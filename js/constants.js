export const KEYBOARD_LAYOUT = [
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

export const DEFAULT_NOTE_DURATION = 0.6;
export const LOOKAHEAD_MS = 25;
export const SCHEDULE_AHEAD = 0.1;

export const RecordingPhase = Object.freeze({
  idle: "idle",
  countIn: "count-in",
  awaitingStart: "awaiting-start",
  recording: "recording"
});

export const BEAT_EPSILON = 1e-4;

export const DEFAULT_TEMPLATES = [
  {
    name: "Demo",
    description: "Vier Viertel: C - D - E - C",
    events: [
      { note: "C3", time: 0, duration: DEFAULT_NOTE_DURATION },
      { note: "D3", time: DEFAULT_NOTE_DURATION, duration: DEFAULT_NOTE_DURATION },
      { note: "E3", time: DEFAULT_NOTE_DURATION * 2, duration: DEFAULT_NOTE_DURATION },
      { note: "C3", time: DEFAULT_NOTE_DURATION * 3, duration: DEFAULT_NOTE_DURATION }
    ]
  }
];
