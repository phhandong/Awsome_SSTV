import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseElements, normalizeCatalogId, recordToSatrec, lookAt, predictPasses, validateObserver, DAY } from './js/orbit-core.js';
import { propagate } from './js/vendor/satellite.es.js';
import { declinationAt, topVector, vectorAngles, smoothVector, pointingGuide, PhoneOrientation } from './js/orientation.js';
import { TrackingStore, EphemerisSource, REFRESH_INTERVAL } from './js/tracking-store.js';

const near = (actual, expected, tolerance, label) => assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} vs ${expected}`);
const tle = '1 00005U 58002B   00179.78495062  .00000023  00000-0  28098-4 0  4753\n2 00005  34.2682 348.7242 1859667 331.7664  19.3264 10.82419157413667';
const vanguard = parseElements(tle)[0];
// Independent published Vallado et al. AIAA-2006-6753 verification case 00005,
// t=0 minutes, TEME km. https://celestrak.org/publications/AIAA/2006-6753/
const reference = [7022.46529266, -1400.08296755, 0.03995155];
const xyz = propagate(recordToSatrec(vanguard), new Date(vanguard.epoch)).position;
[xyz.x, xyz.y, xyz.z].forEach((value, i) => near(value, reference[i], .01, 'Vallado TEME'));
const observer = { latitude: 31.23, longitude: 121.47, altitude: 0 };
// Independently transform the published TEME vector using WGS84 and the
// GMST polynomial; do not derive expected look angles through satellite.js.
const jd = 2440587.5 + Math.floor(vanguard.epoch) / DAY, t = (jd - 2451545) / 36525;
const theta = (280.46061837 + 360.98564736629 * (jd - 2451545) + .000387933*t*t - t*t*t/38710000) * Math.PI/180;
const lat=observer.latitude*Math.PI/180, lon=observer.longitude*Math.PI/180;
const n=6378.137/Math.sqrt(1-0.00669437999014*Math.sin(lat)**2);
const dx=reference[0]*Math.cos(theta)+reference[1]*Math.sin(theta)-n*Math.cos(lat)*Math.cos(lon);
const dy=-reference[0]*Math.sin(theta)+reference[1]*Math.cos(theta)-n*Math.cos(lat)*Math.sin(lon);
const dz=reference[2]-n*(1-0.00669437999014)*Math.sin(lat);
const east=-Math.sin(lon)*dx+Math.cos(lon)*dy;
const north=-Math.sin(lat)*Math.cos(lon)*dx-Math.sin(lat)*Math.sin(lon)*dy+Math.cos(lat)*dz;
const up=Math.cos(lat)*Math.cos(lon)*dx+Math.cos(lat)*Math.sin(lon)*dy+Math.sin(lat)*dz;
const look=lookAt(recordToSatrec(vanguard),observer,vanguard.epoch);
near(look.azimuth,(Math.atan2(east,north)*180/Math.PI+360)%360,.001,'independent azimuth');
near(look.elevation,Math.atan2(up,Math.hypot(east,north))*180/Math.PI,.001,'independent elevation');
near(look.distance,Math.hypot(dx,dy,dz),.01,'independent range');

const text=await readFile('test-fixtures/iss.json','utf8'), iss=parseElements(text,'celestrak')[0];
const sat=recordToSatrec(iss), prediction=predictPasses(sat,observer,iss.epoch);
assert.ok(prediction.passes.length>0);
for(const pass of prediction.passes) {
  assert.ok(pass.peak>=pass.rise&&pass.peak<=pass.set&&pass.maxElevation>0);
  if(!pass.ongoingStart) near(lookAt(sat,observer,pass.rise).elevation,0,.03,'rise');
  if(!pass.ongoingEnd) near(lookAt(sat,observer,pass.set).elevation,0,.03,'set');
}
const pass=prediction.passes[0];
assert.equal(predictPasses(sat,observer,pass.peak).passes[0].ongoingStart,true);
assert.equal(predictPasses(sat,{latitude:90,longitude:0,altitude:0},iss.epoch).passes.length,0);
assert.throws(()=>lookAt({...sat,ecco:1.5},observer,iss.epoch));
assert.throws(()=>validateObserver({...observer,latitude:91}));
assert.throws(()=>parseElements(tle.slice(0,-1)+'8'));
assert.throws(()=>parseElements('[{}]'));
assert.throws(()=>parseElements(text.replace('15.48747543','null')));
assert.equal(parseElements('VANGUARD\n'+tle)[0].name,'VANGUARD');
for (const [encoded, numeric] of [['A0470','100470'],['H9999','179999'],['J0000','180000'],['N9999','229999'],['P0000','230000'],['Z9999','339999']]) {
  assert.equal(normalizeCatalogId(encoded), numeric);
}
for (const invalid of ['I0470','O0470','a0470','A470','A04X0']) assert.throws(() => normalizeCatalogId(invalid));
const jamx = parseElements(`JAMX01
1 A0470U 26195F   26280.19609334  .00004321  00000-0  26865-3 0  9997
2 A0470  97.5407 353.3186 0013970 123.6964 236.5599 15.10085176  6509`)[0];
assert.equal(jamx.catalogId, '100470');
assert.equal(jamx.id, 'import:100470');
assert.equal(recordToSatrec(jamx).satnum, 'A0470', 'original fixed-width TLE is preserved');
assert.ok(Number.isFinite(lookAt(recordToSatrec(jamx),observer,Date.parse('2026-10-08T00:00:00Z')).azimuth));

// NOAA WMM2025 published tests, declination degrees, 0/100 km above WGS84.
// https://www.ncei.noaa.gov/sites/default/files/2025-02/WMM2025_TEST_VALUES.txt
for(const [year,altitude,latitude,longitude,declination] of [
  [2025,0,80,0,1.28],[2025,0,0,120,-.16],[2025,0,-80,-120,68.78],
  [2025,100000,80,0,.85],[2027.5,0,80,0,2.59],[2027.5,100000,-80,-120,67.93],
]) {
  const y=Math.floor(year), time=Date.UTC(y,0,1)+(year-y)*(Date.UTC(y+1,0,1)-Date.UTC(y,0,1));
  near(declinationAt({latitude,longitude,altitude},time),declination,.01,'NOAA declination');
}
assert.throws(()=>declinationAt(observer,Date.UTC(2030,0,1)));
for(const [alpha,expected] of [[0,0],[90,270],[180,180],[270,90]]) near(vectorAngles(topVector(alpha,0)).azimuth,expected,1e-9,'cardinal');
near(vectorAngles(topVector(0,45)).elevation,45,1e-9,'raise top');
near(vectorAngles(topVector(0,-30)).elevation,-30,1e-9,'lower top');
const smoothed=vectorAngles(smoothVector(topVector(1,0),topVector(-1,0),.5));
assert.ok(smoothed.azimuth<.01||smoothed.azimuth>359.99,'wrap smoothing');
const pose={valid:true,time:Date.now(),vector:topVector(0,30),...vectorAngles(topVector(0,30)),accuracy:5};
near(pointingGuide(pose,{azimuth:0,elevation:30}).angle,0,1e-5,'target aligned');
assert.match(pointingGuide(pose,{azimuth:90,elevation:30}).text,/向右/);
assert.match(pointingGuide(pose,{azimuth:0,elevation:-1}).text,/地平线下/);
assert.match(pointingGuide({...pose,accuracy:40},{azimuth:0,elevation:30}).text,/精度/);
assert.doesNotMatch(pointingGuide(pose,{azimuth:180,elevation:89}).text,/向左|向右/);
assert.equal(pointingGuide(pose,{azimuth:0,elevation:30},pose.time+3000).angle,null);
let lastPose;
const phone=new PhoneOrientation(p=>{lastPose=p;}); phone.declination=0; phone.enabled=true;
// Stable sampling is covered in verify-orientation-auto; isolate geometry here.
phone.offset=0;
phone.consume({alpha:0,beta:0,gamma:0,webkitCompassHeading:0,webkitCompassAccuracy:5});
assert.equal(lastPose.valid,true);
phone.lastRender=0; phone.consume({alpha:270,beta:30,gamma:60,webkitCompassHeading:90,webkitCompassAccuracy:5});
near(lastPose.azimuth,90,1e-6,'calibrated east with roll'); near(lastPose.elevation,30,1e-6,'calibrated pitch');
phone.lastRender=0; phone.consume({alpha:270,beta:30,gamma:60,webkitCompassHeading:-1,webkitCompassAccuracy:-1}); assert.equal(lastPose.valid,false);

const store=new TrackingStore(null,null);
let calls=0;
const source=new EphemerisSource(store,parseElements,async()=>{calls++;return {status:200,text:async()=>text};});
const now=Date.now();
await Promise.all([source.refresh(now),source.refresh(now)]); assert.equal(calls,1);
await source.refresh(now+1); assert.equal(calls,1);
await source.refresh(now+REFRESH_INTERVAL); assert.equal(calls,2);
const old=await store.get('iss');
source.fetcher=async()=>{calls++;throw new Error('network unavailable');};
const failed=await source.refresh(now+2*REFRESH_INTERVAL); assert.ok(failed.error); assert.deepEqual(failed.record,old);
await source.refresh(now+2*REFRESH_INTERVAL+1); assert.equal(calls,3);
source.fetcher=async()=>({status:503});
assert.match((await source.refresh(now+3*REFRESH_INTERVAL)).error,/503/);
assert.deepEqual(await store.get('iss'),old);
console.log('PASS tracking: Vallado / independent look angles, passes, imports, NOAA WMM2025, pointing, cache and request limits');
