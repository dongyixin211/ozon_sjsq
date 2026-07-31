import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index], process.argv[index + 1]);
}

const version = args.get("--version");
const url = args.get("--url");
const signaturePath = args.get("--signature");
const required = process.argv.includes("--required");
const notes = args.get("--notes") ?? "常规功能更新";

if (!version || !url || !signaturePath) {
  console.error("用法: npm run updater:manifest -- --version 1.2.3 --url https://.../Ozon.SJSQ_1.2.3_x64-setup.nsis.zip --signature <sig文件> [--notes 更新说明] [--required]");
  process.exit(1);
}

const signature = (await readFile(path.resolve(signaturePath), "utf8")).trim();
const outputPath = path.resolve("server/src/public/updates/latest.json");
const manifest = {
  version,
  notes: `${required ? "[required] " : ""}${notes}`,
  pub_date: new Date().toISOString(),
  platforms: {
    "windows-x86_64": { signature, url },
  },
};

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
console.log(`已生成 ${outputPath}`);
