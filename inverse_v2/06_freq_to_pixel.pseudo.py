"""
频率 → 像素转换函数
RVA 0x1cf7c  |  VA 0x41cf7c  |  SSTVENG.dll

从反汇编 RVA 0x1cf40..0x1d160 完整逆向确认。

调用约定: __cdecl
  arg0 [ebp+8]  = this (ebx)
  arg1 [ebp+0xc/0x10] = input (float64) — 来自 CPLL::DemodSample 输出

已确认常量 (RVA → f32):
  0x1d178  128.0      直流偏移
  0x1d17c  36864.0    输入上限 (经 DC 校正后)
  0x1d180  23552.0    输入下限 (经 DC 校正后)
  0x1d184  28672.0    像素映射中心
  0x1d188  0.0244140625  映射斜率 = 100/4096

ring buffer 结构 (this+0x3770, esi):
  +0x00  ptr   buffer_base
  +0x04  int   write_pos
  +0x08  int   buf_size
  +0x0c  int   count (已累积样本数)

对象字段:
  +0x3794  int   sample_counter  (逐样本递增)
  +0x3798  f64   current_value   (当前滤波后值)
  +0x379c  f64   current_value_hi (高32位)
  +0x37a0  f64   smoothed_value  (环形缓冲均值输出)
  +0x37a8  f64   pixel_float     (28672 - smoothed_value)
  +0x37b4  int   pixel_counter   (初值 0xf = 15)
  +0x37b8  int   discontinuity_flag (非0 → 触发 ring buf 重填充)
  +0x37bc  int   warmup_counter  (预热期倒计数)
  +0x37c0  int   warmup_total    (预热总样本数)

全局窗口边界 (VA):
  0x495818  int   window_start   (有效采样窗口起点, 样本索引)
  0x49581c  int   window_end     (有效采样窗口终点)

算法流程 (对应 0x1cf7c..0x1d115):
  1. DC 偏移校正: adjusted = input - 128.0  (0x1cf87: fsubr)
  2. 范围检查: if adjusted ∉ [23552, 36864] → 跳过 (0x1cf96/0x1cfa8)
  3. 窗口检查: if sample_counter ∉ [window_start, window_end] → 跳过
  4. 不连续处理 (0x1d04d): 若 discontinuity_flag=1 → call 0x41d18c(填充 ring buf)
  5. 写入 ring buffer (0x1cffa): buf[write_pos] = adjusted
  6. 计算均值: smoothed_value = MovingAvg(ring buf)  (call 0x40b9d4)
  7. 中心映射 (0x1d0cc): pixel_float = 28672.0 - smoothed_value
  8. 缩放截断 (0x1d0ee): pixel_int = ftol(pixel_float × 0.0244140625)
  9. 存储像素 (0x1d0fb): call 0x41b4d0(this, pixel_int)

关键: input 的物理意义
  从上下文推断, input 来自 CPLL::DemodSample 返回值:
    output = -(freq_error × vcoGain_filtered) × 16384
  其中 freq_error = center_freq - raw_freq (1900Hz 为中心)。

  若 freq=1500Hz (黑): error=+400, output=-400×0.0025×16384≈-16384 (after filter)
  若 freq=2300Hz (白): error=-400, output=+400×0.0025×16384≈+16384

  但 [-16384, +16384] 不满足 [23552, 36864] 范围! 说明:
    1. CPLL 输出未直接传入此函数, 中间有额外处理;
    2. 或者 input 单位并非 Hz, 而是某种累积相位/样本计数。

  从 ring buffer 均值 + 28672 中心值推测: input 可能是"载波相位累积器",
  单位为 1/16 样本 (16384=2^14 为定点缩放)。需进一步追踪调用链确认。

映射公式总结 (已确认部分):
  pixel = floor( (28672 - MovingAvg(input - 128)) × (100/4096) )

  换算: 若 input ∈ [23552, 36864], 则:
    adjusted ∈ [23424, 36736]
    假设 MovingAvg ≈ adjusted (稳态), 则:
    pixel_float ∈ [28672-36736, 28672-23424] = [-8064, 5248]
    pixel = floor(pixel_float × 0.024414) ∈ [-197, 128]

  这仍然不对应 [0, 255]! 结论: input 的实际数值范围与物理意义需进一步确认,
  当前公式本身已完整逆向, 但输入量纲未解。
"""

# ──────────────────────────────────────────────────────────────────────
# 伪代码
def FreqToPixel(this, input_value: float) -> None:
    """对应 RVA 0x1cf7c 完整实现."""

    # 1. DC 校正
    adjusted = input_value - 128.0   # fsubr [0x41d178]

    # 2. 范围钳位检查
    if adjusted > 36864.0 or adjusted < 23552.0:
        # 超出范围 → 进入清理路径 (0x1d117)
        if this.sample_counter >= this.window_start and this.discontinuity_flag > 0:
            this.discontinuity_flag -= 1
            if this.discontinuity_flag == 0:
                # ring buf 预热期结束, 丢弃累积
                ring_buf_clear(this.ring_3780)
        return

    # 3. 窗口检查 (0x1cfc4..0x1cfe2)
    if this.sample_counter < globals.window_start or this.sample_counter > globals.window_end:
        return  # 不在有效图像区域

    # 4. 不连续标志处理
    if this.discontinuity_flag:
        # 用当前值填充整个 ring buffer (0x1d062: call 0x41d18c)
        fill_ring_buffer(this.ring_3770, adjusted, adjusted)
        this.discontinuity_flag = 0

    # 5. 写入 ring buffer 并计算均值
    ring = this.ring_3770  # lea esi,[ebx+0x3770]
    buf = ring.buffer_base
    buf[ring.write_pos] = adjusted
    ring.write_pos = (ring.write_pos + 1) % ring.buf_size
    if ring.count < ring.buf_size:
        ring.count += 1
    this.smoothed_value = compute_ring_avg(ring)  # call 0x40b9d4

    # 6. 像素映射: (center - smoothed) × scale
    if this.sample_counter == globals.window_end:
        this.pixel_float = 28672.0 - this.smoothed_value  # fsub [0x41d184]
        this.pixel_counter = 0xf  # 重置计数器(下一段开始)
        pixel_int = int(this.pixel_float * 0.0244140625)  # fmul, ftol

        # 7. 存储到图像缓冲
        store_pixel_to_image(this, pixel_int)  # call 0x41b4d0

    # 8. 递增样本计数
    this.sample_counter += 1
