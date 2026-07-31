import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
const repo = "E:/tool/ozon_sjsq";
const sharpPath = pathToFileURL(path.join(repo, "server/node_modules/sharp/lib/index.js")).href;
const { default: sharp } = await import(sharpPath);
for (let scene=1; scene<=6; scene++) {
  const psPath = path.join(repo, ".codex-work/mockup-ps-direct/huazhuangbao-lion", `ps-direct-${String(scene).padStart(2,"0")}.jpg`);
  const localPath = path.join(repo, ".codex-work/huazhuangbao-current-diff", `local-${String(scene).padStart(2,"0")}.png`);
  const ps = await sharp(psPath).resize(1086,1448,{fit:"fill"}).removeAlpha().raw().toBuffer({resolveWithObject:true});
  const lo = await sharp(localPath).resize(1086,1448,{fit:"fill"}).removeAlpha().raw().toBuffer({resolveWithObject:true});
  let sum=[0,0,0], abs=[0,0,0], count=0, high=0;
  for (let i=0;i<ps.data.length;i+=3) {
    const d0=lo.data[i]-ps.data[i], d1=lo.data[i+1]-ps.data[i+1], d2=lo.data[i+2]-ps.data[i+2];
    const a=(Math.abs(d0)+Math.abs(d1)+Math.abs(d2))/3;
    if (a < 8) continue;
    sum[0]+=d0; sum[1]+=d1; sum[2]+=d2;
    abs[0]+=Math.abs(d0); abs[1]+=Math.abs(d1); abs[2]+=Math.abs(d2);
    count++;
    if (a>25) high++;
  }
  console.log(scene, {count, high, meanSigned:sum.map(v=>+(v/count).toFixed(2)), meanAbs:abs.map(v=>+(v/count).toFixed(2))});
}
