"""
CPLL::DemodSample  —  零过点锁相环解调器
RVA  0x1843c  |  VA  0x41843c  |  SSTVENG.dll (MMSSTV v1.06)

调用约定: __cdecl(Delphi Pascal-style)
  arg0 (ebx = [ebp+8])  = CPLL* this
  arg1 (double at [ebp+0xc/0x10]) = 当前音频样本值 (float64)
返回值: FPU ST0 = 解调输出(float64, 单位见下)

反汇编确认的常量 (VA → 值):
  0x4186c0  f32  0.0      零过点比较阈值
  0x4186c4  f32  1.0      最小半周期(样本数),小于此则忽略
  0x4186c8  f32  0.5      半周期 ref × 0.5 = sr/1 (freq_raw = ref×0.5/delta = sr/delta)
  0x4186cc  f32  2400.0   频率上限钳位 (Hz)
  0x4186d0  f32  1000.0   频率下限钳位 (Hz)
  0x4186d4  f32  1900.0   中心频率 (Hz) ,误差基准
  0x4186d8  f80  0.0025   VcoGain (80-bit extended; 来自 ini pllVcoGain=1 换算)
  0x4186e4  f32  16384.0  输出缩放因子 (最终 × 16384 再取反)

CPLL 对象内存布局 (ebx = this):
  +0x04  int32   样本计数器 (逐样本递增)
  +0x08  float64 上一个正过零点的分数位置 (初值 -1.0 或某负值表示"未初始化")
  +0x10  float64 上一个样本值 (初值 0.0;用于检测过零)
  +0x18  float64 当前原始频率估计 (每半周期更新)
  +0x20  float64 经输出滤波后的频率误差×增益 (= DemodSample 返回值)
  +0x28  float64 halfPeriodRef = 2 × sampleRate  (由 mmsSetSampleFreq 写入)
  +0x30  int32   outOrder: 0=直通, 1=环形缓冲均值, 2=另一种滤波(未全逆向)
  +0x34  int32   clampEnabled: 非 0 则启用频率钳位
  +0x38  float64[N] 环路滤波器缓冲区 (loopOrder=1 时的滑动窗口)
  +0x50  int32   loopBufSize (= pllLoopOrder 值; ini 默认 1)
  +0x54  int32   loopBufWritePos
  +0x58  int32   loopBufCount (累积满后才开始均值)
  +0x5c..+0x80  输出滤波器状态 (环形缓冲, outOrder=1 时使用)
  +0x78  int32   warmup_counter (初始样本不稳定期倒计数)
  +0x7c  int32   warmup_total (初值由 ini pllOutOrder 决定)
"""

# ── CPLL 对象结构 ────────────────────────────────────────────────────
class CPLL:
    sample_count:     int    # +0x04 逐样本递增
    prev_cross_frac:  float  # +0x08 上一正过零点分数位置
    prev_sample:      float  # +0x10 上一样本值
    freq_raw:         float  # +0x18 当前原始频率估计 (Hz)
    output:           float  # +0x20 经环路+输出滤波后的值
    half_period_ref:  float  # +0x28 = 2 × sr (由 mmsSetSampleFreq 写入)
    out_order:        int    # +0x30
    clamp_enabled:    int    # +0x34 非0 → 启用 [1000, 2400] Hz 钳位
    # +0x38..  loop filter ring buffer  (长度 = loop_buf_size)
    loop_buf_size:    int    # +0x50  (ini pllLoopOrder, 默认1)
    loop_write_pos:   int    # +0x54
    loop_count:       int    # +0x58
    # +0x5c..  output filter ring buffer
    warmup_counter:   int    # +0x78
    warmup_total:     int    # +0x7c


# ── 常量 ─────────────────────────────────────────────────────────────
ZERO_THRESH   = 0.0      # [VA 0x4186c0] 零过点阈值
MIN_PERIOD    = 1.0      # [VA 0x4186c4] 最小半周期 (样本)
HALF_MULT     = 0.5      # [VA 0x4186c8]
FREQ_HI       = 2400.0   # [VA 0x4186cc] 频率上限 (Hz)
FREQ_LO       = 1000.0   # [VA 0x4186d0] 频率下限 (Hz)
CENTER_FREQ   = 1900.0   # [VA 0x4186d4] PLL 中心 (Hz)
VCO_GAIN      = 0.0025   # [VA 0x4186d8] 80-bit = 2^-9 × 0xa3d7...
OUTPUT_SCALE  = 16384.0  # [VA 0x4186e4]


