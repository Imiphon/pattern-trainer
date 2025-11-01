import { DEFAULT_NOTE_DURATION, RecordingPhase, BEAT_EPSILON, DEFAULT_TEMPLATES } from "./constants.js";
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
const recordingSummaryNotation = document.getElementById("recordingSummaryNotation");
const templateGrid = document.getElementById("templateGrid");
const practiceDropZone = document.getElementById("practiceDropZone");
const practiceHint = document.getElementById("practiceHint");
const practiceQueueEl = document.getElementById("practiceQueue");
const practiceQueuePlayBtn = document.getElementById("practiceQueuePlay");
const practiceQueueClearBtn = document.getElementById("practiceQueueClear");
const practiceRepeatsSelect = document.getElementById("practiceRepeats");
const practicePauseBarsSelect = document.getElementById("practicePauseBars");

const metronomeBpmInput = document.getElementById("metronomeBpm");
const metronomeBeatsInput = document.getElementById("metronomeBeats");
const metronomeToggleBtn = document.getElementById("metronomeToggle");
const metronomeVolumeSlider = document.getElementById("metronomeVolume");
const keyboardVolumeSlider = document.getElementById("keyboardVolume");
const playbackVolumeSlider = document.getElementById("playbackVolume");
const playbackMetronomeToggle = document.getElementById("playbackMetronomeToggle");

const TEMPLATE_DRAG_KEY = "application/x-template-id";
const QUEUE_DRAG_KEY = "application/x-practice-queue-index";

let keyboardGainNode = null;
let playbackGainNode = null;
let metronomeStartedForPlayback = false;
let keyboardVolumeValue = sliderValueToGain(keyboardVolumeSlider?.value ?? 90);
let playbackVolumeValue = sliderValueToGain(playbackVolumeSlider?.value ?? 80);
let metronomeVolumeValue = sliderValueToGain(metronomeVolumeSlider?.value ?? 80);
const activeKeyboardSources = new Map();
let savedTemplates = [];
let practiceQueue = [];
let draggingQueueIndex = null;

if (keyboardEl) {
  keyElements = createKeyboard(keyboardEl, triggerNotePlayback);
}

initializeTemplates();

