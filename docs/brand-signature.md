# Kinetra: cinematic sports signature

## Direction

The previous constant-speed intro did not express the requested elegant, athletic brand. This version uses a swept three-part K, an individually outlined wordmark, controlled acceleration and an original synthesized audio signature.

- **Tone:** focused, confident, restrained; no playful bouncing.
- **Complexity:** one mark, one wordmark, one short Russian line; 16:9 composition.
- **Density:** generous negative space, readable on a 390px phone.
- **Energy:** fast entrance, decelerated assembly, deliberate hold and accelerated exit.

Deep ink `#020b10`, warm ivory `#f2f1e9`, Kinetra orange `#ff4103`. The mark also replaces the interface, favicon and installed-app icons. No remote fonts or graphics are needed.

## Seven-second sequence

| Time       | Motion                                 | Sound                        |
| ---------- | -------------------------------------- | ---------------------------- |
| 0–1.08s    | Accelerating light stroke              | Rising air sweep             |
| 1.08–1.82s | Three blades lock into the K           | Low impact and resonant tone |
| 1.82–2.62s | Slow surface highlight                 | Lighter second note          |
| 2.62–3.10s | Wordmark opens and decelerates         | High resolving tone          |
| 3.10–5.62s | Quiet hold with subtle scale settling  | Short stereo decay           |
| 5.62–6.10s | Small compression before release       | Air gathers                  |
| 6.10–7.00s | Blades accelerate away; fade to lesson | Brief release and soft tail  |

The sound is synthesized from oscillators, filtered seeded noise and short delays. No third-party recording or Netflix audio is used. Its four-note motif is E3–B3–F♯4–F♯5. Authoring script: `scripts/render-brand-signature.py` (Python, NumPy, SciPy, FFmpeg); none is a runtime dependency. The shipped MP3 is approximately 113 KB, stereo, 48 kHz. Measured integrated loudness: −20.4 LUFS; true peak: −4.5 dBFS before player volume 0.7.

## Playback and accessibility

Sound starts only from the lesson's play gesture. Muting is remembered locally. Skip and completion stop audio before the lesson. Closing the player stops audio. Hidden tabs pause the timeline and sound; return resumes the same position. Browser audio refusal cannot block the lesson. Reduced-motion preference bypasses both animation and signature. Controls have names, visible keyboard focus and 44px targets.

The existing browser scenario verifies all seven stages, minimum duration, trusted-gesture audio, mute/re-enable, retained preference, keyboard skip, stopped audio and reduced motion. It retains mobile screenshots in the CI artifact `lesson-sharing-preview`.
