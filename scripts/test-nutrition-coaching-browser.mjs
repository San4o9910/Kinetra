import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { Server as SocketIOServer } from 'socket.io';
export const nutritionFixture = (h, { studentId, getStudent, getCompleted, photoFile }) => {
  const meals = [],
    templates = [],
    messages = [],
    applications = new Map(),
    conversationId = '00000000-0000-4000-8000-000000000306',
    reads = { client: 0, trainer: 0 };
  let score = null,
    namespace,
    sockets;
  const state = (role) => ({
    last_message_sequence: messages.length,
    own_last_read_sequence: reads[role],
    counterpart_last_read_sequence: reads[role === 'client' ? 'trainer' : 'client'],
    unread_count: messages.filter((m) => m.sender_role !== role && m.sequence > reads[role]).length,
  });
  const project = (m, role) => ({ ...m, is_mine: m.sender_role === role });
  const last = () =>
    messages.length
      ? { kind: 'text', preview: messages.at(-1).text, created_at: messages.at(-1).created_at }
      : null;
  const summary = () => ({
    id: conversationId,
    client: {
      display_name: 'Анна Ученица',
      secondary_label: 'anna@example.test',
      avatar_url: null,
    },
    last_message: last(),
    unread_count: state('trainer').unread_count,
    activity_at: new Date().toISOString(),
  });
  const conversation = () => ({
    id: conversationId,
    trainer: { display_name: 'Мария Тренер', avatar_url: null },
    last_message_sequence: messages.length,
    last_read_sequence: reads.client,
    counterpart_last_read_sequence: reads.trainer,
    unread_count: state('client').unread_count,
  });
  const profile = () => ({
    display_name: 'Мария Тренер',
    active_students: getStudent()?.client_id ? 1 : 0,
    ready_lessons: 1,
    review_count: score ? 1 : 0,
    rating: score,
    level: 'Старт',
    next_level: 'Практик',
  });
  return {
    meals,
    templates,
    messages,
    getScore: () => score,
    conversationId,
    attach(server) {
      sockets = new SocketIOServer(server, {
        cors: { origin: h.frontendOrigin, credentials: true },
        transports: ['websocket'],
      });
      namespace = sockets.of('/chat');
      namespace.use((socket, next) => {
        const role = String(socket.handshake.auth.accessToken ?? '').replace('workspace-', '');
        if (!['client', 'trainer'].includes(role)) return next(new Error('Unauthenticated'));
        socket.data.role = role;
        next();
      });
      namespace.on('connection', (socket) => {
        void socket.join(socket.data.role);
        socket.on('chat:sync', (_event, ack) => ack({ delta_required: false }));
      });
    },
    close() {
      return new Promise((resolve) => sockets.close(resolve));
    },
    async handle(req, res, role) {
      const url = new URL(req.url, h.frontendOrigin),
        p = url.pathname;
      const json = (v, status = 200) => h.json(res, status, v);
      if (p === '/fixture-meal.png') {
        res.writeHead(200, { 'Content-Type': 'image/png' });
        res.end(await readFile(photoFile));
        return true;
      }
      if (p === '/api/v1/chat/session') {
        json(
          role === 'trainer'
            ? {
                role,
                enabled: true,
                photo_uploads_enabled: false,
                profile: { display_name: 'Мария Тренер', avatar_url: null },
                unread_count: state(role).unread_count,
              }
            : {
                role: 'client',
                enabled: true,
                photo_uploads_enabled: false,
                available: !!getStudent()?.client_id,
                conversation: getStudent()?.client_id ? conversation() : null,
              },
        );
        return true;
      }
      if (p === '/api/v1/chat/conversations') {
        if (req.method === 'GET')
          json({ items: getStudent()?.client_id ? [summary()] : [], next_cursor: null });
        else json({ conversation: conversation() }, 201);
        return true;
      }
      if (p === `/api/v1/chat/conversations/${conversationId}`) {
        json({ conversation: summary() });
        return true;
      }
      if (p === `/api/v1/chat/conversations/${conversationId}/messages`) {
        if (req.method === 'GET')
          json({
            messages: messages
              .filter((m) => m.sequence > Number(url.searchParams.get('after_sequence') ?? 0))
              .map((m) => project(m, role)),
            conversation_state: state(role),
            next_before_sequence: null,
            has_more_before: false,
            next_after_sequence: null,
            has_more_after: false,
          });
        else {
          const body = await h.readJsonBody(req);
          assert.equal(body.kind, 'text');
          const m = {
            id: randomUUID(),
            conversation_id: conversationId,
            sequence: messages.length + 1,
            ...body,
            sender_role: role,
            sender_name: role === 'trainer' ? 'Мария Тренер' : 'Анна Ученица',
            photo: null,
            created_at: new Date().toISOString(),
          };
          messages.push(m);
          json(
            { message: project(m, role), conversation_state: state(role), replayed: false },
            201,
          );
          setImmediate(() => {
            for (const recipient of ['client', 'trainer']) {
              namespace.to(recipient).emit('chat:message:new', { message: project(m, recipient) });
              namespace.to(recipient).emit('chat:conversation:updated', {
                conversation_id: conversationId,
                last_message: last(),
                unread_count: state(recipient).unread_count,
              });
            }
          });
        }
        return true;
      }
      if (p.endsWith(`/${conversationId}/read`)) {
        const v = await h.readJsonBody(req);
        reads[role] = v.through_sequence;
        json({ conversation_state: state(role) });
        return true;
      }
      if (p === '/api/v1/training/coach-profile') {
        json(profile());
        return true;
      }
      if (p === '/api/v1/training/my-coach') {
        json({ profile: profile(), score, can_review: getCompleted() });
        return true;
      }
      if (p === '/api/v1/training/my-coach/rating') {
        score = (await h.readJsonBody(req)).score;
        json({ saved: true });
        return true;
      }
      if (
        p === '/api/v1/training/nutrition' ||
        p === `/api/v1/training/students/${studentId}/nutrition`
      ) {
        json({
          entries: meals.filter(
            (m) =>
              m.recorded_date === url.searchParams.get('date') &&
              (role === 'client' || m.share_with_trainer),
          ),
        });
        return true;
      }
      const entry = /^\/api\/v1\/training\/nutrition\/([^/]+)(\/photo|\/sharing)?$/.exec(p);
      if (entry) {
        const [, id, action] = entry,
          existing = meals.find((m) => m.id === id);
        if (action === '/photo') {
          if (req.method === 'GET') json({ path: '/fixture-meal.png' });
          else if (req.method === 'DELETE') {
            existing.photo_id = null;
            json({ saved: true });
          } else {
            for await (const chunk of req) void chunk;
            existing.photo_id = randomUUID();
            json({ saved: true });
          }
        } else if (action === '/sharing') {
          existing.share_with_trainer = (await h.readJsonBody(req)).share;
          existing.revision += 1;
          json({ saved: true });
        } else if (req.method === 'DELETE') {
          meals.splice(meals.indexOf(existing), 1);
          json({ removed: true });
        } else {
          const body = await h.readJsonBody(req);
          assert.equal(body.revision, existing?.revision ?? 0);
          const value = {
            ...body,
            id,
            photo_id: existing?.photo_id ?? null,
            revision: body.revision + 1,
          };
          if (existing) Object.assign(existing, value);
          else meals.push(value);
          json({ id, revision: value.revision });
        }
        return true;
      }
      if (p === '/api/v1/training/nutrition-templates') {
        json({ templates });
        return true;
      }
      const template = /^\/api\/v1\/training\/nutrition-templates\/([^/]+)(\/apply)?$/.exec(p);
      if (template) {
        const [, id, apply] = template;
        if (apply) {
          const body = await h.readJsonBody(req);
          if (!applications.has(body.request_id)) {
            const value = templates.find((t) => t.id === id);
            const added = value.meals.map((m) => ({
              ...structuredClone(m),
              id: randomUUID(),
              recorded_date: body.recorded_date,
              note: '',
              share_with_trainer: body.share_with_trainer,
              photo_id: null,
              revision: 1,
            }));
            meals.push(...added);
            applications.set(
              body.request_id,
              added.map((m) => m.id),
            );
          }
          json({ ids: applications.get(body.request_id) });
        } else if (req.method === 'DELETE') {
          templates.splice(
            templates.findIndex((t) => t.id === id),
            1,
          );
          json({ removed: true });
        } else {
          const body = await h.readJsonBody(req);
          templates.push({ id, ...body });
          json({ id });
        }
        return true;
      }
      return false;
    },
  };
};
export const runNutritionCoachingBrowser = async (
  h,
  trainer,
  client,
  fixture,
  fill,
  clickReady,
  photoFile,
) => {
  const capture = async (context, name) => {
    await context.setViewport(390, 844);
    await context.cdp.evaluate('window.scrollTo(0,0)');
    const shot = await context.cdp.send('Page.captureScreenshot', { format: 'png' });
    await mkdir('artifacts/lesson-sharing', { recursive: true });
    await writeFile(`artifacts/lesson-sharing/${name}.png`, Buffer.from(shot.data, 'base64'));
    if (process.env.KINETRA_CAPTURE_PREVIEW_LOG === 'true')
      console.log('KINETRA_COACHING_PREVIEW=' + JSON.stringify({ name, data: shot.data }));
  };
  await client.navigate('/chat');
  await h.waitFor('chat opens before onboarding', () => client.exists('chat-composer'));
  await client.setValue('chat-message-input', 'Как заменить упражнение?');
  await client.click('chat-send-button');
  await h.waitFor('student message saved', () => fixture.messages.length === 1);
  await trainer.navigate('/trainer/chats/' + fixture.conversationId);
  await h.waitFor('trainer sees student message', async () =>
    (await trainer.bodyText()).includes('Как заменить упражнение?'),
  );
  await trainer.setValue('chat-message-input', 'Пришлю замену в программе.');
  await trainer.click('chat-send-button');
  await h.waitFor('student receives live reply', async () =>
    (await client.bodyText()).includes('Пришлю замену в программе.'),
  );
  assert.equal(
    await client.cdp.evaluate("getComputedStyle(document.querySelector('.tab-bar')).position"),
    'fixed',
  );
  assert.equal(
    await trainer.cdp.evaluate(
      "getComputedStyle(document.querySelector('.trainer-bottom-nav')).position",
    ),
    'fixed',
  );
  for (const [role, context] of [
    ['trainer', trainer],
    ['student', client],
  ]) {
    await context.setViewport(390, 844);
    await context.cdp.evaluate(
      'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))',
    );
    const metrics = await context.cdp.evaluate(`(() => {
      const composer=document.querySelector('[data-testid=chat-composer]').getBoundingClientRect();
      const nav=document.querySelector('.trainer-bottom-nav, .tab-bar').getBoundingClientRect();
      return {composerTop:composer.top, composerBottom:composer.bottom, navTop:nav.top};
    })()`);
    assert.ok(
      metrics.composerBottom <= metrics.navTop + 1 && metrics.composerTop >= 0,
      `${role} chat composer must be visible: ${JSON.stringify(metrics)}`,
    );
  }
  console.log('KINETRA_CHAT_BEFORE_ONBOARDING_ROUNDTRIP_BROWSER=PASS');
  await client.navigate('/nutrition');
  await h.waitFor('nutrition diary', () => client.exists('nutrition-diary'));
  await clickReady(client, '+ Приём пищи');
  await fill(client, 'Продукт 1', 'Рис варёный');
  await fill(client, 'Количество', '150');
  await clickReady(client, 'Сохранить порцию');
  await h.waitFor('portion template persisted', () => fixture.templates.length === 1);
  await fill(client, 'Название шаблона', 'Мой обед');
  await clickReady(client, 'Сохранить приём пищи как шаблон');
  await h.waitFor('meal template persisted', () => fixture.templates.length === 2);
  const doc = await client.cdp.send('DOM.getDocument');
  const input = await client.cdp.send('DOM.querySelector', {
    nodeId: doc.root.nodeId,
    selector: '.nutrition-editor input[type=file]',
  });
  await client.cdp.send('DOM.setFileInputFiles', { nodeId: input.nodeId, files: [photoFile] });
  await clickReady(client, 'Сохранить запись');
  await h.waitFor(
    'private meal and photo persisted',
    () => fixture.meals.length === 1 && fixture.meals[0].photo_id,
  );
  await h.waitFor(
    'meal rendered',
    async () => !(await client.cdp.evaluate("!!document.querySelector('.nutrition-editor')")),
  );
  await clickReady(client, 'Посмотреть фото');
  await h.waitFor('meal photograph visible', () =>
    client.cdp.evaluate("!!document.querySelector('.nutrition-entry img')?.naturalWidth"),
  );
  await capture(client, 'nutrition-mobile');
  await clickReady(client, 'Поделиться с тренером');
  await h.waitFor('meal consent persisted', () => fixture.meals[0].share_with_trainer);
  await trainer.navigate('/trainer/students');
  await h.waitFor('student row', () =>
    trainer.cdp.evaluate("!!document.querySelector('.training-student')"),
  );
  await trainer.cdp.evaluate("document.querySelector('.training-student').click()");
  await h.waitFor('trainer sees shared food', () =>
    trainer.cdp.evaluate(
      "!!document.querySelector('.nutrition-entry')?.textContent.includes('Рис варёный')",
    ),
  );
  await fill(client, 'Название рациона', 'День с тренировкой');
  await clickReady(client, 'Сохранить рацион на день');
  await h.waitFor('ration template persisted', () => fixture.templates.length === 3);
  await client.cdp.evaluate("document.querySelector('.nutrition-templates').open=true");
  const day = fixture.meals[0].recorded_date;
  await clickReady(client, `Добавить в день ${day.split('-').reverse().join('.')}`);
  await h.waitFor(
    'ration copies ingredients privately without photo',
    () => fixture.meals.length === 2,
  );
  assert.equal(fixture.meals[1].share_with_trainer, false);
  assert.equal(fixture.meals[1].photo_id, null);
  await h.waitFor('two food entries rendered after template application', () =>
    client.cdp.evaluate("document.querySelectorAll('.nutrition-entry').length===2"),
  );
  await clickReady(client, 'Закрыть доступ тренеру');
  await h.waitFor('meal consent revoked', () => !fixture.meals[0].share_with_trainer);
  await trainer.navigate('/trainer/students');
  await h.waitFor('student row reload', () =>
    trainer.cdp.evaluate("!!document.querySelector('.training-student')"),
  );
  await trainer.cdp.evaluate("document.querySelector('.training-student').click()");
  await h.waitFor('private food hidden from trainer', () =>
    trainer.cdp.evaluate(
      "document.querySelector('.nutrition-diary')?.textContent.includes('Нет доступных записей')",
    ),
  );
  await trainer.navigate('/trainer/profile');
  await h.waitFor('coach packages', () => trainer.exists('coach-profile'));
  assert.ok(
    (await trainer.bodyText()).includes('1 225') || (await trainer.bodyText()).includes('1 225'),
  );
  await trainer.cdp.evaluate(
    "[...document.querySelectorAll('.coach-packages button')].find(b=>b.textContent.includes('Большая практика')).click()",
  );
  await fill(trainer, 'Мест в большом пакете', '40');
  await fill(trainer, 'Дополнительные места', '2');
  await h.waitFor('large package price', () =>
    trainer.cdp.evaluate(
      "document.querySelector('.coach-quote').textContent.replace(/\\s/g,'').includes('5500')",
    ),
  );
  await capture(trainer, 'coach-profile-mobile');
  for (const context of [trainer, client])
    for (const width of [390, 1280]) {
      await context.setViewport(width, 844);
      assert.equal(
        await context.cdp.evaluate('document.documentElement.scrollWidth<=innerWidth'),
        true,
        'Nutrition and coach screens fit viewport',
      );
    }
  console.log('KINETRA_NUTRITION_TEMPLATES_PHOTOS_PACKAGES_BROWSER=PASS');
};
