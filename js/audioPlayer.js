// audioPlayer.js — 交互式音频播放器，支持选择起始和结束位置

export class AudioPlayer {
  constructor(containerId, options = {}) {
    console.log('AudioPlayer 初始化:', containerId);

    this.container = document.getElementById(containerId);
    this.waveformCanvas = document.getElementById('audioWaveform');
    this.playPauseBtn = document.getElementById('audioPlayPauseBtn');
    this.playhead = document.getElementById('audioPlayhead');
    this.selection = document.getElementById('audioSelection');
    this.currentTimeEl = document.getElementById('audioCurrentTime');
    this.durationEl = document.getElementById('audioDuration');
    this.selectionStartEl = document.getElementById('audioSelectionStart');
    this.selectionEndEl = document.getElementById('audioSelectionEnd');
    this.resetBtn = document.getElementById('resetSelectionBtn');

    // 检查所有元素是否存在
    if (!this.container || !this.waveformCanvas || !this.playPauseBtn) {
      console.error('AudioPlayer 初始化失败: 缺少必需的 DOM 元素');
      console.log('container:', this.container);
      console.log('waveformCanvas:', this.waveformCanvas);
      console.log('playPauseBtn:', this.playPauseBtn);
      return;
    }

    this.audioContext = null;
    this.audioBuffer = null;
    this.sourceNode = null;
    this.samples = null;
    this.sampleRate = 0;
    this.duration = 0;
    this.isPlaying = false;
    this.startTime = 0;
    this.pauseTime = 0;

    // 选区范围 (0-1)
    this.selectionStart = 0;
    this.selectionEnd = 1;

    // 拖动状态
    this.isDragging = false;
    this.dragType = null; // 'start', 'end', 'move'
    this.dragStartX = 0;
    this.dragStartLeft = 0;
    this.dragStartRight = 0;

    this.onSelectionChange = options.onSelectionChange || (() => {});

    this.init();
    console.log('AudioPlayer 初始化完成');
  }

  init() {
    // 播放控制
    this.playPauseBtn.addEventListener('click', () => this.togglePlayPause());

    // 时间轴交互（点击和拖动播放头）
    this.setupTimelineInteraction();

    // 选区拖动
    this.setupSelectionDrag();

    // 重置选区
    this.resetBtn.addEventListener('click', () => this.resetSelection());

    // 更新循环
    this.updateLoop();
  }

  setupTimelineInteraction() {
    let isDraggingPlayhead = false;

    // 点击或拖动时间轴
    this.waveformCanvas.addEventListener('mousedown', (e) => {
      // 不干扰选区拖动
      if (this.isDragging) return;

      isDraggingPlayhead = true;
      this.updatePlayheadFromMouse(e);
    });

    document.addEventListener('mousemove', (e) => {
      if (isDraggingPlayhead && !this.isDragging) {
        this.updatePlayheadFromMouse(e);
      }
    });

    document.addEventListener('mouseup', () => {
      isDraggingPlayhead = false;
    });
  }

  updatePlayheadFromMouse(e) {
    const rect = this.waveformCanvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const ratio = Math.max(0, Math.min(1, x / rect.width));
    const time = ratio * this.duration;
    this.seek(time);
  }

  async loadAudio(samples, sampleRate) {
    this.samples = samples;
    this.sampleRate = sampleRate;
    this.duration = samples.length / sampleRate;

    // 创建音频上下文
    if (!this.audioContext) {
      this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }

    // 创建音频缓冲区
    this.audioBuffer = this.audioContext.createBuffer(1, samples.length, sampleRate);
    this.audioBuffer.copyToChannel(samples, 0);

    // 绘制波形
    this.drawWaveform();

    // 更新时长显示
    this.durationEl.textContent = this.formatTime(this.duration);

    // 重置选区
    this.resetSelection();

    // 显示播放器
    this.container.hidden = false;

    // 立即触发选区更新回调
    this.onSelectionChange(this.getSelectionTime());
  }

