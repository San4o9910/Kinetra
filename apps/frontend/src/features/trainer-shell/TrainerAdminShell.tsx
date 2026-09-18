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
        <nav aria-label="Разделы тренера">
          <a
            href={appRoutes.trainerStudents}
            aria-current={route === appRoutes.trainerStudents ? 'page' : undefined}
            onClick={(event) => navigate(event, appRoutes.trainerStudents)}
          >
            Ученики
          </a>
          <a
            href={appRoutes.trainerLessons}
            aria-current={route === appRoutes.trainerLessons ? 'page' : undefined}
            onClick={(event) => navigate(event, appRoutes.trainerLessons)}
          >
            Мои уроки
          </a>
          <a
            href={appRoutes.trainerChats}
            aria-current={chatsActive ? 'page' : undefined}
            onClick={(event) => navigate(event, appRoutes.trainerChats)}
          >
            Диалоги
          </a>
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
    </div>
  );
};