if (recordBtn && stopBtn && playBtn && deleteBtn && saveBtn) {
  recordBtn.addEventListener("click", startRecording);
  stopBtn.addEventListener("click", stopRecording);
  playBtn.addEventListener("click", () => playRecording());
  deleteBtn.addEventListener("click", () => clearRecording());
  saveBtn.addEventListener("click", saveRecordingAsTemplate);
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

if (practiceQueuePlayBtn) {
  practiceQueuePlayBtn.addEventListener("click", playPracticeQueue);
}

if (practiceQueueClearBtn) {
  practiceQueueClearBtn.addEventListener("click", clearPracticeQueue);
}

if (practiceQueueEl) {
  practiceQueueEl.addEventListener("dragover", handlePracticeQueueDragOver);
  practiceQueueEl.addEventListener("dragleave", handlePracticeQueueDragLeave);
  practiceQueueEl.addEventListener("drop", handlePracticeQueueDrop);
}

if (practiceDropZone && practiceDropZone !== practiceQueueEl) {
  practiceDropZone.addEventListener("dragover", handlePracticeQueueDragOver);
  practiceDropZone.addEventListener("dragleave", handlePracticeQueueDragLeave);
  practiceDropZone.addEventListener("drop", handlePracticeQueueDrop);
}

if (practiceRepeatsSelect) {
  practiceRepeatsSelect.addEventListener("change", () => {
    updateRecordingStatus(`Wiederholungen: ${practiceRepeatsSelect.value}`);
  });
}

if (practicePauseBarsSelect) {
  practicePauseBarsSelect.addEventListener("change", () => {
    updateRecordingStatus(`Pause vor Wiederholung: ${practicePauseBarsSelect.value} Takte`);
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

if (practiceQueueEl) {
  practiceQueueEl.addEventListener("dragover", handlePracticeQueueDragOver);
  practiceQueueEl.addEventListener("dragleave", handlePracticeQueueDragLeave);
  practiceQueueEl.addEventListener("drop", handlePracticeQueueDrop);
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
  updatePracticeQueueControls();

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
    updatePracticeQueueControls();
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
    updatePracticeQueueControls();
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
  updatePracticeQueueControls();

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

function generateTemplateName() {
  const existing = savedTemplates.filter((tpl) => tpl.id.startsWith("user-"));
  return `Aufnahme ${existing.length + 1}`;
}

function clearPracticeQueue() {
  if (isPlayingBack) {
    stopPlayback();
  }
  practiceQueue.length = 0;
  renderPracticeQueue();
  clearDropHighlights();
  updateRecordingStatus("Übungs-Queue geleert.");
}

function handleQueueItemDragStart(event, index) {
  draggingQueueIndex = index;
  const dt = event.dataTransfer;
  if (dt) {
    dt.effectAllowed = "move";
    dt.setData(QUEUE_DRAG_KEY, String(index));
    dt.setData("text/plain", String(index));
  }
  event.currentTarget?.classList.add("is-dragging");
  setDropZoneHighlight(true);
}

function handleQueueItemDragEnter(event) {
  if (!isQueueDrag(event)) return;
  const target = event.currentTarget;
  target?.classList.add("is-drag-over");
}

function handleQueueItemDragOver(event, index) {
  if (!isQueueDrag(event)) return;
  event.preventDefault();
  if (event.dataTransfer) {
    event.dataTransfer.dropEffect = "move";
  }
  const target = event.currentTarget;
  target?.classList.add("is-drag-over");
}

function handleQueueItemDragLeave(event) {
  const target = event.currentTarget;
  target?.classList.remove("is-drag-over");
}

function handleQueueItemDrop(event, index) {
  if (!isQueueDrag(event)) return;
  event.preventDefault();
  const target = event.currentTarget;
  target?.classList.remove("is-drag-over");

  const fromIndex =
    draggingQueueIndex ?? parseInt(event.dataTransfer?.getData(QUEUE_DRAG_KEY) ?? "-1", 10);
  if (Number.isNaN(fromIndex) || fromIndex < 0 || fromIndex >= practiceQueue.length) {
    clearQueueDragState();
    return;
  }

  let toIndex = index;
  if (fromIndex < toIndex) {
    toIndex -= 1;
  }
  toIndex = Math.max(0, Math.min(toIndex, practiceQueue.length - 1));

  if (fromIndex === toIndex) {
    clearQueueDragState();
    return;
  }

  const [entry] = practiceQueue.splice(fromIndex, 1);
  practiceQueue.splice(toIndex, 0, entry);
  renderPracticeQueue();
  updateRecordingStatus(`Vorlage "${entry.name}" verschoben.`);
  clearQueueDragState();
}

function handleQueueItemDragEnd(event) {
  event.currentTarget?.classList.remove("is-dragging");
  clearQueueDragState();
}

function removePracticeQueueItem(index) {
  const removed = practiceQueue[index];
  practiceQueue.splice(index, 1);
  renderPracticeQueue();
  if (removed) {
    updateRecordingStatus(`Vorlage "${removed.name}" aus der Übungs-Queue entfernt.`);
  } else {
    updateRecordingStatus("Eintrag aus der Übungs-Queue entfernt.");
  }
}

function updatePracticeQueueControls() {
  const hasItems = practiceQueue.length > 0;
  if (practiceHint) {
    practiceHint.hidden = hasItems;
  }
  if (practiceQueuePlayBtn) {
    practiceQueuePlayBtn.disabled = !hasItems || isRecording || isPlayingBack;
  }
  if (practiceQueueClearBtn) {
    practiceQueueClearBtn.disabled = !hasItems;
  }
}

function updateRecordingNotationVisibility() {
  if (!recordingSummaryNotation) return;
  recordingSummaryNotation.style.display = practiceQueue.length > 0 ? "none" : "";
}

function handleTemplateDelete(templateId) {
  const template = savedTemplates.find((tpl) => tpl.id === templateId);
  if (!template) return;
  const confirmed = window.confirm(`Vorlage "${template.name}" wirklich löschen?`);
  if (!confirmed) return;
  savedTemplates = savedTemplates.filter((tpl) => tpl.id !== templateId);
  practiceQueue = practiceQueue.filter((entry) => entry.templateId !== templateId);
  renderTemplates();
  renderPracticeQueue();
  updateRecordingStatus(`Vorlage "${template.name}" gelöscht.`);
}

function playPracticeQueue() {
  if (!practiceQueue.length || isRecording) return;
  const repeats = Math.max(1, parseInt(practiceRepeatsSelect?.value ?? "1", 10));
  const pauseBars = Math.max(0, parseInt(practicePauseBarsSelect?.value ?? "0", 10));
  const singleCycleEvents = [];
  let cycleDuration = 0;

  practiceQueue.forEach((entry) => {
    entry.events.forEach((event) => {
      singleCycleEvents.push({
        note: event.note,
        time: cycleDuration + event.time,
        duration: event.duration ?? DEFAULT_NOTE_DURATION
      });
    });
    cycleDuration += getTemplateDuration(entry.events) + 0.05;
  });

  const baseBeatLength = getQueueBeatLength(singleCycleEvents);
  const beatsPerBar = metronomeInstance?.beatsPerBar ?? 4;
  const pauseDuration = pauseBars * baseBeatLength * beatsPerBar;

  const aggregatedEvents = [];
  for (let r = 0; r < repeats; r += 1) {
    const repeatOffset = r * (cycleDuration + pauseDuration);
    singleCycleEvents.forEach((event) => {
      aggregatedEvents.push({
        note: event.note,
        time: repeatOffset + event.time,
        duration: event.duration
      });
    });
  }

  if (!aggregatedEvents.length) {
    updateRecordingStatus("Keine Noten zum Abspielen in der Übungs-Queue.");
    return;
  }

  const syncWithMetronome = playbackMetronomeToggle ? playbackMetronomeToggle.checked : false;
  playDynamicSequence(aggregatedEvents, "Übungs-Queue spielt ab ...", { syncWithMetronome });
}

async function playDynamicSequence(events, statusMessage, options = {}) {
  const ctx = await getAudioContext();
  if (!ctx) return;

  stopPlayback();
  isPlayingBack = true;
  recordBtn.disabled = true;
  playBtn.disabled = true;
  updatePracticeQueueControls();

  const shouldSyncWithMetronome = options.syncWithMetronome ?? (playbackMetronomeToggle ? playbackMetronomeToggle.checked : false);
  let tempoScale = 1;
  const baseBeatLength = getQueueBeatLength(events);

  if (shouldSyncWithMetronome && metronomeInstance) {
    const currentBeatLength = 60 / metronomeInstance.bpm;
    tempoScale = currentBeatLength / baseBeatLength;
    if (!metronomeInstance.isActive()) {
      await metronomeInstance.start();
      metronomeStartedForPlayback = metronomeInstance.isActive();
    } else {
      metronomeStartedForPlayback = false;
    }
  } else {
    metronomeStartedForPlayback = false;
  }

  const startAt = ctx.currentTime + 0.1;
  let totalDuration = 0;

  events.forEach((event) => {
    const scaledStart = startAt + event.time * tempoScale;
    const scaledDuration = Math.max(event.duration * tempoScale, 0.05);
    totalDuration = Math.max(totalDuration, event.time * tempoScale + scaledDuration);
    scheduleTone(ctx, event.note, scaledStart, scaledDuration, playbackGainNode ?? ctx.destination);
  });

  playbackTimeouts.push(
    window.setTimeout(() => {
      stopPlayback();
      updateRecordingStatus("Wiedergabe beendet.");
    }, totalDuration * 1000 + 200)
  );

  updateRecordingStatus(statusMessage ?? "Wiedergabe läuft ...");
}

function getTemplateDuration(events) {
  if (!events?.length) return DEFAULT_NOTE_DURATION;
  return events.reduce((max, event) => {
    const duration = event.duration ?? DEFAULT_NOTE_DURATION;
    return Math.max(max, event.time + duration);
  }, 0);
}

function getQueueBeatLength(events) {
  if (!events.length) return DEFAULT_NOTE_DURATION;
  if (events.length === 1) return events[0].duration ?? DEFAULT_NOTE_DURATION;
  const sorted = [...events].sort((a, b) => a.time - b.time);
  for (let i = 1; i < sorted.length; i += 1) {
    const diff = sorted[i].time - sorted[i - 1].time;
    if (diff > 0.01) {
      return diff;
    }
  }
  return DEFAULT_NOTE_DURATION;
}

function isElementInDropArea(element) {
  if (!element) return false;
  if (practiceDropZone && (element === practiceDropZone || practiceDropZone.contains(element))) return true;
  if (practiceQueueEl && (element === practiceQueueEl || practiceQueueEl.contains(element))) return true;
  return false;
}

function setDropZoneHighlight(active) {
  if (practiceDropZone) {
    practiceDropZone.classList.toggle("is-drag-over", !!active);
  }
}

function clearDropHighlights() {
  setDropZoneHighlight(false);
  if (practiceQueueEl) {
    practiceQueueEl.classList.remove("is-drag-over");
    practiceQueueEl.querySelectorAll(".practice-queue__item.is-drag-over").forEach((el) => {
      el.classList.remove("is-drag-over");
    });
    practiceQueueEl.querySelectorAll(".practice-queue__item.is-dragging").forEach((el) => {
      el.classList.remove("is-dragging");
    });
  }
}

function isTemplateDrag(event) {
  if (isQueueDrag(event)) return false;
  const dt = event.dataTransfer;
  if (!dt) return false;
  return dt.types?.includes(TEMPLATE_DRAG_KEY);
}

function isQueueDrag(event) {
  if (draggingQueueIndex !== null) return true;
  const dt = event.dataTransfer;
  return !!dt?.types?.includes(QUEUE_DRAG_KEY);
}

function clearQueueDragState() {
  draggingQueueIndex = null;
  clearDropHighlights();
}

function findTemplateById(id) {
  return savedTemplates.find((tpl) => tpl.id === id);
}

function releasePointerCaptureSafe(target, pointerId) {
  if (typeof target.releasePointerCapture === "function") {
    try {
      target.releasePointerCapture(pointerId);
    } catch (err) {
      // ignore
    }
  }
}

function cleanupTemplateTouchData(target) {
  delete target.dataset.touchTemplateId;
  delete target.dataset.touchStartX;
  delete target.dataset.touchStartY;
}

function playTemplatePreview(template) {
  if (!template?.events?.length) {
    updateRecordingStatus("Diese Vorlage enthält keine Noten.");
    return;
  }
  const clonedEvents = template.events.map((event) => ({ ...event }));
  playDynamicSequence(clonedEvents, `Vorlage "${template.name}" spielt ab ...`, {
    syncWithMetronome: false
  });
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
  updatePracticeQueueControls();

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
  updatePracticeQueueControls();

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
  }
  recordBtn.disabled = false;
  stopMetronomeAfterPlayback();
  updatePracticeQueueControls();
}

function saveRecordingAsTemplate() {
  if (recordedEvents.length === 0) {
    updateRecordingStatus("Keine Aufnahme vorhanden. Bitte zuerst aufnehmen.");
    return;
  }
  const rawName = templateNameInput ? templateNameInput.value.trim() : "";
  const name = rawName || generateTemplateName();
  if (templateNameInput && !rawName) {
    templateNameInput.value = name;
  }

  const template = {
    id: `user-${Date.now()}`,
    name,
    description: `Aufnahme ${savedTemplates.filter((tpl) => tpl.id.startsWith("user-")).length + 1}`,
    events: recordedEvents.map((event) => ({ ...event }))
  };

  savedTemplates.push(template);
  renderTemplates();

  lastTemplateName = name;
  updatePracticeArea(name);
  updateRecordingStatus(`Vorlage "${name}" gespeichert. Du findest sie in "Vorlagen".`);
}

function updatePracticeArea(name) {
  const summary = formatRecordingSummary(recordedEvents);
  renderRecordingSummaryNotation(summary);
  if (practiceTextarea) {
    practiceTextarea.value = `${name}: ${summary}`;
  }
  updatePracticeQueueControls();
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

function initializeTemplates() {
  if (!templateGrid) return;
  savedTemplates = DEFAULT_TEMPLATES.map((tpl, index) => ({
    id: `default-${index}`,
    name: tpl.name,
    description: tpl.description,
    events: tpl.events ? tpl.events.map((event) => ({ ...event })) : []
  }));
  renderTemplates();
  renderPracticeQueue();
}

function renderTemplates() {
  if (!templateGrid) return;
  templateGrid.innerHTML = "";
  savedTemplates.forEach((template) => {
    const card = document.createElement("div");
    card.className = "template-card";
    card.dataset.templateId = template.id;

    const header = document.createElement("div");
    header.className = "template-card__header";

    const nameEl = document.createElement("span");
    nameEl.className = "template-name";
    nameEl.textContent = template.name;

    const actionsEl = document.createElement("div");
    actionsEl.className = "template-card__actions";

    const playBtn = document.createElement("button");
    playBtn.type = "button";
    playBtn.className = "template-card__icon-btn";
    playBtn.setAttribute("aria-label", `Vorlage ${template.name} abspielen`);
    playBtn.textContent = "▶";
    playBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      playTemplatePreview(template);
    });

    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "template-card__icon-btn template-card__icon-btn--delete";
    deleteBtn.setAttribute("aria-label", `Vorlage ${template.name} löschen`);
    deleteBtn.textContent = "🗑";
    deleteBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      handleTemplateDelete(template.id);
    });

    actionsEl.append(playBtn, deleteBtn);
    header.append(nameEl, actionsEl);
    card.append(header);

    card.draggable = true;
    card.addEventListener("dragstart", (event) => handleTemplateDragStart(event, template.id));
    card.addEventListener("dragend", handleTemplateDragEnd);
    card.addEventListener("pointerdown", (event) => handleTemplatePointerDown(event, template.id));
    card.addEventListener("pointermove", handleTemplatePointerMove);
    card.addEventListener("pointerup", (event) => handleTemplatePointerUp(event, template.id));
    card.addEventListener("pointercancel", handleTemplatePointerCancel);
    templateGrid.appendChild(card);
  });
}

function addTemplateToQueue(template) {
  if (!template?.events?.length) {
    updateRecordingStatus("Diese Vorlage enthält keine Noten.");
    return;
  }
  const entry = {
    id: `queue-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    templateId: template.id,
    name: template.name,
    events: template.events.map((event) => ({ ...event }))
  };
  practiceQueue.push(entry);
  clearDropHighlights();
  renderPracticeQueue();
  updateRecordingStatus(`Vorlage "${template.name}" zur Übung hinzugefügt.`);
}

function renderPracticeQueue() {
  if (!practiceQueueEl) return;
  practiceQueueEl.innerHTML = "";
  practiceQueue.forEach((entry, index) => {
    const item = document.createElement("li");
    item.className = "practice-queue__item";
    item.dataset.queueId = entry.id;

    const nameEl = document.createElement("p");
    nameEl.className = "practice-queue__name";
    nameEl.textContent = entry.name;

    const actionsEl = document.createElement("div");
    actionsEl.className = "practice-queue__actions";

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "practice-queue__btn practice-queue__btn--remove";
    removeBtn.setAttribute("aria-label", `${entry.name} aus Übung entfernen`);
    removeBtn.textContent = "✕";
    removeBtn.addEventListener("click", () => removePracticeQueueItem(index));
    actionsEl.append(removeBtn);

    item.append(nameEl, actionsEl);
    item.draggable = true;
    item.addEventListener("dragstart", (event) => handleQueueItemDragStart(event, index));
    item.addEventListener("dragenter", handleQueueItemDragEnter);
    item.addEventListener("dragover", (event) => handleQueueItemDragOver(event, index));
    item.addEventListener("dragleave", handleQueueItemDragLeave);
    item.addEventListener("drop", (event) => handleQueueItemDrop(event, index));
    item.addEventListener("dragend", handleQueueItemDragEnd);
    practiceQueueEl.appendChild(item);
  });
  updatePracticeQueueControls();
  updateRecordingNotationVisibility();
}

function handleTemplateDragStart(event, templateId) {
  const dt = event.dataTransfer;
  if (dt) {
    dt.setData(TEMPLATE_DRAG_KEY, templateId);
    dt.setData("text/plain", templateId);
    dt.effectAllowed = "copy";
  }
  event.currentTarget?.classList.add("is-dragging");
  setDropZoneHighlight(true);
}

function handleTemplateDragEnd(event) {
  event.currentTarget?.classList.remove("is-dragging");
  clearDropHighlights();
}

function handlePracticeQueueDragOver(event) {
  if (!isTemplateDrag(event)) return;
  event.preventDefault();
  if (event.dataTransfer) {
    event.dataTransfer.dropEffect = "copy";
  }
  const target = event.currentTarget;
  if (target && target.classList) {
    target.classList.add("is-drag-over");
  }
  setDropZoneHighlight(true);
}

function handlePracticeQueueDragLeave(event) {
  const target = event.currentTarget;
  if (!target || !target.classList) return;
  const related = event.relatedTarget;
  if (!related || !target.contains(related)) {
    target.classList.remove("is-drag-over");
  }
  if (!isElementInDropArea(related)) {
    clearDropHighlights();
  }
}

function handlePracticeQueueDrop(event) {
  if (isQueueDrag(event)) {
    event.preventDefault();
    const target = event.currentTarget;
    if (target && target.classList) {
      target.classList.remove("is-drag-over");
    }
    const fromIndex =
      draggingQueueIndex ?? parseInt(event.dataTransfer?.getData(QUEUE_DRAG_KEY) ?? "-1", 10);
    if (!Number.isNaN(fromIndex) && fromIndex >= 0 && fromIndex < practiceQueue.length) {
      const [entry] = practiceQueue.splice(fromIndex, 1);
      practiceQueue.push(entry);
      renderPracticeQueue();
      updateRecordingStatus(`Vorlage "${entry.name}" verschoben.`);
    }
    clearQueueDragState();
    return;
  }
  if (!isTemplateDrag(event)) return;
  event.preventDefault();
  const target = event.currentTarget;
  if (target && target.classList) {
    target.classList.remove("is-drag-over");
  }
  const templateId = event.dataTransfer.getData(TEMPLATE_DRAG_KEY) || event.dataTransfer.getData("text/plain");
  const template = findTemplateById(templateId);
  if (template) {
    addTemplateToQueue(template);
  }
  clearDropHighlights();
}

function handleTemplatePointerDown(event, templateId) {
  if (event.pointerType !== "touch") return;
  const target = event.currentTarget;
  if (!target || typeof target.setPointerCapture !== "function") return;
  try {
    target.setPointerCapture(event.pointerId);
  } catch (err) {
    // ignore
  }
  target.dataset.touchTemplateId = templateId;
  target.dataset.touchStartX = String(event.clientX ?? 0);
  target.dataset.touchStartY = String(event.clientY ?? 0);
}

function handleTemplatePointerUp(event, templateId) {
  if (event.pointerType !== "touch") return;
  const target = event.currentTarget;
  if (!target) return;
  releasePointerCaptureSafe(target, event.pointerId);
  cleanupTemplateTouchData(target);
  const template = findTemplateById(templateId);
  if (!template) return;

  const dropTarget = document.elementFromPoint(event.clientX, event.clientY);
  const overDrop = isElementInDropArea(dropTarget);

  if (overDrop) {
    addTemplateToQueue(template);
    clearDropHighlights();
    return;
  }

  playTemplatePreview(template);
  clearDropHighlights();
}

function handleTemplatePointerCancel(event) {
  const target = event.currentTarget;
  if (!target) return;
  releasePointerCaptureSafe(target, event.pointerId);
  cleanupTemplateTouchData(target);
  clearDropHighlights();
}

function handleTemplatePointerMove(event) {
  if (event.pointerType !== "touch") return;
  const dropTarget = document.elementFromPoint(event.clientX, event.clientY);
  const overDrop = isElementInDropArea(dropTarget);
  setDropZoneHighlight(overDrop);
  if (!overDrop) {
    practiceQueueEl?.classList.remove("is-drag-over");
  }
}
