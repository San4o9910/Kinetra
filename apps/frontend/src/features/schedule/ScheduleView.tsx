import React, { useRef, type KeyboardEvent, type ReactNode } from 'react';
import type { ProgramScheduleDay, ProgramScheduleWeek, ScheduleResponse } from '@kinetra/shared';

export type ScheduleSection = 'current' | 'next';

export interface ScheduleViewProps {
  readonly response: ScheduleResponse;
  readonly activeSection: ScheduleSection;
  readonly onSectionChange: (section: ScheduleSection) => void;
  readonly onOpenDay: (day: ProgramScheduleDay) => void;
}

interface ScheduleDayCardProps {
  readonly day: ProgramScheduleDay;
  readonly section: ScheduleSection;
  readonly onOpen: (day: ProgramScheduleDay) => void;
}

const ClockIcon = (): ReactNode => (
  <svg className="schedule-clock-icon" viewBox="0 0 20 20" aria-hidden="true">
    <circle cx="10" cy="10" r="7" />
    <path d="M10 6v4l2.7 1.7" />
  </svg>
);

const ScheduleDayCard = ({ day, section, onOpen }: ScheduleDayCardProps): ReactNode => {
  const completed = section === 'current' && day.completed;
  const description = day.description?.trim() ?? '';

  return (
    <li>
      <button
        className={`schedule-day-card${completed ? ' is-completed' : ''}`}
        data-testid={`schedule-${section}-day-${day.day_of_week}`}
        data-completed={completed ? 'true' : 'false'}
        type="button"
        aria-label={`${day.day_label}. ${day.title}${description.length === 0 ? '' : `. ${description}`}. ${day.duration_minutes} минут${completed ? '. Выполнено' : ''}. Открыть на главной`}
        onClick={() => onOpen(day)}
      >
        <span className="schedule-day-icon" aria-hidden="true">
          {day.icon}
        </span>
        <span className="schedule-day-copy">
          <strong>{day.day_label}</strong>
          <span className="schedule-day-title">{day.title}</span>
          {description.length === 0 ? null : (
            <span className="schedule-day-description">{description}</span>
          )}
          <span className="schedule-day-duration">
            <ClockIcon />
            {day.duration_minutes} мин
          </span>
        </span>
        {completed ? (
          <span
            className="schedule-day-completed"
            data-testid={`schedule-completed-${day.day_of_week}`}
          >
            <span aria-hidden="true">✅</span>
            <span className="visually-hidden">Выполнено</span>
          </span>
        ) : (
          <span className="schedule-day-chevron" aria-hidden="true">
            ›
          </span>
        )}
      </button>
    </li>
  );
};

interface ScheduleWeekSectionProps {
  readonly week: ProgramScheduleWeek;
  readonly section: ScheduleSection;
  readonly tabbed: boolean;
  readonly onOpenDay: (day: ProgramScheduleDay) => void;
}

const ScheduleWeekSection = ({
  week,
  section,
  tabbed,
  onOpenDay,
}: ScheduleWeekSectionProps): ReactNode => {
  const current = section === 'current';
  const headingId = `schedule-${section}-week-heading`;

  return (
    <section
      className="schedule-week-section"
      data-testid={`schedule-panel-${section}`}
      id={`schedule-panel-${section}`}
      role={tabbed ? 'tabpanel' : 'region'}
      aria-labelledby={tabbed ? `schedule-tab-${section}` : headingId}
    >
      <header className="schedule-week-summary">
        <h2 id={headingId} data-testid={`schedule-${section}-week-heading`}>
          {current ? 'Текущая неделя' : 'Следующая неделя'} <span>· {week.week_number}</span>
        </h2>
        {current ? (
          <p
            data-testid="schedule-progress"
            role="progressbar"
            aria-label="Прогресс текущей недели"
            aria-valuemin={0}
            aria-valuemax={week.total_days}
            aria-valuenow={week.days_completed}
            aria-valuetext={`Выполнено ${week.days_completed} из ${week.total_days}`}
          >
            Выполнено {week.days_completed} из {week.total_days}
          </p>
        ) : (
          <p>План на следующую неделю</p>
        )}
      </header>

      <ol className="schedule-day-list" aria-labelledby={headingId}>
        {week.days.map((day) => (
          <ScheduleDayCard key={day.day_of_week} day={day} section={section} onOpen={onOpenDay} />
        ))}
      </ol>
    </section>
  );
};

