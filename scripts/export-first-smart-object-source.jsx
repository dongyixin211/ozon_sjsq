#target photoshop

(function () {
  var argsFile = new File("E:/tool/ozon_sjsq/dist/mockup-inspect-smart/source-job.json");
  if (!argsFile.exists) throw new Error("missing source-job.json");

  argsFile.encoding = "UTF8";
  argsFile.open("r");
  var argsText = argsFile.read();
  argsFile.close();
  var args = eval("(" + argsText + ")");

  app.displayDialogs = DialogModes.NO;

  var psdFile = new File(args.psdPath);
  var outputFile = new File(args.outputPath);
  var doc = app.open(psdFile);
  try {
    var layer = findFirstVisibleSmartObject(doc.layers);
    if (!layer) throw new Error("no visible smart object found");
    app.activeDocument = doc;
    doc.activeLayer = layer;
    executeAction(stringIDToTypeID("placedLayerEditContents"), undefined, DialogModes.NO);
    var sourceDoc = app.activeDocument;
    exportPng(sourceDoc, outputFile);
    sourceDoc.close(SaveOptions.DONOTSAVECHANGES);
    app.activeDocument = doc;
    doc.close(SaveOptions.DONOTSAVECHANGES);
  } catch (error) {
    try {
      if (app.activeDocument && app.activeDocument !== doc) {
        app.activeDocument.close(SaveOptions.DONOTSAVECHANGES);
      }
    } catch (_) {}
    try {
      doc.close(SaveOptions.DONOTSAVECHANGES);
    } catch (_) {}
    throw error;
  }
})();

function findFirstVisibleSmartObject(layers) {
  for (var i = layers.length - 1; i >= 0; i -= 1) {
    var layer = layers[i];
    if (!layer.visible) continue;
    if (layer.typename === "ArtLayer") {
      try {
        if (layer.kind === LayerKind.SMARTOBJECT && Number(layer.opacity) > 0) return layer;
      } catch (_) {}
    } else if (layer.typename === "LayerSet") {
      var nested = findFirstVisibleSmartObject(layer.layers);
      if (nested) return nested;
    }
  }
  return null;
}

function exportPng(doc, outputFile) {
  var options = new ExportOptionsSaveForWeb();
  options.format = SaveDocumentType.PNG;
  options.PNG8 = false;
  options.transparency = true;
  options.interlaced = false;
  doc.exportDocument(outputFile, ExportType.SAVEFORWEB, options);
}
