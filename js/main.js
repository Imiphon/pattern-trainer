import { DEFAULT_NOTE_DURATION, RecordingPhase, BEAT_EPSILON } from "./constants.js";
import { createKeyboard } from "./keyboard.js";
import { SimpleMetronome } from "./metronome.js";
import { playPianoNote } from "./audio.js";

const keyTimers = new Map();
const recordedEvents = [];
let keyElements = null;
let playbackTimeouts = [];
let audioCtx = null;
let isRecording = false;
let isPlayingBack = false;
let recordStartTime = 0;
let metronomeInstance = null;
let lastTemplateName = "";

let recordingTimingSnapshot = null;
let lastRecordingTiming = null;
let recordedBeatTimeline = [];
let lastRecordingBeatTimeline = [];
let metronomeBeatListenerCleanup = null;

let recordingPhase = RecordingPhase.idle;
let countInBeatsRemaining = 0;
let stopPending = false;
let stopTargetBeat = null;
let countInHasStarted = false;
let metronomeStartedByRecorder = false;

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
const recordingSummaryNotation = document.getElementById("recordingSummaryNotation");

const metronomeBpmInput = document.getElementById("metronomeBpm");
const metronomeBeatsInput = document.getElementById("metronomeBeats");
const metronomeToggleBtn = document.getElementById("metronomeToggle");
const metronomeVolumeSlider = document.getElementById("metronomeVolume");
const keyboardVolumeSlider = document.getElementById("keyboardVolume");
const playbackVolumeSlider = document.getElementById("playbackVolume");
const playbackMetronomeToggle = document.getElementById("playbackMetronomeToggle");

let keyboardGainNode = null;
let playbackGainNode = null;
let metronomeStartedForPlayback = false;
let keyboardVolumeValue = sliderValueToGain(keyboardVolumeSlider?.value ?? 90);
let playbackVolumeValue = sliderValueToGain(playbackVolumeSlider?.value ?? 80);
let metronomeVolumeValue = sliderValueToGain(metronomeVolumeSlider?.value ?? 80);
const activeKeyboardSources = new Map();

if (keyboardEl) {
  keyElements = createKeyboard(keyboardEl, triggerNotePlayback);
}

if (recordBtn && stopBtn && playBtn && deleteBtn && saveBtn) {
  recordBtn.addEventListener("click", startRecording);
  stopBtn.addEventListener("click", stopRecording);
  playBtn.addEventListener("click", () => playRecording());
  deleteBtn.addEventListener("click", () => clearRecording());
  saveBtn.addEventListener("click", saveRecordingAsTemplate);
}

if (practicePlayBtn) {
  practicePlayBtn.addEventListener("click", () => playRecording());
}

if (keyboardVolumeSlider) {
  keyboardVolumeSlider.addEventListener("input", () => {
    keyboardVolumeValue = sliderValueToGain(keyboardVolumeSlider.value);
    updateKeyboardVolume();
  });
}

if (playbackVolumeSlider) {
  playbackVolumeSlider.addEventListener("input", () => {
    playbackVolumeValue = sliderValueToGain(playbackVolumeSlider.value);
    updatePlaybackVolume();
  });
}

if (metronomeVolumeSlider) {
  metronomeVolumeSlider.addEventListener("input", () => {
    metronomeVolumeValue = sliderValueToGain(metronomeVolumeSlider.value);
    if (metronomeInstance) {
      metronomeInstance.setVolume(metronomeVolumeValue);
    }
  });
}

if (metronomeToggleBtn && metronomeBpmInput && metronomeBeatsInput) {
  metronomeInstance = new SimpleMetronome({
    getContext: getAudioContext,
    bpmInput: metronomeBpmInput,
    beatsInput: metronomeBeatsInput,
    toggleButton: metronomeToggleBtn
  });

  metronomeToggleBtn.addEventListener("click", () => metronomeInstance.toggle());
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      metronomeInstance?.stop();
    }
  });

  metronomeInstance.setVolume(metronomeVolumeValue);
}

