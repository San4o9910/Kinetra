import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { MeResponse, SubscriptionResponse } from '@kinetra/shared';

import { LoginScreen } from './features/auth/LoginScreen';
import { BaseLessonsScreen } from './features/base-lessons/BaseLessonsScreen';
import { TabBar } from './features/navigation/TabBar';
import { OnboardingCarousel } from './features/onboarding/OnboardingCarousel';
import { PaymentCancelScreen } from './features/payments/PaymentCancelScreen';
import { PaymentScreen } from './features/payments/PaymentScreen';
import { PaymentSuccessScreen } from './features/payments/PaymentSuccessScreen';
import { isSubscriptionActive } from './features/payments/model';
import { SubscriptionLockedScreen } from './features/payments/SubscriptionLockedScreen';
import { SubscriptionVerificationState } from './features/payments/SubscriptionVerificationState';
import { ProgressScreen } from './features/progress/ProgressScreen';
import { clearWorkoutHistorySentinel } from './features/program/history';
import { ProgramScreen } from './features/program/ProgramScreen';
import { ScheduleScreen } from './features/schedule/ScheduleScreen';
import { SettingsScreen } from './features/settings/SettingsScreen';
import { settleBestEffortWithin } from './features/settings/accountLifecycle';
import { SurveyWizard } from './features/survey/SurveyWizard';
import { ChatFloatingButton, ClientChatScreen, useChatRuntime } from './features/chat';
import { TrainerChatsScreen } from './features/trainer-chat';
import { useOnlineStatus } from './hooks/useOnlineStatus';
import {
  ApiRequestError,
  bootstrapSession,
  chatRuntimeApi,
  ensureAccessToken,
  fetchMe,
  getSubscription,
  invalidateInMemorySession,
  prepareLogout,
  preparePushSubscriptionDeletion,
  refreshInMemoryAccessToken,
  type PreparedLogoutAttempt,
  type PreparedPushSubscriptionDeletion,
} from './lib/api';
import { bestEffortUnsubscribeFromPush } from './pwa/pushNotifications';
import { createFeatureChatRealtimeClient } from './realtime/socket';
import {
  appRoutes,
  isActiveAppRoute,
  isChatFabRoute,
  isPaymentRoute,
  isSettingsRoute,
  isTrainerRoute,
  normalizeAppRoute,
  routeForOnboardingStatus,
  trainerConversationIdFromRoute,
  trainerConversationRoute,
  type AppRoute,
} from './routing';

const runtimeEnv = (typeof import.meta.env === 'object' ? import.meta.env : {}) as ImportMetaEnv;
const supportEmail = runtimeEnv.VITE_SUPPORT_EMAIL ?? 'coach@kinetra.app';
const PUSH_BEST_EFFORT_TIMEOUT_MS = 1_500;

const chatUnavailableMessage = (
  reason: 'disabled' | 'trainer_unavailable' | 'not_available',
): string => {
  if (reason === 'disabled') {
    return 'Чат временно отключён.';
  }

  if (reason === 'trainer_unavailable') {
    return 'Персональный тренер пока не назначен.';
  }

  return 'Чат недоступен для этого аккаунта.';
};

const clientDisplayName = (profile: MeResponse): string =>
  profile.user.firstName ?? profile.user.username ?? 'Вы';

interface SystemStateProps {
  readonly kind: 'offline' | 'server';
  readonly message: string;
  readonly onRetry: () => void;
}

const SystemState = ({ kind, message, onRetry }: SystemStateProps): ReactNode => (
  <main className="app-shell" data-testid={`${kind}-screen`}>
    <section className="stage-card system-state" aria-labelledby="system-state-title">
      <div className="survey-brand">
        <span className="survey-brand-mark" aria-hidden="true">
          K
        </span>
        <span>KINETRA</span>
      </div>
      <p className="survey-kicker">{kind === 'offline' ? 'НЕТ СЕТИ' : 'СЕРВЕР НЕДОСТУПЕН'}</p>
      <h1 id="system-state-title">
        {kind === 'offline' ? 'Проверьте подключение' : 'Попробуем ещё раз'}
      </h1>
      <p>{message}</p>
      <button
        className="primary-button system-state-action"
        data-testid="retry-session"
        type="button"
        onClick={onRetry}
      >
        Повторить
      </button>
    </section>
  </main>
);

