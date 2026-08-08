import { encodeBmp, canvasBlob } from './js/image-export.js';

const width = 3;
const height = 2;
const rgba = new Uint8ClampedArray([
  255, 0, 0, 255,  0, 255, 0, 255,  0, 0, 255, 255,
  1, 2, 3, 255,    4, 5, 6, 255,      7, 8, 9, 255,
]);
const canvas = {
  width, height,
  getContext: () => ({ getImageData: () => ({ data: rgba }) }),
  toBlob: callback => callback(new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' })),
};

const bmp = new Uint8Array(await encodeBmp(canvas).arrayBuffer());
const view = new DataView(bmp.buffer);
const rowSize = 12;
const checks = {
  signature: bmp[0] === 0x42 && bmp[1] === 0x4d,
  dimensions: view.getInt32(18, true) === width && view.getInt32(22, true) === height,
  depth: view.getUint16(28, true) === 24,
  alignment: bmp.length === 54 + rowSize * height,
  bottomUpBgr: bmp.slice(54, 63).join(',') === '3,2,1,6,5,4,9,8,7',
};
const png = await canvasBlob(canvas, 'png');
checks.png = png.type === 'image/png' && png.size > 0;
for (const [name, passed] of Object.entries(checks)) console.log(`${passed ? 'PASS' : 'FAIL'} ${name}`);
if (Object.values(checks).some(passed => !passed)) process.exit(1);
