# Awesome SSTV

> 浏览器内 SSTV(慢扫描电视)编解码器 · 纯静态 · 可直接部署到 GitHub Pages

基于对 `SSTVENG.dll`(MMSSTV v1.06,JE3HHT 2002-2003)的逆向成果,在浏览器中从零重构的 SSTV 生成与解码工具。**不依赖原 DLL**,所有算法(调频合成、FM 解调、VIS 识别、同步、斜率校正)均用纯 JavaScript 实现,协议参数来自公开 SSTV 规范。

## 功能

- 🎨 **生成器**:选择图片 + 模式,合成 SSTV 测试音频,可播放 / 下载 WAV
- 📡 **解码器**:上传 **WAV 或 MP3** 文件,解码出图像;支持频谱瀑布图可视化(700–2700 Hz)
- 🎙️ **实时接收**:在 HTTPS 或 localhost 下使用麦克风，AudioWorklet 采集、Worker 解码并逐行更新图像，同时显示 SSTV 带内/邻带估算音频 SNR
- 🎧 **录音再处理**：停止接收后，原始录音自动载入“音频接收”的时间轴，无需重新上传；支持选区、调整解码设置、播放并实时解码或重复极速解码。切换视图保留选区，保存 WAV 后仍可处理；明确清空录音时移除对应音频，刷新前请先下载保存。
- 📡 **无 VIS 启动**:自动比较连续同步脉冲的行周期识别模式，也可手动指定模式从信号中途开始接收
- ⏱️ **起始时间偏移**:可设置从音频的第几秒开始解码(跳过前导噪声 / 选取特定帧)
- 🎛️ **DSP 开关**:可独立启用/关闭 AFC 自动频偏校正、CLMS/NLMS 自适应线增强和 BPF 带通滤波；复基带设置会保留 SSTV 必需的 1100–2300 Hz 协议频率
- ⟲ **自测闭环**:一键生成 → 解码 → 原图对照 + PSNR 指标
- 📻 **支持模式**:MMSSTV 接收目录的 43 种模式，包括六种窄带 N/MC 模式
- 📱 响应式暗色主题,移动端 / 桌面端自适应
- 🛰️ **卫星跟踪**：自动获取 ISS 与业余无线电卫星目录，支持名称／NORAD 编号搜索和本机收藏；本机计算所选目标的方位、仰角、距离及未来 24 小时过境，支持 TLE / OMM JSON 导入
- 🧭 **iPhone 指向**：定位或手动坐标、运动授权、平放校准；以手机物理顶部指向卫星，WMM2025 磁偏角修正到真北
- 📲 **桌面 Web 应用**：添加到主屏幕、离线启动与版本缓存；接收／跟踪同页切换，音频会话持续运行

## iPhone 使用

目标系统为 iOS 18.4 及以上。用 Safari 打开 HTTPS 站点，通过“共享 → 添加到主屏幕”安装；若有“作为网页 App 打开”选项，请启用。从 Safari 打开桌面应用是新会话，需要重新启用接收。

1. 打开“卫星跟踪”，点“使用当前位置”或手动填写经纬度及海拔。留空海拔按 0 米估计；海拔以 WGS84 椭球面为参考，普通地面观测也可使用估计值。
2. 点击跟踪页顶部的卫星名称，打开“选择卫星”。首次进入跟踪页时，自动从 CelesTrak 获取业余无线电卫星目录，先展示已有缓存；按名称或 NORAD 编号搜索，点击星标收藏，使用“全部／收藏／本地导入”筛选。点击目标立即切换跟踪，搜索和收藏不会改变目标或重启接收。收藏与上次选择只保存在本机，不跨设备同步。目录中的卫星不一定发射 SSTV，其他卫星的下行频率可在设置中自行添加。

   “设置 → 更新星历”分别检查 ISS 与目录的更新间隔。可导入不超过 1 MB、最多 500 颗卫星的两行／三行 TLE 或 OMM JSON。TLE 必须具有有效校验和；导入记录在本机保存，需手动更新。自动更新与手动导入的同一颗卫星分开列出，也可以分别收藏；自定义频率仍按 NORAD 编号复用。收藏或当前目标若从自动目录消失，会保留最后星历并标注“未在最新目录中”；切换目标且取消收藏后移除这份保留记录。
