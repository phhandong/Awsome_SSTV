"""
DEMBPF 带通滤波器 — 推断实现
SSTVENG.dll

基于标准 FIR 设计方法和已知配置参数的推断实现。
注意: 这不是从反汇编逆向的代码，而是基于 DSP 理论的合理推测。

已知信息:
  - ini 参数: DEMBPF=0/1, TXBPFTAP=24
  - FFT 显示范围: FFTLow=700, FFTWidth=2000 → [700, 2700] Hz
  - SSTV 视频带: [1000, 2400] Hz
  - 窗函数相关常数: 0.5 @ RVA 0x1a14

未定位:
  - ❌ FIR 系数数组地址
  - ❌ 窗函数生成代码
  - ❌ 卷积实现
"""

import math

# ══════════════════════════════════════════════════════════════════════════
# FIR 带通滤波器设计 (Hamming 窗方法)
# ══════════════════════════════════════════════════════════════════════════

def design_bandpass_fir(taps: int, fs: float, f_low: float, f_high: float) -> list[float]:
    """
    设计 FIR 带通滤波器 (窗函数法)

    参数:
      taps: 滤波器阶数 (奇数, 对称)
      fs: 采样率 (Hz)
      f_low: 通带下限 (Hz)
      f_high: 通带上限 (Hz)

    返回:
      h: FIR 系数数组 (长度 taps)

    对应可能的 RVA:
      - 初始化代码可能在 RVA 0x13389 (DEMBPF 配置读取后)
      - 或在 mmsCreate / mmsSetSampleFreq 中动态生成
    """
    # 归一化截止频率 (0–π)
    wc_low = 2 * math.pi * f_low / fs
    wc_high = 2 * math.pi * f_high / fs

    # 理想带通脉冲响应 (sinc 函数)
    n_center = taps // 2
    h_ideal = []
    for n in range(taps):
        i = n - n_center
        if i == 0:
            # sinc(0) = 带宽/π
            h_i = (wc_high - wc_low) / math.pi
        else:
            # h[n] = (sin(wc_high*n) - sin(wc_low*n)) / (π*n)
            h_i = (math.sin(wc_high * i) - math.sin(wc_low * i)) / (math.pi * i)
        h_ideal.append(h_i)

    # Hamming 窗
    window = hamming_window(taps)

    # 加窗
    h_windowed = [h_ideal[i] * window[i] for i in range(taps)]

    # 归一化 (通带增益 = 1)
    gain = sum(h_windowed)
    h_normalized = [coef / gain for coef in h_windowed]

    return h_normalized


def hamming_window(N: int) -> list[float]:
    """
    Hamming 窗函数

    公式: w[n] = 0.54 - 0.46 × cos(2πn/(N-1))

    对应常数 (可能的 RVA 位置):
      0.54 @ RVA 0x????  (未定位)
      0.46 @ RVA 0x????  (未定位)
      0.5  @ RVA 0x1a14  (已定位, 可能用于 cos 参数计算)

    Delphi 实现推测:
      for i := 0 to N-1 do
        window[i] := 0.54 - 0.46 * cos(2*pi*i/(N-1));
    """
    window = []
    for n in range(N):
        w_n = 0.54 - 0.46 * math.cos(2 * math.pi * n / (N - 1))
        window.append(w_n)
    return window


# ══════════════════════════════════════════════════════════════════════════
# FIR 滤波器应用 (卷积)
# ══════════════════════════════════════════════════════════════════════════

