import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = path.resolve(import.meta.dirname, "..");
const args = parseArgs(process.argv.slice(2));
const sourcePath = path.resolve(args.source || "D:/ozon/商品图/桌布/原图/TM20251025000433.png");
const referenceDir = path.resolve(args.referenceDir || "D:/ozon/商品图/桌布/套图/TM20251025000433");
const outputDir = path.resolve(args.outputDir || path.join(repoRoot, ".codex-work", "zhuobu-scene7-mesh-scan"));
const templateRoot = path.join(outputDir, "templates");
const rendererPath = pathToFileURL(path.join(repoRoot, "server", "dist", "src", "mockup-renderer.js")).href;
const sharpPath = pathToFileURL(path.join(repoRoot, "server", "node_modules", "sharp", "lib", "index.js")).href;

process.env.JWT_SECRET ||= "local-render-preview-secret-123456";
process.env.ADMIN_TOKEN ||= "local-admin-token-123456";
process.env.DATABASE_URL ||= "postgres://preview:preview@127.0.0.1:5432/preview";
process.env.STORAGE_PROVIDER ||= "local";
process.env.STORAGE_BUCKET ||= "local-preview";
process.env.STORAGE_PUBLIC_BASE_URL ||= "http://127.0.0.1:8787";
process.env.MOCKUP_TEMPLATE_ROOT = templateRoot;

await fs.rm(outputDir, { recursive: true, force: true });
await fs.mkdir(templateRoot, { recursive: true });

const baseDir = path.join(repoRoot, "server", "src", "mockup-templates", "zhuobu");
const baseTemplate = JSON.parse(await fs.readFile(path.join(baseDir, "template.json"), "utf8"));
const { renderMockupsWithTemplate, invalidateMockupTemplateCache } = await import(`${rendererPath}?scene7MeshScan=${Date.now()}`);
const { default: sharp } = await import(sharpPath);
const sourceBuffer = await fs.readFile(sourcePath);
const sku = path.basename(sourcePath, path.extname(sourcePath));
const referencePath = path.join(referenceDir, `111_${sku}_07.gif`);
const referenceBuffer = await fs.readFile(referencePath);

const candidates = createCandidates();
const summaries = [];
for (const candidate of candidates) {
  const targetDir = path.join(templateRoot, candidate.name);
  await fs.cp(baseDir, targetDir, { recursive: true });
  const template = structuredClone(baseTemplate);
  mutateScene7Meshes(template, candidate);
  await fs.writeFile(path.join(targetDir, "template.json"), `${JSON.stringify(template, null, 2)}\n`, "utf8");
  invalidateMockupTemplateCache(candidate.name);

  const rendered = await renderMockupsWithTemplate({
    templateDir: candidate.name,
    sourceBuffer,
    sku,
    sceneIndexes: [7],
  });
  const scene = rendered.scenes[0];
  const cloudPath = path.join(outputDir, `${candidate.name}-cloud-07.png`);
  await fs.writeFile(cloudPath, scene.buffer);
  const metrics = await calculateMetrics(sharp, referenceBuffer, scene.buffer);
  const summary = {
    ...candidate,
    cloudPath,
    ...metrics,
  };
  summaries.push(summary);
  console.log(JSON.stringify({
    name: candidate.name,
    similarity: metrics.similarity,
    farSimilarity: metrics.farSimilarity,
    farMissPct: metrics.farMissPct,
  }));
}

summaries.sort((left, right) => right.similarity - left.similarity);
await fs.writeFile(path.join(outputDir, "summary.json"), `${JSON.stringify(summaries, null, 2)}\n`, "utf8");
await createComparison(sharp, summaries.slice(0, 12), referenceBuffer, outputDir);

console.table(summaries.slice(0, 20).map((item) => ({
  name: item.name,
  similarity: item.similarity,
  farSimilarity: item.farSimilarity,
  farMissPct: item.farMissPct,
  frontSimilarity: item.frontSimilarity,
})));
console.log(path.join(outputDir, "summary.json"));
console.log(path.join(outputDir, "scene-07-top-candidates.jpg"));

