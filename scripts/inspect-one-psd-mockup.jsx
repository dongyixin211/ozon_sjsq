#target photoshop

(function () {
  var argsFile = new File("E:/tool/ozon_sjsq/dist/mockup-inspect/current-job.json");
  if (!argsFile.exists) throw new Error("缺少 current-job.json");

  argsFile.encoding = "UTF8";
  argsFile.open("r");
  var argsText = argsFile.read();
  argsFile.close();
  var args = parseSimpleJson(argsText);

  var psdFile = new File(args.psdPath);
  var outputDir = new Folder(args.outputDir);
  if (!outputDir.exists) outputDir.create();

  app.displayDialogs = DialogModes.NO;

  var row = {
    fileName: psdFile.name,
    psdPath: psdFile.fsName,
    ok: false,
    documentName: "",
    width: 0,
    height: 0,
    smartObjectCount: 0,
    layers: [],
    previewFiles: [],
    error: ""
  };

  try {
    var doc = app.open(psdFile);
    row.ok = true;
    row.documentName = doc.name;
    row.width = unitValueToPx(doc.width);
    row.height = unitValueToPx(doc.height);

    collectLayers(doc.layers, "", row.layers);
    for (var i = 0; i < row.layers.length; i += 1) {
      if (row.layers[i].kind === "SMARTOBJECT") row.smartObjectCount += 1;
    }

    var previewFile = new File(outputDir.fsName + "/preview.jpg");
    exportPreview(doc, previewFile);
    row.previewFiles.push(previewFile.fsName);

    doc.close(SaveOptions.DONOTSAVECHANGES);
  } catch (error) {
    row.error = String(error);
    try {
      if (app.documents.length > 0) {
        app.activeDocument.close(SaveOptions.DONOTSAVECHANGES);
      }
    } catch (_) {}
  }

  var reportFile = new File(outputDir.fsName + "/report.json");
  reportFile.encoding = "UTF8";
  reportFile.open("w");
  reportFile.write(toJson(row));
  reportFile.close();
})();

function collectLayers(layers, path, output) {
  for (var i = 0; i < layers.length; i += 1) {
    var layer = layers[i];
    var layerPath = path ? path + "/" + layer.name : layer.name;
    if (layer.typename === "ArtLayer") {
      var bounds = readBounds(layer.bounds);
      output.push({
        path: layerPath,
        name: layer.name,
        visible: Boolean(layer.visible),
        kind: readLayerKind(layer),
        bounds: bounds,
        width: Math.max(0, bounds.right - bounds.left),
        height: Math.max(0, bounds.bottom - bounds.top),
        opacity: Number(layer.opacity),
        blendMode: String(layer.blendMode)
      });
    } else if (layer.typename === "LayerSet") {
      var groupBounds = readBounds(layer.bounds);
      output.push({
        path: layerPath,
        name: layer.name,
        visible: Boolean(layer.visible),
        kind: "GROUP",
        bounds: groupBounds,
        width: Math.max(0, groupBounds.right - groupBounds.left),
        height: Math.max(0, groupBounds.bottom - groupBounds.top),
        opacity: 100,
        blendMode: "GROUP"
      });
      collectLayers(layer.layers, layerPath, output);
    }
  }
}

function readLayerKind(layer) {
  try {
    if (layer.kind === LayerKind.SMARTOBJECT) return "SMARTOBJECT";
    if (layer.kind === LayerKind.TEXT) return "TEXT";
    if (layer.kind === LayerKind.SOLIDFILL) return "SOLIDFILL";
    if (layer.kind === LayerKind.NORMAL) return "NORMAL";
    return String(layer.kind);
  } catch (_) {
    return "UNKNOWN";
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

function exportPreview(doc, outputFile) {
  var originalWidth = unitValueToPx(doc.width);
  var maxWidth = 900;
  var duplicate = doc.duplicate();
  if (originalWidth > maxWidth) {
    duplicate.resizeImage(UnitValue(maxWidth, "px"), null, null, ResampleMethod.BICUBIC);
  }
  var options = new ExportOptionsSaveForWeb();
  options.format = SaveDocumentType.JPEG;
  options.quality = 82;
  options.optimized = true;
  duplicate.exportDocument(outputFile, ExportType.SAVEFORWEB, options);
  duplicate.close(SaveOptions.DONOTSAVECHANGES);
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
