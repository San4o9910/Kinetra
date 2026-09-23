import React, { useEffect, useState } from 'react';
import type { MyTraining as MyTrainingData } from '@kinetra/shared';
import { trainingApi, trainingMessage, pendingInvite, clearInvite } from './api';
import { PersonalTraining } from './PersonalTraining';

export const MyTraining = ({
  mode = 'home',
  accountId = '',
  timezone = 'Europe/Moscow',
  fallback,
  onOpenChat,
}: {
  mode?: 'home' | 'schedule' | 'progress';
  accountId?: string;
  timezone?: string;
  fallback?: React.ReactNode;
  onOpenChat: () => void;
}): React.ReactNode => {
  const [data, setData] = useState<MyTrainingData | null>(null);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState('');
  const [token, setToken] = useState(pendingInvite);
  const [trainer, setTrainer] = useState('');
  const [busy, setBusy] = useState(false);
  const [inviteError, setInviteError] = useState('');
  useEffect(() => {
    const c = new AbortController();
    void trainingApi
      .mine(c.signal)
      .then((v) => {
        if (!c.signal.aborted) {
          setData(v);
          setError('');
        }
      })
      .catch((e) => {
        if (!c.signal.aborted) setError(trainingMessage(e));
      });
    return () => c.abort();
  }, [revision]);
  useEffect(() => {
    if (token.length !== 43) {
      setTrainer('');
      return;
    }
    let active = true;
    void trainingApi
      .invitation(token)
      .then((v) => {
        if (active) {
          setTrainer(v.trainer_name);
          setInviteError('');
        }
      })
      .catch((e) => {
        if (active) {
          setTrainer('');
          setInviteError(trainingMessage(e));
        }
      });
    return () => {
      active = false;
    };
  }, [token]);
  const invitation = (
    <section className="training-card training-invite">
      <h2>{trainer ? `Приглашение от тренера ${trainer}` : 'Подключитесь к своему тренеру'}</h2>
      <p>
        Тренер добавляет вас в свой кабинет и отправляет ссылку. После подключения здесь появится
        составленная им программа.
      </p>
      <label>
        Ссылка или код приглашения
        <input
          value={token}
          onChange={(e) => {
            let value = e.target.value.trim();
            try {
              const url = new URL(value);
              value = new URLSearchParams(url.hash.slice(1)).get('invite') ?? value;
            } catch {
              /* A bare token is also supported. */
            }
            setToken(value);
          }}
          placeholder="Вставьте ссылку от тренера"
        />
      </label>
      {trainer && (
        <>
          <p>Тренер увидит выполнение ваших занятий и отметки самочувствия.</p>
          <button
            type="button"
            className="primary-button"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              setInviteError('');
              void trainingApi
                .accept(token)
                .then(() => {
                  clearInvite();
                  setToken('');
                  setTrainer('');
                  setRevision((v) => v + 1);
                })
                .catch((e) => setInviteError(trainingMessage(e)))
                .finally(() => setBusy(false));
            }}
          >
            {busy ? 'Подключаем…' : 'Подключиться к тренеру'}
          </button>
        </>
      )}
      {inviteError && <p role="alert">{inviteError}</p>}
      {token && (
        <button
          type="button"
          onClick={() => {
            clearInvite();
            setToken('');
            setInviteError('');
          }}
        >
          Закрыть приглашение
        </button>
      )}
    </section>
  );
  if (error)
    return (
      <section className="training-card">
        <p role="alert">{error}</p>
        <button
          type="button"
          onClick={() => {
            setError('');
            setRevision((v) => v + 1);
          }}
        >
          Повторить
        </button>
      </section>
    );
  if (!data)
    return (
      <p className="training-empty" role="status">
        Загружаем вашу программу…
      </p>
    );
  if (!data.student_id)
    return (
      <>
        {invitation}
        {fallback && (
          <>
            <p className="training-course-label">
              Вводный курс Kinetra · программа тренера появится после подключения
            </p>
            {fallback}
          </>
        )}
      </>
    );
  return (
    <>
      {token && invitation}
      <PersonalTraining
        data={data}
        mode={mode}
        accountId={accountId}
        timezone={timezone}
        onChat={onOpenChat}
        onSaved={() => setRevision((v) => v + 1)}
      />
    </>
  );
};
