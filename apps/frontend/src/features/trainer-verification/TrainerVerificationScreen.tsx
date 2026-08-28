import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type {
  MeResponse,
  TrainerVerificationApplicationInput,
  TrainerVerificationMaterialKind,
  TrainerVerificationMeResponse,
  TrainerVerificationState,
} from '@kinetra/shared';

import {
  ApiRequestError,
  createTrainerVerification,
  fetchMe,
  getTrainerVerification,
  updateTrainerVerification,
  withdrawTrainerVerification,
} from '../../lib/api';

const materialKinds: readonly {
  readonly value: TrainerVerificationMaterialKind;
  readonly label: string;
}[] = [
  { value: 'professional_profile', label: 'Профессиональный профиль' },
  { value: 'certificate', label: 'Сертификат' },
  { value: 'diploma', label: 'Диплом' },
  { value: 'portfolio', label: 'Портфолио' },
  { value: 'other', label: 'Другой материал' },
];

const trainerVerificationStateLabel: Readonly<Record<TrainerVerificationState, string>> = {
  not_started: 'Подтвердите тренерские навыки',
  pending: 'Заявка на проверке',
  needs_more_info: 'Нужно дополнить заявку',
  approved: 'Профиль тренера подтверждён',
  rejected: 'Заявка отклонена',
  withdrawn: 'Заявка отозвана',
};

const isHttpsMaterialUrl = (value: string): boolean => {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
};

interface MaterialDraft {
  readonly localId: string;
  readonly kind: TrainerVerificationMaterialKind;
  readonly url: string;
  readonly title: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

interface ApplicationDraft {
  readonly displayName: string;
  readonly specialization: string;
  readonly experienceYears: string;
  readonly bio: string;
  readonly city: string;
  readonly timezone: string;
  readonly materials: readonly MaterialDraft[];
}

type VerificationLoadState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'ready'; readonly data: TrainerVerificationMeResponse };

interface TrainerVerificationScreenProps {
  readonly onProfileUpdated: (profile: MeResponse) => void;
  readonly onSessionExpired: () => void;
  readonly onSignOut: () => void;
}

const browserTimezone = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Moscow';
  } catch {
    return 'Europe/Moscow';
  }
};

const emptyMaterial = (localId: string): MaterialDraft => ({
  localId,
  kind: 'professional_profile',
  url: '',
  title: '',
  issuedAt: '',
  expiresAt: '',
});

const emptyDraft = (): ApplicationDraft => ({
  displayName: '',
  specialization: '',
  experienceYears: '',
  bio: '',
  city: '',
  timezone: browserTimezone(),
  materials: [emptyMaterial('material-1')],
});

const requestErrorMessage = (error: unknown, fallback: string): string =>
  error instanceof ApiRequestError ? error.message : fallback;

