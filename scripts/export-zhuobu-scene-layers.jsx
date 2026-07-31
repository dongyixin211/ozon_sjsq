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
  var layersDir = new Folder(outputDir.fsName + "/layers");
  var masksDir = new Folder(outputDir.fsName + "/masks");
  if (!outputDir.exists) outputDir.create();
  if (!layersDir.exists) layersDir.create();
  if (!masksDir.exists) masksDir.create();

  var sceneWidth = Number(args.sceneWidth || 800);
  var sceneHeight = Number(args.sceneHeight || 1067);
  var targetScene = Number(args.targetScene || 1);
  app.displayDialogs = DialogModes.NO;

  var report = {
    ok: false,
    psdPath: psdFile.fsName,
    outputDir: outputDir.fsName,
    targetScene: targetScene,
    sceneWidth: sceneWidth,
    sceneHeight: sceneHeight,
    scene: null,
    skippedLayers: [],
    error: ""
  };

  var doc = null;
  var states = [];
  try {
    doc = app.open(psdFile);
    report.ok = true;
    collectLayerStates(doc.layers, states);

    var group = findSceneGroup(doc.layers, targetScene, sceneHeight, unitValueToPx(doc.height));
    if (!group) throw new Error("scene group not found: " + targetScene);

    report.scene = {
      index: group.sceneIndex,
      name: group.layer.name,
      top: group.sceneTop,
      width: sceneWidth,
      height: sceneHeight,
      layers: [],
      previewFile: ""
    };

    var previewFile = new File(outputDir.fsName + "/preview_" + pad2(group.sceneIndex) + ".jpg");
    exportScenePreview(doc, group.sceneTop, sceneWidth, sceneHeight, previewFile);
    report.scene.previewFile = previewFile.fsName;

    var artLayers = [];
    collectArtLayers(group.layer.layers, artLayers);
    for (var layerIndex = 0; layerIndex < artLayers.length; layerIndex += 1) {
      var layer = artLayers[layerIndex];
      var bounds = readBounds(layer.bounds);
      var layerInfo = {
        name: layer.name,
        path: group.layer.name + "/" + layer.name,
        topToBottomIndex: layerIndex,
        visible: Boolean(layer.visible),
        opacity: Number(layer.opacity),
        blendMode: String(layer.blendMode),
        bounds: bounds,
        left: bounds.left,
        top: bounds.top - group.sceneTop,
        width: Math.max(0, bounds.right - bounds.left),
        height: Math.max(0, bounds.bottom - bounds.top),
        kind: "",
        file: "",
        maskFile: ""
      };
      if (!layer.visible || Number(layer.opacity) <= 0 || layerInfo.width <= 0 || layerInfo.height <= 0) {
        continue;
      }

      if (isReplacementLayer(layer, sceneWidth, sceneHeight)) {
        layerInfo.kind = "replace";
        var smartInfo = readSmartObjectInfo(layer, group.sceneTop);
        layerInfo.transform = smartInfo.transform;
        layerInfo.nonAffineTransform = smartInfo.nonAffineTransform;
        layerInfo.smartObjectWidth = smartInfo.width;
        layerInfo.smartObjectHeight = smartInfo.height;
        layerInfo.smartObjectFileReference = smartInfo.fileReference;
        var maskFile = new File(masksDir.fsName + "/scene-" + pad2(group.sceneIndex) + "-replace-" + pad3(layerIndex) + ".png");
        if (tryExportSingleLayer(doc, layer, group.sceneTop, sceneWidth, sceneHeight, maskFile, states)) {
          layerInfo.maskFile = "masks/" + maskFile.name;
        }
        report.scene.layers.push(layerInfo);
        continue;
      }

      layerInfo.kind = "image";
      var outputFile = new File(layersDir.fsName + "/scene-" + pad2(group.sceneIndex) + "-layer-" + pad3(layerIndex) + ".png");
      try {
        exportSingleLayer(doc, layer, group.sceneTop, sceneWidth, sceneHeight, outputFile, states);
        if (outputFile.exists) {
          layerInfo.file = "layers/" + outputFile.name;
          report.scene.layers.push(layerInfo);
        }
      } catch (layerError) {
        restoreLayerStates(states);
        report.skippedLayers.push({ layer: layer.name, reason: String(layerError) });
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

  var reportFile = new File(outputDir.fsName + "/scene-export-report.json");
  reportFile.encoding = "UTF8";
  reportFile.open("w");
  reportFile.write(toJson(report));
  reportFile.close();
})();

function findSceneGroup(layers, targetScene, sceneHeight, documentHeight) {
  for (var i = 0; i < layers.length; i += 1) {
    var layer = layers[i];
    if (layer.typename !== "LayerSet") continue;
    var bounds = readBounds(layer.bounds);
    var sceneTop = sceneTopFromBounds(bounds, sceneHeight, documentHeight);
    var sceneIndex = Math.floor(sceneTop / sceneHeight) + 1;
    if (sceneIndex === targetScene) {
      return { layer: layer, sceneTop: sceneTop, sceneIndex: sceneIndex };
    }
  }
  return null;
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

function sceneTopFromBounds(bounds, sceneHeight, documentHeight) {
  var maxSceneIndex = Math.max(0, Math.ceil(documentHeight / sceneHeight) - 1);
  var top = Number(bounds.top);
  var bottom = Number(bounds.bottom);
  var center = (top + bottom) / 2;
  var rawIndex = isFinite(center) && bottom > top ? Math.floor(center / sceneHeight) : Math.floor(top / sceneHeight);
  if (!isFinite(rawIndex)) rawIndex = 0;
  rawIndex = Math.max(0, Math.min(maxSceneIndex, rawIndex));
  return rawIndex * sceneHeight;
}

function collectLayerStates(layers, output) {
  for (var i = 0; i < layers.length; i += 1) {
    var layer = layers[i];
    var grouped = null;
    try { grouped = Boolean(layer.grouped); } catch (_) {}
    output.push({ layer: layer, visible: Boolean(layer.visible), grouped: grouped });
    if (layer.typename === "LayerSet") collectLayerStates(layer.layers, output);
  }
}

function restoreLayerStates(states) {
  for (var i = states.length - 1; i >= 0; i -= 1) {
    try { states[i].layer.visible = states[i].visible; } catch (_) {}
    try {
      if (states[i].grouped !== null) {
        states[i].layer.grouped = states[i].grouped;
      }
    } catch (_) {}
  }
}

function hideAllLayers(states) {
  for (var i = 0; i < states.length; i += 1) {
    try { states[i].layer.visible = false; } catch (_) {}
  }
}

function showLayerAndParents(layer) {
  var current = layer;
  while (current) {
    try { current.visible = true; } catch (_) {}
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

function exportSingleLayer(doc, layer, sceneTop, sceneWidth, sceneHeight, outputFile, states) {
  hideAllLayers(states);
  releaseClippingForLayer(layer);
  showLayerAndParents(layer);
  exportScenePng(doc, sceneTop, sceneWidth, sceneHeight, outputFile);
  restoreLayerStates(states);
}

function tryExportSingleLayer(doc, layer, sceneTop, sceneWidth, sceneHeight, outputFile, states) {
  try {
    exportSingleLayer(doc, layer, sceneTop, sceneWidth, sceneHeight, outputFile, states);
    return outputFile.exists;
  } catch (_) {
    restoreLayerStates(states);
    return false;
  }
}

function exportScenePreview(doc, sceneTop, sceneWidth, sceneHeight, outputFile) {
  var tempDoc = copySceneToNewDocument(doc, sceneTop, sceneWidth, sceneHeight);
  var options = new ExportOptionsSaveForWeb();
  options.format = SaveDocumentType.JPEG;
  options.quality = 86;
  options.optimized = true;
  tempDoc.exportDocument(outputFile, ExportType.SAVEFORWEB, options);
  tempDoc.close(SaveOptions.DONOTSAVECHANGES);
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
  doc.selection.select([[0, sceneTop], [sceneWidth, sceneTop], [sceneWidth, sceneTop + sceneHeight], [0, sceneTop + sceneHeight]]);
  doc.selection.copy(true);
  var tempDoc = app.documents.add(UnitValue(sceneWidth, "px"), UnitValue(sceneHeight, "px"), 72, "scene-export", NewDocumentMode.RGB, DocumentFill.TRANSPARENT);
  tempDoc.paste();
  return tempDoc;
}

function isReplacementLayer(layer, sceneWidth, sceneHeight) {
  try {
    if (layer.kind !== LayerKind.SMARTOBJECT) return false;
  } catch (_) {
    return false;
  }
  var info = readSmartObjectInfo(layer, 0);
  if (Math.abs(Number(info.width || 0) - 1600) > 3 || Math.abs(Number(info.height || 0) - 960) > 3) {
    return false;
  }
  var bounds = readBounds(layer.bounds);
  var width = Math.max(0, bounds.right - bounds.left);
  var height = Math.max(0, bounds.bottom - bounds.top);
  return !(Math.abs(width - sceneWidth) <= 2 && Math.abs(height - sceneHeight) <= 2);
}

function readSmartObjectInfo(layer, sceneTop) {
  var output = { transform: [], nonAffineTransform: [], fileReference: "", width: 0, height: 0 };
  try {
    app.activeDocument.activeLayer = layer;
    var ref = new ActionReference();
    ref.putEnumerated(charIDToTypeID("Lyr "), charIDToTypeID("Ordn"), charIDToTypeID("Trgt"));
    var desc = executeActionGet(ref);
    var smartObjectKey = stringIDToTypeID("smartObject");
    if (desc.hasKey(smartObjectKey)) {
      var smartObject = desc.getObjectValue(smartObjectKey);
      var fileReferenceKey = stringIDToTypeID("fileReference");
      if (smartObject.hasKey(fileReferenceKey)) output.fileReference = smartObject.getString(fileReferenceKey);
    }
    var smartObjectMoreKey = stringIDToTypeID("smartObjectMore");
    if (!desc.hasKey(smartObjectMoreKey)) return output;
    var smartObjectMore = desc.getObjectValue(smartObjectMoreKey);
    output.transform = readNumericList(smartObjectMore, "transform", sceneTop);
    output.nonAffineTransform = readNumericList(smartObjectMore, "nonAffineTransform", sceneTop);
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

function readBounds(bounds) {
  return {
    left: unitValueToPx(bounds[0]),
    top: unitValueToPx(bounds[1]),
    right: unitValueToPx(bounds[2]),
    bottom: unitValueToPx(bounds[3])
  };
}

function unitValueToPx(value) {
  try { return Math.round(value.as("px") * 1000) / 1000; } catch (_) { return Number(value); }
}

function round3(value) {
  return Math.round(Number(value || 0) * 1000) / 1000;
}

function pad2(value) {
  return ("0" + value).slice(-2);
}

function pad3(value) {
  return ("00" + value).slice(-3);
}

function parseSimpleJson(text) {
  try {
    return eval("(" + text + ")");
  } catch (error) {
    throw new Error("invalid json: " + error);
  }
}

function toJson(value) {
  if (value === null) return "null";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "string") return "\"" + value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"").replace(/\r/g, "\\r").replace(/\n/g, "\\n") + "\"";
  if (value instanceof Array) {
    var parts = [];
    for (var i = 0; i < value.length; i += 1) parts.push(toJson(value[i]));
    return "[" + parts.join(",") + "]";
  }
  var props = [];
  for (var key in value) {
    if (value.hasOwnProperty(key)) props.push(toJson(key) + ":" + toJson(value[key]));
  }
  return "{" + props.join(",") + "}";
}
