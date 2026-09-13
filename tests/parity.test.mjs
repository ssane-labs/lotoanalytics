/**
 * Проверка, что JS-модель считает ровно то же, что Python-модель.
 *
 * Логика популярности существует в двух реализациях: Python собирает данные,
 * JS считает в браузере. Если они разойдутся, пользователь увидит не те числа,
 * которые мы проверяли. Эталон снимает tests/make_vectors.py.
 *
 * Запуск:  node tests/parity.test.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';

import { PopularityModel, matchProbability, expectedShareFactor, combinations }
  from '../docs/model.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const read = (p) => JSON.parse(readFileSync(join(root, p), 'utf8'));

const TOLERANCE = 1e-9;
let checks = 0;

function close(actual, expected, label) {
  const rel = Math.abs(actual - expected) / Math.max(Math.abs(expected), 1e-12);
  assert.ok(
    rel < TOLERANCE,
    `${label}: JS=${actual} Python=${expected} (отн. расхождение ${rel})`,
  );
  checks += 1;
}

// --- 1. Идентичность модели популярности --------------------------------

const vectorsFile = read('tests/vectors.json');

// Читаем первоисточник model_params.json, а не собранные docs/data: тест не
// должен зависеть от того, когда в последний раз запускали сборку данных.
const params = read('model_params.json');
const spec = params.games['6x45'];

// Эталон снят без истории тиражей, поэтому и здесь её отключаем: фактор
// history зависит от того, какие данные были загружены при сборке.
const model = new PopularityModel({
  game: {
    key: '6x45',
    pick: spec.pick,
    pool: spec.pool,
    slip: spec.slip,
    ticket_price_rub: spec.ticket_price_rub,
    prizes_rub: spec.prizes_rub,
    typical_players_per_draw: spec.typical_players_per_draw,
  },
  popularity: params.popularity,
  mean_weight: 1,
  recent_winners: [],
});

for (const vector of vectorsFile.vectors) {
  const got = model.breakdown(vector.combo);
  const tag = `[${vector.combo.join(',')}]`;

  for (const [factor, expected] of Object.entries(vector.breakdown)) {
    close(got[factor], expected, `${tag} фактор ${factor}`);
  }
  const weight = Object.values(got).reduce((a, b) => a * b, 1);
  close(weight, vector.weight, `${tag} итоговый вес`);
}

// --- 2. Комбинаторика ---------------------------------------------------

assert.equal(combinations(45, 6), 8145060, 'C(45,6)');
assert.equal(combinations(6, 6), 1, 'C(6,6)');
assert.equal(combinations(45, 0), 1, 'C(45,0)');
checks += 3;

// Сумма вероятностей по всем уровням совпадений должна давать единицу.
let totalProbability = 0;
for (let m = 0; m <= 6; m += 1) {
  totalProbability += matchProbability(model.game, m);
}
close(totalProbability, 1, 'сумма вероятностей по числу совпадений');

close(matchProbability(model.game, 6), 1 / 8145060, 'вероятность джекпота');

// --- 3. Ожидаемая доля джекпота ----------------------------------------

close(expectedShareFactor(0), 1, 'E[1/(1+K)] при lam=0');
// При lam -> бесконечность доля убывает как 1/lam.
const big = expectedShareFactor(1000);
assert.ok(big > 0 && big < 0.002, `E[1/(1+K)] при lam=1000 = ${big}`);
checks += 1;
// Монотонное убывание.
let previous = Infinity;
for (const lam of [0.01, 0.1, 0.5, 1, 2, 5, 20]) {
  const value = expectedShareFactor(lam);
  assert.ok(value < previous, `E[1/(1+K)] должна убывать, lam=${lam}`);
  previous = value;
  checks += 1;
}

// --- 4. Нейросеть: прямой проход JS совпадает с Python -------------------

import { existsSync, readdirSync } from 'node:fs';
import { DrawAI } from '../docs/ai.js';

const dataDir = join(root, 'docs', 'data');
const aiFiles = existsSync(dataDir)
  ? readdirSync(dataDir).filter((f) => f.endsWith('_ai.json'))
  : [];
for (const file of aiFiles) {
  const payload = read(`docs/data/${file}`);
  if (payload.insufficient) continue;
  const ai = new DrawAI(payload);
  const probs = ai.probabilities(payload.check.history);
  payload.check.probs.forEach((expected, i) => {
    close(probs[i], expected, `${file} вероятность числа ${i + 1}`);
  });
}

console.log(
  `OK: ${vectorsFile.vectors.length} векторов, ${aiFiles.length} нейросетей, ${checks} проверок, ` +
    `расхождение Python/JS < ${TOLERANCE}`,
);
