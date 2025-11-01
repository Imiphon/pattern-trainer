export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function noteToFrequency(note) {
  const match = /^([A-G])(#?)(\d)$/.exec(note);
  if (!match) return 440;
  const [, letter, sharp, octaveStr] = match;
  const SEMITONES = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  const octave = parseInt(octaveStr, 10);
  const base = SEMITONES[letter];
  const midi = (octave + 1) * 12 + base + (sharp ? 1 : 0);
  return 440 * Math.pow(2, (midi - 69) / 12);
}
