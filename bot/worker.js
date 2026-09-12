/**
 * Телеграм-бот на Cloudflare Workers (бесплатный тариф, свой HTTPS-домен
 * *.workers.dev — покупать ничего не нужно).
 *
 * Бот намеренно простой: он не считает и ничего не предсказывает, а открывает
 * Mini App, где вся математика выполняется в браузере. Это значит, что сервер
 * не хранит ни ставок, ни комбинаций пользователей — нечего терять и нечего
 * утекать.
 *
 * Секреты (wrangler secret put ИМЯ) — в коде их быть не должно:
 *   BOT_TOKEN        — токен от BotFather
 *   WEBHOOK_SECRET   — произвольная строка, ею Telegram подписывает запросы
 * Переменная (wrangler.toml -> [vars]):
 *   MINIAPP_URL      — https://<логин>.github.io/<репозиторий>/
 */

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
    '/app — открыть аналитику\n' +
    '/honest — почему мы не продаём предсказания\n' +
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

async function callTelegram(token, method, payload) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    // Логируем, но не падаем: Telegram повторит апдейт, если вернуть не-200.
    console.error(`${method} -> ${res.status}`, await res.text());
  }
  return res;
}

function appKeyboard(url) {
  return { inline_keyboard: [[{ text: 'Открыть аналитику', web_app: { url } }]] };
}

async function handleUpdate(update, env) {
  const message = update.message || update.edited_message;
  if (!message?.text) return;

  const chatId = message.chat.id;
  const command = message.text.trim().split(/\s+/)[0].split('@')[0].toLowerCase();

  const send = (text, withButton = false) =>
    callTelegram(env.BOT_TOKEN, 'sendMessage', {
      chat_id: chatId,
      text,
      ...(withButton ? { reply_markup: appKeyboard(env.MINIAPP_URL) } : {}),
    });

  switch (command) {
    case '/start':
      return send(TEXT.start, true);
    case '/honest':
      return send(TEXT.honest, true);
    case '/help':
      return send(TEXT.help);
    default:
      return send(TEXT.unknown);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return new Response('ok', { status: 200 });
    }

    if (request.method !== 'POST') {
      return new Response('Этот адрес принимает только вебхуки Telegram.', {
        status: 405,
      });
    }

    // Telegram подписывает каждый вебхук этим заголовком. Без проверки любой
    // желающий мог бы отправлять боту поддельные апдейты.
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

    // Всегда 200: иначе Telegram будет повторять один и тот же апдейт.
    return new Response('ok', { status: 200 });
  },
};