function createCandidates() {
  const output = [{ name: "baseline", topLift: 0, midLift: 0, bottomLift: 0, scaleX: 1, scaleY: 1, dx: 0, dy: 0 }];
  for (const topLift of [-220, -180, -140, -110, -80, -50, 50]) {
    output.push({ name: `top${slugNumber(topLift)}`, topLift, midLift: topLift * 0.45, bottomLift: 0, scaleX: 1, scaleY: 1, dx: 0, dy: 0 });
  }
  for (const topLift of [-180, -140, -110, -80]) {
    for (const scaleX of [0.92, 0.96, 1.04, 1.08]) {
      output.push({ name: `top${slugNumber(topLift)}-sx${slugNumber(scaleX)}`, topLift, midLift: topLift * 0.45, bottomLift: 0, scaleX, scaleY: 1, dx: 0, dy: 0 });
    }
  }
  for (const scaleY of [0.88, 0.94, 1.06, 1.12]) {
    output.push({ name: `sy${slugNumber(scaleY)}`, topLift: 0, midLift: 0, bottomLift: 0, scaleX: 1, scaleY, dx: 0, dy: 0 });
  }
  for (const dy of [-80, -50, -25, 25, 50]) {
    output.push({ name: `dy${slugNumber(dy)}`, topLift: 0, midLift: 0, bottomLift: 0, scaleX: 1, scaleY: 1, dx: 0, dy });
  }
  for (const topLift of [-160, -120, -90]) {
    for (const dy of [20, 40, 60]) {
      output.push({ name: `top${slugNumber(topLift)}-dy${slugNumber(dy)}`, topLift, midLift: topLift * 0.45, bottomLift: 0, scaleX: 1, scaleY: 1, dx: 0, dy });
    }
  }
  return output;
}

function mutateScene7Meshes(template, candidate) {
  const scene = template.scenes.find((item) => item.index === 7);
  if (!scene) throw new Error("scene 7 not found");
  for (const layer of scene.layers) {
    if (layer.kind !== "replace" || !layer.perspectiveMesh) continue;
    const mesh = layer.perspectiveMesh;
    const centerX = average(mesh.warpedVertices.map((point) => point.x));
    const centerY = average(mesh.warpedVertices.map((point) => point.y));
    mesh.warpedVertices = mesh.warpedVertices.map((point, index) => {
      const source = mesh.vertices[index] || { x: 0.5, y: 0.5 };
      const topWeight = Math.max(0, 1 - Number(source.y || 0));
      const bottomWeight = Math.max(0, Number(source.y || 0));
      const midWeight = 1 - Math.abs(Number(source.y || 0) - 0.5) * 2;
      return {
        x: round(centerX + (point.x - centerX) * (candidate.scaleX ?? 1) + (candidate.dx ?? 0)),
        y: round(centerY + (point.y - centerY) * (candidate.scaleY ?? 1)
          + (candidate.dy ?? 0)
          + (candidate.topLift ?? 0) * topWeight
          + (candidate.midLift ?? 0) * Math.max(0, midWeight)
          + (candidate.bottomLift ?? 0) * bottomWeight),
      };
    });
  }
}

async function calculateMetrics(sharp, referenceBuffer, cloudBuffer) {
  const reference = await rawRgb(sharp, referenceBuffer);
  const cloud = await rawRgb(sharp, cloudBuffer);
  const base = await rawRgb(sharp, await fs.readFile(path.join(baseDir, "layers", "scene-07-layer-005.png")));
  const all = calculateBox(reference, cloud, base, { left: 0, top: 0, width: 800, height: 1067 });
  const far = calculateBox(reference, cloud, base, { left: 0, top: 330, width: 800, height: 240 });
  const front = calculateBox(reference, cloud, base, { left: 0, top: 530, width: 800, height: 330 });
  return {
    mae: all.mae,
    similarity: all.similarity,
    farSimilarity: far.similarity,
    farMissPct: far.missPct,
    frontSimilarity: front.similarity,
  };
}

