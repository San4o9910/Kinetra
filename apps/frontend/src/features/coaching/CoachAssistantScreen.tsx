import React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { CoachMessage, CoachQuestionInput } from '@kinetra/shared';
import { ApiRequestError, askCoach, getCoachHistory } from '../../lib/api';
import { KineticMark } from '../navigation/KineticMark';

export const CoachAssistantScreen = ({
  onOpenTrainer,
  onSessionExpired,
}: {
  readonly onOpenTrainer: () => void;
  readonly onSessionExpired: () => void;
}): React.ReactNode => {
  const [messages, setMessages] = useState<readonly CoachMessage[]>([]);
  const [available, setAvailable] = useState(false);
  const [loading, setLoading] = useState(true);
  const [question, setQuestion] = useState('');
  const [useProgress, setUseProgress] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  const gate = useRef(false);
  const pending = useRef<CoachQuestionInput | null>(null);
  const explain = useCallback(
    (caught: unknown): string => {
      if (caught instanceof ApiRequestError) {
        if (caught.kind === 'auth') onSessionExpired();
        return caught.message;
      }
      return 'Не удалось получить ответ. Попробуйте ещё раз.';
    },
    [onSessionExpired],
  );
  const load = useCallback(async (): Promise<void> => {
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    setLoading(true);
    setError(null);
    try {
      const data = await getCoachHistory(current.signal);
      if (!current.signal.aborted) {
        setMessages(data.messages);
        setAvailable(data.available);
      }
    } catch (caught) {
      if (!current.signal.aborted) setError(explain(caught));
    } finally {
      if (!current.signal.aborted) setLoading(false);
    }
  }, [explain]);
  useEffect(() => {
    void load();
    return () => controller.current?.abort();
  }, [load]);
  const send = async (): Promise<void> => {
    if (gate.current || !available || !question.trim()) return;
    gate.current = true;
    setBusy(true);
    setError(null);
    const current = new AbortController();
    controller.current = current;
    const input =
      pending.current?.question === question.trim() && pending.current.use_progress === useProgress
        ? pending.current
        : { request_id: crypto.randomUUID(), question: question.trim(), use_progress: useProgress };
    pending.current = input;
    try {
      const result = await askCoach(input, current.signal);
      if (!current.signal.aborted) {
        setMessages((items) => [...items.filter((item) => item.id !== result.id), result]);
        setQuestion('');
        pending.current = null;
      }
    } catch (caught) {
      if (!current.signal.aborted) setError(explain(caught));
    } finally {
      gate.current = false;
      if (!current.signal.aborted) setBusy(false);
    }
  };
  return (
    <main className="coach-shell" aria-labelledby="coach-title">
      <header className="coach-heading">
        <KineticMark />
        <div>
          <p className="program-kicker">ПОМОЩЬ МЕЖДУ ЗАНЯТИЯМИ</p>
          <h1 id="coach-title">ИИ-помощник</h1>
          <p>Объяснит программу и поможет разобраться в своём прогрессе.</p>
        </div>
      </header>
      {loading ? (
        <p role="status">Открываем историю…</p>
      ) : (
        !available && (
          <section className="coach-unavailable">
            <h2>Помощник готовится к работе</h2>
            <p>Пока можно задать вопрос живому тренеру или посмотреть материалы программы.</p>
            <button className="primary-button" type="button" onClick={onOpenTrainer}>
              Написать тренеру
            </button>
            <button className="secondary-button" type="button" onClick={() => void load()}>
              Проверить доступность
            </button>
          </section>
        )
      )}
      <div className="coach-messages" aria-label="История общения с ИИ-помощником">
        {messages.map((message) => (
          <article key={message.id}>
            <div className="coach-question">
              <span>Вы</span>
              <p>{message.question}</p>
            </div>
            <div className="coach-answer">
              <strong>ИИ-помощник Kinetra</strong>
              <p>{message.answer}</p>
              <small>Ответ на основе доступных данных Kinetra</small>
            </div>
          </article>
        ))}
      </div>
      {available && (
        <>
          <div className="coach-prompts">
            {[
              'Что у меня по плану?',
              'Подведи итог моей недели',
              'Помоги составить вопрос тренеру',
            ].map((text) => (
              <button
                type="button"
                className="secondary-button"
                key={text}
                disabled={busy}
                onClick={() => setQuestion(text)}
              >
                {text}
              </button>
            ))}
          </div>
          <form
            className="coach-compose"
            onSubmit={(event) => {
              event.preventDefault();
              void send();
            }}
          >
            <label htmlFor="coach-question">Ваш вопрос</label>
            <textarea
              id="coach-question"
              value={question}
              disabled={busy}
              maxLength={2000}
              placeholder="Что хотите уточнить?"
              onChange={(event) => setQuestion(event.target.value)}
            />
            <label className="coach-consent">
              <input
                type="checkbox"
                checked={useProgress}
                disabled={busy}
                onChange={(event) => setUseProgress(event.target.checked)}
              />
              <span>
                Использовать мой прогресс и оценки самочувствия для ответа. Эти данные получит
                ИИ-сервис OpenAI.
              </span>
            </label>
            <div className="coach-compose-actions">
              <span>{question.length} / 2000</span>
              <button type="submit" className="primary-button" disabled={busy || !question.trim()}>
                {busy ? 'Готовим ответ…' : 'Отправить'}
              </button>
            </div>
            {busy && <p role="status">Помощник читает доступные материалы…</p>}
          </form>
        </>
      )}
      {error !== null && (
        <p role="alert" className="review-error">
          {error}
        </p>
      )}
      <p className="coach-footnote">Изменения программы и вопросы техники обсудите с тренером.</p>
    </main>
  );
};
