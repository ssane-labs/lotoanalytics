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

export { verifyInitData, MAX_INITDATA_AGE_SEC };
