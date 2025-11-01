const pianoSampleCache = new Map();

function normalizeNoteName(note) {
  // convert to lowercase, keep sharp symbol as '#'
  return note.toLowerCase();
}

async function fetchSampleBuffer(ctx, note) {
  const normalized = normalizeNoteName(note);
  if (pianoSampleCache.has(normalized)) {
    return pianoSampleCache.get(normalized);
  }
  const encoded = encodeURIComponent(`${normalized}.mp3`);
  const response = await fetch(`./assets/audio/piano/${encoded}`);
  if (!response.ok) {
    throw new Error(`Konnte Audiosample nicht laden: ${normalized}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
  pianoSampleCache.set(normalized, audioBuffer);
  return audioBuffer;
}

export async function playPianoNote(ctx, note, when, options = {}) {
  const buffer = await fetchSampleBuffer(ctx, note);
  const source = ctx.createBufferSource();
  source.buffer = buffer;

  const gain = ctx.createGain();
  const attackTime = 0.01;
  const maxGain = 1;

  gain.gain.setValueAtTime(0, when);
  gain.gain.linearRampToValueAtTime(maxGain, when + attackTime);

  const destination = options.destination ?? ctx.destination;
  const duration = options.duration;

  const hasDuration = typeof duration === "number" && Number.isFinite(duration);
  const desiredDuration = hasDuration ? duration : buffer.duration;
  const playbackDuration = Math.max(0.05, Math.min(desiredDuration, buffer.duration));
  const stopAt = when + playbackDuration;

  const releaseWindow = hasDuration ? Math.min(0.2, desiredDuration * 0.6) : Math.min(0.4, buffer.duration * 0.35);
  const releaseStart = Math.max(when + attackTime, stopAt - releaseWindow);
  gain.gain.setValueAtTime(maxGain, releaseStart);
  gain.gain.exponentialRampToValueAtTime(hasDuration ? 0.0001 : 0.002, stopAt);

  source.connect(gain).connect(destination);
  source.start(when);
  if (hasDuration) {
    source.stop(stopAt);
  }

  let stopped = false;
  const stop = (time = ctx.currentTime) => {
    if (stopped) return;
    stopped = true;
    const clampTime = Math.max(time, ctx.currentTime);
    const currentValue = gain.gain.value;
    gain.gain.setValueAtTime(currentValue, clampTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, clampTime + 0.08);
    source.stop(clampTime + 0.1);
  };

  source.addEventListener?.("ended", () => {
    stopped = true;
  });
  source.onended = () => {
    stopped = true;
  };

  return { source, gain, stop };
}

export function clearSampleCache() {
  pianoSampleCache.clear();
}
