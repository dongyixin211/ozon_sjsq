#target photoshop

(function () {
  var argsFile = new File("E:/tool/ozon_sjsq/dist/mockup-convert/current-job.json");
  if (!argsFile.exists) throw new Error("missing current-job.json");

  argsFile.encoding = "UTF8";
  argsFile.open("r");
  var argsText = argsFile.read();
  argsFile.close();
  var args = parseSimpleJson(argsText);

  var psdFile = new File(args.psdPath);
  var outputDir = new Folder(args.outputDir);
  var masksDir = new Folder(outputDir.fsName + "/replace-alpha");
  if (!outputDir.exists) outputDir.create();
  if (!masksDir.exists) masksDir.create();

  var sceneWidth = Number(args.sceneWidth || 800);
  var sceneHeight = Number(args.sceneHeight || 1067);
  app.displayDialogs = DialogModes.NO;

  var report = {
    ok: false,
    psdPath: psdFile.fsName,
    sceneWidth: sceneWidth,
    sceneHeight: sceneHeight,
    masks: [],
    skipped: [],
    error: ""
  };

  var doc = null;
  var originalStates = [];
  try {
    doc = app.open(psdFile);
    report.ok = true;
    collectLayerStates(doc.layers, originalStates);

    var sceneGroups = collectTopLevelGroups(doc.layers);
    for (var groupIndex = 0; groupIndex < sceneGroups.length; groupIndex += 1) {
      var sceneGroup = sceneGroups[groupIndex];
      var groupBounds = readBounds(sceneGroup.bounds);
      var sceneTop = sceneTopFromBounds(groupBounds, sceneHeight, unitValueToPx(doc.height));
      var sceneIndex = Math.floor(sceneTop / sceneHeight) + 1;
      var artLayers = [];
      collectArtLayers(sceneGroup.layers, artLayers);

      for (var layerIndex = 0; layerIndex < artLayers.length; layerIndex += 1) {
        var layer = artLayers[layerIndex];
        if (!isVisibleReplacementSmartObject(layer)) {
          continue;
        }
        var smart = readSmartObjectInfo(layer, sceneTop);
        if (Math.round(smart.width) !== 1600 || Math.round(smart.height) !== 960) {
          continue;
        }

        var safeName = sanitizeFileName(layer.name);
        var outputFile = new File(masksDir.fsName + "/scene-" + pad2(sceneIndex) + "-replace-" + pad3(layerIndex) + "-" + safeName + ".png");
        try {
          exportSingleLayer(doc, layer, sceneTop, sceneWidth, sceneHeight, outputFile, originalStates);
          report.masks.push({
            scene: sceneIndex,
            layerIndex: layerIndex,
            layerId: readLayerId(layer),
            name: layer.name,
            file: "replace-alpha/" + outputFile.name
          });
        } catch (exportError) {
          restoreLayerStates(originalStates);
          report.skipped.push({
            scene: sceneIndex,
            name: layer.name,
            reason: String(exportError)
          });
        }
      }
    }

    restoreLayerStates(originalStates);
    doc.close(SaveOptions.DONOTSAVECHANGES);
  } catch (error) {
    report.ok = false;
    report.error = String(error);
    try {
      if (doc) doc.close(SaveOptions.DONOTSAVECHANGES);
    } catch (_) {}
  }

  var reportFile = new File(outputDir.fsName + "/replace-alpha-report.json");
  reportFile.encoding = "UTF8";
  reportFile.open("w");
  reportFile.write(toJson(report));
  reportFile.close();
})();

function collectTopLevelGroups(layers) {
  var output = [];
  for (var i = 0; i < layers.length; i += 1) {
    if (layers[i].typename === "LayerSet") {
      output.push(layers[i]);
    }
  }
  return output;
}

function collectArtLayers(layers, output) {
  for (var i = 0; i < layers.length; i += 1) {
    var layer = layers[i];
    if (layer.typename === "ArtLayer") {
      output.push(layer);
    } else if (layer.typename === "LayerSet") {
      collectArtLayers(layer.layers, output);
    }
  }
}

