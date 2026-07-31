import fs from "node:fs";
import path from "node:path";

const outputDir = path.resolve("server/src/public/app");
const viteHtml = path.join(outputDir, "index.web.html");
const targetHtml = path.join(outputDir, "index.html");

if (fs.existsSync(viteHtml)) {
  fs.renameSync(viteHtml, targetHtml);
  console.log("已生成网页版入口：server/src/public/app/index.html");
} else if (fs.existsSync(targetHtml)) {
  console.log("网页版入口已存在：server/src/public/app/index.html");
} else {
  throw new Error("没有找到网页版入口文件，请检查 Vite Web 构建结果。");
}
