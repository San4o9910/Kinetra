import React from 'react';
import { KINETRA_BLADES } from './kinetra-brand';

/** The same swept K as the film, with a finite completion highlight. */
export const KineticMark = ({
  completed = false,
}: {
  readonly completed?: boolean;
}): React.ReactNode => (
  <svg
    className={`kinetic-mark${completed ? ' is-complete' : ''}`}
    viewBox="0 0 64 64"
    aria-hidden="true"
  >
    {KINETRA_BLADES.map((d) => (
      <path key={d} className="kinetic-mark-silhouette" d={d} />
    ))}
    {completed && (
      <path className="kinetic-mark-stroke" pathLength="1" d={KINETRA_BLADES.join(' ')} />
    )}
  </svg>
);
