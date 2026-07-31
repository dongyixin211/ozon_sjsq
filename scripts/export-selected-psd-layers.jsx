#target photoshop

(function () {
  var argsFile = new File("E:/tool/ozon_sjsq/dist/mockup-convert/selected-layers-job.json");
  if (!argsFile.exists) throw new Error("missing selected-layers-job.json");

  argsFile.encoding = "UTF8";
  argsFile.open("r");
  var argsText = argsFile.read();
  argsFile.close();
  var args = eval("(" + argsText + ")");

  var psdFile = new File(args.psdPath);
  var sceneTop = Number(args.sceneTop || 0);
  var sceneWidth = Number(args.sceneWidth || 1086);
  var sceneHeight = Number(args.sceneHeight || 1448);
  var outputDir = new Folder(args.outputDir);
  if (!outputDir.exists) outputDir.create();

  app.displayDialogs = DialogModes.NO;

  var doc = null;
  var states = [];
  try {
    doc = app.open(psdFile);
    collectLayerStates(doc.layers, states);

    for (var i = 0; i < args.layers.length; i += 1) {
      var item = args.layers[i];
      var layer = findLayerByPath(doc.layers, String(item.path).split("/"), 0);
      if (!layer) throw new Error("layer not found: " + item.path);
      var outputFile = new File(outputDir.fsName + "/" + item.fileName);
      exportSingleLayer(doc, layer, sceneTop, sceneWidth, sceneHeight, outputFile, states);
    }

    restoreLayerStates(states);
    doc.close(SaveOptions.DONOTSAVECHANGES);
  } catch (error) {
    try {
      if (doc) doc.close(SaveOptions.DONOTSAVECHANGES);
    } catch (_) {}
    throw error;
  }
})();

function findLayerByPath(layers, parts, index) {
  for (var i = 0; i < layers.length; i += 1) {
    var layer = layers[i];
    if (String(layer.name) !== parts[index]) continue;
    if (index === parts.length - 1) return layer;
    if (layer.typename === "LayerSet") {
      return findLayerByPath(layer.layers, parts, index + 1);
    }
  }
  return null;
}

function collectLayerStates(layers, output) {
  for (var i = 0; i < layers.length; i += 1) {
    var layer = layers[i];
    output.push({ layer: layer, visible: Boolean(layer.visible) });
    if (layer.typename === "LayerSet") collectLayerStates(layer.layers, output);
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

function exportSingleLayer(doc, layer, sceneTop, sceneWidth, sceneHeight, outputFile, states) {
  hideAllLayers(states);
  showLayerAndParents(layer);
  exportScenePng(doc, sceneTop, sceneWidth, sceneHeight, outputFile);
  restoreLayerStates(states);
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
    "selected-layer-export",
    NewDocumentMode.RGB,
    DocumentFill.TRANSPARENT
  );
  tempDoc.paste();
  return tempDoc;
}
