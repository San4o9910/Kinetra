import React, { useEffect, type ReactNode } from 'react';

export interface BaseLessonsRequiredDialogProps {
  readonly open: boolean;
  readonly completedLessons: number | null;
  readonly unlockThreshold: number | null;
  readonly onClose: () => void;
  readonly onOpenBaseLessons: () => void;
}

const progressCopy = (completedLessons: number | null, unlockThreshold: number | null): string => {
  if (completedLessons === null || unlockThreshold === null) {
    return 'Перед первой тренировкой нужно пройти базовую подготовку.';
  }

  return `Сейчас пройдено ${completedLessons} из ${unlockThreshold} необходимых уроков.`;
};

export const BaseLessonsRequiredDialog = ({
  open,
  completedLessons,
  unlockThreshold,
  onClose,
  onOpenBaseLessons,
}: BaseLessonsRequiredDialogProps): ReactNode => {
  const dialogRef = React.useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;

    if (dialog === null) {
      return;
    }

    if (open && !dialog.open) {
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  return (
    <dialog
      ref={dialogRef}
      className="base-lessons-required-dialog"
      data-testid="base-lessons-required-dialog"
      aria-labelledby="base-lessons-required-title"
      aria-describedby="base-lessons-required-description"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div className="base-lessons-required-sheet">
        <span className="base-lessons-required-mark" aria-hidden="true">
          K
        </span>
        <h2 id="base-lessons-required-title">Сначала подготовимся к тренировке</h2>
        <p id="base-lessons-required-description">
          {progressCopy(completedLessons, unlockThreshold)} Остальные разделы Kinetra можно свободно
          изучать уже сейчас.
        </p>
        <div className="base-lessons-required-actions">
          <button
            className="primary-button"
            data-testid="open-base-lessons"
            type="button"
            onClick={onOpenBaseLessons}
          >
            Пройти базовые уроки
          </button>
          <button
            className="ghost-button"
            data-testid="continue-exploring-app"
            type="button"
            onClick={onClose}
          >
            Вернуться к изучению приложения
          </button>
        </div>
      </div>
    </dialog>
  );
};
