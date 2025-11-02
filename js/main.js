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
const QUANTIZE_PRESETS = [
  { value: "whole", label: "Ganze", beatMultiplier: 4, icon: "./assets/images/notes/1-1.png" },
  { value: "half", label: "Halbe", beatMultiplier: 2, icon: "./assets/images/notes/1-2.png" },
  { value: "quarter", label: "Viertel", beatMultiplier: 1, icon: "./assets/images/notes/1-4.png" },
  { value: "eighth", label: "Achtel", beatMultiplier: 0.5, icon: "./assets/images/notes/1-8.png" },
  { value: "sixteenth", label: "Sechzehntel", beatMultiplier: 0.25, icon: "./assets/images/notes/1-16.png" },
  { value: "eighthTriplet", label: "Achtel-Triolen", beatMultiplier: 1 / 3, icon: "./assets/images/notes/3-8.png" }
];
const QUANTIZE_RESOLUTIONS = QUANTIZE_PRESETS.reduce((acc, preset) => {
  acc[preset.value] = { label: preset.label, beatMultiplier: preset.beatMultiplier };
  return acc;
}, {});
const DEFAULT_QUANTIZE_MODE = "quarter";
const NOTE_TIME_EPSILON = 0.0001;
const EXTRA_SUSTAIN_SECONDS = 0.1;
const MAX_FORCED_SUSTAIN_RATIO = 2.5;
const quantizeToggleBtn = document.getElementById("quantizeToggle");
const quantizeModeSelect = document.getElementById("quantizeMode");
const quantizeSelectWrapper = document.querySelector("[data-quantize-select]");
const quantizeModeToggleBtn = document.getElementById("quantizeModeToggle");
const quantizeModeList = document.getElementById("quantizeModeList");
let quantizeOptionElements = [];
const quantizeOptionData = new Map();

let keyboardGainNode = null;
let playbackGainNode = null;
let metronomeStartedForPlayback = false;
let metronomeStartedForCountIn = false;
let keyboardVolumeValue = sliderValueToGain(keyboardVolumeSlider?.value ?? 90);
let playbackVolumeValue = sliderValueToGain(playbackVolumeSlider?.value ?? 80);
let metronomeVolumeValue = sliderValueToGain(metronomeVolumeSlider?.value ?? 80);
const activeKeyboardSources = new Map();
let savedTemplates = [];
let practiceQueue = [];
let draggingQueueIndex = null;
let isQuantizationEnabled = false;
let lastQuantizeMode = DEFAULT_QUANTIZE_MODE;
let isQuantizeMenuOpen = false;
let quantizeFocusedOptionIndex = -1;

function renderQuantizeOptions() {
  if (!quantizeModeList) return;
  quantizeModeList.innerHTML = "";
  quantizeOptionData.clear();

  QUANTIZE_PRESETS.forEach(({ value, label, icon }, index) => {
    const option = document.createElement("li");
    option.className = "quantize-select__option";
    option.setAttribute("role", "option");
    option.dataset.value = value;
    option.dataset.label = label;
    if (icon) {
      option.dataset.icon = icon;
    }
    option.setAttribute("tabindex", "-1");
    option.setAttribute("aria-selected", "false");

  const iconWrapper = document.createElement("span");
  iconWrapper.className = "quantize-select__option-icon";
  iconWrapper.setAttribute("aria-hidden", "true");
  const img = document.createElement("img");
  img.src = icon;
  img.alt = "";
  iconWrapper.appendChild(img);
  option.appendChild(iconWrapper);

    quantizeModeList.appendChild(option);
    quantizeOptionData.set(value, { label, icon, index });
  });

  quantizeOptionElements = Array.from(quantizeModeList.querySelectorAll(".quantize-select__option"));
  quantizeOptionElements.forEach((option, index) => {
    option.addEventListener("click", () => {
      if (quantizeModeToggleBtn?.disabled) return;
      const { value } = option.dataset;
      if (!value) return;
      selectQuantizeOption(value);
    });
    option.addEventListener("keydown", (event) => handleQuantizeOptionKeydown(event, index));
  });
}

renderQuantizeOptions();

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

