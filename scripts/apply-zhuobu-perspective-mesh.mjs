import fs from "node:fs/promises";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const args = parseArgs(process.argv.slice(2));
const reportPath = path.resolve(args.report || path.join(repoRoot, "dist", "mockup-inspect-smart", "zhuobu", "smart-report.json"));
const templatePath = path.resolve(args.template || path.join(repoRoot, "server", "src", "mockup-templates", "zhuobu", "template.json"));
const sceneHeight = Number(args.sceneHeight || 1067);

const report = JSON.parse(await fs.readFile(reportPath, "utf8"));
const template = JSON.parse(await fs.readFile(templatePath, "utf8"));
const meshBySceneAndName = new Map();

for (const item of report.smartObjects || []) {
  const more = item.descriptor?.smartObjectMore?.value;
  const filterValue = item.descriptor?.smartObject?.value?.filterFX?.[0]?.value?.filter?.value
    || more?.filterFX?.value?.filterFXList?.[0]?.value?.filter?.value;
  if (!more?.transform || !filterValue?.vertices || !filterValue?.warpedVertices || !filterValue?.quads) {
    continue;
  }

  const sceneIndex = Math.floor((Number(more.transform[1]) || 0) / sceneHeight) + 1;
  const sceneOffsetY = (sceneIndex - 1) * sceneHeight;
  const localTransform = toLocalPointQuad(more.transform, sceneOffsetY);
  const filterOffsetY = resolveFilterOffsetY(filterValue, more.transform, sceneHeight);
  const inverseTransform = invertHomography(homographyFromUnitSquare(localTransform));
  if (!inverseTransform) {
    continue;
  }

  const vertices = filterValue.vertices.map((entry) => {
    const point = descriptorPointToLocalPoint(entry, sceneOffsetY + filterOffsetY);
    const uv = mapTargetToUnit(inverseTransform, point.x, point.y);
    return {
      x: round(uv?.u ?? 0),
      y: round(uv?.v ?? 0),
    };
  });
  const warpedVertices = filterValue.warpedVertices.map((entry) => {
    const point = descriptorPointToLocalPoint(entry, sceneOffsetY + filterOffsetY);
    return {
      x: round(point.x),
      y: round(point.y),
    };
  });
  const quads = filterValue.quads.map((entry) => entry.value.indices);

  meshBySceneAndName.set(`${sceneIndex}:${normalizeName(item.name)}`, {
    vertices,
    warpedVertices,
    quads,
  });
}

let updated = 0;
for (const scene of template.scenes || []) {
  for (const layer of scene.layers || []) {
    if (layer.kind !== "replace") {
      continue;
    }
    const mesh = meshBySceneAndName.get(`${scene.index}:${normalizeName(layer.name)}`);
    if (!mesh) {
      delete layer.perspectiveMesh;
      continue;
    }
    layer.perspectiveMesh = mesh;
    updated += 1;
  }
}

await fs.writeFile(templatePath, `${JSON.stringify(template, null, 2)}\n`, "utf8");
console.log(JSON.stringify({
  reportPath,
  templatePath,
  meshes: meshBySceneAndName.size,
  updated,
}, null, 2));

function descriptorPointToLocalPoint(entry, sceneOffsetY) {
  return {
    x: Number(entry.value.horizontal),
    y: Number(entry.value.vertical) - sceneOffsetY,
  };
}

function resolveFilterOffsetY(filterValue, transformValues, sceneHeight) {
  const points = [
    ...(filterValue.vertices || []),
    ...(filterValue.warpedVertices || []),
  ];
  if (!points.length) {
    return 0;
  }
  const filterCenterY = average(points.map((entry) => Number(entry.value.vertical)));
  const transformCenterY = average([
    Number(transformValues[1]),
    Number(transformValues[3]),
    Number(transformValues[5]),
    Number(transformValues[7]),
  ]);
  const sceneOffsetCount = Math.round((filterCenterY - transformCenterY) / sceneHeight);
  if (sceneOffsetCount === 0) {
    return 0;
  }
  const offset = sceneOffsetCount * sceneHeight;
  const correctedCenterY = filterCenterY - offset;
  const transformHalfHeight = Math.max(
    1,
    (Math.max(Number(transformValues[1]), Number(transformValues[3]), Number(transformValues[5]), Number(transformValues[7]))
      - Math.min(Number(transformValues[1]), Number(transformValues[3]), Number(transformValues[5]), Number(transformValues[7]))) / 2,
  );
  return Math.abs(correctedCenterY - transformCenterY) <= transformHalfHeight * 1.5 ? offset : 0;
}

