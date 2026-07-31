import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = path.resolve(import.meta.dirname, "..");
const args = parseArgs(process.argv.slice(2));
const sourceDir = path.resolve(args.sourceDir || "D:/ozon/商品图/桌布/原图");
const referenceRoot = path.resolve(args.referenceRoot || "D:/ozon/商品图/桌布/套图");
const outputDir = path.resolve(args.outputDir || path.join(repoRoot, ".codex-work", "zhuobu-scene7-mesh"));
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
const { renderMockupsWithTemplate, invalidateMockupTemplateCache } = await import(`${rendererPath}?scene7Mesh=${Date.now()}`);
const { default: sharp } = await import(sharpPath);

const samples = await collectSamples(sourceDir, referenceRoot);
if (!samples.length) {
  throw new Error("没有找到可用的桌布 PS 参考图");
}

const candidates = createCandidates();
const filter = args.candidates
  ? new Set(args.candidates.split(",").map((value) => value.trim()).filter(Boolean))
  : null;

const summaries = [];
for (const candidate of candidates) {
  if (filter && !filter.has(candidate.name)) {
    continue;
  }
  const targetDir = path.join(templateRoot, candidate.name);
  await fs.cp(baseDir, targetDir, { recursive: true });
  const template = structuredClone(baseTemplate);
  candidate.mutate(template);
  await fs.writeFile(path.join(targetDir, "template.json"), `${JSON.stringify(template, null, 2)}\n`, "utf8");
  invalidateMockupTemplateCache(candidate.name);

  const rows = [];
  for (const sample of samples) {
    const sourceBuffer = await fs.readFile(sample.sourcePath);
    const rendered = await renderMockupsWithTemplate({
      templateDir: candidate.name,
      sourceBuffer,
      sku: sample.sku,
      sceneIndexes: [7],
    });
    const scene = rendered.scenes[0];
    if (args.keepImages === "true") {
      await fs.writeFile(path.join(outputDir, `${candidate.name}-${sample.sku}-07.png`), scene.buffer);
    }
    const referenceBuffer = await fs.readFile(sample.refs[7]);
    const mae = await calculateMae(referenceBuffer, scene.buffer);
    rows.push({
      sku: sample.sku,
      mae: Number(mae.toFixed(3)),
      similarity: Number((100 - (mae / 255) * 100).toFixed(3)),
    });
  }
  const summary = {
    name: candidate.name,
    averageSimilarity: round3(average(rows.map((row) => row.similarity))),
    worstSimilarity: round3(Math.min(...rows.map((row) => row.similarity))),
    rows,
  };
  summaries.push(summary);
  console.log(JSON.stringify({
    name: summary.name,
    average: summary.averageSimilarity,
    worst: summary.worstSimilarity,
  }));
}

summaries.sort((left, right) => {
  const averageDiff = right.averageSimilarity - left.averageSimilarity;
  if (Math.abs(averageDiff) > 0.0005) {
    return averageDiff;
  }
  return right.worstSimilarity - left.worstSimilarity;
});
await fs.writeFile(path.join(outputDir, "summary.json"), `${JSON.stringify({ samples: samples.map((sample) => sample.sku), summaries }, null, 2)}\n`, "utf8");
console.table(summaries.slice(0, 20).map((summary) => ({
  name: summary.name,
  average: summary.averageSimilarity,
  worst: summary.worstSimilarity,
})));
console.log(path.join(outputDir, "summary.json"));

