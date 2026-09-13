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

import { verifyInitData } from './verify.js';

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
        build: 'plans-v2',
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

    if (url.pathname === '/api/entitlement' || url.pathname === '/api/invoice') {
      // Без этого перехвата сбой внутри обработчика уходит наружу как ответ
      // Cloudflare без заголовков CORS, и браузер сообщает «Load failed», не
      // показывая ни кода, ни причины.
      try {
        return url.pathname === '/api/invoice'
          ? await handleInvoice(request, env)
          : await handleEntitlement(request, env);
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
