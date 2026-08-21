import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { config as loadEnv } from 'dotenv';
import pg from 'pg';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const backendRoot = resolve(scriptDirectory, '..');
const repositoryRoot = resolve(backendRoot, '../..');

loadEnv({ path: resolve(repositoryRoot, '.env'), quiet: true });

const databaseUrl =
  process.env.DATABASE_URL ?? 'postgresql://kinetra:kinetra_local_only@localhost:5432/kinetra';

const daySchedule = [
  {
    dayOfWeek: 1,
    weekday: 'Понедельник',
    direction: 'breathing',
    title: 'Дыхательная практика',
    description: 'Настройка нервной системы, учимся дышать животом.',
    durationMinutes: 25,
    icon: 'wind',
  },
  {
    dayOfWeek: 2,
    weekday: 'Вторник',
    direction: 'strength',
    title: 'Силовая тренировка',
    description: 'Приседания, тяги, жимы. 3 круга.',
    durationMinutes: 35,
    icon: 'dumbbell',
  },
  {
    dayOfWeek: 3,
    weekday: 'Среда',
    direction: 'body_therapy',
    title: 'Тело мой дом',
    description: 'Снимаем зажимы, работаем с телом.',
    durationMinutes: 30,
    icon: 'heart-pulse',
  },
  {
    dayOfWeek: 4,
    weekday: 'Четверг',
    direction: 'functional',
    title: 'Функциональная тренировка',
    description: 'Динамика, координация, баланс.',
    durationMinutes: 35,
    icon: 'activity',
  },
  {
    dayOfWeek: 5,
    weekday: 'Пятница',
    direction: 'stretching',
    title: 'Растяжка',
    description: 'Восстанавливаем длину мышц.',
    durationMinutes: 30,
    icon: 'move',
  },
  {
    dayOfWeek: 6,
    weekday: 'Суббота',
    direction: 'neuro',
    title: 'Нейрогимнастика',
    description: 'Упражнения для мозга и координации.',
    durationMinutes: 15,
    icon: 'brain',
  },
  {
    dayOfWeek: 7,
    weekday: 'Воскресенье',
    direction: 'recovery',
    title: 'Восстановление',
    description: 'Самомассаж и полезное блюдо.',
    durationMinutes: 20,
    icon: 'moon',
  },
];

const baseLessons = [
  {
    slug: 'base-lesson-01-breathing-check',
    title: 'Как понять правильно ли я дышу?',
    description: 'Базовый урок о дыхании и самопроверке.',
    durationSeconds: 600,
  },
  {
    slug: 'base-lesson-02-push-ups',
    title: 'Как правильно отжиматься?',
    description: 'Базовая техника безопасных отжиманий.',
    durationSeconds: 600,
  },
  {
    slug: 'base-lesson-03-pull-ups',
    title: 'Как научиться подтягиваться?',
    description: 'Пошаговая подготовка к первому подтягиванию.',
    durationSeconds: 600,
  },
  {
    slug: 'base-lesson-04-squats',
    title: 'Как приседать?',
    description: 'Основы техники приседаний.',
    durationSeconds: 600,
  },
  {
    slug: 'base-lesson-05-deadlift',
    title: 'Как и зачем делать становую тягу?',
    description: 'Назначение и базовая техника становой тяги.',
    durationSeconds: 600,
  },
  {
    slug: 'base-lesson-06-daily-training',
    title: 'Я не хочу заниматься каждый день!',
    description: 'Как встроить регулярные тренировки в обычную жизнь.',
    durationSeconds: 600,
  },
  {
    slug: 'base-lesson-07-nutrition',
    title: 'Что я ем?',
    description: 'Вводный урок о повседневном питании.',
    durationSeconds: 600,
  },
];

