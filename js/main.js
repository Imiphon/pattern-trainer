const KEYBOARD_LAYOUT = [
  { white: "C3", label: "C3", black: { note: "C#3", label: "C#3" } },
  { white: "D3", label: "D3", black: { note: "D#3", label: "D#3" } },
  { white: "E3", label: "E3" },
  { white: "F3", label: "F3", black: { note: "F#3", label: "F#3" } },
  { white: "G3", label: "G3", black: { note: "G#3", label: "G#3" } },
  { white: "A3", label: "A3", black: { note: "A#3", label: "A#3" } },
  { white: "B3", label: "B3" },
  { white: "C4", label: "C4", black: { note: "C#4", label: "C#4" } },
  { white: "D4", label: "D4", black: { note: "D#4", label: "D#4" } },
  { white: "E4", label: "E4" },
  { white: "F4", label: "F4", black: { note: "F#4", label: "F#4" } },
  { white: "G4", label: "G4", black: { note: "G#4", label: "G#4" } },
  { white: "A4", label: "A4", black: { note: "A#4", label: "A#4" } },
  { white: "B4", label: "B4" },
  { white: "C5", label: "C5" }
];

const DEFAULT_NOTE_DURATION = 0.6;
const LOOKAHEAD_MS = 25;
const SCHEDULE_AHEAD = 0.1;

const keyElements = new Map();
const keyTimers = new Map();
const recordedEvents = [];
let playbackTimeouts = [];
let audioCtx = null;
let isRecording = false;
let isPlayingBack = false;
let recordStartTime = 0;
let metronomeInstance = null;
let lastTemplateName = "";

const keyboardEl = document.getElementById("trainerKeyboard");
const recordBtn = document.getElementById("recordBtn");
const stopBtn = document.getElementById("stopBtn");
const playBtn = document.getElementById("playBtn");
const deleteBtn = document.getElementById("deleteBtn");
const saveBtn = document.getElementById("saveBtn");
const recordingStatusEl = document.getElementById("recordingStatus");
const templateNameInput = document.getElementById("templateName");
const practiceTextarea = document.getElementById("practice-notes");
const practicePlayBtn = document.getElementById("practicePlay");
const recordingSummaryText = document.getElementById("recordingSummaryText");

const metronomeBpmInput = document.getElementById("metronomeBpm");
const metronomeBeatsInput = document.getElementById("metronomeBeats");
const metronomeSoundSelect = document.getElementById("metronomeSound");
const metronomeToggleBtn = document.getElementById("metronomeToggle");

if (keyboardEl) {
  createKeyboard(keyboardEl);
}

if (recordBtn && stopBtn && playBtn && deleteBtn && saveBtn) {
  recordBtn.addEventListener("click", startRecording);
  stopBtn.addEventListener("click", stopRecording);
  playBtn.addEventListener("click", () => playRecording());
  deleteBtn.addEventListener("click", clearRecording);
  saveBtn.addEventListener("click", saveRecordingAsTemplate);
}

if (practicePlayBtn) {
  practicePlayBtn.addEventListener("click", () => playRecording());
}

if (metronomeToggleBtn && metronomeBpmInput && metronomeBeatsInput && metronomeSoundSelect) {
  metronomeInstance = new SimpleMetronome({
    getContext: getAudioContext,
    bpmInput: metronomeBpmInput,
    beatsInput: metronomeBeatsInput,
    soundSelect: metronomeSoundSelect,
    toggleButton: metronomeToggleBtn
  });

  metronomeToggleBtn.addEventListener("click", () => metronomeInstance.toggle());
  metronomeSoundSelect.addEventListener("change", () => metronomeInstance.setSound(metronomeSoundSelect.value));
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      metronomeInstance?.stop();
    }
  });
}

function createKeyboard(container) {
  KEYBOARD_LAYOUT.forEach(({ white, label, black }) => {
    const wrapper = document.createElement("div");
    wrapper.className = "key-wrapper";

    const whiteKey = createKeyElement(white, label, "white");
    wrapper.append(whiteKey);

    if (black) {
      const blackKey = createKeyElement(black.note, black.label ?? black.note, "black");
      wrapper.append(blackKey);
    }

    container.append(wrapper);
  });
}

function createKeyElement(note, label, variant) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = `key ${variant}`;
  btn.dataset.note = note;
  btn.setAttribute("aria-label", `Note ${label}`);

  const span = document.createElement("span");
  span.className = "key-label";
  span.textContent = label;
  btn.append(span);

  const pressHandler = (event) => {
    event.preventDefault();
    triggerNotePlayback(note);
  };

  btn.addEventListener("pointerdown", pressHandler);
  btn.addEventListener("keydown", (event) => {
    if (event.code === "Space" || event.code === "Enter") {
      event.preventDefault();
      triggerNotePlayback(note);
    }
  });

  keyElements.set(note, btn);
  return btn;
}

