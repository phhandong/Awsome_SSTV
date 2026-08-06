# SSTVENG.dll 动态调试指南

> 目标: 追踪 CPLL 输出 → freq_to_pixel 输入的数据流  
> 定位 CLMS 滤波器实现和 FIR 系数数组

---

## 工具准备

### 推荐调试器

**x64dbg** (首选，免费开源)
- 下载: https://x64dbg.com/
- 优点: 
  - 现代 UI，支持 32/64 位
  - 内置脚本引擎
  - 插件丰富 (ScyllaHide 反调试)
  - 支持数据断点 (硬件断点)

**OllyDbg 2.01** (备选)
- 下载: http://www.ollydbg.de/
- 优点: 经典稳定，插件成熟
- 缺点: 仅支持 32 位

**Ghidra** (静态+动态结合)
- 下载: https://ghidra-sre.org/
- 用途: 
  1. 先用 Ghidra 静态分析生成函数签名
  2. 导出符号表给 x64dbg 使用
  3. 动态调试时对照 Ghidra 的反编译结果

---

## 调试环境搭建

### 1. 准备测试音频
```bash
# 使用现有的 ROBOT36_test.mp3 或生成标准测试音
cd "C:/Users/THINKPAD/Radio/Awsome_SSTV"
node dump_result.js  # 生成参考解码图

# 或生成纯音测试信号 (1500Hz 黑, 2300Hz 白)
python << 'SCRIPT'
import numpy as np, wave
sr = 11025
duration = 2.0
t = np.linspace(0, duration, int(sr*duration))
# 1秒1500Hz (黑) + 1秒2300Hz (白)
sig = np.concatenate([
    np.sin(2*np.pi*1500*t[:sr]),
    np.sin(2*np.pi*2300*t[:sr])
])
sig_int16 = (sig * 32767).astype(np.int16)
with wave.open('test_tone.wav', 'w') as f:
    f.setnchannels(1); f.setsampwidth(2); f.setframerate(sr)
    f.writeframes(sig_int16.tobytes())
SCRIPT
```

### 2. 启动 RXSSTV.exe 并附加调试器

**方法 A: 从调试器启动**
```
x64dbg → File → Open → RXSSTV.exe
命令行参数: (无)
工作目录: C:\Users\THINKPAD\Radio\Setup_RXSSTV
```

**方法 B: 附加到运行中的进程**
```
1. 手动启动 RXSSTV.exe
2. x64dbg → File → Attach
3. 选择 RXSSTV.exe 进程
```

### 3. 加载符号 (可选但推荐)

x64dbg 命令窗口:
```
loadlib SSTVENG.dll         # 强制加载 DLL
symload SSTVENG.dll         # 尝试加载符号
```

手动标注关键地址:
```
label 0x41843c "CPLL_DemodSample"
label 0x41cf7c "freq_to_pixel"
label 0x40df28 "CorrectSlant"
label 0x4122b0 "ReSync"
label 0x40d880 "DoJob"
```

---

## 调试任务 1: 追踪 CPLL → freq_to_pixel 数据流

### 目标: 确认 freq_to_pixel 的 input 参数来源

#### Step 1: 在 CPLL 输出处下断点
```
SSTVENG.dll 基址: 通常 0x10000000 (动态加载) 或 0x400000 (静态)
实际地址 = 基址 + RVA

bp SSTVENG.dll+0x186b7      # CPLL 返回前 (fchs 后, ret 前)
```

断点命中时:
- 查看 FPU 栈 ST0 (即将返回的值)
- 记录连续 10 次调用的返回值范围

x64dbg 脚本 (自动记录):
```python
# Script: log_cpll_output.txt
bp SSTVENG.dll+0x186b7
cond "1"  # 总是触发
log "[CPLL] ST0 = {st0}"
run
```

#### Step 2: 在 freq_to_pixel 入口处下断点
```
bp SSTVENG.dll+0x1cf7c      # freq_to_pixel 入口

断点命中时查看:
  - ebx (this 指针)
  - [ebp+0xc]/[ebp+0x10] (double 参数低/高位)
```

x64dbg 观察窗口添加:
```
[ebp+C]:8     # 查看 double 参数
ebx+3794      # sample_counter
ebx+3798      # current_value
```

#### Step 3: 追踪调用栈
```
当 freq_to_pixel 断点命中时:
  1. 按 Ctrl+K 查看调用栈
  2. 返回地址应指向调用者 (DoJob 或其他)
  3. 在调用点设置条件断点:
     cond "[ebp+C] != 0"  # 只在参数非零时中断
```

**预期结果**:
- 若 input ∈ [-20000, +20000] → 可能是 CPLL 直接输出
- 若 input ∈ [23000, 37000] → 中间有加法偏移 (猜测 +28672?)
- 若 input 是巨大整数 → 可能是相位累积器

---

## 调试任务 2: 定位 CLMS::Filter 实现

### 目标: 找到 CLMS 对象的虚表和 Filter 方法地址

#### Step 1: 在 CLMS 创建点下断点
```
# RXLMSAN 配置读取后的工厂调用 (RVA 0x1429f)
bp SSTVENG.dll+0x1429f      # call [edi+8]

断点命中时:
  1. 查看 edi (应指向某个工厂对象)
  2. dump [edi] (查看虚表前 16 字节)
  3. 单步进入 (F7) 到工厂方法内部
```

#### Step 2: 追踪返回的对象
```
工厂方法返回后 (0x142a2: mov [0x495960], eax):
  1. 查看 eax (CLMS 对象指针)
  2. dump [eax] (虚表指针)
  3. 跟随虚表:
     dump dword:[eax]  # 虚表基址
     dump [[eax]]      # 虚表前 16 个函数指针
```