const achievements = [
  {
    code: 'first_base_lesson',
    title: 'Первый базовый урок',
    description: 'Посмотреть один базовый урок.',
    iconKey: 'play-circle',
    ruleType: 'base_lessons_viewed',
    ruleValue: 1,
  },
  {
    code: 'base_unlocked',
    title: 'База открыта',
    description: 'Посмотреть четыре базовых урока.',
    iconKey: 'unlock',
    ruleType: 'base_lessons_viewed',
    ruleValue: 4,
  },
  {
    code: 'first_workout',
    title: 'Первая тренировка',
    description: 'Завершить первую тренировку.',
    iconKey: 'trophy',
    ruleType: 'workouts_completed',
    ruleValue: 1,
  },
  {
    code: 'week_complete',
    title: 'Неделя завершена',
    description: 'Завершить семь дней одной недели.',
    iconKey: 'calendar-check',
    ruleType: 'week_days_completed',
    ruleValue: 7,
  },
  {
    code: 'streak_3',
    title: 'Серия из трёх',
    description: 'Завершить три тренировки подряд.',
    iconKey: 'flame',
    ruleType: 'workout_streak',
    ruleValue: 3,
  },
];

const { Pool } = pg;
const pool = new Pool({ connectionString: databaseUrl, max: 1 });
const client = await pool.connect();

const workoutSlugs = [];