function createCandidates() {
  const candidates = [{ name: "baseline", mutate: () => {} }];
  for (const axis of ["x", "y"]) {
    for (const amount of [-4, -3, -2, -1, 1, 2, 3, 4]) {
      candidates.push({
        name: `global-${axis}${signed(amount)}`,
        mutate: (template) => nudgeScene7(template, ({ set }) => set(axis, amount)),
      });
    }
  }
  for (const axis of ["x", "y"]) {
    for (const amount of [-8, -6, -4, -2, 2, 4, 6, 8]) {
      candidates.push({
        name: `bottom-${axis}${signed(amount)}`,
        mutate: (template) => nudgeScene7(template, ({ uv, set }) => {
          const weight = smoothstep(0.55, 1, uv.y);
          set(axis, amount * weight);
        }),
      });
      candidates.push({
        name: `midbottom-${axis}${signed(amount)}`,
        mutate: (template) => nudgeScene7(template, ({ uv, set }) => {
          const weight = Math.max(0, 1 - Math.abs(uv.y - 0.78) / 0.32);
          set(axis, amount * weight);
        }),
      });
      candidates.push({
        name: `center-${axis}${signed(amount)}`,
        mutate: (template) => nudgeScene7(template, ({ uv, set }) => {
          const weightX = Math.max(0, 1 - Math.abs(uv.x - 0.5) / 0.5);
          const weightY = Math.max(0, 1 - Math.abs(uv.y - 0.72) / 0.38);
          set(axis, amount * weightX * weightY);
        }),
      });
      candidates.push({
        name: `right-${axis}${signed(amount)}`,
        mutate: (template) => nudgeScene7(template, ({ uv, set }) => {
          const weight = smoothstep(0.55, 1, uv.x);
          set(axis, amount * weight);
        }),
      });
      candidates.push({
        name: `left-${axis}${signed(amount)}`,
        mutate: (template) => nudgeScene7(template, ({ uv, set }) => {
          const weight = smoothstep(0.45, 0, uv.x);
          set(axis, amount * weight);
        }),
      });
    }
  }
  for (const amountX of [-6, -4, -2, 2, 4, 6]) {
    for (const amountY of [-6, -4, -2, 2, 4, 6]) {
      candidates.push({
        name: `bottom-xy${signed(amountX)}-${signed(amountY)}`,
        mutate: (template) => nudgeScene7(template, ({ uv, add }) => {
          const weight = smoothstep(0.55, 1, uv.y);
          add(amountX * weight, amountY * weight);
        }),
      });
    }
  }
  for (const amount of [-5, -4.5, -4, -3.5, -3, -2.5, -2, -1.5, -1, -0.5]) {
    candidates.push({
      name: `center-fine-y${signed(amount)}`,
      mutate: (template) => nudgeScene7(template, ({ uv, set }) => {
        const weightX = Math.max(0, 1 - Math.abs(uv.x - 0.5) / 0.5);
        const weightY = Math.max(0, 1 - Math.abs(uv.y - 0.72) / 0.38);
        set("y", amount * weightX * weightY);
      }),
    });
  }
  for (const amountX of [-3, -2, -1, 1, 2, 3]) {
    for (const amountY of [-5, -4, -3, -2, -1]) {
      candidates.push({
        name: `center-xy${signed(amountX)}-${signed(amountY)}`,
        mutate: (template) => nudgeScene7(template, ({ uv, add }) => {
          const weightX = Math.max(0, 1 - Math.abs(uv.x - 0.5) / 0.5);
          const weightY = Math.max(0, 1 - Math.abs(uv.y - 0.72) / 0.38);
          add(amountX * weightX * weightY, amountY * weightX * weightY);
        }),
      });
    }
  }
  for (const strength of [0, 0.08, 0.12, 0.16, 0.18, 0.2, 0.22, 0.24, 0.28, 0.32]) {
    candidates.push({
      name: `linear-${strength}`,
      mutate: (template) => {
        const scene = template.scenes.find((item) => item.index === 7);
        scene.linearLightStrength = strength;
      },
    });
  }
  for (const amount of [-4, -3, -2.5, -2, -1.5, -1]) {
    candidates.push({
      name: `linear0-center-y${signed(amount)}`,
      mutate: (template) => {
        const scene = template.scenes.find((item) => item.index === 7);
        scene.linearLightStrength = 0;
        nudgeScene7(template, ({ uv, set }) => {
          const weightX = Math.max(0, 1 - Math.abs(uv.x - 0.5) / 0.5);
          const weightY = Math.max(0, 1 - Math.abs(uv.y - 0.72) / 0.38);
          set("y", amount * weightX * weightY);
        });
      },
    });
  }
  return candidates;
}

