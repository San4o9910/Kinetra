import React, { type MouseEvent, type ReactNode } from 'react';

import { appRoutes, type AppRoute } from '../../routing';
import { chatFabAccessibleName, chatUnreadBadge } from '../chat/model';

type TabIconName = 'home' | 'calendar' | 'progress' | 'chat';

interface TabItem {
  readonly route: AppRoute;
  readonly label: string;
  readonly testId: string;
  readonly icon: TabIconName;
}

const tabItems: readonly TabItem[] = [
  { route: appRoutes.home, label: 'Сегодня', testId: 'tab-home', icon: 'home' },
  {
    route: appRoutes.schedule,
    label: 'План',
    testId: 'tab-schedule',
    icon: 'calendar',
  },
  {
    route: appRoutes.progress,
    label: 'Прогресс',
    testId: 'tab-progress',
    icon: 'progress',
  },
  { route: appRoutes.chat, label: 'Тренер', testId: 'tab-chat', icon: 'chat' },
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

  if (name === 'chat') {
    return (
      <svg className="tab-bar-icon" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M5 4.5h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-7.8L6 21v-3.5H5a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2Z" />
        <path d="M7.5 9h9M7.5 13h6" />
      </svg>
    );
  }

  return null;
};

export interface TabBarProps {
  readonly route: AppRoute;
  readonly disabled?: boolean;
  readonly showChat: boolean;
  readonly chatUnreadCount: number;
  readonly onNavigate: (route: AppRoute) => void;
}

export const TabBar = ({
  route,
  disabled = false,
  showChat,
  chatUnreadCount,
  onNavigate,
}: TabBarProps): ReactNode => {
  const activeRoute = route;
  const visibleItems = showChat
    ? tabItems
    : tabItems.filter((item) => item.route !== appRoutes.chat);

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
      <div className={`tab-bar-inner${showChat ? ' has-chat' : ''}`}>
        {visibleItems.map((item) => {
          const active = activeRoute === item.route;
          const unreadBadge =
            item.route === appRoutes.chat ? chatUnreadBadge(chatUnreadCount) : null;

          return (
            <a
              key={item.route}
              className={`tab-bar-link${active ? ' is-active' : ''}`}
              data-testid={item.testId}
              href={item.route}
              aria-label={
                item.route === appRoutes.chat ? chatFabAccessibleName(chatUnreadCount) : undefined
              }
              aria-current={active ? 'page' : undefined}
              aria-disabled={disabled ? 'true' : undefined}
              tabIndex={disabled ? -1 : undefined}
              onClick={(event) => navigate(event, item.route)}
            >
              <span className="tab-bar-icon-wrap">
                <TabIcon name={item.icon} />
                {unreadBadge === null ? null : (
                  <span className="tab-bar-badge" data-testid="tab-chat-badge" aria-hidden="true">
                    {unreadBadge}
                  </span>
                )}
              </span>
              <span>{item.label}</span>
            </a>
          );
        })}
      </div>
    </nav>
  );
};
