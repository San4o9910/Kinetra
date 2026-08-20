import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import type { MeResponse } from '@kinetra/shared';

import { ApiRequestError, completeOnboarding } from '../../lib/api';

import {
  ONBOARDING_AXIS_LOCK_THRESHOLD,
  ONBOARDING_COMPLETE_LABEL,
  ONBOARDING_NEXT_LABEL,
  ONBOARDING_SLIDE_OWNER_STORAGE_KEY,
  ONBOARDING_SLIDE_STORAGE_KEY,
  onboardingSlides,
  parseStoredOnboardingSlideForUser,
  slideAfterSwipe,
  weekRhythms,
  type WeekRhythm,
} from './model';

type GestureAxis = 'pending' | 'horizontal' | 'vertical';

interface PointerOrigin {
  readonly x: number;
  readonly y: number;
}

const readStoredSlide = (userId: string): number => {
  if (typeof window === 'undefined') {
    return 0;
  }

  try {
    return parseStoredOnboardingSlideForUser(
      window.sessionStorage.getItem(ONBOARDING_SLIDE_STORAGE_KEY),
      window.sessionStorage.getItem(ONBOARDING_SLIDE_OWNER_STORAGE_KEY),
      userId,
    );
  } catch {
    return 0;
  }
};

const writeStoredSlide = (slide: number, userId: string): void => {
  try {
    window.sessionStorage.setItem(ONBOARDING_SLIDE_OWNER_STORAGE_KEY, userId);
    window.sessionStorage.setItem(ONBOARDING_SLIDE_STORAGE_KEY, String(slide));
  } catch {
    // sessionStorage can be unavailable in hardened/private browser modes.
  }
};

const clearStoredSlide = (): void => {
  try {
    window.sessionStorage.removeItem(ONBOARDING_SLIDE_STORAGE_KEY);
    window.sessionStorage.removeItem(ONBOARDING_SLIDE_OWNER_STORAGE_KEY);
  } catch {
    // sessionStorage can be unavailable in hardened/private browser modes.
  }
};

const RhythmIcon = ({ icon }: Pick<WeekRhythm, 'icon'>): ReactNode => {
  switch (icon) {
    case 'breath':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4 9.5c2.5-3 5-3 7.5 0s5 3 8 0" />
          <path d="M5.5 14.5c2-2 4-2 6 0s4 2 7 0" />
        </svg>
      );
    case 'strength':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M7 8v8M17 8v8M4.5 10v4M19.5 10v4M7 12h10" />
        </svg>
      );
    case 'home':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="m4.5 11 7.5-6 7.5 6v8h-15Z" />
          <path d="M9.5 19v-5h5v5" />
        </svg>
      );
    case 'functional':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="m6 17 5-10 3 6 4-2" />
          <path d="m15.5 8.5 2.5 2.5-1 3" />
        </svg>
      );
    case 'stretch':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="5.5" r="2" />
          <path d="M12 8v5l-5 5M12 12l5.5 6M8 10l4 2 4-2" />
        </svg>
      );
    case 'neuro':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M8.5 5.5A3.5 3.5 0 0 0 6 11v2a3.5 3.5 0 0 0 2.5 5.5M15.5 5.5A3.5 3.5 0 0 1 18 11v2a3.5 3.5 0 0 1-2.5 5.5" />
          <path d="M9 8.5c2 0 2 2 2 3.5s0 3.5-2 3.5M15 8.5c-2 0-2 2-2 3.5s0 3.5 2 3.5M12 5v14" />
        </svg>
      );
    case 'food':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M7 4v7M4.5 4v4.5A2.5 2.5 0 0 0 7 11M9.5 4v4.5A2.5 2.5 0 0 1 7 11v9" />
          <path d="M16 4v16M16 4c3 1.5 4 4 4 7h-4" />
        </svg>
      );
  }
};

const ArrowIcon = ({ direction }: { readonly direction: 'back' | 'next' }): ReactNode => (
  <svg
    className="onboarding-arrow"
    viewBox="0 0 20 20"
    aria-hidden="true"
    data-direction={direction}
  >
    <path d="M4 10h12M11 5l5 5-5 5" />
  </svg>
);