export const TrainerVerificationScreen = ({
  onProfileUpdated,
  onSessionExpired,
  onSignOut,
}: TrainerVerificationScreenProps): ReactNode => {
  const [loadState, setLoadState] = useState<VerificationLoadState>({ kind: 'loading' });
  const [draft, setDraft] = useState<ApplicationDraft>(emptyDraft);
  const [isSaving, setIsSaving] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [profileRefreshError, setProfileRefreshError] = useState<string | null>(null);
  const materialSequenceRef = useRef(1);
  const approvedProfileRefreshAttemptedRef = useRef(false);

  const handleApiError = useCallback(
    (error: unknown, fallback: string): string => {
      if (error instanceof ApiRequestError && error.kind === 'auth') {
        onSessionExpired();
      }

      return requestErrorMessage(error, fallback);
    },
    [onSessionExpired],
  );

  const refreshApprovedProfile = useCallback(async (): Promise<void> => {
    setProfileRefreshError(null);

    try {
      const profile = await fetchMe();

      if (profile.account_role !== 'trainer') {
        setProfileRefreshError(
          'Заявка одобрена, но права тренера пока не активны. Повторите обновление позже.',
        );
        return;
      }

      onProfileUpdated(profile);
    } catch (error) {
      setProfileRefreshError(
        handleApiError(error, 'Не удалось обновить профиль после проверки. Попробуйте ещё раз.'),
      );
    }
  }, [handleApiError, onProfileUpdated]);

  const applyResponse = useCallback(
    (data: TrainerVerificationMeResponse): void => {
      setLoadState({ kind: 'ready', data });
      const request = data.request;

      if (request !== null) {
        const materials = request.materials.map((material, index) => ({
          localId: material.id || `material-${index + 1}`,
          kind: material.kind,
          url: material.url,
          title: material.title,
          issuedAt: material.issued_at ?? '',
          expiresAt: material.expires_at ?? '',
        }));
        materialSequenceRef.current = Math.max(materialSequenceRef.current, materials.length);
        setDraft({
          displayName: request.display_name ?? '',
          specialization: request.specialization ?? '',
          experienceYears:
            request.experience_years === null ? '' : String(request.experience_years),
          bio: request.bio ?? '',
          city: request.city ?? '',
          timezone: request.timezone ?? browserTimezone(),
          materials:
            materials.length === 0
              ? [emptyMaterial(`material-${++materialSequenceRef.current}`)]
              : materials,
        });
      }

      if (
        data.trainer_verification_state === 'approved' &&
        !approvedProfileRefreshAttemptedRef.current
      ) {
        approvedProfileRefreshAttemptedRef.current = true;
        void refreshApprovedProfile();
      }
    },
    [refreshApprovedProfile],
  );

  const load = useCallback(
    async (signal?: AbortSignal): Promise<void> => {
      setLoadState({ kind: 'loading' });
      setActionError(null);

      try {
        applyResponse(await getTrainerVerification(signal));
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          return;
        }

        setLoadState({
          kind: 'error',
          message: handleApiError(error, 'Не удалось загрузить заявку. Попробуйте ещё раз.'),
        });
      }
    },
    [applyResponse, handleApiError],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const updateMaterial = (localId: string, patch: Partial<MaterialDraft>): void => {
    setDraft((current) => ({
      ...current,
      materials: current.materials.map((material) =>
        material.localId === localId ? { ...material, ...patch } : material,
      ),
    }));
  };

  const addMaterial = (): void => {
    materialSequenceRef.current += 1;
    setDraft((current) => ({
      ...current,
      materials: [...current.materials, emptyMaterial(`material-${materialSequenceRef.current}`)],
    }));
  };

  const removeMaterial = (localId: string): void => {
    setDraft((current) => ({
      ...current,
      materials:
        current.materials.length === 1
          ? current.materials
          : current.materials.filter((material) => material.localId !== localId),
    }));
  };

  const applicationFromDraft = (): TrainerVerificationApplicationInput | null => {
    const experienceYears = Number(draft.experienceYears);
    const valuesPresent =
      draft.displayName.trim().length > 0 &&
      draft.specialization.trim().length > 0 &&
      Number.isInteger(experienceYears) &&
      experienceYears >= 0 &&
      draft.bio.trim().length > 0 &&
      draft.city.trim().length > 0 &&
      draft.timezone.trim().length > 0 &&
      draft.materials.length > 0;
    const validMaterials = draft.materials.every(
      (material) => material.title.trim().length > 0 && isHttpsMaterialUrl(material.url.trim()),
    );

    if (!valuesPresent || !validMaterials) {
      return null;
    }

    return {
      display_name: draft.displayName.trim(),
      specialization: draft.specialization.trim(),
      experience_years: experienceYears,
      bio: draft.bio.trim(),
      city: draft.city.trim(),
      timezone: draft.timezone.trim(),
      materials: draft.materials.map((material) => ({
        kind: material.kind,
        url: material.url.trim(),
        title: material.title.trim(),
        ...(material.issuedAt === '' ? {} : { issued_at: material.issuedAt }),
        ...(material.expiresAt === '' ? {} : { expires_at: material.expiresAt }),
      })),
    };
  };

  const submitApplication = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();

    if (loadState.kind !== 'ready' || isSaving) {
      return;
    }

    const application = applicationFromDraft();

    if (application === null) {
      setActionError('Заполните все обязательные поля и укажите только HTTPS-ссылки.');
      return;
    }

    setIsSaving(true);
    setActionError(null);

    try {
      const shouldUpdate = loadState.data.trainer_verification_state === 'needs_more_info';
      applyResponse(
        shouldUpdate
          ? await updateTrainerVerification(application)
          : await createTrainerVerification(application),
      );
    } catch (error) {
      setActionError(handleApiError(error, 'Не удалось отправить заявку. Попробуйте ещё раз.'));
    } finally {
      setIsSaving(false);
    }
  };

  const withdraw = async (): Promise<void> => {
    if (isSaving) {
      return;
    }

    setIsSaving(true);
    setActionError(null);

    try {
      applyResponse(await withdrawTrainerVerification());
    } catch (error) {
      setActionError(handleApiError(error, 'Не удалось отозвать заявку. Попробуйте ещё раз.'));
    } finally {
      setIsSaving(false);
    }
  };

  if (loadState.kind === 'loading') {
    return (
      <main className="verification-shell" data-testid="trainer-verification-loading">
        <div className="loading-state" role="status" aria-live="polite">
          <span aria-hidden="true" />
          Загружаем статус проверки…
        </div>
        <button className="auth-link-button" type="button" onClick={onSignOut}>
          Выйти
        </button>
      </main>
    );
  }

  if (loadState.kind === 'error') {
    return (
      <main className="verification-shell" data-testid="trainer-verification-error">
        <section className="verification-card" aria-labelledby="verification-error-title">
          <p className="survey-kicker">ПРОВЕРКА ТРЕНЕРА</p>
          <h1 id="verification-error-title">Не удалось загрузить заявку</h1>
          <p role="alert">{loadState.message}</p>
          <button className="primary-button" type="button" onClick={() => void load()}>
            Повторить
          </button>
          <button className="auth-link-button" type="button" onClick={onSignOut}>
            Выйти
          </button>
        </section>
      </main>
    );
  }

  const { data } = loadState;
  const state = data.trainer_verification_state;
  const request = data.request;
  const formVisible =
    state === 'not_started' ||
    state === 'needs_more_info' ||
    state === 'rejected' ||
    state === 'withdrawn';

  return (
    <main className="verification-shell" data-testid={`trainer-verification-${state}`}>
      <section className="verification-card" aria-labelledby="verification-title">
        <div className="survey-brand">
          <span className="survey-brand-mark" aria-hidden="true">
            K
          </span>
          <span>KINETRA</span>
        </div>
        <div className="verification-heading">
          <p className="survey-kicker">ПРОВЕРКА ТРЕНЕРА</p>
          <h1 id="verification-title">{trainerVerificationStateLabel[state]}</h1>
          {state === 'pending' ? (
            <p>Модератор проверяет данные. До одобрения тренерские функции недоступны.</p>
          ) : null}
          {state === 'approved' ? (
            <p>Обновляем профиль и открываем рабочее пространство тренера.</p>
          ) : null}
          {state === 'withdrawn' ? <p>Можно создать новую заявку, когда будете готовы.</p> : null}
          {state === 'rejected' ? <p>Исправьте данные и отправьте новую заявку.</p> : null}
        </div>

        {request?.review_reason === null || request?.review_reason === undefined ? null : (
          <div className="verification-review-note" role="status">
            <strong>Комментарий модератора</strong>
            <p>{request.review_reason}</p>
          </div>
        )}

        {profileRefreshError === null ? null : (
          <div className="verification-alert" role="alert">
            <p>{profileRefreshError}</p>
            <button type="button" onClick={() => void refreshApprovedProfile()}>
              Повторить обновление профиля
            </button>
          </div>
        )}

        {formVisible ? (
          <form
            className="verification-form"
            data-testid="trainer-verification-form"
            onSubmit={(event) => void submitApplication(event)}
            noValidate
          >
            <div className="verification-fields">
              <label>
                <span>Имя для отображения</span>
                <input
                  type="text"
                  autoComplete="name"
                  value={draft.displayName}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, displayName: event.target.value }))
                  }
                  required
                />
              </label>
              <label>
                <span>Специализация</span>
                <input
                  type="text"
                  value={draft.specialization}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, specialization: event.target.value }))
                  }
                  required
                />
              </label>
              <label>
                <span>Опыт, лет</span>
                <input
                  type="number"
                  inputMode="numeric"
                  min="0"
                  max="80"
                  step="1"
                  value={draft.experienceYears}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, experienceYears: event.target.value }))
                  }
                  required
                />
              </label>
              <label>
                <span>Город</span>
                <input
                  type="text"
                  autoComplete="address-level2"
                  value={draft.city}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, city: event.target.value }))
                  }
                  required
                />
              </label>
              <label>
                <span>Часовой пояс</span>
                <input
                  type="text"
                  value={draft.timezone}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, timezone: event.target.value }))
                  }
                  required
                />
              </label>
            </div>

            <label>
              <span>Кратко о вашей практике</span>
              <textarea
                rows={5}
                value={draft.bio}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, bio: event.target.value }))
                }
                required
              />
            </label>

            <fieldset className="verification-materials">
              <legend>Ссылки и подтверждающие материалы</legend>
              <p>Добавьте минимум одну доступную по HTTPS ссылку. Файлы не загружаются.</p>
              {draft.materials.map((material, index) => (
                <div className="verification-material" key={material.localId}>
                  <div className="verification-material-heading">
                    <strong>Материал {index + 1}</strong>
                    {draft.materials.length === 1 ? null : (
                      <button type="button" onClick={() => removeMaterial(material.localId)}>
                        Удалить
                      </button>
                    )}
                  </div>
                  <label>
                    <span>Тип</span>
                    <select
                      value={material.kind}
                      onChange={(event) =>
                        updateMaterial(material.localId, {
                          kind: event.target.value as TrainerVerificationMaterialKind,
                        })
                      }
                    >
                      {materialKinds.map((kind) => (
                        <option value={kind.value} key={kind.value}>
                          {kind.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <span>Название</span>
                    <input
                      type="text"
                      value={material.title}
                      onChange={(event) =>
                        updateMaterial(material.localId, { title: event.target.value })
                      }
                      required
                    />
                  </label>
                  <label>
                    <span>HTTPS-ссылка</span>
                    <input
                      type="url"
                      inputMode="url"
                      placeholder="https://"
                      value={material.url}
                      onChange={(event) =>
                        updateMaterial(material.localId, { url: event.target.value })
                      }
                      required
                    />
                  </label>
                  <div className="verification-material-dates">
                    <label>
                      <span>Выдан</span>
                      <input
                        type="date"
                        value={material.issuedAt}
                        onChange={(event) =>
                          updateMaterial(material.localId, { issuedAt: event.target.value })
                        }
                      />
                    </label>
                    <label>
                      <span>Действует до</span>
                      <input
                        type="date"
                        value={material.expiresAt}
                        onChange={(event) =>
                          updateMaterial(material.localId, { expiresAt: event.target.value })
                        }
                      />
                    </label>
                  </div>
                </div>
              ))}
              <button className="secondary-button" type="button" onClick={addMaterial}>
                Добавить материал
              </button>
            </fieldset>

            {actionError === null ? null : (
              <p className="survey-error" role="alert">
                {actionError}
              </p>
            )}

            <button className="primary-button" type="submit" disabled={isSaving}>
              {isSaving
                ? 'Отправляем…'
                : state === 'needs_more_info'
                  ? 'Отправить дополнения'
                  : state === 'rejected' || state === 'withdrawn'
                    ? 'Отправить новую заявку'
                    : 'Отправить заявку'}
            </button>
            {state === 'needs_more_info' ? (
              <button
                className="secondary-button"
                type="button"
                disabled={isSaving}
                onClick={() => void withdraw()}
              >
                Отозвать заявку
              </button>
            ) : null}
          </form>
        ) : null}

        {state === 'pending' ? (
          <div className="verification-actions">
            {actionError === null ? null : (
              <p className="survey-error" role="alert">
                {actionError}
              </p>
            )}
            <button
              className="primary-button"
              type="button"
              disabled={isSaving}
              onClick={() => void load()}
            >
              Проверить статус
            </button>
            <button type="button" disabled={isSaving} onClick={() => void withdraw()}>
              {isSaving ? 'Отзываем…' : 'Отозвать заявку'}
            </button>
          </div>
        ) : null}

        <button className="auth-link-button" type="button" disabled={isSaving} onClick={onSignOut}>
          Выйти
        </button>
      </section>
    </main>
  );
};
