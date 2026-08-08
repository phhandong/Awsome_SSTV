# Awesome SSTV

> 浏览器内 SSTV(慢扫描电视)编解码器 · 纯静态 · 可直接部署到 GitHub Pages

基于对 `SSTVENG.dll`(MMSSTV v1.06,JE3HHT 2002-2003)的逆向成果,在浏览器中从零重构的 SSTV 生成与解码工具。**不依赖原 DLL**,所有算法(调频合成、FM 解调、VIS 识别、同步、斜率校正)均用纯 JavaScript 实现,协议参数来自公开 SSTV 规范。

## 功能

- 🎨 **生成器**:选择图片 + 模式,合成 SSTV 测试音频,可播放 / 下载 WAV
- 📡 **解码器**:上传 **WAV 或 MP3** 文件,解码出图像;支持频谱瀑布图可视化(700–2700 Hz)
- 🎙️ **实时接收**:在 HTTPS 或 localhost 下使用麦克风，AudioWorklet 采集、Worker 解码并逐行更新图像
- 📡 **无 VIS 启动**:自动比较连续同步脉冲的行周期识别模式，也可手动指定模式从信号中途开始接收
- ⏱️ **起始时间偏移**:可设置从音频的第几秒开始解码(跳过前导噪声 / 选取特定帧)
- 🎛️ **DSP 开关**:可独立启用/关闭 AFC 自动频偏校正、CLMS/NLMS 自适应线增强和 BPF 带通滤波
- ⟲ **自测闭环**:一键生成 → 解码 → 原图对照 + PSNR 指标
- 📻 **支持模式**:MMSSTV 接收目录的 43 种模式，包括六种窄带 N/MC 模式
- 📱 响应式暗色主题,移动端 / 桌面端自适应

## 闭环验证结果(44100 Hz,WAV 往返)

| 模式 | 尺寸 | 色彩 | PSNR |
|------|------|------|------|
| Martin 1 | 320×256 | RGB | 29.7 dB |
| Martin 2 | 320×256 | RGB | 26.7 dB |
| Scottie 1 | 320×256 | RGB | 34.4 dB |
| Scottie 2 | 320×256 | RGB | 31.8 dB |
| Scottie DX | 320×256 | RGB | 41.7 dB |
| Robot 36 | 320×240 | YUV 4:2:2 | 20.1 dB |
| Robot 72 | 320×240 | YUV 4:2:2 | 20.6 dB |

> Robot 系因 YUV 4:2:2 色度下采样 inherent 损失,PSNR 较 RGB 模式低,属正常。

运行验证:`npm test`

### JavaScript 接收 API

```js
import { SSTVReceiver } from './js/receiver.js';

const receiver = new SSTVReceiver({ dsp: { engine: 'mmsstv', bpf: true } });
receiver.on('locked', event => console.log(event.mode.name));
receiver.on('row', event => console.log(event.rows));
receiver.on('frame', event => render(event.result.pixels));
receiver.push(pcmChunk, inputSampleRate);
receiver.end();
```

自动接收默认依次尝试 VIS、窄带 FSK 和同步脉冲周期。已知模式时可以绕过头部：

```js
const receiver = new SSTVReceiver({ mode: 8 }); // Robot 36
// 同步 decode(samples, sampleRate, { mode: 8 }) 也支持手动模式
```

手动模式会从第一条可用的完整同步行开始构图。AVT 90 没有可用于锁定的行同步，手动模式从输入 PCM 起点开始。

文件上传和麦克风输入共用该增量接收器。`decode()` 继续提供同步兼容接口；MMSSTV CPLL/FSK/VIS 负责接收锁定，完整录音的像素积分使用零相位频率轨以保留短像素边界。

## 本地预览

无需构建。任选一种:

```bash
# 方式 1:Python 内置服务器
python -m http.server 8000

# 方式 2:Node
npx serve

# 然后浏览器打开 http://localhost:8000
```

文件解码可直接通过静态服务器使用。麦克风 API 要求 HTTPS 或 localhost，不能从普通 `file://` 页面启动。

## 部署到 GitHub Pages

1. 把整个目录推到 GitHub 仓库(如 `Awsome_SSTV`)
2. 仓库 **Settings → Pages → Source = `main` 分支 `/root`**
3. 访问 `https://<你的用户名>.github.io/Awsome_SSTV/`