const SlideVisual = ({ index }: { readonly index: number }): ReactNode => {
  if (index === 2) {
    return (
      <div className="onboarding-rhythms" data-testid="onboarding-rhythms">
        {weekRhythms.map((rhythm) => (
          <div className="onboarding-rhythm" key={rhythm.day}>
            <span className="onboarding-rhythm-icon">
              <RhythmIcon icon={rhythm.icon} />
            </span>
            <span className="onboarding-rhythm-copy">
              <strong>{rhythm.day}</strong>
              <small>{rhythm.label}</small>
            </span>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className={`onboarding-art onboarding-art-${index + 1}`} aria-hidden="true">
      <span className="onboarding-art-orbit" />
      <span className="onboarding-art-core">{index === 5 ? 'K' : index + 1}</span>
      <span className="onboarding-art-line" />
    </div>
  );
};

export interface OnboardingCarouselProps {
  readonly userId: string;
  readonly onCompleted: (profile: MeResponse) => void;
  readonly onOpenSettings: () => void;
  readonly onSessionExpired: () => void;
}

export const OnboardingCarousel = ({
  userId,
  onCompleted,
  onOpenSettings,
  onSessionExpired,
}: OnboardingCarouselProps): ReactNode => {
  const [currentSlide, setCurrentSlide] = useState(() => readStoredSlide(userId));
  const [dragOffset, setDragOffset] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const [isCompleting, setIsCompleting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const pointerOrigin = useRef<PointerOrigin | null>(null);
  const activePointerId = useRef<number | null>(null);
  const gestureAxis = useRef<GestureAxis>('pending');
  const completionInFlight = useRef(false);
  const isLastSlide = currentSlide === onboardingSlides.length - 1;
  const activeSlideTitle = onboardingSlides[currentSlide]?.title ?? '';

  useEffect(() => {
    writeStoredSlide(currentSlide, userId);
  }, [currentSlide, userId]);

  const moveTo = useCallback((nextSlide: number): void => {
    setErrorMessage(null);
    setCurrentSlide(Math.max(0, Math.min(nextSlide, onboardingSlides.length - 1)));
  }, []);

  const moveBy = useCallback((delta: number): void => {
    setErrorMessage(null);
    setCurrentSlide((current) =>
      Math.max(0, Math.min(current + delta, onboardingSlides.length - 1)),
    );
  }, []);

  const resetPointerGesture = (): void => {
    pointerOrigin.current = null;
    activePointerId.current = null;
    gestureAxis.current = 'pending';
    setIsDragging(false);
    setDragOffset(0);
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (isCompleting || !event.isPrimary || (event.pointerType === 'mouse' && event.button !== 0)) {
      return;
    }

    pointerOrigin.current = { x: event.clientX, y: event.clientY };
    activePointerId.current = event.pointerId;
    gestureAxis.current = 'pending';
    setDragOffset(0);

    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Synthetic pointer events and older browsers may not support pointer capture.
    }
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const origin = pointerOrigin.current;

    if (origin === null || activePointerId.current !== event.pointerId) {
      return;
    }

    const deltaX = event.clientX - origin.x;
    const deltaY = event.clientY - origin.y;

    if (gestureAxis.current === 'pending') {
      if (Math.max(Math.abs(deltaX), Math.abs(deltaY)) < ONBOARDING_AXIS_LOCK_THRESHOLD) {
        return;
      }

      gestureAxis.current = Math.abs(deltaX) > Math.abs(deltaY) ? 'horizontal' : 'vertical';
    }

    if (gestureAxis.current !== 'horizontal') {
      return;
    }

    setIsDragging(true);
    const isAtStart = currentSlide === 0 && deltaX > 0;
    const isAtEnd = isLastSlide && deltaX < 0;
    const resistance = isAtStart || isAtEnd ? 0.28 : 1;
    setDragOffset(Math.max(-110, Math.min(110, deltaX * resistance)));
  };

  const finishPointerGesture = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const origin = pointerOrigin.current;

    if (origin === null || activePointerId.current !== event.pointerId) {
      return;
    }

    const nextSlide = slideAfterSwipe(
      currentSlide,
      event.clientX - origin.x,
      event.clientY - origin.y,
    );
    resetPointerGesture();
    moveTo(nextSlide);

    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // The pointer may already be released by the browser.
    }
  };

  const handleKeyboard = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      moveBy(1);
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      moveBy(-1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      moveTo(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      moveTo(onboardingSlides.length - 1);
    }
  };

  const handleComplete = async (): Promise<void> => {
    if (completionInFlight.current) {
      return;
    }

    completionInFlight.current = true;
    setIsCompleting(true);
    setErrorMessage(null);

    try {
      const profile = await completeOnboarding();
      clearStoredSlide();
      onCompleted(profile);
    } catch (error) {
      if (error instanceof ApiRequestError && error.kind === 'auth') {
        onSessionExpired();
        return;
      }

      setErrorMessage(
        error instanceof ApiRequestError
          ? error.message
          : 'Не удалось завершить онбординг. Попробуйте ещё раз.',
      );
    } finally {
      completionInFlight.current = false;
      setIsCompleting(false);
    }
  };

  const trackStyle = {
    '--onboarding-slide': currentSlide,
    '--onboarding-drag-offset': `${dragOffset}px`,
  } as CSSProperties;

  return (
    <main className="onboarding-shell" data-testid="onboarding-screen">
      <section className="onboarding-panel">
        <header className="onboarding-topbar">
          <div className="survey-brand">
            <span className="survey-brand-mark" aria-hidden="true">
              K
            </span>
            <span>KINETRA</span>
          </div>
          <button
            className="ghost-button onboarding-settings"
            data-testid="open-settings"
            type="button"
            disabled={isCompleting}
            onClick={onOpenSettings}
          >
            Настройки
          </button>
        </header>

        <div
          className="onboarding-card"
          role="region"
          aria-roledescription="карусель"
          aria-label="Знакомство с Kinetra"
          aria-busy={isCompleting}
        >
          <p className="visually-hidden" aria-live="polite" aria-atomic="true">
            Слайд {currentSlide + 1} из {onboardingSlides.length}: {activeSlideTitle}
          </p>

          <div
            className="onboarding-viewport"
            data-testid="onboarding-viewport"
            tabIndex={0}
            aria-label="Слайды. Используйте стрелки влево и вправо для навигации"
            onKeyDown={handleKeyboard}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={finishPointerGesture}
            onPointerCancel={resetPointerGesture}
            onLostPointerCapture={resetPointerGesture}
          >
            <div
              className={`onboarding-track${isDragging ? ' is-dragging' : ''}`}
              style={trackStyle}
            >
              {onboardingSlides.map((slide, index) => {
                const isActive = index === currentSlide;

                return (
                  <article
                    className={`onboarding-slide${isActive ? ' is-active' : ''}`}
                    data-testid={`onboarding-slide-${index + 1}`}
                    key={slide.title}
                    role="group"
                    aria-roledescription="слайд"
                    aria-label={`${index + 1} из ${onboardingSlides.length}`}
                    aria-hidden={!isActive}
                  >
                    <div className="onboarding-slide-content">
                      <p className="onboarding-step">{String(index + 1).padStart(2, '0')}</p>
                      <h1>{slide.title}</h1>
                      {slide.subtitle === undefined ? null : <p>{slide.subtitle}</p>}
                      <SlideVisual index={index} />
                    </div>
                  </article>
                );
              })}
            </div>
          </div>

          <div className="onboarding-controls">
            <div className="onboarding-dots" role="group" aria-label="Слайды онбординга">
              {onboardingSlides.map((slide, index) => (
                <button
                  className={`onboarding-dot${index === currentSlide ? ' is-active' : ''}`}
                  data-testid={`onboarding-dot-${index + 1}`}
                  key={slide.title}
                  type="button"
                  disabled={isCompleting}
                  aria-label={`Перейти к слайду ${index + 1}: ${slide.title}`}
                  aria-current={index === currentSlide ? 'step' : undefined}
                  onClick={() => moveTo(index)}
                >
                  <span />
                </button>
              ))}
            </div>

            {errorMessage === null ? null : (
              <p className="onboarding-error" role="alert" data-testid="onboarding-error">
                {errorMessage}
              </p>
            )}

            <div className="onboarding-actions">
              {currentSlide === 0 ? (
                <span aria-hidden="true" />
              ) : (
                <button
                  className="secondary-button onboarding-back"
                  data-testid="onboarding-back"
                  type="button"
                  disabled={isCompleting}
                  onClick={() => moveBy(-1)}
                >
                  <ArrowIcon direction="back" />
                  Назад
                </button>
              )}

              {isLastSlide ? (
                <button
                  className="primary-button onboarding-complete"
                  data-testid="onboarding-complete"
                  type="button"
                  disabled={isCompleting}
                  onClick={() => void handleComplete()}
                >
                  {isCompleting ? 'Сохраняем…' : ONBOARDING_COMPLETE_LABEL}
                </button>
              ) : (
                <button
                  className="primary-button onboarding-next"
                  data-testid="onboarding-next"
                  type="button"
                  onClick={() => moveBy(1)}
                >
                  {ONBOARDING_NEXT_LABEL}
                  <ArrowIcon direction="next" />
                </button>
              )}
            </div>
          </div>
        </div>
      </section>
    </main>
  );
};
