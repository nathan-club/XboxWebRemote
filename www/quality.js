'use strict';

class XwrQuality {
  constructor(ceiling = 50000) {
    const cap = ceiling > 0 ? Math.min(ceiling, 50000) : 50000;
    this.profiles = [50000, 20000, 8000, 4000, 2000].map(rate => ({
      bitrate: Math.min(rate, cap), quality: Math.min(rate, cap) <= 4000 ? '720p' : '1080p',
    })).filter((p, i, all) => !i || p.bitrate !== all[i - 1].bitrate);
    this.index = 0;
    this.done = false;
    this.adjustments = 0;
    this.maxAdjustments = 2;
    this.label = '等待媒体连接';
    this.resetWindow();
  }

  get profile() { return this.profiles[this.index]; }

  resetWindow() {
    this.started = null;
    this.baseline = null;
    this.sampleId = null;
  }

  static assess(before, after) {
    const delta = key => Math.max(0, (after[key] || 0) - (before[key] || 0));
    const received = delta('packetsReceived'), lost = delta('packetsLost');
    const seconds = (after.timestamp - before.timestamp) / 1000;
    const emitted = delta('jitterBufferEmittedCount');
    const bufferMs = emitted ? delta('jitterBufferDelay') / emitted * 1000 : 0;
    const freezeRatio = seconds > 0 ? delta('totalFreezesDuration') / seconds : 0;
    const decoded = delta('framesDecoded'), dropped = delta('framesDropped');
    const loss = lost / Math.max(1, received + lost);
    const reasons = [];
    if (loss > 0.02) reasons.push('网络丢包');
    if (bufferMs > 120) reasons.push('缓冲积压');
    if (freezeRatio > 0.05 || (received > 30 && decoded === 0)) reasons.push('画面冻结');
    if (dropped / Math.max(1, decoded + dropped) > 0.1) reasons.push('解码丢帧');
    return {bad: reasons.length > 0, reasons, noFrames: received > 30 && decoded === 0,
      severe: loss > 0.08 || freezeRatio > 0.15 || (received > 30 && decoded === 0)};
  }

  sample(video, visible = true) {
    // Hidden/background tabs can throttle rendering; don't classify that as a bad route.
    if (!visible) { this.resetWindow(); return null; }
    if (!video || !Number.isFinite(video.timestamp) || video.framesDecoded === undefined) return null;
    if (this.sampleId !== null && (this.sampleId !== video.id ||
        (this.baseline && video.framesDecoded < this.baseline.framesDecoded))) this.resetWindow();
    this.sampleId = video.id;
    if (this.started === null) this.started = video.timestamp;
    const elapsed = video.timestamp - this.started;
    if (!this.done && elapsed < 3000) { this.label = '预热画面…'; return null; }
    if (!this.baseline) { this.baseline = {...video}; return null; }
    const duration = video.timestamp - this.baseline.timestamp;
    if (duration < 10000) {
      if (!this.done) this.label = '正在校准 '+Math.floor(duration / 1000)+'/10 秒';
      return null;
    }
    const result = XwrQuality.assess(this.baseline, video);
    this.baseline = {...video};
    // No automatic reconnect during gameplay: initial calibration owns all changes.
    if (this.done) return result.bad ? {type:'warning', ...result} : null;
    if (result.bad && this.index < this.profiles.length - 1 && this.adjustments < this.maxAdjustments) {
      this.index = result.severe ? this.profiles.length - 1 : this.index + 1;
      this.adjustments++;
      this.label = result.reasons.join('、')+'，调整档位…';
      this.resetWindow();
      return {type:'adjust', profile:this.profile, ...result};
    }
    this.done = true;
    this.label = result.bad ? '校准完成，最低档仍有波动' : '校准完成';
    return {type:'ready', profile:this.profile, ...result};
  }
}

if (typeof module !== 'undefined') module.exports = XwrQuality;
