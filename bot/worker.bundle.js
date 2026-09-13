// СОБРАННЫЙ ФАЙЛ — НЕ РЕДАКТИРОВАТЬ ВРУЧНУЮ.
//
// Склеен из bot/worker.js и bot/verify.js скриптом bot/build_bundle.py.
// Правки вносите в исходники и пересобирайте, иначе они потеряются при
// следующей сборке.
//
// Этот файл существует ради веб-панели Cloudflare: туда удобно вставить
// ровно один файл. Целиком скопируйте его содержимое в редактор воркера.

// ===== из bot/verify.js =====

/**
 * Проверка подписи initData из Telegram Mini App.
 *
 * Вынесено в отдельный модуль по одной причине: это единственное место, где
 * решается, кто есть кто. Ошибка здесь означает, что подписку можно получить
 * бесплатно, объявив себя чужим id. Поэтому модуль покрыт тестом
 * tests/initdata.test.mjs, который гоняет его на подделанных, просроченных и
 * подписанных чужим токеном данных.
 *
 * Работает и в Cloudflare Workers, и в Node 20+: обе среды дают Web Crypto.
 */

const enc = new TextEncoder();

async function hmac(keyBytes, message) {
  const key = await crypto.subtle.importKey(
    'raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(message)));
}

const toHex = (bytes) =>
  [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

/** Сравнение за постоянное время: обычное === утекает информацию по таймингу. */
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const MAX_INITDATA_AGE_SEC = 24 * 60 * 60;

async function verifyInitData(initData, env) {
  if (!initData || typeof initData !== 'string') return null;

  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');

  const pairs = [...params.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const build = (entries) => entries.map(([k, v]) => `${k}=${v}`).join('\n');

  // Поле signature Telegram добавил позже основного протокола, и клиенты
  // расходятся в том, входит ли оно в подписываемую строку: документация
  // требует убирать только hash, но часть версий считает хэш без signature.
  // Проверяем оба варианта — совпадение любого означает подпись тем же
  // ботом, поэтому строгость проверки от этого не падает.
  const candidates = [build(pairs)];
  if (params.has('signature')) {
    candidates.push(build(pairs.filter(([k]) => k !== 'signature')));
  }

  // Порядок именно такой: сначала ключ выводится из строки "WebAppData",
  // и только потом им подписывается сама строка данных.
  const secret = await hmac(enc.encode('WebAppData'), env.BOT_TOKEN);
  let matched = false;
  for (const checkString of candidates) {
    if (safeEqual(toHex(await hmac(secret, checkString)), hash)) {
      matched = true;
      break;
    }
  }
  if (!matched) return null;

  // Просроченная подпись равнозначна отсутствию подписи: перехваченный
  // однажды initData иначе работал бы вечно.
  const authDate = Number(params.get('auth_date') || 0);
  if (!authDate || Date.now() / 1000 - authDate > MAX_INITDATA_AGE_SEC) return null;

  try {
    const user = JSON.parse(params.get('user') || 'null');
    return user?.id ? user : null;
  } catch {
    return null;
  }
}

// ===== из bot/worker.js =====
/**
 * Телеграм-бот и платёжный бэкенд на Cloudflare Workers (бесплатный тариф,
 * свой HTTPS-домен *.workers.dev — покупать ничего не нужно).
 *
 * Оплата — Telegram Stars (валюта XTR). Это не выбор из удобства: Telegram
 * требует продавать цифровые товары и услуги внутри ботов и Mini App только
 * за Stars, чтобы соблюсти правила Apple и Google. ЮKassa и прочие провайдеры
 * разрешены исключительно для физических товаров, а подписка на аналитику —
 * цифровая услуга. Плюс Stars не требуют ни юрлица, ни договора с банком.
 *
 * Что здесь есть:
 *   POST /api/entitlement  — есть ли у пользователя активная подписка
 *   POST /api/invoice      — ссылка на оплату для Telegram.WebApp.openInvoice
 *   POST /api/cancel       — отменить свою подписку (без возврата звёзд)
 *   POST /  (вебхук)       — команды бота и обработка платежей
 *
 * Секреты (wrangler secret put ИМЯ или через панель Cloudflare):
 *   BOT_TOKEN        — токен от BotFather
 *   WEBHOOK_SECRET   — произвольная строка, ею Telegram подписывает вебхуки
 * Переменные [vars]:
 *   MINIAPP_URL, DONATE_URL
 * Хранилище [[kv_namespaces]]:
 *   SUBS — кто и до какого момента оплатил
 */


// Тарифы. Ключ уходит в payload инвойса, поэтому менять его после запуска
// нельзя — иначе уже отправленные, но не оплаченные счета перестанут узнаваться.
//
// hidden: тариф не показывается в приложении и в ответе на /buy, но счёт по
// нему создать можно. Нужен, чтобы проверять всю цепочку оплаты за одну
// звезду, не показывая такую цену покупателям.
const PLANS = {
  test: { title: 'Проверка оплаты', stars: 1, days: 1, hidden: true },
  week: { title: 'Аналитик на неделю', stars: 75, days: 7 },
  month: { title: 'Аналитик на месяц', stars: 250, days: 30 },
  year: { title: 'Аналитик на год', stars: 1990, days: 365 },
};

const FREE_DAILY_LIMIT = 1;

const TEXT = {
  start:
    'Это лотерейный аналитик.\n\n' +
    'Он не предсказывает результаты тиражей — предсказать их невозможно, ' +
    'и внутри есть вкладка «Проверка», где это измерено на реальных данных.\n\n' +
    'Что он делает вместо этого: считает, насколько часто вашу комбинацию ' +
    'выбирают другие игроки. Джекпот делится между всеми, кто угадал, ' +
    'поэтому комбинация, которую не поставил больше никто, при выигрыше ' +
    'приносит больше денег. Шанс выиграть при этом не меняется.',
  help:
    'Команды:\n' +
    '/start — открыть аналитику\n' +
    '/buy — оформить подписку\n' +
    '/status — до какого числа оплачено\n' +
    '/cancel — отменить подписку\n' +
    '/invite — пригласить друга и получить дни подписки\n' +
    '/honest — почему предсказать тираж нельзя\n' +
    '/help — это сообщение',
  honest:
    'Коротко: шар не помнит прошлых тиражей.\n\n' +
    'Модель, обученная на всех прошлых тиражах, сходится ровно к «все ' +
    'комбинации равновероятны» — 1 к 8 145 060 для «6 из 45». Мы обучили ' +
    'несколько моделей, включая градиентный бустинг, и проверили их на ' +
    'тиражах, которых они не видели. Ни одна не обошла случайный выбор ' +
    '(0,8 совпадения на тираж). Таблица с результатами — во вкладке ' +
    '«Проверка», код проверки открыт.\n\n' +
    'Если кто-то продаёт вам «числа на завтра» — он продаёт случайные числа.',
  unknown: 'Не знаю такой команды. Попробуйте /help',
};

// ---------------------------------------------------------------- Telegram

async function tg(env, method, payload) {
  const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload ?? {}),
  });
  const data = await res.json().catch(() => ({ ok: false }));
  if (!data.ok) console.error(`${method} failed`, JSON.stringify(data));
  return data;
}

