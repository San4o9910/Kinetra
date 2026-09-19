import { KineticMark } from '../navigation/KineticMark';
import type { ReactNode, MouseEvent } from 'react';

import { appRoutes, type AppRoute } from '../../routing';

export interface TrainerAdminShellProps {
  readonly route: AppRoute;
  readonly canReview?: boolean;
  readonly canManageVideos: boolean;
  readonly onNavigate: (route: AppRoute) => void;
  readonly onSignOut: () => void;
  readonly children: ReactNode;
}

export const TrainerAdminShell = ({
  route,
  canManageVideos,
  canReview = false,
  onNavigate,
  onSignOut,
  children,
}: TrainerAdminShellProps): ReactNode => {
  const navigate = (event: MouseEvent<HTMLAnchorElement>, next: AppRoute): void => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
      return;
    event.preventDefault();
    onNavigate(next);
  };
  const chatsActive = route === appRoutes.trainerChats || route.startsWith('/trainer/chats/');
  return (
    <div className="trainer-admin-shell">
      <header className="trainer-admin-header">
        <a
          className="trainer-admin-brand"
          href={appRoutes.trainerStudents}
          onClick={(event) => navigate(event, appRoutes.trainerStudents)}
          aria-label="Kinetra — рабочее пространство тренера"
        >
          <span aria-hidden="true">
            <KineticMark />
          </span>
          <strong>KINETRA</strong>
        </a>
        <nav aria-label="Дополнительные разделы тренера">
          {canManageVideos ? (
            <a
              href={appRoutes.trainerVideos}
              aria-current={route === appRoutes.trainerVideos ? 'page' : undefined}
              onClick={(event) => navigate(event, appRoutes.trainerVideos)}
            >
              Общий курс
            </a>
          ) : null}
          {canReview && (
            <a
              href={appRoutes.adminApplications}
              onClick={(event) => navigate(event, appRoutes.adminApplications)}
            >
              Заявки тренеров
            </a>
          )}
        </nav>
        <button type="button" onClick={onSignOut}>
          Выйти
        </button>
      </header>
      <div className="trainer-admin-content">{children}</div>
      <nav className="trainer-bottom-nav" aria-label="Разделы тренера">
        {[
          {
            route: appRoutes.trainerStudents,
            label: 'Ученики',
            icon: 'M4 21v-2a5 5 0 0 1 10 0v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M17 4a4 4 0 0 1 0 8M20 21v-2a5 5 0 0 0-3-4.6',
          },
          {
            route: appRoutes.trainerLessons,
            label: 'Мои уроки',
            icon: 'M4 4h16v16H4zM10 8l6 4-6 4z',
          },
          {
            route: appRoutes.trainerChats,
            label: 'Чат',
            icon: 'M4 4h16v13H10l-5 4v-4H4zM8 8h8M8 12h6',
          },
          {
            route: appRoutes.trainerProfile,
            label: 'Профиль',
            icon: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8M4 21v-2a8 6 0 0 1 16 0v2',
          },
        ].map((item) => (
          <a
            key={item.route}
            href={item.route}
            aria-current={
              (item.route === appRoutes.trainerChats ? chatsActive : route === item.route)
                ? 'page'
                : undefined
            }
            onClick={(event) => navigate(event, item.route)}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d={item.icon} />
            </svg>
            <span>{item.label}</span>
          </a>
        ))}
      </nav>
    </div>
  );
};
