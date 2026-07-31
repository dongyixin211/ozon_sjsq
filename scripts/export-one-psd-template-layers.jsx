#target photoshop

(function () {
  var argsFile = new File("E:/tool/ozon_sjsq/dist/mockup-convert/current-job.json");
  if (!argsFile.exists) throw new Error("缺少 current-job.json");

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

  app.displayDialogs = DialogModes.NO;

  var report = {
    ok: false,
    psdPath: psdFile.fsName,
    width: 0,
    height: 0,
    sceneWidth: sceneWidth,
    sceneHeight: sceneHeight,
    scenes: [],
    skippedLayers: [],
    error: ""
  };

  var doc = null;
  var originalStates = [];
  try {
    doc = app.open(psdFile);
    report.ok = true;
    report.width = unitValueToPx(doc.width);
    report.height = unitValueToPx(doc.height);

    collectLayerStates(doc.layers, originalStates);
    var sceneGroups = collectSceneGroups(doc.layers, sceneWidth, sceneHeight, report.height);
    sceneGroups.sort(function (left, right) { return left.index - right.index; });

    for (var sceneIndex = 0; sceneIndex < sceneGroups.length; sceneIndex += 1) {
      var sceneGroup = sceneGroups[sceneIndex];
      var groupBounds = readBounds(sceneGroup.layer.bounds);
      var sceneTop = sceneTopFromBounds(groupBounds, sceneHeight, report.height);
      var outputSceneIndex = Math.floor(sceneTop / sceneHeight) + 1;
      var scene = {
        index: outputSceneIndex,
        name: sceneGroup.layer.name,
        sourceIndex: sceneGroup.index,
        top: sceneTop,
        width: sceneWidth,
        height: sceneHeight,
        layers: [],
        previewFile: ""
      };

      restoreLayerStates(originalStates);
      var previewFile = new File(outputDir.fsName + "/preview_" + pad2(outputSceneIndex) + ".jpg");
      try {
        exportScenePreview(doc, sceneTop, sceneWidth, sceneHeight, previewFile);
        scene.previewFile = previewFile.fsName;
      } catch (previewError) {
        report.skippedLayers.push({
          scene: sceneGroup.index,
          layer: "__preview__",
          reason: String(previewError)
        });
      }

      var artLayers = [];
      collectArtLayers(sceneGroup.layer.layers, [], artLayers);
      for (var layerIndex = 0; layerIndex < artLayers.length; layerIndex += 1) {
        var layer = artLayers[layerIndex];
        var bounds = readBounds(layer.bounds);
        var layerInfo = {
          name: layer.name,
          path: sceneGroup.layer.name + "/" + layer.name,
          topToBottomIndex: sceneIndex * 1000 + layerIndex,
          visible: Boolean(layer.visible),
          opacity: Number(layer.opacity),
          blendMode: String(layer.blendMode),
          bounds: bounds,
          left: bounds.left,
          top: bounds.top - sceneTop,
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
          var smartObjectInfo = readSmartObjectInfo(layer, sceneTop);
          if (smartObjectInfo.transform.length === 8) {
            layerInfo.transform = smartObjectInfo.transform;
          }
          if (smartObjectInfo.nonAffineTransform.length === 8) {
            layerInfo.nonAffineTransform = smartObjectInfo.nonAffineTransform;
          }
          if (smartObjectInfo.fileReference) {
            layerInfo.smartObjectFileReference = smartObjectInfo.fileReference;
          }
          if (smartObjectInfo.width > 0 && smartObjectInfo.height > 0) {
            layerInfo.smartObjectWidth = smartObjectInfo.width;
            layerInfo.smartObjectHeight = smartObjectInfo.height;
          }
          var maskFile = new File(masksDir.fsName + "/scene-" + pad2(outputSceneIndex) + "-replace-" + pad3(layerIndex) + ".png");
          if (tryExportSingleLayer(doc, layer, sceneTop, sceneWidth, sceneHeight, maskFile, originalStates)) {
            layerInfo.maskFile = "masks/" + maskFile.name;
          }
          scene.layers.push(layerInfo);
          continue;
        }

        layerInfo.kind = "image";
        var outputFile = new File(layersDir.fsName + "/scene-" + pad2(outputSceneIndex) + "-layer-" + pad3(layerIndex) + ".png");
        try {
          exportSingleLayer(doc, layer, sceneTop, sceneWidth, sceneHeight, outputFile, originalStates);
          if (outputFile.exists) {
            layerInfo.file = "layers/" + outputFile.name;
            scene.layers.push(layerInfo);
          } else {
            report.skippedLayers.push({
              scene: sceneGroup.index,
              layer: layer.name,
              reason: "layer export produced no file"
            });
          }
        } catch (layerExportError) {
          restoreLayerStates(originalStates);
          report.skippedLayers.push({
            scene: sceneGroup.index,
            layer: layer.name,
            reason: String(layerExportError)
          });
        }
      }
      scene.layers.sort(function (left, right) { return left.topToBottomIndex - right.topToBottomIndex; });
      if (scene.layers.length > 0) {
        report.scenes.push(scene);
      }
    }

    report.scenes.sort(function (left, right) { return left.index - right.index; });
    restoreLayerStates(originalStates);
    doc.close(SaveOptions.DONOTSAVECHANGES);
  } catch (error) {
    report.ok = false;
    report.error = String(error);
    try {
      if (doc) doc.close(SaveOptions.DONOTSAVECHANGES);
    } catch (_) {}
  }

  var reportFile = new File(outputDir.fsName + "/export-report.json");
  reportFile.encoding = "UTF8";
  reportFile.open("w");
  reportFile.write(toJson(report));
  reportFile.close();
})();