interface ActiveAppShellProps {
  readonly route: AppRoute;
  readonly navigationDisabled: boolean;
  readonly chatFabHidden: boolean;
  readonly chatUnreadCount: number;
  readonly onOpenChat: () => void;
  readonly onNavigate: (route: AppRoute) => void;
  readonly children: ReactNode;
}

const ActiveAppShell = ({
  route,
  navigationDisabled,
  chatFabHidden,
  chatUnreadCount,
  onOpenChat,
  onNavigate,
  children,
}: ActiveAppShellProps): ReactNode => (
  <div className="active-app-shell">
    <div className="active-app-content">{children}</div>
    <ChatFloatingButton unreadCount={chatUnreadCount} hidden={chatFabHidden} onOpen={onOpenChat} />
    <TabBar route={route} disabled={navigationDisabled} onNavigate={onNavigate} />
  </div>
);

interface ChatRouteStateProps {
  readonly kind: 'loading' | 'error' | 'unavailable';
  readonly message: string;
  readonly onBack: () => void;
  readonly backLabel?: string;
  readonly onRetry?: () => void;
  readonly showEmailFallback?: boolean;
}

const ChatRouteState = ({
  kind,
  message,
  onBack,
  backLabel = 'Назад',
  onRetry,
  showEmailFallback = false,
}: ChatRouteStateProps): ReactNode => (
  <main className="chat-bootstrap-shell" data-testid={`chat-runtime-${kind}`}>
    <section className="chat-bootstrap-card" aria-live="polite">
      <p className="survey-kicker">ЧАТ KINETRA</p>
      <h1>
        {kind === 'loading'
          ? 'Открываем защищённый чат'
          : kind === 'unavailable'
            ? 'Чат пока недоступен'
            : 'Чат не загрузился'}
      </h1>
      <p>{message}</p>
      <div className="chat-bootstrap-actions">
        {onRetry === undefined ? null : (
          <button className="primary-button" type="button" onClick={onRetry}>
            Повторить
          </button>
        )}
        {showEmailFallback ? <a href={`mailto:${supportEmail}`}>Написать в поддержку</a> : null}
        <button type="button" onClick={onBack}>
          {backLabel}
        </button>
      </div>
    </section>
  </main>
);

export type TrainerSignOutUiState = 'pending' | 'failed';

export const TrainerSignOutState = React.memo(
  ({
    state,
    onRetry,
  }: {
    readonly state: TrainerSignOutUiState;
    readonly onRetry: () => void;
  }): ReactNode => (
    <main className="chat-bootstrap-shell" data-testid={`trainer-sign-out-${state}`}>
      <section className="chat-bootstrap-card" aria-live="assertive">
        <p className="survey-kicker">ЗАЩИЩЁННЫЙ ВЫХОД</p>
        <h1>{state === 'pending' ? 'Завершаем сессию' : 'Выход не завершен'}</h1>
        <p>
          {state === 'pending'
            ? 'Подтверждаем отзыв сессии на сервере. Рабочие диалоги временно скрыты.'
            : 'Сервер не подтвердил отзыв сессии. Вы по-прежнему вошли в аккаунт.'}
        </p>
        {state === 'failed' ? (
          <div className="chat-bootstrap-actions">
            <button className="primary-button" type="button" onClick={onRetry}>
              Повторить
            </button>
          </div>
        ) : null}
      </section>
    </main>
  ),
);

type SessionState =
  | { readonly kind: 'booting' }
  | { readonly kind: 'unauthenticated' }
  | { readonly kind: 'offline'; readonly message: string }
  | { readonly kind: 'server'; readonly message: string }
  | { readonly kind: 'authenticated'; readonly profile: MeResponse };

type SubscriptionLoadState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly subscription: SubscriptionResponse }
  | { readonly kind: 'error'; readonly message: string };

interface TrainerSignOutAttempt {
  readonly logout: PreparedLogoutAttempt;
  readonly deleteSubscription: PreparedPushSubscriptionDeletion;
}

