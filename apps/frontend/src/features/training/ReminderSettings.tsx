import { useEffect, useState } from 'react';
import type { NotificationPreferences } from '@kinetra/shared';
import { getSettingsProfile, updateNotifications } from '../../lib/api';
import {
  subscribeToPush,
  getExistingPushSubscription,
  isPushSupported,
} from '../../pwa/pushNotifications';
import { trainingMessage } from './api';
export const ReminderSettings = ({ timezone }: { timezone: string }) => {
  const [value, setValue] = useState<NotificationPreferences | null>(null),
    [enabled, setEnabled] = useState(false),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(''),
    [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    void getSettingsProfile()
      .then((v) => {
        if (active) setValue(v.notification_preferences);
      })
      .catch((e) => {
        if (active) setError(trainingMessage(e));
      });
    void getExistingPushSubscription()
      .then((v) => {
        if (active) setEnabled(v !== null);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);
  return (
    <details className="training-card">
      <summary>Напоминания о тренировках</summary>
      <p className="training-muted">
        В день назначенного занятия · часовой пояс {timezone}. В дни отдыха напоминаний о занятиях
        не будет.
      </p>
      {value && (
        <form
          className="training-form"
          onSubmit={(e) => {
            e.preventDefault();
            setBusy(true);
            setError('');
            void updateNotifications(value)
              .then(() =>
                setMessage(
                  value.workout_reminders
                    ? 'Время напоминания сохранено.'
                    : 'Напоминания отключены.',
                ),
              )
              .catch((e) => setError(trainingMessage(e)))
              .finally(() => setBusy(false));
          }}
        >
          <label className="training-check">
            <input
              type="checkbox"
              checked={value.workout_reminders}
              onChange={(e) =>
                setValue((v) => (v ? { ...v, workout_reminders: e.target.checked } : v))
              }
            />
            Напоминать о занятиях
          </label>
          {value.workout_reminders && (
            <label>
              Время
              <input
                type="time"
                required
                step={1800}
                value={value.reminder_time}
                onChange={(e) => setValue((v) => (v ? { ...v, reminder_time: e.target.value } : v))}
              />
            </label>
          )}
          <div className="training-actions">
            <button type="submit" disabled={busy}>
              Сохранить настройки
            </button>
            {value.workout_reminders && !enabled && (
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  setError('');
                  if (!isPushSupported()) {
                    setError(
                      'На iPhone добавьте Kinetra на экран «Домой» и откройте приложение оттуда.',
                    );
                    setBusy(false);
                    return;
                  }
                  void subscribeToPush()
                    .then(() => {
                      setEnabled(true);
                      setMessage('Уведомления разрешены на этом устройстве.');
                    })
                    .catch((e) => setError(trainingMessage(e)))
                    .finally(() => setBusy(false));
                }}
              >
                Разрешить уведомления
              </button>
            )}
          </div>
          {value.workout_reminders && !enabled && (
            <p>
              Чтобы получать напоминания при закрытом приложении, разрешите уведомления на этом
              устройстве.
            </p>
          )}
        </form>
      )}
      {message && <p role="status">{message}</p>}
      {error && (
        <p role="alert" className="training-error">
          {error}
        </p>
      )}
    </details>
  );
};
