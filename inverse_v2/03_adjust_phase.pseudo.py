"""
CSSTVDEM::AdjustPhase  —  手动相位微调
RVA  0xe6f8  |  VA  0x40e6f8  |  SSTVENG.dll

调用: mmsAdjustPhase(phase, scale) → thunk @ VA 0x401ebc → 此函数
约定 (Delphi register + stack):
  eax = CSSTVDEM* this
  edx = phase  (int32, 相位偏移样本数)
  ecx = scale  (int32, 当前扫描线总样本数)
  ret 8

功能: 用户在 GUI 拖动相位条时调用.
  1. 将 phase/scale 换算为样本偏移,写入 ring buf 读指针.
  2. 对当前帧的所有行重新渲染(re-render with shifted phase).
  3. 触发一次显示更新.

确认的操作序列 (从 0xe6f8 反汇编):
  0xe717: test edi,edi; jg   → scale <= 0 时触发全重同步后返回
  0xe757: fild [ebp-0x28]    → phase → FPU
  0xe75a: fmul [esi+8]       → × sr (double)
  0xe760: fild [ebp-0x30]    → scale → FPU
  0xe763: fdivp              → = phase × sr / scale
  0xe765: fild [esi+0x5c]    → 当前 ring buf 读指针
  0xe768: fsubrp             → offset = (phase×sr/scale) - cur_ptr
  0xe76a: call 0x47fbc0      → ftol → 截断为整数
  0xe76f: mov [esi+0x5c],eax → 写回 ring buf 读指针(phase 位移后的位置)

  0xe774..0xe792: 调整读指针使其在 [0, sr_samples] 范围内(模运算)
    - [esi] = mode_type (ini: 0=auto, 1=Scottie,…)
    - [esi+0x50] = 当前模式每行样本数

  0xe7b4: call 0x40ade4      → flush/reset ring buf (丢弃当前未处理数据)
  0xe7bb: mov [ebx+0x28364],1 → set re_render_flag
  0xe7c5: lea eax,[ebx+0x283c4]; call 0x417010 → 重建 ring buf

  0xe7e2: xor edi,edi         → 行循环 edi=0
  row_loop (0xe7e9..0xe8a5): 对每一行:
    0xe817: call 0x40bbc8     → render_line(this, line_buf_ptr, offset×2)
      [ebx+0x283d8] = line_buf_a, [ebx+0x283dc] = line_buf_b
    0xe865: add [eax+0x3710],edx → 累积行相位

  0xe8c8: call 0x40ec90       → 更新显示 (DIB 刷新)
  0xe8cf: or [ebx+0x283f4],1  → 置状态标志 bit0 (已调整)
"""


def AdjustPhase(this, phase: int, scale: int) -> None:
    """
    伪代码: 对应 RVA 0xe6f8 逐步骤。
    phase: GUI 相位滑块值(整数样本偏移)
    scale: 当前扫描线的总样本数(来自模式时序)
    """
    conf = this.g_config   # esi = 0x4956e0

    # 0xe717: scale <= 0 → 不能除以 0, 触发全重同步
    if scale <= 0:
        full_resync(this, edx=0)   # call 0x40eed4(this, 0)
        return

    # ── 计算样本偏移 ──────────────────────────────────────────────────
    # 0xe757..0xe76f
    offset_float = (phase * conf.sr_double) / scale
    # 从当前 ring buf 读指针减去偏移,得到新的读指针位置
    new_ptr = int(conf.ring_read_ptr - offset_float)  # ftol (截断)

    # 模运算: 保证 new_ptr 在 [0, line_samples) (0xe780..0xe792)
    line_samples = conf.line_samples   # [esi+0x50]
    while new_ptr < 0:
        new_ptr += line_samples
    while new_ptr >= line_samples:
        new_ptr -= line_samples
    conf.ring_read_ptr = new_ptr       # mov [esi+0x5c], eax

    # ── flush 当前 ring buf, 准备重新渲染 ─────────────────────────────
    # 0xe7b4: call 0x40ade4
    flush_ring_buf(this)
    this.re_render_flag = 1            # mov [ebx+0x28364],1
    rebuild_ring_buf(this)             # call 0x417010

    # ── 逐行重渲染 ───────────────────────────────────────────────────
    sub = this.sync_substruct          # lea,[ebx+0x1028c]
    sub.line_phase = conf.ring_read_ptr  # mov [eax+0x3710], ecx (0xe7d6)

    for row in range(sub.sync_line_count):
        # 0xe7f6..0xe85e: 根据 use_ring_buf 选择 line_buf_a 或 line_buf_b
        if sub.use_ring_buf:
            buf_ptr = sub.ring_buf_ptr + row * conf.line_samples * 2
        else:
            buf_ptr = this.line_buf_a  # 见 0xe831/0xe847
        # 0xe817/0xe85a: call 0x40bbc8(this, buf_ptr, offset×2)
        render_line(this, buf_ptr, row * conf.line_samples * 2)

        # 累积行相位 (0xe865)
        sub.line_phase += conf.line_samples

        # 每行后触发显示通知 (0xe877..0xe894)
        if sub.slant_enabled:
            notify_display_line(this, row)

    # ── 状态更新 ─────────────────────────────────────────────────────
    this.re_render_flag = 0            # 0xe8ad
    sync_ring_buf(this)                # call 0x40dae0

    # 如果 sr 发生变化则触发 AFC (0xe8ba..0xe8c8)
    if conf.sr_double != conf.sr_initial:
        trigger_afc(this)              # call 0x40ec90

    this.status_flags |= 0x1           # or [ebx+0x283f4],1 (0xe8cf)
