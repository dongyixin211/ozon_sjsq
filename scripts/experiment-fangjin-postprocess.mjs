import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = path.resolve(import.meta.dirname, "..");
const compareDir = path.join(repoRoot, "dist", "ps-compare");
const psDir = "D:/ozon/商品图/套图/TJ20251116000279/images";
const sharpPath = pathToFileURL(path.join(repoRoot, "server", "node_modules", "sharp", "lib", "index.js")).href;
const { default: sharp } = await import(sharpPath);

console.log("注意：本脚本基于 dist/ps-compare/cloud-xx.jpg 做二次后处理，会再次 JPEG 编码；结果只用于判断后处理方向，不等同于渲染器原始输出指标。");

const configs = [
  { name: "baseline" },
  ...[0.3, 0.45, 0.6, 0.75, 0.9].map((sigma) => ({ name: `blur-${sigma}`, blur: sigma })),
  ...[0.2, 0.35, 0.5, 0.75, 1].map((sigma) => ({ name: `sharpen-${sigma}`, sharpen: { sigma } })),
  ...[
    { sigma: 0.5, flat: 1, jagged: 1.5 },
    { sigma: 0.7, flat: 1, jagged: 1.5 },
    { sigma: 0.9, flat: 1, jagged: 1.5 },
    { sigma: 1, flat: 1, jagged: 2 },
    { sigma: 1.2, flat: 1, jagged: 2 },
    { sigma: 1.4, flat: 1, jagged: 2 },
  ].map((value) => ({ name: `sharpen-${value.sigma}-${value.flat}-${value.jagged}`, sharpen: value })),
  ...[80, 86, 90, 92, 95, 98, 100].map((quality) => ({ name: `jpeg-q${quality}`, jpegQuality: quality })),
  ...[6, 8, 10, 12, 14].map((bits) => ({ name: `posterize-${bits}`, posterizeBits: bits })),
  ...[1, 1.5, 2, 2.5].map((amount) => ({ name: `edge-soft-${amount}`, edgeSoft: amount })),
];

const rows = [];
for (const config of configs) {
  const values = [];
  const directValues = [];
  for (let scene = 1; scene <= 6; scene += 1) {
    const cloudPath = path.join(compareDir, `cloud-${String(scene).padStart(2, "0")}.jpg`);
    const psPath = path.join(psDir, `111_TJ20251116000279_${String(scene).padStart(2, "0")}.gif`);
    const cloudBuffer = await fs.readFile(cloudPath);
    const candidate = await applyConfig(cloudBuffer, config);
    const psDirectBuffer = await sharp(psPath, { animated: false }).toBuffer();
    const psBuffer = await sharp(psDirectBuffer).jpeg({ quality: 92 }).toBuffer();
    values.push(await calculateMae(psBuffer, candidate));
    directValues.push(await calculateMae(psDirectBuffer, candidate));
  }
  rows.push({
    config: config.name,
    avg: average(values),
    directAvg: average(directValues),
    s1: round(values[0]),
    s2: round(values[1]),
    s3: round(values[2]),
    s4: round(values[3]),
    s5: round(values[4]),
    s6: round(values[5]),
    d1: round(directValues[0]),
    d2: round(directValues[1]),
    d3: round(directValues[2]),
    d4: round(directValues[3]),
    d5: round(directValues[4]),
    d6: round(directValues[5]),
  });
}

rows.sort((left, right) => left.avg - right.avg);
console.log("按历史 MAE 排序：");
console.table(rows.slice(0, 25));
console.log("按直接 GIF MAE 排序：");
console.table([...rows].sort((left, right) => left.directAvg - right.directAvg).slice(0, 25));

async function applyConfig(buffer, config) {
  let image = sharp(buffer);
  if (config.blur) {
    image = image.blur(config.blur);
  }
  if (config.sharpen) {
    image = image.sharpen(config.sharpen);
  }
  if (config.posterizeBits) {
    const { data, info } = await sharp(buffer).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const levels = (1 << config.posterizeBits) - 1;
    const output = Buffer.from(data);
    for (let index = 0; index < output.length; index += 1) {
      output[index] = Math.round((Math.round((output[index] / 255) * levels) / levels) * 255);
    }
    image = sharp(output, { raw: info });
  }
  if (config.edgeSoft) {
    image = await edgeSoftenedImage(buffer, config.edgeSoft);
  }
  if (config.jpegQuality) {
    return image.jpeg({ quality: config.jpegQuality, mozjpeg: true }).toBuffer();
  }
  return image.jpeg({ quality: 92, mozjpeg: true }).toBuffer();
}

async function edgeSoftenedImage(buffer, amount) {
  const [{ data, info }, blurred] = await Promise.all([
    sharp(buffer).removeAlpha().raw().toBuffer({ resolveWithObject: true }),
    sharp(buffer).blur(amount).removeAlpha().raw().toBuffer(),
  ]);
  const output = Buffer.from(data);
  const width = info.width;
  const height = info.height;
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const offset = (y * width + x) * 3;
      const gx = gradientAt(data, width, offset, 3);
      const gy = gradientAt(data, width, offset, width * 3);
      const edge = Math.min(1, (gx + gy) / 160);
      if (edge <= 0.08) {
        continue;
      }
      for (let channel = 0; channel < 3; channel += 1) {
        output[offset + channel] = Math.round(data[offset + channel] * (1 - edge) + blurred[offset + channel] * edge);
      }
    }
  }
  return sharp(output, { raw: info });
}

function gradientAt(data, _width, offset, step) {
  return (
    Math.abs(data[offset] - data[offset + step])
    + Math.abs(data[offset + 1] - data[offset + step + 1])
    + Math.abs(data[offset + 2] - data[offset + step + 2])
  ) / 3;
}

async function calculateMae(psBuffer, candidateBuffer) {
  const [ps, candidate] = await Promise.all([
    sharp(psBuffer).resize(800, 1067, { fit: "fill" }).removeAlpha().raw().toBuffer({ resolveWithObject: true }),
    sharp(candidateBuffer).resize(800, 1067, { fit: "fill" }).removeAlpha().raw().toBuffer({ resolveWithObject: true }),
  ]);
  let sum = 0;
  for (let offset = 0; offset < ps.data.length; offset += 3) {
    sum += (
      Math.abs(ps.data[offset] - candidate.data[offset])
      + Math.abs(ps.data[offset + 1] - candidate.data[offset + 1])
      + Math.abs(ps.data[offset + 2] - candidate.data[offset + 2])
    ) / 3;
  }
  return sum / (ps.data.length / 3);
}

function average(values) {
  return round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function round(value) {
  return Number(value.toFixed(3));
}
