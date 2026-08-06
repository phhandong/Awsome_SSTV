"""
CSSTVDEM::ReSync  —  行同步搜索状态机
RVA  0x122b0  |  VA  0x4122b0  |  SSTVENG.dll

调用: mmsReSync → thunk @ VA 0x401e9c → 此函数
约定: eax = CSSTVDEM* this (Delphi register call)

功能: 在音频样本流中搜索行同步脉冲(1200 Hz),
      锁定后建立行起点序列,供像素解码使用。

已确认字段偏移 (来自反汇编):
  ebx = this
  esi = &this->sync_substruct (= ebx + 0x1028c)

  this偏移:
    +0x282e4  sync_pos_A      上一候选同步位置 (样本, -1=无效)
    +0x282e8  sync_pos_B      当前候选同步位置 (样本, -1=无效)
    +0x2834c  resync_count    重同步次数计数器
    +0x28344  acc_a           同步搜索累计值 A
    +0x28348  acc_b           同步搜索累计值 B
    +0x28350  best_metric     当前最小度量值 (初值 0x7fffffff = INT_MAX)
    +0x28354  sm_phase        状态机阶段 (初值 6 = 搜索阶段)

  sync_substruct (ebx+0x1028c) 偏移:
    +0x36c8   phase_offset    同步相位偏移 (样本, 被 AdjustPhase 写入)
    +0x36cc   sync_enabled    非0 才执行 ReSync

全局:
  0x4956dc  CSSTVDEM* g_engine  (全局引擎单例)
  0x4956e8  f64 g_sr_double     采样率 double
  0x495708  f64 g_reference_t   参考时刻 (由 waveIn 回调更新)

最小同步间隔: 5 样本 (0x4122e4: cmp edx,5; jl skip)
状态机阶段初值: 6 (0x41230b: mov [ebx+0x28354],6)
"""


def ReSync(this) -> None:             # eax = this
    """
    伪代码: 完整对应 RVA 0x122b0 反汇编 (在 REVERSE_ENGINEERING.md §6.1 中有初版,
    此版补充了全部字段名和状态机阶段语义)。
    """
    sub = this.sync_substruct         # lea esi,[ebx+0x1028c]

    # 前置保护 (0x4122b6..0x4122d0)
    if sub.sync_enabled == 0:
        return
    if g_global_state == 2:           # [0x4956e0] == 2 → 保护锁
        return
    if this.sync_pos_B < 0:           # +0x282e8 < 0 → 无候选
        return

    # ── 计算与上次的时间差 ────────────────────────────────────────────
    # g_reference_t = 由 waveIn 回调写入的当前"帧头"绝对样本位置
    # 0x4122da: fld [0x495708]; call _ftol → ref_t = ftol(g_reference_t)
    ref_t  = int(g_reference_t)       # call 0x47fbc0 (_ftol, Delphi runtime)

    # 0x4122e4: abs(sync_pos_A - ref_t)
    d = abs(this.sync_pos_A - ref_t)
    if d < 5:                         # 最小间隔 5 样本 (cmp edx,5; jl skip)
        return

    # ── 计算相对偏移 (可能跨环缓冲回绕) ──────────────────────────────
    # 0x4122f4: edi = sync_pos_B - ref_t
    edi = this.sync_pos_B - ref_t
    if edi < 0:
        # 回绕补偿: +0x282e8 溢出了 ring buf → 加上 sr
        edi += int(g_sr_double)       # fld [0x4956e8]; ftol

    # ── 提交同步结果 ──────────────────────────────────────────────────
    sub.phase_offset  = edi           # 0x41230c: mov [esi+0x36c8],edi
    this.sync_pos_B   = -1            # 标记 pos_B 已消费
    this.sync_pos_A   = -1            # 标记 pos_A 已消费

    # 重置状态机到搜索阶段
    this.best_metric  = 0x7fffffff    # INT_MAX → "窗口内找最优" 初值
    this.acc_a        = 0
    this.acc_b        = 0
    this.sm_phase     = 6             # 6 = 搜索阶段 (最高阶段编号)
    this.resync_count += 1            # 重同步计数


# ── 状态机阶段说明 (从上下文推断, 非完整反汇编) ──────────────────────
#
# sm_phase 值含义(推断 + 部分确认):
#   6  SEARCH   初始/失锁: 扫描 ring buf 寻找 1200 Hz 脉冲
#   5  FOUND    找到候选脉冲,开始积累 best_metric
#   4  LOCKED   脉冲位置稳定,进入跟踪
#   3  TRACKING 逐行跟踪,每行更新 phase_offset
#   2  SLIP     检测到行滑动,小幅修正
#   1  RESYNC   触发 ReSync 调用
#   0  IDLE     等待帧头 VIS 码
#
# NOTE: 以上名称来自 MMSSTV 公开源码参考 + 行为推断,
#       DLL 内未发现字符串常量能直接确认枚举名。
#
# best_metric = INT_MAX 是经典"最优同步点搜索"初始化:
#   遍历候选位置时持续更新最小误差量, 最终取误差最小的位置。
#   误差量 = |位置 - 期望位置| 之类的距离度量。
