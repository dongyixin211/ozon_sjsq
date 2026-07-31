#target photoshop

(function () {
  var argsFile = new File("E:/tool/ozon_sjsq/.codex-work/zhuobu-uv-current-job.json");
  if (!argsFile.exists) throw new Error("missing current-job.json");

  argsFile.encoding = "UTF8";
  argsFile.open("r");
  var argsText = argsFile.read();
  argsFile.close();
  var args = parseSimpleJson(argsText);

  var psdFile = new File(args.psdPath);
  var outputDir = new Folder(args.outputDir);
  var uvDir = new Folder(outputDir.fsName + "/uv");
  if (!outputDir.exists) outputDir.create();
  if (!uvDir.exists) uvDir.create();

  var sceneWidth = Number(args.sceneWidth || 800);
  var sceneHeight = Number(args.sceneHeight || 1067);
  var sourceX = new File(args.sourceXPath);
  var sourceY = new File(args.sourceYPath);

  app.displayDialogs = DialogModes.NO;

  var report = {
    ok: false,
    psdPath: psdFile.fsName,
    outputDir: outputDir.fsName,
    sourceX: sourceX.fsName,
    sourceY: sourceY.fsName,
    sceneWidth: sceneWidth,
    sceneHeight: sceneHeight,
    maps: [],
    skipped: [],
    error: ""
  };

  var doc = null;
  var states = [];
  try {
    doc = app.open(psdFile);
    report.ok = true;
    collectLayerStates(doc.layers, states);

    var targetScene = Number(args.targetScene || 0);
    var sceneGroups = collectSceneGroups(doc.layers, sceneHeight, unitValueToPx(doc.height));
    for (var groupIndex = 0; groupIndex < sceneGroups.length; groupIndex += 1) {
      var group = sceneGroups[groupIndex];
      if (targetScene > 0 && group.sceneIndex !== targetScene) {
        continue;
      }
      var artLayers = [];
      collectArtLayers(group.layer.layers, artLayers);
      for (var layerIndex = 0; layerIndex < artLayers.length; layerIndex += 1) {
        var layer = artLayers[layerIndex];
        if (!isReplacementLayer(layer, group.sceneTop, sceneWidth, sceneHeight)) {
          continue;
        }
        var safeName = safeFilePart(layer.name);
        var prefix = "scene-" + pad2(group.sceneIndex) + "-layer-" + pad3(layerIndex) + "-" + safeName;
        var xFile = new File(uvDir.fsName + "/" + prefix + "-x.png");
        var yFile = new File(uvDir.fsName + "/" + prefix + "-y.png");

        try {
          var originalName = layer.name;
          exportUvLayer(doc, layer, group.sceneTop, sceneWidth, sceneHeight, sourceX, xFile, states);
          exportUvLayer(doc, layer, group.sceneTop, sceneWidth, sceneHeight, sourceY, yFile, states);
          report.maps.push({
            scene: group.sceneIndex,
            name: originalName,
            path: group.layer.name + "/" + originalName,
            layerIndex: layerIndex,
            uvMapX: "uv/" + xFile.name,
            uvMapY: "uv/" + yFile.name
          });
        } catch (exportError) {
          restoreLayerStates(states);
          report.skipped.push({
            scene: group.sceneIndex,
            name: layer.name,
            reason: String(exportError)
          });
        }
      }
    }

    restoreLayerStates(states);
    doc.close(SaveOptions.DONOTSAVECHANGES);
  } catch (error) {
    report.ok = false;
    report.error = String(error);
    try {
      if (doc) doc.close(SaveOptions.DONOTSAVECHANGES);
    } catch (_) {}
  }

  var reportFile = new File(outputDir.fsName + "/uv-report.json");
  reportFile.encoding = "UTF8";
  reportFile.open("w");
  reportFile.write(toJson(report));
  reportFile.close();
})();