const appKeyboard = (env) => ({
  inline_keyboard: [[{ text: 'Открыть аналитику', web_app: { url: env.MINIAPP_URL } }]],
});

// ------------------------------------------------------------- подписки

const subKey = (userId) => `sub:${userId}`;

async function getSubscription(env, userId) {
  const raw = await env.SUBS?.get(subKey(userId));
  if (!raw) return { active: false, until: null };
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return { active: false, until: null };
  }
  const until = Number(data.until || 0);
  return { active: until > Date.now(), until, plan: data.plan };
}

async function grantSubscription(env, userId, planKey, charge) {
  const plan = PLANS[planKey];
  if (!plan) throw new Error(`неизвестный тариф: ${planKey}`);
  return addDays(env, userId, plan.days, {
    plan: planKey,
    // Идентификатор платежа нужен, чтобы можно было вернуть деньги:
    // Telegram требует от ботов возможность возврата Stars по запросу.
    charge_id: charge?.telegram_payment_charge_id ?? null,
    paid_at: Date.now(),
  });
}

/**
 * Продлевает доступ на days дней. Продление считаем от большей из дат: если
 * пользователь платит или получает бонус до конца периода, остаток не сгорает.
 *
 * Прежние поля записи сохраняются: бонус за приглашение не должен затирать
 * charge_id оплаты, иначе вернуть по ней звёзды станет нечем.
 */
