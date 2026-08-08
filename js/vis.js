// SPDX-License-Identifier: LGPL-3.0-or-later
// vis.js — SSTV VIS(Vertical Interval Signaling)头编解码
//
// VIS 头结构(公开 SSTV 规范,频率锚点逆向确认):
//   1900Hz @ 300ms   leader 起始脉冲
//   1200Hz @ 10ms    break
//   1200Hz @ 30ms    start bit
//   8 × data bit @ 30ms each:  1100Hz=1, 1300Hz=0,  LSB 先发(7 位码 + 1 位偶校验)
//   1200Hz @ 30ms    stop bit
//
// 8 位 = 低 7 位 VIS 码 + 最高位偶校验。LSB 先发意味着先发 bit0。

import { FREQ } from './modes.js';

const LEADER_MS = 300;
const BREAK_MS = 10;
const BIT_MS = 30;

// 偶校验位:使 8 位中 1 的总数为偶数
export function visParity(visCode7) {
  const code = visCode7 & 0x7f;
  let ones = 0;
  for (let i = 0; i < 7; i++) if (code & (1 << i)) ones++;
  return (ones & 1) ? 1 : 0;  // 奇数个1 → 校验位置1使总数偶
}

// 把 7 位 VIS 码组成 8 位(高位为校验),返回发送顺序的 8 位数组(LSB 先)
function visBits(visCode7) {
  const byte = (visCode7 & 0x7f) | (visParity(visCode7) << 7);
  const bits = [];
  for (let i = 0; i < 8; i++) bits.push((byte >> i) & 1);
  return bits;
}

// 生成 VIS 头的"音调段"序列,供 encoder 顺序合成
// 返回: [{freq, durationMs}, ...]
export function visHeaderSegments(visCode7) {
  const extended = visCode7 > 0x7f && (visCode7 & 0xff) === 0x23;
  const segs = [
    { freq: FREQ.VIS_START, durationMs: LEADER_MS },
    { freq: FREQ.VIS_BREAK, durationMs: BREAK_MS },
    { freq: FREQ.VIS_BREAK, durationMs: BIT_MS },   // start bit
  ];
  const bits = extended
    ? Array.from({ length: 16 }, (_, i) => (visCode7 >> i) & 1)
    : visBits(visCode7);
  for (const bit of bits) {
    segs.push({ freq: bit ? FREQ.VIS_BIT_1 : FREQ.VIS_BIT_0, durationMs: BIT_MS });
  }
  segs.push({ freq: FREQ.VIS_BREAK, durationMs: BIT_MS });  // stop bit
  return segs;
}

// VIS 头总时长(ms)
export const VIS_HEADER_MS = LEADER_MS + BREAK_MS + 10 * BIT_MS;  // 300+10+300 = 610ms

const NARROW_FSK_CODES = new Map([
  [0x02, 0x1022d], [0x04, 0x1042d], [0x05, 0x1052d],
  [0x14, 0x1142d], [0x15, 0x1152d], [0x16, 0x1162d],
]);

export function narrowHeaderSegments(modeCode) {
  const chars = [0x2d, 0x15, modeCode, (0x15 ^ modeCode) & 0x3f];
  const segments = [{ freq: FREQ.FSK_SPACE, durationMs: 150 }];
  for (const value of chars) {
    for (let bit = 0; bit < 6; bit++) {
      segments.push({ freq: value & (1 << bit) ? FREQ.NARROW_SYNC : FREQ.FSK_SPACE, durationMs: 22 });
    }
  }
  return segments;
}

export function decodeNarrowFSKHeader(freq, sr, searchStart = 0) {
  const guard = Math.floor(100 * sr / 1000);
  const bitSamples = 22 * sr / 1000;
  const searchEnd = Math.min(freq.length, searchStart + Math.floor(5 * sr));
  let start = -1;
  for (let i = searchStart; i + guard < searchEnd; i++) {
    if (!near(freq[i], FREQ.FSK_SPACE, 90)) continue;
    const probes = 8;
    let matches = 0;
    for (let p = 0; p < probes; p++) {
      const at = i + Math.floor((p + 0.5) * guard / probes);
      if (near(freq[at], FREQ.FSK_SPACE, 90)) matches++;
    }
    if (matches < probes - 1) continue;
    let transition = i + guard;
    const limit = Math.min(freq.length, transition + Math.floor(100 * sr / 1000));
    while (transition < limit && !near(freq[transition], FREQ.NARROW_SYNC, 90)) transition++;
    if (transition < limit) { start = transition; break; }
  }
  if (start < 0) return null;

  const chars = [];
  for (let c = 0; c < 4; c++) {
    let value = 0;
    for (let bit = 0; bit < 6; bit++) {
      const at = Math.floor(start + (c * 6 + bit + 0.5) * bitSamples);
      if (at >= freq.length) return null;
      if (near(freq[at], FREQ.NARROW_SYNC, 100)) value |= 1 << bit;
      else if (!near(freq[at], FREQ.FSK_SPACE, 100)) return null;
    }
    chars.push(value);
  }
  if (chars[0] !== 0x2d || chars[1] !== 0x15 || chars[3] !== ((chars[1] ^ chars[2]) & 0x3f)) return null;
  const modeKey = NARROW_FSK_CODES.get(chars[2]);
  if (!modeKey) return null;
  return { visCode7: modeKey, sampleOffset: Math.floor(start + 24 * bitSamples), fsk: true };
}

