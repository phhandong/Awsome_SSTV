import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, resolve, relative, isAbsolute } from 'node:path';
import { chromium } from 'playwright-core';

await mkdir('test-artifacts', {recursive:true});
const root=process.cwd(), fixture=await readFile('test-fixtures/iss.json','utf8');
const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.webmanifest':'application/manifest+json','.png':'image/png','.woff2':'font/woff2'};
let release=1;
const server=createServer(async(req,res)=>{
  try {
    let pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
    if(pathname.startsWith('/Awsome_SSTV/')) pathname=pathname.slice('/Awsome_SSTV'.length);
    const file=resolve(root,pathname.replace(/^\//,'')||'index.html'), rel=relative(root,file);
    if(rel.startsWith('..')||isAbsolute(rel)) throw Error('invalid path');
    let body=await readFile(file);
    if(file.endsWith('sw-assets.js')) body=Buffer.from(body.toString().replace(/(OFFLINE_VERSION = '[^']+)/,`$1-test${release}`));
    if(file.endsWith('index.html')) body=Buffer.from(body.toString().replace('<head>',`<head><meta name="test-release" content="${release}">`));
    res.setHeader('Content-Type',mime[extname(file)]||'text/plain'); res.setHeader('Cache-Control','no-store'); res.end(body);
  } catch(_){res.statusCode=404;res.end('not found');}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const base=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',headless:true,args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream']});