const HiddenSchedulePanel = ({ section }: { readonly section: ScheduleSection }): ReactNode => (
  <section
    id={`schedule-panel-${section}`}
    role="tabpanel"
    aria-labelledby={`schedule-tab-${section}`}
    hidden
  />
);

export const ScheduleView = ({
  response,
  activeSection,
  onSectionChange,
  onOpenDay,
}: ScheduleViewProps): ReactNode => {
  const currentTabRef = useRef<HTMLButtonElement>(null);
  const nextTabRef = useRef<HTMLButtonElement>(null);
  const hasNextWeek = response.next_week !== null;
  const visibleSection = hasNextWeek ? activeSection : 'current';

  const selectFromKeyboard = (
    event: KeyboardEvent<HTMLButtonElement>,
    nextSection: ScheduleSection,
  ): void => {
    event.preventDefault();
    onSectionChange(nextSection);
    (nextSection === 'current' ? currentTabRef : nextTabRef).current?.focus();
  };

  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (!hasNextWeek) {
      return;
    }

    if (event.key === 'ArrowLeft' || event.key === 'Home') {
      selectFromKeyboard(event, 'current');
    } else if (event.key === 'ArrowRight' || event.key === 'End') {
      selectFromKeyboard(event, 'next');
    }
  };

  return (
    <main
      className="schedule-shell"
      data-testid="schedule-screen"
      aria-labelledby="schedule-heading"
    >
      <div className="schedule-panel">
        <header className="schedule-header">
          <h1 id="schedule-heading">Расписание</h1>
          <p>Две недели в одном ритме — текущая работа и следующий шаг.</p>
        </header>

        {hasNextWeek ? (
          <div className="schedule-segmented" data-testid="schedule-segmented" role="tablist">
            <button
              ref={currentTabRef}
              className={visibleSection === 'current' ? 'is-active' : ''}
              data-testid="schedule-segment-current"
              id="schedule-tab-current"
              type="button"
              role="tab"
              aria-controls="schedule-panel-current"
              aria-selected={visibleSection === 'current'}
              tabIndex={visibleSection === 'current' ? 0 : -1}
              onClick={() => onSectionChange('current')}
              onKeyDown={handleTabKeyDown}
            >
              Текущая
            </button>
            <button
              ref={nextTabRef}
              className={visibleSection === 'next' ? 'is-active' : ''}
              data-testid="schedule-segment-next"
              id="schedule-tab-next"
              type="button"
              role="tab"
              aria-controls="schedule-panel-next"
              aria-selected={visibleSection === 'next'}
              tabIndex={visibleSection === 'next' ? 0 : -1}
              onClick={() => onSectionChange('next')}
              onKeyDown={handleTabKeyDown}
            >
              Следующая
            </button>
          </div>
        ) : null}

        {visibleSection === 'current' || response.next_week === null ? (
          <React.Fragment>
            <ScheduleWeekSection
              week={response.current_week}
              section="current"
              tabbed={hasNextWeek}
              onOpenDay={onOpenDay}
            />
            {hasNextWeek ? <HiddenSchedulePanel section="next" /> : null}
          </React.Fragment>
        ) : (
          <React.Fragment>
            <HiddenSchedulePanel section="current" />
            <ScheduleWeekSection
              week={response.next_week}
              section="next"
              tabbed
              onOpenDay={onOpenDay}
            />
          </React.Fragment>
        )}

        {response.next_week === null ? (
          <p className="schedule-final-message" data-testid="schedule-final-message">
            Вы на финальной неделе программы! <span aria-hidden="true">🎉</span>
          </p>
        ) : null}
      </div>
    </main>
  );
};
