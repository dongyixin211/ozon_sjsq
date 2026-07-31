#target photoshop

(function () {
  var argsFile = new File("E:/tool/ozon_sjsq/dist/ps-render/zhuobu/current-job.json");
  if (!argsFile.exists) throw new Error("missing current-job.json");

  argsFile.encoding = "UTF8";
  argsFile.open("r");
  var argsText = argsFile.read();
  argsFile.close();
  var args = parseSimpleJson(argsText);

  var psdFile = new File(args.psdPath);
  var sourceFile = new File(args.sourcePath);
  var preparedSourceFile = new File(args.preparedSourcePath);
  var outputDir = new Folder(args.outputDir);
  if (!outputDir.exists) outputDir.create();

  var sceneWidth = Number(args.sceneWidth || 800);
  var sceneHeight = Number(args.sceneHeight || 1067);
  var sceneCount = Number(args.sceneCount || 9);
  var sourceWidth = Number(args.sourceWidth || 1600);
  var sourceHeight = Number(args.sourceHeight || 960);
  var outputFormat = String(args.outputFormat || "gif").toLowerCase();
  var sourceFit = String(args.sourceFit || "fill").toLowerCase();
  var sku = String(args.sku || "mockup");

  app.displayDialogs = DialogModes.NO;

  var report = {
    ok: false,
    psdPath: psdFile.fsName,
    sourcePath: sourceFile.fsName,
    preparedSourcePath: "",
    outputDir: outputDir.fsName,
    sku: sku,
    sceneWidth: sceneWidth,
    sceneHeight: sceneHeight,
    sceneCount: sceneCount,
    replacedLayers: [],
    files: [],
    error: ""
  };

  var doc = null;
  try {
    var replacementFile = prepareSourceFile(sourceFile, preparedSourceFile, sourceWidth, sourceHeight, sourceFit);
    report.preparedSourcePath = replacementFile.fsName;

    doc = app.open(psdFile);
    var targetLayers = [];
    collectReplacementSmartObjects(doc.layers, "", targetLayers);
    if (targetLayers.length <= 0) {
      throw new Error("no 1600x960 replacement smart object found");
    }

    for (var i = 0; i < targetLayers.length && i < 1; i += 1) {
      app.activeDocument = doc;
      doc.activeLayer = targetLayers[i].layer;
      replaceSmartObjectContents(replacementFile);
      report.replacedLayers.push({
        path: targetLayers[i].path,
        name: targetLayers[i].layer.name,
        id: readLayerId(targetLayers[i].layer)
      });
    }

    for (var sceneIndex = 1; sceneIndex <= sceneCount; sceneIndex += 1) {
      var sceneTop = (sceneIndex - 1) * sceneHeight;
      var outputFile = new File(outputDir.fsName + "/111_" + sku + "_" + pad2(sceneIndex) + "." + outputExtension(outputFormat));
      exportScene(doc, sceneTop, sceneWidth, sceneHeight, outputFile, outputFormat);
      report.files.push({
        scene: sceneIndex,
        file: outputFile.fsName,
        exists: outputFile.exists
      });
    }

    doc.close(SaveOptions.DONOTSAVECHANGES);
    report.ok = true;
  } catch (error) {
    report.ok = false;
    report.error = String(error);
    try {
      if (doc) doc.close(SaveOptions.DONOTSAVECHANGES);
    } catch (_) {}
  }

  var reportFile = new File(outputDir.fsName + "/ps-render-report.json");
  reportFile.encoding = "UTF8";
  reportFile.open("w");
  reportFile.write(toJson(report));
  reportFile.close();
})();

function prepareSourceFile(sourceFile, outputFile, width, height, fit) {
  if (fit === "none") return sourceFile;

  var doc = app.open(sourceFile);
  try {
    if (doc.mode !== DocumentMode.RGB) {
      doc.changeMode(ChangeMode.RGB);
    }
  } catch (_) {}

  if (fit === "cover") {
    resizeCover(doc, width, height);
  } else {
    doc.resizeImage(UnitValue(width, "px"), UnitValue(height, "px"), 72, ResampleMethod.BICUBIC);
  }

  var options = new ExportOptionsSaveForWeb();
  options.format = SaveDocumentType.PNG;
  options.PNG8 = false;
  options.transparency = true;
  options.interlaced = false;
  doc.exportDocument(outputFile, ExportType.SAVEFORWEB, options);
  doc.close(SaveOptions.DONOTSAVECHANGES);
  return outputFile;
}

