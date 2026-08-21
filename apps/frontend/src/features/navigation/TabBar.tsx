import React, { type MouseEvent, type ReactNode } from 'react';

import { appRoutes, isSettingsRoute, type AppRoute } from '../../routing';

type TabIconName = 'home' | 'calendar' | 'progress' | 'settings';

interface TabItem {
  readonly route: AppRoute;
  readonly label: string;
  readonly testId: string;
  readonly icon: TabIconName;
}

const tabItems: readonly TabItem[] = [
  { route: appRoutes.home, label: 'Главная', testId: 'tab-home', icon: 'home' },
  {
    route: appRoutes.schedule,
    label: 'Расписание',
    testId: 'tab-schedule',
    icon: 'calendar',
  },
  {
    route: appRoutes.progress,
    label: 'Прогресс',
    testId: 'tab-progress',
    icon: 'progress',
  },
  { route: appRoutes.settings, label: 'Настройки', testId: 'tab-settings', icon: 'settings' },
];

const TabIcon = ({ name }: { readonly name: TabIconName }): ReactNode => {
  if (name === 'home') {
    return React.createElement(
      'svg',
      { className: 'tab-bar-icon', viewBox: '0 0 24 24', 'aria-hidden': true },
      React.createElement('path', {
        d: 'm3.5 10.8 8.5-7 8.5 7v9a1.2 1.2 0 0 1-1.2 1.2h-4.6v-6.2H9.3V21H4.7a1.2 1.2 0 0 1-1.2-1.2Z',
      }),
    );
  }

  if (name === 'calendar') {
    return (
      <svg className="tab-bar-icon" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M5 3.5v3M19 3.5v3M3.5 9h17M5 5h14a1.5 1.5 0 0 1 1.5 1.5v13A1.5 1.5 0 0 1 19 21H5a1.5 1.5 0 0 1-1.5-1.5v-13A1.5 1.5 0 0 1 5 5Z" />
      </svg>
    );
  }

  if (name === 'progress') {
    return (
      <svg className="tab-bar-icon" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M5 20V12M12 20V4M19 20v-11" />
      </svg>
    );
  }

  return (
    <svg className="tab-bar-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M9.8 3.7 10.5 2h3l.7 1.7 1.7.7 1.7-.7 2.1 2.1-.7 1.7.7 1.7 1.8.8v3l-1.8.8-.7 1.7.7 1.7-2.1 2.1-1.7-.7-1.7.7-.7 1.8h-3l-.7-1.8-1.7-.7-1.7.7-2.1-2.1.7-1.7-.7-1.7L2.5 13v-3l1.8-.8.7-1.7-.7-1.7 2.1-2.1 1.7.7Z" />
      <circle cx="12" cy="11.5" r="3" />
    </svg>
  );
};

export interface TabBarProps {
  readonly route: AppRoute;
  readonly disabled?: boolean;
  readonly onNavigate: (route: AppRoute) => void;
}

export const TabBar = ({ route, disabled = false, onNavigate }: TabBarProps): ReactNode => {
  const activeRoute = isSettingsRoute(route) ? appRoutes.settings : route;

  const navigate = (event: MouseEvent<HTMLAnchorElement>, nextRoute: AppRoute): void => {
    if (disabled) {
      event.preventDefault();
      return;
    }

    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }

    event.preventDefault();
    onNavigate(nextRoute);
  };

  return (
    <nav
      className={`tab-bar${disabled ? ' is-disabled' : ''}`}
      data-testid="tab-bar"
      aria-label="Основная навигация"
      aria-busy={disabled}
    >
      <div className="tab-bar-inner">
        {tabItems.map((item) => {
          const active = activeRoute === item.route;

          return (
            <a
              key={item.route}
              className={`tab-bar-link${active ? ' is-active' : ''}`}
              data-testid={item.testId}
              href={item.route}
              aria-current={active ? 'page' : undefined}
              aria-disabled={disabled ? 'true' : undefined}
              tabIndex={disabled ? -1 : undefined}
              onClick={(event) => navigate(event, item.route)}
            >
              <TabIcon name={item.icon} />
              <span>{item.label}</span>
            </a>
          );
        })}
      </div>
    </nav>
  );
};