function isVisibleReplacementSmartObject(layer) {
  try {
    return layer.visible && Number(layer.opacity) > 0 && layer.kind === LayerKind.SMARTOBJECT;
  } catch (_) {
    return false;
  }
}

function readLayerId(layer) {
  try {
    return Number(layer.id);
  } catch (_) {
    return 0;
  }
}

function readSmartObjectInfo(layer, sceneTop) {
  var output = {
    transform: [],
    width: 0,
    height: 0
  };
  try {
    app.activeDocument.activeLayer = layer;
    var ref = new ActionReference();
    ref.putEnumerated(charIDToTypeID("Lyr "), charIDToTypeID("Ordn"), charIDToTypeID("Trgt"));
    var desc = executeActionGet(ref);
    var smartObjectMoreKey = stringIDToTypeID("smartObjectMore");
    if (!desc.hasKey(smartObjectMoreKey)) return output;
    var smartObjectMore = desc.getObjectValue(smartObjectMoreKey);
    output.transform = readNumericList(smartObjectMore, "transform", sceneTop);
    var sizeKey = stringIDToTypeID("size");
    if (smartObjectMore.hasKey(sizeKey)) {
      var size = smartObjectMore.getObjectValue(sizeKey);
      var widthKey = stringIDToTypeID("width");
      var heightKey = stringIDToTypeID("height");
      if (size.hasKey(widthKey)) output.width = readDescriptorNumber(size, widthKey);
      if (size.hasKey(heightKey)) output.height = readDescriptorNumber(size, heightKey);
    }
  } catch (_) {}
  return output;
}

function readNumericList(desc, keyName, sceneTop) {
  var output = [];
  try {
    var key = stringIDToTypeID(keyName);
    if (!desc.hasKey(key)) return output;
    var list = desc.getList(key);
    for (var i = 0; i < list.count; i += 1) {
      var value = readListNumber(list, i);
      if (i % 2 === 1) value -= sceneTop;
      output.push(round3(value));
    }
  } catch (_) {}
  return output;
}

function readListNumber(list, index) {
  var type = list.getType(index);
  if (type === DescValueType.UNITDOUBLE) return list.getUnitDoubleValue(index);
  if (type === DescValueType.DOUBLETYPE) return list.getDouble(index);
  if (type === DescValueType.INTEGERTYPE) return list.getInteger(index);
  if (type === DescValueType.LARGEINTEGERTYPE) return list.getLargeInteger(index);
  return 0;
}

function readDescriptorNumber(desc, key) {
  var type = desc.getType(key);
  if (type === DescValueType.UNITDOUBLE) return desc.getUnitDoubleValue(key);
  if (type === DescValueType.DOUBLETYPE) return desc.getDouble(key);
  if (type === DescValueType.INTEGERTYPE) return desc.getInteger(key);
  if (type === DescValueType.LARGEINTEGERTYPE) return desc.getLargeInteger(key);
  return 0;
}

function collectLayerStates(layers, output) {
  for (var i = 0; i < layers.length; i += 1) {
    var layer = layers[i];
    output.push({ layer: layer, visible: Boolean(layer.visible) });
    if (layer.typename === "LayerSet") {
      collectLayerStates(layer.layers, output);
    }
  }
}

function restoreLayerStates(states) {
  for (var i = states.length - 1; i >= 0; i -= 1) {
    try {
      states[i].layer.visible = states[i].visible;
    } catch (_) {}
  }
}

function hideAllLayers(states) {
  for (var i = 0; i < states.length; i += 1) {
    try {
      states[i].layer.visible = false;
    } catch (_) {}
  }
}

function showLayerAndParents(layer) {
  var current = layer;
  while (current) {
    try {
      current.visible = true;
    } catch (_) {}
    try {
      if (!current.parent || current.parent.typename === "Document") break;
      current = current.parent;
    } catch (_) {
      break;
    }
  }
}

