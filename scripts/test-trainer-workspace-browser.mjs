import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

export const runTrainerWorkspaceBrowser = async (h) => {
  const trainerId = '00000000-0000-4000-8000-000000000301',
    clientId = '00000000-0000-4000-8000-000000000302',
    studentId = '00000000-0000-4000-8000-000000000303',
    planId = '00000000-0000-4000-8000-000000000304',
    lessonId = '00000000-0000-4000-8000-000000000305';
  const token = 'a'.repeat(43);
  let student = null,
    plan = null,
    lesson = null,
    uploaded = false;
  const accounts = new Map();
  const person = (role) => ({
    ...h.profile,
    account_role: role,
    requested_role: role === 'trainer' ? 'trainer' : 'trainee',
    trainer_profile:
      role === 'trainer' ? { display_name: 'Мария Тренер', can_manage_videos: false } : null,
    user: {
      ...h.profile.user,
      id: role === 'trainer' ? trainerId : clientId,
      onboardingStatus: 'active',
    },
  });
  const session = (role) => ({
    user: person(role).user,
    accessToken: `workspace-${role}`,
    tokenType: 'Bearer',
    expiresIn: 900,
  });
  const server = h.createFixtureServer(async (req, res) => {
    const pathname = new URL(req.url ?? '/', h.frontendOrigin).pathname;
    const role = String(req.headers.authorization ?? '').replace('Bearer workspace-', '');
    if (pathname === '/api/v1/auth/login') {
      const body = await h.readJsonBody(req);
      const role = body.identifier.startsWith('trainer') ? 'trainer' : 'client';
      accounts.set(role, true);
      h.json(res, 200, session(role), {
        'Set-Cookie': `kinetra_refresh=${role}; HttpOnly; Path=/api/v1/auth; SameSite=Lax`,
      });
      return;
    }
    if (pathname === '/api/v1/auth/refresh') {
      const role = String(req.headers.cookie ?? '').includes('=trainer') ? 'trainer' : 'client';
      if (accounts.get(role)) h.json(res, 200, session(role));
      else h.json(res, 401, { error: { code: 'AUTHENTICATION_REQUIRED', message: 'Sign in' } });
      return;
    }
    if (pathname === '/api/v1/me') {
      h.json(res, 200, person(role));
      return;
    }
    if (pathname === '/api/v1/admin/trainer-verification/access') {
      h.json(res, 200, { can_review: false });
      return;
    }
    if (pathname === '/api/v1/chat/session') {
      h.json(res, 200, { enabled: false, available: false, reason: 'disabled' });
      return;
    }
    if (pathname === '/api/v1/settings/subscription') {
      h.json(res, 200, {
        status: 'active',
        provider: 'free_beta',
        starts_at: new Date().toISOString(),
        expires_at: null,
        amount: 0,
        currency: 'RUB',
        auto_renew: false,
        days_remaining: null,
        access_mode: 'free_beta',
        payments_enabled: false,
      });
      return;
    }
    if (pathname.startsWith('/api/v1/training/')) {
      assert.ok(
        ['trainer', 'client'].includes(role),
        'Protected training request carries account token',
      );
      if (pathname.endsWith('/students') && req.method === 'POST') {
        const body = await h.readJsonBody(req);
        assert.equal(body.name, 'Анна Ученица');
        student = {
          id: studentId,
          name: body.name,
          contact: body.contact,
          client_id: null,
          accepted_at: null,
          archived_at: null,
          conversation_id: null,
          total: 0,
          completed: 0,
          minutes: 0,
          last_completed_at: null,
        };
        h.json(res, 201, { id: studentId, token });
        return;
      }
      if (pathname.endsWith('/students')) {
        h.json(res, 200, { students: student ? [student] : [] });
        return;
      }
      if (pathname.endsWith(`/students/${studentId}`)) {
        h.json(res, 200, { student, plans: plan ? [plan] : [] });
        return;
      }
      if (pathname.endsWith(`/students/${studentId}/plans`)) {
        plan = {
          id: planId,
          title: 'Новая программа',
          goal: '',
          status: 'draft',
          revision: 1,
          workouts: [],
        };
        h.json(res, 201, { id: planId });
        return;
      }
      if (pathname.endsWith(`/plans/${planId}`)) {
        const body = await h.readJsonBody(req);
        assert.equal(body.revision, plan.revision);
        plan = {
          ...plan,
          ...body,
          revision: plan.revision + 1,
          workouts: body.workouts.map((w) => ({
            ...w,
            completed_at: null,
            position_seconds: 0,
            difficulty: null,
            wellbeing: null,
            note: '',
            lesson_title: lesson.title,
          })),
        };
        h.json(res, 200, { revision: plan.revision });
        return;
      }
      if (pathname.endsWith(`/plans/${planId}/publish`)) {
        assert.equal((await h.readJsonBody(req)).revision, plan.revision);
        plan.status = 'published';
        plan.revision++;
        student.total = plan.workouts.length;
        h.json(res, 200, { saved: true });
        return;
      }
      if (pathname.endsWith('/invitation')) {
        assert.equal((await h.readJsonBody(req)).token, token);
        h.json(res, 200, { trainer_name: 'Мария Тренер' });
        return;
      }
      if (pathname.endsWith('/invitation/accept')) {
        assert.equal(role, 'client');
        student.client_id = clientId;
        student.accepted_at = new Date().toISOString();
        h.json(res, 200, { connected: true });
        return;
      }
      if (pathname.endsWith('/mine')) {
        h.json(res, 200, {
          student_id: student?.client_id ? studentId : null,
          trainer_name: student?.client_id ? 'Мария Тренер' : null,
          plans: student?.client_id && plan?.status === 'published' ? [plan] : [],
        });
        return;
      }
      if (pathname.endsWith('/log')) {
        assert.equal(role, 'client');
        const body = await h.readJsonBody(req);
        Object.assign(plan.workouts[0], body, { completed_at: new Date().toISOString() });
        student.completed = 1;
        student.minutes = 30;
        student.last_completed_at = plan.workouts[0].completed_at;
        h.json(res, 200, { saved: true });
        return;
      }
      if (pathname.endsWith('/lessons') && req.method === 'POST') {
        const body = await h.readJsonBody(req);
        lesson = { id: lessonId, ...body, status: 'pending', duration_seconds: null };
        h.json(res, 201, { id: lessonId });
        return;
      }
      if (pathname.endsWith('/lessons')) {
        h.json(res, 200, {
          lessons: lesson ? [lesson] : [],
          upload_available: true,
          max_bytes: 268435456,
        });
        return;
      }
      if (pathname.endsWith('/file')) {
        assert.equal(req.headers['content-type'], 'video/mp4');
        let size = 0;
        for await (const bytes of req) size += bytes.length;
        assert.equal(size, lesson.size_bytes);
        uploaded = true;
        lesson.status = 'ready';
        lesson.duration_seconds = 20;
        h.json(res, 200, { saved: true });
        return;
      }
    }
    if (pathname.startsWith('/api/')) {
      h.json(res, 404, { error: { code: 'NOT_FOUND', message: 'Not found' } });
      return;
    }
    let file = path.join(h.frontendDist, pathname === '/' ? '/index.html' : pathname);
    try {
      if (!(await stat(file)).isFile()) file = path.join(h.frontendDist, 'index.html');
    } catch {
      file = path.join(h.frontendDist, 'index.html');
    }
    res.writeHead(200, {
      'Content-Type': h.contentTypes.get(path.extname(file)) ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(await readFile(file));
  });
  const dirs = await Promise.all([
    mkdtemp(path.join(os.tmpdir(), 'kinetra-browser-')),
    mkdtemp(path.join(os.tmpdir(), 'kinetra-browser-')),
  ]);
  let trainer, client;
  const fill = async (context, label, value) =>
    context.cdp.evaluate(
      `(()=>{const label=[...document.querySelectorAll('label')].find(l=>l.textContent.trim().startsWith(${JSON.stringify(label)}));if(!label)throw Error('Missing label');const el=label.querySelector('input,textarea,select');const proto=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:el.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event(el.tagName==='SELECT'?'change':'input',{bubbles:true}));})()`,
    );
  try {
    await h.listen(server, h.apiPort);
    trainer = await h.launchT12BrowserContext(dirs[0], 1280, 900);
    client = await h.launchT12BrowserContext(dirs[1], 390, 844);
    await trainer.cdp.send('Page.navigate', { url: h.frontendOrigin + '/login' });
    await h.waitFor('workspace trainer login', () => trainer.exists('login-screen'));
    await trainer.setValue('login-identifier', 'trainer@example.test');
    await trainer.setValue('login-password', 'abc123');
    await trainer.click('login-submit');
    await h.waitFor('trainer workspace landing', () => trainer.exists('trainer-workspace'));
    assert.equal(await trainer.pathname(), '/trainer/students');
    await trainer.clickButtonWithText('＋ Добавить ученика');
    await fill(trainer, 'Имя', 'Анна Ученица');
    await fill(trainer, 'Контакт', 'anna@example.test');
    await trainer.clickButtonWithText('Создать приглашение');
    await h.waitFor('student invitation created', () => student !== null);
    await h.waitFor('student detail rendered', async () =>
      (await trainer.bodyText()).includes('Создать программу'),
    );
    assert.ok((await trainer.bodyText()).includes('Приглашение готово'));
    await trainer.navigate('/trainer/lessons');
    await h.waitFor('personal library', async () =>
      (await trainer.bodyText()).includes('Новый урок'),
    );
    await fill(trainer, 'Название', 'Разминка тренера');
    await trainer.cdp.evaluate(
      `(()=>{const input=document.querySelector('input[type=file]');const transfer=new DataTransfer();transfer.items.add(new File([new Uint8Array([1,2,3,4])],'lesson.mp4',{type:'video/mp4'}));input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()`,
    );
    await trainer.clickButtonWithText('Загрузить урок');
    await h.waitFor('personal video uploaded', () => uploaded);
    await h.waitFor('video ready in library', async () =>
      (await trainer.bodyText()).includes('Готов к занятиям'),
    );
    await trainer.navigate('/trainer/students');
    await h.waitFor('student roster', async () =>
      (await trainer.bodyText()).includes('Анна Ученица'),
    );
    await trainer.cdp.evaluate("document.querySelector('.training-student').click()");
    await h.waitFor('student selected', async () =>
      (await trainer.bodyText()).includes('Создать программу'),
    );
    await trainer.clickButtonWithText('Создать программу');
    await h.waitFor('program draft', async () =>
      (await trainer.bodyText()).includes('Добавить занятие'),
    );
    await fill(trainer, 'Название программы', 'Сила и мобильность');
    await fill(trainer, 'Цель и рекомендации', 'Две спокойные тренировки');
    await trainer.clickButtonWithText('＋ Добавить занятие');
    await fill(trainer, 'Название занятия', 'Первая тренировка');
    await fill(trainer, 'Упражнения', 'Приседания: 3 подхода по 12');
    await fill(trainer, 'Видеоурок', lessonId);
    await trainer.cdp.evaluate('window.confirm=()=>true');
    await trainer.clickButtonWithText('Сохранить и назначить');
    await h.waitFor('program published', () => plan?.status === 'published');
    assert.equal(plan.workouts[0].lesson_id, lessonId);
    await client.cdp.send('Page.navigate', { url: h.frontendOrigin + '/login#invite=' + token });
    await h.waitFor('student login', () => client.exists('login-screen'));
    await client.setValue('login-identifier', 'student@example.test');
    await client.setValue('login-password', 'abc123');
    await client.click('login-submit');
    await h.waitFor('invitation opens after authentication', async () =>
      (await client.bodyText()).includes('Приглашение от тренера Мария Тренер'),
    );
    await client.clickButtonWithText('Подключиться к тренеру');
    await h.waitFor('assigned program', async () =>
      (await client.bodyText()).includes('Первая тренировка'),
    );
    assert.equal(
      await client.exists('main-screen'),
      false,
      'Personal program replaces the general course for an assigned student',
    );
    await client.cdp.evaluate("document.querySelector('.training-completion summary').click()");
    await fill(client, 'Сообщение тренеру', 'Сделала все подходы');
    await client.clickButtonWithText('Тренировка выполнена');
    await h.waitFor('individual progress persisted', () => student.completed === 1);
    await trainer.navigate('/trainer/students');
    await h.waitFor('updated student roster', async () =>
      (await trainer.bodyText()).includes('1 из 1 занятий'),
    );
    await trainer.cdp.evaluate("document.querySelector('.training-student').click()");
    await h.waitFor('trainer receives feedback', async () =>
      (await trainer.bodyText()).includes('Сделала все подходы'),
    );
    for (const context of [trainer, client])
      for (const width of [390, 1280]) {
        await context.setViewport(width, 844);
        assert.equal(
          await context.cdp.evaluate('document.documentElement.scrollWidth<=innerWidth'),
          true,
          `Trainer workspace overflows at ${width}`,
        );
      }
  } finally {
    for (const context of [trainer, client]) {
      context?.cdp.close();
      await h.terminateChrome(context?.chrome ?? null);
    }
    await h.close(server);
    for (const dir of dirs) await h.removeProfileDirectory(dir);
  }
  console.log('KINETRA_TRAINER_WORKSPACE_BROWSER=PASS');
};