function renderRecordingSummaryNotation(content) {
  if (!recordingSummaryNotation) return;
  if (typeof content === "string") {
    recordingSummaryNotation.textContent = content;
    return;
  }
  recordingSummaryNotation.textContent = "";
}

renderRecordingSummaryNotation("Noch keine Aufnahme.");

async function triggerNotePlayback(note) {
  const ctx = await getAudioContext();
  if (!ctx) return;

  const now = ctx.currentTime;
  try {
    stopActiveKeyboardNote(note, now);

    const voice = await playPianoNote(ctx, note, now, {
      destination: keyboardGainNode ?? ctx.destination
    });
    if (voice && voice.source) {
      activeKeyboardSources.set(note, voice);
      const cleanup = () => {
        activeKeyboardSources.delete(note);
        voice.source.removeEventListener?.("ended", cleanup);
        voice.source.onended = null;
      };
      voice.source.addEventListener?.("ended", cleanup);
      voice.source.onended = cleanup;
    }
  } catch (error) {
    console.error("Konnte Pianoton nicht wiedergeben:", error);
    updateRecordingStatus("Audio konnte nicht abgespielt werden.");
  }
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
  if (!ctx || isRecording || recordingPhase !== RecordingPhase.idle) {
    return;
  }

  if (!metronomeInstance) {
    updateRecordingStatus("Metronom ist nicht verfuegbar.");
    return;
  }

  stopPlayback();

  if (metronomeBeatListenerCleanup) {
    metronomeBeatListenerCleanup();
    metronomeBeatListenerCleanup = null;
  }

  if (!metronomeInstance.isActive()) {
    await metronomeInstance.start();
    metronomeStartedByRecorder = metronomeInstance.isActive();
  } else {
    metronomeStartedByRecorder = false;
  }

  if (!metronomeInstance.isActive()) {
    updateRecordingStatus("Metronom konnte nicht gestartet werden.");
    return;
  }

  recordingTimingSnapshot = null;
  recordedBeatTimeline = [];
  recordedEvents.length = 0;
  recordStartTime = 0;
  stopPending = false;
  stopTargetBeat = null;
  countInBeatsRemaining = Math.max(1, metronomeInstance.beatsPerBar);
  countInHasStarted = false;
  recordingPhase = RecordingPhase.countIn;

  metronomeBeatListenerCleanup = metronomeInstance.addBeatListener(handleRecordingBeat);

  recordBtn.disabled = true;
  stopBtn.disabled = false;
  playBtn.disabled = true;
  deleteBtn.disabled = true;
  saveBtn.disabled = true;
  if (practicePlayBtn) {
    practicePlayBtn.disabled = true;
  }

  updateRecordingStatus("Einzaehler vorbereitet - warte auf Taktbeginn ...");
  renderRecordingSummaryNotation("Einzaehler laeuft ...");
}

function handleRecordingBeat(beat) {
  if (recordingPhase === RecordingPhase.countIn) {
    const total = Math.max(1, metronomeInstance?.beatsPerBar ?? 1);
    if (!countInHasStarted) {
      if (!beat.accent) {
        updateRecordingStatus("Warte auf Taktbeginn ...");
        return;
      }
      countInHasStarted = true;
      countInBeatsRemaining = Math.max(0, total - 1);
      const completedFirst = total - countInBeatsRemaining;
      updateRecordingStatus(`Einzaehler ${completedFirst}/${total}`);
      if (countInBeatsRemaining <= 0) {
        recordingPhase = RecordingPhase.awaitingStart;
      }
      return;
    }

    countInBeatsRemaining = Math.max(0, countInBeatsRemaining - 1);
    const completed = total - countInBeatsRemaining;
    updateRecordingStatus(`Einzaehler ${completed}/${total}`);
    if (countInBeatsRemaining <= 0) {
      recordingPhase = RecordingPhase.awaitingStart;
    }
    return;
  }

  if (recordingPhase === RecordingPhase.awaitingStart) {
    beginActiveRecording(beat);
    return;
  }

  if (recordingPhase === RecordingPhase.recording) {
    recordedBeatTimeline.push(beat);
    if (stopPending && stopTargetBeat != null && beat.totalBeats + BEAT_EPSILON >= stopTargetBeat) {
      finalizeRecordingNow();
    }
  }
}

