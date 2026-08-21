import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
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
import { SurveyWizard } from './features/survey/SurveyWizard';
import { ApiRequestError, bootstrapSession, fetchMe, getSubscription } from './lib/api';
import {
  appRoutes,
  isActiveAppRoute,
  isPaymentRoute,
  isSettingsRoute,
  normalizeAppRoute,
  routeForOnboardingStatus,
  type AppRoute,
} from './routing';

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
  readonly onNavigate: (route: AppRoute) => void;
  readonly children: ReactNode;
}

const ActiveAppShell = ({
  route,
  navigationDisabled,
  onNavigate,
  children,
}: ActiveAppShellProps): ReactNode => (
  <div className="active-app-shell">
    <div className="active-app-content">{children}</div>
    <TabBar route={route} disabled={navigationDisabled} onNavigate={onNavigate} />
  </div>
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
  const [subscriptionState, setSubscriptionState] = useState<SubscriptionLoadState>({
    kind: 'idle',
  });
  const subscriptionControllerRef = useRef<AbortController | null>(null);
  const subscriptionRequestVersionRef = useRef(0);

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

  useEffect(() => {
    if (authenticatedUserId === null) {
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
  }, [authenticatedUserId, loadSubscription]);

  useEffect(() => {
    if (authenticatedUserId === null) {
      return;
    }

    const refreshWhenVisible = (): void => {
      if (document.visibilityState === 'visible') {
        loadSubscription(false);
      }
    };

    document.addEventListener('visibilitychange', refreshWhenVisible);
    return () => document.removeEventListener('visibilitychange', refreshWhenVisible);
  }, [authenticatedUserId, loadSubscription]);

  useLayoutEffect(() => {
    if (
      subscriptionState.kind === 'ready' &&
      !isSubscriptionActive(subscriptionState.subscription)
    ) {
      clearWorkoutHistorySentinel();
    }
  }, [subscriptionState]);

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

      if (!isActiveAppRoute(route)) {
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
          navigate(routeForOnboardingStatus(profile.user.onboardingStatus), true);
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

  const withActiveNavigation = (content: ReactNode): ReactNode =>
    profile.user.onboardingStatus === 'active' ? (
      <ActiveAppShell
        route={route}
        navigationDisabled={workoutCompletionBusy}
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
        onClose={() => navigate(routeForOnboardingStatus(profile.user.onboardingStatus))}
        onEditSurvey={() => navigate(appRoutes.editSurvey)}
        onOpenPayment={() => navigate(appRoutes.payment)}
        onSubscriptionUpdated={handleSubscriptionUpdated}
        onSignedOut={() => {
          setSession({ kind: 'unauthenticated' });
          navigate(appRoutes.login, true);
        }}
        onSessionExpired={handleActiveSessionExpired}
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
      onNavigate={navigateActiveTab}
    >
      {activeContent}
    </ActiveAppShell>
  );
};
