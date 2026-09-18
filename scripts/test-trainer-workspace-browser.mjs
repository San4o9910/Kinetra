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
    uploaded = false,
    uploadOffset = 0,
    rejectLogs = false,
    templates = [];
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
    if (pathname === '/api/v1/settings/profile') {
      h.json(res, 200, {
        ...h.profile,
        notification_preferences: {
          workout_reminders: false,
          reminder_time: '09:00',
          weekly_survey_reminder: false,
        },
      });
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
      if (pathname.endsWith('/attention')) {
        h.json(res, 200, { events: [] });
        return;
      }
      if (pathname.endsWith('/measurements')) {
        h.json(res, 200, { measurements: [] });
        return;
      }
      if (pathname.endsWith('/reschedules')) {
        h.json(res, 200, { requests: [] });
        return;
      }
      if (pathname.endsWith('/complaints')) {
        h.json(res, 200, { complaints: [] });
        return;
      }
      if (pathname.endsWith('/templates')) {
        h.json(res, 200, { templates });
        return;
      }
      if (pathname.endsWith(`/plans/${planId}/template`)) {
        templates = [
          {
            id: '00000000-0000-4000-8000-000000000310',
            title: plan.title,
            goal: plan.goal,
            workouts: structuredClone(plan.workouts),
          },
        ];
        h.json(res, 200, { id: templates[0].id });
        return;
      }
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
            lesson_title: lesson?.title ?? null,
            progress_revision: 0,
            set_records: [],
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
        if (rejectLogs) {
          h.json(res, 503, { error: { code: 'OFFLINE_TEST', message: 'Связь прервалась' } });
          return;
        }
        assert.equal(body.base_revision, plan.workouts[0].progress_revision);
        Object.assign(plan.workouts[0], body, {
          progress_revision: plan.workouts[0].progress_revision + 1,
          completed_at: body.completed ? new Date().toISOString() : null,
        });
        student.completed = body.completed ? 1 : 0;
        student.minutes = body.completed ? 30 : 0;
        student.last_completed_at = plan.workouts[0].completed_at;
        h.json(res, 200, { saved: true, revision: plan.workouts[0].progress_revision });
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
      if (pathname.endsWith('/upload')) {
        h.json(res, 200, {
          status: lesson.status,
          offset: uploadOffset,
          size: lesson.size_bytes,
          original_name: lesson.original_name,
          source_modified: lesson.source_modified,
          chunk_bytes: 4 * 1024 * 1024,
        });
        return;
      }
      if (pathname.endsWith('/chunk')) {
        assert.equal(req.headers['content-type'], 'application/octet-stream');
        assert.equal(Number(req.headers['x-upload-offset']), uploadOffset);
        for await (const bytes of req) uploadOffset += bytes.length;
        lesson.upload_offset = uploadOffset;
        lesson.status = 'uploading';
        h.json(res, 200, { offset: uploadOffset });
        return;
      }
      if (pathname.endsWith('/finish')) {
        assert.equal(uploadOffset, lesson.size_bytes);
        uploaded = true;
        lesson.status = 'ready';
        lesson.duration_seconds = 20;
        h.json(res, 200, { queued: true });
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
  const clickReady = async (context, text) => {
    await h.waitFor('enabled action: ' + text, () =>
      context.cdp.evaluate(
        `(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)});return !!b&&!b.matches(':disabled');})()`,
      ),
    );
    await context.clickButtonWithText(text);
  };
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
    await clickReady(trainer, '＋ Добавить ученика');
    await fill(trainer, 'Имя', 'Анна Ученица');
    await fill(trainer, 'Контакт', 'anna@example.test');
    await clickReady(trainer, 'Создать приглашение');
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
    await clickReady(trainer, 'Загрузить урок');
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
    await clickReady(trainer, 'Создать программу');
    await h.waitFor('program draft', async () =>
      (await trainer.bodyText()).includes('Добавить занятие'),
    );
    await fill(trainer, 'Название программы', 'Сила и мобильность');
    await fill(trainer, 'Цель и рекомендации', 'Две спокойные тренировки');
    await clickReady(trainer, '＋ Добавить занятие');
    await fill(trainer, 'Название занятия', 'Первая тренировка');
    await fill(trainer, 'Инструкции', 'Приседания: 3 подхода по 12');
    await fill(trainer, 'Видеоурок', lessonId);
    await clickReady(trainer, '＋ Добавить упражнение');
    await fill(trainer, 'Название упражнения', 'Приседания');
    await fill(trainer, 'Вес, кг', '10');
    await h.waitFor(
      'autosaved structured exercise',
      () => plan?.workouts[0]?.exercises?.[0]?.weight_kg === 10,
    );
    await clickReady(trainer, 'Сохранить как шаблон');
    await h.waitFor('trainer template saved', () => templates.length === 1);

    await trainer.cdp.evaluate('window.confirm=()=>true');
    await clickReady(trainer, 'Сохранить и назначить');
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
    await clickReady(client, 'Подключиться к тренеру');
    await h.waitFor('assigned program', async () =>
      (await client.bodyText()).includes('Первая тренировка'),
    );
    assert.equal(
      await client.exists('main-screen'),
      false,
      'Personal program replaces the general course for an assigned student',
    );
    await clickReady(client, 'Начать тренировку');
    await h.waitFor('workout mode', () => client.exists('training-session'));
    assert.equal(
      await client.cdp.evaluate('document.activeElement?.id'),
      'training-session-heading',
    );
    assert.equal(
      await client.cdp.evaluate(
        "[...document.querySelectorAll('.training-session input,.training-session select,.training-session textarea')].every(e=>!!e.closest('label')||!!e.getAttribute('aria-label'))",
      ),
      true,
      'Workout fields have accessible names',
    );
    // Two headless windows are open. Establish desktop foreground focus for native keyboard input.
    await client.setViewport(1280, 900);
    await client.cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    await client.cdp.send('Page.bringToFront');
    assert.equal(await client.cdp.evaluate('document.hasFocus()'), true);
    await client.cdp.evaluate("document.getElementById('training-session-heading').focus()");
    await client.cdp.evaluate(
      `(()=>{window.__trainingFocusTrace=[];for(const type of ['keydown','keyup','focusin','focusout'])document.addEventListener(type,e=>queueMicrotask(()=>{window.__trainingFocusTrace.push({type,key:e.key,prevented:e.defaultPrevented,target:e.target?.tagName,id:e.target?.id,active:document.activeElement?.tagName,activeId:document.activeElement?.id});}),true);return new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));})()`,
    );
    await client.cdp.send('Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      key: 'Tab',
      code: 'Tab',
      windowsVirtualKeyCode: 9,
      nativeVirtualKeyCode: 9,
    });
    await client.cdp.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'Tab',
      code: 'Tab',
      windowsVirtualKeyCode: 9,
      nativeVirtualKeyCode: 9,
    });
    try {
      await h.waitFor(
        'keyboard focus reaches workout controls',
        async () => (await client.cdp.evaluate('document.activeElement?.tagName')) === 'BUTTON',
      );
    } catch (error) {
      throw new Error(
        String(error) +
          ' ' +
          JSON.stringify(
            await client.cdp.evaluate(
              `({focus:document.activeElement?.outerHTML?.slice(0,500),trace:window.__trainingFocusTrace.slice(-25),controls:[...document.querySelectorAll('.training-session button')].slice(0,8).map(b=>({text:b.textContent,tabIndex:b.tabIndex,disabled:b.matches(':disabled'),display:getComputedStyle(b).display,visibility:getComputedStyle(b).visibility}))})`,
            ),
          ),
      );
    }
    await client.setViewport(390, 844);
    rejectLogs = true;
    await client.cdp.evaluate(
      "document.querySelector('.training-set-list button[aria-pressed]').click()",
    );
    await h.waitFor('offline marks retained', async () =>
      (await client.bodyText()).includes('Отметки ожидают отправки'),
    );
    assert.ok(
      await client.cdp.evaluate(
        `Object.keys(localStorage).some(k=>k.startsWith('kinetra.training.private.v1:${clientId}:workout:'))`,
      ),
    );
    rejectLogs = false;
    await clickReady(client, 'Отправить снова');
    await h.waitFor('replayed workout marks', () => plan.workouts[0].set_records.length === 1);
    await h.waitFor('save finished', async () =>
      (await client.bodyText()).includes('Сохранено у тренера'),
    );

    await fill(client, 'Сообщение тренеру', 'Сделала все подходы');
    await clickReady(client, 'Тренировка выполнена');
    await h.waitFor('individual progress persisted', () => student.completed === 1);
    await trainer.navigate('/trainer/students');
    await h.waitFor('updated student roster', async () =>
      (await trainer.bodyText()).includes('1 из 1 занятий'),
    );
    await trainer.cdp.evaluate("document.querySelector('.training-student').click()");
    await h.waitFor('trainer receives feedback', async () =>
      (await trainer.bodyText()).includes('Сделала все подходы'),
    );
    await client.navigate('/schedule');
    await h.waitFor(
      'personal calendar',
      async () => await client.cdp.evaluate("!!document.querySelector('.training-calendar')"),
    );
    assert.ok(
      await client.cdp.evaluate(
        "[...document.querySelectorAll('.training-calendar button')].every(b=>b.getAttribute('aria-label')||b.textContent.trim())",
      ),
    );
    await client.navigate('/progress');
    await h.waitFor('exercise history', async () =>
      (await client.bodyText()).includes('Приседания'),
    );
    assert.ok((await client.bodyText()).includes('Замеры'));
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
  console.log('KINETRA_TRAINING_EXPERIENCE_BROWSER=PASS');
};
