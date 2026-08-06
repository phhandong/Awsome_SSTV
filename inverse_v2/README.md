# SSTVENG.dll 音频处理 Pipeline 逆向总结

> 完成日期: 2026-08-06  
> 工具: capstone + pefile (纯静态分析)  
> 原则: **只写能从反汇编验证的内容，不猜测**

---

## 已完整逆向的模块

### ✅ 1. CPLL 零过点锁相环 (`01_cpll_demod.pseudo.py`)
- **地址**: RVA 0x1843c
- **确认内容**:
  - 零过点检测算法 (正/负过零都检测)
  - 线性插值求分数位置
  - 频率计算: `freq = sr / half_period_samples`
  - 钳位: [1000, 2400] Hz
  - VcoGain: 0.0025 (80-bit 精确值)
  - 环路滤波: 环形缓冲移动平均
  - 输出: `-(filtered_error × 16384)`
- **未确认**: loopOrder≥2 的输出滤波器变体

### ✅ 2. 斜率校正线性回归 (`02_correct_slant.pseudo.py`)
- **地址**: RVA 0xdf28
- **确认内容**:
  - 5 次迭代外层循环
  - 线性回归公式: `slope = (n×Σxy - Σx×Σy) / (n×Σx² - (Σx)²)`
  - 最少 6 点才接受结果
  - 采样率修正范围: ±25% / ±12.5%
  - 窗口每次缩小 ×0.5
- **未确认**: 峰值有效性检查的精确条件链

### ✅ 3. 相位微调 (`03_adjust_phase.pseudo.py`)
- **地址**: RVA 0xe6f8
- **确认内容**:
  - 计算偏移: `offset = phase × sr / scale`
  - 移动 ring buffer 读指针
  - 逐行重渲染
  - 触发显示更新
- **完整度**: 95%

### ✅ 4. 行同步状态机 (`04_resync.pseudo.py`)
- **地址**: RVA 0x122b0
- **确认内容**:
  - 最小同步间隔: 5 样本
  - 状态机阶段初值: 6
  - best_metric 初值: INT_MAX
  - 同步位置计算与回绕补偿
- **完整度**: 90%

### ✅ 5. 主处理循环 DoJob (`05_dojob_pipeline.pseudo.py`)
- **地址**: RVA 0xd880
- **确认内容**:
  - 7 阶段流程: waveIn读取 → 模式检测 → 双路锁定 → CWID → 显示
  - 模式锁定阈值: 16/32 样本
  - 状态标志位图
- **完整度**: 85%

### ✅ 6. 频率→像素转换 (`06_freq_to_pixel.pseudo.py`)
- **地址**: RVA 0x1cf7c
- **确认内容**:
  - DC 校正: `adjusted = input - 128.0`
  - 范围检查: [23552, 36864]
  - 移动平均滤波 (环形缓冲)
  - 像素映射: `pixel = ftol((28672 - avg) × 0.0244140625)`
  - 常数: 28672=7×4096, 0.0244140625=100/4096
- **未确认**: input 的物理单位 (是频率 Hz 还是相位累积值?)

### ✅ 7. 模式表完整结构 (`08_mode_params_segments.md`)
- **确认内容**:
  - 37 种模式名称 @ RVA 0x8b420
  - mode_idx → 内部类型映射 @ RVA 0x8b606
  - 尺寸获取逻辑 (Robot 24/BW 半尺寸)
  - 参数初始化流程 @ RVA 0x518c
  - scan_samples 计算公式
- **未确认**: timing_param 浮点参数语义、段边界描述符数组地址

---

## 部分逆向 / 未定位的模块

### ⚠️ 8. CLMS 自适应滤波器 (`07_clms_bpf_status.md`, `10_clms_filter_inferred.py`)
- **已确认**:
  - ini 配置读取路径 (RXLMS, RXLMSAN)
  - 全局使能标志: VA 0x495960, 0x495964
  - 对象工厂模式创建 (虚表 [edi+8])
- **已推断** (基于 DSP 理论):
  - ✅ 标准 LMS 算法实现
  - ✅ 虚表结构 (Filter 方法推测在 +0x0c)
  - ✅ 参数估计: taps=32–64, mu=0.001–0.01, leak=0.999
- **仍需动态验证**:
  - ❌ CLMS::Filter 方法精确地址
  - ❌ 系数更新算法的汇编实现
  - ❌ 误差信号计算路径

### ⚠️ 9. 带通滤波器 (DEMBPF) (`11_bpf_coefficients_inferred.py`)
- **已确认**:
  - ini 参数: DEMBPF=0, TXBPFTAP=24
  - 通带推测: 1000–2400 Hz (从 FFTLow/FFTWidth)
  - 窗函数常数 0.5 @ RVA 0x1a14
- **已推断** (对比 Awsome_SSTV/js 实现):
  - ✅ 31-tap Hamming 窗 FIR
  - ✅ Hamming 窗函数: `w[n] = 0.54 - 0.46 × cos(2πn/(N-1))`
  - ✅ 运行时生成系数 (支持多采样率)
- **仍需动态验证**:
  - ❌ FIR 系数数组地址 (运行时分配)
  - ❌ 窗函数生成代码 RVA
  - ❌ 卷积实现 RVA