if (quantizeToggleBtn && quantizeModeSelect) {
  quantizeToggleBtn.addEventListener("click", () => {
    if (!recordedEvents.length) return;
    isQuantizationEnabled = !isQuantizationEnabled;
    updateQuantizationControls();
    refreshQuantizationPreview();
  });
  quantizeModeSelect.addEventListener("change", () => {
    const selectedValue = getSelectedQuantizeMode();
    updateQuantizeToggleDisplay(selectedValue);
    updateQuantizeOptionSelection(selectedValue);
    if (recordedEvents.length && isQuantizationEnabled) {
      refreshQuantizationPreview();
    }
  });
}

if (quantizeModeToggleBtn) {
  quantizeModeToggleBtn.addEventListener("click", () => {
    if (quantizeModeToggleBtn.disabled) return;
    if (isQuantizeMenuOpen) {
      closeQuantizeMenu(true);
    } else {
      openQuantizeMenu();
    }
  });
  quantizeModeToggleBtn.addEventListener("keydown", handleQuantizeToggleKeydown);
}

if (quantizeModeSelect) {
  let initialValue = quantizeModeSelect.value || DEFAULT_QUANTIZE_MODE;
  if (!quantizeOptionData.has(initialValue)) {
    initialValue = quantizeOptionElements[0]?.dataset.value ?? DEFAULT_QUANTIZE_MODE;
    quantizeModeSelect.value = initialValue;
  }
  selectQuantizeOption(initialValue, { closeMenu: false, silent: true });
  lastQuantizeMode = initialValue;
}

updateQuantizationControls();

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
  resetQuantizationState();
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
    updateQuantizationControls();
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
  updateQuantizationControls();

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
  if ((metronomeStartedForPlayback || metronomeStartedForCountIn) && metronomeInstance?.isActive()) {
    metronomeInstance.stop();
  }
  metronomeStartedForPlayback = false;
  metronomeStartedForCountIn = false;
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
  const countInBeats = Math.max(1, beatsPerBar);
  playDynamicSequence(aggregatedEvents, "Übungs-Queue spielt ab ...", {
    syncWithMetronome,
    countInBeats,
    baseBeatLength
  });
}