async function addDays(env, userId, days, fields = {}) {
  let current = {};
  try {
    current = JSON.parse((await env.SUBS.get(subKey(userId))) || '{}');
  } catch { /* битая запись — начинаем заново */ }
  const base = Math.max(Date.now(), Number(current.until || 0));
  const until = base + days * 86400_000;
  const next = { ...current, ...fields, until };
  if (fields.charge_id === null && current.charge_id) next.charge_id = current.charge_id;
  delete next.cancelled_at;
  await env.SUBS.put(subKey(userId), JSON.stringify(next));
  return until;
}

// ------------------------------------------------------------ рефералка

// Сколько дней получают оба — пригласивший и новичок, и сколько друзей
// засчитывается одному человеку. Потолок нужен против накрутки фейковыми
// аккаунтами: без него неделя подписки стоила бы пять регистраций.
const REF_BONUS_DAYS = 3;
const REF_MAX_FRIENDS = 10;

let botUsername = null;
async function getBotUsername(env) {
  if (botUsername) return botUsername;
  const me = await tg(env, 'getMe');
  botUsername = me.ok ? me.result.username : null;
  return botUsername;
}

async function referralInfo(env, userId) {
  const username = await getBotUsername(env);
  const invited = Number((await env.SUBS?.get(`ref:count:${userId}`)) || 0);
  return {
    link: username ? `https://t.me/${username}?start=ref_${userId}` : null,
    invited,
    bonus_days: REF_BONUS_DAYS,
    max_friends: REF_MAX_FRIENDS,
  };
}

/**
 * Пользователь пришёл в бота. Отмечаем его как известного и, если он пришёл
 * по чужой ссылке впервые, начисляем бонус обоим.
 *
 * Новичком считается только тот, кого бот раньше не видел и у кого нет записи
 * о подписке: иначе старый пользователь мог бы «прийти по ссылке» друга.
 */
async function registerVisit(env, userId, payload) {
  if (!env.SUBS || !userId) return null;
  const seenKey = `seen:${userId}`;
  const known = (await env.SUBS.get(seenKey)) || (await env.SUBS.get(subKey(userId)));
  if (known) return null;
  await env.SUBS.put(seenKey, String(Date.now()));

  const refId = Number(/^ref_(\d+)$/.exec(payload || '')?.[1] || 0);
  if (!refId || refId === userId) return null;

  const countKey = `ref:count:${refId}`;
  const count = Number((await env.SUBS.get(countKey)) || 0);
  await env.SUBS.put(`ref:by:${userId}`, String(refId));
  if (count >= REF_MAX_FRIENDS) return { rewarded: false };

  await env.SUBS.put(countKey, String(count + 1));
  await addDays(env, refId, REF_BONUS_DAYS, { plan: 'referral' });
  await addDays(env, userId, REF_BONUS_DAYS, { plan: 'referral' });
  await tg(env, 'sendMessage', {
    chat_id: refId,
    text: `По вашей ссылке пришёл новый пользователь — вам +${REF_BONUS_DAYS} дня подписки. ` +
      `Приглашено: ${count + 1} из ${REF_MAX_FRIENDS}.`,
  });
  return { rewarded: true };
}