function resizeCover(doc, width, height) {
  var originalWidth = unitValueToPx(doc.width);
  var originalHeight = unitValueToPx(doc.height);
  var scale = Math.max(width / originalWidth, height / originalHeight);
  var resizedWidth = Math.ceil(originalWidth * scale);
  var resizedHeight = Math.ceil(originalHeight * scale);
  doc.resizeImage(UnitValue(resizedWidth, "px"), UnitValue(resizedHeight, "px"), 72, ResampleMethod.BICUBIC);
  var left = Math.max(0, Math.round((resizedWidth - width) / 2));
  var top = Math.max(0, Math.round((resizedHeight - height) / 2));
  doc.crop([
    UnitValue(left, "px"),
    UnitValue(top, "px"),
    UnitValue(left + width, "px"),
    UnitValue(top + height, "px")
  ]);
}

function collectReplacementSmartObjects(layers, parentPath, output) {
  for (var i = 0; i < layers.length; i += 1) {
    var layer = layers[i];
    var layerPath = parentPath ? parentPath + "/" + layer.name : layer.name;
    if (layer.typename === "ArtLayer") {
      if (isReplacementSmartObject(layer)) {
        output.push({ layer: layer, path: layerPath });
      }
    } else if (layer.typename === "LayerSet") {
      collectReplacementSmartObjects(layer.layers, layerPath, output);
    }
  }
}

function isReplacementSmartObject(layer) {
  try {
    if (layer.kind !== LayerKind.SMARTOBJECT) return false;
  } catch (_) {
    return false;
  }
  var info = readSmartObjectInfo(layer);
  if (Math.abs(Number(info.width || 0) - 1600) > 3) return false;
  if (Math.abs(Number(info.height || 0) - 960) > 3) return false;
  return /桌布链接图|zhuobu|table/i.test(info.fileReference || "") || true;
}

function readSmartObjectInfo(layer) {
  var output = { fileReference: "", width: 0, height: 0 };
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

function replaceSmartObjectContents(sourceFile) {
  var desc = new ActionDescriptor();
  desc.putPath(charIDToTypeID("null"), sourceFile);
  executeAction(stringIDToTypeID("placedLayerReplaceContents"), desc, DialogModes.NO);
}

function exportScene(doc, sceneTop, sceneWidth, sceneHeight, outputFile, outputFormat) {
  var tempDoc = copySceneToNewDocument(doc, sceneTop, sceneWidth, sceneHeight);
  var options = new ExportOptionsSaveForWeb();

  if (outputFormat === "png") {
    options.format = SaveDocumentType.PNG;
    options.PNG8 = false;
    options.transparency = true;
    options.interlaced = false;
  } else if (outputFormat === "jpg" || outputFormat === "jpeg") {
    options.format = SaveDocumentType.JPEG;
    options.quality = 90;
    options.optimized = true;
  } else {
    options.format = SaveDocumentType.COMPUSERVEGIF;
    options.colors = 256;
    options.interlaced = false;
    options.transparency = false;
  }

  tempDoc.exportDocument(outputFile, ExportType.SAVEFORWEB, options);
  tempDoc.close(SaveOptions.DONOTSAVECHANGES);
}

function copySceneToNewDocument(doc, sceneTop, sceneWidth, sceneHeight) {
  app.activeDocument = doc;
  doc.selection.select([[0, sceneTop], [sceneWidth, sceneTop], [sceneWidth, sceneTop + sceneHeight], [0, sceneTop + sceneHeight]]);
  doc.selection.copy(true);
  var tempDoc = app.documents.add(UnitValue(sceneWidth, "px"), UnitValue(sceneHeight, "px"), 72, "scene-export", NewDocumentMode.RGB, DocumentFill.WHITE);
  tempDoc.paste();
  return tempDoc;
}

function readDescriptorNumber(desc, key) {
  var type = desc.getType(key);
  if (type === DescValueType.UNITDOUBLE) return desc.getUnitDoubleValue(key);
  if (type === DescValueType.DOUBLETYPE) return desc.getDouble(key);
  if (type === DescValueType.INTEGERTYPE) return desc.getInteger(key);
  if (type === DescValueType.LARGEINTEGERTYPE) return desc.getLargeInteger(key);
  return 0;
}

function readLayerId(layer) {
  try {
    return Number(layer.id);
  } catch (_) {
    return 0;
  }
}

function unitValueToPx(value) {
  try {
    return Math.round(value.as("px") * 1000) / 1000;
  } catch (_) {
    return Number(value);
  }
}

function outputExtension(format) {
  if (format === "jpeg") return "jpg";
  if (format === "jpg") return "jpg";
  if (format === "png") return "png";
  return "gif";
}

function pad2(value) {
  return ("0" + value).slice(-2);
}

function parseSimpleJson(text) {
  try {
    return eval("(" + text + ")");
  } catch (error) {
    throw new Error("invalid json: " + error);
  }
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
