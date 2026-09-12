/**
 * Тесты проверки подписи initData — самого чувствительного места в проекте.
 *
 * Если эта проверка ошибётся, любой сможет объявить себя чужим пользователем и
 * получить оплаченную подписку бесплатно. Поэтому здесь не «happy path», а
 * набор попыток обмана: подделанная подпись, чужой токен, просроченные данные,
 * подмена полей и отсутствие подписи вовсе.
 *
 * Запуск:  node tests/initdata.test.mjs
 */

import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

import { verifyInitData, MAX_INITDATA_AGE_SEC } from '../bot/verify.js';

const TOKEN = '123456:TEST-TOKEN-FOR-SIGNATURE-CHECK';
const env = { BOT_TOKEN: TOKEN };

/** Подписывает набор полей так же, как это делает Telegram. */
function sign(fields, token = TOKEN) {
  const dcs = Object.entries(fields)
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  return createHmac('sha256', secret).update(dcs).digest('hex');
}

function build(overrides = {}, token = TOKEN) {
  const fields = {
    auth_date: String(Math.floor(Date.now() / 1000)),
    query_id: 'AAExampleQueryId',
    user: JSON.stringify({ id: 777001, first_name: 'Тест', username: 'tester' }),
    ...overrides,
  };
  return new URLSearchParams({ ...fields, hash: sign(fields, token) }).toString();
}

let passed = 0;
async function check(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ok    ${name}`);
}

await check('подлинные данные принимаются и отдают пользователя', async () => {
  const user = await verifyInitData(build(), env);
  assert.equal(user?.id, 777001);
  assert.equal(user.username, 'tester');
});

await check('подделанная подпись отклоняется', async () => {
  const data = build();
  const broken = data.replace(/hash=[0-9a-f]+/, `hash=${'0'.repeat(64)}`);
  assert.equal(await verifyInitData(broken, env), null);
});

await check('подпись чужим токеном отклоняется', async () => {
  assert.equal(await verifyInitData(build({}, TOKEN + 'x'), env), null);
});

await check('верная подпись при другом токене бота отклоняется', async () => {
  assert.equal(await verifyInitData(build(), { BOT_TOKEN: TOKEN + 'x' }), null);
});

await check('просроченные данные отклоняются', async () => {
  const stale = String(Math.floor(Date.now() / 1000) - MAX_INITDATA_AGE_SEC - 60);
  assert.equal(await verifyInitData(build({ auth_date: stale }), env), null);
});

await check('данные на границе срока ещё принимаются', async () => {
  const edge = String(Math.floor(Date.now() / 1000) - MAX_INITDATA_AGE_SEC + 120);
  const user = await verifyInitData(build({ auth_date: edge }), env);
  assert.equal(user?.id, 777001);
});

await check('подмена пользователя при сохранённой подписи отклоняется', async () => {
  // Классическая атака: взять свои подлинные данные и переписать id на чужой.
  const data = build();
  const forged = data.replace(/user=[^&]+/, encodeURIComponent(
    JSON.stringify({ id: 999999, first_name: 'Чужой' }),
  ).replace(/^/, 'user='));
  assert.equal(await verifyInitData(forged, env), null);
});

await check('отсутствие hash отклоняется', async () => {
  assert.equal(await verifyInitData('auth_date=1&user=%7B%22id%22%3A1%7D', env), null);
});

await check('пустая строка и мусор отклоняются', async () => {
  assert.equal(await verifyInitData('', env), null);
  assert.equal(await verifyInitData(null, env), null);
  assert.equal(await verifyInitData('не-урл-вообще', env), null);
});

// Поле signature появляется в initData настоящих клиентов, но не в
// синтетических данных — из-за чего тесты проходили, а живой Telegram
// получал 401. Ниже закреплены оба варианта подсчёта хэша.

await check('initData с signature принимается (хэш включает signature)', async () => {
  const fields = {
    auth_date: String(Math.floor(Date.now() / 1000)),
    chat_instance: '-1234567890',
    chat_type: 'private',
    query_id: 'AAReal',
    signature: 'SomeEd25519SignatureValue',
    user: JSON.stringify({ id: 777001, first_name: 'Тест' }),
  };
  const data = new URLSearchParams({ ...fields, hash: sign(fields) }).toString();
  assert.equal((await verifyInitData(data, env))?.id, 777001);
});

await check('initData с signature принимается (хэш без signature)', async () => {
  const fields = {
    auth_date: String(Math.floor(Date.now() / 1000)),
    query_id: 'AAReal',
    signature: 'SomeEd25519SignatureValue',
    user: JSON.stringify({ id: 777001, first_name: 'Тест' }),
  };
  const withoutSignature = { ...fields };
  delete withoutSignature.signature;
  const data = new URLSearchParams({
    ...fields,
    hash: sign(withoutSignature),
  }).toString();
  assert.equal((await verifyInitData(data, env))?.id, 777001);
});

await check('подделка при наличии signature отклоняется', async () => {
  const fields = {
    auth_date: String(Math.floor(Date.now() / 1000)),
    signature: 'SomeEd25519SignatureValue',
    user: JSON.stringify({ id: 777001, first_name: 'Тест' }),
  };
  const data = new URLSearchParams({ ...fields, hash: '0'.repeat(64) }).toString();
  assert.equal(await verifyInitData(data, env), null);
  const wrongToken = new URLSearchParams({
    ...fields,
    hash: sign(fields, TOKEN + 'x'),
  }).toString();
  assert.equal(await verifyInitData(wrongToken, env), null);
});

await check('данные без поля user отклоняются', async () => {
  const fields = { auth_date: String(Math.floor(Date.now() / 1000)), query_id: 'x' };
  const data = new URLSearchParams({ ...fields, hash: sign(fields) }).toString();
  assert.equal(await verifyInitData(data, env), null);
});

console.log(`\nOK: ${passed} проверок подписи initData пройдено`);