已附带 `.github/workflows/deploy.yml`,推到 main 会自动部署。`.nojekyll` 关闭 Jekyll 处理。

> 所有资源用相对路径(`./js/...`),子路径部署与自定义域都兼容。

## 项目结构

```
Awsome_SSTV/
├── index.html              # 单入口
├── css/style.css           # 暗色响应式主题
├── js/
│   ├── modes.js            # 模式数据库(频率常量 + ModeDescriptor,唯一时序真相源)
│   ├── vis.js              # VIS 头编解码
│   ├── wav.js              # 纯 JS WAV 读写(44100/16bit/mono + 多格式解码)
│   ├── encoder.js          # 生成器:图片→VIS→行扫描→PCM(相位连续调频)
│   ├── decoder.js          # 解码器:PCM→VIS/FSK/同步→逐行重建→YUV合并
│   ├── sync-acquisition.js  # MMSSTV 同步周期自动识别与手动模式解析
│   ├── demod.js            # FM 解调(解析信号瞬时频率)+ 同步搜索 + AutoSlant
│   ├── audiodecode.js      # 统一音频解码:WAV(纯JS)+ MP3(Web Audio)+ 起始时间切片
│   ├── fft.js              # 频谱瀑布图
│   ├── ui.js               # Canvas 渲染 / 拖放 / PSNR
│   └── app.js              # 入口,事件编排,自测闭环
├── verify.js               # Node 闭环验证(encode→WAV→decode→PSNR)
├── .nojekyll               # 关闭 GitHub Pages Jekyll
└── .github/workflows/deploy.yml
```

## 算法说明

**生成器**:像素亮度 0–255 线性映射到 1500–2300 Hz(黑→白)。逐行按模式段序列合成,SYNC 1200Hz / PORCH 1500Hz / SCAN 调频。相位累加器保证段边界无爆音。Robot 系按奇偶场顺序输出,YUV 4:2:2。

**解码器**:可选 BPF → 可选 CLMS/NLMS 自适应线增强 → 双极性过零测频 → 可选 AFC(以 VIS 1900Hz 为基准校正频偏)→ VIS/FSK 识别；头部缺失时按 MMSSTV 的连续 1200/1900Hz 同步脉冲间隔匹配模式行周期，也可使用手动模式 → 按模式段对齐每行首个 SCAN → 逐像素采样重建。三个 DSP 模块可在界面独立开关，默认 AFC 关、LMS 关、BPF 开。

**音频输入**:WAV 走纯 JS 解析(`wav.js`,无浏览器 API 依赖);MP3 等其他格式走 Web Audio API 的 `decodeAudioData`(`audiodecode.js`),统一输出单声道 PCM,再由 `demod.resample` 重采样到 44100Hz。**起始时间偏移**:在解码前按 `秒 × 采样率` 截取 PCM,可跳过前导静音/噪声或选取录音中的特定 SSTV 帧。

**协议参数来源**:频率常量(1200/1500/1900/2300/1100/1300 Hz)、VIS 编码、模式时序均为公开 SSTV 规范;逆向确认了 SSTVENG.dll 实现这些标准值。详见 `../Setup_RXSSTV/REVERSE_ENGINEERING.md`。

## 扩展更多模式

在 `js/modes.js` 加一条 `ModeDescriptor` 即可,无需改解码主循环。例如 PD120:

```js
// PD120:640×480,YUV 4:1:1,VIS 95
const PD120_LINE = [ /* 段定义 */ ];
MODES[95] = { visCode:95, name:'PD120', width:640, height:480, ... };
```

## 许可与致谢

- 协议实现:MIT
- 原创 UI、编码器和工具:MIT
- MMSSTV 等价接收 DSP:LGPL-3.0-or-later，见 `LICENSES/MMSSTV-NOTICE.md`
- MMSSTV 源码版权 © 2000-2013 Makoto Mori、Nobuyuki Oba
- RXSSTV 外壳 © ON6MU

## 验证命令汇总

```bash
node verify.js     # 核心:8 模式闭环 PSNR
node verify-dsp.js # DSP:AFC/LMS/BPF 算法与开关
node verify-stream.js # 流式重采样、CPLL、VIS/FSK、同步自动启动、手动启动
node verify-audio.js # WAV:PCM/float/边界校验
node uitest.js     # UI:装配与模式填充(jsdom)
```