function beginActiveRecording(beat) {
  recordingPhase = RecordingPhase.recording;
  isRecording = true;
  countInHasStarted = false;
  recordStartTime = beat.time;
  recordingTimingSnapshot = metronomeInstance?.getTimingState(beat.time) ?? metronomeInstance?.getTimingState();
  recordedBeatTimeline = [beat];
  updateRecordingStatus("Aufnahme laeuft - spiele dein Pattern ein.");
  renderRecordingSummaryNotation("Aufnahme laeuft ...");
}

function stopRecording() {
  if (recordingPhase === RecordingPhase.idle) {
    return;
  }

  if (recordingPhase === RecordingPhase.countIn || recordingPhase === RecordingPhase.awaitingStart) {
    cleanupMetronomeListener();
    recordingPhase = RecordingPhase.idle;
    isRecording = false;
    countInBeatsRemaining = 0;
    countInHasStarted = false;
    stopPending = false;
    stopTargetBeat = null;
    recordStartTime = 0;
    recordingTimingSnapshot = null;
    recordedBeatTimeline = [];

    stopMetronomeIfNeeded();

    recordBtn.disabled = false;
    stopBtn.disabled = true;
    playBtn.disabled = recordedEvents.length === 0;
    deleteBtn.disabled = recordedEvents.length === 0;
    saveBtn.disabled = recordedEvents.length === 0;
    if (practicePlayBtn) {
      practicePlayBtn.disabled = recordedEvents.length === 0;
    }
    renderRecordingSummaryNotation(recordedEvents.length ? formatRecordingSummary(recordedEvents) : "Noch keine Aufnahme.");
    updateRecordingStatus("Aufnahme abgebrochen.");
    return;
  }

  if (recordingPhase === RecordingPhase.recording) {
    if (stopPending) {
      return;
    }

    const timing = metronomeInstance?.getTimingState();
    if (!timing) {
      finalizeRecordingNow();
      return;
    }

    const beatsPerBar = Math.max(1, timing.beatsPerBar || 1);
    const totalBeats = timing.totalBeats ?? 0;
    const currentBar = Math.floor(totalBeats / beatsPerBar);
    const beatPosition = totalBeats - currentBar * beatsPerBar;
    let targetBar = currentBar;
    if (Math.abs(beatPosition) > BEAT_EPSILON) {
      targetBar = currentBar + 1;
    }
    stopTargetBeat = targetBar * beatsPerBar;
    stopPending = true;
    stopBtn.disabled = true;
    updateRecordingStatus("Stop angefordert - schliesse aktuellen Takt ab ...");

    if (stopTargetBeat <= totalBeats + BEAT_EPSILON) {
      finalizeRecordingNow();
    }
  }
}

function finalizeRecordingNow() {
  if (recordingPhase === RecordingPhase.idle && !isRecording) {
    return;
  }

  isRecording = false;
  recordingPhase = RecordingPhase.idle;
  stopPending = false;
  countInBeatsRemaining = 0;
  countInHasStarted = false;
  stopTargetBeat = null;
  stopBtn.disabled = true;
  recordBtn.disabled = false;

  cleanupMetronomeListener();

  if (!recordingTimingSnapshot) {
    recordingTimingSnapshot = metronomeInstance?.getTimingState();
  }

  if (recordedEvents.length === 0) {
    updateRecordingStatus("Keine Noten aufgenommen. Versuche es noch einmal.");
    renderRecordingSummaryNotation("Noch keine Aufnahme.");
    playBtn.disabled = true;
    deleteBtn.disabled = true;
    saveBtn.disabled = true;
    if (practicePlayBtn) {
      practicePlayBtn.disabled = true;
    }
    if (practiceTextarea) {
      practiceTextarea.value = "";
    }
    if (templateNameInput) {
      templateNameInput.value = "";
    }
    lastTemplateName = "";
    stopMetronomeIfNeeded();
    return;
  }

  playBtn.disabled = false;
  deleteBtn.disabled = false;
  saveBtn.disabled = false;
  if (practicePlayBtn) {
    practicePlayBtn.disabled = false;
  }

  lastRecordingTiming = recordingTimingSnapshot;
  lastRecordingBeatTimeline = recordedBeatTimeline.slice();
  recordingTimingSnapshot = null;
  recordedBeatTimeline = [];

  updateRecordingStatus("Aufnahme beendet. Du kannst nun anhoeren, speichern oder loeschen.");
  updatePracticeArea(lastTemplateName || "Letzte Aufnahme");
  stopMetronomeIfNeeded();
}

