import { useEffect, useId, useRef, useState } from 'react';
import { KINETRA_BLADES, KINETRA_LETTERS } from './kinetra-brand';
import { KINETRA_INTRO_MS, kinetraMotion } from './kinetra-motion';
export { KINETRA_INTRO_MS } from './kinetra-motion';

export const KinetraVideoIntro = ({
  onDone,
  sound = null,
}: {
  onDone: () => void;
  sound?: HTMLAudioElement | null;
}) => {
  const root = useRef<SVGSVGElement>(null);
  const callback = useRef(onDone);
  const elapsed = useRef(0);
  const [soundOn, setSoundOn] = useState(() => !!sound && !sound.muted && !sound.paused);
  const uid = useId().replaceAll(':', '');
  useEffect(() => {
    callback.current = onDone;
  }, [onDone]);
  useEffect(() => {
    const svg = root.current;
    if (!svg) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    let frame = 0,
      last = 0,
      finished = false;
    const stopSound = () => {
      if (sound) sound.pause();
    };
    const done = () => {
      if (finished) return;
      finished = true;
      cancelAnimationFrame(frame);
      stopSound();
      callback.current();
    };
    const motion = () => {
      if (reduced.matches) done();
    };
    const syncSound = () => setSoundOn(!!sound && !sound.muted && !sound.paused);
    const visibility = () => {
      last = 0;
      if (!sound) return;
      if (document.hidden) sound.pause();
      else if (!sound.muted && !finished) {
        sound.currentTime = elapsed.current / 1000;
        void sound.play().catch(syncSound);
      }
    };
    if (reduced.matches) {
      done();
      return;
    }
    const scene = svg.querySelector<SVGGElement>('[data-scene]')!;
    const mark = svg.querySelector<SVGGElement>('[data-mark]')!;
    const blades = [...svg.querySelectorAll<SVGGElement>('[data-blade]')];
    const letters = [...svg.querySelectorAll<SVGGElement>('[data-letter]')];
    const word = svg.querySelector<SVGGElement>('[data-word]')!;
    const caption = svg.querySelector<SVGTextElement>('[data-tagline]')!;
    const launch = svg.querySelector<SVGGElement>('[data-launch]')!;
    const flash = svg.querySelector<SVGRectElement>('[data-flash]')!;
    const sheen = svg.querySelector<SVGRectElement>('[data-sheen]')!;
    const halo = svg.querySelector<SVGEllipseElement>('[data-halo]')!;
    const cut = svg.querySelector<SVGPathElement>('[data-cut]')!;
    const tick = (now: number) => {
      if (finished) return;
      if (last && !document.hidden) elapsed.current += Math.min(now - last, 100);
      last = now;
      const f = kinetraMotion(elapsed.current);
      svg.dataset.phase = f.phase;
      scene.style.opacity = String(f.curtain);
      launch.setAttribute(
        'transform',
        `translate(${-570 + 1030 * f.launch} ${430 - 260 * f.launch}) rotate(-24)`,
      );
      launch.style.opacity = String(f.launch > 0 && f.arrival < 0.8 ? 1 - f.arrival : 0);
      mark.style.opacity = String(f.markOpacity);
      mark.setAttribute(
        'transform',
        `translate(480 ${f.markY}) scale(${f.markScale * (1 - f.tension)}) translate(-32 -32)`,
      );
      blades.forEach((blade, i) => {
        const direction = i === 0 ? -1 : 1;
        const distance = (1 - f.arrival) * (i === 0 ? -26 : 34);
        blade.setAttribute(
          'transform',
          `translate(${distance + direction * f.exit * 300} ${distance * -0.28 - direction * f.exit * 65})`,
        );
      });
      word.setAttribute('transform', `translate(273 ${f.wordY}) skewX(-7)`);
      word.style.opacity = String(f.wordOpacity);
      letters.forEach((letter, i) =>
        letter.setAttribute(
          'transform',
          `translate(${KINETRA_LETTERS[i]!.x + (i - 3) * f.wordSpread} 0)`,
        ),
      );
      caption.style.opacity = String(f.captionOpacity);
      flash.style.opacity = String(f.light);
      sheen.setAttribute('x', String(-40 + f.glint * 130));
      sheen.style.opacity = f.glint > 0 && f.glint < 1 ? '0.8' : '0';
      halo.style.opacity = String((0.1 + f.arrival * 0.2) * (1 - f.exit));
      halo.setAttribute('rx', String(35 + f.arrival * 90));
      cut.style.opacity = String(f.tension * 11 + (f.exit > 0 ? (1 - f.exit) * 0.55 : 0));
      if (sound && !sound.paused && Math.abs(sound.currentTime - elapsed.current / 1000) > 0.2)
        sound.currentTime = elapsed.current / 1000;
      if (elapsed.current >= KINETRA_INTRO_MS) done();
      else frame = requestAnimationFrame(tick);
    };
    document.addEventListener('visibilitychange', visibility);
    reduced.addEventListener('change', motion);
    for (const event of ['play', 'pause', 'volumechange', 'error'])
      sound?.addEventListener(event, syncSound);
    // StrictMode may replay setup after its cleanup paused the gesture-started audio.
    if (sound && !sound.muted && sound.paused) void sound.play().catch(syncSound);
    frame = requestAnimationFrame(tick);
    return () => {
      finished = true;
      cancelAnimationFrame(frame);
      document.removeEventListener('visibilitychange', visibility);
      reduced.removeEventListener('change', motion);
      for (const event of ['play', 'pause', 'volumechange', 'error'])
        sound?.removeEventListener(event, syncSound);
      stopSound();
    };
  }, [sound]);
  const toggleSound = () => {
    if (!sound) return;
    const enabled = !soundOn;
    sound.muted = !enabled;
    try {
      localStorage.setItem('kinetra-intro-sound', enabled ? 'on' : 'off');
    } catch {
      /* Playback also works without storage. */
    }
    if (enabled) {
      sound.currentTime = elapsed.current / 1000;
      void sound
        .play()
        .then(() => setSoundOn(true))
        .catch(() => setSoundOn(false));
    } else setSoundOn(false);
  };
  return (
    <div className="kinetra-video-intro" role="group" aria-label="Заставка Kinetra">
      <svg ref={root} viewBox="0 0 960 540" aria-hidden="true" data-phase="charge">
        <defs>
          <radialGradient id={`${uid}-space`} cx="50%" cy="38%" r="65%">
            <stop stopColor="#11303b" />
            <stop offset=".55" stopColor="#04151e" />
            <stop offset="1" stopColor="#020b10" />
          </radialGradient>
          <linearGradient id={`${uid}-metal`} x1="0" y1="0" x2="1" y2="1">
            <stop stopColor="#fffdf5" />
            <stop offset=".38" stopColor="#e4e8e3" />
            <stop offset=".58" stopColor="#879b9c" />
            <stop offset=".82" stopColor="#eef0e8" />
            <stop offset="1" stopColor="#bac7c5" />
          </linearGradient>
          <linearGradient id={`${uid}-ember`} x1="0" y1="1" x2="1" y2="0">
            <stop stopColor="#b12407" />
            <stop offset=".5" stopColor="#ff4103" />
            <stop offset="1" stopColor="#ffba78" />
          </linearGradient>
          <linearGradient id={`${uid}-trail`}>
            <stop stopColor="#ff4103" stopOpacity="0" />
            <stop offset=".85" stopColor="#ff7439" stopOpacity=".7" />
            <stop offset="1" stopColor="#fff6dc" />
          </linearGradient>
          <linearGradient id={`${uid}-sheen`}>
            <stop stopColor="#fff" stopOpacity="0" />
            <stop offset=".5" stopColor="#fff" />
            <stop offset="1" stopColor="#fff" stopOpacity="0" />
          </linearGradient>
          <filter id={`${uid}-soft`} x="-100%" y="-150%" width="300%" height="400%">
            <feGaussianBlur stdDeviation="8" />
          </filter>
          <clipPath id={`${uid}-shape`}>
            {KINETRA_BLADES.map((d) => (
              <path key={d} d={d} />
            ))}
          </clipPath>
        </defs>
        <rect width="960" height="540" fill={`url(#${uid}-space)`} />
        <g data-scene>
          <ellipse
            data-halo
            cx="480"
            cy="262"
            rx="35"
            ry="5"
            fill="#ff6a26"
            filter={`url(#${uid}-soft)`}
          />
          <g data-launch opacity="0">
            <path d="M-380 0H0" stroke={`url(#${uid}-trail)`} strokeWidth="2" />
            <path d="M-230 9H-5" stroke={`url(#${uid}-trail)`} strokeWidth=".6" />
            <path d="M-140-7H-6" stroke={`url(#${uid}-trail)`} strokeWidth=".6" />
          </g>
          <g data-mark opacity="0">
            {KINETRA_BLADES.map((d, i) => (
              <g key={d} data-blade>
                <path d={d} transform="translate(0 1.1)" fill="#15272a" />
                <path d={d} fill={`url(#${uid}-${i === 1 ? 'ember' : 'metal'})`} />
                <path d={d} fill="none" stroke="#fff5dc" strokeWidth=".2" opacity=".35" />
              </g>
            ))}
            <g clipPath={`url(#${uid}-shape)`}>
              <rect
                data-sheen
                x="-40"
                y="-10"
                width="17"
                height="90"
                transform="skewX(-22)"
                fill={`url(#${uid}-sheen)`}
                opacity="0"
              />
            </g>
          </g>
          <g data-word opacity="0" fill="#f2f1e9">
            {KINETRA_LETTERS.map(({ x, d }) => (
              <g key={x} data-letter>
                <path d={d} fillRule="evenodd" />
              </g>
            ))}
          </g>
          <text
            data-tagline
            x="480"
            y="437"
            textAnchor="middle"
            opacity="0"
            className="kinetra-film-tagline"
          >
            ДВИЖЕНИЕ В ТВОЁМ РИТМЕ
          </text>
          <path
            data-cut
            d="M225 272 735 78"
            stroke={`url(#${uid}-trail)`}
            strokeWidth="1.2"
            opacity="0"
          />
          <rect data-flash width="960" height="540" fill="#e09663" opacity="0" />
        </g>
      </svg>
      <div className="kinetra-intro-caption">
        {sound && (
          <button
            type="button"
            className="kinetra-sound-control"
            data-testid="intro-sound"
            aria-label={soundOn ? 'Выключить звук заставки' : 'Включить звук заставки'}
            aria-pressed={soundOn}
            onClick={toggleSound}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M4 9H8L13 5V19L8 15H4Z" />
              <path d={soundOn ? 'M17 8Q21 12 17 16M19 5Q26 12 19 19' : 'M17 9 22 15M22 9 17 15'} />
            </svg>
            <span>{soundOn ? 'Звук включён' : 'Без звука'}</span>
          </button>
        )}
        <button
          type="button"
          className="kinetra-intro-skip"
          data-testid="intro-skip"
          onClick={() => {
            sound?.pause();
            onDone();
          }}
        >
          Пропустить заставку <span aria-hidden="true">↗</span>
        </button>
      </div>
    </div>
  );
};