class FIRFilter:
    """
    FIR 滤波器对象

    对应 Delphi 对象布局 (推测):
      +0x00  虚表指针
      +0x04  taps (阶数)
      +0x08  coeffs[] (系数数组指针)
      +0x0c  buffer[] (延迟线指针)
      +0x10  write_pos (环形缓冲写位置)
    """

    def __init__(self, coeffs: list[float]):
        self.coeffs = coeffs
        self.taps = len(coeffs)
        self.buffer = [0.0] * self.taps
        self.write_pos = 0

    def filter(self, input_sample: float) -> float:
        """
        处理一个样本 (卷积)

        对应可能的汇编实现:
          ; 假设 esi = this, st0 = input_sample
          fld st0                    ; 加载输入
          mov edi, [esi+0xc]         ; edi = buffer
          mov ecx, [esi+0x10]        ; ecx = write_pos
          fstp qword [edi+ecx*8]     ; buffer[write_pos] = input

          ; 卷积循环
          fldz                       ; output = 0
          mov eax, [esi+0x08]        ; eax = coeffs
          mov ebx, [esi+0x04]        ; ebx = taps
          xor edx, edx               ; edx = k (loop counter)
        .loop:
          fld qword [eax+edx*8]      ; st0 = coeffs[k]
          mov ecx, [esi+0x10]        ; ecx = write_pos
          sub ecx, edx               ; ecx -= k
          jge .no_wrap
          add ecx, ebx               ; 回绕: ecx += taps
        .no_wrap:
          fmul qword [edi+ecx*8]     ; st0 *= buffer[(write_pos-k)%taps]
          faddp st1, st0             ; output += st0
          inc edx
          cmp edx, ebx
          jl .loop

          ; 更新写位置
          inc dword [esi+0x10]       ; write_pos++
          mov ecx, [esi+0x10]
          cmp ecx, [esi+0x04]        ; 检查是否回绕
          jl .done
          mov dword [esi+0x10], 0    ; 回绕到 0
        .done:
          ; 返回值在 st0
        """
        # 更新延迟线
        self.buffer[self.write_pos] = input_sample
        self.write_pos = (self.write_pos + 1) % self.taps

        # 卷积
        output = 0.0
        for k in range(self.taps):
            idx = (self.write_pos - 1 - k) % self.taps
            output += self.coeffs[k] * self.buffer[idx]

        return output


# ══════════════════════════════════════════════════════════════════════════
# RXSSTV 推测参数
# ══════════════════════════════════════════════════════════════════════════

"""
根据 ini 配置和 SSTV 协议推测:

采样率: 11025 Hz (ini 默认)
通带: [1000, 2400] Hz
  - 黑色 1500 Hz
  - 白色 2300 Hz
  - 同步 1200 Hz
  - VIS 1100–1300 Hz
阻带: <900 Hz, >2500 Hz
滤波器阶数: 31 taps (基于 TXBPFTAP=24 推断接收端类似)

过渡带:
  下限: 900–1000 Hz (100 Hz)
  上限: 2400–2500 Hz (100 Hz)

阻带衰减: -40 dB 以上 (Hamming 窗典型值)
"""

# 示例: 生成滤波器系数
SAMPLE_RATE = 11025  # Hz
F_LOW = 1000         # Hz
F_HIGH = 2400        # Hz
TAPS = 31            # 奇数

bpf_coeffs = design_bandpass_fir(TAPS, SAMPLE_RATE, F_LOW, F_HIGH)

print("=== DEMBPF 推测系数 (31-tap Hamming) ===")
print(f"采样率: {SAMPLE_RATE} Hz")
print(f"通带: [{F_LOW}, {F_HIGH}] Hz")
print(f"阶数: {TAPS}")
print(f"\nFIR 系数 (对称):")
for i, coef in enumerate(bpf_coeffs):
    print(f"  h[{i:2d}] = {coef:+.10f}")

print(f"\n系数和: {sum(bpf_coeffs):.10f} (应接近 0 for BPF)")
print(f"对称性验证: {bpf_coeffs == bpf_coeffs[::-1]}")