const routeAtStartup = (): AppRoute =>
  typeof window === 'undefined' ? appRoutes.login : normalizeAppRoute(window.location.pathname);

const useBrowserRoute = (): readonly [AppRoute, (route: AppRoute, replace?: boolean) => void] => {
  const [route, setRoute] = useState<AppRoute>(routeAtStartup);

  useEffect(() => {
    const handlePopState = (): void => setRoute(normalizeAppRoute(window.location.pathname));
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  const navigate = useCallback((nextRoute: AppRoute, replace = false): void => {
    if (typeof window !== 'undefined' && window.location.pathname !== nextRoute) {
      if (replace) {
        window.history.replaceState(null, '', nextRoute);
      } else {
        window.history.pushState(null, '', nextRoute);
      }
      window.scrollTo({ top: 0, behavior: 'auto' });
    }

    setRoute(nextRoute);
  }, []);

  return [route, navigate] as const;
};

export const App = (): ReactNode => {
  const [session, setSession] = useState<SessionState>({ kind: 'booting' });
  const [route, navigate] = useBrowserRoute();
  const [workoutCompletionBusy, setWorkoutCompletionBusy] = useState(false);
  const [blockingDialogOpen, setBlockingDialogOpen] = useState(false);
  const [trainerSignOutState, setTrainerSignOutState] = useState<'idle' | TrainerSignOutUiState>(
    'idle',
  );
  const [subscriptionState, setSubscriptionState] = useState<SubscriptionLoadState>({
    kind: 'idle',
  });
  const subscriptionControllerRef = useRef<AbortController | null>(null);
  const subscriptionRequestVersionRef = useRef(0);
  const chatDisposeRef = useRef<() => void>(() => undefined);
  const chatSuspendRef = useRef<() => void>(() => undefined);
  const trainerSignOutBusyRef = useRef(false);
  const trainerSignOutAttemptRef = useRef<TrainerSignOutAttempt | null>(null);
  const authenticatedUserIdRef = useRef<string | null>(null);
  const online = useOnlineStatus();
  const chatRealtime = useMemo(
    () => createFeatureChatRealtimeClient(ensureAccessToken, refreshInMemoryAccessToken),
    [],
  );

  const navigateActiveTab = useCallback(
    (nextRoute: AppRoute): void => {
      if (workoutCompletionBusy) {
        return;
      }

      const workoutVideoId = window.history.state?.kinetraWorkoutVideoId;

      if (typeof workoutVideoId === 'string') {
        if (window.location.pathname === nextRoute) {
          window.history.back();
          return;
        }

        window.history.replaceState(null, '', nextRoute);
      }

      navigate(nextRoute);
    },
    [navigate, workoutCompletionBusy],
  );

  const handleActiveSessionExpired = useCallback((): void => {
    invalidateInMemorySession();
    chatDisposeRef.current();
    subscriptionControllerRef.current?.abort();
    subscriptionRequestVersionRef.current += 1;
    setSubscriptionState({ kind: 'idle' });
    setSession({ kind: 'unauthenticated' });
    navigate(appRoutes.login, true);
  }, [navigate]);

  const loadSubscription = useCallback(
    (announceLoading = true): void => {
      subscriptionControllerRef.current?.abort();
      const controller = new AbortController();
      const version = ++subscriptionRequestVersionRef.current;
      subscriptionControllerRef.current = controller;

      if (announceLoading) {
        setSubscriptionState({ kind: 'loading' });
      }

      void getSubscription(controller.signal)
        .then((subscription) => {
          if (!controller.signal.aborted && subscriptionRequestVersionRef.current === version) {
            setSubscriptionState({ kind: 'ready', subscription });
          }
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted || subscriptionRequestVersionRef.current !== version) {
            return;
          }

          if (error instanceof ApiRequestError && error.kind === 'auth') {
            handleActiveSessionExpired();
            return;
          }

          setSubscriptionState({
            kind: 'error',
            message:
              error instanceof ApiRequestError
                ? error.message
                : 'Не удалось проверить подписку. Попробуйте ещё раз.',
          });
        })
        .finally(() => {
          if (subscriptionControllerRef.current === controller) {
            subscriptionControllerRef.current = null;
          }
        });
    },
    [handleActiveSessionExpired],
  );

  const handleSubscriptionUpdated = useCallback((subscription: SubscriptionResponse): void => {
    subscriptionControllerRef.current?.abort();
    subscriptionRequestVersionRef.current += 1;
    setSubscriptionState({ kind: 'ready', subscription });
  }, []);

  const restoreSession = useCallback(async (signal?: AbortSignal): Promise<void> => {
    setSession({ kind: 'booting' });

    try {
      const restored = await bootstrapSession();

      if (!restored) {
        setSession({ kind: 'unauthenticated' });
        return;
      }

      const profile = await fetchMe(signal);
      setSession({ kind: 'authenticated', profile });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        return;
      }

      if (error instanceof ApiRequestError) {
        if (error.kind === 'auth') {
          setSession({ kind: 'unauthenticated' });
          return;
        }

        if (error.kind === 'network') {
          setSession({ kind: 'offline', message: error.message });
          return;
        }

        setSession({ kind: 'server', message: error.message });
        return;
      }

      setSession({
        kind: 'server',
        message: 'Не удалось загрузить профиль. Попробуйте ещё раз.',
      });
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void restoreSession(controller.signal);
    return () => controller.abort();
  }, [restoreSession]);

  useEffect(() => {
    if (session.kind !== 'offline') {
      return;
    }

    const retryWhenOnline = (): void => void restoreSession();
    window.addEventListener('online', retryWhenOnline);
    return () => window.removeEventListener('online', retryWhenOnline);
  }, [restoreSession, session.kind]);

  const authenticatedUserId = session.kind === 'authenticated' ? session.profile.user.id : null;
  const authenticatedRole = session.kind === 'authenticated' ? session.profile.account_role : null;
  const chatEnabled =
    session.kind === 'authenticated' &&
    (session.profile.account_role === 'trainer' ||
      session.profile.user.onboardingStatus === 'active');
  const chatRuntime = useChatRuntime({
    accountId: authenticatedUserId,
    role: authenticatedRole,
    enabled: chatEnabled,
    api: chatRuntimeApi,
    realtime: chatRealtime,
    onSessionExpired: handleActiveSessionExpired,
  });
  chatDisposeRef.current = chatRuntime.disposeNow;
  chatSuspendRef.current = chatRuntime.suspendNow;
  authenticatedUserIdRef.current = authenticatedUserId;

  const finishSignedOut = useCallback((): void => {
    subscriptionControllerRef.current?.abort();
    subscriptionRequestVersionRef.current += 1;
    setSubscriptionState({ kind: 'idle' });
    setBlockingDialogOpen(false);
    setSession({ kind: 'unauthenticated' });
    navigate(appRoutes.login, true);
  }, [navigate]);

  const handleTrainerSignOut = useCallback((): void => {
    if (trainerSignOutBusyRef.current) {
      return;
    }

    let attempt = trainerSignOutAttemptRef.current;

    if (attempt === null || !attempt.logout.isCurrent()) {
      try {
        attempt = {
          logout: prepareLogout(),
          deleteSubscription: preparePushSubscriptionDeletion(),
        };
        trainerSignOutAttemptRef.current = attempt;
      } catch {
        setTrainerSignOutState('failed');
        return;
      }
    }

    trainerSignOutBusyRef.current = true;
    setTrainerSignOutState('pending');
    chatSuspendRef.current();

    void settleBestEffortWithin(
      (control) =>
        bestEffortUnsubscribeFromPush({
          ...control,
          deleteSubscription: attempt.deleteSubscription,
        }),
      PUSH_BEST_EFFORT_TIMEOUT_MS,
    )
      .then(() => attempt.logout.execute())
      .then((completion) => {
        if (
          trainerSignOutAttemptRef.current !== attempt ||
          authenticatedUserIdRef.current !== attempt.logout.subjectId ||
          !attempt.logout.isCompletionCurrent(completion)
        ) {
          return;
        }

        trainerSignOutAttemptRef.current = null;
        trainerSignOutBusyRef.current = false;
        setTrainerSignOutState('idle');
        chatDisposeRef.current();
        finishSignedOut();
      })
      .catch(() => {
        if (
          trainerSignOutAttemptRef.current !== attempt ||
          authenticatedUserIdRef.current !== attempt.logout.subjectId
        ) {
          return;
        }

        trainerSignOutBusyRef.current = false;
        setTrainerSignOutState('failed');
      });
  }, [finishSignedOut]);

  useEffect(() => {
    const attempt = trainerSignOutAttemptRef.current;

    if (attempt !== null && authenticatedUserId !== attempt.logout.subjectId) {
      trainerSignOutAttemptRef.current = null;
      trainerSignOutBusyRef.current = false;
      setTrainerSignOutState('idle');
    }
  }, [authenticatedUserId]);

  useEffect(() => {
    if (authenticatedUserId === null || authenticatedRole !== 'client') {
      subscriptionControllerRef.current?.abort();
      subscriptionRequestVersionRef.current += 1;
      setSubscriptionState({ kind: 'idle' });
      return;
    }

    loadSubscription();
    return () => {
      subscriptionControllerRef.current?.abort();
      subscriptionRequestVersionRef.current += 1;
    };
  }, [authenticatedRole, authenticatedUserId, loadSubscription]);

  useEffect(() => {
    if (authenticatedUserId === null || authenticatedRole !== 'client') {
      return;
    }

    const refreshWhenVisible = (): void => {
      if (document.visibilityState === 'visible') {
        loadSubscription(false);
      }
    };

    document.addEventListener('visibilitychange', refreshWhenVisible);
    return () => document.removeEventListener('visibilitychange', refreshWhenVisible);
  }, [authenticatedRole, authenticatedUserId, loadSubscription]);

  useLayoutEffect(() => {
    if (
      subscriptionState.kind === 'ready' &&
      !isSubscriptionActive(subscriptionState.subscription)
    ) {
      clearWorkoutHistorySentinel();
    }
  }, [subscriptionState]);

  useEffect(() => {
    if (route !== appRoutes.settings) {
      setBlockingDialogOpen(false);
    }
  }, [route]);

  useEffect(() => {
    if (session.kind === 'unauthenticated') {
      if (route !== appRoutes.login) {
        navigate(appRoutes.login, true);
      }
      return;
    }

    if (session.kind !== 'authenticated') {
      return;
    }

    if (session.profile.account_role === 'trainer') {
      if (!isTrainerRoute(route)) {
        navigate(appRoutes.trainerChats, true);
      }
      return;
    }

    if (isTrainerRoute(route)) {
      navigate(routeForOnboardingStatus(session.profile.user.onboardingStatus), true);
      return;
    }

    if (isPaymentRoute(route)) {
      if (
        route === appRoutes.payment &&
        subscriptionState.kind === 'ready' &&
        isSubscriptionActive(subscriptionState.subscription)
      ) {
        navigate(routeForOnboardingStatus(session.profile.user.onboardingStatus), true);
      }
      return;
    }

    if (session.profile.user.onboardingStatus === 'active') {
      if (route === appRoutes.editSurvey && session.profile.survey === null) {
        navigate(appRoutes.settings, true);
        return;
      }

      if (route !== appRoutes.chat && !isActiveAppRoute(route)) {
        navigate(appRoutes.home, true);
      }
      return;
    }

    if (isSettingsRoute(route)) {
      if (route === appRoutes.editSurvey && session.profile.survey === null) {
        navigate(appRoutes.settings, true);
      }
      return;
    }

    const expectedRoute = routeForOnboardingStatus(session.profile.user.onboardingStatus);

    if (route !== expectedRoute) {
      navigate(expectedRoute, true);
    }
  }, [navigate, route, session, subscriptionState]);

  if (session.kind === 'booting') {
    return (
      <main className="app-shell" data-testid="session-loading">
        <div className="loading-state" role="status" aria-live="polite">
          <span aria-hidden="true" />
          Восстанавливаем защищённую сессию…
        </div>
      </main>
    );
  }

  if (session.kind === 'unauthenticated') {
    return (
      <LoginScreen
        onAuthenticated={(profile) => {
          setSession({ kind: 'authenticated', profile });
          navigate(
            profile.account_role === 'trainer'
              ? appRoutes.trainerChats
              : routeForOnboardingStatus(profile.user.onboardingStatus),
            true,
          );
        }}
      />
    );
  }

  if (session.kind === 'offline' || session.kind === 'server') {
    return (
      <SystemState
        kind={session.kind}
        message={session.message}
        onRetry={() => void restoreSession()}
      />
    );
  }

  const profile = session.profile;

  if (profile.account_role === 'trainer') {
    if (trainerSignOutState !== 'idle') {
      return <TrainerSignOutState state={trainerSignOutState} onRetry={handleTrainerSignOut} />;
    }

    if (!isTrainerRoute(route)) {
      return (
        <ChatRouteState
          kind="loading"
          message="Открываем рабочее пространство тренера…"
          backLabel="Выйти"
          onBack={handleTrainerSignOut}
        />
      );
    }

    if (chatRuntime.state.kind === 'idle' || chatRuntime.state.kind === 'loading') {
      return (
        <ChatRouteState
          kind="loading"
          message="Загружаем назначенные диалоги…"
          backLabel="Выйти"
          onBack={handleTrainerSignOut}
        />
      );
    }

    if (chatRuntime.state.kind === 'unavailable') {
      return (
        <ChatRouteState
          kind="unavailable"
          message={chatUnavailableMessage(chatRuntime.state.reason)}
          backLabel="Выйти"
          onBack={handleTrainerSignOut}
          onRetry={chatRuntime.refresh}
        />
      );
    }

    if (chatRuntime.state.kind === 'error' || chatRuntime.state.session.role !== 'trainer') {
      return (
        <ChatRouteState
          kind="error"
          message={
            chatRuntime.state.kind === 'error'
              ? chatRuntime.state.message
              : 'Сервер вернул неверную роль чата. Войдите снова.'
          }
          backLabel="Выйти"
          onBack={handleTrainerSignOut}
          onRetry={chatRuntime.refresh}
        />
      );
    }

    return (
      <TrainerChatsScreen
        accountId={profile.user.id}
        routeConversationId={trainerConversationIdFromRoute(route)}
        session={chatRuntime.state.session}
        api={chatRuntimeApi}
        realtime={chatRealtime}
        online={online}
        photoUploadsEnabled={chatRuntime.state.session.photo_uploads_enabled}
        onNavigateConversation={(conversationId) =>
          navigate(trainerConversationRoute(conversationId))
        }
        onBackToInbox={() => navigate(appRoutes.trainerChats)}
        onSessionExpired={handleActiveSessionExpired}
        registerObjectUrl={chatRuntime.registerObjectUrl}
        onSignOut={handleTrainerSignOut}
      />
    );
  }

  const defaultAuthenticatedRoute = routeForOnboardingStatus(profile.user.onboardingStatus);

  if (route === appRoutes.paymentSuccess) {
    return (
      <PaymentSuccessScreen
        onActivated={handleSubscriptionUpdated}
        onContinue={() => navigate(defaultAuthenticatedRoute, true)}
        onSessionExpired={handleActiveSessionExpired}
      />
    );
  }

  if (route === appRoutes.paymentCancel) {
    return (
      <PaymentCancelScreen
        onRetry={() => navigate(appRoutes.payment, true)}
        onLater={() => navigate(defaultAuthenticatedRoute, true)}
      />
    );
  }

  if (route === appRoutes.payment) {
    if (subscriptionState.kind === 'loading' || subscriptionState.kind === 'idle') {
      return <SubscriptionVerificationState loading onRetry={() => loadSubscription()} />;
    }

    if (subscriptionState.kind === 'error') {
      return (
        <SubscriptionVerificationState
          loading={false}
          message={subscriptionState.message}
          onRetry={() => loadSubscription()}
        />
      );
    }

    if (!isSubscriptionActive(subscriptionState.subscription)) {
      return (
        <PaymentScreen
          onBack={() => navigate(defaultAuthenticatedRoute)}
          onSessionExpired={handleActiveSessionExpired}
        />
      );
    }

    return <SubscriptionVerificationState loading onRetry={() => loadSubscription()} />;
  }

  const chatControlledUnavailable = chatRuntime.state.kind === 'unavailable';
  const chatFabHidden =
    blockingDialogOpen || !isChatFabRoute(route) || chatControlledUnavailable || !chatEnabled;

  const withActiveNavigation = (content: ReactNode): ReactNode =>
    profile.user.onboardingStatus === 'active' ? (
      <ActiveAppShell
        route={route}
        navigationDisabled={workoutCompletionBusy}
        chatFabHidden={chatFabHidden}
        chatUnreadCount={chatRuntime.unreadCount}
        onOpenChat={() => navigate(appRoutes.chat)}
        onNavigate={navigateActiveTab}
      >
        {content}
      </ActiveAppShell>
    ) : (
      content
    );

  if (route === appRoutes.editSurvey) {
    return withActiveNavigation(
      <SurveyWizard
        initialSurvey={profile.survey}
        onSaved={(updated) => {
          setSession({ kind: 'authenticated', profile: updated });
          navigate(appRoutes.settings, true);
        }}
        onCancel={() => navigate(appRoutes.settings)}
      />,
    );
  }

  if (route === appRoutes.settings) {
    return withActiveNavigation(
      <SettingsScreen
        hasSurvey={profile.survey !== null}
        chatAvailable={chatEnabled && !chatControlledUnavailable}
        onClose={() => navigate(routeForOnboardingStatus(profile.user.onboardingStatus))}
        onOpenChat={() => navigate(appRoutes.chat)}
        onEditSurvey={() => navigate(appRoutes.editSurvey)}
        onOpenPayment={() => navigate(appRoutes.payment)}
        onSubscriptionUpdated={handleSubscriptionUpdated}
        onSignedOut={finishSignedOut}
        onSessionExpired={handleActiveSessionExpired}
        onChatSessionSuspend={chatRuntime.suspendNow}
        onChatSessionRestart={chatRuntime.restartNow}
        onChatSessionEnd={chatRuntime.disposeNow}
        onBlockingDialogChange={setBlockingDialogOpen}
      />,
    );
  }

  if (profile.user.onboardingStatus === 'survey_pending') {
    return (
      <SurveyWizard
        initialSurvey={profile.survey}
        onSaved={(updated) => {
          setSession({ kind: 'authenticated', profile: updated });
          navigate(routeForOnboardingStatus(updated.user.onboardingStatus), true);
        }}
      />
    );
  }

  if (profile.user.onboardingStatus === 'onboarding_pending') {
    return (
      <OnboardingCarousel
        key={profile.user.id}
        userId={profile.user.id}
        onCompleted={(updated) => {
          setSession({ kind: 'authenticated', profile: updated });
          navigate(routeForOnboardingStatus(updated.user.onboardingStatus), true);
        }}
        onOpenSettings={() => navigate(appRoutes.settings)}
        onSessionExpired={() => {
          setSession({ kind: 'unauthenticated' });
          navigate(appRoutes.login, true);
        }}
      />
    );
  }

  if (profile.user.onboardingStatus === 'base_lessons') {
    return (
      <BaseLessonsScreen
        key={profile.user.id}
        onCompleted={(updated) => {
          setSession({ kind: 'authenticated', profile: updated });
          navigate(routeForOnboardingStatus(updated.user.onboardingStatus), true);
        }}
        onOpenSettings={() => navigate(appRoutes.settings)}
        onSessionExpired={() => {
          setSession({ kind: 'unauthenticated' });
          navigate(appRoutes.login, true);
        }}
      />
    );
  }

  if (route === appRoutes.chat) {
    const backToActiveApp = (): void => navigate(appRoutes.home);

    if (chatRuntime.state.kind === 'idle' || chatRuntime.state.kind === 'loading') {
      return (
        <ChatRouteState
          kind="loading"
          message="Загружаем диалог и проверяем защищённую сессию…"
          onBack={backToActiveApp}
        />
      );
    }

    if (chatRuntime.state.kind === 'unavailable') {
      return (
        <ChatRouteState
          kind="unavailable"
          message={chatUnavailableMessage(chatRuntime.state.reason)}
          showEmailFallback
          onBack={backToActiveApp}
          onRetry={chatRuntime.refresh}
        />
      );
    }

    if (chatRuntime.state.kind === 'error' || chatRuntime.state.session.role !== 'client') {
      return (
        <ChatRouteState
          kind="error"
          message={
            chatRuntime.state.kind === 'error'
              ? chatRuntime.state.message
              : 'Сервер вернул неверную роль чата. Войдите снова.'
          }
          onBack={backToActiveApp}
          onRetry={chatRuntime.refresh}
        />
      );
    }

    return (
      <ClientChatScreen
        accountId={profile.user.id}
        ownDisplayName={clientDisplayName(profile)}
        session={chatRuntime.state.session}
        api={chatRuntimeApi}
        realtime={chatRealtime}
        online={online}
        photoUploadsEnabled={chatRuntime.state.session.photo_uploads_enabled}
        supportEmail={supportEmail}
        onBack={backToActiveApp}
        onSessionExpired={handleActiveSessionExpired}
        onConversationStateChange={chatRuntime.updateClientConversationState}
        registerObjectUrl={chatRuntime.registerObjectUrl}
      />
    );
  }

  const activeContent =
    route === appRoutes.schedule ? (
      subscriptionState.kind === 'ready' ? (
        isSubscriptionActive(subscriptionState.subscription) ? (
          <ScheduleScreen
            onOpenHome={() => navigate(appRoutes.home)}
            onSessionExpired={handleActiveSessionExpired}
            onSubscriptionRequired={loadSubscription}
          />
        ) : (
          <SubscriptionLockedScreen
            subscription={subscriptionState.subscription}
            onOpenPayment={() => navigate(appRoutes.payment)}
          />
        )
      ) : (
        <SubscriptionVerificationState
          loading={subscriptionState.kind === 'loading' || subscriptionState.kind === 'idle'}
          {...(subscriptionState.kind === 'error' ? { message: subscriptionState.message } : {})}
          onRetry={() => loadSubscription()}
        />
      )
    ) : route === appRoutes.progress ? (
      <ProgressScreen
        timezone={profile.user.timezone}
        onGoalChanged={(goal) => {
          setSession((current) =>
            current.kind === 'authenticated' && current.profile.survey !== null
              ? {
                  kind: 'authenticated',
                  profile: {
                    ...current.profile,
                    survey: { ...current.profile.survey, goal },
                  },
                }
              : current,
          );
        }}
        onProfileUpdated={(updated) => setSession({ kind: 'authenticated', profile: updated })}
        onSessionExpired={handleActiveSessionExpired}
      />
    ) : subscriptionState.kind === 'ready' ? (
      isSubscriptionActive(subscriptionState.subscription) ? (
        <ProgramScreen
          timezone={profile.user.timezone}
          subscription={subscriptionState.subscription}
          onOpenPayment={() => navigate(appRoutes.payment)}
          onSubscriptionRequired={loadSubscription}
          onWorkoutCompletionBusyChange={setWorkoutCompletionBusy}
          onSessionExpired={handleActiveSessionExpired}
        />
      ) : (
        <SubscriptionLockedScreen
          subscription={subscriptionState.subscription}
          onOpenPayment={() => navigate(appRoutes.payment)}
        />
      )
    ) : (
      <SubscriptionVerificationState
        loading={subscriptionState.kind === 'loading' || subscriptionState.kind === 'idle'}
        {...(subscriptionState.kind === 'error' ? { message: subscriptionState.message } : {})}
        onRetry={() => loadSubscription()}
      />
    );

  return (
    <ActiveAppShell
      route={route}
      navigationDisabled={workoutCompletionBusy}
      chatFabHidden={chatFabHidden}
      chatUnreadCount={chatRuntime.unreadCount}
      onOpenChat={() => navigate(appRoutes.chat)}
      onNavigate={navigateActiveTab}
    >
      {activeContent}
    </ActiveAppShell>
  );
};
