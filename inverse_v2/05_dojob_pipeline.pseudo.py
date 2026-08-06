"""
CSSTVDEM::DoJob  —  主处理循环
RVA  0xd880  |  VA  0x40d880  |  SSTVENG.dll

调用: mmsDoJob → thunk @ VA 0x401820 → 此函数
约定: eax = CSSTVDEM* this, edx = hwnd (HWND, 可为 NULL)
     被 VB6 端 Timer 控件周期性调用 (每帧触发一次)

流程从反汇编分为 7 个阶段,已确认:
  0xd880  Stage0  初始化 / SEH 设置
  0xd898  Stage1  waveIn 数据读取 (call 0x40dae0)
  0xd8a4  Stage2  CWID/FSKID 处理 (条件: +0x15c30 != 0)
  0xd8af  Stage3  模式检测 (call 0x40984c)
  0xd8d9  Stage4  模式状态机 (条件: +0x13958, +0x282f4, +0x283e0)
  0xd97c  Stage5  CWID 字符串处理 (+0x13ac0, +0x283ec)
  0xd9b2  Stage6  图像行解码 / 通知 (+0x283ec, +0x283f0)
  0xda4d  Stage7  显示更新 (+0x495aac)

已确认字段偏移:
  this 偏移:
    +0x282f4  int   mode_code       当前模式状态码 (0=未知)
    +0x282f8  int   mode_phase      模式检测相位字节
                     bit0=1: 模式候选 A 已锁
                     bit1=2: 模式候选 B 已锁 (两者都锁 → 可调 40eed4)
                     value=3: 双锁,准备提交
    +0x2509c  int   stable_count    连续稳定样本计数 (模式锁定用)
    +0x13958  int   engine_active   非0 = 引擎已启动 (mmsStart 后置1)
    +0x283e0  int   delay_counter   延迟计数器 (-1=立即触发, 0=到期, >0=倒数)
    +0x283f4  int   status_flags    状态位图 (bit0=phase_adj, bit6=cwid_rcvd)
    +0x15c30  int   cwid_active     CWID 解码是否激活
    +0x13ac0  int   new_mode_flag   新模式触发标志 (DoJob 读后清零)
    +0x283ec  ptr   cwid_string_ptr CWID 字符串指针 (NULL=无)
    +0x283f0  ptr/str cwid_override  CWID 覆盖字符串 (NULL→用 VA 0x488cf2 默认)

  全局:
    0x495aac  int  g_display_hwnd_flag  非0 → 有窗口需要刷新
    0x495a6c  int  g_afc_enabled        AFC 使能标志
    0x495a68, 0x495a70, 0x495a74, 0x495a84 — 其他使能标志
"""


def DoJob(this, hwnd) -> None:         # eax=this, edx=hwnd

    # ── Stage 1: 读入新音频数据 ───────────────────────────────────────
    # 0xd898: call 0x40dae0
    # 从 waveIn 环形缓冲读取新 PCM 数据, 写入 this->ring_buf (+0x283c4)
    read_waveIn_samples(this)          # 内部调用 CPLL::DemodSample 逐样本处理

    # ── Stage 2: CWID/FSKID 处理 ─────────────────────────────────────
    # 0xd8a4: cmp [ebx+0x15c30],0; je skip
    if this.cwid_active:
        process_cwid_fskid(this)       # call 0x4106bc (CEXTFSK 类)

    # ── Stage 3: 模式检测 ────────────────────────────────────────────
    # 0xd8af: call 0x40984c → 返回 0 = 还在检测, 非0 = 已完成
    mode_done = detect_mode(this)      # 分析 ring buf 中的 VIS 码

    if mode_done:
        # 跳过模式状态机 (0xd8b6: test eax,eax; jne → 0xda97)
        pass
    else:
        # ── Stage 4: 模式状态机 ──────────────────────────────────────
        # 条件 1: 引擎已激活 + 有模式码 + 无延迟 + 全局状态!=2
        # 0xd8c7: cmp [ebx+0x13958],0  cmp [ebx+0x282f4],0  cmp [ebx+0x283e0],0
        # 0xd8e2: cmp [0x4956e0],2
        if (this.engine_active and this.mode_code and
                this.delay_counter == 0 and g_global_state != 2):

            # 双路模式锁定逻辑 (0xd8f4..0xd93b)
            if this.mode_code == 2 and not (this.mode_phase & 0x02):
                # 候选 B 路径: 需要 stable_count >= 32 (0xd904: cmp 0x20)
                if this.stable_count >= 0x20:
                    this.mode_phase = 3    # 双锁
                    trigger_mode_commit(this, 0)   # call 0x40eed4(this, edx=0)
            elif not (this.mode_phase & 0x01):
                # 候选 A 路径: 需要 stable_count >= 16 (0xd924: cmp 0x10)
                if this.stable_count >= 0x10:
                    this.mode_phase = 1    # 单锁 A
                    trigger_mode_commit(this, 0)   # call 0x40eed4(this, edx=0)

        # 延迟计数器处理 (0xd940..0xd97c)
        if this.delay_counter != 0:
            if this.delay_counter < 0:
                this.delay_counter = 0
                trigger_mode_commit(this, 0)
            else:
                this.delay_counter -= 1
                if this.delay_counter == 0:
                    trigger_mode_commit(this, 1)

    # ── Stage 5: 新模式标志 ──────────────────────────────────────────
    # 0xd97c: cmp [ebx+0x13ac0],0
    if this.new_mode_flag:
        this.new_mode_flag = 0
        # 如果引擎活跃且 AFC 使能
        if this.engine_active and g_afc_enabled:  # [0x495a6c]
            # 0xd9a6: call 0x41119c (AFC 初始化)
            init_afc(this, mode=1)
        this.status_flags |= 0x10     # or [ebx+0x283f4],0x10 (0xd9ab)

    # ── Stage 6: CWID 字符串解析 ──────────────────────────────────────
    # 0xd9b2: cmp [ebx+0x283ec],0 → CWID 字符串是否到来
    if this.cwid_string_ptr:
        # 比对 CWID 字符串 (call 0x424f08 memcpy 0xc8 字节)
        # 比较 override_str vs default (0x488cf2)
        override = this.cwid_override or default_cwid_str  # VA 0x488cf2
        if compare_cwid(this.cwid_string_ptr, override, 0xc8):  # 200 bytes
            # 匹配成功: 提取 FSK ID (0xda03..0xda40)
            fsk_id_len = this.cwid_string_ptr[0x288]    # +0x288 = 长度
            extract_fskid(this.cwid_string_ptr + 0x28c, this.cwid_override)
            this.status_flags |= 0x40   # bit6: CWID received (0xda40)

    # ── Stage 7: 显示更新 ───────────────────────────────────────────
    # 0xda4d: cmp [0x495aac],0  → 有注册窗口才刷新
    if g_display_hwnd_flag:
        refresh_display_window(this)  # PostMessage + DIB 刷新(未深入反汇编)