/**
 * Отмена подписки по желанию пользователя, без возврата звёзд: доступ
 * заканчивается сразу. Запись не удаляем, а закрываем датой — charge_id
 * должен остаться, чтобы возврат по запросу был возможен и потом.
 */
async function cancelSubscription(env, userId) {
  const raw = await env.SUBS?.get(subKey(userId));
  if (!raw) return false;
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return false;
  }
  if (Number(data.until || 0) <= Date.now()) return false;
  await env.SUBS.put(
    subKey(userId),
    JSON.stringify({ ...data, until: Date.now(), cancelled_at: Date.now() }),
  );
  return true;
}

const fmtDate = (ts) =>
  new Date(ts).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });

// ------------------------------------------------------------------- API

// Mini App живёт на github.io, воркер — на workers.dev. Это разные источники,
// поэтому браузер сначала шлёт preflight-запрос OPTIONS и пропускает POST
// только если в ответе перечислены и разрешённые методы, и заголовки.
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'access-control-max-age': '86400',
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...CORS,
      'cache-control': 'no-store',
    },
  });

/** Ответ на preflight. Статус 204 запрещает тело: с телом Response падает. */
const preflight = () => new Response(null, { status: 204, headers: CORS });

async function handleEntitlement(request, env) {
  const body = await request.json().catch(() => ({}));
  const user = await verifyInitData(body.initData, env);
  if (!user) return json({ error: 'invalid initData' }, 401);

  // Открыл приложение, минуя /start, — всё равно запоминаем, чтобы потом не
  // засчитать его новичком по чужой ссылке.
  await registerVisit(env, user.id, null);
  const sub = await getSubscription(env, user.id);

  // Ссылки на оплату готовим заранее, вместе с ответом о подписке. Если
  // запрашивать их в момент нажатия, любой сбой сети именно в эту секунду
  // оставляет пользователя с ошибкой вместо оплаты — а мобильный webview
  // как раз в этот момент уходит в фон под платёжный экран.
  const plans = await Promise.all(
    Object.entries(PLANS).filter(([, p]) => !p.hidden).map(async ([key, p]) => ({
      key,
      title: p.title,
      stars: p.stars,
      days: p.days,
      link: sub.active ? null : await createInvoiceLink(env, key, user.id),
    })),
  );

  return json({
    user_id: user.id,
    active: sub.active,
    until: sub.until,
    until_text: sub.until ? fmtDate(sub.until) : null,
    plan: sub.plan ?? null,
    free_daily_limit: FREE_DAILY_LIMIT,
    plans,
    referral: await referralInfo(env, user.id),
  });
}

/**
 * Ссылка на оплату для Telegram.WebApp.openInvoice. Оплата проходит внутри
 * клиента Telegram, платёжные данные пользователя до нас не доходят.
 *
 * Возвращает null вместо исключения: несозданная ссылка одного тарифа не
 * должна ронять весь ответ о подписке.
 */
async function createInvoiceLink(env, planKey, userId) {
  const plan = PLANS[planKey];
  if (!plan) return null;
  try {
    const res = await tg(env, 'createInvoiceLink', {
      title: plan.title,
      description:
        'Пакеты билетов с непересекающимися числами, неограниченный подбор ' +
        'и сохранение комбинаций. Вероятность выигрыша не меняется.',
      payload: JSON.stringify({ plan: planKey, uid: userId }),
      provider_token: '', // для Stars токен провайдера не нужен
      currency: 'XTR',
      prices: [{ label: plan.title, amount: plan.stars }],
    });
    return res.ok ? res.result : null;
  } catch (err) {
    console.error('createInvoiceLink failed', err);
    return null;
  }
}

