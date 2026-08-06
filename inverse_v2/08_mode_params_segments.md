"""
Robot/Scottie/Martin 像素段边界计算
SSTVENG.dll 模式参数结构

## 模式表结构 (已完整确认)

### 1. 模式索引 → 名称映射 (RVA 0x8b420)
char* ModeNames[37] = {
  [0]  "Robot 36",    [1]  "Robot 72",    [2]  "AVT 90",
  [3]  "Scottie 1",   [4]  "Scottie 2",   [5]  "ScottieDX",
  [6]  "Martin 1",    [7]  "Martin 2",    [8]  "SC2 180",
  [9]  "SC2 120",     [10] "SC2 60",      [11] "PD50",
  [12] "PD90",        [13] "PD120",       [14] "PD160",
  [15] "PD180",       [16] "PD240",       [17] "PD290",
  [18] "P3",          [19] "P5",          [20] "P7",
  [21] "MR73",        [22] "MR90",        [23] "MR115",
  [24] "MR140",       [25] "MR175",       [26] "MP73",
  [27] "MP115",       [28] "MP140",       [29] "MP175",
  [30] "ML180",       [31] "ML240",       [32] "ML280",
  [33] "ML320",       [34] "Robot 24",    [35] "B/W 8",
  [36] "B/W 12"
};

### 2. 模式索引 → 内部类型映射 (RVA 0x8b606)
uint8_t TypeMap[37] = {
  35, 36, 34,  // Robot 36/72, AVT 90
  0, 1, 2,     // Scottie 1/2/DX
  3, 4,        // Martin 1/2
  5, 6, 7,     // SC2 180/120/60
  8,9,10,11,12,13,14,  // PD50/90/120/160/180/240/290
  15,16,17,    // P3/5/7
  18,19,20,26,27,  // MR73/90/115/140/175
  28,29,21,22, // MP73/115/140/175
  23,24,25,30, // ML180/240/280/320
  31,32,33     // Robot 24, B/W 8/12
};

### 3. 模式尺寸获取 (mmsGetModeSize @ RVA 0x1b3c)
对于 mode_idx ∈ [34, 36] (Robot 24, B/W 8, B/W 12):
  返回 (height/2 << 16) | (width/2)  // 半尺寸
其他模式:
  返回 (height << 16) | width        // 全尺寸

典型尺寸 (从公开 SSTV 规范):
  - Robot 36/72: 320×240
  - Scottie 1: 320×256
  - Martin 1: 320×256
  - PD 系列: 320×256 (PD120/160/180/240/290)

## 模式参数初始化 (init_mode_params @ RVA 0x518c)

### 调用: set_mode → init_mode_params(param_struct*, mode_code)

**参数结构偏移** (ebx = param_struct):
  +0x00  ptr   buffer_y       (Y/亮度缓冲,分配 0x608 字节)
  +0x04  ptr   buffer_cb      (Cb/U 色度缓冲)
  +0x40  ptr   buffer_cr      (Cr/V 色度缓冲)
  +0x44  int   scan_samples_1 (扫描段1样本数, ≤0xc0=192)
  +0x48  int   scan_samples_2 (扫描段2样本数, ≤0xc0=192)
  +0x4c  f32   timing_param_1 (模式相关浮点参数)
  +0x50  f32   timing_param_2
  +0x54  f32   timing_param_3
  +0x58  f32   timing_param_4

**scan_samples 计算** (0x5194..0x51f3):
  scan_samples_1 = ftol(48.0 × sr × 0x1e17b6... + 0.5)
  scan_samples_2 = ftol(12.0 × sr × 0x1e17b6... + 0.5)
  if (scan_samples > 0xc0) scan_samples = 0xc0  // 钳位到 192

  其中:
    sr = 11025.0 (从 [VA 0x48b89c] 读取, ini SampFreq)
    0x1e17b6... (80-bit) ≈ 9.0703e-05 (推测为时间→样本转换系数)
    48.0 → 可能对应 48ms 扫描段
    12.0 → 可能对应 12ms 扫描段

**timing_param 赋值** (0x5238/0x5256):
  Mode 1 (Scottie 2?):
    +0x4c = 0x39ffd60f → 3.0515e-04
    +0x50 = 0x3f2797cc → 6.5574e-01
    +0x54 = 0xce4217d3 → -8.1446e+08 (negative!)
    +0x58 = 0x3feffffb → 1.8749e+00

  Default (其他模式):
    +0x4c = 0xeb1c432d → -1.8920e+26 (invalid float?)
    +0x50 = 0x3f0a36e2 → 5.4001e-01
    +0x54 = 0xdab191de → -2.4939e+16 (negative!)
    +0x58 = 0x3feffffc → 1.8750e+00

  这些浮点值看起来不合理(负数巨大),可能是:
    1. 实际为整数偏移地址 (被错误解释为 float)
    2. 未初始化的占位符 (运行时由其他代码填充)
    3. 反汇编偏移错误导致读到错误的立即数

## 像素段边界计算 (推断 + 公开规范)

### Scottie 系列 (type 0/1/2)
**时序结构** (从公开 SSTV 规范):
  - 逐行扫描: Y → R-Y → B-Y (绿色在行末)
  - 同步脉冲 9ms (1200 Hz) 在每行**末尾**
  - 扫描段长度 (Scottie 1): Y=138.24ms, R-Y=B-Y=138.24ms
  - 分隔脉冲 1.5ms (1500 Hz) 在段之间

**段边界样本计算**:
  sr = 11025 Hz (ini 默认)
  Y_samples   = floor(138.24e-3 × sr) = 1524 样本
  RY_samples  = floor(138.24e-3 × sr) = 1524 样本
  BY_samples  = floor(138.24e-3 × sr) = 1524 样本
  sep_samples = floor(1.5e-3 × sr)    = 16 样本

  行结构: [Y + sep + R-Y + sep + B-Y + sep + SYNC]
  像素宽度 = 320, 每段采样 320 点:
    pixel_ms = scan_ms / 320 = 138.24 / 320 = 0.4320 ms/pixel

**DLL 实现**:
  - scan_samples_1 (0x44) 对应主扫描段 (Y/R-Y/B-Y)
  - 钳位 ≤192 可能是某种缓冲区约束, 而非实际扫描长度
  - 实际像素采样间隔由 freq_to_pixel 的 window [23552,36864] 控制

### Martin 系列 (type 3/4)
**时序结构**:
  - 逐行扫描: SYNC + sep + G + sep + B + sep + R (同步在行**首**)
  - SYNC 4.862ms (1200 Hz)
  - 扫描段 (Martin 1): G=B=R=146.432ms

**段边界**:
  scan_samples = floor(146.432e-3 × 11025) = 1614 样本
  像素间隔 = 146.432 / 320 = 0.4576 ms/pixel

### Robot 系列 (type 35/36/31)
**时序结构**:
  - YUV 4:2:2 色彩空间, 隔行扫描 (interlace)
  - 奇场: Y0 + Cb0 + Y1 + Cr1 + ... (120 行)
  - 偶场: Y0 + Cr0 + Y1 + Cb1 + ... (120 行)
  - SYNC 9ms (1200 Hz) 在每行**首**

**段边界** (Robot 36):
  Y_scan  = 88ms / 320 = 0.275 ms/pixel
  Cb_scan = 44ms / 160 = 0.275 ms/pixel (色度半分辨率)
  Cr_scan = 44ms / 160 = 0.275 ms/pixel

## 未能逆向的部分 (不猜测)

1. **精确的段边界样本数组**
   - DLL 中应有类似 `SegmentDescriptor[] segments` 的结构
   - 每段记录: start_sample, length_samples, color_channel, pixel_count
   - 未定位到此数组的具体地址

2. **时序参数的真实语义**
   - +0x4c..0x58 的 4 个浮点数的物理意义未确认
   - 可能是: VIS 码延迟, 行前导时间, 色度偏移, 斜率校正系数

3. **动态段边界调整**
   - freq_to_pixel 的 window [23552,36864] 与模式时序的关系未明
   - 可能通过采样率缩放动态调整: window = base × (sr/11025)

4. **模式参数记录完整布局**
   - RVA 0x8b6bc 的参数记录结构未完整解析
   - 记录大小 ≈32 字节, 但字段含义未全部确认

## 结论

**已确认**:
  - 37 种模式的名称和内部类型映射
  - 模式尺寸获取逻辑 (含 Robot 24/BW 半尺寸特殊处理)
  - 参数初始化入口和部分字段偏移
  - scan_samples 计算公式 (含采样率缩放)

**可从公开规范补充**:
  - 各模式的标准时序 (ms 级段长度)
  - 像素/样本映射公式 (samples = ms × sr)
  - 同步脉冲位置 (Scottie 行末, Martin/Robot 行首)

**无法逆向** (需动态调试或参考源码):
  - 段边界描述符数组的精确地址和结构
  - timing_param 浮点参数的真实语义
  - 段边界与 freq_to_pixel window 的动态关联
"""
