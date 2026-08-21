import React, { useEffect, useRef, type ReactNode } from 'react';

export type SettingsDialogKind = 'level' | 'about' | 'renewal' | 'logout' | 'delete' | null;

const ManagedDialog = ({
  open,
  testId,
  labelledBy,
  describedBy,
  danger = false,
  onClose,
  children,
}: {
  readonly open: boolean;
  readonly testId: string;
  readonly labelledBy: string;
  readonly describedBy?: string;
  readonly danger?: boolean;
  readonly onClose: () => void;
  readonly children: ReactNode;
}): ReactNode => {
  const dialogRef = useRef<HTMLDialogElement>(null);

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
      className={`settings-dialog${danger ? ' is-danger' : ''}`}
      data-testid={testId}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
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
      <div className="settings-dialog-sheet">{children}</div>
    </dialog>
  );
};

const DialogActions = ({ children }: { readonly children: ReactNode }): ReactNode => (
  <div className="settings-dialog-actions">{children}</div>
);

export interface SettingsDialogsProps {
  readonly activeDialog: SettingsDialogKind;
  readonly appVersion: string;
  readonly privacyUrl: string;
  readonly deleteStage: 1 | 2;
  readonly deleteConfirmation: string;
  readonly busy: boolean;
  readonly error: string | null;
  readonly onClose: () => void;
  readonly onContinueDelete: () => void;
  readonly onDeleteConfirmationChange: (value: string) => void;
  readonly onCancelSubscription: () => void;
  readonly onLogout: () => void;
  readonly onDelete: () => void;
}

export const SettingsDialogs = ({
  activeDialog,
  appVersion,
  privacyUrl,
  deleteStage,
  deleteConfirmation,
  busy,
  error,
  onClose,
  onContinueDelete,
  onDeleteConfirmationChange,
  onCancelSubscription,
  onLogout,
  onDelete,
}: SettingsDialogsProps): ReactNode => (
  <React.Fragment>
    <ManagedDialog
      open={activeDialog === 'level'}
      testId="settings-level-dialog"
      labelledBy="settings-level-title"
      describedBy="settings-level-description"
      onClose={onClose}
    >
      <div className="settings-dialog-icon" aria-hidden="true">
        02
      </div>
      <h2 id="settings-level-title">Новые уровни уже в работе</h2>
      <p id="settings-level-description">
        Скоро будут доступны уровни «Мастерство» и «Пик». Мы сообщим, когда можно будет перейти.
      </p>
      <DialogActions>
        <button className="settings-dialog-primary" type="button" onClick={onClose}>
          Понятно
        </button>
      </DialogActions>
    </ManagedDialog>

    <ManagedDialog
      open={activeDialog === 'about'}
      testId="settings-about-dialog"
      labelledBy="settings-about-title"
      describedBy="settings-about-description"
      onClose={onClose}
    >
      <div className="settings-dialog-brand" aria-hidden="true">
        K
      </div>
      <h2 id="settings-about-title">Kinetra</h2>
      <p id="settings-about-description">
        Персональные тренировки, осознанное движение и ваш прогресс в одном приложении.
      </p>
      <dl className="settings-about-meta">
        <div>
          <dt>Версия</dt>
          <dd data-testid="settings-app-version">{appVersion}</dd>
        </div>
      </dl>
      <a className="settings-privacy-link" href={privacyUrl}>
        Политика конфиденциальности
      </a>
      <DialogActions>
        <button className="settings-dialog-primary" type="button" onClick={onClose}>
          Закрыть
        </button>
      </DialogActions>
    </ManagedDialog>

    <ManagedDialog
      open={activeDialog === 'renewal'}
      testId="settings-renewal-dialog"
      labelledBy="settings-renewal-title"
      describedBy="settings-renewal-description"
      onClose={onClose}
    >
      <h2 id="settings-renewal-title">Отменить автопродление?</h2>
      <p id="settings-renewal-description">
        Текущая подписка продолжит действовать до даты окончания. Новых списаний не будет.
      </p>
      {error === null ? null : (
        <p className="settings-dialog-error" role="alert">
          {error}
        </p>
      )}
      <DialogActions>
        <button
          className="settings-dialog-secondary"
          type="button"
          disabled={busy}
          onClick={onClose}
        >
          Не отменять
        </button>
        <button
          className="settings-dialog-primary"
          data-testid="settings-cancel-auto-renew-confirm"
          type="button"
          disabled={busy}
          onClick={onCancelSubscription}
        >
          {busy ? 'Отменяем…' : 'Отменить автопродление'}
        </button>
      </DialogActions>
    </ManagedDialog>

    <ManagedDialog
      open={activeDialog === 'logout'}
      testId="settings-logout-dialog"
      labelledBy="settings-logout-title"
      describedBy="settings-logout-description"
      onClose={onClose}
    >
      <h2 id="settings-logout-title">Выйти из аккаунта?</h2>
      <p id="settings-logout-description">
        На этом устройстве потребуется снова ввести email и пароль.
      </p>
      {error === null ? null : (
        <p className="settings-dialog-error" role="alert">
          {error}
        </p>
      )}
      <DialogActions>
        <button
          className="settings-dialog-secondary"
          type="button"
          disabled={busy}
          onClick={onClose}
        >
          Отмена
        </button>
        <button
          className="settings-dialog-primary"
          data-testid="logout-confirm"
          type="button"
          disabled={busy}
          onClick={onLogout}
        >
          {busy ? 'Выходим…' : 'Выйти'}
        </button>
      </DialogActions>
    </ManagedDialog>

    <ManagedDialog
      open={activeDialog === 'delete'}
      testId="settings-delete-dialog"
      labelledBy="settings-delete-title"
      describedBy="settings-delete-description"
      danger
      onClose={onClose}
    >
      <div className="settings-dialog-danger-mark" aria-hidden="true">
        !
      </div>
      <h2 id="settings-delete-title">
        {deleteStage === 1 ? 'Удалить аккаунт?' : 'Последнее подтверждение'}
      </h2>
      <p id="settings-delete-description">
        {deleteStage === 1
          ? 'Профиль, прогресс, тренировки и достижения будут удалены без возможности восстановления.'
          : 'Введите DELETE заглавными буквами. Это действие нельзя отменить.'}
      </p>

      {deleteStage === 2 ? (
        <label className="settings-delete-confirmation">
          Подтверждение
          <input
            data-testid="settings-delete-confirmation"
            type="text"
            value={deleteConfirmation}
            placeholder="DELETE"
            autoComplete="off"
            spellCheck={false}
            disabled={busy}
            onChange={(event) => onDeleteConfirmationChange(event.currentTarget.value)}
          />
        </label>
      ) : null}

      {error === null ? null : (
        <p className="settings-dialog-error" role="alert">
          {error}
        </p>
      )}

      <DialogActions>
        <button
          className="settings-dialog-secondary"
          type="button"
          disabled={busy}
          onClick={onClose}
        >
          Отмена
        </button>
        {deleteStage === 1 ? (
          <button
            className="settings-dialog-danger"
            data-testid="settings-delete-continue"
            type="button"
            onClick={onContinueDelete}
          >
            Продолжить
          </button>
        ) : (
          <button
            className="settings-dialog-danger"
            data-testid="settings-delete-confirm"
            type="button"
            disabled={busy || deleteConfirmation !== 'DELETE'}
            onClick={onDelete}
          >
            {busy ? 'Удаляем…' : 'Удалить навсегда'}
          </button>
        )}
      </DialogActions>
    </ManagedDialog>
  </React.Fragment>
);