function exportSingleLayer(doc, layer, sceneTop, sceneWidth, sceneHeight, outputFile, originalStates) {
  hideAllLayers(originalStates);
  showLayerAndParents(layer);
  exportScenePng(doc, sceneTop, sceneWidth, sceneHeight, outputFile);
  restoreLayerStates(originalStates);
}

function exportScenePng(doc, sceneTop, sceneWidth, sceneHeight, outputFile) {
  var tempDoc = copySceneToNewDocument(doc, sceneTop, sceneWidth, sceneHeight);
  var options = new ExportOptionsSaveForWeb();
  options.format = SaveDocumentType.PNG;
  options.PNG8 = false;
  options.transparency = true;
  options.interlaced = false;
  tempDoc.exportDocument(outputFile, ExportType.SAVEFORWEB, options);
  tempDoc.close(SaveOptions.DONOTSAVECHANGES);
}

function copySceneToNewDocument(doc, sceneTop, sceneWidth, sceneHeight) {
  app.activeDocument = doc;
  doc.selection.select([
    [0, sceneTop],
    [sceneWidth, sceneTop],
    [sceneWidth, sceneTop + sceneHeight],
    [0, sceneTop + sceneHeight]
  ]);
  doc.selection.copy(true);
  var tempDoc = app.documents.add(
    UnitValue(sceneWidth, "px"),
    UnitValue(sceneHeight, "px"),
    72,
    "replace-alpha-export",
    NewDocumentMode.RGB,
    DocumentFill.TRANSPARENT
  );
  tempDoc.paste();
  return tempDoc;
}

function sceneTopFromBounds(bounds, sceneHeight, documentHeight) {
  var maxSceneIndex = Math.max(0, Math.ceil(documentHeight / sceneHeight) - 1);
  var top = Number(bounds.top);
  var bottom = Number(bounds.bottom);
  var center = (top + bottom) / 2;
  var rawIndex = 0;
  if (isFinite(center) && bottom > top) {
    rawIndex = Math.floor(center / sceneHeight);
  } else if (isFinite(top)) {
    rawIndex = Math.floor(top / sceneHeight);
  }
  if (!isFinite(rawIndex)) rawIndex = 0;
  rawIndex = Math.max(0, Math.min(maxSceneIndex, rawIndex));
  return rawIndex * sceneHeight;
}

function readBounds(bounds) {
  return {
    left: unitValueToPx(bounds[0]),
    top: unitValueToPx(bounds[1]),
    right: unitValueToPx(bounds[2]),
    bottom: unitValueToPx(bounds[3])
  };
}

function unitValueToPx(value) {
  try {
    return Math.round(value.as("px") * 1000) / 1000;
  } catch (_) {
    return Number(value);
  }
}

function sanitizeFileName(value) {
  return String(value || "layer")
    .replace(/[\\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .substr(0, 80) || "layer";
}

function round3(value) {
  return Math.round(Number(value || 0) * 1000) / 1000;
}

function pad2(value) {
  return String(value).length >= 2 ? String(value) : "0" + value;
}

function pad3(value) {
  var text = String(value);
  while (text.length < 3) text = "0" + text;
  return text;
}

function parseSimpleJson(text) {
  return eval("(" + text + ")");
}

function escapeString(value) {
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, "\\\"")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t");
}

function toJson(value) {
  if (value === null) return "null";
  if (typeof value === "number") return isFinite(value) ? String(value) : "0";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return "\"" + escapeString(value) + "\"";
  if (value instanceof Array) {
    var items = [];
    for (var i = 0; i < value.length; i += 1) items.push(toJson(value[i]));
    return "[" + items.join(",") + "]";
  }
  var props = [];
  for (var key in value) {
    if (value.hasOwnProperty(key)) props.push("\"" + escapeString(key) + "\":" + toJson(value[key]));
  }
  return "{" + props.join(",") + "}";
}