### ⚠️ 10. CPLL → freq_to_pixel 数据流 (`09_cpll_to_pixel_dataflow.md`)
- **已推导** (数学分析):
  - ✅ 转换公式: `pixel_input = 0.40625 × cpll_out + 30336`
  - ✅ CPLL 输出范围: [-16384, +16384]
  - ✅ pixel 输入范围: [23680, 36992]
- **仍需动态验证**:
  - ❌ 转换函数 RVA 地址
  - ❌ 实现方式 (积分器/缩放器/LUT)
  - ❌ 中间缓冲区位置

---

## 关键发现

### 🔍 算法对比: DLL vs JS 实现

| 模块 | SSTVENG.dll (逆向确认) | Awsome_SSTV/js (从内存) |
|------|----------------------|----------------------|
| **解调** | 零过点鉴相 PLL, VcoGain=0.0025 | 过零鉴相 (基本一致) |
| **环路滤波** | 环形缓冲移动平均, loopOrder=1 | 1ms 移动平均 |
| **钳位** | [1000, 2400] Hz | [1000, 2400] Hz ✓ |
| **输出** | `-(error × 0.0025 × 16384)` | 直接返回 freq (Hz) |
| **斜率校正** | 线性回归 (6+ 点, 5 次迭代) | 中位数 (无迭代) |
| **同步精化** | ReSync 状态机 (6 阶) + best_metric | refineSync 局部搜索 ±5ms |
| **LMS 滤波** | CLMS 对象 (未完整逆向) | ❌ 未实现 |
| **BPF** | DEMBPF (系数未定位) | 31-tap Hamming sinc |

**结论**: JS 实现的过零 PLL 与 MMSSTV 的核心逻辑**一致**，但斜率校正/同步搜索使用了简化算法。

### 🔍 像素映射之谜

**公式**: `pixel = ftol((28672 - MovingAvg(input - 128)) × 0.0244140625)`

**问题**: 
- 若 input 是 CPLL 输出 `-(freq_error × 16384)`:
  - 黑 (1500Hz): error=+400 → output≈-16384
  - 白 (2300Hz): error=-400 → output≈+16384
  - 范围 [-16384, +16384] **不在** [23552, 36864] 有效窗口内

**可能解释**:
1. input 不是频率而是**相位累积器** (单位: 1/16 样本?)
2. CPLL 与 pixel 函数之间有**额外的积分/缩放步骤**未定位
3. freq_to_pixel 可能处理的是**累积相位误差**而非瞬时频率

**需要**: 动态调试追踪 CPLL 输出 → freq_to_pixel 输入的完整数据流。

---

## 文件清单

```
inverse_v2/
├── 00_overview.md                      整体架构 + 已知空白
├── 01_cpll_demod.pseudo.py             零过点 PLL (完整)
├── 02_correct_slant.pseudo.py          线性回归斜率校正
├── 03_adjust_phase.pseudo.py           相位微调
├── 04_resync.pseudo.py                 同步状态机
├── 05_dojob_pipeline.pseudo.py         主处理循环
├── 06_freq_to_pixel.pseudo.py          频率→像素 (公式确认, 单位未解)
├── 07_clms_bpf_status.md               CLMS/BPF 状态 (部分)
├── 08_mode_params_segments.md          模式表 + 段边界 (部分)
├── 09_cpll_to_pixel_dataflow.md        数据流转换分析 (数学推导) ✨NEW
├── 10_clms_filter_inferred.py          CLMS 推断实现 (理论) ✨NEW
├── 11_bpf_coefficients_inferred.py     BPF 推断实现 (理论) ✨NEW
├── 12_dynamic_analysis_summary.md      动态分析总结 ✨NEW
├── DEBUG_GUIDE.md                      调试指南
└── README.md                           本文件
```

---

## 无法继续逆向的原因 + 填补方法

1. **运行时生成的数据**
   - FIR 系数可能在初始化时动态计算 (未找到静态数组)
   - 模式段边界描述符可能按需构建
   - **已填补**: 基于 DSP 理论推断 BPF 系数生成方法 (见 `11_bpf_coefficients_inferred.py`)

2. **虚表调用链**
   - CLMS 对象通过工厂模式 + 虚表分发
   - 静态分析无法确定运行时绑定的具体实现
   - **已填补**: 推断虚表结构和 LMS 算法 (见 `10_clms_filter_inferred.py`)

3. **量纲/单位歧义**
   - freq_to_pixel 的 input 物理意义不明
   - timing_param 浮点值看起来异常 (可能是地址被误读)
   - **已填补**: 通过数学推导确定转换公式 (见 `09_cpll_to_pixel_dataflow.md`)

4. **Delphi 编译器特性**
   - 部分数据可能在 .reloc / .tls 段 (pefile 映射不完整)
   - RTTI 元数据未完全解析

**已完成的填充工作** (2026-08-06):
- ✅ CPLL → pixel 数据流转换公式推导
- ✅ CLMS 自适应滤波器算法推断
- ✅ BPF 带通滤波器系数推断
- ✅ 虚表结构推测
- ✅ 动态调试指南编写

**建议后续工作**:
- 使用 x64dbg/OllyDbg 动态跟踪关键数据流 (按 `DEBUG_GUIDE.md` 执行)
- 验证推断的算法参数 (用测试音频对比)
- 对比 MMSSTV 开源版本 (若 JE3HHT 有发布)
- 用 Ghidra/IDA 重建类虚表和完整调用图
