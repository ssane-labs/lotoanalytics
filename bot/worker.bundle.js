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
 * Модель монетизации — прокрутки, а не подписка. Прокрутка это одно действие:
 * подобранная комбинация или половина разбора своей (разбор стоит две).
 * Подписка здесь не работала по существу: человек заходит раз в неделю перед
 * тиражом, и платить за тридцать дней доступа ему незачем. Прокрутки же
 * покупаются ровно под то, чем пользуются, и не сгорают.
 *
 * Откуда берутся прокрутки:
 *   — одна бесплатная каждый день;
 *   — до пяти в неделю за просмотр рекламного ролика (Adsgram);
 *   — пакетами за Telegram Stars.
 *
 * Оплата — Telegram Stars (валюта XTR). Это не выбор из удобства: Telegram
 * требует продавать цифровые товары и услуги внутри ботов и Mini App только
 * за Stars, чтобы соблюсти правила Apple и Google. ЮKassa и прочие провайдеры
 * разрешены исключительно для физических товаров.
 *
 * Что здесь есть:
 *   POST /api/state       — баланс прокруток, лимиты, пакеты, ссылки на оплату
 *   POST /api/spend       — списать прокрутки (решает сервер, не клиент)
 *   POST /api/ad-claim    — начислить прокрутку за досмотренный ролик
 *   GET  /api/ad-reward   — то же, но вызовом самой рекламной сети
 *   POST /api/invoice     — ссылка на оплату для Telegram.WebApp.openInvoice
 *   POST /  (вебхук)      — команды бота и обработка платежей
 *
 * Секреты (wrangler secret put ИМЯ или через панель Cloudflare):
 *   BOT_TOKEN        — токен от BotFather
 *   WEBHOOK_SECRET   — произвольная строка, ею Telegram подписывает вебхуки
 *   AD_REWARD_SECRET — произвольная строка для callback рекламной сети
 * Переменные [vars]:
 *   MINIAPP_URL, DONATE_URL, ADMIN_IDS, ADSGRAM_BLOCK_ID
 * Хранилище [[kv_namespaces]]:
 *   SUBS — кошельки пользователей (имя осталось от версии с подписками)
 */


// Пакеты прокруток. Ключ уходит в payload инвойса, поэтому менять его после
// запуска нельзя — иначе уже отправленные, но не оплаченные счета перестанут
// узнаваться. Цена за прокрутку падает с размером пакета: это и есть причина
// брать больше одной.
//
// hidden: пакет не показывается в приложении и в ответе на /buy, но счёт по
// нему создать можно. Нужен, чтобы проверять всю цепочку оплаты за одну
// звезду, не показывая такую цену покупателям.
const PACKS = {
  test: { title: 'Проверка оплаты', spins: 1, stars: 1, hidden: true },
  p1: { title: '1 прокрутка', spins: 1, stars: 30 },
  p5: { title: '5 прокруток', spins: 5, stars: 125 },
  p10: { title: '10 прокруток', spins: 10, stars: 200 },
};

const ECONOMY = {
  /** Бесплатных прокруток в сутки. */
  FREE_PER_DAY: 1,
  /** Сколько прокруток в неделю можно получить за рекламу. */
  ADS_PER_WEEK: 5,
  /** Прокруток за один досмотренный ролик. */
  AD_REWARD: 1,
  /** Одна подобранная комбинация. */
  COST_PER_TICKET: 1,
  /** Разбор своей комбинации. */
  COST_CHECK: 2,
};

// Сколько прокруток получают оба — пригласивший и новичок, и сколько друзей
// засчитывается одному человеку. Потолок нужен против накрутки фейковыми
// аккаунтами.
const REF_BONUS_SPINS = 3;
const REF_MAX_FRIENDS = 10;

// Компенсация тем, у кого на момент перехода была оплачена подписка. Считаем
// щедро и один раз: обменять оплаченные дни на прокрутки обязаны мы, а не
// пользователь — он платил за другое.
const MIGRATION_SPINS = 15;