  drawWaveform() {
    const canvas = this.waveformCanvas;
    const ctx = canvas.getContext('2d', { alpha: true });
    const w = canvas.width = canvas.clientWidth;
    const h = canvas.height = canvas.clientHeight || 140;

    // 清除画布（透明）
    ctx.clearRect(0, 0, w, h);

    // 绘制半透明波形
    ctx.strokeStyle = 'rgba(79, 209, 197, 0.6)';
    ctx.lineWidth = 1.5;
    ctx.lineCap = 'round';

    ctx.beginPath();
    const step = Math.max(1, Math.floor(this.samples.length / w));

    for (let x = 0; x < w; x++) {
      let max = 0;
      const startIdx = x * step;
      const endIdx = Math.min(startIdx + step, this.samples.length);

      for (let i = startIdx; i < endIdx; i++) {
        const v = Math.abs(this.samples[i] || 0);
        if (v > max) max = v;
      }

      const y = h / 2 - max * h / 2;
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // 绘制中心线
    ctx.strokeStyle = 'rgba(79, 209, 197, 0.2)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, h / 2);
    ctx.lineTo(w, h / 2);
    ctx.stroke();
  }

  handleTimelineClick(e) {
    if (this.isDragging) return;

    const rect = this.waveformCanvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const ratio = Math.max(0, Math.min(1, x / rect.width));
    const time = ratio * this.duration;

    // 如果点击在选区内，则移动播放位置；否则也移动播放位置
    this.seek(time);
  }

  setupSelectionDrag() {
    const handles = this.selection.querySelectorAll('.audio-selection-handle');

    handles.forEach(handle => {
      handle.addEventListener('mousedown', (e) => {
        e.stopPropagation();
        this.isDragging = true;
        this.dragType = handle.dataset.handle;
        this.dragStartX = e.clientX;
        this.dragStartLeft = this.selectionStart;
        this.dragStartRight = this.selectionEnd;
        document.body.style.cursor = 'ew-resize';
      });
    });

    // 选区移动
    this.selection.addEventListener('mousedown', (e) => {
      if (e.target.classList.contains('audio-selection-handle')) return;
      e.stopPropagation();
      this.isDragging = true;
      this.dragType = 'move';
      this.dragStartX = e.clientX;
      this.dragStartLeft = this.selectionStart;
      this.dragStartRight = this.selectionEnd;
      document.body.style.cursor = 'move';
    });

    document.addEventListener('mousemove', (e) => {
      if (!this.isDragging) return;

      const rect = this.waveformCanvas.getBoundingClientRect();
      const delta = (e.clientX - this.dragStartX) / rect.width;

      if (this.dragType === 'start') {
        this.selectionStart = Math.max(0, Math.min(this.dragStartRight - 0.01, this.dragStartLeft + delta));
      } else if (this.dragType === 'end') {
        this.selectionEnd = Math.max(this.dragStartLeft + 0.01, Math.min(1, this.dragStartRight + delta));
      } else if (this.dragType === 'move') {
        const width = this.dragStartRight - this.dragStartLeft;
        let newStart = this.dragStartLeft + delta;
        let newEnd = this.dragStartRight + delta;

        if (newStart < 0) {
          newStart = 0;
          newEnd = width;
        } else if (newEnd > 1) {
          newEnd = 1;
          newStart = 1 - width;
        }

        this.selectionStart = newStart;
        this.selectionEnd = newEnd;
      }

      this.updateSelection();
    });

    document.addEventListener('mouseup', () => {
      if (this.isDragging) {
        this.isDragging = false;
        this.dragType = null;
        document.body.style.cursor = '';
        this.onSelectionChange(this.getSelectionTime());
      }
    });
  }

  updateSelection() {
    const left = this.selectionStart * 100;
    const width = (this.selectionEnd - this.selectionStart) * 100;

    this.selection.style.left = left + '%';
    this.selection.style.width = width + '%';

    this.selectionStartEl.textContent = (this.selectionStart * this.duration).toFixed(1);
    this.selectionEndEl.textContent = (this.selectionEnd * this.duration).toFixed(1);
  }

  resetSelection() {
    this.selectionStart = 0;
    this.selectionEnd = 1;
    this.updateSelection();
    this.onSelectionChange(this.getSelectionTime());
  }

  getSelectionTime() {
    return {
      start: this.selectionStart * this.duration,
      end: this.selectionEnd * this.duration,
      duration: (this.selectionEnd - this.selectionStart) * this.duration
    };
  }

  async togglePlayPause() {
    if (this.isPlaying) {
      this.pause();
    } else {
      await this.play();
    }
  }

  async play() {
    if (!this.audioBuffer) return;

    // 恢复音频上下文
    if (this.audioContext.state === 'suspended') {
      await this.audioContext.resume();
    }

    // 停止之前的播放
    if (this.sourceNode) {
      this.sourceNode.stop();
    }

    // 创建新的源节点
    this.sourceNode = this.audioContext.createBufferSource();
    this.sourceNode.buffer = this.audioBuffer;
    this.sourceNode.connect(this.audioContext.destination);

    // 从选区开始播放
    const startTime = this.pauseTime || (this.selectionStart * this.duration);
    const duration = (this.selectionEnd * this.duration) - startTime;

    this.sourceNode.start(0, startTime, duration);
    this.startTime = this.audioContext.currentTime - startTime;
    this.isPlaying = true;
    this.playPauseBtn.textContent = '⏸';

    // 播放结束
    this.sourceNode.onended = () => {
      if (this.isPlaying) {
        this.stop();
      }
    };
  }

  pause() {
    if (this.sourceNode && this.isPlaying) {
      this.pauseTime = this.audioContext.currentTime - this.startTime;
      this.sourceNode.stop();
      this.isPlaying = false;
      this.playPauseBtn.textContent = '▶';
    }
  }

  stop() {
    if (this.sourceNode) {
      try {
        this.sourceNode.stop();
      } catch (e) {
        // 已经停止
      }
      this.sourceNode = null;
    }
    this.isPlaying = false;
    this.pauseTime = 0;
    this.playPauseBtn.textContent = '▶';
  }

  seek(time) {
    const wasPlaying = this.isPlaying;
    if (wasPlaying) {
      this.pause();
    }
    this.pauseTime = Math.max(this.selectionStart * this.duration, Math.min(this.selectionEnd * this.duration, time));
    if (wasPlaying) {
      this.play();
    }
  }

  updateLoop() {
    requestAnimationFrame(() => this.updateLoop());

    if (this.isPlaying && this.audioContext) {
      const currentTime = this.audioContext.currentTime - this.startTime;
      const progress = currentTime / this.duration;

      // 更新播放头
      this.playhead.style.left = (progress * 100) + '%';

      // 更新时间显示
      this.currentTimeEl.textContent = this.formatTime(currentTime);

      // 检查是否超出选区
      if (currentTime >= this.selectionEnd * this.duration) {
        this.stop();
      }
    } else if (!this.isPlaying && this.pauseTime) {
      const progress = this.pauseTime / this.duration;
      this.playhead.style.left = (progress * 100) + '%';
      this.currentTimeEl.textContent = this.formatTime(this.pauseTime);
    }
  }

  formatTime(seconds) {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  }

  destroy() {
    if (this.sourceNode) {
      this.sourceNode.stop();
    }
    if (this.audioContext) {
      this.audioContext.close();
    }
  }
}
