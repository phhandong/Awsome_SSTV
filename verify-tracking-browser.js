import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, resolve, relative, isAbsolute } from 'node:path';
import { chromium } from 'playwright-core';

await mkdir('test-artifacts', {recursive:true});
const root=process.cwd(), fixture=await readFile('test-fixtures/iss.json','utf8');
const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.webmanifest':'application/manifest+json','.png':'image/png','.svg':'image/svg+xml','.woff2':'font/woff2'};
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
  const recordingOnly=process.argv.includes('--recording-ui');
  const dopplerOnly=process.argv.includes('--doppler-ui');
  for(const prefix of recordingOnly || dopplerOnly ? ['/Awsome_SSTV/'] : ['/Awsome_SSTV/','/']) {
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
    if(dopplerOnly) await page.addInitScript(()=>{
      const NativeWorker=window.Worker;
      window.Worker=class extends NativeWorker {
        constructor(url,options) {
          super(url,options); this.isOrbit=String(url).includes('orbit-worker');
          if(this.isOrbit) { window.testOrbitWorker=this; this.addEventListener('message',event=>{if(window.dropOrbitMessages) event.stopImmediatePropagation();}); }
        }
        postMessage(data,...rest) { if(this.isOrbit) this.testGeneration=data.generation; return super.postMessage(data,...rest); }
      };
    });
    await page.clock.install({time:new Date('2026-10-06T08:00:00Z')});
    await page.goto(base+prefix);
    if(recordingOnly || dopplerOnly) {
      await page.waitForSelector('#micReceiveBtn:not([disabled])');
      await page.click('#trackTab');
      assert.equal(await page.isVisible('#trackingImageMount #resultCanvas'),true);
      if(dopplerOnly) {
        assert.equal(await page.textContent('#receiveFrequency'),'—');
        await page.click('#trackingSettingsOpen');
        await page.fill('#observerLat','31.23'); await page.fill('#observerLon','121.47');
        await page.click('#observerForm button'); await page.click('#trackingSettingsClose');
        await page.waitForFunction(()=>document.getElementById('receiveFrequency').textContent!=='—');
        assert.match(await page.textContent('#receiveFrequency'),/^437\.\d{6}$/);
        await page.evaluate(()=>{window.testOrientationAllowed=false;}); await page.click('#orientationEnable');
        await page.waitForFunction(()=>document.getElementById('orientationStatus').textContent.includes('权限未允许'));
        assert.notEqual(await page.textContent('#receiveFrequency'),'—','Doppler does not require motion permission');
        await page.evaluate(()=>{window.dropOrbitMessages=true;}); await page.clock.runFor(6000);
        assert.equal(await page.textContent('#receiveFrequency'),'—','expired position clears frequency');
        await page.evaluate(()=>{window.dropOrbitMessages=false;}); await page.clock.runFor(1000);
        await page.waitForFunction(()=>document.getElementById('receiveFrequency').textContent!=='—');
        await page.evaluate(()=>{const worker=window.testOrbitWorker;worker.dispatchEvent(new MessageEvent('message',{data:{type:'error',generation:worker.testGeneration,message:'测试传播失败'}}));});
        assert.equal(await page.textContent('#receiveFrequency'),'—'); assert.match(await page.textContent('#frequencyStatus'),/传播失败/);
        await page.clock.runFor(1000); await page.waitForFunction(()=>document.getElementById('receiveFrequency').textContent!=='—');
        await page.evaluate(()=>{window.micStarts=0;const original=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);navigator.mediaDevices.getUserMedia=(...args)=>{window.micStarts++;return original(...args);};});
      }
      await page.click('#trackingReceiveBtn');
      await page.waitForFunction(()=>document.getElementById('micReceiveBtn').getAttribute('aria-pressed')==='true');
      if(dopplerOnly) {
        await page.selectOption('#frequencySelect','iss-sstv-vhf');
        await page.waitForFunction(()=>document.getElementById('receiveFrequency').textContent.startsWith('145.'));
        await page.click('#trackingSettingsOpen'); await page.click('#frequencyNew');
        await page.fill('#frequencyName','Test USB band'); await page.fill('#frequencyModeInput','USB');
        await page.selectOption('#frequencyKind','band'); await page.fill('#frequencyLow','435.000'); await page.fill('#frequencyHigh','435.100');
        await page.click('#frequencyForm button');
        await page.waitForFunction(()=>document.getElementById('frequencyForm').hidden);
        assert.equal(await page.inputValue('#bandTuneMHz'),'435.050000');
        await page.fill('#bandTuneMHz','436'); await page.click('#bandTuneForm button');
        await page.waitForFunction(()=>document.getElementById('frequencyError').textContent.includes('频段内'));
        await page.fill('#bandTuneMHz','435.025'); await page.click('#bandTuneForm button');
        await page.waitForFunction(()=>document.getElementById('nominalFrequency').textContent.includes('435.025000'));
        await page.click('#trackingSettingsClose');
        await page.click('#trackingImageExpand'); assert.equal(await page.isVisible('#trackingImageLargeMount #resultCanvas'),true);
        await page.click('#trackingImageClose');
        await page.waitForSelector('#trackingImageMount #resultCanvas');
        assert.equal(await page.evaluate(()=>window.micStarts),1,'settings, selection and enlargement keep the same microphone');
        assert.equal(await page.getAttribute('#micReceiveBtn','aria-pressed'),'true');
      }
      await page.click('#trackingReceiveBtn');
      await page.waitForFunction(()=>!document.getElementById('recordingSaveDialog').hidden);
      await page.click('#recordingSaveNo');
      await page.waitForFunction(()=>!document.getElementById('trackingRecording').hidden && !document.getElementById('trackingClearRecording').disabled);
      assert.match(await page.textContent('#trackingRecordingSummary'),/已暂存录音.*秒/);
      await page.evaluate(async()=>{
        const app=await import('./js/app.js');
        app.beginReceiverFrame({frameId:999,width:8,height:4,mode:{name:'TEST'}});
        const pixels=new Uint8ClampedArray(8*2*4);
        for(let i=0;i<pixels.length;i+=4) pixels.set([20,180,60,255],i);
        app.applyReceiverFramePatch({frameId:999,y:0,rowCount:2,pixels,rows:2,totalRows:4});
        window.testSharedCanvas=document.getElementById('resultCanvas');
      });
      const checkPixels=()=>page.evaluate(()=>Array.from(document.getElementById('resultCanvas').getContext('2d').getImageData(0,0,1,1).data));
      assert.deepEqual(await checkPixels(),[20,180,60,255],'live patches rendered in tracker');
      if(dopplerOnly) {
        await page.click('#trackingImageExpand');
        await page.evaluate(async()=>{const app=await import('./js/app.js');app.applyReceiverFramePatch({frameId:999,y:2,rowCount:1,pixels:new Uint8ClampedArray(8*4).fill(255),rows:3,totalRows:4});});
        assert.equal(await page.evaluate(()=>window.testSharedCanvas===document.querySelector('#trackingImageLargeMount #resultCanvas')),true);
        assert.equal(await page.evaluate(()=>document.getElementById('resultCanvas').getContext('2d').getImageData(0,2,1,1).data[0]),255,'live updates continue enlarged');
        await page.click('#trackingImageClose');
      }
      await page.click('#receiveTab');
      assert.equal(await page.isVisible('#receiveView #resultCanvas'),true);
      await page.click('#trackTab');
      assert.equal(await page.evaluate(()=>window.testSharedCanvas===document.querySelector('#trackingImageMount #resultCanvas')),true);
      assert.deepEqual(await checkPixels(),[20,180,60,255],'same canvas survives view switch');
      const [download]=await Promise.all([page.waitForEvent('download'),page.click('#trackingDownloadRecording')]);
      assert.match(download.suggestedFilename(),/\.wav$/);
      await page.click('#trackingClearRecording');
      await page.waitForFunction(()=>document.getElementById('trackingRecording').hidden);
      assert.deepEqual(await checkPixels(),[20,180,60,255],'clearing audio preserves images');
      await page.click('#trackingReceiveBtn');
      await page.waitForFunction(()=>document.getElementById('micReceiveBtn').getAttribute('aria-pressed')==='true');
      await page.click('#trackingReceiveBtn');
      await page.waitForFunction(()=>!document.getElementById('recordingSaveDialog').hidden);
      await page.click('#recordingSaveNo');
      await page.evaluate(()=>scrollTo(0,0));
      await page.screenshot({path:'test-artifacts/tracking-recording-ui.png',fullPage:true});
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
      if(dopplerOnly) {
        await page.click('#trackingClearRecording');
        for(const [width,height] of [[390,844],[375,667],[375,550]]) {
          await page.setViewportSize({width,height}); await page.evaluate(()=>scrollTo(0,0));
          const boxes=await page.evaluate(()=>['receiveFrequency','skyPlot','trackingImageMount','trackingReceiveBtn'].map(id=>{const r=document.getElementById(id).getBoundingClientRect();return {id,top:r.top,bottom:r.bottom,height:r.height,viewport:innerHeight};}));
          assert.ok(boxes.every(b=>b.top>=0&&b.bottom<=b.viewport&&b.height>0),JSON.stringify(boxes));
          assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
          await page.screenshot({path:`test-artifacts/doppler-${width}x${height}.png`});
        }
        await page.setViewportSize({width:844,height:390});
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
        await page.setViewportSize({width:390,height:844});
        await page.waitForFunction(()=>navigator.serviceWorker.ready.then(r=>!!r.active));
        await page.reload(); await page.click('#trackTab');
        await page.waitForFunction(()=>document.getElementById('receiveFrequency').textContent!=='—');
        assert.match(await page.textContent('#nominalFrequency'),/435.025000/);
        await page.click('#trackingSettingsOpen');
        await page.setInputFiles('#orbitFile',{name:'iss.json',mimeType:'application/json',buffer:Buffer.from(fixture)});
        await page.waitForFunction(()=>document.getElementById('satelliteSelect').value==='import:25544');
        assert.match(await page.textContent('#nominalFrequency'),/435.025000/,'same catalog retains its frequency');
        await page.screenshot({path:'test-artifacts/doppler-settings.png'});
        await page.click('#trackingSettingsClose');
        await page.waitForFunction(()=>!!navigator.serviceWorker.controller);
        await context.setOffline(true); await page.reload(); await page.click('#trackTab');
        await page.waitForFunction(()=>document.getElementById('receiveFrequency').textContent!=='—');
        assert.match(await page.textContent('#nominalFrequency'),/435.025000/);
        await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));});
        assert.equal(await page.textContent('#receiveFrequency'),'—');
        await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:false});document.dispatchEvent(new Event('visibilitychange'));});
        await page.waitForFunction(()=>document.getElementById('receiveFrequency').textContent!=='—');
        await page.click('#trackingSettingsOpen'); await page.click('#frequencyDelete'); await page.click('#trackingSettingsClose');
        await page.waitForFunction(()=>document.getElementById('nominalFrequency').textContent.includes('437.550000'));
        await context.setOffline(false);
        await page.clock.fastForward(4*86400000);
        await page.waitForFunction(()=>document.getElementById('frequencyStatus').textContent.includes('星历较旧'));
        console.log('PASS Doppler UI: bands, viewport fit, live microphone/canvas continuity, persistence, offline and resume');
      }
      assert.deepEqual(errors,[]);
      await context.close();
      console.log('PASS recording UI: retain → download → clear → record again; shared live image and pixels preserved across view changes');
      continue;
    }
    await page.waitForFunction(()=>document.getElementById('orbitDataStatus').textContent.includes('已更新'));
    assert.equal(fetches,1);
    await page.click('#trackTab');
    await page.click('#trackingSettingsOpen');
    await page.fill('#observerLat','31.23');await page.fill('#observerLon','121.47');
    await page.click('#observerForm button');
    await page.waitForFunction(()=>document.querySelectorAll('.pass-row').length>0);
    assert.notEqual(await page.textContent('#orbitAz'),'—');
    await page.click('#refreshOrbit');
    assert.equal(fetches,1,'manual refresh must respect two hours');
    await page.click('#trackingSettingsClose');
    await page.evaluate(()=>{window.testOrientationAllowed=false;});
    await page.click('#orientationEnable');
    await page.waitForFunction(()=>document.getElementById('orientationStatus').textContent.includes('权限未允许'));
    await page.evaluate(()=>{window.testOrientationAllowed=true;});
    await page.click('#orientationEnable');
    await page.waitForFunction(()=>!document.getElementById('orientationCalibrate').disabled);
    await page.evaluate(()=>{ const e=new Event('deviceorientation');Object.assign(e,{alpha:0,beta:0,gamma:0,webkitCompassHeading:0,webkitCompassAccuracy:5});window.dispatchEvent(e); });
    await page.click('#trackingSettingsOpen');
    await page.click('#orientationCalibrate');
    await page.click('#trackingSettingsClose');
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
    await page.click('#trackingSettingsOpen');
    await page.setInputFiles('#orbitFile',{name:'bad.json',mimeType:'application/json',buffer:Buffer.from('[{}]')});
    await page.waitForFunction(()=>document.getElementById('orbitDataStatus').textContent.includes('导入失败'));
    assert.equal(await page.inputValue('#satelliteSelect'),before);
    await page.setInputFiles('#orbitFile',{name:'iss.json',mimeType:'application/json',buffer:Buffer.from(fixture)});
    await page.waitForFunction(()=>document.getElementById('satelliteSelect').value==='import:25544');
    await page.waitForFunction(()=>document.getElementById('orbitAz').textContent!=='—');
    await page.click('#trackingSettingsClose');
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