function nudgeScene7(template, fn) {
  const scene = template.scenes.find((item) => item.index === 7);
  const layer = scene?.layers.find((item) => item.kind === "replace");
  const mesh = layer?.perspectiveMesh;
  if (!mesh) {
    throw new Error("scene 7 mesh missing");
  }
  mesh.warpedVertices = mesh.warpedVertices.map((point, index) => {
    let dx = 0;
    let dy = 0;
    const uv = mesh.vertices[index];
    fn({
      uv,
      add: (x, y) => {
        dx += x;
        dy += y;
      },
      set: (axis, value) => {
        if (axis === "x") {
          dx += value;
        } else {
          dy += value;
        }
      },
    });
    return {
      x: round3(point.x + dx),
      y: round3(point.y + dy),
    };
  });
}

function smoothstep(edge0, edge1, value) {
  const t = Math.max(0, Math.min(1, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

async function collectSamples(sourceDir, referenceRoot) {
  const sourceFiles = (await fs.readdir(sourceDir))
    .filter((file) => /\.(png|jpe?g|webp)$/i.test(file))
    .sort();
  const samples = [];
  for (const file of sourceFiles) {
    const sku = path.basename(file, path.extname(file));
    const refs = await completeReferenceFiles(referenceRoot, sku);
    if (!refs) {
      continue;
    }
    samples.push({
      sku,
      sourcePath: path.join(sourceDir, file),
      refs,
    });
  }
  return samples;
}

async function completeReferenceFiles(root, sku) {
  const candidateDirs = [
    path.join(root, sku),
    path.join(root, sku, "images"),
  ];
  for (const refDir of candidateDirs) {
    const refs = {};
    let complete = true;
    for (let scene = 1; scene <= 9; scene += 1) {
      const file = path.join(refDir, `111_${sku}_${String(scene).padStart(2, "0")}.gif`);
      try {
        await fs.access(file);
        refs[scene] = file;
      } catch {
        complete = false;
        break;
      }
    }
    if (complete) {
      return refs;
    }
  }
  return null;
}

async function calculateMae(referenceBuffer, cloudBuffer) {
  const reference = await sharp(referenceBuffer, { animated: false })
    .resize(800, 1067, { fit: "fill" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const cloud = await sharp(cloudBuffer)
    .resize(800, 1067, { fit: "fill" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let sum = 0;
  for (let offset = 0; offset < reference.data.length; offset += 3) {
    sum += (
      Math.abs(reference.data[offset] - cloud.data[offset])
      + Math.abs(reference.data[offset + 1] - cloud.data[offset + 1])
      + Math.abs(reference.data[offset + 2] - cloud.data[offset + 2])
    ) / 3;
  }
  return sum / (reference.data.length / 3);
}

function average(values) {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
}

function round3(value) {
  return Number(value.toFixed(3));
}

function signed(value) {
  return value > 0 ? `+${value}` : `${value}`;
}

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--source-dir") {
      parsed.sourceDir = values[index + 1] || "";
      index += 1;
    } else if (value === "--reference-root") {
      parsed.referenceRoot = values[index + 1] || "";
      index += 1;
    } else if (value === "--output-dir") {
      parsed.outputDir = values[index + 1] || "";
      index += 1;
    } else if (value === "--keep-images") {
      parsed.keepImages = values[index + 1] || "";
      index += 1;
    } else if (value === "--candidates") {
      parsed.candidates = values[index + 1] || "";
      index += 1;
    }
  }
  return parsed;
}