function cleanupMetronomeListener() {
  if (metronomeBeatListenerCleanup) {
    metronomeBeatListenerCleanup();
    metronomeBeatListenerCleanup = null;
  }
}

function stopMetronomeIfNeeded() {
  if (metronomeStartedByRecorder && metronomeInstance?.isActive()) {
    metronomeInstance.stop();
  }
  metronomeStartedByRecorder = false;
}

function stopMetronomeAfterPlayback() {
  if (metronomeStartedForPlayback && metronomeInstance?.isActive()) {
    metronomeInstance.stop();
  }
  metronomeStartedForPlayback = false;
}

function clearRecording(showStatus = true) {
  stopPlayback();
  recordedEvents.length = 0;
  isRecording = false;
  recordStartTime = 0;
  lastTemplateName = "";

  cleanupMetronomeListener();

  recordingPhase = RecordingPhase.idle;
  countInBeatsRemaining = 0;
  countInHasStarted = false;
  stopPending = false;
  stopTargetBeat = null;

  recordingTimingSnapshot = null;
  lastRecordingTiming = null;
  recordedBeatTimeline = [];
  lastRecordingBeatTimeline = [];

  recordBtn.disabled = false;
  stopBtn.disabled = true;
  playBtn.disabled = true;
  deleteBtn.disabled = true;
  saveBtn.disabled = true;
    if (practicePlayBtn) {
      practicePlayBtn.disabled = true;
    }

  renderRecordingSummaryNotation("Noch keine Aufnahme.");
  if (showStatus) {
    updateRecordingStatus("Aufnahme geloescht.");
  }
  if (practiceTextarea) {
    practiceTextarea.value = "";
  }
  if (templateNameInput) {
    templateNameInput.value = "";
  }
  stopMetronomeIfNeeded();
}

async function playRecording() {
  if (isRecording || isPlayingBack || recordedEvents.length === 0) return;

  const ctx = await getAudioContext();
  if (!ctx) return;

  stopPlayback();
  isPlayingBack = true;
  recordBtn.disabled = true;
  playBtn.disabled = true;
  if (practicePlayBtn) {
    practicePlayBtn.disabled = true;
  }

  const shouldSyncWithMetronome = playbackMetronomeToggle ? playbackMetronomeToggle.checked : false;
  let tempoScale = 1;

  const recordedBeatLength =
    lastRecordingTiming && Number.isFinite(lastRecordingTiming.beatLengthSeconds) && lastRecordingTiming.beatLengthSeconds > 0
      ? lastRecordingTiming.beatLengthSeconds
      : null;

  if (shouldSyncWithMetronome && metronomeInstance) {
    const currentBeatLength = 60 / metronomeInstance.bpm;
    if (recordedBeatLength) {
      tempoScale = currentBeatLength / recordedBeatLength;
    }
    if (!metronomeInstance.isActive()) {
      await metronomeInstance.start();
      metronomeStartedForPlayback = metronomeInstance.isActive();
    } else {
      metronomeStartedForPlayback = false;
    }
  } else {
    metronomeStartedForPlayback = false;
  }

  const startAt = ctx.currentTime + 0.08;
  const lastEvent = recordedEvents[recordedEvents.length - 1];
  const totalDuration = lastEvent.time * tempoScale + lastEvent.duration * tempoScale + 0.25;

  recordedEvents.forEach((event, index) => {
    const eventStart = startAt + event.time * tempoScale;
    const nextEvent = recordedEvents[index + 1];
    const eventDuration = nextEvent ? Math.max((nextEvent.time - event.time) * tempoScale, 0.06) : undefined;
    scheduleTone(ctx, event.note, eventStart, eventDuration, playbackGainNode ?? ctx.destination);
  });

  playbackTimeouts.push(
    window.setTimeout(() => {
      stopPlayback();
      updateRecordingStatus("Wiedergabe beendet.");
    }, totalDuration * 1000)
  );

  updateRecordingStatus(shouldSyncWithMetronome ? "Spiele Aufnahme (Metronomtempo) ab ..." : "Spiele Aufnahme ab ...");
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
    if (practicePlayBtn) {
      practicePlayBtn.disabled = false;
    }
  }
  recordBtn.disabled = false;
  stopMetronomeAfterPlayback();
}