#### Step 3: 在可能的 Filter 调用点下断点
```
# 搜索对 CLMS 对象的方法调用
在 DoJob 或 DemodSample 附近搜索:
  mov eax, [0x495960]   # 加载 CLMS 对象
  mov edx, [eax]        # 加载虚表
  call [edx+X]          # 虚函数调用

可能的偏移:
  +0x00  构造函数
  +0x04  析构函数
  +0x08  工厂方法 (已确认)
  +0x0c  Filter 方法? (猜测)
  +0x10  Update 方法? (猜测)
```

**技巧**: 使用条件记录断点
```
bp SSTVENG.dll+0xXXXX
cond "1"
log "[CLMS call] eax={eax} [eax]={[eax]:x} call_target={[[eax]+C]:x}"
run
```

---

## 调试任务 3: 定位 FIR 系数数组

### 目标: 找到带通滤波器系数的运行时地址

#### Step 1: 在 DEMBPF 初始化处下断点
```
bp SSTVENG.dll+0x13389      # DEMBPF 配置读取

断点命中后单步执行 (F8) 到:
  - call 0x4868f0 (TIniFile::ReadInteger)
  - 返回值在 eax (0 或 1)
  - 若 eax=1, 继续单步找 FIR 初始化代码
```

#### Step 2: 搜索 memset/memcpy 调用
```
FIR 系数初始化通常是:
  1. 分配缓冲区 (malloc/GetMem)
  2. 循环写入系数 (for i=0..N)
  3. 或 memcpy 从常量表

在 DEMBPF=1 分支中查找:
  - call malloc / call GetMem
  - 返回的指针 (eax) 即系数数组基址
  - dump eax:128  # 查看前 32 个 float32
```

#### Step 3: 硬件数据断点 (推荐)
```
假设找到系数数组基址 0x12345678:

# 在第一个系数写入时中断
bphws 0x12345678, w, 4   # 写入断点, 4 字节

断点命中时查看调用栈 → 定位生成代码
```

**验证系数合理性**:
```python
# x64dbg Python 脚本
import struct
base = 0x12345678  # 替换为实际地址
coeffs = []
for i in range(31):
    val = struct.unpack('<f', DbgMemRead(base+i*4, 4))[0]
    coeffs.append(val)
print('FIR taps:', coeffs)
print('Sum:', sum(coeffs))         # 低通应≈1.0
print('Symmetric:', coeffs == coeffs[::-1])
```

---

## 调试任务 4: 验证像素映射公式

### 目标: 用实际数据验证 `28672 - avg` 公式

#### Step 1: 录制 freq_to_pixel 的输入输出
```
bp SSTVENG.dll+0x1cf7c      # 入口
bp SSTVENG.dll+0x1d0fb      # 存储像素前 (call 0x41b4d0)

脚本:
```
```python
# 入口断点
log "[IN] input={[ebp+C]:f64} sample={ebx+3794}"

# 输出断点
log "[OUT] pixel={eax:d} smoothed={ebx+37a0:f64} raw={ebx+37a8:f64}"
```

#### Step 2: 导出日志分析
```
录制一段 1500Hz→2300Hz 的测试音
导出日志到 pixel_trace.txt
Python 分析:
```
```python
import re, numpy as np
with open('pixel_trace.txt') as f:
    data = f.readlines()
inputs = [float(re.search(r'input=([\d.e+-]+)', line).group(1)) 
          for line in data if 'IN' in line]
pixels = [int(re.search(r'pixel=(\d+)', line).group(1)) 
          for line in data if 'OUT' in line]

print('Input range:', min(inputs), max(inputs))
print('Pixel range:', min(pixels), max(pixels))
print('Input→Pixel correlation:', np.corrcoef(inputs[:100], pixels[:100]))
```

---

## 常见问题排查

### 问题 1: 断点不命中
**原因**: DLL 基址不是 0x400000
**解决**:
```
1. x64dbg → Symbols 标签查看 SSTVENG.dll 实际基址
2. 计算实际地址: base + RVA
   例: base=0x10000000, RVA=0x1843c → 0x1001843c
```

### 问题 2: 无法查看浮点数
**解决**:
```
# FPU 栈查看
View → FPU

# 内存浮点查看
dump 地址:8
右键 → Display as → Float (32-bit)
```

### 问题 3: VB6 外壳干扰
**解决**:
```
# 跳过 VB6 运行时, 直接断到 DLL
bp mmsCreate   # DLL 初始化入口
run
# 然后设置内部断点
```

---

## 输出成果

完成调试后，更新以下文档:

1. **06_freq_to_pixel.pseudo.py** 
   - 补充 input 的物理单位和数值范围
   - 确认 CPLL 输出与 pixel 输入的转换关系

2. **07_clms_bpf_status.md**
   - 补充 CLMS::Filter 方法地址
   - 记录 FIR 系数数组地址和实际值

3. **新建: 09_dynamic_trace.md**
   - 记录关键数据流的实测值
   - 附带调试日志片段作为证据

---

## 进阶: 使用 Frida 动态插桩

若需要批量追踪或自动化:

```javascript
// frida_cpll.js - 追踪 CPLL 输出
var baseAddr = Module.findBaseAddress("SSTVENG.dll");
var cpllRet = baseAddr.add(0x186b7);

Interceptor.attach(cpllRet, {
  onEnter: function(args) {
    // FPU ST0 需通过汇编读取
    var ctx = this.context;
    console.log("[CPLL] about to return");
  }
});
```

运行:
```bash
frida -l frida_cpll.js RXSSTV.exe
```
