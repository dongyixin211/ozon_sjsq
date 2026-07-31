import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
const repo = "E:/tool/ozon_sjsq";
const sourcePath = path.join(repo, ".codex-work/inputs/lion.png");
const refDir = path.join(repo, ".codex-work/mockup-ps-direct/huazhuangbao-lion");
const baseTemplate = path.join(repo, "server/src/mockup-templates/huazhuangbao");
const tempRoot = path.join(repo, ".codex-work/hz-opacity-search/templates");
await fs.rm(tempRoot,{recursive:true,force:true});
await fs.mkdir(tempRoot,{recursive:true});
const sharpPath = pathToFileURL(path.join(repo,"server/node_modules/sharp/lib/index.js")).href;
const rendererPath = pathToFileURL(path.join(repo,"server/dist/src/mockup-renderer.js")).href;
const {default: sharp}=await import(sharpPath);
process.env.JWT_SECRET ||= "local-render-preview-secret-123456"; process.env.ADMIN_TOKEN ||= "local-admin-token-123456"; process.env.DATABASE_URL ||= "postgres://x:x@127.0.0.1:5432/x"; process.env.STORAGE_PROVIDER ||= "local"; process.env.STORAGE_BUCKET ||= "x"; process.env.STORAGE_PUBLIC_BASE_URL ||= "http://127.0.0.1"; process.env.MOCKUP_TEMPLATE_ROOT = tempRoot;
const sourceBuffer=await fs.readFile(sourcePath);
const refs=new Map(); for(let i=1;i<=6;i++) refs.set(i, await fs.readFile(path.join(refDir,`ps-direct-${String(i).padStart(2,"0")}.jpg`)));
const rows=[];
for (const factor of [1,0.9,0.8,0.7,0.6,0.5]) {
  const slug=`hz-${String(factor).replace('.','p')}`;
  const dir=path.join(tempRoot,slug);
  await fs.cp(baseTemplate,dir,{recursive:true});
  const jsonPath=path.join(dir,"template.json");
  const template=JSON.parse(await fs.readFile(jsonPath,"utf8"));
  let changed=0;
  for (const scene of template.scenes) for (const layer of scene.layers) {
    if (layer.kind === "replace" && layer.blendMode === "multiply") { layer.opacity = +(Number(layer.opacity ?? 1)*factor).toFixed(4); changed++; }
  }
  await fs.writeFile(jsonPath, JSON.stringify(template,null,2));
  const {renderMockupsWithTemplate}=await import(`${rendererPath}?f=${factor}_${Date.now()}`);
  const rendered=await renderMockupsWithTemplate({templateDir:slug, sourceBuffer, sku:'SEARCH'});
  const maes=[];
  for (const scene of rendered.scenes) maes.push(await mae(refs.get(scene.index), scene.buffer));
  rows.push({factor, changed, average:avg(maes), scenes:maes.map(v=>+v.toFixed(2)).join(', ')});
}
rows.sort((a,b)=>a.average-b.average);
console.table(rows.map(r=>({...r, average:+r.average.toFixed(3)})));
async function mae(refBuf, locBuf){ const ref=await sharp(refBuf).resize(1086,1448,{fit:'fill'}).removeAlpha().raw().toBuffer({resolveWithObject:true}); const loc=await sharp(locBuf).resize(1086,1448,{fit:'fill'}).removeAlpha().raw().toBuffer({resolveWithObject:true}); let s=0; for(let i=0;i<ref.data.length;i+=3)s+=(Math.abs(ref.data[i]-loc.data[i])+Math.abs(ref.data[i+1]-loc.data[i+1])+Math.abs(ref.data[i+2]-loc.data[i+2]))/3; return s/(ref.data.length/3); }
function avg(v){return v.reduce((s,x)=>s+x,0)/v.length}

