ALTER TABLE weekly_metrics
  DROP CONSTRAINT IF EXISTS weekly_metrics_note_length_valid;

ALTER TABLE weekly_metrics
  ADD CONSTRAINT weekly_metrics_note_length_valid CHECK (
    note IS NULL OR char_length(note) <= 500
  ) NOT VALID;

UPDATE weekly_metrics
SET note = left(note, 500)
WHERE char_length(note) > 500;

ALTER TABLE weekly_metrics
  VALIDATE CONSTRAINT weekly_metrics_note_length_valid;

UPDATE achievements AS achievement
SET
  title = canonical.title,
  description = canonical.description,
  icon_key = canonical.icon_key,
  rule_type = canonical.rule_type,
  rule_value = canonical.rule_value
FROM (
  VALUES
    (
      'first_base_lesson',
      'Первый шаг',
      'Просмотрен первый базовый урок',
      '🎯',
      'base_lessons_viewed',
      1
    ),
    (
      'base_unlocked',
      'База пройдена',
      '4 базовых урока завершены',
      '🔓',
      'base_lessons_viewed',
      4
    ),
    (
      'first_workout',
      'Первая тренировка',
      'Первая тренировка из программы',
      '💪',
      'workouts_completed',
      1
    ),
    (
      'week_complete',
      'Неделя завершена',
      'Все 7 дней за неделю',
      '🏆',
      'week_days_completed',
      7
    ),
    (
      'streak_3',
      'Три подряд',
      '3 тренировки подряд',
      '🔥',
      'workout_streak',
      3
    )
) AS canonical(code, title, description, icon_key, rule_type, rule_value)
WHERE achievement.code = canonical.code;
