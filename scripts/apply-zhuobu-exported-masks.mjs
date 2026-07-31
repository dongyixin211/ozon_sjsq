import fs from "node:fs/promises";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const args = parseArgs(process.argv.slice(2));
const exportRoot = path.resolve(args.exportRoot || path.join(repoRoot, ".codex-work", "zhuobu-mask-export-v2"));
const templateDir = path.resolve(args.templateDir || path.join(repoRoot, "server", "src", "mockup-templates", "zhuobu"));
const templatePath = path.join(templateDir, "template.json");
const masksDir = path.join(templateDir, "masks");

await fs.mkdir(masksDir, { recursive: true });

const template = JSON.parse(await fs.readFile(templatePath, "utf8"));
const exportedMasks = await readExportedMasks(exportRoot);
let applied = 0;

for (const scene of template.scenes) {
  if (scene.index > 8) {
    continue;
  }
  for (const layer of scene.layers) {
    if (layer.kind !== "replace") {
      continue;
    }
    const exported = exportedMasks.get(maskKey(scene.index, layer.name));
    if (!exported) {
      throw new Error(`exported mask not found: scene ${scene.index} ${layer.name}`);
    }
    await fs.copyFile(exported.sourceFile, path.join(templateDir, exported.maskFile));
    layer.mask = exported.maskFile;
    delete layer.clipMask;
    delete layer.clipMaskLeft;
    delete layer.clipMaskTop;
    delete layer.clipMaskWidth;
    delete layer.clipMaskHeight;
    delete layer.clipBaseName;
    applied += 1;
  }
}

await fs.writeFile(templatePath, `${JSON.stringify(template, null, 2)}\n`, "utf8");

console.log(JSON.stringify({
  templatePath,
  exportRoot,
  applied,
}, null, 2));

async function readExportedMasks(root) {
  const output = new Map();
  for (let sceneIndex = 1; sceneIndex <= 8; sceneIndex += 1) {
    const sceneDir = path.join(root, `scene-${String(sceneIndex).padStart(2, "0")}`);
    const report = JSON.parse(await fs.readFile(path.join(sceneDir, "scene-export-report.json"), "utf8"));
    for (const layer of report.scene.layers.filter((item) => item.kind === "replace")) {
      output.set(maskKey(sceneIndex, layer.name), {
        sceneIndex,
        name: layer.name,
        maskFile: layer.maskFile,
        sourceFile: path.join(sceneDir, layer.maskFile),
      });
    }
  }
  return output;
}

function maskKey(sceneIndex, name) {
  return `${sceneIndex}::${name}`;
}

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--export-root") {
      parsed.exportRoot = values[index + 1] || "";
      index += 1;
    } else if (value === "--template-dir") {
      parsed.templateDir = values[index + 1] || "";
      index += 1;
    }
  }
  return parsed;
}