function saveRecordingAsTemplate() {
  if (recordedEvents.length === 0) {
    updateRecordingStatus("Keine Aufnahme vorhanden. Bitte zuerst aufnehmen.");
    return;
  }
  const rawName = templateNameInput ? templateNameInput.value.trim() : "";
  const name = rawName || "Unbenannte Vorlage";
  if (templateNameInput && !rawName) {
    templateNameInput.value = name;
  }
  lastTemplateName = name;
  updatePracticeArea(name);
  updateRecordingStatus(`Vorlage "${name}" gespeichert. Du findest sie in "Meine Uebung".`);
}

function updatePracticeArea(name) {
  const summary = formatRecordingSummary(recordedEvents);
  renderRecordingSummaryNotation(summary);
  if (practiceTextarea) {
    practiceTextarea.value = `${name}: ${summary}`;
  }
  if (practicePlayBtn) {
    practicePlayBtn.disabled = recordedEvents.length === 0;
  }
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
  ensureAudioGraph(audioCtx);
  return audioCtx;
}

function ensureAudioGraph(ctx) {
  if (!ctx) return;
  if (!keyboardGainNode) {
    keyboardGainNode = ctx.createGain();
    keyboardGainNode.connect(ctx.destination);
  }
  if (!playbackGainNode) {
    playbackGainNode = ctx.createGain();
    playbackGainNode.connect(ctx.destination);
  }
  updateKeyboardVolume(ctx);
  updatePlaybackVolume(ctx);
}

function updateKeyboardVolume(ctx = audioCtx) {
  if (keyboardGainNode && ctx) {
    keyboardGainNode.gain.setTargetAtTime(keyboardVolumeValue, ctx.currentTime, 0.01);
  }
}

function updatePlaybackVolume(ctx = audioCtx) {
  if (playbackGainNode && ctx) {
    playbackGainNode.gain.setTargetAtTime(playbackVolumeValue, ctx.currentTime, 0.01);
  }
}

function sliderValueToGain(value) {
  const numeric = Math.max(0, Math.min(100, Number(value)));
  const normalized = numeric / 100;
  return normalized * normalized;
}

function stopActiveKeyboardNote(note, time = audioCtx?.currentTime ?? 0) {
  if (!activeKeyboardSources.size) return;
  const stopTime = Math.max(time, audioCtx?.currentTime ?? time);
  activeKeyboardSources.forEach((voice, key) => {
    if (!voice) return;
    try {
      voice.stop(stopTime);
    } catch (error) {
      console.warn("Konnte aktiven Ton nicht stoppen:", error);
    }
    activeKeyboardSources.delete(key);
  });
}

function scheduleTone(ctx, note, when, duration, destination) {
  playPianoNote(ctx, note, when, {
    duration,
    destination: destination ?? ctx.destination
  }).catch((error) => {
    console.error("Konnte Pianoton nicht planen:", error);
  });
  const delay = Math.max(0, (when - ctx.currentTime) * 1000);
  const highlightDuration = Math.max(50, (duration ?? DEFAULT_NOTE_DURATION) * 1000);
  const timeoutId = window.setTimeout(() => {
    flashKey(note, "playback-active", highlightDuration);
  }, delay);
  playbackTimeouts.push(timeoutId);
}

function flashKey(note, className, durationMs) {
  if (!keyElements) return;
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
    const el = keyElements?.get(note);
    el?.classList.remove("playback-active");
  });
}
