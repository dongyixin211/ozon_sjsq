#target photoshop

(function () {
  var argsFile = new File("E:/tool/ozon_sjsq/dist/mockup-inspect-smart/current-job.json");
  if (!argsFile.exists) throw new Error("missing current-job.json");

  argsFile.encoding = "UTF8";
  argsFile.open("r");
  var argsText = argsFile.read();
  argsFile.close();
  var args = parseSimpleJson(argsText);

  var psdFile = new File(args.psdPath);
  var outputDir = new Folder(args.outputDir);
  if (!outputDir.exists) outputDir.create();

  app.displayDialogs = DialogModes.NO;

  var report = {
    ok: false,
    psdPath: psdFile.fsName,
    documentName: "",
    width: 0,
    height: 0,
    smartObjects: [],
    error: ""
  };

  var doc = null;
  try {
    doc = app.open(psdFile);
    report.ok = true;
    report.documentName = doc.name;
    report.width = unitValueToPx(doc.width);
    report.height = unitValueToPx(doc.height);

    collectSmartObjects(doc.layers, "", report.smartObjects);
    doc.close(SaveOptions.DONOTSAVECHANGES);
  } catch (error) {
    report.ok = false;
    report.error = String(error);
    try {
      if (doc) doc.close(SaveOptions.DONOTSAVECHANGES);
    } catch (_) {}
  }

  var reportFile = new File(outputDir.fsName + "/smart-report.json");
  reportFile.encoding = "UTF8";
  reportFile.open("w");
  reportFile.write(toJson(report));
  reportFile.close();
})();

function collectSmartObjects(layers, parentPath, output) {
  for (var i = 0; i < layers.length; i += 1) {
    var layer = layers[i];
    var layerPath = parentPath ? parentPath + "/" + layer.name : layer.name;
    if (layer.typename === "ArtLayer") {
      if (isSmartObject(layer)) {
        var bounds = readBounds(layer.bounds);
        output.push({
          path: layerPath,
          name: layer.name,
          id: readLayerId(layer),
          visible: Boolean(layer.visible),
          opacity: Number(layer.opacity),
          blendMode: String(layer.blendMode),
          bounds: bounds,
          width: Math.max(0, bounds.right - bounds.left),
          height: Math.max(0, bounds.bottom - bounds.top),
          descriptor: readLayerDescriptor(layer)
        });
      }
    } else if (layer.typename === "LayerSet") {
      collectSmartObjects(layer.layers, layerPath, output);
    }
  }
}

function isSmartObject(layer) {
  try {
    return layer.kind === LayerKind.SMARTOBJECT;
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

function readLayerDescriptor(layer) {
  try {
    app.activeDocument.activeLayer = layer;
    var ref = new ActionReference();
    ref.putEnumerated(charIDToTypeID("Lyr "), charIDToTypeID("Ordn"), charIDToTypeID("Trgt"));
    var desc = executeActionGet(ref);
    return descriptorToObject(desc, 0);
  } catch (error) {
    return { error: String(error) };
  }
}

function descriptorToObject(desc, depth) {
  if (depth > 10) return "[max-depth]";
  var output = {};
  for (var i = 0; i < desc.count; i += 1) {
    var key = desc.getKey(i);
    var name = idToName(key);
    output[name] = descriptorValueToObject(desc, key, depth);
  }
  return output;
}

function descriptorValueToObject(desc, key, depth) {
  var type = desc.getType(key);
  try {
    switch (type) {
      case DescValueType.BOOLEANTYPE:
        return desc.getBoolean(key);
      case DescValueType.STRINGTYPE:
        return desc.getString(key);
      case DescValueType.DOUBLETYPE:
        return desc.getDouble(key);
      case DescValueType.INTEGERTYPE:
        return desc.getInteger(key);
      case DescValueType.LARGEINTEGERTYPE:
        return desc.getLargeInteger(key);
      case DescValueType.UNITDOUBLE:
        return desc.getUnitDoubleValue(key);
      case DescValueType.ENUMERATEDTYPE:
        return {
          enumType: idToName(desc.getEnumerationType(key)),
          enumValue: idToName(desc.getEnumerationValue(key))
        };
      case DescValueType.OBJECTTYPE:
        return {
          objectType: idToName(desc.getObjectType(key)),
          value: descriptorToObject(desc.getObjectValue(key), depth + 1)
        };
      case DescValueType.LISTTYPE:
        return listToObject(desc.getList(key), depth + 1);
      case DescValueType.ALIASTYPE:
        return String(desc.getPath(key));
      case DescValueType.RAWTYPE:
        return "[raw]";
      case DescValueType.CLASSTYPE:
        return idToName(desc.getClass(key));
      case DescValueType.REFERENCETYPE:
        return "[reference]";
      default:
        return "[unknown:" + type + "]";
    }
  } catch (error) {
    return "[error:" + String(error) + "]";
  }
}

function listToObject(list, depth) {
  if (depth > 10) return "[max-depth]";
  var output = [];
  for (var i = 0; i < list.count; i += 1) {
    var type = list.getType(i);
    try {
      switch (type) {
        case DescValueType.BOOLEANTYPE:
          output.push(list.getBoolean(i));
          break;
        case DescValueType.STRINGTYPE:
          output.push(list.getString(i));
          break;
        case DescValueType.DOUBLETYPE:
          output.push(list.getDouble(i));
          break;
        case DescValueType.INTEGERTYPE:
          output.push(list.getInteger(i));
          break;
        case DescValueType.LARGEINTEGERTYPE:
          output.push(list.getLargeInteger(i));
          break;
        case DescValueType.UNITDOUBLE:
          output.push(list.getUnitDoubleValue(i));
          break;
        case DescValueType.OBJECTTYPE:
          output.push({
            objectType: idToName(list.getObjectType(i)),
            value: descriptorToObject(list.getObjectValue(i), depth + 1)
          });
          break;
        case DescValueType.LISTTYPE:
          output.push(listToObject(list.getList(i), depth + 1));
          break;
        case DescValueType.ENUMERATEDTYPE:
          output.push({
            enumType: idToName(list.getEnumerationType(i)),
            enumValue: idToName(list.getEnumerationValue(i))
          });
          break;
        default:
          output.push("[type:" + type + "]");
      }
    } catch (error) {
      output.push("[error:" + String(error) + "]");
    }
  }
  return output;
}

function idToName(id) {
  try {
    var stringName = typeIDToStringID(id);
    if (stringName) return stringName;
  } catch (_) {}
  try {
    return typeIDToCharID(id);
  } catch (_) {}
  return String(id);
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
