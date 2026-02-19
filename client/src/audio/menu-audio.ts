type PendingEvent = 'boot' | 'load';

class MenuAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private uiBus: GainNode | null = null;
  private ambientBus: GainNode | null = null;
  private uiReverb: ConvolverNode | null = null;
  private ambientReverb: ConvolverNode | null = null;
  private unlocked = false;
  private pending = new Set<PendingEvent>();
  private ambientDesired = false;
  private noiseBuffer: AudioBuffer | null = null;
  private impulseBuffer: AudioBuffer | null = null;

  private ambientMasterGain: GainNode | null = null;
  private ambientChordTimer: number | null = null;
  private ambientSparkleTimer: number | null = null;
  private ambientNoiseSource: AudioBufferSourceNode | null = null;
  private ambientNoiseGain: GainNode | null = null;

  private ensureContext() {
    if (typeof window === 'undefined') return null;
    if (!this.ctx) {
      const AudioCtx =
        window.AudioContext ||
        (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioCtx) return null;

      this.ctx = new AudioCtx();

      const master = this.ctx.createGain();
      master.gain.value = 3.2;

      const glue = this.ctx.createDynamicsCompressor();
      glue.threshold.value = -16;
      glue.knee.value = 18;
      glue.ratio.value = 2.8;
      glue.attack.value = 0.006;
      glue.release.value = 0.24;

      const tonalTilt = this.ctx.createBiquadFilter();
      tonalTilt.type = 'highshelf';
      tonalTilt.frequency.value = 2800;
      tonalTilt.gain.value = -1.2;

      const uiBus = this.ctx.createGain();
      uiBus.gain.value = 2.4;

      const ambientBus = this.ctx.createGain();
      ambientBus.gain.value = 2.8;

      uiBus.connect(master);
      ambientBus.connect(master);
      master.connect(glue);
      glue.connect(tonalTilt);
      tonalTilt.connect(this.ctx.destination);

      this.master = master;
      this.uiBus = uiBus;
      this.ambientBus = ambientBus;

      this.uiReverb = this.ctx.createConvolver();
      this.uiReverb.buffer = this.buildImpulseBuffer(this.ctx, 1.35, 2.2);
      const uiReverbGain = this.ctx.createGain();
      uiReverbGain.gain.value = 0.9;
      this.uiReverb.connect(uiReverbGain);
      uiReverbGain.connect(this.uiBus);

      this.ambientReverb = this.ctx.createConvolver();
      this.ambientReverb.buffer = this.buildImpulseBuffer(this.ctx, 2.8, 3.4);
      const ambientReverbGain = this.ctx.createGain();
      ambientReverbGain.gain.value = 1.8;
      this.ambientReverb.connect(ambientReverbGain);
      ambientReverbGain.connect(this.ambientBus);
    }
    return this.ctx;
  }

  unlock() {
    const ctx = this.ensureContext();
    if (!ctx) return false;
    const firstUnlock = !this.unlocked;

    if (ctx.state === 'suspended') {
      void ctx.resume();
    }

    this.unlocked = true;
    if (firstUnlock) {
      this.flushPending();
    }
    if (this.ambientDesired) {
      this.startAmbient();
    }
    return firstUnlock;
  }

  playBoot() {
    if (!this.unlocked) {
      this.pending.add('boot');
      return;
    }
    const ctx = this.ensureContext();
    if (!ctx || !this.uiBus) return;

    const now = ctx.currentTime;
    this.playRiser(now, 0.7);
    this.playSubHit(now + 0.38, 0.45);
    this.playBell(now + 0.44, 392, 0.5, 0.018, 0.22);
    this.playBell(now + 0.56, 523.25, 0.62, 0.02, 0.26);
    this.playBell(now + 0.7, 659.25, 0.74, 0.018, 0.3);
  }

  playLoad() {
    if (!this.unlocked) {
      this.pending.add('load');
      return;
    }
    const ctx = this.ensureContext();
    if (!ctx) return;

    const now = ctx.currentTime;
    this.playWhoosh(now, 0.24, 1400, 4200, 0.008);
    this.playBell(now + 0.06, 349.23, 0.26, 0.01, 0.14);
    this.playBell(now + 0.14, 466.16, 0.28, 0.011, 0.16);
    this.playBell(now + 0.24, 587.33, 0.32, 0.011, 0.2);
  }

  playNavigate() {
    if (!this.unlocked) return;
    const ctx = this.ensureContext();
    if (!ctx) return;

    const now = ctx.currentTime;
    this.playClick(now, 0.0065, 4200, 0.0048);
    this.playTone(now + 0.006, 980, 0.028, 0.0034, 'triangle', 0.02);
  }

  playConfirm() {
    if (!this.unlocked) return;
    const ctx = this.ensureContext();
    if (!ctx) return;

    const now = ctx.currentTime;
    this.playClick(now, 0.007, 3600, 0.0045);
    this.playBell(now + 0.01, 440, 0.36, 0.011, 0.2);
    this.playBell(now + 0.08, 659.25, 0.42, 0.012, 0.24);
  }

  setMenuAmbient(enabled: boolean) {
    this.ambientDesired = enabled;
    if (!enabled) {
      this.stopAmbient();
      return;
    }
    if (this.unlocked) {
      this.startAmbient();
    }
  }

  refreshAmbient() {
    if (!this.ambientDesired || !this.unlocked) return;
    this.stopAmbient();
    this.startAmbient();
  }

  private flushPending() {
    if (this.pending.has('boot')) this.playBoot();
    if (this.pending.has('load')) this.playLoad();
    this.pending.clear();
  }

  private playTone(
    start: number,
    freq: number,
    duration: number,
    gainValue: number,
    type: OscillatorType,
    glide: number,
  ) {
    if (!this.ctx || !this.uiBus) return;

    const osc = this.ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, start);
    osc.frequency.exponentialRampToValueAtTime(Math.max(40, freq * (1 + glide)), start + duration);

    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(5500, start);
    filter.frequency.exponentialRampToValueAtTime(1700, start + duration);

    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.linearRampToValueAtTime(gainValue, start + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);

    osc.connect(filter);
    filter.connect(gain);
    gain.connect(this.uiBus);

    if (this.uiReverb) {
      const send = this.ctx.createGain();
      send.gain.value = 0.22;
      gain.connect(send);
      send.connect(this.uiReverb);
      osc.onended = () => {
        send.disconnect();
      };
    }

    osc.start(start);
    osc.stop(start + duration + 0.03);
    osc.onended = () => {
      osc.disconnect();
      filter.disconnect();
      gain.disconnect();
    };
  }

  private playBell(
    start: number,
    fundamental: number,
    duration: number,
    gainValue: number,
    shimmerMix: number,
  ) {
    this.playTone(start, fundamental, duration, gainValue, 'sine', 0.01);
    this.playTone(start + 0.002, fundamental * 2, duration * 0.74, gainValue * shimmerMix, 'triangle', 0.008);
  }

  private playClick(start: number, duration: number, bandFreq: number, gainValue: number) {
    if (!this.ctx || !this.uiBus) return;

    const src = this.ctx.createBufferSource();
    src.buffer = this.buildNoiseBuffer(this.ctx);

    const band = this.ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.setValueAtTime(bandFreq, start);
    band.Q.value = 2.8;

    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.linearRampToValueAtTime(gainValue, start + 0.002);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);

    src.connect(band);
    band.connect(gain);
    gain.connect(this.uiBus);

    src.start(start);
    src.stop(start + duration + 0.015);
    src.onended = () => {
      src.disconnect();
      band.disconnect();
      gain.disconnect();
    };
  }

  private playWhoosh(start: number, duration: number, fromHz: number, toHz: number, gainValue: number) {
    if (!this.ctx || !this.uiBus) return;

    const src = this.ctx.createBufferSource();
    src.buffer = this.buildNoiseBuffer(this.ctx);

    const band = this.ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.setValueAtTime(fromHz, start);
    band.frequency.exponentialRampToValueAtTime(toHz, start + duration);
    band.Q.value = 0.9;

    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(gainValue, start + 0.05);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);

    src.connect(band);
    band.connect(gain);
    gain.connect(this.uiBus);

    if (this.uiReverb) {
      const send = this.ctx.createGain();
      send.gain.value = 0.16;
      gain.connect(send);
      send.connect(this.uiReverb);
      src.onended = () => {
        send.disconnect();
      };
    }

    src.start(start);
    src.stop(start + duration + 0.05);
    src.onended = () => {
      src.disconnect();
      band.disconnect();
      gain.disconnect();
    };
  }

  private playRiser(start: number, duration: number) {
    this.playWhoosh(start, duration, 480, 2400, 0.01);
    this.playTone(start + 0.08, 196, duration * 0.8, 0.006, 'sawtooth', 0.2);
  }

  private playSubHit(start: number, duration: number) {
    if (!this.ctx || !this.uiBus) return;

    const osc = this.ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(72, start);
    osc.frequency.exponentialRampToValueAtTime(41, start + duration);

    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.007, start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);

    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 180;

    osc.connect(lp);
    lp.connect(gain);
    gain.connect(this.uiBus);

    osc.start(start);
    osc.stop(start + duration + 0.03);
    osc.onended = () => {
      osc.disconnect();
      lp.disconnect();
      gain.disconnect();
    };
  }

  private playAmbientPluck(start: number, freq: number, duration = 0.9) {
    if (!this.ctx || !this.ambientMasterGain) return;

    const osc = this.ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, start);
    osc.frequency.exponentialRampToValueAtTime(freq * 1.01, start + duration);

    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(2200, start);
    filter.frequency.exponentialRampToValueAtTime(680, start + duration);
    filter.Q.value = 0.35;

    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.linearRampToValueAtTime(0.0048, start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);

    osc.connect(filter);
    filter.connect(gain);
    gain.connect(this.ambientMasterGain);

    if (this.ambientReverb) {
      const send = this.ctx.createGain();
      send.gain.value = 0.48;
      gain.connect(send);
      send.connect(this.ambientReverb);
      osc.onended = () => {
        send.disconnect();
      };
    }

    osc.start(start);
    osc.stop(start + duration + 0.1);
    osc.onended = () => {
      osc.disconnect();
      filter.disconnect();
      gain.disconnect();
    };
  }

  private startAmbient() {
    const ctx = this.ensureContext();
    if (!ctx || !this.ambientBus) return;
    if (this.ambientMasterGain || this.ambientNoiseSource) return;

    const ambientMaster = ctx.createGain();
    ambientMaster.gain.setValueAtTime(0.0001, ctx.currentTime);
    ambientMaster.gain.exponentialRampToValueAtTime(0.34, ctx.currentTime + 4.8);
    ambientMaster.connect(this.ambientBus);
    this.ambientMasterGain = ambientMaster;

    const noise = ctx.createBufferSource();
    noise.buffer = this.buildNoiseBuffer(ctx);
    noise.loop = true;

    const noiseHp = ctx.createBiquadFilter();
    noiseHp.type = 'highpass';
    noiseHp.frequency.value = 1200;
    noiseHp.Q.value = 0.45;

    const noiseBp = ctx.createBiquadFilter();
    noiseBp.type = 'bandpass';
    noiseBp.frequency.value = 2600;
    noiseBp.Q.value = 0.65;

    const noiseGain = ctx.createGain();
    noiseGain.gain.setValueAtTime(0.0001, ctx.currentTime);
    noiseGain.gain.exponentialRampToValueAtTime(0.0032, ctx.currentTime + 3.4);

    noise.connect(noiseHp);
    noiseHp.connect(noiseBp);
    noiseBp.connect(noiseGain);
    noiseGain.connect(ambientMaster);

    if (this.ambientReverb) {
      const washSend = ctx.createGain();
      washSend.gain.value = 0.75;
      noiseGain.connect(washSend);
      washSend.connect(this.ambientReverb);
      noise.onended = () => washSend.disconnect();
    }

    noise.start();
    this.ambientNoiseSource = noise;
    this.ambientNoiseGain = noiseGain;

    const chords: ReadonlyArray<[number, number, number]> = [
      [261.63, 329.63, 392],
      [293.66, 369.99, 440],
      [329.63, 415.3, 493.88],
      [293.66, 369.99, 440],
    ];

    let chordIndex = 0;
    const applyChord = () => {
      const chord = chords[chordIndex] ?? chords[0] ?? [261.63, 329.63, 392];
      const t = ctx.currentTime + 0.05;
      this.playAmbientPluck(t, chord[0], 1.8);
      this.playAmbientPluck(t + 0.18, chord[1], 1.6);
      this.playAmbientPluck(t + 0.36, chord[2], 1.7);
      chordIndex = (chordIndex + 1) % chords.length;
    };

    applyChord();
    this.ambientChordTimer = window.setInterval(() => {
      applyChord();
    }, 6800);

    const melody: ReadonlyArray<number> = [523.25, 587.33, 659.25, 698.46, 783.99, 659.25, 587.33, 523.25];
    let melodyIndex = 0;
    this.ambientSparkleTimer = window.setInterval(() => {
      if (!this.unlocked) return;
      const note = melody[melodyIndex] ?? melody[0] ?? 523.25;
      melodyIndex = (melodyIndex + 1) % melody.length;
      const t = ctx.currentTime + 0.02;
      this.playAmbientPluck(t, note, 0.95);
    }, 2600);
  }

  private stopAmbient() {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;

    if (this.ambientChordTimer !== null) {
      window.clearInterval(this.ambientChordTimer);
      this.ambientChordTimer = null;
    }
    if (this.ambientSparkleTimer !== null) {
      window.clearInterval(this.ambientSparkleTimer);
      this.ambientSparkleTimer = null;
    }

    if (this.ambientMasterGain) {
      this.ambientMasterGain.gain.cancelScheduledValues(now);
      this.ambientMasterGain.gain.setValueAtTime(Math.max(this.ambientMasterGain.gain.value, 0.0001), now);
      this.ambientMasterGain.gain.exponentialRampToValueAtTime(0.0001, now + 1.1);
    }
    if (this.ambientNoiseGain && this.ambientNoiseSource) {
      this.ambientNoiseGain.gain.cancelScheduledValues(now);
      this.ambientNoiseGain.gain.setValueAtTime(Math.max(this.ambientNoiseGain.gain.value, 0.0001), now);
      this.ambientNoiseGain.gain.exponentialRampToValueAtTime(0.0001, now + 1.1);
      this.ambientNoiseSource.stop(now + 1.2);
      this.ambientNoiseSource.onended = () => {
        this.ambientNoiseSource?.disconnect();
        this.ambientNoiseGain?.disconnect();
      };
    }

    this.ambientMasterGain = null;
    this.ambientNoiseSource = null;
    this.ambientNoiseGain = null;
  }

  private buildNoiseBuffer(ctx: AudioContext) {
    if (this.noiseBuffer) return this.noiseBuffer;

    const length = Math.floor(ctx.sampleRate * 1.5);
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);

    let brown = 0;
    for (let i = 0; i < length; i += 1) {
      const white = Math.random() * 2 - 1;
      brown = (brown + 0.03 * white) / 1.03;
      data[i] = brown * 2.4;
    }

    this.noiseBuffer = buffer;
    return buffer;
  }

  private buildImpulseBuffer(ctx: AudioContext, seconds: number, decay: number) {
    if (this.impulseBuffer && Math.abs(seconds - 1.35) < 0.01 && Math.abs(decay - 2.2) < 0.01) {
      return this.impulseBuffer;
    }

    const length = Math.floor(ctx.sampleRate * seconds);
    const buffer = ctx.createBuffer(2, length, ctx.sampleRate);

    for (let c = 0; c < 2; c += 1) {
      const channel = buffer.getChannelData(c);
      for (let i = 0; i < length; i += 1) {
        const t = i / length;
        const env = Math.pow(1 - t, decay);
        channel[i] = (Math.random() * 2 - 1) * env;
      }
    }

    if (Math.abs(seconds - 1.35) < 0.01 && Math.abs(decay - 2.2) < 0.01) {
      this.impulseBuffer = buffer;
    }

    return buffer;
  }
}

export const menuAudio = new MenuAudio();
