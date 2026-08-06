"""
CSSTVDEM::CorrectSlant  —  斜率校正(采样率线性回归)
RVA  0xdf28  |  VA  0x40df28  |  SSTVENG.dll

调用: mmsCorrectSlant → thunk @ VA 0x401eac → 此函数
约定: eax = CSSTVDEM* this (Delphi register call)

原理: 当声卡采样率与音频实际采样率存在偏差时, SSTV 图像会倾斜。
      方法是对多行同步脉冲的实际位置做线性回归,用斜率估计偏差并修正。

确认常量 (VA → f32):
  0x40e6c4  f64  0.1      初始搜索窗口宽度 = 0.1 × sr (样本)
  0x40e6cc  f64  0.0      线性回归累加器初值
  0x40e6d8  f32  0.25     采样率修正上限 (max +25%)
  0x40e6dc  f32  0.125    采样率修正下限 (min -12.5%)
  0x40e6e0  f32  3.0      外层窗口比例 3×sr
  0x40e6e4  f32  7.0      外层窗口比例 7×sr
  0x40e6f0  f32  0.5      每次迭代窗口缩小倍率

  条件: [sub_struct+0x3720] >= 0x10 (16 行) 才执行
  条件: 线性回归点数 >= 6 才接受结果  (0x40e4e5: cmp [ebp-0x6c],6)
  最大迭代次数: 5  (0x40e5eb: cmp [ebp-0x3c],5)

同步子结构偏移 (CSSTVDEM+0x1028c):
  +0x3720  int  sync_line_count       已检出同步行数
  +0x3734  int  ring_buf_total_size   ring buf 容量
  +0x3738  int  use_ring_buf          非0 = 用内嵌 ring buf; 0 = 用外部 ring buf
  +0x373c  ptr  ring_buf_ptr          内嵌 ring buf 基址
  +0x36cc  int  slant_enabled         非0 才执行斜率校正 (0x40df55 检查)
  +0x36c8  int  current_phase_offset  搜索中心(样本偏移,被 AdjustPhase 写入)
  +0x3710  int  line_phase_accumulator 逐行累积相位 (0x40e7d6 写入)

全局:
  0x4956e0 int  g_global_state  == 2 时保护锁, CorrectSlant 直接返回 (0x40df85)
  0x4956e8 f64  g_sr_double     采样率 (double, 运行时填充)
  +0x60/+0x64 in g_config (=0x4956e0+0x60)  当前 sr double (高/低32位)
"""

import math

# ── 确认的 CorrectSlant 伪代码 ──────────────────────────────────────

