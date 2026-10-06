import { PNG } from 'pngjs';
import { mkdir, writeFile } from 'node:fs/promises';
await mkdir('icons', { recursive: true });
for (const [name, size] of [['icon-192',192],['icon-512',512],['apple-touch-icon',180]]) {
  const png = new PNG({ width:size, height:size });
  for (let y=0;y<size;y++) for (let x=0;x<size;x++) {
    let coverage=0;
    for (const ox of [.25,.75]) for (const oy of [.25,.75]) {
      const a=(x+ox)/size, b=(y+oy)/size, dx=a-.5, dy=b-.43;
      const r=Math.hypot(dx,dy), angle=Math.atan2(dy,dx);
      const arc=(Math.abs(r-.19)<.014 || Math.abs(r-.30)<.014) && angle>-.95 && angle<2.19;
      const mast=Math.abs(dx)<.016 && b>.43 && b<.73;
      const foot=b>.70 && b<.735 && Math.abs(dx)<.12;
      if (arc||mast||foot||r<.04) coverage++;
    }
    const i=(y*size+x)*4, mix=coverage/4;
    for(let k=0;k<3;k++) png.data[i+k]=Math.round([7,12,14][k]*(1-mix)+[65,223,186][k]*mix);
    png.data[i+3]=255;
  }
  await writeFile(`icons/${name}.png`,PNG.sync.write(png));
}
