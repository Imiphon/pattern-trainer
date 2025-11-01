import { LOOKAHEAD_MS, SCHEDULE_AHEAD } from "./constants.js";
import { clamp } from "./utils.js";

let metronomeNoiseBuffer = null;

export class SimpleMetronome {
  constructor({ getContext, bpmInput, beatsInput, toggleButton }) {
    this.getContext = getContext;
    this.bpmInput = bpmInput;
    this.beatsInput = beatsInput;
    this.toggleButton = toggleButton;

    this.ctx = null;
    this.metroGain = null;
    this.nextNoteTime = 0;
    this.currentBeat = 0;
    this.isRunning = false;
    this.timerId = null;
    this.beatListeners = new Set();
    this.beatCounter = 0;
    this.startedAt = null;
    this.lastBeatTime = null;
    this.beatLengthSeconds = 60 / this.bpm;
    this.volume = 0.9;
  }

  async start() {
    if (this.isRunning) return;
    const ctx = await this.getContext();
    if (!ctx) return;

    this.ctx = ctx;
    this.ensureGain();

    this.currentBeat = 0;
    this.nextNoteTime = ctx.currentTime + 0.1;
    this.isRunning = true;
    this.startedAt = this.nextNoteTime;
    this.beatCounter = 0;
    this.lastBeatTime = null;
    this.beatLengthSeconds = 60 / this.bpm;

    this.toggleButton.textContent = "Stop";
    this.toggleButton.classList.add("is-running");
    this.timerId = window.setInterval(() => this.scheduler(), LOOKAHEAD_MS);
  }

  stop() {
    if (!this.isRunning) return;
    this.isRunning = false;
    this.toggleButton.textContent = "Start";
    this.toggleButton.classList.remove("is-running");
    if (this.timerId) {
      window.clearInterval(this.timerId);
      this.timerId = null;
    }
    this.lastBeatTime = null;
    this.startedAt = null;
    this.beatCounter = 0;
    this.currentBeat = 0;
  }

  toggle() {
    if (this.isRunning) {
      this.stop();
    } else {
      this.start();
    }
  }

  scheduler() {
    if (!this.ctx) return;
    while (this.nextNoteTime < this.ctx.currentTime + SCHEDULE_AHEAD) {
      const bpm = this.bpm;
      const beatInterval = 60 / bpm;
      const scheduledTime = this.nextNoteTime;
      const beatIndex = this.currentBeat;
      const totalBeats = this.beatCounter;
      const accent = beatIndex === 0;

      this.scheduleTick(accent, scheduledTime);
      this.emitBeat({
        accent,
        time: scheduledTime,
        beatIndex,
        totalBeats,
        beatLength: beatInterval,
        bpm
      });

      this.nextNoteTime += beatInterval;
      this.beatLengthSeconds = beatInterval;
      this.lastBeatTime = scheduledTime;
      this.beatCounter = totalBeats + 1;
      this.currentBeat = (beatIndex + 1) % this.beatsPerBar;
    }
  }

  scheduleTick(accent, when) {
    if (!this.ctx || !this.metroGain) return;
    playMetronomeTick({
      ctx: this.ctx,
      destination: this.metroGain,
      when,
      accent
    });
  }

  ensureGain() {
    if (!this.ctx || this.metroGain) return;
    this.metroGain = this.ctx.createGain();
    this.metroGain.gain.value = this.volume;
    this.metroGain.connect(this.ctx.destination);
  }

  get bpm() {
    return clamp(parseInt(this.bpmInput.value, 10) || 96, 30, 220);
  }

  get beatsPerBar() {
    return clamp(parseInt(this.beatsInput.value, 10) || 4, 1, 12);
  }

  isActive() {
    return this.isRunning;
  }

  addBeatListener(listener) {
    if (typeof listener !== "function") {
      return () => {};
    }
    this.beatListeners.add(listener);
    return () => {
      this.beatListeners.delete(listener);
    };
  }

  setVolume(value) {
    const normalized = clamp(typeof value === "number" ? value : 0, 0, 1);
    this.volume = normalized;
    if (this.metroGain) {
      const ctx = this.ctx;
      const now = ctx ? ctx.currentTime : 0;
      this.metroGain.gain.setTargetAtTime(this.volume, now, 0.01);
    }
  }

  getVolume() {
    return this.volume;
  }