async function handleCancel(request, env) {
  const body = await request.json().catch(() => ({}));
  const user = await verifyInitData(body.initData, env);
  if (!user) return json({ error: 'invalid initData' }, 401);
  const cancelled = await cancelSubscription(env, user.id);
  return json({ cancelled });
}

async function handleInvoice(request, env) {
  const body = await request.json().catch(() => ({}));
  const user = await verifyInitData(body.initData, env);
  if (!user) return json({ error: 'invalid initData' }, 401);

  const planKey = String(body.plan || '');
  const plan = PLANS[planKey];
  if (!plan) return json({ error: 'unknown plan' }, 400);

  const link = await createInvoiceLink(env, planKey, user.id);
  if (!link) {
    // Пустая ссылка означает отказ Telegram — причина уходит в логи воркера.
    return json({ error: 'Telegram не выдал ссылку на счёт' }, 502);
  }
  return json({ link, plan: planKey, stars: plan.stars });
}

// --------------------------------------------------------------- вебхук

async function handleUpdate(update, env) {
  // Последний шанс отменить платёж. Ответить обязательно в течение 10 секунд,
  // иначе Telegram отменит его сам.
  if (update.pre_checkout_query) {
    const q = update.pre_checkout_query;
    let ok = false;
    try {
      ok = Boolean(PLANS[JSON.parse(q.invoice_payload).plan]);
    } catch { /* битый payload — не подтверждаем */ }
    return tg(env, 'answerPreCheckoutQuery', {
      pre_checkout_query_id: q.id,
      ok,
      ...(ok ? {} : { error_message: 'Тариф больше недоступен. Откройте /buy заново.' }),
    });
  }

  const message = update.message;
  if (!message) return;
  const chatId = message.chat.id;
  const userId = message.from?.id;

  if (message.successful_payment) {
    const pay = message.successful_payment;
    let planKey = null;
    try {
      planKey = JSON.parse(pay.invoice_payload).plan;
    } catch { /* см. ниже */ }

    if (!PLANS[planKey]) {
      console.error('оплата с неизвестным payload', pay.invoice_payload);
      return tg(env, 'sendMessage', {
        chat_id: chatId,
        text: 'Платёж получен, но тариф не распознан. Напишите нам — вернём Stars.',
      });
    }
    const until = await grantSubscription(env, userId, planKey, pay);
    return tg(env, 'sendMessage', {
      chat_id: chatId,
      text: `Оплачено до ${fmtDate(until)}. Спасибо!\n\n` +
        'Напоминаю то, за что вы НЕ платили: шанс выиграть не изменился и ' +
        'измениться не может. Вы платите за подбор комбинаций, которые не ' +
        'ставит никто, — это влияет на размер выплаты, а не на вероятность.',
      reply_markup: appKeyboard(env),
    });
  }

  if (!message.text) return;
  const [head, payload] = message.text.trim().split(/\s+/);
  const command = head.split('@')[0].toLowerCase();

  const send = (text, extra = {}) =>
    tg(env, 'sendMessage', { chat_id: chatId, text, ...extra });

  switch (command) {
    case '/start': {
      const ref = await registerVisit(env, userId, payload);
      const bonus = ref?.rewarded
        ? `\n\nВы пришли по приглашению — вам +${REF_BONUS_DAYS} дня подписки в подарок.`
        : '';
      return send(TEXT.start + bonus, { reply_markup: appKeyboard(env) });
    }

    case '/invite': {
      const info = await referralInfo(env, userId);
      if (!info.link) return send('Не удалось получить ссылку, попробуйте позже.');
      return send(
        `Ваша ссылка-приглашение:\n${info.link}\n\n` +
          `За каждого нового друга — +${info.bonus_days} дня подписки вам и ему. ` +
          `Засчитывается до ${info.max_friends} друзей, уже приглашено: ${info.invited}.`,
      );
    }

    case '/honest':
      return send(TEXT.honest, { reply_markup: appKeyboard(env) });

    case '/help':
      return send(TEXT.help);

    case '/status': {
      const sub = await getSubscription(env, userId);
      return send(
        sub.active
          ? `Подписка активна до ${fmtDate(sub.until)}.`
          : 'Подписки нет. Бесплатно доступна одна комбинация в день, /buy — снять ограничение.',
        { reply_markup: appKeyboard(env) },
      );
    }

    case '/cancel': {
      const sub = await getSubscription(env, userId);
      if (!sub.active) return send('Активной подписки нет — отменять нечего.');
      return send(
        `Подписка активна до ${fmtDate(sub.until)}.\n\n` +
          'После отмены доступ закончится сразу, звёзды не возвращаются. ' +
          'Чтобы подтвердить, отправьте /cancel_confirm',
      );
    }

    case '/cancel_confirm': {
      const cancelled = await cancelSubscription(env, userId);
      return send(cancelled
        ? 'Подписка отменена. Доступ закрыт, звёзды не возвращались.'
        : 'Активной подписки нет — отменять нечего.');
    }

    case '/buy':
      return send(
        'Тарифы. Оплата внутри Telegram, звёздами:\n\n' +
          Object.values(PLANS)
            .filter((p) => !p.hidden)
            .map((p) => `${p.title} — ${p.stars} ⭐`)
            .join('\n') +
          '\n\nОткройте приложение и нажмите «Подписка» — оплата пройдёт там.',
        { reply_markup: appKeyboard(env) },
      );

    default:
      return send(TEXT.unknown);
  }
}