function calculateBox(reference, cloud, base, box) {
  let sum = 0;
  let psPattern = 0;
  let cloudPattern = 0;
  let missed = 0;
  const total = box.width * box.height;
  for (let y = box.top; y < box.top + box.height; y += 1) {
    for (let x = box.left; x < box.left + box.width; x += 1) {
      const offset = (y * 800 + x) * 3;
      sum += pixelDiff(reference.data, cloud.data, offset);
      const psIsPattern = pixelDiff(reference.data, base.data, offset) > 26 && !isNearWhite(reference.data, offset);
      const cloudIsPattern = pixelDiff(cloud.data, base.data, offset) > 26 && !isNearWhite(cloud.data, offset);
      if (psIsPattern) psPattern += 1;
      if (cloudIsPattern) cloudPattern += 1;
      if (psIsPattern && !cloudIsPattern) missed += 1;
    }
  }
  const mae = sum / total;
  return {
    mae: Number(mae.toFixed(3)),
    similarity: Number((100 - (mae / 255) * 100).toFixed(2)),
    psPatternPct: Number(((psPattern / total) * 100).toFixed(2)),
    cloudPatternPct: Number(((cloudPattern / total) * 100).toFixed(2)),
    missPct: Number(((missed / total) * 100).toFixed(2)),
  };
}

async function rawRgb(sharp, input) {
  return sharp(input, { animated: false })
    .resize(800, 1067, { fit: "fill" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
}

function pixelDiff(left, right, offset) {
  return (
    Math.abs(left[offset] - right[offset])
    + Math.abs(left[offset + 1] - right[offset + 1])
    + Math.abs(left[offset + 2] - right[offset + 2])
  ) / 3;
}

function isNearWhite(data, offset) {
  const r = data[offset];
  const g = data[offset + 1];
  const b = data[offset + 2];
  return r > 225 && g > 225 && b > 225 && Math.max(r, g, b) - Math.min(r, g, b) < 24;
}

async function createComparison(sharp, summaries, referenceBuffer, outputDir) {
  const panels = [await labelPanel(sharp, referenceBuffer, "PS")];
  for (const summary of summaries) {
    panels.push(await labelPanel(sharp, await fs.readFile(summary.cloudPath), `${summary.name} ${summary.similarity}%`));
  }
  await sharp({
    create: {
      width: panels.length * 260 + (panels.length - 1) * 10,
      height: 391,
      channels: 3,
      background: "#ffffff",
    },
  })
    .composite(panels.map((input, index) => ({ input, left: index * 270, top: 0 })))
    .jpeg({ quality: 90 })
    .toFile(path.join(outputDir, "scene-07-top-candidates.jpg"));
}

async function labelPanel(sharp, buffer, label) {
  const image = await sharp(buffer, { animated: false }).resize({ width: 260, height: 347, fit: "fill" }).jpeg({ quality: 90 }).toBuffer();
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="260" height="44"><rect width="260" height="44" fill="#111827"/><text x="8" y="28" font-family="Arial" font-size="14" fill="#fff">${escapeXml(label)}</text></svg>`);
  return sharp({ create: { width: 260, height: 391, channels: 3, background: "#fff" } })
    .composite([{ input: svg, left: 0, top: 0 }, { input: image, left: 0, top: 44 }])
    .jpeg({ quality: 90 })
    .toBuffer();
}

function average(values) {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
}

function slugNumber(value) {
  return String(value).replace("-", "m").replace(".", "p");
}

function round(value) {
  return Math.round(Number(value || 0) * 1000) / 1000;
}

function escapeXml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--source") {
      parsed.source = values[index + 1] || "";
      index += 1;
    } else if (value === "--reference-dir") {
      parsed.referenceDir = values[index + 1] || "";
      index += 1;
    } else if (value === "--output-dir") {
      parsed.outputDir = values[index + 1] || "";
      index += 1;
    }
  }
  return parsed;
}
