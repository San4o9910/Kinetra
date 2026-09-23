import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// This fixture exercises UI requests and state transitions. Authorization,
// moderation and immutable public snapshots are checked against PostgreSQL.
export const marketplaceFixture = (h, trainerId) => {
  let profile = null;
  const offers = new Map();
  const publicProfile = () =>
    profile?.is_listed
      ? {
          ...profile.published,
          id: trainerId,
          rating: null,
          review_count: 0,
        }
      : null;
  const publicOffers = () =>
    !publicProfile()
      ? []
      : [...offers.values()]
          .filter((o) => o.is_listed)
          .map((o) => ({
            ...o.published,
            id: o.id,
            trainer_id: trainerId,
            trainer_name: profile.published.display_name,
          }));
  return {
    offers,
    getProfile: () => profile,
    publish() {
      for (const row of [profile, ...offers.values()]) {
        assert.equal(row.review_state, 'pending');
        row.published = structuredClone(row.draft);
        row.is_listed = true;
        row.review_state = 'approved';
        row.revision++;
      }
    },
    async handle(req, res, role) {
      const url = new URL(req.url, h.frontendOrigin);
      const publicPath = '/api/v1/marketplace';
      const ownerPath = '/api/v1/training/marketplace';
      if (url.pathname.startsWith(publicPath)) {
        const p = publicProfile(),
          items = publicOffers();
        if (url.pathname === publicPath + '/') {
          const q = url.searchParams.get('q') ?? '';
          h.json(res, 200, {
            trainers: p && (!q || p.display_name.includes(q)) ? [p] : [],
            offers: items.filter((o) => !q || o.title.includes(q)),
            disciplines: p ? p.disciplines : [],
            page: 1,
            page_size: 24,
            has_more: false,
            purchases_enabled: false,
          });
        } else if (url.pathname === publicPath + '/coaches/' + trainerId && p) {
          h.json(res, 200, { profile: p, offers: items, purchases_enabled: false });
        } else {
          const offer = items.find((o) => url.pathname === publicPath + '/offers/' + o.id);
          h.json(
            res,
            offer ? 200 : 404,
            offer
              ? { offer, purchases_enabled: false }
              : { error: { message: 'Предложение недоступно' } },
          );
        }
        return true;
      }
      if (!url.pathname.startsWith(ownerPath)) return false;
      assert.equal(role, 'trainer');
      const suffix = url.pathname.slice(ownerPath.length);
      if (suffix === '/workspace') {
        h.json(res, 200, { profile, offers: [...offers.values()], purchases_enabled: false });
        return true;
      }
      const isProfile = suffix.startsWith('/profile');
      const id = isProfile ? trainerId : suffix.split('/')[2];
      const previous = isProfile ? profile : offers.get(id);
      const body = await h.readJsonBody(req);
      if (req.method === 'PUT') {
        assert.equal(body.revision, previous?.revision ?? 0);
        const row = {
          ...previous,
          id,
          trainer_id: trainerId,
          draft: body.draft,
          revision: body.revision + 1,
          review_state: 'draft',
          review_note: '',
          is_listed: previous?.is_listed ?? false,
          published: previous?.published ?? null,
        };
        if (isProfile) profile = row;
        else offers.set(id, row);
        h.json(res, 200, row);
      } else if (suffix.endsWith('/submit')) {
        assert.equal(body.revision, previous.revision);
        previous.review_state = 'pending';
        h.json(res, 200, { saved: true });
      } else {
        throw new Error('Unexpected marketplace fixture request: ' + req.method + ' ' + suffix);
      }
      return true;
    },
  };
};

