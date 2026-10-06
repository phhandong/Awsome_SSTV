import { chromium } from 'playwright-core';
import { mkdir, readFile } from 'node:fs/promises';

// Header, favicon and install icons share one vector source.
await mkdir('icons', { recursive: true });
const svg = await readFile('icons/satellite.svg', 'utf8');
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: true,
});
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  for (const [name, size] of [['icon-192', 192], ['icon-512', 512], ['apple-touch-icon', 180]]) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(`<style>html,body{margin:0;background:#070c0e}svg{display:block;width:100vw;height:100vh}</style>${svg}`);
    await page.screenshot({ path: `icons/${name}.png` });
  }
} finally {
  await browser.close();
}
