import {
  nutritionFixture,
  runNutritionCoachingBrowser,
} from './test-nutrition-coaching-browser.mjs';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

export const runTrainerWorkspaceBrowser = async (h) => {
  const trainerId = '00000000-0000-4000-8000-000000000301',
    clientId = '00000000-0000-4000-8000-000000000302',
    studentId = '00000000-0000-4000-8000-000000000303',
    planId = '00000000-0000-4000-8000-000000000304',
    lessonId = '00000000-0000-4000-8000-000000000305';
  let clientOnboarding = 'active';
  const token = 'a'.repeat(43);
  let student = null,
    plan = null,
    lesson = null,
    uploaded = false,
    uploadOffset = 0,
    rejectLogs = false,
    templates = [],
    lessonAssigned = false,
    lessonCompleted = false;
  const mediaDirectory = await mkdtemp(path.join(os.tmpdir(), 'kinetra-sharing-media-'));
  const mediaFile = path.join(mediaDirectory, 'lesson.mp4');
  execFileSync('ffmpeg', [
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'color=c=0x001621:s=320x180:r=15',
    '-t',
    '2',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    mediaFile,
  ]);
  const photoFile = path.join(mediaDirectory, 'meal.png');
  execFileSync('ffmpeg', ['-v', 'error', '-i', mediaFile, '-frames:v', '1', photoFile]);
  const nutrition = nutritionFixture(h, {
    trainerId,
    clientId,
    studentId,
    getStudent: () => student,
    getCompleted: () => lessonCompleted,
    photoFile,
  });
  const assignedLessons = () =>
    lessonAssigned && lesson
      ? [
          {
            ...lesson,
            assigned_at: new Date().toISOString(),
            position_seconds: 0,
            completed_at: lessonCompleted ? new Date().toISOString() : null,
          },
        ]
      : [];
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
      onboardingStatus: role === 'client' ? clientOnboarding : 'active',
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
      const role = /(?:^|;\s*)kinetra_refresh=(trainer|client)(?:;|$)/.exec(
        String(req.headers.cookie ?? ''),
      )?.[1];
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
    if (await nutrition.handle(req, res, role)) return;
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
    if (pathname === '/fixture-lesson.mp4') {
      res.writeHead(200, { 'Content-Type': 'video/mp4' });
      res.end(await readFile(mediaFile));
      return;
    }
    if (pathname.startsWith('/api/v1/training/')) {
      if (pathname.endsWith('/access')) {
        h.json(res, 200, { path: '/fixture-lesson.mp4' });
        return;
      }
      if (pathname.endsWith('/assignments')) {
        if (req.method === 'POST') {
          const input = await h.readJsonBody(req);
          assert.ok(input.target === 'all' || input.student_ids.includes(studentId));
          lessonAssigned = true;
          h.json(res, 200, { assigned: 1 });
        } else
          h.json(res, 200, {
            recipients: lessonAssigned
              ? [
                  {
                    ...student,
                    position_seconds: 0,
                    completed_at: lessonCompleted ? new Date().toISOString() : null,
                  },
                ]
              : [],
          });
        return;
      }
      if (pathname.endsWith('/progress')) {
        const input = await h.readJsonBody(req);
        lessonCompleted = lessonCompleted || input.completed === true;
        h.json(res, 200, { saved: true });
        return;
      }

      assert.ok(
        ['trainer', 'client'].includes(role),
        'Protected training request carries account token',
      );
      if (pathname.endsWith('/attention')) {
        h.json(res, 200, {
          events:
            student && !student.client_id
              ? [
                  {
                    student_id: studentId,
                    name: student.name,
                    kind: 'invitation',
                    title: 'Ещё не принял приглашение',
                  },
                ]
              : [],
        });
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
        h.json(res, 200, {
          student,
          plans: plan ? [plan] : [],
          assigned_lessons: assignedLessons(),
        });
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
          assigned_lessons: student?.client_id ? assignedLessons() : [],
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
        if (Object.keys(body).length === 1 && Number.isInteger(body.position_seconds)) {
          plan.workouts[0].position_seconds = body.position_seconds;
          h.json(res, 200, { saved: true, revision: plan.workouts[0].progress_revision });
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
  nutrition.attach(server);
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
    await trainer.cdp.send('Page.navigate', { url: h.frontendOrigin + '/login' });
    await h.waitFor('workspace trainer login', () => trainer.exists('login-screen'));
    await trainer.setValue('login-identifier', 'trainer@example.test');
    await trainer.setValue('login-password', 'K7m9Q2');
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
    await clickReady(trainer, 'Назначить / результаты');
    await h.waitFor('lesson recipients loaded', async () =>
      (await trainer.bodyText()).includes('Доступ появится после принятия приглашения'),
    );
    await fill(trainer, 'Получатели', 'all');
    await clickReady(trainer, 'Назначить всем');
    await h.waitFor('lesson assigned to current roster', () => lessonAssigned);
    await trainer.navigate('/trainer/students');
    await h.waitFor('student roster', async () =>
      (await trainer.bodyText()).includes('Анна Ученица'),
    );
    for (const theme of ['dark', 'light']) {
      await trainer.cdp.evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);
      const contrast = await trainer.cdp.evaluate(
        `(()=>{const node=document.querySelector('.training-attention-item button');const fg=getComputedStyle(node).color,bg=getComputedStyle(node.closest('article')).backgroundColor;const lum=c=>{const v=c.match(/[\\d.]+/g).slice(0,3).map(Number).map(n=>n/255).map(n=>n<=0.04045?n/12.92:((n+0.055)/1.055)**2.4);return v[0]*0.2126+v[1]*0.7152+v[2]*0.0722;};const a=lum(fg),b=lum(bg);return (Math.max(a,b)+.05)/(Math.min(a,b)+.05);})()`,
      );
      assert.ok(contrast >= 4.5, `${theme} attention text contrast: ${contrast}`);
      const mark = await trainer.cdp.evaluate(
        `(()=>{const m=document.querySelector('.trainer-admin-brand svg'),tile=m.parentElement;return {stroke:getComputedStyle(m).stroke,background:getComputedStyle(tile).backgroundColor,width:m.getBoundingClientRect().width,tile:tile.getBoundingClientRect().width};})()`,
      );
      assert.notEqual(mark.stroke, mark.background);
      assert.ok(mark.width <= mark.tile);
    }
    await trainer.cdp.evaluate("document.documentElement.dataset.theme='dark'");
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
    // Keep one native headless window during the keyboard scenario. Distinct
    // Chrome processes can steal OS focus despite Page.bringToFront; the two
    // users remain isolated by their persistent profiles and fixture sessions.
    trainer.cdp.close();
    await h.terminateChrome(trainer.chrome);
    trainer = null;
    client = await h.launchT12BrowserContext(dirs[1], 1280, 900);
    await client.cdp.send('Page.navigate', { url: h.frontendOrigin + '/login#invite=' + token });
    await h.waitFor('student login', () => client.exists('login-screen'));
    await client.setValue('login-identifier', 'student@example.test');
    await client.setValue('login-password', 'K7m9Q2');
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
    // Native input must focus the renderer, not only the DOM element. A synthetic
    // .click() does not establish the browser's keyboard input target in headless Chrome.
    await client.setViewport(1280, 900);
    await client.cdp.send('Page.bringToFront');
    await client.cdp.evaluate(
      `(()=>{const button=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Начать тренировку');if(!button||button.disabled)throw Error('Workout action unavailable');button.dataset.testid='workspace-start-with-pointer';})()`,
    );
    await client.trustedClick('workspace-start-with-pointer');
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
    await h.waitFor('native workout window focus', () =>
      client.cdp.evaluate('document.hasFocus()'),
    );
    await client.cdp.evaluate(
      `(()=>{window.__trainingFocusTrace=[];for(const type of ['keydown','keyup','focusin','focusout'])document.addEventListener(type,e=>queueMicrotask(()=>{window.__trainingFocusTrace.push({type,key:e.key,prevented:e.defaultPrevented,target:e.target?.tagName,id:e.target?.id,active:document.activeElement?.tagName,activeId:document.activeElement?.id});}),true);return new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));})()`,
    );
    await client.cdp.send('Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      key: 'Tab',
      code: 'Tab',
      windowsVirtualKeyCode: 9,
    });
    await client.cdp.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'Tab',
      code: 'Tab',
      windowsVirtualKeyCode: 9,
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
    assert.ok(
      await client.cdp.evaluate(
        "window.__trainingFocusTrace.some(e=>e.type==='keydown'&&e.key==='Tab')",
      ),
      'Native Tab reaches the workout document',
    );
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
    trainer = await h.launchT12BrowserContext(dirs[0], 1280, 900);
    await h.waitFor(
      'returning trainer authentication',
      async () =>
        (await trainer.exists('login-screen')) || (await trainer.exists('trainer-workspace')),
    );
    if (await trainer.exists('login-screen')) {
      await trainer.setValue('login-identifier', 'trainer@example.test');
      await trainer.setValue('login-password', 'K7m9Q2');
      await trainer.click('login-submit');
    }
    await h.waitFor('returning trainer workspace', () => trainer.exists('trainer-workspace'));
    await trainer.navigate('/trainer/students');
    await h.waitFor('updated student roster', async () =>
      (await trainer.bodyText()).includes('1 из 1 занятий'),
    );
    await trainer.cdp.evaluate("document.querySelector('.training-student').click()");
    await h.waitFor('trainer receives feedback', async () =>
      (await trainer.bodyText()).includes('Сделала все подходы'),
    );
    await client.navigate('/');
    await client.cdp.send('Page.bringToFront');
    await h.waitFor('standalone assigned lesson', async () =>
      (await client.bodyText()).includes('Смотреть урок'),
    );
    await clickReady(client, 'Смотреть урок');
    await h.waitFor('lesson ready to play', async () =>
      (await client.bodyText()).includes('Воспроизвести урок'),
    );
    await client.setViewport(390, 844);
    await clickReady(client, '▶ Воспроизвести урок');
    await h.waitFor('brand intro starts', () =>
      client.cdp.evaluate("!!document.querySelector('.kinetra-video-intro')"),
    );
    const started = Date.now();
    const artifact = path.join(process.cwd(), 'artifacts/lesson-sharing');
    await mkdir(artifact, { recursive: true });
    for (const phase of ['drop', 'bounce', 'draw', 'word', 'gather', 'split']) {
      await h.waitFor(`intro phase ${phase}`, () =>
        client.cdp.evaluate(
          `document.querySelector('.kinetra-video-intro svg')?.dataset.phase===${JSON.stringify(phase)}`,
        ),
      );
      await new Promise((resolve) =>
        setTimeout(
          resolve,
          { drop: 500, bounce: 350, draw: 1200, word: 350, gather: 700, split: 400 }[phase],
        ),
      );
      await client.cdp.evaluate(
        "document.querySelector('.kinetra-video-intro').scrollIntoView({block:'center'})",
      );
      const shot = await client.cdp.send('Page.captureScreenshot', { format: 'png' });
      if (process.env.KINETRA_CAPTURE_PREVIEW_LOG === 'true')
        console.log('KINETRA_INTRO_FRAME=' + JSON.stringify({ phase, data: shot.data }));
      await writeFile(path.join(artifact, `intro-${phase}.png`), Buffer.from(shot.data, 'base64'));
    }
    await h.waitFor('intro ends', () =>
      client.cdp.evaluate("!document.querySelector('.kinetra-video-intro')"),
    );
    assert.ok(Date.now() - started >= 6500, 'Intro must remain visible for all stages');
    assert.equal(
      await client.cdp.evaluate("document.querySelector('.training-player video').hidden"),
      false,
    );
    await clickReady(client, 'Отметить пройденным');
    await h.waitFor('separate lesson progress', () => lessonCompleted);
    // Reopen: keyboard-operable skip, then reduced motion omits the decorative sequence.
    await clickReady(client, 'Закрыть урок');
    await clickReady(client, 'Смотреть урок');
    await clickReady(client, '▶ Воспроизвести урок');
    await h.waitFor('skip available', () =>
      client.cdp.evaluate("!!document.querySelector('.kinetra-intro-caption button')"),
    );
    await client.cdp.send('Page.bringToFront');
    await client.cdp.evaluate(
      "document.querySelector('.kinetra-intro-caption button').dataset.testid='intro-skip'",
    );
    await client.cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    await client.cdp.evaluate("document.querySelector('.kinetra-intro-caption button').focus()");
    await client.cdp.send('Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
    });
    await client.cdp.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
    });
    await h.waitFor('keyboard skips animation', () =>
      client.cdp.evaluate("!document.querySelector('.kinetra-video-intro')"),
    );
    await clickReady(client, 'Закрыть урок');
    await client.cdp.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
    });
    await clickReady(client, 'Смотреть урок');
    await clickReady(client, '▶ Воспроизвести урок');
    assert.equal(
      await client.cdp.evaluate("!!document.querySelector('.kinetra-video-intro')"),
      false,
    );
    await client.cdp.send('Emulation.setEmulatedMedia', { features: [] });
    console.log('KINETRA_LESSON_SHARING_INTRO_ACCESSIBILITY_BROWSER=PASS');
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
    await h.waitFor('coach rating available after completion', () =>
      client.cdp.evaluate('!!document.querySelector(\'.coach-stars input[value="5"]\')'),
    );
    await client.cdp.evaluate('document.querySelector(\'.coach-stars input[value="5"]\').click()');
    await clickReady(client, 'Оценить');
    await h.waitFor('one coach rating saved', () => nutrition.getScore() === 5);

    for (const context of [trainer, client])
      for (const width of [390, 1280]) {
        await context.setViewport(width, 844);
        assert.equal(
          await context.cdp.evaluate('document.documentElement.scrollWidth<=innerWidth'),
          true,
          `Trainer workspace overflows at ${width}`,
        );
      }
    clientOnboarding = 'survey_pending';
    await runNutritionCoachingBrowser(h, trainer, client, nutrition, fill, clickReady, photoFile);
  } finally {
    for (const context of [trainer, client]) {
      context?.cdp.close();
      await h.terminateChrome(context?.chrome ?? null);
    }
    await nutrition.close();
    await h.close(server);
    await h.removeProfileDirectory(mediaDirectory);
    for (const dir of dirs) await h.removeProfileDirectory(dir);
  }
  console.log('KINETRA_TRAINER_WORKSPACE_BROWSER=PASS');
  console.log('KINETRA_TRAINING_EXPERIENCE_BROWSER=PASS');
};
