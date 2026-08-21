import type { ReactNode } from 'react';

export interface ComingSoonScreenProps {
  readonly kind: 'progress';
}

export const ComingSoonScreen = ({ kind }: ComingSoonScreenProps): ReactNode => {
  const title = 'Прогресс';

  return (
    <main className="coming-soon-shell" data-testid={`${kind}-screen`}>
      <section className="coming-soon-card" aria-labelledby={`${kind}-title`}>
        <p className="program-kicker">KINETRA</p>
        <h1 id={`${kind}-title`}>{title}</h1>
        <p>Скоро</p>
      </section>
    </main>
  );
};