async function playDynamicSequence(events, statusMessage, options = {}) {
  const ctx = await getAudioContext();
  if (!ctx) return;

  stopPlayback();
  isPlayingBack = true;
  recordBtn.disabled = true;
  playBtn.disabled = true;
  updatePracticeQueueControls();

  const shouldSyncWithMetronome =
    options.syncWithMetronome ?? (playbackMetronomeToggle ? playbackMetronomeToggle.checked : false);
  const providedBeatLength = options.baseBeatLength;
  const baseBeatLength =
    Number.isFinite(providedBeatLength) && providedBeatLength > 0 ? providedBeatLength : getQueueBeatLength(events);
  const countInBeats = Math.max(0, options.countInBeats ?? 0);

  let tempoScale = 1;
  const metronomeBeatLength =
    metronomeInstance && Number.isFinite(metronomeInstance.bpm) && metronomeInstance.bpm > 0
      ? 60 / metronomeInstance.bpm
      : null;

  metronomeStartedForCountIn = false;

  if (shouldSyncWithMetronome && metronomeInstance) {
    const currentBeatLength = metronomeBeatLength ?? 60 / metronomeInstance.bpm;
    tempoScale = currentBeatLength / Math.max(baseBeatLength, 0.001);
    if (!metronomeInstance.isActive()) {
      await metronomeInstance.start();
      metronomeStartedForPlayback = metronomeInstance.isActive();
    } else {
      metronomeStartedForPlayback = false;
    }
  } else {
    metronomeStartedForPlayback = false;
    if (countInBeats > 0 && metronomeInstance && !metronomeInstance.isActive()) {
      await metronomeInstance.start();
      metronomeStartedForCountIn = metronomeInstance.isActive();
    }
  }

  const fallbackBeatLength = baseBeatLength > 0 ? baseBeatLength : DEFAULT_NOTE_DURATION;
  const resolvedCountInBeatLength = countInBeats > 0 ? metronomeBeatLength ?? fallbackBeatLength : 0;
  const countInDuration = resolvedCountInBeatLength > 0 ? countInBeats * resolvedCountInBeatLength : 0;

  if (metronomeStartedForCountIn && countInDuration > 0) {
    const stopDelay = countInDuration * 1000 + 150;
    const stopId = window.setTimeout(() => {
      if (metronomeInstance?.isActive()) {
        metronomeInstance.stop();
      }
      metronomeStartedForCountIn = false;
    }, stopDelay);
    playbackTimeouts.push(stopId);
  }

  const startDelay = 0.1 + countInDuration;
  const startAt = ctx.currentTime + startDelay;
  const nextEventTimes = computeNextEventTimes(events);
  let relativeEndMax = 0;

  events.forEach((event, index) => {
    const scaledStart = startAt + event.time * tempoScale;
    const rawDuration = event.duration ?? DEFAULT_NOTE_DURATION;
    const baseDurationSeconds = Math.max(rawDuration * tempoScale, 0.05);
    const nextTime = nextEventTimes[index];
    const gapSeconds = nextTime != null ? Math.max(0, (nextTime - event.time) * tempoScale) : null;
    const sustainDuration = resolveSustainDuration(baseDurationSeconds, gapSeconds);
    const playbackDuration = sustainDuration ?? undefined;
    const highlightDurationMs = estimateHighlightDuration(baseDurationSeconds, sustainDuration);

    relativeEndMax = Math.max(
      relativeEndMax,
      event.time * tempoScale + (sustainDuration ?? baseDurationSeconds + EXTRA_SUSTAIN_SECONDS)
    );

    scheduleTone(ctx, event.note, scaledStart, playbackDuration, playbackGainNode ?? ctx.destination, highlightDurationMs);
  });

  const overallDuration = relativeEndMax + startDelay;
  playbackTimeouts.push(
    window.setTimeout(() => {
      stopPlayback();
      updateRecordingStatus("Wiedergabe beendet.");
    }, overallDuration * 1000 + 200)
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
  resetQuantizationState();
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
  const playbackEvents = getPlaybackRecordingEvents();
  if (!playbackEvents.length) {
    stopPlayback();
    updateRecordingStatus("Keine Noten zum Abspielen vorhanden.");
    return;
  }
  const nextEventTimes = computeNextEventTimes(playbackEvents);
  let relativeEndMax = 0;

  playbackEvents.forEach((event, index) => {
    const eventStart = startAt + event.time * tempoScale;
    const rawDuration = event.duration ?? DEFAULT_NOTE_DURATION;
    const baseDurationSeconds = Math.max(rawDuration * tempoScale, 0.05);
    const nextTime = nextEventTimes[index];
    const gapSeconds = nextTime != null ? Math.max(0, (nextTime - event.time) * tempoScale) : null;
    const sustainDuration = resolveSustainDuration(baseDurationSeconds, gapSeconds);
    const playbackDuration = sustainDuration ?? undefined;
    const highlightDurationMs = estimateHighlightDuration(baseDurationSeconds, sustainDuration);

    relativeEndMax = Math.max(
      relativeEndMax,
      event.time * tempoScale + (sustainDuration ?? baseDurationSeconds + EXTRA_SUSTAIN_SECONDS)
    );

    scheduleTone(ctx, event.note, eventStart, playbackDuration, playbackGainNode ?? ctx.destination, highlightDurationMs);
  });

  const totalDuration = relativeEndMax + 0.25;
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

  const sourceEvents = getPlaybackRecordingEvents();
  const template = {
    id: `user-${Date.now()}`,
    name,
    description: `Aufnahme ${savedTemplates.filter((tpl) => tpl.id.startsWith("user-")).length + 1}`,
    events: sourceEvents.map((event) => ({ ...event }))
  };

  savedTemplates.push(template);
  renderTemplates();

  lastTemplateName = name;
  updatePracticeArea(name);
  updateRecordingStatus(`Vorlage "${name}" gespeichert. Du findest sie in "Vorlagen".`);
}

function updatePracticeArea(name) {
  const eventsForSummary = getDisplayRecordingEvents();
  const summary = formatRecordingSummary(eventsForSummary);
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

function computeNextEventTimes(events) {
  if (!Array.isArray(events) || events.length === 0) return [];
  const order = events.map((_, index) => index).sort((a, b) => {
    const aTime = events[a]?.time ?? 0;
    const bTime = events[b]?.time ?? 0;
    return aTime - bTime;
  });
  const nextTimes = new Array(events.length).fill(null);
  order.forEach((currentIdx, orderedPosition) => {
    const currentTime = events[currentIdx]?.time;
    if (typeof currentTime !== "number") return;
    for (let offset = orderedPosition + 1; offset < order.length; offset += 1) {
      const candidateIdx = order[offset];
      const candidateTime = events[candidateIdx]?.time;
      if (typeof candidateTime !== "number") continue;
      if (candidateTime - currentTime > NOTE_TIME_EPSILON) {
        nextTimes[currentIdx] = candidateTime;
        break;
      }
    }
  });
  return nextTimes;
}

function resolveSustainDuration(baseDurationSeconds, gapSeconds) {
  const safeBase = Math.max(baseDurationSeconds, 0.05);
  if (gapSeconds == null || !Number.isFinite(gapSeconds)) {
    return null;
  }
  if (gapSeconds > safeBase * MAX_FORCED_SUSTAIN_RATIO) {
    return null;
  }
  return Math.max(safeBase, gapSeconds + EXTRA_SUSTAIN_SECONDS);
}

function estimateHighlightDuration(baseDurationSeconds, sustainDurationSeconds) {
  const fallback = sustainDurationSeconds ?? baseDurationSeconds + EXTRA_SUSTAIN_SECONDS;
  return Math.max(50, fallback * 1000);
}

function getSelectedQuantizeMode() {
  if (!quantizeModeSelect) {
    return QUANTIZE_RESOLUTIONS[lastQuantizeMode] ? lastQuantizeMode : DEFAULT_QUANTIZE_MODE;
  }
  const rawValue = quantizeModeSelect.value || lastQuantizeMode || DEFAULT_QUANTIZE_MODE;
  const resolved = QUANTIZE_RESOLUTIONS[rawValue] ? rawValue : DEFAULT_QUANTIZE_MODE;
  lastQuantizeMode = resolved;
  return resolved;
}

function getRecordingBeatLengthSeconds() {
  if (
    lastRecordingTiming &&
    Number.isFinite(lastRecordingTiming.beatLengthSeconds) &&
    lastRecordingTiming.beatLengthSeconds > 0
  ) {
    return lastRecordingTiming.beatLengthSeconds;
  }
  const inferred = getQueueBeatLength(recordedEvents);
  if (Number.isFinite(inferred) && inferred > 0) {
    return inferred;
  }
  return DEFAULT_NOTE_DURATION;
}

function getQuantizationGridSeconds(mode) {
  const setting = QUANTIZE_RESOLUTIONS[mode];
  if (!setting) return null;
  const beatLength = getRecordingBeatLengthSeconds();
  if (!Number.isFinite(beatLength) || beatLength <= 0) return null;
  const grid = beatLength * setting.beatMultiplier;
  return grid > 0 ? grid : null;
}

function quantizeEvents(events, gridSeconds) {
  if (!Array.isArray(events) || events.length === 0) return [];
  if (!gridSeconds || !Number.isFinite(gridSeconds) || gridSeconds <= 0) {
    return events.map((event) => ({ ...event }));
  }
  const quantized = events.map((event, index) => {
    const target = Math.round((event.time ?? 0) / gridSeconds) * gridSeconds;
    const clamped = Math.max(0, target);
    return { ...event, time: clamped, __index: index };
  });
  quantized.sort((a, b) => {
    if (Math.abs(a.time - b.time) > NOTE_TIME_EPSILON) {
      return a.time - b.time;
    }
    return a.__index - b.__index;
  });
  quantized.forEach((event) => {
    delete event.__index;
  });
  return quantized;
}

function getQuantizedRecordingEvents() {
  if (!recordedEvents.length) return [];
  const mode = getSelectedQuantizeMode();
  const gridSeconds = getQuantizationGridSeconds(mode);
  return quantizeEvents(recordedEvents, gridSeconds);
}

function getPlaybackRecordingEvents() {
  if (!recordedEvents.length) return [];
  if (isQuantizationEnabled) {
    return getQuantizedRecordingEvents();
  }
  return recordedEvents.map((event) => ({ ...event }));
}

function getDisplayRecordingEvents() {
  if (!recordedEvents.length) return [];
  return isQuantizationEnabled ? getQuantizedRecordingEvents() : recordedEvents;
}

function updateQuantizeToggleDisplay(value) {
  if (!quantizeModeToggleBtn) return;
  const data =
    quantizeOptionData.get(value) ||
    (quantizeOptionElements.length ? quantizeOptionData.get(quantizeOptionElements[0].dataset.value) : null);
  const labelEl = quantizeModeToggleBtn.querySelector(".quantize-select__label");
  const iconImg = quantizeModeToggleBtn.querySelector(".quantize-select__icon img");
  const label = data?.label ?? value ?? "";
  if (labelEl) {
    labelEl.textContent = label;
  }
  if (iconImg) {
    if (data?.icon) {
      iconImg.src = data.icon;
      iconImg.alt = label;
      iconImg.style.visibility = "";
    } else {
      iconImg.src = "";
      iconImg.alt = "";
      iconImg.style.visibility = "hidden";
    }
  }
}

function updateQuantizeOptionSelection(value) {
  let selectedIndex = -1;
  quantizeOptionElements.forEach((option, index) => {
    const isSelected = option.dataset.value === value;
    option.classList.toggle("is-selected", isSelected);
    option.setAttribute("aria-selected", isSelected ? "true" : "false");
    option.setAttribute("tabindex", isSelected ? "0" : "-1");
    if (isSelected) {
      selectedIndex = index;
    }
  });
  if (selectedIndex >= 0) {
    quantizeFocusedOptionIndex = selectedIndex;
  }
}

function selectQuantizeOption(value, { closeMenu = true, focusToggle = true, silent = false } = {}) {
  if (!quantizeModeSelect || !quantizeOptionData.has(value)) return;
  const previousValue = quantizeModeSelect.value;
  quantizeModeSelect.value = value;
  updateQuantizeToggleDisplay(value);
  updateQuantizeOptionSelection(value);
  if (closeMenu) {
    closeQuantizeMenu(focusToggle);
  }
  if (!silent && value !== previousValue) {
    quantizeModeSelect.dispatchEvent(new Event("change", { bubbles: true }));
  }
}

function openQuantizeMenu() {
  if (isQuantizeMenuOpen || !quantizeModeList || !quantizeModeToggleBtn) return;
  isQuantizeMenuOpen = true;
  quantizeModeToggleBtn.setAttribute("aria-expanded", "true");
  quantizeModeList.classList.add("is-open");
  quantizeModeList.setAttribute("aria-hidden", "false");
  quantizeSelectWrapper?.classList.add("is-open");
  document.addEventListener("click", handleQuantizeOutsideClick);
  document.addEventListener("keydown", handleQuantizeGlobalKeydown);
  const currentValue = quantizeModeSelect?.value ?? DEFAULT_QUANTIZE_MODE;
  const selectedIndex = quantizeOptionData.get(currentValue)?.index ?? 0;
  focusQuantizeOption(selectedIndex);
}

function closeQuantizeMenu(focusToggle = false) {
  if (!isQuantizeMenuOpen) return;
  isQuantizeMenuOpen = false;
  quantizeModeToggleBtn?.setAttribute("aria-expanded", "false");
  quantizeModeList?.classList.remove("is-open");
  quantizeModeList?.setAttribute("aria-hidden", "true");
  quantizeSelectWrapper?.classList.remove("is-open");
  document.removeEventListener("click", handleQuantizeOutsideClick);
  document.removeEventListener("keydown", handleQuantizeGlobalKeydown);
  if (focusToggle && quantizeModeToggleBtn && !quantizeModeToggleBtn.disabled) {
    quantizeModeToggleBtn.focus();
  }
}

function focusQuantizeOption(index) {
  if (!quantizeOptionElements.length) return;
  const count = quantizeOptionElements.length;
  const targetIndex = ((index % count) + count) % count;
  quantizeOptionElements.forEach((option, idx) => {
    option.setAttribute("tabindex", idx === targetIndex ? "0" : "-1");
  });
  quantizeFocusedOptionIndex = targetIndex;
  const option = quantizeOptionElements[targetIndex];
  option.focus();
}

function handleQuantizeToggleKeydown(event) {
  if (quantizeModeToggleBtn?.disabled) return;
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    if (!isQuantizeMenuOpen) {
      openQuantizeMenu();
    }
    const currentValue = quantizeModeSelect?.value ?? DEFAULT_QUANTIZE_MODE;
    const selectedIndex = quantizeOptionData.get(currentValue)?.index ?? 0;
    focusQuantizeOption(selectedIndex);
  } else if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    if (isQuantizeMenuOpen) {
      closeQuantizeMenu(true);
    } else {
      openQuantizeMenu();
    }
  }
}

