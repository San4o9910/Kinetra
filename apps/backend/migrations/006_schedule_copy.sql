WITH canonical_schedule(day_of_week, title, description) AS (
  VALUES
    (1, 'Дыхательная практика', 'Настройка нервной системы, учимся дышать животом.'),
    (2, 'Силовая тренировка', 'Приседания, тяги, жимы. 3 круга.'),
    (3, 'Тело мой дом', 'Снимаем зажимы, работаем с телом.'),
    (4, 'Функциональная тренировка', 'Динамика, координация, баланс.'),
    (5, 'Растяжка', 'Восстанавливаем длину мышц.'),
    (6, 'Нейрогимнастика', 'Упражнения для мозга и координации.'),
    (7, 'Восстановление', 'Самомассаж и полезное блюдо.')
)
UPDATE program_days AS program_day
SET
  title = canonical_schedule.title,
  description = canonical_schedule.description
FROM canonical_schedule
WHERE program_day.day_of_week = canonical_schedule.day_of_week;

WITH canonical_schedule(day_of_week, title, description) AS (
  VALUES
    (1, 'Дыхательная практика', 'Настройка нервной системы, учимся дышать животом.'),
    (2, 'Силовая тренировка', 'Приседания, тяги, жимы. 3 круга.'),
    (3, 'Тело мой дом', 'Снимаем зажимы, работаем с телом.'),
    (4, 'Функциональная тренировка', 'Динамика, координация, баланс.'),
    (5, 'Растяжка', 'Восстанавливаем длину мышц.'),
    (6, 'Нейрогимнастика', 'Упражнения для мозга и координации.'),
    (7, 'Восстановление', 'Самомассаж и полезное блюдо.')
)
UPDATE videos AS video
SET
  title = canonical_schedule.title,
  description = canonical_schedule.description
FROM canonical_schedule
WHERE video.type = 'workout'
  AND video.day_of_week = canonical_schedule.day_of_week;