// ------------------------------------------------------------------ вход

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return preflight();
    }
    if (url.pathname === '/health') {
      // Отдаём только факты наличия, никаких значений: по этому ответу видно,
      // пережили ли публикацию привязка хранилища и секреты, но сами секреты
      // не утекают.
      return json({
        ok: true,
        // Метка сборки. Нужна, чтобы отличать «опубликовалось» от
        // «опубликовалось, но до боевого адреса не доехало»: без неё обе
        // ситуации выглядят одинаково.
        build: 'referral-v1',
        plans: Object.keys(PLANS),
        kv_subs: Boolean(env.SUBS),
        bot_token: Boolean(env.BOT_TOKEN),
        webhook_secret: Boolean(env.WEBHOOK_SECRET),
        miniapp_url: env.MINIAPP_URL || null,
        donate_url: env.DONATE_URL || null,
      });
    }
    if (request.method !== 'POST') {
      return new Response('Этот адрес принимает только POST.', { status: 405 });
    }

    const api = {
      '/api/entitlement': handleEntitlement,
      '/api/invoice': handleInvoice,
      '/api/cancel': handleCancel,
    }[url.pathname];
    if (api) {
      // Без этого перехвата сбой внутри обработчика уходит наружу как ответ
      // Cloudflare без заголовков CORS, и браузер сообщает «Load failed», не
      // показывая ни кода, ни причины.
      try {
        return await api(request, env);
      } catch (err) {
        console.error(`${url.pathname} failed`, err);
        return json({ error: 'internal', detail: String(err && err.message) }, 500);
      }
    }

    // Дальше — только вебхук Telegram. Заголовок с секретом подтверждает, что
    // апдейт действительно от Telegram, а не подделан кем угодно.
    if (
      env.WEBHOOK_SECRET &&
      request.headers.get('x-telegram-bot-api-secret-token') !== env.WEBHOOK_SECRET
    ) {
      return new Response('forbidden', { status: 403 });
    }

    let update;
    try {
      update = await request.json();
    } catch {
      return new Response('bad json', { status: 400 });
    }

    try {
      await handleUpdate(update, env);
    } catch (err) {
      console.error('handleUpdate failed', err);
    }

    // Всегда 200: иначе Telegram будет повторять тот же апдейт по кругу.
    return new Response('ok');
  },
};
