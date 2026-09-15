import React from 'react';

/** One finite stroke, shared by the brand and a confirmed workout completion. */
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
    <path className="kinetic-mark-track" d="M16 50V14M48 14 24 32 48 50" />
    <path className="kinetic-mark-stroke" pathLength="1" d="M16 50V14M48 14 24 32 48 50" />
  </svg>
);
