import fs from "node:fs";
import path from "node:path";

copyDirectory("src/public", "dist/src/public", "已复制静态后台文件。");
copyDirectory("src/mockup-templates", "dist/src/mockup-templates", "已复制样机模板文件。");

function copyDirectory(sourcePath, targetPath, message) {
  const source = path.resolve(sourcePath);
  const target = path.resolve(targetPath);

  if (!fs.existsSync(source)) {
    return;
  }

  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });

  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    fs.cpSync(from, to, { recursive: true });
  }

  console.log(message);
}