async function triggerNotePlayback(note) {
  const ctx = await getAudioContext();
  if (!ctx) return;

  const now = ctx.currentTime;
  playTone(ctx, note, now, DEFAULT_NOTE_DURATION);
  flashKey(note, "active", DEFAULT_NOTE_DURATION * 600);

  if (isRecording) {
    if (recordedEvents.length === 0) {
      recordStartTime = now;
    }
    recordedEvents.push({
      note,
      time: Math.max(0, now - recordStartTime),
      duration: DEFAULT_NOTE_DURATION
    });
    updateRecordingStatus(`Aufnahme laeuft - Noten: ${recordedEvents.length}`);
  }
}

async function startRecording() {
  const ctx = await getAudioContext();
  if (!ctx || isRecording) return;

  stopPlayback();
  recordedEvents.length = 0;
  recordStartTime = ctx.currentTime;
  isRecording = true;

  recordBtn.disabled = true;
  stopBtn.disabled = false;
  playBtn.disabled = true;
  deleteBtn.disabled = true;
  saveBtn.disabled = true;
  practicePlayBtn.disabled = true;

  updateRecordingStatus("Aufnahme laeuft - spiele dein Pattern ein.");
  updateRecordingSummaryPlaceholder("Aufnahme laeuft ...");
}

function stopRecording() {
  if (!isRecording) return;
  isRecording = false;
  stopBtn.disabled = true;
  recordBtn.disabled = false;

  if (recordedEvents.length === 0) {
    updateRecordingStatus("Keine Noten aufgenommen. Versuche es noch einmal.");
    clearRecording(false);
    return;
  }

  playBtn.disabled = false;
  deleteBtn.disabled = false;
  saveBtn.disabled = false;
  practicePlayBtn.disabled = false;

  updateRecordingStatus("Aufnahme beendet. Du kannst nun anhoeren, speichern oder loeschen.");
  updatePracticeArea(lastTemplateName || "Letzte Aufnahme");
}

function clearRecording(showStatus = true) {
  stopPlayback();
  recordedEvents.length = 0;
  isRecording = false;
  recordStartTime = 0;
  lastTemplateName = "";

  recordBtn.disabled = false;
  stopBtn.disabled = true;
  playBtn.disabled = true;
  deleteBtn.disabled = true;
  saveBtn.disabled = true;
  practicePlayBtn.disabled = true;

  updateRecordingSummaryPlaceholder("Noch keine Aufnahme.");
  if (showStatus) {
    updateRecordingStatus("Aufnahme geloescht.");
  }
  practiceTextarea.value = "";
  templateNameInput.value = "";
}

async function playRecording() {
  if (isRecording || isPlayingBack || recordedEvents.length === 0) return;

  const ctx = await getAudioContext();
  if (!ctx) return;

  stopPlayback();
  isPlayingBack = true;
  recordBtn.disabled = true;
  playBtn.disabled = true;
  practicePlayBtn.disabled = true;

  const startAt = ctx.currentTime + 0.08;
  const totalDuration =
    recordedEvents[recordedEvents.length - 1].time +
    recordedEvents[recordedEvents.length - 1].duration +
    0.25;

  recordedEvents.forEach((event) => {
    scheduleTone(ctx, event.note, startAt + event.time, event.duration);
  });

  playbackTimeouts.push(
    window.setTimeout(() => {
      stopPlayback();
      updateRecordingStatus("Wiedergabe beendet.");
    }, totalDuration * 1000)
  );

  updateRecordingStatus("Spiele Aufnahme ab ...");
}

function stopPlayback() {
  if (playbackTimeouts.length > 0) {
    playbackTimeouts.forEach((id) => window.clearTimeout(id));
    playbackTimeouts = [];
  }
  clearPlaybackVisuals();

  if (!isPlayingBack) return;
  isPlayingBack = false;
  if (recordedEvents.length > 0) {
    playBtn.disabled = false;
    practicePlayBtn.disabled = false;
  }
  recordBtn.disabled = false;
}

function saveRecordingAsTemplate() {
  if (recordedEvents.length === 0) {
    updateRecordingStatus("Keine Aufnahme vorhanden. Bitte zuerst aufnehmen.");
    return;
  }
  const name = templateNameInput.value.trim() || "Unbenannte Vorlage";
  lastTemplateName = name;
  updatePracticeArea(name);
  updateRecordingStatus(`Vorlage "${name}" gespeichert. Du findest sie in "Meine Uebung".`);
}

function updatePracticeArea(name) {
  const summary = formatRecordingSummary(recordedEvents);
  recordingSummaryText.textContent = summary;
  practiceTextarea.value = `${name}: ${summary}`;
  practicePlayBtn.disabled = recordedEvents.length === 0;
}

function updateRecordingSummaryPlaceholder(text) {
  recordingSummaryText.textContent = text;
}