function collectSceneGroups(layers, sceneWidth, sceneHeight, documentHeight) {
  var output = [];
  for (var i = 0; i < layers.length; i += 1) {
    var layer = layers[i];
    if (layer.typename === "LayerSet") {
      var name = String(layer.name);
      var match = name.match(/^\s*(\d+)\s*$/) || name.match(/(?:组|group)\s*(\d+)/i);
      if (match) {
        var bounds = readBounds(layer.bounds);
        if (isSceneLikeGroup(bounds, sceneHeight, documentHeight)) {
          output.push({ index: Number(match[1]), layer: layer });
        }
      }
    }
  }
  return output;
}

function isSceneLikeGroup(bounds, sceneHeight, documentHeight) {
  var top = Number(bounds.top);
  var bottom = Number(bounds.bottom);
  if (!isFinite(top) || !isFinite(bottom) || bottom <= top) return false;
  if (bottom - top > sceneHeight * 2) return false;
  var center = (top + bottom) / 2;
  return center >= -sceneHeight && center <= documentHeight + sceneHeight;
}

function collectArtLayers(layers, parents, output) {
  for (var i = 0; i < layers.length; i += 1) {
    var layer = layers[i];
    if (layer.typename === "ArtLayer") {
      output.push(layer);
    } else if (layer.typename === "LayerSet") {
      collectArtLayers(layer.layers, parents.concat([layer]), output);
    }
  }
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
  exportScenePng(doc, sceneTop, sceneWidth, sceneHeight, outputFile, readBounds(layer.bounds));
  restoreLayerStates(originalStates);
}

function tryExportSingleLayer(doc, layer, sceneTop, sceneWidth, sceneHeight, outputFile, originalStates) {
  try {
    exportSingleLayer(doc, layer, sceneTop, sceneWidth, sceneHeight, outputFile, originalStates);
    return outputFile.exists;
  } catch (_) {
    restoreLayerStates(originalStates);
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

function exportScenePng(doc, sceneTop, sceneWidth, sceneHeight, outputFile, sourceBounds) {
  var tempDoc = copySceneToNewDocument(doc, sceneTop, sceneWidth, sceneHeight, sourceBounds);
  var options = new ExportOptionsSaveForWeb();
  options.format = SaveDocumentType.PNG;
  options.PNG8 = false;
  options.transparency = true;
  options.interlaced = false;
  tempDoc.exportDocument(outputFile, ExportType.SAVEFORWEB, options);
  tempDoc.close(SaveOptions.DONOTSAVECHANGES);
}

function copySceneToNewDocument(doc, sceneTop, sceneWidth, sceneHeight, sourceBounds) {
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
    "scene-export",
    NewDocumentMode.RGB,
    DocumentFill.TRANSPARENT
  );
  tempDoc.paste();
  if (sourceBounds) {
    var expectedCenterX = (Number(sourceBounds.left) + Number(sourceBounds.right)) / 2;
    var expectedCenterY = (Number(sourceBounds.top) + Number(sourceBounds.bottom)) / 2 - sceneTop;
    tempDoc.activeLayer.translate(
      UnitValue(expectedCenterX - sceneWidth / 2, "px"),
      UnitValue(expectedCenterY - sceneHeight / 2, "px")
    );
  }
  return tempDoc;
}

function isReplacementLayer(layer, sceneWidth, sceneHeight) {
  try {
    if (layer.kind !== LayerKind.SMARTOBJECT) return false;
  } catch (_) {
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

function readSmartObjectInfo(layer, sceneTop) {
  var output = {
    transform: [],
    nonAffineTransform: [],
    fileReference: "",
    width: 0,
    height: 0
  };
  try {
    app.activeDocument.activeLayer = layer;
    var ref = new ActionReference();
    ref.putEnumerated(charIDToTypeID("Lyr "), charIDToTypeID("Ordn"), charIDToTypeID("Trgt"));
    var desc = executeActionGet(ref);

    var smartObjectKey = stringIDToTypeID("smartObject");
    if (desc.hasKey(smartObjectKey)) {
      var smartObject = desc.getObjectValue(smartObjectKey);
      var fileReferenceKey = stringIDToTypeID("fileReference");
      if (smartObject.hasKey(fileReferenceKey)) {
        output.fileReference = smartObject.getString(fileReferenceKey);
      }
    }

    var smartObjectMoreKey = stringIDToTypeID("smartObjectMore");
    if (!desc.hasKey(smartObjectMoreKey)) {
      return output;
    }
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
  try {
    return Math.round(value.as("px") * 1000) / 1000;
  } catch (_) {
    return Number(value);
  }
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