3. 点“启用姿态”，允许运动访问；首次使用按引导将手机屏幕朝上稳定平放约 2 秒，自动校准后抬起手机**物理顶部**指向目标。之后打开会自动建立方向参考，无需点击校准；若无法取得稳定读数，会提示短暂平放。首次引导完成状态保存在本机，旧的方向偏移不会跨会话复用；“手动校准”保留为备用入口。横竖屏不改变指向轴。罗盘易受磁性配件、金属和附近设备影响，精度低时请移开干扰。
4. 在跟踪视图顶部选择下行频率，按大字显示的多普勒修正频率手动调整电台；每秒更新，接近时升高、远离时降低。ISS 默认 SSTV UHF 437.550 MHz，同时提供历史 SSTV VHF 145.800 MHz 和 FM 转发器下行 437.800 MHz；预设不表示当前正在发射，实际以 ARISS 活动公告为准。点击“设置”可管理星历、定位、过境及自定义频率／频段。自定义项目和频段内的目标频率按 NORAD 编号保存在本机；射频模式标签不会更改 SSTV 解码模式。手机竖屏同时显示实时频率、卫星与手机指向和解码预览；点击图像或“放大 / 保存”查看大图、翻页和导出。设置、频率切换和图片放大不会重启麦克风或丢失解码进度。接收栏保留状态、SNR、开始／停止以及暂存录音的下载和清空入口。
5. 应用在接收或跟踪时尝试保持屏幕常亮。切后台或锁屏会停止麦克风，返回前台后可保存已采集的录音，方向参考会自动重新建立，必要时提示短暂平放。录音仍为内存暂存，系统关闭应用或刷新页面会丢失未下载内容。

轨道位置是 SGP4 推算值，不是卫星实时遥测。超过 72 小时的轨道历元会标为较旧；这是提示阈值，不保证精度。过境使用几何地平线，不判断遮挡、光照或 SSTV 发射活动。姿态只作辅助指向，不承诺固定角度精度。WMM2025 有效期为 2025 年至 2029 年，过期后需要更新模型。

首次联网加载后，等待页面底部显示“离线资源已就绪”。已缓存的应用、算法、字体、目录与星历可离线使用，离线时也能搜索、收藏和跟踪缓存目标；首次离线访问无法安装，也无法取得新星历。ISS 与业余无线电目录分别计时，每个来源每次请求（包括失败）至少间隔两小时，手动按钮同样受此限制；服务失败或返回无效数据时保留上一份有效数据，并显示失败原因与下次检查时间。首次未缓存目录时可以等待联网或在设置中导入星历。自动检查仅在已打开页面的前台运行，页面关闭或切后台不会执行定时任务。没有持久存储时退化为会话缓存，并显示提示。

应用有更新时会显示“更新应用”。接收、解码或播放期间更新按钮不可用；需要关闭该站点的其他应用窗口后才能更新。更新以完整资源版本切换，避免页面与解码 Worker 混用版本。

### 开发与验证

保持无需构建的静态部署；第三方浏览器模块已随仓库固定、自托管，不依赖运行时 CDN。修改应用资源后运行 `npm run prepare:offline` 并提交 `sw-assets.js`；GitHub Pages 工作流也会在发布前重新生成资源索引。

```bash
npm run vendor:tracking   # 从锁定依赖重新生成卫星与 WMM 浏览器模块
npm run icons            # 重新生成应用图标
npm run prepare:offline  # 生成原子版本缓存资源索引
npm run test:tracking    # Vallado / NOAA、姿态、目录搜索收藏、导入与独立限流
npm run test:pwa         # 根目录和子路径下的目录交互、音频连续性、离线与更新
npm run test:doppler     # 多普勒符号、距离差分、自定义频率管理
npm run test:field       # 手机同屏、频率操作、音频连续性和离线定向验证
npm test                 # 全部回归
```

浏览器测试默认使用 Windows Chrome，可通过 `CHROME_PATH` 指定可执行文件。ISS 与 amateur 星历请求在自动测试中分别返回固定数据，不向 CelesTrak 连续请求；`test-fixtures/amateur.json` 使用合成轨道，仅验证目录行为，不作为真实卫星的轨道参考值。测试截图输出到 `test-artifacts/`。

**iPhone 真机验收尚未完成**。桌面测试中的权限、姿态和后台事件为模拟，不能替代手机验证；见 [iPhone 验收记录](docs/IPHONE_ACCEPTANCE.md)。

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
│   ├── fft.js              # 频谱瀑布图与流式音频 SNR 估算
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
node verify-snr.js # 流式音频 SNR 估算与分块一致性
node verify-stream.js # 流式重采样、CPLL、VIS/FSK、同步自动启动、手动启动
node verify-audio.js # WAV:PCM/float/边界校验
node uitest.js     # UI:装配与模式填充(jsdom)
```
