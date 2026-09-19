import { useEffect, useRef, useState } from 'react';
import type {
  FoodPortion,
  MealContents,
  MealSlot,
  NutritionEntry,
  NutritionEntryInput,
  NutritionTemplate,
} from '@kinetra/shared';
import { apiBaseUrl } from '../../lib/api';
import { trainingApi, trainingMessage } from './api';
const slots: Record<MealSlot, string> = {
  breakfast: 'Завтрак',
  lunch: 'Обед',
  dinner: 'Ужин',
  snack: 'Перекус',
};
const units = { g: 'г', ml: 'мл', piece: 'шт.' } as const;
const localDate = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const portionText = (p: FoodPortion) =>
  `${p.name} · ${p.quantity.toLocaleString('ru-RU')} ${units[p.unit]}`;
const blank = (date: string): NutritionEntryInput => ({
  recorded_date: date,
  slot: 'lunch',
  title: '',
  items: [{ name: '', quantity: 150, unit: 'g' }],
  note: '',
  share_with_trainer: false,
  revision: 0,
});
const contents = (e: MealContents): MealContents => ({
  slot: e.slot,
  title: e.title,
  items: e.items.map((p) => ({ ...p })),
});
export const NutritionDiary = ({ studentId }: { studentId?: string }) => {
  const [date, setDate] = useState(localDate),
    [entries, setEntries] = useState<NutritionEntry[]>([]),
    [templates, setTemplates] = useState<NutritionTemplate[]>([]),
    [revision, setRevision] = useState(0),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false),
    [open, setOpen] = useState(false),
    [form, setForm] = useState(() => blank(date)),
    [entryId, setEntryId] = useState<string>(() => crypto.randomUUID()),
    [file, setFile] = useState<File | null>(null),
    [photos, setPhotos] = useState<Record<string, string>>({}),
    [templateName, setTemplateName] = useState(''),
    [dayName, setDayName] = useState('');
  const templateRequest = useRef<{ id: string; date: string; request: string } | null>(null);
  const uploadInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const c = new AbortController();
    setLoading(true);
    setError('');
    setPhotos({});
    void trainingApi
      .nutrition(date, studentId, c.signal)
      .then((v) => {
        if (!c.signal.aborted) setEntries(v.entries);
      })
      .catch((e) => {
        if (!c.signal.aborted) setError(trainingMessage(e));
      })
      .finally(() => {
        if (!c.signal.aborted) setLoading(false);
      });
    if (!studentId)
      void trainingApi
        .foodTemplates()
        .then((v) => {
          if (!c.signal.aborted) setTemplates(v.templates);
        })
        .catch((e) => {
          if (!c.signal.aborted) setError(trainingMessage(e));
        });
    return () => c.abort();
  }, [date, studentId, revision]);
  const run = async (fn: () => Promise<void>, reload = true) => {
    if (busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await fn();
      if (reload) setRevision((v) => v + 1);
    } catch (e) {
      setError(trainingMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const start = (value?: NutritionEntry) => {
    setForm(value ? { ...value, items: value.items.map((p) => ({ ...p })) } : blank(date));
    setEntryId(value?.id ?? crypto.randomUUID());
    setFile(null);
    setTemplateName('');
    setOpen(true);
  };
  const changeFood = (index: number, patch: Partial<FoodPortion>) =>
    setForm((v) => ({
      ...v,
      items: v.items.map((p, i) => (i === index ? { ...p, ...patch } : p)),
    }));
  const saveTemplate = async (
    kind: NutritionTemplate['kind'],
    name: string,
    meals: MealContents[],
  ) => {
    await trainingApi.saveFoodTemplate(crypto.randomUUID(), { kind, name, meals });
    setNotice(kind === 'day' ? 'Рацион сохранён в шаблонах.' : 'Шаблон сохранён.');
  };
  const validFood = form.items.every((p) => p.name.trim() && p.quantity > 0 && p.quantity <= 10000);
  const chooseFile = (f: File | null) => {
    if (
      f &&
      (!['image/jpeg', 'image/png', 'image/webp'].includes(f.type) || f.size > 10 * 1024 ** 2)
    ) {
      setFile(null);
      if (uploadInput.current) uploadInput.current.value = '';
      setError('Выберите фото JPEG, PNG или WebP до 10 МБ.');
      return;
    }
    setFile(f);
  };
  return (
    <section className="training-workspace nutrition-diary" data-testid="nutrition-diary">
      <div className="training-heading">
        <div>
          <p className="survey-kicker">ПИТАНИЕ</p>
          <h1>{studentId ? 'Дневник ученика' : 'Мой дневник питания'}</h1>
          <p>
            {studentId
              ? 'Только записи, которыми ученик поделился с вами.'
              : 'Обычные продукты и порции. Сохраните один раз — используйте снова.'}
          </p>
        </div>
        {!studentId && (
          <button type="button" className="primary-button" disabled={busy} onClick={() => start()}>
            + Приём пищи
          </button>
        )}
      </div>
      <div className="nutrition-date">
        <label>
          День
          <input
            type="date"
            value={date}
            disabled={busy || open}
            onChange={(e) => {
              if (e.target.value) setDate(e.target.value);
            }}
          />
        </label>
        <span className="training-muted">{entries.length} записей за день</span>
      </div>
      {error && (
        <p className="training-error" role="alert">
          {error}{' '}
          <button type="button" disabled={busy} onClick={() => setRevision((v) => v + 1)}>
            Обновить
          </button>
        </p>
      )}
      {notice && (
        <p className="nutrition-notice" role="status">
          {notice}
        </p>
      )}
      {open && !studentId && (
        <form
          className="training-card training-form nutrition-editor"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              const {
                recorded_date,
                slot,
                title,
                items,
                note,
                share_with_trainer,
                revision: version,
              } = form;
              const saved = await trainingApi.saveMeal(entryId, {
                recorded_date,
                slot,
                title,
                items,
                note,
                share_with_trainer,
                revision: version,
              });
              setForm((v) => ({ ...v, revision: saved.revision }));
              if (file) {
                try {
                  await trainingApi.uploadMealPhoto(saved.id, file);
                  setFile(null);
                } catch (e) {
                  setRevision((v) => v + 1);
                  throw new Error(
                    `Запись сохранена. Фото не загрузилось: ${trainingMessage(e)} Можно выбрать другое фото и сохранить ещё раз.`,
                  );
                }
              }
              setOpen(false);
              setNotice('Приём пищи сохранён.');
            });
          }}
        >
          <fieldset disabled={busy}>
            <legend>{form.revision ? 'Редактирование записи' : 'Новый приём пищи'}</legend>
            <div className="training-fields">
              <label>
                Приём пищи
                <select
                  value={form.slot}
                  onChange={(e) => setForm((v) => ({ ...v, slot: e.target.value as MealSlot }))}
                >
                  {Object.entries(slots).map(([key, label]) => (
                    <option value={key} key={key}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Название · необязательно
                <input
                  value={form.title}
                  maxLength={120}
                  placeholder="Например, обед после тренировки"
                  onChange={(e) => setForm((v) => ({ ...v, title: e.target.value }))}
                />
              </label>
            </div>
            <div className="nutrition-foods">
              {form.items.map((p, index) => (
                <div className="nutrition-food-row" key={index}>
                  <label>
                    Продукт {index + 1}
                    <input
                      required
                      value={p.name}
                      maxLength={120}
                      placeholder={index ? 'Варёная индейка' : 'Рис варёный'}
                      onChange={(e) => changeFood(index, { name: e.target.value })}
                    />
                  </label>
                  <label>
                    Количество
                    <input
                      required
                      type="number"
                      min="0.1"
                      max="10000"
                      step="any"
                      value={p.quantity || ''}
                      onChange={(e) => changeFood(index, { quantity: Number(e.target.value) })}
                    />
                  </label>
                  <label>
                    Единица
                    <select
                      value={p.unit}
                      onChange={(e) =>
                        changeFood(index, { unit: e.target.value as FoodPortion['unit'] })
                      }
                    >
                      <option value="g">граммы</option>
                      <option value="ml">мл</option>
                      <option value="piece">штуки</option>
                    </select>
                  </label>
                  <div className="nutrition-row-actions">
                    <button
                      type="button"
                      aria-label={`Удалить продукт ${index + 1}`}
                      disabled={form.items.length === 1}
                      onClick={() =>
                        setForm((v) => ({ ...v, items: v.items.filter((_, i) => i !== index) }))
                      }
                    >
                      Удалить
                    </button>
                    <button
                      type="button"
                      disabled={!p.name.trim() || !(p.quantity > 0)}
                      onClick={() =>
                        void run(() =>
                          saveTemplate('portion', portionText(p).slice(0, 120), [
                            { slot: form.slot, title: '', items: [p] },
                          ]),
                        )
                      }
                    >
                      Сохранить порцию
                    </button>
                  </div>
                </div>
              ))}
            </div>
            <button
              type="button"
              disabled={form.items.length >= 40}
              onClick={() =>
                setForm((v) => ({
                  ...v,
                  items: [...v.items, { name: '', quantity: 100, unit: 'g' }],
                }))
              }
            >
              ＋ Продукт
            </button>
            <p className="training-muted">
              Например: рис 150 г, варёная индейка 200 г, банан 1 шт., творог 100 г. Указывайте,
              взвешивали продукт до или после приготовления.
            </p>
            <label>
              Комментарий
              <textarea
                maxLength={1000}
                value={form.note}
                onChange={(e) => setForm((v) => ({ ...v, note: e.target.value }))}
              />
            </label>
            {!entries.find((e) => e.id === entryId)?.photo_id && (
              <label>
                Фото · необязательно
                <input
                  ref={uploadInput}
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  onChange={(e) => chooseFile(e.target.files?.[0] ?? null)}
                />
              </label>
            )}
            {file && (
              <button
                type="button"
                onClick={() => {
                  setFile(null);
                  if (uploadInput.current) uploadInput.current.value = '';
                }}
              >
                Убрать выбранное фото
              </button>
            )}
            <label className="training-check">
              <input
                type="checkbox"
                checked={form.share_with_trainer}
                onChange={(e) => setForm((v) => ({ ...v, share_with_trainer: e.target.checked }))}
              />
              Показывать эту запись и фото моему тренеру
            </label>
            <p className="training-muted">
              Без отметки запись видна только вам. Доступ можно закрыть в любой момент.
            </p>
            <div className="nutrition-template-save">
              <label>
                Название шаблона
                <input
                  value={templateName}
                  maxLength={120}
                  placeholder="Мой обычный обед"
                  onChange={(e) => setTemplateName(e.target.value)}
                />
              </label>
              <button
                type="button"
                disabled={!templateName.trim() || !validFood}
                onClick={() => void run(() => saveTemplate('meal', templateName, [contents(form)]))}
              >
                Сохранить приём пищи как шаблон
              </button>
            </div>
            <div className="training-actions">
              <button className="primary-button" disabled={!validFood}>
                {busy ? 'Сохраняем…' : 'Сохранить запись'}
              </button>
              <button type="button" onClick={() => setOpen(false)}>
                Отмена
              </button>
            </div>
          </fieldset>
        </form>
      )}
      {!studentId && (
        <details className="training-card nutrition-templates">
          <summary>
            Мои порции и рационы <span>{templates.length}</span>
          </summary>
          <p className="training-muted">
            Порция добавляется к продуктам, приём пищи открывается для редактирования. Рацион
            добавляет записи в выбранный день без фотографий.
          </p>
          {!templates.length && (
            <p>Создайте первую запись и сохраните её состав — шаблоны появятся здесь.</p>
          )}
          <div className="nutrition-template-grid">
            {templates.map((t) => (
              <article key={t.id}>
                <span className="training-badge">
                  {t.kind === 'portion'
                    ? 'Порция'
                    : t.kind === 'meal'
                      ? 'Приём пищи'
                      : 'Рацион на день'}
                </span>
                <h3>{t.name}</h3>
                <p>{t.meals.map((m) => m.items.map(portionText).join(', ')).join(' / ')}</p>
                <div className="training-actions">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      if (t.kind === 'day') {
                        if (
                          !templateRequest.current ||
                          templateRequest.current.id !== t.id ||
                          templateRequest.current.date !== date
                        )
                          templateRequest.current = {
                            id: t.id,
                            date,
                            request: crypto.randomUUID(),
                          };
                        const req = templateRequest.current;
                        void run(async () => {
                          await trainingApi.applyFoodTemplate(t.id, req.request, date, false);
                          templateRequest.current = null;
                          setNotice(
                            `Рацион добавлен: ${t.meals.length} приёмов пищи. Записи пока видны только вам.`,
                          );
                        });
                        return;
                      }
                      if (
                        t.kind === 'meal' &&
                        open &&
                        !window.confirm('Заменить состав открытой записи этим шаблоном?')
                      )
                        return;
                      if (t.kind === 'portion') {
                        setForm((v) => ({
                          ...(!open ? blank(date) : v),
                          items: [
                            ...(open ? v.items.filter((p) => p.name.trim()) : []),
                            ...t.meals[0]!.items.map((p) => ({ ...p })),
                          ].slice(0, 40),
                        }));
                        if (!open) {
                          setEntryId(crypto.randomUUID());
                          setFile(null);
                        }
                      } else {
                        setForm({ ...blank(date), ...contents(t.meals[0]!) });
                        setEntryId(crypto.randomUUID());
                        setFile(null);
                      }
                      setOpen(true);
                      window.scrollTo({ top: 0, behavior: 'smooth' });
                    }}
                  >
                    {t.kind === 'day'
                      ? `Добавить в день ${date.split('-').reverse().join('.')}`
                      : 'Использовать'}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      if (
                        window.confirm(`Удалить шаблон «${t.name}»? Сохранённые записи останутся.`)
                      )
                        void run(async () => {
                          await trainingApi.removeFoodTemplate(t.id);
                        });
                    }}
                  >
                    Удалить
                  </button>
                </div>
              </article>
            ))}
          </div>
        </details>
      )}
      {loading ? (
        <p role="status">Загружаем дневник…</p>
      ) : !entries.length ? (
        <div className="training-card training-empty">
          <h2>{studentId ? 'Нет доступных записей' : 'Что было на вашем столе?'}</h2>
          <p>
            {studentId
              ? 'Ученик ещё не поделился приёмами пищи за этот день.'
              : 'Добавьте продукты и количество. Можно начать с одного банана или чашки напитка.'}
          </p>
        </div>
      ) : (
        <div className="nutrition-entries">
          {entries.map((e) => (
            <article className="training-card nutrition-entry" key={e.id}>
              <div className="training-heading">
                <div>
                  <span className="survey-kicker">{slots[e.slot]}</span>
                  <h2>{e.title || slots[e.slot]}</h2>
                </div>
                <span className="training-badge">
                  {e.share_with_trainer ? 'Доступно тренеру' : 'Только вам'}
                </span>
              </div>
              <ul className="nutrition-portions">
                {e.items.map((p, i) => (
                  <li key={i}>
                    <span>{p.name}</span>
                    <strong>
                      {p.quantity.toLocaleString('ru-RU')} {units[p.unit]}
                    </strong>
                  </li>
                ))}
              </ul>
              {e.note && <p>{e.note}</p>}
              {e.photo_id && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      if (photos[e.id]) {
                        setPhotos((v) => ({ ...v, [e.id]: '' }));
                        return;
                      }
                      const v = await trainingApi.mealPhoto(e.id);
                      setPhotos((old) => ({ ...old, [e.id]: v.path }));
                    }, false)
                  }
                >
                  {photos[e.id] ? 'Скрыть фото' : 'Посмотреть фото'}
                </button>
              )}
              {photos[e.id] && (
                <img
                  className="training-progress-photo"
                  src={apiBaseUrl + photos[e.id]}
                  alt={`Фото: ${e.title || slots[e.slot]}`}
                  referrerPolicy="no-referrer"
                  onError={() => {
                    setPhotos((v) => ({ ...v, [e.id]: '' }));
                    setError(
                      'Фото не загрузилось или доступ истёк. Нажмите «Посмотреть фото» ещё раз.',
                    );
                  }}
                />
              )}
              {!studentId && (
                <div className="training-actions">
                  {e.photo_id && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        if (window.confirm('Удалить только фотографию? Запись о еде останется.'))
                          void run(async () => {
                            await trainingApi.removeMealPhoto(e.id);
                          });
                      }}
                    >
                      Удалить фото
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      start(e);
                      window.scrollTo({ top: 0, behavior: 'smooth' });
                    }}
                  >
                    Изменить
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        await trainingApi.shareMeal(e.id, !e.share_with_trainer);
                      })
                    }
                  >
                    {e.share_with_trainer ? 'Закрыть доступ тренеру' : 'Поделиться с тренером'}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      if (window.confirm('Удалить приём пищи и его фото?'))
                        void run(async () => {
                          await trainingApi.removeMeal(e.id);
                        });
                    }}
                  >
                    Удалить
                  </button>
                </div>
              )}
            </article>
          ))}
        </div>
      )}
      {!studentId && entries.length > 0 && (
        <section className="training-card nutrition-day-save">
          <h2>Повторять такой рацион</h2>
          <p>
            Сохраните все приёмы пищи этого дня. Продукты и порции можно менять после добавления.
          </p>
          <label>
            Название рациона
            <input
              value={dayName}
              maxLength={120}
              placeholder="День с тренировкой"
              onChange={(e) => setDayName(e.target.value)}
            />
          </label>
          <button
            type="button"
            disabled={busy || !dayName.trim() || entries.length > 12}
            onClick={() => void run(() => saveTemplate('day', dayName, entries.map(contents)))}
          >
            Сохранить рацион на день
          </button>
          {entries.length > 12 && <p>В шаблон рациона можно включить до 12 приёмов пищи.</p>}
        </section>
      )}
    </section>
  );
};