function collectSceneGroups(layers, sceneHeight, documentHeight) {
  var groups = [];
  for (var i = 0; i < layers.length; i += 1) {
    var layer = layers[i];
    if (layer.typename !== "LayerSet") continue;
    var bounds = readBounds(layer.bounds);
    var sceneTop = sceneTopFromBounds(bounds, sceneHeight, documentHeight);
    groups.push({
      layer: layer,
      sceneTop: sceneTop,
      sceneIndex: Math.floor(sceneTop / sceneHeight) + 1
    });
  }
  groups.sort(function (left, right) {
    return left.sceneTop - right.sceneTop;
  });
  return groups;
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

function isReplacementLayer(layer, sceneTop, sceneWidth, sceneHeight) {
  try {
    if (layer.kind !== LayerKind.SMARTOBJECT) return false;
  } catch (_) {
    return false;
  }
  if (!layer.visible || Number(layer.opacity) <= 0) {
    return false;
  }
  var info = readSmartObjectInfo(layer);
  if (Math.abs(Number(info.width || 0) - 1600) > 3 || Math.abs(Number(info.height || 0) - 960) > 3) {
    return false;
  }
  var bounds = readBounds(layer.bounds);
  var width = Math.max(0, bounds.right - bounds.left);
  var height = Math.max(0, bounds.bottom - bounds.top);
  if (Math.abs(width - sceneWidth) <= 2 && Math.abs(height - sceneHeight) <= 2) {
    return false;
  }
  return true;
}

function readSmartObjectInfo(layer) {
  var output = { fileReference: "", width: 0, height: 0 };
  try {
    app.activeDocument.activeLayer = layer;
    var ref = new ActionReference();
    ref.putEnumerated(charIDToTypeID("Lyr "), charIDToTypeID("Ordn"), charIDToTypeID("Trgt"));
    var desc = executeActionGet(ref);
    var smartObjectKey = stringIDToTypeID("smartObject");
    if (!desc.hasKey(smartObjectKey)) return output;
    var smartObject = desc.getObjectValue(smartObjectKey);
    var fileReferenceKey = stringIDToTypeID("fileReference");
    if (smartObject.hasKey(fileReferenceKey)) {
      output.fileReference = smartObject.getString(fileReferenceKey);
    }
    var smartObjectMoreKey = stringIDToTypeID("smartObjectMore");
    if (desc.hasKey(smartObjectMoreKey)) {
      var smartObjectMore = desc.getObjectValue(smartObjectMoreKey);
      var sizeKey = stringIDToTypeID("size");
      if (smartObjectMore.hasKey(sizeKey)) {
        var size = smartObjectMore.getObjectValue(sizeKey);
        var widthKey = stringIDToTypeID("width");
        var heightKey = stringIDToTypeID("height");
        if (size.hasKey(widthKey)) output.width = readDescriptorNumber(size, widthKey);
        if (size.hasKey(heightKey)) output.height = readDescriptorNumber(size, heightKey);
      }
    }
  } catch (_) {}
  return output;
}

function readDescriptorNumber(desc, key) {
  var type = desc.getType(key);
  if (type === DescValueType.UNITDOUBLE) return desc.getUnitDoubleValue(key);
  if (type === DescValueType.DOUBLETYPE) return desc.getDouble(key);
  if (type === DescValueType.INTEGERTYPE) return desc.getInteger(key);
  if (type === DescValueType.LARGEINTEGERTYPE) return desc.getLargeInteger(key);
  return 0;
}

function exportUvLayer(doc, layer, sceneTop, sceneWidth, sceneHeight, sourceFile, outputFile, states) {
  app.activeDocument = doc;
  doc.activeLayer = layer;
  replaceSmartObjectContents(sourceFile);
  hideAllLayers(states);
  releaseClippingForLayer(layer);
  showLayerAndParents(layer);
  exportScenePng(doc, sceneTop, sceneWidth, sceneHeight, outputFile);
  restoreLayerStates(states);
}

function replaceSmartObjectContents(sourceFile) {
  var desc = new ActionDescriptor();
  desc.putPath(charIDToTypeID("null"), sourceFile);
  executeAction(stringIDToTypeID("placedLayerReplaceContents"), desc, DialogModes.NO);
}

function exportScenePng(doc, sceneTop, sceneWidth, sceneHeight, outputFile) {
  var tempDoc = duplicateAndCropScene(doc, sceneTop, sceneWidth, sceneHeight);
  var options = new ExportOptionsSaveForWeb();
  options.format = SaveDocumentType.PNG;
  options.PNG8 = false;
  options.transparency = true;
  options.interlaced = false;
  tempDoc.exportDocument(outputFile, ExportType.SAVEFORWEB, options);
  tempDoc.close(SaveOptions.DONOTSAVECHANGES);
}

function duplicateAndCropScene(doc, sceneTop, sceneWidth, sceneHeight) {
  app.activeDocument = doc;
  var tempDoc = doc.duplicate("uv-export", true);
  app.activeDocument = tempDoc;
  tempDoc.crop([
    UnitValue(0, "px"),
    UnitValue(sceneTop, "px"),
    UnitValue(sceneWidth, "px"),
    UnitValue(sceneTop + sceneHeight, "px")
  ]);
  return tempDoc;
}

function collectLayerStates(layers, output) {
  for (var i = 0; i < layers.length; i += 1) {
    var layer = layers[i];
    var grouped = null;
    try {
      grouped = Boolean(layer.grouped);
    } catch (_) {}
    output.push({ layer: layer, visible: Boolean(layer.visible), grouped: grouped });
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
    try {
      if (states[i].grouped !== null) {
        states[i].layer.grouped = states[i].grouped;
      }
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

function releaseClippingForLayer(layer) {
  var current = layer;
  while (current) {
    try {
      if (current.typename === "ArtLayer" && current.grouped) {
        current.grouped = false;
      }
    } catch (_) {}
    try {
      if (!current.parent || current.parent.typename === "Document") break;
      current = current.parent;
    } catch (_) {
      break;
    }
  }
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

function safeFilePart(value) {
  var text = String(value || "")
    .replace(/[\\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  if (!text) return "layer";
  return text.length > 80 ? text.substring(0, 80) : text;
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