function handleQuantizeOptionKeydown(event, index) {
  if (!isQuantizeMenuOpen) return;
  const option = quantizeOptionElements[index];
  if (!option) return;
  if (event.key === "ArrowDown") {
    event.preventDefault();
    focusQuantizeOption(index + 1);
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    focusQuantizeOption(index - 1);
  } else if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    const value = option.dataset.value;
    if (value) {
      selectQuantizeOption(value);
    }
  } else if (event.key === "Escape") {
    event.preventDefault();
    closeQuantizeMenu(true);
  }
}

function handleQuantizeOutsideClick(event) {
  if (!isQuantizeMenuOpen) return;
  if (!quantizeSelectWrapper?.contains(event.target)) {
    closeQuantizeMenu();
  }
}

function handleQuantizeGlobalKeydown(event) {
  if (!isQuantizeMenuOpen) return;
  if (event.key === "Escape") {
    event.preventDefault();
    closeQuantizeMenu(true);
  } else if (event.key === "Tab") {
    closeQuantizeMenu();
  }
}

function refreshQuantizationPreview() {
  if (!recordedEvents.length) {
    renderRecordingSummaryNotation("Noch keine Aufnahme.");
    updateQuantizationControls();
    return;
  }
  const label =
    templateNameInput?.value?.trim() || lastTemplateName || "Letzte Aufnahme";
  updatePracticeArea(label);
}

