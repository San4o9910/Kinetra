/** Original Kinetra velocity mark, shared by the interface and the film. */
export const KINETRA_BLADES = [
  'M13 54 21 10H31L23 54Z',
  'M29 28 49 10H62L32 36H25Z',
  'M25 40 33 33 52 54H38Z',
] as const;

/** Custom wordmark outlines: no remote font or font-loading flash. */
export const KINETRA_LETTERS = [
  { x: 0, d: 'M0 0H8V25L32 0H42L16 29 43 60H32L8 32V60H0Z' },
  { x: 64, d: 'M0 0H8V60H0Z' },
  { x: 95, d: 'M0 60V0H8L36 45V0H44V60H36L8 15V60Z' },
  { x: 161, d: 'M0 0H40V8H8V25H34V33H8V52H40V60H0Z' },
  { x: 222, d: 'M0 0H46V8H27V60H19V8H0Z' },
  {
    x: 289,
    d: 'M0 60V0H24Q44 0 44 18Q44 31 31 35L48 60H38L22 36H8V60ZM8 8V28H24Q36 28 36 18Q36 8 24 8Z',
  },
  { x: 359, d: 'M0 60 23 0H32L55 60H46L40 44H15L9 60ZM18 36H37L27.5 10Z' },
] as const;
