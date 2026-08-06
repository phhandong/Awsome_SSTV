"""
CLMS 自适应滤波器 与 带通滤波器 — 逆向状态
SSTVENG.dll

## 已确认信息

### 1. CLMS/LMS 配置读取 (ini → 内存)

**ini 参数** (SSTVENG.ini [Define]):
  RXLMS=0       RX 端 LMS 自适应滤波使能 (0=关闭, 1=开启)
  RXLMSAN=0     RX 端 LMS 自适应噪声消除使能
  DEMBPF=0      解调器带通滤波使能 (0=关闭, 1=开启)

**配置读取代码**:
  - RXLMS   字符串 @ RVA 0x893e2, 被 RVA 0x1417a / 0x165bb 引用
  - RXLMSAN 字符串 @ RVA 0x893e8, 被 RVA 0x141f2 / 0x16630 引用
  - DEMBPF  字符串 @ RVA 0x892fd, 被 RVA 0x13389 / 0x166a5 引用

  读取流程 (从 RVA 0x141c0 反汇编确认):
    1. 从 ini 读取整型值 (call 0x4868f0, Delphi TIniFile::ReadInteger)
    2. 存入全局变量:
         RXLMS   → 0x495960 (VA)
         RXLMSAN → 0x495964 (VA)
    3. 通过虚表调用 [edi+8] 创建滤波器对象 (工厂模式)
    4. 返回值存入 this+0x10214 (当前模式参数结构)

**导出 API**:
  mmsSetLMS @ RVA 0x1e08 → thunk 转发到 RVA 0x12390
    - 实际是 set_mode 函数的一部分
    - 参数: eax=this, edx=mode_code
    - 调用 RVA 0x40518c (init_mode_params) 初始化模式参数

### 2. CLMS 类元数据

**RTTI 字符串**:
  - "CLMS"   @ RVA 0x30e8 (类名)
  - "CLMS *" @ RVA 0x4f8c (指针类型名)

**类结构 (推断)**:
  CLMS 是 Delphi 对象,继承自某个滤波器基类。
  虚表偏移 +8 处是工厂方法 (从 call [edi+8] @ 0x1429f 确认)。

### 3. 带通滤波器 (DEMBPF)

**ini 参数**:
  DEMBPF=0         使能标志
  TXBPFTAP=24      发送端 BPF tap 数 (FIR 阶数)
  TXLPFFQ=2000     发送端低通截止频率 (Hz)
  FFTLow=700       FFT 显示下限 (Hz)
  FFTWidth=2000    FFT 显示宽度 (Hz) → 上限 = 700+2000 = 2700 Hz

**推断的滤波器规格**:
  - 通带: 1000–2400 Hz (SSTV 视频带,对应 ini FFTLow=700..2700)
  - 阶数: 21–31 taps (典型 FIR 长度,从 TXBPFTAP=24 推断接收端类似)
  - 窗函数: Hamming 或 Blackman (搜索到 0.5 常数 @ RVA 0x1a14,
            但未找到完整窗函数数组)
  - 实现方式: 可能在运行时动态生成系数 (未找到静态系数数组)

**配置读取位置**: RVA 0x13389
  - 读取 DEMBPF 标志,通过 ini 读写 API
  - 如果启用,创建带通滤波器对象

### 4. 未能定位的部分 (不猜测)

**CLMS 滤波器实现**:
  - ❌ CLMS::Filter 方法地址未定位
  - ❌ 自适应系数更新算法未反汇编
  - ❌ LMS 步长参数 (μ) 的存储位置未找到
  - ❌ 误差信号计算路径未追踪

**带通滤波器系数**:
  - ❌ FIR 系数数组未找到 (搜索了对称数组,结果为未初始化内存)
  - ❌ 窗函数生成代码未定位 (仅找到孤立的 0.5 常数)
  - ❌ 卷积实现 (convolve) 未反汇编

**滤波器调用链**:
  - ❌ CPLL::DemodSample 输出 → CLMS 输入的连接点未确认
  - ❌ 滤波后信号 → freq_to_pixel 的传递路径未完整追踪

### 5. 从 Awsome_SSTV/js/demod.js 的对照

**JS 实现** (作为参考,非 DLL 逆向结果):
  - 带通: 31-tap Hamming 窗 sinc, [1000, 2400] Hz
  - 解调: 过零鉴相 (已确认与 CPLL 一致)
  - 无 LMS 自适应滤波 (JS 未实现)

**MMSSTV (JE3HHT 原作者公开信息)**:
  - CLMS 用于多径衰落补偿 (adaptive equalizer)
  - LMS-AN (自适应噪声消除) 用于抑制窄带干扰
  - PLL 前置带通滤波减少带外噪声

## 结论

**已确认**:
  1. ini 配置参数读取路径
  2. 全局使能标志存储位置 (0x495960, 0x495964)
  3. CLMS/DEMBPF 对象通过工厂模式动态创建
  4. 滤波器初始化在模式切换时触发 (call 0x40518c)

**无法逆向** (不在二进制静态数据中):
  1. CLMS 滤波算法实现细节
  2. 带通 FIR 系数 (运行时生成或在未定位的数据段)
  3. 滤波器与 CPLL 的精确连接方式

**建议**:
  - 若需完整 CLMS 实现,需动态调试或参考 MMSSTV 公开文档
  - 带通滤波器可按标准 DSP 教材实现 (Hamming 窗 sinc, 通带 1000–2400 Hz)
  - LMS 自适应滤波在 ini 默认关闭 (RXLMS=0),对基本 SSTV 解码非必需
"""

# 不写伪代码,因为未逆向到实际算法实现
