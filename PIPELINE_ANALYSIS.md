# SSTV 解码 Pipeline 分析(基于 ROBOT36_test.mp3)

> 用现有 `js/` 代码解码 `asset/ROBOT36_test.mp3`,逐步理解 pipeline 行为与瓶颈。
> 诊断脚本:`analyze_mp3.js`、`find_signal.js`(需临时 `npm install --no-save mpg123-decoder`,仅分析用,非项目运行时依赖)。

## 1. Pipeline 全流程(代码视角)

`js/decoder.js` 的 `decode(samples, sampleRate)`:

| 步骤 | 代码 | 作用 |
|------|------|------|
| ① 重采样 | `demod.resample` → 44100Hz | 统一采样率 |
| ② FM 解调 | `demod.demodulate` | 解析信号(带通+Hilbert)求瞬时频率 → `freq[]`(每样本一个 Hz) |
| ③ VIS 识别 | `vis.decodeVISHeader` | 找 1900Hz leader → 8 位 VIS 码 → 模式 + 图像起始偏移 |
| ④ 同步搜索 | `demod.findSyncPulses` + `autoSlant` | 找 1200Hz 同步脉冲,每行起点 |
| ⑤ 逐行重建 | `decoder.decodeRgb` / `decodeYuvInterlaced` | 按模式段在 `freq[]` 上取段,SCAN 段均分到像素 |
| ⑥ YUV 合并 | `decodeYuvInterlaced` | Robot 奇偶场合并 + YUV→RGB |

MP3 输入额外前置:`audiodecode.decodeAudioFile` → 浏览器 `AudioContext.decodeAudioData`(或分析脚本用 mpg123-decoder)→ 单声道 PCM。

## 2. ROBOT36_test.mp3 的实际信号结构

MP3 解码:`48000Hz / 立体声 / 41.88s` → 重采样到 44100Hz。

**能量分布**(`find_signal.js`):0ms 起即有信号(无静音前导),rms 从 0.05 渐升到 ~6.6s 后稳定 0.10。**真正的 VIS leader 不在 0s**。

**频率结构**(切片 1.5s 后,demodulate):
- **前导杂讯**:0~1.74s,频率乱跳(715/2087/1540...),非 SSTV。
- **双 1900Hz leader**:
  - 第一段:绝对 1735~2025ms(切片内 237~490ms,持续 ~252ms)
  - 第二段:绝对 2151~2342ms(切片内 651~842ms,持续 ~191ms)
  - 两段之间是 1200Hz break(10ms)
- **VIS 数据位**:第二段后,8 位 @30ms:
  `1303, 1305, 1330, 1105, 1312, 1326, 1304, 1116` → `0,0,0,1,0,0,0,1`
  = byte `0b10001000` = 136,低 7 位 = **8**
- **VIS 码 8 = Robot 36** ✓(与文件名吻合)

## 3. 现有 pipeline 在该 MP3 上的失败点

### 失败点 A:单样本 leader 检测太脆
`vis.decodeVISHeader` 用**单样本**判定 1900Hz(容差 ±80Hz),要求连续 ≥100ms。
实测 leader 段(切片 250~510ms)单样本落在容差内的仅 **69%**(22/32),有 1310/845/2033/1741 等离群点 → 无法形成连续 100ms → leader 检测失败。

**根因**:解调瞬时频率相噪大。来源:
- MP3 有损压缩(丢高频/相位信息)
- 48000→44100 重采样(线性插值引入相位失真)
- Hilbert FIR(33 tap)群延迟与过渡带

**验证**:对 `freq[]` 做 2/5/10ms 移动平均后,leader 稳定检出(238/240/244ms)。**修复方向:demodulate 的平滑从 0.5ms 提到 ~3ms**(已验证不破坏最短 SYNC 4.862ms 的形状)。

### 失败点 B:VIS 头是双 leader,代码只找单 leader
`decodeVISHeader` 找到第一个 1900Hz 段后,直接在其后读 8 位。但本信号第一段后是 **第二个 1900Hz leader**(而非 break+start+bits),导致读出的 8 位全是 ~1900Hz → 既非 1100 也非 1300 → 校验失败。

**标准 SSTV VIS 头实际有两种结构**:
- 单 leader:`1900@300ms → 1200@10 → 1200@30(start) → 8×data → 1200@30(stop)`
- 双 leader:`1900@300ms → 1200@10(break) → 1900@300ms → 1200@30(start) → 8×data → 1200@30(stop)`

本 MP3 是**双 leader**结构。**修复方向:`decodeVISHeader` 找到第一段后,若其后紧接第二段 1900Hz(而非 1200Hz break),则跳过第二段再读位**。

### 失败点 C(次要):前导杂讯需起始时间偏移
0~1.74s 的杂讯会干扰 leader 搜索(零星 1900Hz 假阳性)。**这正是 UI"起始时间"功能的用途**——用户设 1.5s 即可跳过。但更好的做法是让 VIS 检测本身鲁棒到能跳过前导(扫描整个文件找双 leader 模式)。

## 4. 各阶段中间产物(切片 1.5s 后)

```
MP3 字节 (1.6MB)
  └─ mpg123/AudioContext → PCM Float32 (48000Hz, 2ch, 41.88s)
      └─ resample → 44100Hz mono PCM (1.85M 样本)
          └─ demodulate → freq[] (1.85M 个 Hz 值)
              │  leader 段:237-490ms ~1900Hz(69% 样本在容差)
              │  第二段:651-842ms ~1900Hz
              │  VIS 位:897-1107ms,1303/1305/1330/1105/...
              └─ decodeVISHeader → visCode7=8 (Robot36), imageStart
                  └─ findSyncPulses → 1200Hz 脉冲序列(期望 ~240=2场×120行)
                      └─ autoSlant → 每行起点
                          └─ decodeYuvInterlaced → Y/Cr/Cb → RGB → 320×240 图像
```

## 5. 结论

Pipeline 架构正确,模式表/解调/同步/重建逻辑都成立(自测闭环 PSNR 达标证明了这点)。对真实 MP3 失败的根因是**两处鲁棒性不足**:

1. `demod.demodulate` 平滑不足(0.5ms)→ MP3 相噪下单样本频率抖动大 → leader/位检测失败
2. `vis.decodeVISHeader` 不支持双 leader 结构 → 把第二段当数据位

修复这两处(平滑提到 3ms + VIS 检测兼容双 leader),配合起始时间偏移跳过前导,即可解码该 MP3。修复后需重跑 `verify.js` 确认现有 8 模式闭环不回归。

## 6. 复现命令

```bash
npm install --no-save mpg123-decoder   # 临时,仅分析用
node find_signal.js                     # 定位信号 + 能量分布
node analyze_mp3.js                     # 完整 pipeline 逐步诊断
```