# ── 主函数(伪代码,直接对应 RVA 0x1843c 反汇编) ────────────────────────
def DemodSample(pll: CPLL, sample: float) -> float:
    """
    每个音频样本调用一次。
    正过零点: prev_sample < 0 且 sample >= 0
    负过零点: prev_sample >= 0 且 sample < 0
    两种都检测(代码在 0x18453 和 0x18537 有两条对称路径)。
    """

    # ── 过零检测与分数位置插值 ─────────────────────────────────────────
    detected = False
    current_sign_neg = (sample < ZERO_THRESH)   # 0x18453: fcomp [0x4186c0]; jb
    prev_sign_neg    = (pll.prev_sample < ZERO_THRESH)

    if current_sign_neg != prev_sign_neg:        # 符号变化 → 过零
        # 线性插值求精确过零点位置 (0x1846b..0x1847d)
        #   fract = sample / (sample - prev_sample)
        #       → cross_frac = counter - fract
        denom = sample - pll.prev_sample          # 0x1847a: fdivr
        fract = sample / denom if denom != 0 else 0.0
        cross_pos = pll.sample_count - fract      # 0x18480: fsub [ebx+8]→ebx+8

        # 半周期长度 = 当前过零位置 - 上一个同向过零位置
        # (两个正过零点之间 = 一个完整周期; 我们取半周期)
        if pll.prev_cross_frac >= 0:
            delta = (pll.sample_count - pll.prev_cross_frac) - fract
            # 0x18492: fcomp [0x4186c4]=1.0; jb → 丢弃过短的半周期
            if delta >= MIN_PERIOD:
                # freq = halfPeriodRef × 0.5 / delta  (= sr / delta)
                # 0x4186c8: ×0.5; RVA 0x184ad: fdiv delta
                pll.freq_raw = pll.half_period_ref * HALF_MULT / delta  # Hz

                # 频率钳位 (仅在 clamp_enabled 非 0 时执行)
                # 0x4186cc = 2400; 0x4186d0 = 1000
                if pll.clamp_enabled:
                    if pll.freq_raw > FREQ_HI:
                        pll.freq_raw = FREQ_HI  # 0x4184c7: 置0; 高32位=0x3ff40000=1.25…
                        # NOTE: 实际置为 IEEE 0x3ff40000_00000000 = 1.25? 待确认
                        # 从上下文推断应为2400,但直接写入的双字值来自运行时计算
                    elif pll.freq_raw < FREQ_LO:
                        pll.freq_raw = FREQ_LO

                detected = True

        pll.prev_cross_frac = cross_pos           # 更新 +0x08

    # ── 环路滤波器 (loopOrder = [ebx+0x30]) ──────────────────────────
    # loopOrder=0: 直通(freq_raw 直接进输出滤波)
    # loopOrder=1: 环形缓冲移动平均(长度 = [ebx+0x50], 默认1即无均值)
    # 0x41864b..0x41868d: 写入环形缓冲, call 0x40b9d4 (计算均值)
    if detected:
        error = CENTER_FREQ - pll.freq_raw        # 0x4186d4: fsub 1900
        gain_error = error * VCO_GAIN             # 0x4186d8: ×0.0025 (80-bit)
        loop_out = loop_filter(pll, gain_error)   # ring buf avg (call 0x40b9d4)
    else:
        loop_out = pll.output  # 无过零时保持上一输出 (passthrough in warmup)

    # ── 预热计数器 (warmup_counter @ +0x78) ──────────────────────────
    # 0x41860d: cmp [ebx+0x78],0; dec; 当 warmup 结束后才进输出滤波
    if pll.warmup_counter > 0:
        pll.warmup_counter -= 1
        if pll.warmup_counter == 0:
            # 滤波器已稳定
            pass

    # ── 输出滤波器 (outOrder=[ebx+0x30]) ────────────────────────────
    # outOrder=0: 直通
    # outOrder=1: 环形缓冲均值 (call 0x40b9d4)
    # outOrder≥2: 另一路径 (0x418693, 直接赋值, 未完整反汇编)
    out_val = output_filter(pll, loop_out)        # 见 0x41862b 分支

    # ── 存储前一样本 ────────────────────────────────────────────────
    pll.prev_sample  = sample                     # 0x4186a2: mov [ebx+0x10]
    pll.sample_count += 1                         # 0x4186ab: inc [ebx+4]

    # ── 最终输出: ×16384, 取反 ──────────────────────────────────────
    # 0x4186b1: fmul [0x4186e4]=16384.0; fchs
    pll.output = out_val
    return -(out_val * OUTPUT_SCALE)


# ── 辅助: 环形缓冲均值 (对应 call 0x40b9d4) ─────────────────────────
def loop_filter(pll: CPLL, value: float) -> float:
    """loopOrder=1 时的移动平均, 窗口长 loop_buf_size(来自 ini pllLoopOrder=1)."""
    buf = pll._loop_buf
    buf[pll.loop_write_pos] = value
    pll.loop_write_pos = (pll.loop_write_pos + 1) % pll.loop_buf_size
    if pll.loop_count < pll.loop_buf_size:
        pll.loop_count += 1
    return sum(buf[:pll.loop_count]) / pll.loop_count


def output_filter(pll: CPLL, value: float) -> float:
    """outOrder: 0=直通, 1=环形缓冲均值(与 loop_filter 同结构)."""
    if pll.out_order == 0:
        return value
    # loopOrder=1: 环形缓冲均值 (地址 0x5c..0x80 内的子缓冲)
    # 具体同上, 省略重复
    return value  # 简化: 按 ini pllOutOrder=3,FC=900Hz 应为3阶低通,未完整逆向