def CorrectSlant(this):  # eax = this
    sub  = this.sync_substruct        # lea esi,[ebx+0x1028c]
    conf = this.g_config              # esi → 0x4956e0

    # 前置检查 (0x40df55..0x40df88)
    if not (sub.slant_enabled or this.has_raw_ring_buf):
        return                        # 未启用则跳过
    if sub.sync_line_count < 16:
        return                        # 0x40df78: cmp [ecx+0x3720],0x10
    if conf.g_global_state == 2:
        return                        # 0x40df85: cmp [esi],2

    # 保存原始 sr (0x40dfdd)
    orig_sr_hi = conf.sr_hi           # [esi+0x60]
    orig_sr_lo = conf.sr_lo           # [esi+0x64]

    # 初始搜索窗口 = 0.1 × sr_int (0x40dfe9..0x40dff7)
    sr_int = int(conf.sr_double)      # ftol(fld [esi+8])
    window = int(sr_int * 0.1)        # 0x40e6c4: fmul 0.1 → ftol

    # 外层: 最多5次迭代 (0x40e5eb: cmp [ebp-0x3c],5)
    for iteration in range(5):        # 0x40dfff..0x40e5eb
        # 收集每行同步脉冲位置 → 临时 int32[] (0x40e024 alloc)
        pulse_positions = collect_sync_peaks(this, sub, conf, window)
        # 0x40e0ac: 逐样本遍历 ring buf, 对每行求峰值位置 (movsx ecx,word[ebx])

        # 线性回归累加 (0x40e1af: fld 0.0 初始化4个累加器)
        n      = 0      # [ebp-0x6c] 有效点计数
        sum_x  = 0.0    # [ebp-0x84]  Σ row_idx
        sum_y  = 0.0    # [ebp-0x8c]  Σ peak_pos
        sum_xx = 0.0    # [ebp-0x94]  Σ row_idx²
        sum_xy = 0.0    # [ebp-0x9c]  Σ row_idx × peak_pos

        for row_idx, peak in enumerate(pulse_positions):
            if row_idx < 2:          # 0x40e3c0: cmp edi,2; jl 跳过前两行
                continue
            # 有效性过滤: 与前一个点的差异不超过 window/sr 比例
            # (0x40e275..0x40e36a: 多段 fcomp 链)
            if not _peak_is_valid(peak, row_idx, conf, window):
                continue
            sum_x  += row_idx         # fild [ebp-0x64]; fadd [ebp-0x84]
            sum_y  += float(peak)     # 0x40e3d4: fadd [ebp-0x8c]
            sum_xx += row_idx ** 2    # 0x40e3f3: fadd [ebp-0x94]
            sum_xy += row_idx * peak  # 0x40e405: fadd [ebp-0x9c]
            n      += 1               # 0x40e411: inc [ebp-0x6c]

        # 回归需要至少 6 个有效点 (0x40e4e5: cmp [ebp-0x6c],6)
        if n < 6:
            break

        # 斜率 = (n×Σxy - Σx×Σy) / (n×Σxx - (Σx)²)
        # (0x40e4eb..0x40e51b)
        denom = n * sum_xx - sum_x * sum_x
        if denom == 0:
            break
        slope = (n * sum_xy - sum_x * sum_y) / denom

        # 新采样率候选 (0x40e527: fmul [esi+0x60]; fdiv [esi+8]; fadd [esi+0x60])
        new_sr = slope * conf.sr_double + conf.sr_double  # = sr × (1 + slope)

        # 偏差检查: |new_sr - orig_sr| / orig_sr in [0.125, 0.25]
        # (0x40e56e..0x40e57c, 0x40e6e8)
        delta_ratio = abs(new_sr - conf.sr_double) / conf.sr_double
        if delta_ratio > 0.25:   # 0x40e6d8: 0.25
            new_sr = conf.sr_double * (1.0 + math.copysign(0.25, slope))
        elif delta_ratio < 0.125: # 0x40e6dc: 0.125
            break                 # 偏差过小,无需修正

        # 接受修正: 更新全局 sr, 通知 CPLL (0x40e584/0x40e591: call 0x418940)
        conf.sr_double = new_sr
        notify_cpll_sr_change(conf)       # 0x418940: 更新 CPLL halfPeriodRef

        # 窗口缩小 × 0.5 (0x40e5d0: fmul [0x40e6f0]=0.5)
        window = int(window * 0.5)
        if window < 4:
            break


def _peak_is_valid(peak, row_idx, conf, window):
    """
    峰值有效性检查 (0x40e275..0x40e36a).
    使用 sr 的 0.25 / 0.125 / 3.0 / 7.0 比例进行多级判断,
    确保同步峰值相对上一行不偏移超过 window_fraction × sr.
    具体条件链较复杂(多段 fcomp),此处仅记录参数来源.
    """
    # 反汇编中的比例(确认值):
    #   ratio1=0.25 → 0x40e6d8
    #   ratio2=0.125 → 0x40e6dc
    #   ratio3=3.0   → 0x40e6e0
    #   ratio4=7.0   → 0x40e6e4
    # 具体逻辑: 5 路 fcomp 分支链,精确语义未完整确定
    return True  # 占位: 实际需按反汇编实现


def collect_sync_peaks(this, sub, conf, window):
    """
    对 ring buf 中每行采样做滑动窗口求和,
    找能量最高的位置作为该行同步脉冲峰值.
    (0x40e0ac: movsx ecx,word ptr[ebx]; add [edx+edi*4],ecx)
    返回: int[] 长度 = sync_line_count
    """
    # 未完整实现: ring buf 访问逻辑依赖 this.use_ring_buf 标志
    # 见 0x40e048..0x40e0c9
    raise NotImplementedError("ring buf 访问路径未完整逆向")