export const runMarketplaceBrowser = async (h, trainer, fixture, fill, clickReady) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'kinetra-browser-'));
  let guest;
  const screenshot = async (context, name) => {
    await mkdir('artifacts/marketplace', { recursive: true });
    const shot = await context.cdp.send('Page.captureScreenshot', { format: 'png' });
    await writeFile(`artifacts/marketplace/${name}.png`, Buffer.from(shot.data, 'base64'));
  };
  try {
    guest = await h.launchT12BrowserContext(dir, 390, 844);
    await h.waitFor('fresh guest login loaded', () => guest.exists('login-screen'));
    await guest.navigate('/catalog');
    await h.waitFor('guest empty catalogue', () => guest.exists('market-catalogue'));
    await h.waitFor(
      'empty catalogue response',
      async () => !(await guest.bodyText()).includes('Загружаем'),
    );
    assert.equal(await guest.exists('login-screen'), false);
    assert.equal(await guest.cdp.evaluate('document.querySelectorAll(".market-card").length'), 0);
    await trainer.navigate('/trainer/marketplace');
    await clickReady(trainer, 'Создать витрину');
    await fill(trainer, 'Имя на витрине', 'Мария Тестовая');
    await fill(trainer, 'Чем вы помогаете', 'Плавание для взрослых');
    await fill(trainer, 'О себе и опыте', 'Тестовое описание опыта');
    await fill(trainer, 'Ваш подход', 'Постепенное освоение техники');
    await clickReady(trainer, 'Сохранить черновик');
    await h.waitFor('profile saved', () => fixture.getProfile()?.revision === 1);
    await clickReady(trainer, 'На проверку');
    await h.waitFor('profile submitted', () => fixture.getProfile()?.review_state === 'pending');
    await clickReady(trainer, '+ Предложение');
    await h.waitFor('offer created', () => fixture.offers.size === 1);
    await h.waitFor('offer editor', async () =>
      (await trainer.bodyText()).includes('Коротко о результате'),
    );
    await fill(trainer, 'Название', 'Техника кроля — тест');
    await fill(trainer, 'Коротко о результате', 'Программа освоения техники');
    await fill(trainer, 'Кому подходит', 'Умеющим держаться на воде');
    await clickReady(trainer, 'Далее →');
    await fill(trainer, 'Подробное описание', 'Четыре недели упражнений');
    await fill(trainer, 'Что входит', 'Восемь самостоятельных тренировок');
    await fill(trainer, 'Открытый текстовый образец', 'Четыре отрезка по 25 м');
    await clickReady(trainer, 'Далее →');
    await fill(trainer, 'Как проходит обратная связь', 'Самостоятельная работа');
    await clickReady(trainer, 'Далее →');
    await fill(trainer, 'Цена, ₽', '2490.50');
    await fill(trainer, 'Когда и как', 'После назначения программы');
    await fill(trainer, 'Условия отмены', 'Свяжитесь с тренером до начала программы');
    await clickReady(trainer, 'Далее →');
    assert.ok((await trainer.bodyText()).includes('Четыре отрезка по 25 м'));
    await trainer.setViewport(390, 844);
    assert.equal(
      await trainer.cdp.evaluate('document.documentElement.scrollWidth<=innerWidth'),
      true,
    );
    await screenshot(trainer, 'offer-preview-mobile');
    await clickReady(trainer, 'Сохранить черновик');
    const row = () => [...fixture.offers.values()][0];
    await h.waitFor('offer saved', () => row()?.revision === 2);
    assert.equal(row().draft.price_kopecks, 249050);
    await h.waitFor('saved offer submit button', () =>
      trainer.cdp.evaluate(
        '[...document.querySelectorAll("[data-market-offer] button")].some(b => b.textContent.trim() === "На проверку" && !b.disabled)',
      ),
    );
    await trainer.cdp.evaluate(
      '[...document.querySelectorAll("[data-market-offer] button")].find(b => b.textContent.trim() === "На проверку" && !b.disabled).click()',
    );
    await h.waitFor('offer submitted', () => row().review_state === 'pending');
    await guest.navigate('/offers/' + row().id);
    await h.waitFor('draft is not public', async () =>
      (await guest.bodyText()).includes('Предложение недоступно'),
    );

    fixture.publish();
    await guest.navigate('/catalog');
    await h.waitFor('published profile appears', async () =>
      (await guest.bodyText()).includes('Мария Тестовая'),
    );
    await screenshot(guest, 'catalogue-mobile');
    await fill(guest, 'Поиск', 'Неизвестный тренер');
    await clickReady(guest, 'Найти');
    await h.waitFor(
      'filter returns empty',
      async () => await guest.cdp.evaluate('document.querySelectorAll(".market-card").length===0'),
    );
    await clickReady(guest, 'Сбросить');
    await h.waitFor(
      'filter reset',
      async () =>
        await guest.cdp.evaluate(
          'document.querySelector("input[name=q]").value==="" && document.querySelectorAll(".market-card").length===1',
        ),
    );
    await clickReady(guest, 'Предложения');
    await guest.cdp.evaluate('document.querySelector(".market-card").click()');
    await h.waitFor('public offer page', async () =>
      (await guest.bodyText()).includes('Оформление покупок ещё не открыто'),
    );
    assert.ok((await guest.bodyText()).includes('Техника кроля — тест'));
    for (const width of [390, 1280]) {
      await guest.setViewport(width, 844);
      assert.equal(
        await guest.cdp.evaluate('document.documentElement.scrollWidth<=innerWidth'),
        true,
      );
      await screenshot(guest, 'offer-' + width);
    }
    await clickReady(guest, 'Войти');
    await h.waitFor('login from selected offer', () => guest.exists('login-screen'));
    await guest.setValue('login-identifier', 'student@example.test');
    await guest.setValue('login-password', 'K7m9Q2');
    await guest.click('login-submit');
    await h.waitFor(
      'login returns to the selected offer',
      async () =>
        (await guest.pathname()) === '/offers/' + row().id &&
        (await guest.bodyText()).includes('К занятиям'),
    );
    console.log('KINETRA_MARKETPLACE_CATALOGUE_BROWSER=PASS');
  } finally {
    guest?.cdp.close();
    await h.terminateChrome(guest?.chrome ?? null);
    await h.removeProfileDirectory(dir);
  }
};
