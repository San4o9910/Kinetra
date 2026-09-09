import React, { type ReactNode } from 'react';

export interface ActiveAppHeaderProps {
  readonly displayName: string;
  readonly disabled: boolean;
  readonly settingsActive: boolean;
  readonly onOpenSettings: () => void;
}

export const ActiveAppHeader = ({
  displayName,
  disabled,
  settingsActive,
  onOpenSettings,
}: ActiveAppHeaderProps): ReactNode => (
  <React.Fragment>
    <header className="active-app-header" data-testid="active-app-header">
      <div className="active-app-brand" aria-label="Kinetra">
        <span className="active-app-brand-mark" aria-hidden="true">
          K
        </span>
        <span>
          KINETRA<small>ДВИЖЕНИЕ В ВАШЕМ РИТМЕ</small>
        </span>
      </div>
      <button
        className="active-app-profile"
        type="button"
        data-testid="header-settings"
        aria-label="Открыть настройки"
        aria-current={settingsActive ? 'page' : undefined}
        disabled={disabled}
        onClick={onOpenSettings}
      >
        <span className="active-app-profile-copy">
          <strong>{displayName}</strong>
          <span>Настройки</span>
        </span>
        <span className="active-app-avatar" aria-hidden="true">
          {Array.from(displayName.trim())[0]?.toLocaleUpperCase('ru-RU') ?? 'К'}
        </span>
      </button>
    </header>
  </React.Fragment>
);