function average(values) {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
}

function toLocalPointQuad(values, sceneOffsetY) {
  return [
    { x: Number(values[0]), y: Number(values[1]) - sceneOffsetY },
    { x: Number(values[2]), y: Number(values[3]) - sceneOffsetY },
    { x: Number(values[4]), y: Number(values[5]) - sceneOffsetY },
    { x: Number(values[6]), y: Number(values[7]) - sceneOffsetY },
  ];
}

function homographyFromUnitSquare(points) {
  const [topLeft, topRight, bottomRight, bottomLeft] = points;
  const dx1 = topRight.x - bottomRight.x;
  const dy1 = topRight.y - bottomRight.y;
  const dx2 = bottomLeft.x - bottomRight.x;
  const dy2 = bottomLeft.y - bottomRight.y;
  const dx3 = topLeft.x - topRight.x + bottomRight.x - bottomLeft.x;
  const dy3 = topLeft.y - topRight.y + bottomRight.y - bottomLeft.y;
  const denominator = dx1 * dy2 - dx2 * dy1;
  if (Math.abs(denominator) < 0.000001) {
    return {
      a: topRight.x - topLeft.x,
      b: bottomLeft.x - topLeft.x,
      c: topLeft.x,
      d: topRight.y - topLeft.y,
      e: bottomLeft.y - topLeft.y,
      f: topLeft.y,
      g: 0,
      h: 0,
    };
  }
  const g = (dx3 * dy2 - dx2 * dy3) / denominator;
  const h = (dx1 * dy3 - dx3 * dy1) / denominator;
  return {
    a: topRight.x - topLeft.x + g * topRight.x,
    b: bottomLeft.x - topLeft.x + h * bottomLeft.x,
    c: topLeft.x,
    d: topRight.y - topLeft.y + g * topRight.y,
    e: bottomLeft.y - topLeft.y + h * bottomLeft.y,
    f: topLeft.y,
    g,
    h,
  };
}

function invertHomography(homography) {
  const { a, b, c, d, e, f, g, h } = homography;
  const determinant =
    a * (e - f * h)
    - b * (d - f * g)
    + c * (d * h - e * g);
  if (Math.abs(determinant) < 0.000001) {
    return null;
  }
  return {
    m00: (e - f * h) / determinant,
    m01: (c * h - b) / determinant,
    m02: (b * f - c * e) / determinant,
    m10: (f * g - d) / determinant,
    m11: (a - c * g) / determinant,
    m12: (c * d - a * f) / determinant,
    m20: (d * h - e * g) / determinant,
    m21: (b * g - a * h) / determinant,
    m22: (a * e - b * d) / determinant,
  };
}

function mapTargetToUnit(inverse, x, y) {
  const denominator = inverse.m20 * x + inverse.m21 * y + inverse.m22;
  if (Math.abs(denominator) < 0.000001) {
    return null;
  }
  return {
    u: (inverse.m00 * x + inverse.m01 * y + inverse.m02) / denominator,
    v: (inverse.m10 * x + inverse.m11 * y + inverse.m12) / denominator,
  };
}

function normalizeName(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--report") {
      parsed.report = values[index + 1] || "";
      index += 1;
    } else if (value === "--template") {
      parsed.template = values[index + 1] || "";
      index += 1;
    } else if (value === "--scene-height") {
      parsed.sceneHeight = values[index + 1] || "";
      index += 1;
    }
  }
  return parsed;
}