  getBeatLengthSeconds() {
    return this.beatLengthSeconds || 60 / this.bpm;
  }

  getTimingState(referenceTime) {
    if (!this.ctx || !this.isRunning || this.startedAt == null) {
      return null;
    }
    const ref = typeof referenceTime === "number" ? referenceTime : this.ctx.currentTime;
    const beatLength = this.getBeatLengthSeconds();
    const elapsed = ref - this.startedAt;
    const totalBeats = elapsed / beatLength;
    const beatsPerBar = this.beatsPerBar;
    const bar = beatsPerBar > 0 ? Math.floor(totalBeats / beatsPerBar) : 0;
    const beatPosition = beatsPerBar > 0 ? totalBeats - bar * beatsPerBar : totalBeats;
    const nextBeatTime = this.lastBeatTime != null ? this.lastBeatTime + beatLength : this.startedAt;

    return {
      bpm: this.bpm,
      beatsPerBar,
      beatLengthSeconds: beatLength,
      startedAt: this.startedAt,
      referenceTime: ref,
      totalBeats,
      bar,
      beatPosition,
      lastBeatTime: this.lastBeatTime,
      nextBeatTime,
      beatCounter: this.beatCounter
    };
  }

  emitBeat({ accent, time, beatIndex, totalBeats, beatLength, bpm }) {
    if (!this.beatListeners.size) return;
    const beatsPerBar = this.beatsPerBar;
    const bar = beatsPerBar > 0 ? Math.floor(totalBeats / beatsPerBar) : 0;
    const beatInBar = beatsPerBar > 0 ? totalBeats % beatsPerBar : totalBeats;
    this.beatListeners.forEach((listener) => {
      listener({
        time,
        accent,
        beatIndex,
        beatsPerBar,
        bar,
        beatInBar,
        totalBeats,
        beatLength,
        bpm
      });
    });
  }
}

function getMetronomeNoiseBuffer(ctx) {
  if (metronomeNoiseBuffer && metronomeNoiseBuffer.sampleRate === ctx.sampleRate) {
    return metronomeNoiseBuffer;
  }
  const duration = 0.04;
  const frameCount = Math.max(1, Math.floor(ctx.sampleRate * duration));
  const buffer = ctx.createBuffer(1, frameCount, ctx.sampleRate);
  const channel = buffer.getChannelData(0);
  for (let i = 0; i < frameCount; i++) {
    const fade = 1 - i / frameCount;
    channel[i] = (Math.random() * 2 - 1) * fade;
  }
  metronomeNoiseBuffer = buffer;
  return metronomeNoiseBuffer;
}

function playMetronomeTick({ ctx, destination, when, accent }) {
  const click = ctx.createOscillator();
  click.type = "square";
  click.frequency.setValueAtTime(accent ? 2400 : 900, when);

  const clickGain = ctx.createGain();
  const clickLevel = accent ? 0.45 : 0.28;
  clickGain.gain.setValueAtTime(0, when);
  clickGain.gain.linearRampToValueAtTime(clickLevel, when + 0.003);
  clickGain.gain.exponentialRampToValueAtTime(0.0001, when + 0.12);
  click.connect(clickGain).connect(destination);
  click.start(when);
  click.stop(when + 0.14);

  const body = ctx.createOscillator();
  body.type = "sine";
  body.frequency.setValueAtTime(accent ? 440 : 260, when);
  const bodyGain = ctx.createGain();
  const bodyLevel = accent ? 0.28 : 0.18;
  bodyGain.gain.setValueAtTime(0, when);
  bodyGain.gain.linearRampToValueAtTime(bodyLevel, when + 0.01);
  bodyGain.gain.exponentialRampToValueAtTime(0.0001, when + 0.18);
  body.connect(bodyGain).connect(destination);
  body.start(when);
  body.stop(when + 0.22);

  const noiseBuffer = getMetronomeNoiseBuffer(ctx);
  if (noiseBuffer) {
    const noise = ctx.createBufferSource();
    noise.buffer = noiseBuffer;
    const noiseGain = ctx.createGain();
    const noiseLevel = accent ? 0.16 : 0.1;
    noiseGain.gain.setValueAtTime(noiseLevel, when);
    noiseGain.gain.exponentialRampToValueAtTime(0.0001, when + 0.05);
    noise.connect(noiseGain).connect(destination);
    noise.start(when);
    noise.stop(when + noiseBuffer.duration);
  }
}