function updateQuantizationControls() {
  if (!quantizeToggleBtn || !quantizeModeSelect) return;
  const hasEvents = recordedEvents.length > 0;
  if (!hasEvents && isQuantizationEnabled) {
    isQuantizationEnabled = false;
  }
  quantizeToggleBtn.disabled = !hasEvents;
  quantizeToggleBtn.textContent = `Quantisierung: ${isQuantizationEnabled ? "An" : "Aus"}`;
  quantizeToggleBtn.setAttribute("aria-pressed", isQuantizationEnabled ? "true" : "false");
  quantizeToggleBtn.classList.toggle("is-active", isQuantizationEnabled);
  const shouldDisableSelector = !hasEvents;
  quantizeModeSelect.disabled = shouldDisableSelector;
  if (quantizeModeToggleBtn) {
    quantizeModeToggleBtn.disabled = shouldDisableSelector;
  }
  quantizeSelectWrapper?.classList.toggle("is-disabled", shouldDisableSelector);
  if (shouldDisableSelector) {
    closeQuantizeMenu();
  }
  updateQuantizeToggleDisplay(quantizeModeSelect.value || DEFAULT_QUANTIZE_MODE);
}

function resetQuantizationState() {
  if (!quantizeToggleBtn || !quantizeModeSelect) return;
  isQuantizationEnabled = false;
  closeQuantizeMenu();
  updateQuantizationControls();
}

function scheduleTone(ctx, note, when, duration, destination, highlightMs) {
  playPianoNote(ctx, note, when, {
    duration,
    destination: destination ?? ctx.destination
  }).catch((error) => {
    console.error("Konnte Pianoton nicht planen:", error);
  });
  const delay = Math.max(0, (when - ctx.currentTime) * 1000);
  const highlightDuration = highlightMs ?? Math.max(50, (duration ?? DEFAULT_NOTE_DURATION) * 1000);
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
    deleteBtn.innerHTML = '<img src="./assets/images/trash-white32.png" alt="Melopoiia Logo" />';
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
