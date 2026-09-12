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
  params.delete('signature');

  const checkString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');

  // Порядок именно такой: сначала ключ выводится из строки "WebAppData",
  // и только потом им подписывается сама строка данных.
  const secret = await hmac(enc.encode('WebAppData'), env.BOT_TOKEN);
  const computed = toHex(await hmac(secret, checkString));
  if (!safeEqual(computed, hash)) return null;

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
const PLANS = {
  week: { title: 'Аналитик на неделю', stars: 75, days: 7 },
  month: { title: 'Аналитик на месяц', stars: 250, days: 30 },
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

  // Продление считаем от большей из дат: если пользователь платит, не дождавшись
  // конца оплаченного периода, остаток не должен сгорать.
  const current = await getSubscription(env, userId);
  const base = Math.max(Date.now(), current.until || 0);
  const until = base + plan.days * 86400_000;

  await env.SUBS.put(
    subKey(userId),
    JSON.stringify({
      until,
      plan: planKey,
      // Идентификатор платежа нужен, чтобы можно было вернуть деньги:
      // Telegram требует от ботов возможность возврата Stars по запросу.
      charge_id: charge?.telegram_payment_charge_id ?? null,
      paid_at: Date.now(),
    }),
  );
  return until;
}

const fmtDate = (ts) =>
  new Date(ts).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });

// ------------------------------------------------------------------- API

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // Mini App живёт на github.io, воркер — на workers.dev: без CORS
      // браузер не даст сделать запрос.
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'content-type',
      'cache-control': 'no-store',
    },
  });

async function handleEntitlement(request, env) {
  const body = await request.json().catch(() => ({}));
  const user = await verifyInitData(body.initData, env);
  if (!user) return json({ error: 'invalid initData' }, 401);

  const sub = await getSubscription(env, user.id);
  return json({
    user_id: user.id,
    active: sub.active,
    until: sub.until,
    until_text: sub.until ? fmtDate(sub.until) : null,
    plan: sub.plan ?? null,
    free_daily_limit: FREE_DAILY_LIMIT,
    plans: Object.entries(PLANS).map(([key, p]) => ({
      key, title: p.title, stars: p.stars, days: p.days,
    })),
  });
}

async function handleInvoice(request, env) {
  const body = await request.json().catch(() => ({}));
  const user = await verifyInitData(body.initData, env);
  if (!user) return json({ error: 'invalid initData' }, 401);

  const planKey = String(body.plan || '');
  const plan = PLANS[planKey];
  if (!plan) return json({ error: 'unknown plan' }, 400);

  // createInvoiceLink возвращает ссылку, которую Mini App открывает через
  // Telegram.WebApp.openInvoice — оплата проходит внутри клиента Telegram,
  // и платёжные данные пользователя до нас не доходят вообще.
  const res = await tg(env, 'createInvoiceLink', {
    title: plan.title,
    description:
      'Пакеты билетов с непересекающимися числами, неограниченный подбор ' +
      'и сохранение комбинаций. Вероятность выигрыша не меняется.',
    payload: JSON.stringify({ plan: planKey, uid: user.id }),
    provider_token: '', // для Stars токен провайдера не нужен
    currency: 'XTR',
    prices: [{ label: plan.title, amount: plan.stars }],
  });

  if (!res.ok) return json({ error: 'invoice failed' }, 502);
  return json({ link: res.result, plan: planKey, stars: plan.stars });
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
  const command = message.text.trim().split(/\s+/)[0].split('@')[0].toLowerCase();

  const send = (text, extra = {}) =>
    tg(env, 'sendMessage', { chat_id: chatId, text, ...extra });

  switch (command) {
    case '/start':
      return send(TEXT.start, { reply_markup: appKeyboard(env) });

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

    case '/buy':
      return send(
        'Тарифы. Оплата внутри Telegram, звёздами:\n\n' +
          Object.values(PLANS)
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
      return json({}, 204);
    }
    if (url.pathname === '/health') {
      return new Response('ok');
    }
    if (request.method !== 'POST') {
      return new Response('Этот адрес принимает только POST.', { status: 405 });
    }

    if (url.pathname === '/api/entitlement') return handleEntitlement(request, env);
    if (url.pathname === '/api/invoice') return handleInvoice(request, env);

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
