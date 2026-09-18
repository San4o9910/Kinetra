import { useEffect, useId, useRef } from 'react';
export const KINETRA_INTRO_MS = 7000;
const letters = [
  'M145 242V174M185 174L145 208L187 242',
  'M216 174V242',
  'M246 242V174L290 242V174',
  'M360 174H319V242H360M319 208H352',
  'M382 174H436M409 174V242',
  'M460 242V174H480Q508 174 508 193Q508 212 480 212H460M483 212L512 242',
  'M532 242L557 174L582 242M541 218H573',
];
const ease = (v: number) => 1 - Math.pow(1 - v, 3);
const clamp = (v: number) => Math.max(0, Math.min(1, v));
/** A finite SVG timeline. Progress only advances while visible; no video or raster asset. */
export const KinetraVideoIntro = ({ onDone }: { onDone: () => void }) => {
  const root = useRef<SVGSVGElement>(null),
    callback = useRef(onDone);
  const uid = useId().replaceAll(':', '');
  useEffect(() => {
    callback.current = onDone;
  }, [onDone]);
  useEffect(() => {
    const svg = root.current;
    if (!svg) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    if (reduced.matches) {
      callback.current();
      return;
    }
    const drop = svg.querySelector<SVGGElement>('[data-drop]')!,
      ball = svg.querySelector<SVGCircleElement>('[data-ball]')!,
      word = svg.querySelector<SVGGElement>('[data-word]')!,
      ripple = svg.querySelector<SVGEllipseElement>('[data-ripple]')!,
      mark = svg.querySelector<SVGGElement>('[data-mark]')!,
      halves = [...svg.querySelectorAll<SVGGElement>('[data-half]')],
      paths = [...svg.querySelectorAll<SVGPathElement>('[data-letter]')];
    const lengths = paths.map((p) => p.getTotalLength()),
      total = lengths.reduce((a, b) => a + b, 0);
    paths.forEach((p, i) => {
      p.style.strokeDasharray = String(lengths[i]);
      p.style.strokeDashoffset = String(lengths[i]);
    });
    let elapsed = 0,
      last = 0,
      frame = 0,
      finished = false;
    const done = () => {
      if (!finished) {
        finished = true;
        cancelAnimationFrame(frame);
        callback.current();
      }
    };
    const motion = () => {
      if (reduced.matches) done();
    };
    reduced.addEventListener('change', motion);
    const tick = (now: number) => {
      if (finished) return;
      if (last && !document.hidden) elapsed += Math.min(now - last, 64);
      last = now;
      const t = elapsed / 1000;
      svg.dataset.phase =
        t < 1.15
          ? 'drop'
          : t < 2
            ? 'bounce'
            : t < 4.5
              ? 'draw'
              : t < 5.25
                ? 'word'
                : t < 6.2
                  ? 'gather'
                  : 'split';
      const fall = clamp(t / 1.15),
        impact = clamp((t - 1.15) / 0.22);
      drop.style.opacity = t < 1.15 ? '1' : String(1 - impact);
      drop.setAttribute(
        'transform',
        `translate(360 ${-35 + 397 * fall * fall}) scale(${1 + impact * 1.2} ${1 - impact * 0.65})`,
      );
      const ring = clamp((t - 1.15) / 0.6);
      ripple.setAttribute('rx', String(16 + 100 * ease(ring)));
      ripple.setAttribute('ry', String(3 + 7 * ring));
      ripple.style.opacity = t >= 1.15 ? String((1 - ring) * 0.65) : '0';
      let x = 360,
        y = 362;
      if (t >= 1.2 && t < 2) {
        const p = clamp((t - 1.2) / 0.8);
        x = 360 + (145 - 360) * ease(p);
        y = (1 - p) * (1 - p) * 362 + 2 * (1 - p) * p * 40 + p * p * 242;
      }
      const drawn = clamp((t - 2) / 2.5) * total;
      let previous = 0;
      paths.forEach((p, i) => {
        const local = clamp((drawn - previous) / lengths[i]!);
        p.style.strokeDashoffset = String(lengths[i]! * (1 - local));
        if (t >= 2 && t < 4.5 && drawn >= previous && drawn <= previous + lengths[i]!) {
          const point = p.getPointAtLength(local * lengths[i]!);
          x = point.x;
          y = point.y;
        }
        previous += lengths[i]!;
      });
      ball.setAttribute('cx', String(x));
      ball.setAttribute('cy', String(y));
      ball.style.opacity = t >= 1.2 && t < 4.5 ? '1' : '0';
      const gather = ease(clamp((t - 5.25) / 0.65));
      word.setAttribute(
        'transform',
        `translate(360 208) scale(${1 - gather * 0.88}) translate(-360 -208)`,
      );
      word.style.opacity = String(1 - gather);
      mark.style.opacity = String(gather);
      mark.setAttribute('transform', `translate(360 208) scale(${0.5 + gather * 0.5})`);
      const split = ease(clamp((t - 6.2) / 0.8));
      halves[0]!.setAttribute(
        'transform',
        `translate(${-split * 235} ${-split * 36}) rotate(${-split * 10})`,
      );
      halves[1]!.setAttribute(
        'transform',
        `translate(${split * 235} ${split * 36}) rotate(${split * 10})`,
      );
      mark.style.opacity = String(gather * (1 - clamp((t - 6.8) / 0.2)));
      // Keep both halves readable during the cut; fade only in the final 200 ms.
      if (elapsed >= KINETRA_INTRO_MS) done();
      else frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      finished = true;
      cancelAnimationFrame(frame);
      reduced.removeEventListener('change', motion);
    };
  }, []);
  return (
    <div className="kinetra-video-intro" role="group" aria-label="Заставка Kinetra">
      <svg ref={root} viewBox="0 0 720 420" aria-hidden="true" data-phase="drop">
        <defs>
          <clipPath id={`${uid}-left`}>
            <path d="M-100-100H100L-100 100Z" />
          </clipPath>
          <clipPath id={`${uid}-right`}>
            <path d="M100-100V100H-100Z" />
          </clipPath>
        </defs>
        <path className="kinetra-intro-floor" d="M96 385H624" />
        <ellipse data-ripple cx="360" cy="382" rx="16" ry="3" />
        <g data-drop transform="translate(360 -35)">
          <path d="M0-30C-5-15-18-4-18 8A18 18 0 0 0 18 8C18-4 5-15 0-30Z" />
        </g>
        <g data-word>
          {letters.map((d, i) => (
            <path key={i} data-letter d={d} />
          ))}
        </g>
        <circle data-ball cx="360" cy="362" r="11" />
        <g data-mark transform="translate(360 208)">
          {['left', 'right'].map((half) => (
            <g key={half} data-half>
              <g clipPath={`url(#${uid}-${half})`}>
                <path d="M-25 43V-43M31-43-25 0 33 43" />
              </g>
            </g>
          ))}
        </g>
      </svg>
      <div className="kinetra-intro-caption">
        <span>Движение начинается с тебя</span>
        <button type="button" onClick={onDone}>
          Пропустить заставку
        </button>
      </div>
    </div>
  );
};
