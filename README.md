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
- 🛰️ **卫星跟踪**：从 TLEData 自动获取 ISS 与完整卫星目录及转发器频率，支持名称／NORAD 编号搜索和本机收藏；中继显示上下行和亚音，本机计算所选目标的方位、仰角、距离及未来 24 小时过境，支持 TLE / OMM JSON 导入
- 📅 **过境日历**：启用日历服务时点击“订阅日历”打开 iPhone 订阅界面，无需保存文件；支持复制订阅地址及分享／下载 `.ics` 文件
- 🧭 **iPhone 指向**：定位或手动坐标、运动授权、平放校准；以手机物理顶部指向卫星，WMM2025 磁偏角修正到真北
- 📲 **桌面 Web 应用**：添加到主屏幕、离线启动与版本缓存；接收／跟踪同页切换，音频会话持续运行

## iPhone 使用

目标系统为 iOS 18.4 及以上。用 Safari 打开 HTTPS 站点，通过“共享 → 添加到主屏幕”安装；若有“作为网页 App 打开”选项，请启用。从 Safari 打开桌面应用是新会话，需要重新启用接收。

1. 打开“卫星跟踪”，点“使用当前位置”或手动填写经纬度及海拔。留空海拔按 0 米估计；海拔以 WGS84 椭球面为参考，普通地面观测也可使用估计值。
2. 点击跟踪页顶部的卫星名称，打开“选择卫星”。默认星历源为 [TLEData all.txt](https://tledata.xanyi.eu.org/tledata/all.txt)，ISS 与完整目录共用一次下载。先展示已有缓存；按名称或 NORAD 编号搜索，点击星标收藏，使用“全部／收藏／本地导入”筛选。目录每批显示 100 颗，可点击“显示更多卫星”，搜索覆盖完整目录。点击目标立即切换跟踪，搜索和收藏不会改变目标或重启接收。收藏与上次选择只保存在本机，不跨设备同步。目录中的卫星不一定发射 SSTV。

   “设置 → 更新星历”检查星历和转发器数据各自的更新间隔。自动目录最多支持 8 MB、30000 颗卫星；可通过“导入文件”或“粘贴星历 → 导入文本”手动导入不超过 1 MB、最多 500 颗卫星的两行／三行 TLE 或 OMM JSON，无需为复制的文本另存文件。TLE 必须保留行内空格并具有有效校验和，Alpha-5 编号会转换为数字 NORAD 编号；导入成功后自动切换到第一颗卫星。校验失败时保留输入，便于修改后重试。导入记录在本机保存，需手动更新。自动更新与手动导入的同一颗卫星分开列出，也可以分别收藏；频率数据按 NORAD 编号复用。收藏或当前目标若从自动目录消失，会保留最后星历并标注“未在最新目录中”；切换目标且取消收藏后移除这份保留记录。
3. 点“开启指向”，允许运动访问；轨迹图下方会显示状态和对齐进度。将手机屏幕朝上稳定平放约 2 秒，方向就绪后用手机**物理顶部**指向目标。“重新对齐”也使用相同的连续稳定检查，不会凭一次读数显示成功。切换“音频接收／卫星跟踪”保持本次参考；从后台或锁屏返回后，需要平放约 2 秒核验方向，防止传感器参考变化造成偏转。短暂的读数异常会暂时隐藏指向，稳定恢复后无需再次平放；持续异常或传感器中断则需重新核验。提示区分等待数据、系统罗盘未就绪和精度不足，不将它们直接归因于磁场干扰。平放只对齐浏览器方向参考，不能校准系统磁传感器，也不保证绝对精度；若仍有明显偏差，请对照系统指南针，检查磁性配件和观测位置。方向偏移不跨刷新复用，横竖屏不改变指向轴。
4. 在跟踪视图顶部选择下行频率，按大字显示的多普勒修正频率手动调整电台；每秒更新，接近时升高、远离时降低。ISS 默认 SSTV UHF 437.550 MHz，同时提供历史 SSTV VHF 145.800 MHz 和 FM 转发器下行 437.800 MHz；预设不表示当前正在发射，实际以 ARISS 活动公告为准。点击“设置”可管理星历、定位、过境及自定义频率／频段。自定义项目和频段内的目标频率按 NORAD 编号保存在本机；射频模式标签不会更改 SSTV 解码模式。手机竖屏同时显示实时频率、卫星与手机指向和解码预览；点击图像或“放大 / 保存”查看大图、翻页和导出。设置、频率切换和图片放大不会重启麦克风或丢失解码进度。接收栏保留状态、SNR、开始／停止以及暂存录音的下载和清空入口。
5. 应用在接收或跟踪时尝试保持屏幕常亮。切后台或锁屏会停止麦克风，返回前台后可保存已采集的录音；姿态会在平放核验方向参考后恢复显示。录音仍为内存暂存，系统关闭应用或刷新页面会丢失未下载内容。
6. 在“设置 → 未来 24 小时”点击某次过境的“订阅日历”，通过 `webcal://` 打开系统订阅界面，确认即可，无需保存文件。若未跳转，请用 Safari 打开，或展开“如何添加到 iPhone 日历”，复制地址到日历 App 的“添加订阅日历”；也可改用日历文件。若网站没有可访问的日历服务，按钮仍显示“添加到日历”，使用原有分享／下载方式；iPhone 可用 Apple Mail 打开附件导入。网页不能确认系统是否已完成订阅或添加。事件包含起止时间、最高仰角、观测位置和提前 5 分钟提醒（提醒时间未过时）。每个订阅地址只含所选过境的只读预测快照，不随星历更新；星历或位置变化后请重新核对，重复添加前检查已有事件。地址包含该次过境和坐标，请仅分享给需要的人。

正常更新应用会保留同一网站、同一浏览器或主屏幕应用中的已导入星历、收藏、观测位置和频率设置。资源更新只替换应用缓存，不清空 `sstv-tracking` 数据库；日历导出也不修改这些记录。清除网站数据、系统清理存储或改用其他网址／浏览器后，原有本机数据可能不可用，请保留原始星历文件作为备份。

轨道位置是 SGP4 推算值，不是卫星实时遥测。超过 72 小时的轨道历元会标为较旧；这是提示阈值，不保证精度。过境使用几何地平线，不判断遮挡、光照或 SSTV 发射活动。姿态只作辅助指向，不承诺固定角度精度。WMM2025 有效期为 2025 年至 2029 年，过期后需要更新模型。

转发器默认来自 [TLEData trans.json](https://tledata.xanyi.eu.org/tledata/trans.json)，首次进入跟踪页时更新，自动提供下行频率或频段。带上行的记录在主界面与设置中显示上下行；FM 中继提取描述中的 CTCSS／PL 亚音，源未注明时显示“未提供”，明确注明 no CTCSS 时显示“无需”。线性转发器显示上下行频段、模式和反相标记；源标为停用或未确认的记录会标注。自定义频率和原有 ISS 预设保留，数据更新不覆盖自定义选择。星历与转发器按编号关联，数据源中的名称或编号错误不会被猜测修正。

首次联网加载后，等待页面底部显示“离线资源已就绪”。已缓存的应用、算法、字体、目录、星历与转发器可离线使用，离线时也能搜索、收藏和跟踪缓存目标；首次离线访问无法安装，也无法取得新星历。all.txt 与 trans.json 分别计时，每个来源每次请求（包括失败）至少间隔两小时，手动按钮同样受此限制；服务失败或返回无效数据时保留上一份有效数据，并显示失败原因与下次检查时间。首次未缓存目录时可以等待联网或在设置中导入星历。自动检查仅在已打开页面的前台运行，页面关闭或切后台不会执行定时任务。没有持久存储时退化为会话缓存，并显示提示。

应用有更新时会显示“更新应用”。接收、解码或播放期间更新按钮不可用；需要关闭该站点的其他应用窗口后才能更新。更新以完整资源版本切换，避免页面与解码 Worker 混用版本。

### 开发与验证

保持无需构建的静态部署；第三方浏览器模块已随仓库固定、自托管，不依赖运行时 CDN。修改应用资源后运行 `npm run prepare:offline` 并提交 `sw-assets.js`；GitHub Pages 工作流也会在发布前重新生成资源索引。

```bash
npm run vendor:tracking   # 从锁定依赖重新生成卫星与 WMM 浏览器模块
npm run icons            # 重新生成应用图标
npm run prepare:offline  # 生成原子版本缓存资源索引
npm run test:tracking    # Vallado / NOAA、姿态、大目录、转发器与缓存限流
npm run test:pwa         # 根目录和子路径下的目录交互、音频连续性、离线与更新
npm run test:doppler     # 多普勒符号、距离差分、自定义频率管理
npm run test:field       # 手机同屏、频率操作、音频连续性和离线定向验证
npm test                 # 全部回归
```

浏览器测试默认使用 Windows Chrome，可通过 `CHROME_PATH` 指定可执行文件。all.txt 和 trans.json 请求在自动测试中返回固定数据，不向外部源连续请求；`test-fixtures/amateur.json` 使用合成轨道，`test-fixtures/transponders.json` 含实际频率样例及明确标为 TEST 的合成记录，仅验证目录和界面行为。测试截图输出到 `test-artifacts/`。

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

### 启用日历订阅服务

`decode.handong-joy.xyz` 使用 GitHub Pages 提供网页，Cloudflare Worker 单独处理 `/calendar/pass.ics`。`wrangler.jsonc` 只匹配该接口及查询参数；`worker/calendar.js` 对其他路径返回 404。部署日历服务使用 `npm run deploy:calendar`（固定 Wrangler 4.149.0），网页仍通过现有 GitHub Pages 工作流发布。无数据库、定时任务或额外存储；关闭请求日志，避免记录包含观测坐标的订阅 URL。

运行 `npm start` 会在 `http://localhost:8000/` 同时提供静态网站和 `/calendar/pass.ics` 日历接口，无需数据库或新增依赖。手机与电脑在同一网络时，请使用电脑的局域网 IP 地址打开页面；手机上的 `localhost` 指向手机自身。电脑必须保持服务运行，日历 App 才能访问订阅地址。麦克风和运动权限仍需要 HTTPS。

线上订阅需要长期可访问、无需网页登录的日历接口。可以将此 Node 服务部署在 HTTPS 反向代理后；若网站继续使用 GitHub Pages，则另外部署日历服务，将 `index.html` 中 `calendar-feed-url` 的内容设为完整的 HTTPS 接口地址（例如 `https://你的日历服务域名/calendar/pass.ics`），再运行 `npm run prepare:offline`。留空时使用当前站点下的 `./calendar/pass.ics`。GitHub Pages 不执行服务器接口，单独上传静态文件不能启用订阅。

页面会检查接口是否支持订阅，服务不可用时保留文件导出。接口采用无状态 GET：URL 中携带有长度限制的事件快照，服务验证后返回 `text/calendar`，支持 GET、HEAD、OPTIONS 和跨域能力检查；不上传 TLE／OMM，不修改或存储本机星历、收藏或位置。外部日历不会运行网页的 Service Worker，因此不能使用 `blob:`、`data:` 或仅浏览器缓存中的文件代替在线接口。

运行 `npm run test:calendar` 和 `npm run test:calendar-browser` 验证事件响应、订阅入口、复制地址、文件备用方式、320px 布局和原有跟踪数据保留。Safari／主屏幕应用实际唤起和确认订阅需按 `docs/IPHONE_ACCEPTANCE.md` 用 iPhone 验收。

### 发布静态网页

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
