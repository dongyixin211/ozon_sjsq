import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
const repo="E:/tool/ozon_sjsq";
const base=path.join(repo,"server/src/mockup-templates/huazhuangbao");
const root=path.join(repo,".codex-work/hz-clip-search/templates");
const slug="hz-forceclip"; const dir=path.join(root,slug);
await fs.rm(root,{recursive:true,force:true}); await fs.mkdir(root,{recursive:true}); await fs.cp(base,dir,{recursive:true});
const sharpPath=pathToFileURL(path.join(repo,"server/node_modules/sharp/lib/index.js")).href; const {default: sharp}=await import(sharpPath);
const templatePath=path.join(dir,"template.json"); const t=JSON.parse(await fs.readFile(templatePath,"utf8")); let changed=0;
const alphaCache=new Map();
async function alphaRatio(file, scene){ if(!file) return 1; if(alphaCache.has(file)) return alphaCache.get(file); const p=path.join(dir,file); const {data,info}=await sharp(p).ensureAlpha().raw().toBuffer({resolveWithObject:true}); let non=0; for(let i=3;i<data.length;i+=4) if(data[i]>0) non++; const ratio=non/(scene.width*scene.height); alphaCache.set(file,ratio); return ratio; }
for (const scene of t.scenes) {
  for (let i=0;i<scene.layers.length;i++) {
    const layer=scene.layers[i]; if (layer.kind!=="replace" || layer.clipMask) continue;
    const candidates=[];
    for (let j=0;j<scene.layers.length;j++) {
      const x=scene.layers[j]; if(x.kind!=='image'||!x.file) continue;
      const ratio=await alphaRatio(x.file, scene); if(ratio>0 && ratio<0.8) candidates.push({layer:x, distance:Math.abs(j-i), ratio});
    }
    candidates.sort((a,b)=>a.distance-b.distance || b.ratio-a.ratio);
    const next=candidates[0]?.layer; if(!next) continue;
    layer.clipMask = `masks/bright-${path.basename(next.file)}`;
    layer.clipMaskLeft = 0; layer.clipMaskTop = 0; layer.clipMaskWidth = scene.width; layer.clipMaskHeight = scene.height;
    changed++;
  }
}
await fs.writeFile(templatePath, JSON.stringify(t,null,2));
const rendererPath=pathToFileURL(path.join(repo,"server/dist/src/mockup-renderer.js")).href;
process.env.JWT_SECRET ||= "local-render-preview-secret-123456"; process.env.ADMIN_TOKEN ||= "local-admin-token-123456"; process.env.DATABASE_URL ||= "postgres://x:x@127.0.0.1:5432/x"; process.env.STORAGE_PROVIDER ||= "local"; process.env.STORAGE_BUCKET ||= "x"; process.env.STORAGE_PUBLIC_BASE_URL ||= "http://127.0.0.1"; process.env.MOCKUP_TEMPLATE_ROOT=root;
const {renderMockupsWithTemplate}=await import(`${rendererPath}?forceclip=${Date.now()}`);
const sourceBuffer=await fs.readFile(path.join(repo,".codex-work/inputs/lion.png")); const rendered=await renderMockupsWithTemplate({templateDir:slug,sourceBuffer,sku:'forceclip'});
const maes=[]; for (const scene of rendered.scenes) { const ref=await fs.readFile(path.join(repo,".codex-work/mockup-ps-direct/huazhuangbao-lion",`ps-direct-${String(scene.index).padStart(2,'0')}.jpg`)); maes.push(await mae(ref,scene.buffer)); }
console.log({changed, average:avg(maes), scenes:maes.map(v=>+v.toFixed(3))});
async function mae(refBuf, locBuf){ const ref=await sharp(refBuf).resize(1086,1448,{fit:'fill'}).removeAlpha().raw().toBuffer({resolveWithObject:true}); const loc=await sharp(locBuf).resize(1086,1448,{fit:'fill'}).removeAlpha().raw().toBuffer({resolveWithObject:true}); let s=0; for(let i=0;i<ref.data.length;i+=3)s+=(Math.abs(ref.data[i]-loc.data[i])+Math.abs(ref.data[i+1]-loc.data[i+1])+Math.abs(ref.data[i+2]-loc.data[i+2]))/3; return s/(ref.data.length/3); }
function avg(v){return v.reduce((s,x)=>s+x,0)/v.length}