# 验证频率响应
print("\n=== 频率响应验证 ===")
test_freqs = [500, 1000, 1200, 1500, 1900, 2300, 2400, 2800]
for f in test_freqs:
    # 简化: 计算 H(e^jω) 在 ω = 2πf/fs
    omega = 2 * math.pi * f / SAMPLE_RATE
    H_real = sum(bpf_coeffs[n] * math.cos(omega * (n - TAPS//2)) for n in range(TAPS))
    H_imag = sum(-bpf_coeffs[n] * math.sin(omega * (n - TAPS//2)) for n in range(TAPS))
    H_mag = math.sqrt(H_real**2 + H_imag**2)
    H_dB = 20 * math.log10(H_mag + 1e-10)
    print(f"  {f:4d} Hz: {H_dB:+6.2f} dB  (mag={H_mag:.4f})")


# ══════════════════════════════════════════════════════════════════════════
# 在 SSTVENG.dll 中可能的存储方式
# ══════════════════════════════════════════════════════════════════════════

"""
方式 1: 静态数组 (编译时生成)
  .data 段中预计算的系数表:
    VA 0x48????  dq 3ff1234567890abc  ; h[0]
    VA 0x48????  dq 3ff2345678901bcd  ; h[1]
    ...
  优点: 快速加载
  缺点: 未找到此类数组 (搜索对称浮点数组失败)

方式 2: 运行时生成 (初始化时计算)
  在 mmsCreate 或 mmsSetSampleFreq 中:
    1. 分配系数缓冲 (malloc 或 Delphi GetMem)
    2. 循环计算 sinc × Hamming
    3. 归一化
  优点: 支持动态采样率
  缺点: 初始化开销 (但仅一次)

方式 3: 查表插值
  存储几组采样率的系数:
    sr=8000  → coeffs_8k
    sr=11025 → coeffs_11k
    sr=22050 → coeffs_22k
  根据 ini 采样率选择或插值
  优点: 平衡灵活性与性能
  缺点: 需要更多存储空间

推测: 方式 2 (运行时生成)
  理由:
    1. 未找到静态系数数组
    2. ini 支持多种采样率 (6000–44100 Hz)
    3. 2003 年 PC 性能足以承受初始化计算
"""


# ══════════════════════════════════════════════════════════════════════════
# 动态调试验证建议
# ══════════════════════════════════════════════════════════════════════════

"""
x64dbg 断点设置:

1. 捕获滤波器初始化
   bp SSTVENG+13389         # DEMBPF 配置读取
   # 单步执行到分配/生成系数的代码

2. 搜索 malloc/GetMem 调用
   bp malloc
   bp GetMem                # Delphi 内存分配
   # 查看返回的缓冲区大小: 31*8=248 bytes (double[31])

3. 搜索 sin/cos 调用
   bp sin
   bp cos
   # 在初始化阶段命中 → 可能正在计算窗函数

4. 硬件断点监控系数写入
   # 假设分配的缓冲区地址为 0x12345678
   bphws 0x12345678, w, 8   # 监控第一个系数写入
   # 命中时查看调用栈 → 定位生成代码

5. 监控卷积调用
   # 在 DoJob 中搜索循环结构:
   #   lea edi,[coeffs]; lea esi,[buffer]; xor ecx,ecx
   #   .loop: fld [edi+ecx*8]; fmul [esi+???]; faddp; inc ecx; loop
   bp SSTVENG+d880
   # 单步追踪找到卷积循环
"""


# ══════════════════════════════════════════════════════════════════════════
# 与 Awsome_SSTV/js 实现对比
# ══════════════════════════════════════════════════════════════════════════

"""
JavaScript 实现 (已知):
  - 31-tap Hamming 窗 FIR
  - 通带: [1000, 2400] Hz
  - 采样率: 11025 Hz
  - 系数预计算并硬编码

SSTVENG.dll (推测):
  - 21–31 taps (基于 TXBPFTAP=24)
  - 通带: [1000, 2400] Hz (与 JS 一致)
  - 运行时生成 (支持多采样率)
  - Hamming 窗 (0.5 常数 @ 0x1a14 为证据)

结论: 核心算法一致，实现细节不同 (静态 vs 动态生成)
"""