function updateRecordingStatus(text) {
  if (recordingStatusEl) {
    recordingStatusEl.textContent = text;
  }
}

function formatRecordingSummary(events) {
  if (!events.length) return "Noch keine Aufnahme.";
  return events.map((event) => event.note).join(" | ");
}

async function getAudioContext() {
  if (typeof window === "undefined") return null;
  if (!audioCtx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) {
      updateRecordingStatus("AudioContext wird nicht unterstuetzt.");
      return null;
    }
    audioCtx = new Ctx();
  }
  if (audioCtx.state === "suspended") {
    await audioCtx.resume();
  }
  return audioCtx;
}

function playTone(ctx, note, when, duration) {
  const frequency = noteToFrequency(note);
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();

  osc.type = "sine";
  osc.frequency.setValueAtTime(frequency, when);

  gain.gain.setValueAtTime(0, when);
  gain.gain.linearRampToValueAtTime(0.32, when + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, when + duration);

  osc.connect(gain).connect(ctx.destination);
  osc.start(when);
  osc.stop(when + duration + 0.05);
}

function scheduleTone(ctx, note, when, duration) {
  playTone(ctx, note, when, duration);
  const delay = Math.max(0, (when - ctx.currentTime) * 1000);
  const highlightDuration = duration * 1000;
  const timeoutId = window.setTimeout(() => {
    flashKey(note, "playback-active", highlightDuration);
  }, delay);
  playbackTimeouts.push(timeoutId);
}

function flashKey(note, className, durationMs) {
  const el = keyElements.get(note);
  if (!el) return;

  const timers = keyTimers.get(note) || {};
  if (timers[className]) {
    window.clearTimeout(timers[className]);
  }
  el.classList.add(className);
  timers[className] = window.setTimeout(() => {
    el.classList.remove(className);
    timers[className] = null;
  }, durationMs);
  keyTimers.set(note, timers);
}

function clearPlaybackVisuals() {
  keyTimers.forEach((timers, note) => {
    if (timers["playback-active"]) {
      window.clearTimeout(timers["playback-active"]);
      timers["playback-active"] = null;
    }
    const el = keyElements.get(note);
    el?.classList.remove("playback-active");
  });
}

function noteToFrequency(note) {
  const match = /^([A-G])(#?)(\d)$/.exec(note);
  if (!match) return 440;
  const [, letter, sharp, octaveStr] = match;
  const SEMITONES = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  const octave = parseInt(octaveStr, 10);
  const base = SEMITONES[letter];
  const midi = (octave + 1) * 12 + base + (sharp ? 1 : 0);
  return 440 * Math.pow(2, (midi - 69) / 12);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

class SimpleMetronome {
  constructor({ getContext, bpmInput, beatsInput, soundSelect, toggleButton }) {
    this.getContext = getContext;
    this.bpmInput = bpmInput;
    this.beatsInput = beatsInput;
    this.soundSelect = soundSelect;
    this.toggleButton = toggleButton;

    this.ctx = null;
    this.metroGain = null;
    this.nextNoteTime = 0;
    this.currentBeat = 0;
    this.isRunning = false;
    this.timerId = null;
    this.soundMode = "click";
  }

  setSound(mode) {
    this.soundMode = mode === "kick" ? "kick" : "click";
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
      const accent = this.currentBeat === 0;
      this.scheduleTick(accent, this.nextNoteTime);
      this.nextNoteTime += 60 / this.bpm;
      this.currentBeat = (this.currentBeat + 1) % this.beatsPerBar;
    }
  }

  scheduleTick(accent, when) {
    if (!this.ctx || !this.metroGain) return;
    if (this.soundMode === "kick") {
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(accent ? 120 : 80, when);
      gain.gain.setValueAtTime(accent ? 0.55 : 0.38, when);
      gain.gain.exponentialRampToValueAtTime(0.0001, when + 0.08);
      osc.connect(gain).connect(this.metroGain);
      osc.start(when);
      osc.stop(when + 0.12);
    } else {
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = "square";
      osc.frequency.setValueAtTime(accent ? 2000 : 1400, when);
      gain.gain.setValueAtTime(accent ? 0.18 : 0.12, when);
      gain.gain.exponentialRampToValueAtTime(0.0001, when + 0.04);
      osc.connect(gain).connect(this.metroGain);
      osc.start(when);
      osc.stop(when + 0.08);
    }
  }

  ensureGain() {
    if (!this.ctx || this.metroGain) return;
    this.metroGain = this.ctx.createGain();
    this.metroGain.gain.value = 0.9;
    this.metroGain.connect(this.ctx.destination);
  }

  get bpm() {
    return clamp(parseInt(this.bpmInput.value, 10) || 96, 30, 220);
  }

  get beatsPerBar() {
    return clamp(parseInt(this.beatsInput.value, 10) || 4, 1, 12);
  }
}