try {
  await client.query('BEGIN');
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['kinetra-content-seed']);

  for (let weekNumber = 1; weekNumber <= 12; weekNumber += 1) {
    const weekStatus = weekNumber === 1 ? 'active' : 'locked';
    const weekResult = await client.query(
      `
        INSERT INTO program_weeks (
          week_number,
          title,
          description,
          status
        )
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (week_number) DO UPDATE SET
          title = EXCLUDED.title,
          description = EXCLUDED.description,
          status = EXCLUDED.status
        RETURNING id
      `,
      [weekNumber, `Неделя ${weekNumber}`, `Тренировочная неделя ${weekNumber} из 12.`, weekStatus],
    );

    const programWeekId = weekResult.rows[0]?.id;

    if (typeof programWeekId !== 'string') {
      throw new Error(`Could not resolve program week ${weekNumber}.`);
    }

    for (const day of daySchedule) {
      await client.query(
        `
          INSERT INTO program_days (
            program_week_id,
            day_of_week,
            direction,
            title,
            description,
            duration_minutes,
            icon
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7)
          ON CONFLICT (program_week_id, day_of_week) DO UPDATE SET
            direction = EXCLUDED.direction,
            title = EXCLUDED.title,
            description = EXCLUDED.description,
            duration_minutes = EXCLUDED.duration_minutes,
            icon = EXCLUDED.icon
        `,
        [
          programWeekId,
          day.dayOfWeek,
          day.direction,
          day.title,
          day.description,
          day.durationMinutes,
          day.icon,
        ],
      );

      const paddedWeek = String(weekNumber).padStart(2, '0');
      const workoutSlug = `workout-week-${paddedWeek}-day-${day.dayOfWeek}`;
      workoutSlugs.push(workoutSlug);

      await client.query(
        `
          INSERT INTO videos (
            slug,
            title,
            description,
            type,
            day_of_week,
            week_number,
            duration_seconds,
            storage_key,
            poster_key,
            status,
            order_index
          )
          VALUES ($1, $2, $3, 'workout', $4, $5, $6, $7, $8, 'published', $9)
          ON CONFLICT (slug) DO UPDATE SET
            title = EXCLUDED.title,
            description = EXCLUDED.description,
            type = EXCLUDED.type,
            day_of_week = EXCLUDED.day_of_week,
            week_number = EXCLUDED.week_number,
            duration_seconds = EXCLUDED.duration_seconds,
            storage_key = EXCLUDED.storage_key,
            poster_key = EXCLUDED.poster_key,
            status = EXCLUDED.status,
            order_index = EXCLUDED.order_index
        `,
        [
          workoutSlug,
          `Неделя ${weekNumber} · ${day.weekday} · ${day.title}`,
          `Заглушка тренировки: неделя ${weekNumber}, день ${day.dayOfWeek}.`,
          day.dayOfWeek,
          weekNumber,
          day.durationMinutes * 60,
          `videos/workouts/week-${paddedWeek}/day-${day.dayOfWeek}.mp4`,
          `posters/workouts/week-${paddedWeek}/day-${day.dayOfWeek}.jpg`,
          (weekNumber - 1) * 7 + day.dayOfWeek,
        ],
      );
    }
  }

  for (const [index, lesson] of baseLessons.entries()) {
    await client.query(
      `
        INSERT INTO videos (
          slug,
          title,
          description,
          type,
          day_of_week,
          week_number,
          duration_seconds,
          storage_key,
          poster_key,
          status,
          order_index
        )
        VALUES ($1, $2, $3, 'base_lesson', NULL, NULL, $4, NULL, NULL, 'published', $5)
        ON CONFLICT (slug) DO UPDATE SET
          title = EXCLUDED.title,
          description = EXCLUDED.description,
          type = EXCLUDED.type,
          day_of_week = EXCLUDED.day_of_week,
          week_number = EXCLUDED.week_number,
          duration_seconds = EXCLUDED.duration_seconds,
          status = EXCLUDED.status,
          order_index = EXCLUDED.order_index
      `,
      [lesson.slug, lesson.title, lesson.description, lesson.durationSeconds, index + 1],
    );
  }

  for (const achievement of achievements) {
    await client.query(
      `
        INSERT INTO achievements (
          code,
          title,
          description,
          icon_key,
          rule_type,
          rule_value
        )
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (code) DO UPDATE SET
          title = EXCLUDED.title,
          description = EXCLUDED.description,
          icon_key = EXCLUDED.icon_key,
          rule_type = EXCLUDED.rule_type,
          rule_value = EXCLUDED.rule_value
      `,
      [
        achievement.code,
        achievement.title,
        achievement.description,
        achievement.iconKey,
        achievement.ruleType,
        achievement.ruleValue,
      ],
    );
  }

  const baseLessonSlugs = baseLessons.map((lesson) => lesson.slug);
  const achievementCodes = achievements.map((achievement) => achievement.code);

  const verification = await client.query(
    `
      SELECT
        (SELECT COUNT(*)::integer FROM program_weeks) AS program_weeks,
        (SELECT COUNT(*)::integer FROM program_days) AS program_days,
        (
          SELECT COUNT(*)::integer
          FROM videos
          WHERE slug = ANY($1::text[])
            AND type = 'base_lesson'
            AND day_of_week IS NULL
            AND week_number IS NULL
            AND duration_seconds > 0
        ) AS base_lessons,
        (
          SELECT COUNT(*)::integer
          FROM videos
          WHERE slug = ANY($2::text[])
            AND type = 'workout'
            AND day_of_week BETWEEN 1 AND 7
            AND week_number BETWEEN 1 AND 12
            AND duration_seconds > 0
        ) AS workouts,
        (
          SELECT COUNT(*)::integer
          FROM achievements
          WHERE code = ANY($3::text[])
        ) AS achievements
    `,
    [baseLessonSlugs, workoutSlugs, achievementCodes],
  );

  const counts = verification.rows[0];
  const expected = {
    program_weeks: 12,
    program_days: 84,
    base_lessons: 7,
    workouts: 84,
    achievements: 5,
  };

  for (const [key, expectedCount] of Object.entries(expected)) {
    if (counts?.[key] !== expectedCount) {
      throw new Error(
        `Content seed verification failed for ${key}: expected ${expectedCount}, received ${String(counts?.[key])}.`,
      );
    }
  }

  await client.query('COMMIT');

  console.log('KINETRA_CONTENT_SEED=PASS');
  console.log(JSON.stringify(expected));
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  client.release();
  await pool.end();
}