const TEXT = {
  start:
    'Лотерейный аналитик для «6 из 45», «7 из 49», «4 из 20», «5 из 36» ' +
    'и «Большого Спортлото».\n\n' +
    'Суперприз делится между всеми, кто угадал. Аналитик оценивает, сколько ' +
    'человек ставят те же числа, что и вы, и подбирает комбинации, которые ' +
    'ставят реже всего, — чтобы при выигрыше суперприз достался вам целиком. ' +
    'Модель обучена на итогах тиражей Столото.\n\n' +
    'Одна прокрутка каждый день бесплатно.',
  help:
    'Команды:\n' +
    '/start — открыть аналитику\n' +
    '/spins — сколько прокруток на балансе\n' +
    '/buy — пакеты прокруток\n' +
    '/invite — позвать друга и получить прокрутки\n' +
    '/refund — вернуть звёзды за последнюю покупку (48 часов)\n' +
    '/help — это сообщение',
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

// ---------------------------------------------------------- периоды

/** Сутки и недели считаем по Москве: аудитория и тиражи живут в этом времени. */
const MSK_SHIFT_MS = 3 * 3600 * 1000;

function dayKey(now = Date.now()) {
  return new Date(now + MSK_SHIFT_MS).toISOString().slice(0, 10);
}

function weekKey(now = Date.now()) {
  const d = new Date(now + MSK_SHIFT_MS);
  d.setUTCHours(0, 0, 0, 0);
  // Четверг той же недели однозначно задаёт её год и номер.
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((d.getTime() - yearStart) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

// ---------------------------------------------------------- кошелёк

const walletKey = (userId) => `sp:${userId}`;
const legacyKey = (userId) => `sub:${userId}`;

const emptyWallet = () => ({
  paid: 0,
  bonus: 0,
  free_day: dayKey(),
  free_used: 0,
  ads_week: weekKey(),
  ads_used: 0,
});

/**
 * Обнуляет счётчики, у которых закончился период. Бесплатная прокрутка не
 * копится: не пришёл вчера — вчерашняя сгорела. Купленные и заработанные
 * рекламой не сгорают никогда.
 */
function refreshPeriods(rec) {
  const today = dayKey();
  if (rec.free_day !== today) {
    rec.free_day = today;
    rec.free_used = 0;
  }
  const week = weekKey();
  if (rec.ads_week !== week) {
    rec.ads_week = week;
    rec.ads_used = 0;
  }
  return rec;
}

async function readWallet(env, userId) {
  let rec;
  try {
    rec = JSON.parse((await env.SUBS?.get(walletKey(userId))) || 'null');
  } catch {
    rec = null;
  }
  if (!rec) {
    rec = emptyWallet();
    const carried = await migrateSubscription(env, userId);
    if (carried) {
      rec.paid += carried;
      rec.migrated = true;
    }
  }
  return refreshPeriods({ ...emptyWallet(), ...rec });
}

async function writeWallet(env, userId, rec) {
  await env.SUBS.put(walletKey(userId), JSON.stringify(rec));
  return rec;
}

/**
 * Была активная подписка на момент перехода — отдаём пакет прокруток. Старую
 * запись помечаем, чтобы обмен не повторился; удалять её нельзя, там лежит
 * charge_id для возможного возврата.
 */
async function migrateSubscription(env, userId) {
  let old;
  try {
    old = JSON.parse((await env.SUBS?.get(legacyKey(userId))) || 'null');
  } catch {
    return 0;
  }
  if (!old || old.converted_at) return 0;
  const active = Number(old.until || 0) > Date.now();
  await env.SUBS.put(legacyKey(userId), JSON.stringify({ ...old, converted_at: Date.now() }));
  if (!active) return 0;
  return MIGRATION_SPINS;
}

const freeLeft = (rec) => Math.max(0, ECONOMY.FREE_PER_DAY - rec.free_used);
const adsLeft = (rec) => Math.max(0, ECONOMY.ADS_PER_WEEK - rec.ads_used);
const totalSpins = (rec) => freeLeft(rec) + rec.bonus + rec.paid;

/**
 * Списывает прокрутки. Сначала бесплатная за сегодня (она всё равно сгорит),
 * потом заработанные рекламой, в последнюю очередь купленные.
 *
 * Возвращает false, ничего не меняя, если не хватает: списание наполовину —
 * худший из возможных исходов.
 */
function spendFrom(rec, cost) {
  if (totalSpins(rec) < cost) return false;
  let left = cost;

  const useFree = Math.min(freeLeft(rec), left);
  rec.free_used += useFree;
  left -= useFree;

  const useBonus = Math.min(rec.bonus, left);
  rec.bonus -= useBonus;
  left -= useBonus;

  rec.paid -= left;
  return true;
}

/** Начисление: покупка, реклама, приглашение. */
async function addSpins(env, userId, spins, fields = {}) {
  const rec = await readWallet(env, userId);
  const next = { ...rec, ...fields, paid: rec.paid + spins };
  await writeWallet(env, userId, next);
  return next;
}

// ------------------------------------------------------ рекламные метки

async function bumpCounter(env, key, delta) {
  const value = Number((await env.SUBS.get(key)) || 0) + delta;
  await env.SUBS.put(key, String(value));
  return value;
}

/** Оплата засчитывается каналу, по ссылке которого пользователь пришёл впервые. */
async function attributePayment(env, userId, stars) {
  const src = await env.SUBS?.get(`src:by:${userId}`);
  if (!src) return;
  await bumpCounter(env, `src:payments:${src}`, 1);
  await bumpCounter(env, `src:stars:${src}`, stars);
}

const isAdmin = (env, userId) =>
  String(env.ADMIN_IDS || '').split(',').map((s) => s.trim()).filter(Boolean)
    .includes(String(userId));

async function sourcesReport(env) {
  const listed = await env.SUBS.list({ prefix: 'src:visits:' });
  if (!listed.keys.length) {
    return 'Переходов по рекламным ссылкам пока нет.\n\nСсылка с меткой: ' +
      `https://t.me/${await getBotUsername(env)}?start=src_имя_канала`;
  }
  const rows = await Promise.all(listed.keys.map(async ({ name }) => {
    const src = name.slice('src:visits:'.length);
    const [visits, payments, stars] = await Promise.all(
      ['visits', 'payments', 'stars'].map((k) => env.SUBS.get(`src:${k}:${src}`)),
    );
    return { src, visits: Number(visits || 0), payments: Number(payments || 0), stars: Number(stars || 0) };
  }));
  rows.sort((a, b) => b.visits - a.visits);
  return 'Источники (новые пользователи → оплаты → звёзды):\n\n' +
    rows.map((r) => `${r.src}: ${r.visits} → ${r.payments} → ${r.stars} ⭐`).join('\n');
}

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
    bonus_spins: REF_BONUS_SPINS,
    max_friends: REF_MAX_FRIENDS,
  };
}

/**
 * Пользователь пришёл в бота. Отмечаем его как известного и, если он пришёл
 * по чужой ссылке впервые, начисляем прокрутки обоим.
 *
 * Новичком считается только тот, кого бот раньше не видел: иначе старый
 * пользователь мог бы «прийти по ссылке» друга.
 */
async function registerVisit(env, userId, payload) {
  if (!env.SUBS || !userId) return null;
  const seenKey = `seen:${userId}`;
  const known = (await env.SUBS.get(seenKey))
    || (await env.SUBS.get(walletKey(userId)))
    || (await env.SUBS.get(legacyKey(userId)));
  if (known) return null;
  await env.SUBS.put(seenKey, String(Date.now()));

  // Рекламная метка: ссылка t.me/бот?start=src_<канал>. Запоминаем, откуда
  // пришёл человек, чтобы потом засчитать каналу и его оплату.
  const src = /^src_([a-z0-9_]{1,40})$/i.exec(payload || '')?.[1]?.toLowerCase();
  if (src) {
    await env.SUBS.put(`src:by:${userId}`, src);
    await bumpCounter(env, `src:visits:${src}`, 1);
    return null;
  }

  const refId = Number(/^ref_(\d+)$/.exec(payload || '')?.[1] || 0);
  if (!refId || refId === userId) return null;

  const countKey = `ref:count:${refId}`;
  const count = Number((await env.SUBS.get(countKey)) || 0);
  await env.SUBS.put(`ref:by:${userId}`, String(refId));
  if (count >= REF_MAX_FRIENDS) return { rewarded: false };

  await env.SUBS.put(countKey, String(count + 1));
  await addSpins(env, refId, REF_BONUS_SPINS);
  await addSpins(env, userId, REF_BONUS_SPINS);
  await tg(env, 'sendMessage', {
    chat_id: refId,
    text: `По вашей ссылке пришёл новый игрок — вам +${REF_BONUS_SPINS} прокрутки. ` +
      `Засчитано друзей: ${count + 1} из ${REF_MAX_FRIENDS}.`,
  });
  return { rewarded: true };
}

// Сколько часов после покупки можно вернуть звёзды самому, командой /refund.
// Позже — только по запросу владельцу: иначе прокрутками можно было бы
// пользоваться бесплатно, возвращая оплату следом.
const SELF_REFUND_HOURS = 48;

/**
 * Возврат последней покупки. Звёзды уходят только тому, кто платил: Telegram
 * сам не позволяет вернуть платёж на другой аккаунт. Прокрутки из этой
 * покупки забираем обратно — насколько ещё осталось.
 */
async function refundLastPayment(env, userId) {
  const rec = await readWallet(env, userId);
  if (!rec.charge_id) {
    return { ok: false, reason: 'Покупок, которые можно вернуть, нет.' };
  }
  const hours = (Date.now() - Number(rec.paid_at || 0)) / 3600_000;
  if (hours > SELF_REFUND_HOURS) {
    return {
      ok: false,
      reason: `Вернуть оплату самостоятельно можно в течение ${SELF_REFUND_HOURS} часов. ` +
        'Напишите владельцу бота — вернём вручную.',
    };
  }

  const res = await tg(env, 'refundStarPayment', {
    user_id: userId,
    telegram_payment_charge_id: rec.charge_id,
  });
  if (!res.ok) {
    return { ok: false, reason: `Telegram отказал в возврате: ${res.description || 'без объяснения'}.` };
  }

  const bought = Number(rec.last_pack_spins || 0);
  await writeWallet(env, userId, {
    ...rec,
    paid: Math.max(0, rec.paid - bought),
    charge_id: null,
    refunded_charge_id: rec.charge_id,
    refunded_at: Date.now(),
  });
  return { ok: true, taken: Math.min(bought, rec.paid) };
}

// ------------------------------------------------------------------- API

// Mini App живёт на github.io, воркер — на workers.dev. Это разные источники,
// поэтому браузер сначала шлёт preflight-запрос OPTIONS и пропускает POST
// только если в ответе перечислены и разрешённые методы, и заголовки.
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
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

/**
 * Полное состояние кошелька — один ответ на все вопросы приложения. Клиент не
 * складывает балансы сам: складывать должен тот, кто хранит.
 */
async function walletResponse(env, userId, rec, extra = {}, { links = false } = {}) {
  // Ссылки на счета готовим заранее, вместе с балансом: если запрашивать их
  // в момент нажатия, любой сбой сети именно в эту секунду оставляет
  // пользователя с ошибкой вместо оплаты. Но делаем это только при открытии
  // приложения — на каждое списание три обращения к Telegram были бы платой
  // задержкой за то, что никому не нужно.
  const packs = links ? await Promise.all(
    Object.entries(PACKS).filter(([, p]) => !p.hidden).map(async ([key, p]) => ({
      key,
      title: p.title,
      spins: p.spins,
      stars: p.stars,
      per: Math.round(p.stars / p.spins),
      link: await createInvoiceLink(env, key, userId),
    })),
  ) : null;

  return json({
    ok: true,
    user_id: userId,
    spins: { free: freeLeft(rec), bonus: rec.bonus, paid: rec.paid },
    total: totalSpins(rec),
    ads_left: adsLeft(rec),
    economy: ECONOMY,
    ...(packs ? { packs } : {}),
    ad_block_id: env.ADSGRAM_BLOCK_ID || null,
    referral: await referralInfo(env, userId),
    ...extra,
  });
}

async function handleState(request, env) {
  const body = await request.json().catch(() => ({}));
  const user = await verifyInitData(body.initData, env);
  if (!user) return json({ error: 'invalid initData' }, 401);

  // Открыл приложение, минуя /start, — всё равно запоминаем, чтобы потом не
  // засчитать его новичком по чужой ссылке.
  await registerVisit(env, user.id, null);
  const rec = await readWallet(env, user.id);
  // Читая, тоже пишем: за ночь сбросился дневной счётчик, и запись должна
  // это пережить, иначе бесплатная прокрутка «появлялась» бы при каждом
  // открытии, но не сохранялась.
  await writeWallet(env, user.id, rec);
  return walletResponse(env, user.id, rec, {}, { links: true });
}

async function handleSpend(request, env) {
  const body = await request.json().catch(() => ({}));
  const user = await verifyInitData(body.initData, env);
  if (!user) return json({ error: 'invalid initData' }, 401);

  const cost = Number(body.cost);
  if (!Number.isInteger(cost) || cost < 1 || cost > 20) {
    return json({ error: 'bad cost' }, 400);
  }

  const rec = await readWallet(env, user.id);
  // Повтор того же списания (ответ на первый запрос потерялся в сети) —
  // прокрутки уже списаны, второй раз не списываем.
  const op = typeof body.op === 'string' ? body.op.slice(0, 64) : null;
  if (op && rec.last_op === op) {
    return walletResponse(env, user.id, rec, { spent: cost, repeated: true });
  }
  if (!spendFrom(rec, cost)) {
    await writeWallet(env, user.id, rec);
    return walletResponse(env, user.id, rec, { ok: false, reason: 'not enough spins' });
  }
  if (op) rec.last_op = op;
  await writeWallet(env, user.id, rec);
  return walletResponse(env, user.id, rec, { spent: cost });
}

/**
 * Начисление за рекламу.
 *
 * Лимит проверяется здесь, а не в приложении: страницу можно переписать в
 * консоли браузера, и единственное, что делает лимит настоящим, — то, что
 * считает его сервер. Даже поддельный вызов не даст больше пяти прокруток
 * в неделю.
 */
/**
 * Один просмотр приходит двумя путями: приложение сообщает о досмотре само, и
 * Adsgram зовёт Reward URL. Кто пришёл вторым в пределах этого окна — тот
 * же просмотр: начисление не повторяем, но и ошибкой не отвечаем.
 *
 * Раньше второй вызов получал отказ «слишком часто», и приложение показывало
 * ошибку ровно тогда, когда прокрутка уже была начислена.
 */
const AD_SAME_VIEW_MS = 90_000;

async function grantAdReward(env, userId, source) {
  const rec = await readWallet(env, userId);
  if (Date.now() - Number(rec.last_ad || 0) < AD_SAME_VIEW_MS) {
    await logAd(env, { user: userId, source, result: 'тот же просмотр' });
    return { rec, ok: true, duplicate: true };
  }
  if (adsLeft(rec) <= 0) {
    await logAd(env, { user: userId, source, result: 'лимит недели' });
    return { rec, ok: false, reason: 'На этой неделе просмотры за прокрутки закончились.' };
  }
  rec.ads_used += 1;
  rec.bonus += ECONOMY.AD_REWARD;
  rec.last_ad = Date.now();
  await writeWallet(env, userId, rec);
  await logAd(env, { user: userId, source, result: `+${ECONOMY.AD_REWARD}` });
  return { rec, ok: true };
}

/**
 * Журнал последних рекламных событий для /ads. Без него не понять, кто из
 * двух путей начисления не дошёл: приложение или вызов Adsgram.
 */
const AD_LOG_KEY = 'adlog';
const AD_LOG_SIZE = 30;

async function logAd(env, entry) {
  try {
    const log = JSON.parse((await env.SUBS.get(AD_LOG_KEY)) || '[]');
    log.unshift({ at: Date.now(), ...entry });
    await env.SUBS.put(AD_LOG_KEY, JSON.stringify(log.slice(0, AD_LOG_SIZE)));
  } catch (err) {
    console.error('adlog failed', err);
  }
}

async function adsReport(env) {
  const log = JSON.parse((await env.SUBS.get(AD_LOG_KEY)) || '[]');
  if (!log.length) {
    return 'Рекламных событий ещё не было: ни приложение, ни Adsgram не сообщали о просмотрах.';
  }
  const time = (ms) => new Date(ms + MSK_SHIFT_MS).toISOString().slice(5, 19).replace('T', ' ');
  return 'Последние рекламные события (время МСК):\n\n' + log.map((e) =>
    `${time(e.at)} · ${e.source} · ${e.user ?? '—'} · ${e.result}`).join('\n');
}

async function handleAdClaim(request, env) {
  const body = await request.json().catch(() => ({}));
  const user = await verifyInitData(body.initData, env);
  if (!user) return json({ error: 'invalid initData' }, 401);

  // Приложение сообщает и о сбоях показа: так в журнале видно, доходит ли
  // дело до ролика вообще.
  if (body.failed) {
    await logAd(env, { user: user.id, source: 'приложение', result: `сбой: ${String(body.failed).slice(0, 120)}` });
    const rec = await readWallet(env, user.id);
    return walletResponse(env, user.id, rec, { ok: false, logged: true });
  }

  const result = await grantAdReward(env, user.id, 'приложение');
  return walletResponse(env, user.id, result.rec, result.ok
    ? { reward: ECONOMY.AD_REWARD, duplicate: Boolean(result.duplicate) }
    : { ok: false, reason: result.reason });
}

/**
 * Callback рекламной сети: Adsgram сам дёргает этот адрес, когда ролик
 * досмотрен. Настраивается в кабинете блока как Reward URL:
 *
 *   https://<воркер>.workers.dev/api/ad-reward?userid=[userId]&key=<секрет>
 *
 * [userId] — плейсхолдер самой сети, она подставляет туда Telegram ID
 * зрителя; кабинет не принимает адрес, в котором этой подстроки нет.
 * Имя параметра userid — наше, его читает handleAdReward.
 *
 * Секрет обязателен: без него начислить прокрутку мог бы кто угодно.
 */
async function handleAdReward(url, env) {
  const secret = env.AD_REWARD_SECRET;
  const raw = url.searchParams.get('userid') || url.searchParams.get('userId') || '';
  if (!secret || url.searchParams.get('key') !== secret) {
    // Неверный ключ тоже пишем в журнал: это самая частая причина, по
    // которой Reward URL «не работает».
    await logAd(env, { user: Number(raw) || null, source: 'Adsgram', result: 'неверный key в Reward URL' });
    return new Response('forbidden', { status: 403 });
  }
  const userId = Number(raw);
  if (!userId) {
    await logAd(env, { user: null, source: 'Adsgram', result: `нет userid: «${raw.slice(0, 40)}»` });
    return new Response('bad userid', { status: 400 });
  }
  const result = await grantAdReward(env, userId, 'Adsgram');
  return json({ ok: result.ok, reason: result.reason });
}

/**
 * Ссылка на оплату для Telegram.WebApp.openInvoice. Оплата проходит внутри
 * клиента Telegram, платёжные данные пользователя до нас не доходят.
 *
 * Возвращает null вместо исключения: несозданная ссылка одного пакета не
 * должна ронять весь ответ о балансе.
 */
async function createInvoiceLink(env, packKey, userId) {
  const pack = PACKS[packKey];
  if (!pack) return null;
  try {
    const res = await tg(env, 'createInvoiceLink', {
      title: pack.title,
      description:
        `${pack.spins} подбор${pack.spins === 1 ? 'а' : 'ов'} комбинаций, которые почти ` +
        'никто не ставит. Прокрутки не сгорают.',
      payload: JSON.stringify({ pack: packKey, uid: userId }),
      provider_token: '', // для Stars токен провайдера не нужен
      currency: 'XTR',
      prices: [{ label: pack.title, amount: pack.stars }],
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

  const packKey = String(body.pack || '');
  const pack = PACKS[packKey];
  if (!pack) return json({ error: 'unknown pack' }, 400);

  const link = await createInvoiceLink(env, packKey, user.id);
  if (!link) {
    // Пустая ссылка означает отказ Telegram — причина уходит в логи воркера.
    return json({ error: 'Telegram не выдал ссылку на счёт' }, 502);
  }
  return json({ link, pack: packKey, stars: pack.stars, spins: pack.spins });
}

// --------------------------------------------------------------- вебхук

async function handleUpdate(update, env) {
  // Последний шанс отменить платёж. Ответить обязательно в течение 10 секунд,
  // иначе Telegram отменит его сам.
  if (update.pre_checkout_query) {
    const q = update.pre_checkout_query;
    let ok = false;
    try {
      ok = Boolean(PACKS[JSON.parse(q.invoice_payload).pack]);
    } catch { /* битый payload — не подтверждаем */ }
    return tg(env, 'answerPreCheckoutQuery', {
      pre_checkout_query_id: q.id,
      ok,
      ...(ok ? {} : { error_message: 'Пакет больше недоступен. Откройте приложение заново.' }),
    });
  }

  const message = update.message;
  if (!message) return;
  const chatId = message.chat.id;
  const userId = message.from?.id;

  if (message.successful_payment) {
    const pay = message.successful_payment;
    let packKey = null;
    try {
      packKey = JSON.parse(pay.invoice_payload).pack;
    } catch { /* см. ниже */ }

    const pack = PACKS[packKey];
    if (!pack) {
      console.error('оплата с неизвестным payload', pay.invoice_payload);
      return tg(env, 'sendMessage', {
        chat_id: chatId,
        text: 'Платёж получен, но пакет не распознан. Напишите нам — вернём Stars.',
      });
    }
    const rec = await addSpins(env, userId, pack.spins, {
      // Идентификатор платежа нужен, чтобы можно было вернуть деньги:
      // Telegram требует от ботов возможность возврата Stars по запросу.
      charge_id: pay.telegram_payment_charge_id ?? null,
      paid_at: Date.now(),
      last_pack_spins: pack.spins,
    });
    await attributePayment(env, userId, Number(pay.total_amount || 0));
    return tg(env, 'sendMessage', {
      chat_id: chatId,
      text: `Начислено ${pack.spins} прокруток. На балансе: ${totalSpins(rec)}.`,
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
        ? `\n\nВы пришли по приглашению — вам +${REF_BONUS_SPINS} прокрутки в подарок.`
        : '';
      return send(TEXT.start + bonus, { reply_markup: appKeyboard(env) });
    }

    case '/invite': {
      const info = await referralInfo(env, userId);
      if (!info.link) return send('Не удалось получить ссылку, попробуйте позже.');
      return send(
        `Ваша ссылка-приглашение:\n${info.link}\n\n` +
          `За каждого нового игрока — по +${info.bonus_spins} прокрутки вам и ему. ` +
          `Засчитываем до ${info.max_friends} друзей, уже пришло: ${info.invited}.`,
      );
    }

    case '/help':
      return send(TEXT.help);

    case '/spins':
    case '/status': {
      const rec = await readWallet(env, userId);
      await writeWallet(env, userId, rec);
      return send(
        `Прокруток на балансе: ${totalSpins(rec)}.\n` +
          `Бесплатных сегодня: ${freeLeft(rec)} из ${ECONOMY.FREE_PER_DAY}.\n` +
          `За рекламу на этой неделе осталось: ${adsLeft(rec)} из ${ECONOMY.ADS_PER_WEEK}.\n\n` +
          'Купленные прокрутки не сгорают.',
        { reply_markup: appKeyboard(env) },
      );
    }

    case '/myid':
      return send(`Ваш Telegram ID: ${userId}`);

    case '/stats':
      // Для остальных команды будто нет: статистика продаж — не их дело.
      if (!isAdmin(env, userId)) return send(TEXT.unknown);
      return send(await sourcesReport(env));

    case '/ads':
      if (!isAdmin(env, userId)) return send(TEXT.unknown);
      return send(await adsReport(env));

    case '/refund': {
      const result = await refundLastPayment(env, userId);
      return send(result.ok
        ? 'Звёзды возвращены на ваш баланс, прокрутки из этой покупки списаны.'
        : result.reason);
    }

    case '/buy':
      return send(
        'Пакеты прокруток. Оплата внутри Telegram, звёздами:\n\n' +
          Object.values(PACKS)
            .filter((p) => !p.hidden)
            .map((p) => `${p.title} — ${p.stars} ⭐ (${Math.round(p.stars / p.spins)} ⭐ за прокрутку)`)
            .join('\n') +
          '\n\nОдна прокрутка каждый день бесплатно, ещё ' +
          `${ECONOMY.ADS_PER_WEEK} в неделю — за просмотр рекламы.\n` +
          'Откройте приложение и нажмите «Пополнить».',
        { reply_markup: appKeyboard(env) },
      );

    default:
      return send(TEXT.unknown);
  }
}

// ------------------------------------------------------------ меню команд

// Меню команд в Telegram. Воркер сам выставляет его после выкатки: версия
// меню хранится в KV, и при первом запросе новой сборки, если версия
// отличается, меню обновляется. Руками запускать setup_telegram.py не нужно.
// Список обязан совпадать с обработчиками в handleUpdate.
const COMMANDS = [
  { command: 'start', description: 'Открыть аналитику' },
  { command: 'spins', description: 'Сколько прокруток на балансе' },
  { command: 'buy', description: 'Пакеты прокруток' },
  { command: 'invite', description: 'Позвать друга: +3 прокрутки обоим' },
  { command: 'help', description: 'Что умеет бот' },
];
const COMMANDS_VERSION = COMMANDS.map((c) => `${c.command}:${c.description}`).join('|');
let commandsChecked = false;

async function syncCommands(env) {
  if (commandsChecked || !env.SUBS || !env.BOT_TOKEN) return;
  commandsChecked = true;
  try {
    if ((await env.SUBS.get('cmd:version')) === COMMANDS_VERSION) return;
    const res = await tg(env, 'setMyCommands', { commands: COMMANDS });
    if (res.ok) await env.SUBS.put('cmd:version', COMMANDS_VERSION);
  } catch (err) {
    console.error('setMyCommands failed', err);
  }
}

// ------------------------------------------------------------------ вход

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    ctx?.waitUntil?.(syncCommands(env));

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
        build: 'spins-v3',
        commands_synced: (await env.SUBS?.get('cmd:version')) === COMMANDS_VERSION,
        packs: Object.keys(PACKS),
        economy: ECONOMY,
        kv_subs: Boolean(env.SUBS),
        bot_token: Boolean(env.BOT_TOKEN),
        webhook_secret: Boolean(env.WEBHOOK_SECRET),
        ad_reward_secret: Boolean(env.AD_REWARD_SECRET),
        ad_block_id: env.ADSGRAM_BLOCK_ID || null,
        miniapp_url: env.MINIAPP_URL || null,
        donate_url: env.DONATE_URL || null,
      });
    }

    // Рекламная сеть зовёт этот адрес сама, обычным GET с параметрами.
    if (url.pathname === '/api/ad-reward') {
      return handleAdReward(url, env);
    }

    if (request.method !== 'POST') {
      return new Response('Этот адрес принимает только POST.', { status: 405 });
    }

    const api = {
      '/api/state': handleState,
      '/api/spend': handleSpend,
      '/api/ad-claim': handleAdClaim,
      '/api/invoice': handleInvoice,
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
