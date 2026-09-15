import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenAiCoachProvider } from '../src/coaching/provider.js';
import { normalizeChatVideo } from '../src/coaching/chat-videos.js';
import {
  coachQuestionSchema,
  workoutGuideSchema,
  workoutSessionSchema,
} from '../src/coaching/schema.js';

test('coaching inputs reject authority overrides, out-of-range feedback and ambiguous chapters', () => {
  for (const input of [
    {},
    { position_seconds: -1 },
    { difficulty: 6 },
    { wellbeing: 0 },
    { note: 'x'.repeat(1001) },
    { user_id: 'someone', position_seconds: 4 },
  ]) {
    assert.equal(workoutSessionSchema.safeParse(input).success, false);
  }
  assert.equal(workoutSessionSchema.safeParse({ position_seconds: 90 }).success, true);
  assert.equal(
    workoutSessionSchema.safeParse({ difficulty: 3, wellbeing: 4, note: '' }).success,
    true,
  );
  const guide = {
    equipment: ['Коврик'],
    technique: 'Авторская подсказка',
    chapters: [
      { title: 'Начало', start_seconds: 0 },
      { title: 'Основная часть', start_seconds: 30 },
    ],
  };
  assert.equal(workoutGuideSchema.safeParse(guide).success, true);
  assert.equal(
    workoutGuideSchema.safeParse({ ...guide, chapters: [...guide.chapters].reverse() }).success,
    false,
  );
  assert.equal(
    workoutGuideSchema.safeParse({ ...guide, chapters: [guide.chapters[0], guide.chapters[0]] })
      .success,
    false,
  );
  assert.equal(
    coachQuestionSchema.safeParse({
      request_id: '00000000-0000-4000-8000-000000000001',
      question: 'Как найти расписание?',
      model: 'override',
    }).success,
    false,
  );
});

test('AI uses configured server credentials and returns only complete bounded responses', async () => {
  let body: Record<string, unknown> | undefined;
  const fetcher: typeof fetch = async (url, init) => {
    assert.equal(url, 'https://api.openai.com/v1/chat/completions');
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer test-key');
    assert.equal(init?.redirect, 'error');
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return Response.json({
      choices: [{ finish_reason: 'stop', message: { content: '  Ответ по материалам.  ' } }],
    });
  };
  assert.equal(
    await new OpenAiCoachProvider('test-key', 'configured-model', fetcher).answer('Вопрос', '{}'),
    'Ответ по материалам.',
  );
  assert.equal(body?.store, false);
  assert.equal(body?.model, 'configured-model');
  for (const response of [
    new Response('secret-provider-error', { status: 500 }),
    Response.json({
      choices: [{ finish_reason: 'length', message: { content: 'Обрезанный ответ' } }],
    }),
    new Response('x'.repeat(100001)),
  ]) {
    await assert.rejects(
      new OpenAiCoachProvider('test-key', 'configured-model', async () => response).answer(
        'Вопрос',
        '{}',
      ),
      (error: unknown) =>
        error instanceof Error &&
        !error.message.includes('secret-provider-error') &&
        'statusCode' in error &&
        error.statusCode === 503,
    );
  }
});

test('chat video decoder accepts a real MP4 and rejects invalid bytes and overlong movies', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kinetra-video-test-'));
  const execute = promisify(execFile);
  try {
    const inputPath = join(directory, 'fixture.mp4');
    await execute(
      'ffmpeg',
      [
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'color=c=blue:s=64x64:r=2',
        '-t',
        '2',
        '-c:v',
        'libx264',
        '-threads',
        '1',
        '-pix_fmt',
        'yuv420p',
        '-metadata',
        'comment=remove-this-private-metadata',
        '-y',
        inputPath,
      ],
      { timeout: 15000 },
    );
    const normalized = await normalizeChatVideo(await readFile(inputPath), directory);
    assert.ok(normalized.data.byteLength > 0);
    assert.equal(normalized.duration, 2);
    const metadata = await execute('ffprobe', [
      '-v',
      'error',
      '-show_format',
      '-of',
      'json',
      join(directory, 'output.mp4'),
    ]);
    assert.equal(metadata.stdout.includes('remove-this-private-metadata'), false);
    await assert.rejects(normalizeChatVideo(Buffer.from('not a video'), directory));
    await execute(
      'ffmpeg',
      [
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'color=c=blue:s=64x64:r=1',
        '-t',
        '181',
        '-c:v',
        'libx264',
        '-threads',
        '1',
        '-y',
        inputPath,
      ],
      { timeout: 15000 },
    );
    await assert.rejects(normalizeChatVideo(await readFile(inputPath), directory), /до 3 минут/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
