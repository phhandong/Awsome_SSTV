import { mkdir, copyFile, writeFile } from 'node:fs/promises';
import { build } from 'esbuild';

await mkdir('js/vendor', { recursive: true });
await copyFile('node_modules/satellite.js/dist/satellite.es.js', 'js/vendor/satellite.es.js');
await copyFile('node_modules/satellite.js/LICENSE.md', 'LICENSES/satellite-js-MIT.txt');
await copyFile('node_modules/geomagnetism/LICENSE', 'LICENSES/geomagnetism-Apache-2.0.txt');
// Bundle only WMM2025; avoid runtime CDN requests and obsolete coefficient sets.
await build({
  stdin: { contents: "import Model from 'geomagnetism/lib/model.js'; import coefficients from 'geomagnetism/data/wmm-2025.json'; export default new Model(coefficients);", resolveDir: process.cwd() },
  bundle: true, format: 'esm', platform: 'browser', target: 'safari18',
  outfile: 'js/vendor/wmm2025.js',
  banner: { js: '/* geomagnetism 0.2.0 — Apache-2.0; NOAA/BGS WMM2025 coefficients. See LICENSES. */' },
});
await writeFile('LICENSES/tracking-NOTICE.md', `# Satellite tracking dependencies\n\n- satellite.js 6.0.1: MIT; https://github.com/shashwatak/satellite-js\n- geomagnetism 0.2.0: Apache-2.0; https://github.com/naturalatlas/geomagnetism\n- WMM2025: NOAA/NCEI and British Geological Survey, https://www.ncei.noaa.gov/products/world-magnetic-model (2025.0–2030.0).\n\nRebuild local browser bundles with npm run vendor:tracking. No CDN is used at runtime.\n`);