// 解码端:在样本数组中检测 VIS 头。
// 输入:demod 得到的频率数组 freq[](每样本一个频率估计),起始搜索偏移,采样率。
// 返回:{ visCode7, sampleOffset } 或 null。sampleOffset 为 VIS 头结束(图像开始)的样本位置。
export function decodeVISHeader(freq, sr, searchStart = 0) {
  // VIS 检测对瞬时频率做局部平滑(3ms 窗):MP3/有损信号相噪大,单样本 1900Hz
  // 容差判定会失败。此处用平滑副本做 leader/位检测,不影响外部 freq(同步/像素重建仍用原值)。
  const searchEnd = Math.min(freq.length, searchStart + Math.floor(5 * sr));
  // One extra second covers the leader and all VIS bits when the leader starts
  // at the end of the search window. Do not smooth minutes of image payload.
  const smoothEnd = Math.min(freq.length, searchEnd + sr);
  const sf = smoothFreq(freq, 3, sr, smoothEnd);

  // 1. 找 1900Hz leader:在 searchStart..searchStart+5s 内找连续 ~300ms 的 1900Hz 区段。
  //    搜索范围 5s(非 1.5s):真实录音常有前导杂讯/VOX 延迟,leader 可能在 1.7s 甚至更晚
  //    (ROBOT36_test.mp3 的 leader 在 ~2.6s)。1.5s 窗口够不到,导致"未检测到 VIS 头"。
  //    取第一个 ≥100ms 的 leader(leader 总在图像前;Scottie DX 扫描段含连续 1900Hz 亮区
  //    可达 345ms,比 leader 的 300ms 还长,取"最长"会误选图像段)。
  const leaderMinMs = 100;
  const leaderMinSamples = Math.floor(leaderMinMs * sr / 1000);

  let leaderStart = -1;
  let i = searchStart;
  while (i < searchEnd) {
    if (near(sf[i], FREQ.VIS_START, 80)) {
      // 跟踪连续 leader 长度
      let j = i;
      while (j < searchEnd && near(sf[j], FREQ.VIS_START, 80)) j++;
      const len = j - i;
      if (len >= leaderMinSamples) { leaderStart = i; break; }
      i = j + 1;
    } else i++;
  }
  if (leaderStart < 0) return null;

  // 找到 leader 起点。leader 持续到频率离开 1900。取 leader 结束点。
  let leaderEnd = leaderStart;
  while (leaderEnd < sf.length && near(sf[leaderEnd], FREQ.VIS_START, 80)) leaderEnd++;

  // leader 之后:break(10ms@1200) + start bit(30ms@1200),共 40ms,然后是 8 个 data bit。
  // p 指向 bit0 的起点。
  const breakSamples = Math.floor((BREAK_MS + BIT_MS) * sr / 1000);
  let p = leaderEnd + breakSamples;

  // 兼容双 leader 结构:部分 SSTV 信号在第一段 1900Hz leader 后,
  // 不是 break+start,而是又一个 1900Hz leader(中间夹 10ms@1200 break)。
  // 检测:p 处若仍是 1900Hz,说明是第二段 leader,跟踪到其结束再 +40ms 读位。
  if (p < sf.length && near(sf[p], FREQ.VIS_START, 80)) {
    let leader2End = p;
    while (leader2End < sf.length && near(sf[leader2End], FREQ.VIS_START, 80)) leader2End++;
    p = leader2End + breakSamples;
  }

  // 读首个 8-bit 字。MMSSTV 的 MP/MR/ML 家族以低字节 0x23 标记，
  // 后随第二个字节组成无校验的 16 位扩展 VIS。
  const bitSamples = Math.floor(BIT_MS * sr / 1000);
  let byte = 0;
  for (let bit = 0; bit < 8; bit++) {
    const mid = p + bit * bitSamples + Math.floor(bitSamples / 2);
    if (mid >= sf.length) return null;
    const f = sf[mid];
    // 1100→1, 1300→0
    if (near(f, FREQ.VIS_BIT_1, 80)) byte |= (1 << bit);
    else if (!near(f, FREQ.VIS_BIT_0, 80)) return null;  // 既不是1也不是0,失败
  }

  if (byte === 0x23) {
    let high = 0;
    for (let bit = 0; bit < 8; bit++) {
      const mid = p + (8 + bit) * bitSamples + Math.floor(bitSamples / 2);
      if (mid >= sf.length) return null;
      const f = sf[mid];
      if (near(f, FREQ.VIS_BIT_1, 80)) high |= (1 << bit);
      else if (!near(f, FREQ.VIS_BIT_0, 80)) return null;
    }
    const imageStart = p + 16 * bitSamples + Math.floor(BIT_MS * sr / 1000);
    return { visCode7: (high << 8) | byte, sampleOffset: imageStart };
  }

  // 校验偶校验
  const code7 = byte & 0x7f;
  const parityBit = (byte >> 7) & 1;
  if (visParity(code7) !== parityBit) return null;

  const imageStart = p + 8 * bitSamples + Math.floor(BIT_MS * sr / 1000); // +stop bit
  return { visCode7: code7, sampleOffset: imageStart };
}

function near(a, b, tol) {
  return Math.abs(a - b) <= tol;
}

// 局部移动平均平滑(窗宽 windowMs),用于 VIS 检测鲁棒化。
// 前缀和将指定范围内的移动平均降为 O(n)。
function smoothFreq(freq, windowMs, sr, limit = freq.length) {
  const half = Math.max(0, Math.floor(windowMs * sr / 1000 / 2));
  if (half === 0) return freq;
  const end = Math.min(freq.length, limit);
  const prefix = new Float64Array(end + 1);
  for (let i = 0; i < end; i++) prefix[i + 1] = prefix[i] + freq[i];
  const out = new Float32Array(end);
  for (let i = 0; i < end; i++) {
    const left = Math.max(0, i - half);
    const right = Math.min(end, i + half + 1);
    out[i] = (prefix[right] - prefix[left]) / (right - left);
  }
  return out;
}
