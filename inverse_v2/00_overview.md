# SSTVENG.dll 音频处理 Pipeline 逆向文档 v2

> 目标文件: `Setup_RXSSTV\SSTVENG.dll`
> 引擎身份: MMSSTV v1.06 (C) JE3HHT 2002–2003, Delphi 编译, ImageBase=0x400000
> 工具链: capstone + pefile(无 IDA/Ghidra)静态分析
> 仅记录可从反汇编验证的内容，不猜测。

---

## 整体 Pipeline

```
waveIn (PCM 16-bit, mono)
      │
      ▼ DoJob @ RVA 0xd880  ─── 被 mmsDoJob 定时器调用
      │
      ├─► 带通滤波(ini: DEMBPF, 1000–2400 Hz)
      │        └── 未直接反汇编,参数在 SSTVENG.ini [Define]
      │
      ├─► CPLL::DemodSample @ RVA 0x1843c
      │        零过点鉴相 → 频率估计 → 环路滤波 → 输出[-16384..+16384]×16384
      │
      ├─► CLMS 自适应滤波 (ini: RXLMS=1, RXLMSAN=1)
      │        地址未定位,参数在 ini 已知,内部实现未反汇编
      │
      ├─► CFFT 频谱显示 (mmsGetSpec → [ebx+spec_buf])
      │        与解调并行,不影响像素路径
      │
      ├─► 同步检测状态机 (DoJob @ 0xd880 + 0x2509c 累积器)
      │        模式码锁定最少需要 16 样本 / 32 样本
      │
      ├─► CSSTVDEM::ReSync @ RVA 0x122b0
      │        6 阶状态机,找行同步脉冲,最小间隔 5 样本
      │
      ├─► CSSTVDEM::CorrectSlant @ RVA 0xdf28
      │        对同步脉冲序列做线性回归 → 修正采样率偏差
      │
      ├─► CSSTVDEM::AdjustPhase @ RVA 0xe6f8
      │        手动相位微调,重新渲染当前帧
      │
      └─► 像素解码 (freq→pixel, 未完整反汇编)
               频率→像素的 0.0244 系数来源未确认
```

## 已确认 RVA/VA 速查

| 函数 | RVA | VA |
|------|-----|----|
| DoJob | 0xd880 | 0x40d880 |
| CorrectSlant | 0xdf28 | 0x40df28 |
| AdjustPhase | 0xe6f8 | 0x40e6f8 |
| ReSync | 0x122b0 | 0x4122b0 |
| CPLL::DemodSample | 0x1843c | 0x41843c |
| g_engine (CSSTVDEM*) | — | 0x4956dc |
| 模式名指针表 | 0x8b420 | 0x48b420 |
| mode_idx→内部类型表 | 0x8b606 | 0x48b606 |

## 已知逆向空白(不猜测)

- CLMS 自适应滤波器地址与实现
- 带通 FIR 系数(ini 参数已知,但系数数组位置未定位)
- 像素频率→亮度精确公式(0.0244140625 系数量纲未确认)
- CFFT 瀑布图实现
- Robot/Scottie/Martin 像素段边界计算细节