async function decodeFixedProbe() {
  const {encode}=await import('./js/encoder.js'),{getMode}=await import('./js/modes.js'),{WebSSTVDecoder}=await import('./js/web-receiver.js');
  const mode=getMode(8),rgba=new Uint8ClampedArray(mode.width*mode.height*4);rgba.fill(180);
  const pcm=encode({rgba},mode,{sampleRate:11025}),decoder=new WebSSTVDecoder();
  try {
    const result=await decoder.decode(pcm,11025,{dsp:{engine:'mmsstv',bpf:true},emitFrames:false});
    return result.pixels.reduce((sum,v)=>sum+v,0);
  } finally {decoder.destroy();}
}
try {
  for(const prefix of ['/Awsome_SSTV/','/']) {
    release=1;
    const context=await browser.newContext({viewport:{width:390,height:844},permissions:['microphone']});
    let fetches=0;
    await context.route('https://celestrak.org/**',route=>{fetches++;return route.fulfill({status:200,contentType:'application/json',body:fixture});});
    await context.addInitScript(()=>{
      window.testOrientationAllowed=true;
      window.DeviceOrientationEvent.requestPermission=async()=>window.testOrientationAllowed?'granted':'denied';
    });
    const page=await context.newPage(), errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    await page.clock.install({time:new Date('2026-10-06T08:00:00Z')});
    await page.goto(base+prefix);
    await page.waitForFunction(()=>document.getElementById('orbitDataStatus').textContent.includes('已更新'));
    assert.equal(fetches,1);
    await page.click('#trackTab');
    await page.fill('#observerLat','31.23');await page.fill('#observerLon','121.47');
    await page.click('#observerForm button');
    await page.waitForFunction(()=>document.querySelectorAll('.pass-row').length>0);
    assert.notEqual(await page.textContent('#orbitAz'),'—');
    await page.click('#refreshOrbit');
    assert.equal(fetches,1,'manual refresh must respect two hours');
    await page.evaluate(()=>{window.testOrientationAllowed=false;});
    await page.click('#orientationEnable');
    await page.waitForFunction(()=>document.getElementById('orientationStatus').textContent.includes('权限未允许'));
    await page.evaluate(()=>{window.testOrientationAllowed=true;});
    await page.click('#orientationEnable');
    await page.waitForFunction(()=>!document.getElementById('orientationCalibrate').disabled);
    await page.evaluate(()=>{ const e=new Event('deviceorientation');Object.assign(e,{alpha:0,beta:0,gamma:0,webkitCompassHeading:0,webkitCompassAccuracy:5});window.dispatchEvent(e); });
    await page.click('#orientationCalibrate');
    await page.waitForFunction(()=>document.getElementById('poseAz').textContent!=='—');
    await page.evaluate(()=>scrollTo(0,0));
    await page.screenshot({path:`test-artifacts/tracking-${prefix==='/'?'root':'subpath'}-mobile.png`,fullPage:true});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'mobile overflow');
    await page.setViewportSize({width:844,height:390});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'landscape overflow');
    await page.setViewportSize({width:1440,height:1000});
    await page.evaluate(()=>scrollTo(0,0));
    await page.screenshot({path:`test-artifacts/tracking-${prefix==='/'?'root':'subpath'}-desktop.png`,fullPage:true});
    const before=await page.inputValue('#satelliteSelect');
    await page.setInputFiles('#orbitFile',{name:'bad.json',mimeType:'application/json',buffer:Buffer.from('[{}]')});
    await page.waitForFunction(()=>document.getElementById('orbitDataStatus').textContent.includes('导入失败'));
    assert.equal(await page.inputValue('#satelliteSelect'),before);
    await page.setInputFiles('#orbitFile',{name:'iss.json',mimeType:'application/json',buffer:Buffer.from(fixture)});
    await page.waitForFunction(()=>document.getElementById('satelliteSelect').value==='import:25544');
    await page.waitForFunction(()=>document.getElementById('orbitAz').textContent!=='—');
    // Encoder page has no orbit Worker: compare its baseline with active tracking.
    const baselinePage=await context.newPage();await baselinePage.goto(base+prefix+'encode.html');
    const baseline=await baselinePage.evaluate(decodeFixedProbe);await baselinePage.close();
    await page.bringToFront();
    const concurrent=await page.evaluate(decodeFixedProbe);
    assert.equal(concurrent,baseline);assert.ok(concurrent>0);
    await page.click('#trackingReceiveBtn');
    await page.waitForFunction(()=>document.getElementById('micReceiveBtn').getAttribute('aria-pressed')==='true');
    for(let i=0;i<3;i++){await page.click('#receiveTab');await page.click('#trackTab');}
    assert.equal(await page.getAttribute('#micReceiveBtn','aria-pressed'),'true','view switch keeps receiver');
    await page.waitForFunction(()=>navigator.serviceWorker.ready.then(r=>!!r.active));
    // The first-install page remains uncontrolled until the next navigation.
    await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));});
    await page.waitForFunction(()=>document.getElementById('micReceiveBtn').getAttribute('aria-pressed')==='false');
    await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:false});document.dispatchEvent(new Event('visibilitychange'));});
    await page.waitForFunction(()=>document.getElementById('recordingSaveDialog').hidden===false);
    await page.click('#recordingSaveNo');
    assert.equal(await page.isDisabled('#downloadRecordingBtn'),false,'background stop retains recording');
    await page.reload();
    await page.waitForFunction(()=>!!navigator.serviceWorker.controller);
    await page.click('#trackTab');
    await page.waitForFunction(()=>document.getElementById('orbitAz').textContent!=='—');
    assert.equal(fetches,1,'cached request timestamp survives reload');
    await context.setOffline(true);
    await page.reload();await page.click('#trackTab');
    await page.waitForFunction(()=>document.querySelectorAll('.pass-row').length>0);
    assert.equal(await page.inputValue('#satelliteSelect'),'import:25544');
    await page.goto(base+prefix+'encode.html');await page.waitForSelector('#encodeBtn');
    await page.click('#encodeBtn'); await page.waitForFunction(()=>!document.getElementById('downloadBtn').disabled);
    await page.goto(base+prefix+'index.html');await page.waitForSelector('#trackTab');
    await context.setOffline(false);
    // Serve a new shell without modifying working-tree files.
    release=2;
    await page.evaluate(async()=>{const r=await navigator.serviceWorker.getRegistration();await r.update();});
    await page.waitForFunction(async()=>!!(await navigator.serviceWorker.getRegistration()).waiting);
    await page.click('#micReceiveBtn');
    await page.waitForFunction(()=>document.getElementById('micReceiveBtn').getAttribute('aria-pressed')==='true');
    await page.waitForFunction(()=>document.getElementById('applyAppUpdate').disabled);
    assert.equal(await page.getAttribute('meta[name="test-release"]','content'),'1','busy release stays pinned');
    await page.click('#micReceiveBtn');await page.waitForFunction(()=>!document.getElementById('recordingSaveDialog').hidden);await page.click('#recordingSaveNo');
    await page.waitForFunction(()=>!document.getElementById('applyAppUpdate').disabled);
    const other=await context.newPage();await other.goto(base+prefix+'encode.html');
    await page.click('#applyAppUpdate');
    await page.waitForFunction(()=>document.getElementById('offlineStatus').textContent.includes('其他窗口'));
    assert.equal(await page.getAttribute('meta[name="test-release"]','content'),'1');
    await other.close();
    await page.click('#applyAppUpdate');
    await page.waitForFunction(()=>document.querySelector('meta[name="test-release"]').content==='2');
    assert.deepEqual(errors,[]);
    await context.close();
    console.log(`PASS ${prefix}: tracking, simulated permissions/pose, concurrent decode, microphone continuity, background stop, offline RX/TX, atomic update`);
  }
} finally {await browser.close();await new Promise(resolve=>server.close(resolve));}
