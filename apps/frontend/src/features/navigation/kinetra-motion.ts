export const KINETRA_INTRO_MS = 7000;
const clamp = (v: number) => Math.max(0, Math.min(1, v));
const progress = (t: number, start: number, duration: number) => clamp((t - start) / duration);
const out = (v: number) => 1 - (1 - v) ** 4;
const smooth = (v: number) => v * v * (3 - 2 * v);

/** Deliberate changes in tempo, shared by the live film and frame acceptance. */
export const kinetraMotion = (milliseconds: number) => {
  const t = Math.max(0, milliseconds) / 1000;
  const launch = progress(t, 0.18, 0.9) ** 3;
  const arrival = out(progress(t, 1.04, 0.78));
  const reveal = out(progress(t, 2.62, 0.48));
  const settle = smooth(progress(t, 3.1, 2.45));
  const exit = progress(t, 6.1, 0.72) ** 3;
  return {
    phase:
      t < 1.08
        ? 'charge'
        : t < 1.82
          ? 'strike'
          : t < 2.62
            ? 'sculpt'
            : t < 3.1
              ? 'reveal'
              : t < 5.62
                ? 'signature'
                : t < 6.1
                  ? 'tension'
                  : 'release',
    launch,
    arrival,
    reveal,
    settle,
    exit,
    curtain: 1 - smooth(progress(t, 6.66, 0.34)),
    markScale: 2.4 + (1 - arrival) * 1.8 - settle * 0.07,
    markY: 174 + (1 - arrival) * 42 - settle * 3,
    markOpacity: out(progress(t, 0.93, 0.23)),
    light:
      Math.max(0, 1 - Math.abs(t - 1.08) / 0.2) * 0.45 +
      Math.max(0, 1 - Math.abs(t - 2.73) / 0.25) * 0.18,
    glint: progress(t, 1.84, 0.85),
    wordOpacity: reveal * (1 - out(progress(t, 5.76, 0.38))),
    wordSpread: (1 - reveal) * 13,
    wordY: 330 + (1 - reveal) * 17,
    captionOpacity: smooth(progress(t, 3.35, 0.8)) * (1 - progress(t, 5.5, 0.3)),
    tension: Math.sin(progress(t, 5.62, 0.48) * Math.PI) * 0.055,
  };
};
