/**
 * Модель популярности и расчёт выплаты — порт scripts/lotto/popularity.py и ev.py.
 *
 * Логика продублирована на двух языках сознательно: Python нужен для сборки
 * данных и обучения, JS — чтобы Mini App считал всё на клиенте и работал без
 * сервера на GitHub Pages. Идентичность проверяет tests/parity.test.mjs по
 * общему набору векторов.
 *
 * Билет — массив полей: [[4, 17, 23, 31, 38, 44]] в «6 из 45»,
 * [[3, 7, 12, 18], [2, 9, 14, 20]] в «4 из 20». Параметры приходят из
 * docs/data/<игра>_model.json (собирается из model_params.json).
 */

export const FACTOR_LABELS = {
  numbers: 'Выбор отдельных чисел',
  consecutive: 'Подряд идущие числа',
  arithmetic: 'Арифметическая прогрессия',
  grid: 'Узор на бланке',
  sum: 'Сумма чисел',
  parity: 'Чётные и нечётные',
  range: 'Узкий диапазон',
  history: 'Повтор выпавшей комбинации',
};

/** Поля меньше этого размера узоров не образуют. Как в popularity.py. */
const MIN_PATTERN_PICK = 3;

export function combinations(n, k) {
  if (k < 0 || k > n) return 0;
  let out = 1;
  for (let i = 0; i < k; i += 1) out = (out * (n - i)) / (i + 1);
  return Math.round(out);
}

/** Плоский список или список полей — в билет с отсортированными полями. */
export function asTicket(game, input) {
  if (Array.isArray(input[0])) return input.map((f) => [...f].sort((a, b) => a - b));
  const out = [];
  let pos = 0;
  for (const f of game.fields) {
    out.push(input.slice(pos, pos + f.pick).sort((a, b) => a - b));
    pos += f.pick;
  }
  return out;
}

/** Номер поля зашит в число — так повтор прошлого тиража ищется одной проверкой. */
const flat = (ticket) => ticket.flatMap((f, i) => f.map((n) => i * 100 + n));

export class PopularityModel {
  constructor(payload) {
    this.game = payload.game;
    this.cfg = payload.popularity;
    this.meanWeight = payload.mean_weight;
    this.calibration = this.cfg.calibration || null;
    this.randomShare = this.calibration ? this.calibration.random_share : 0;
    this.totalCombinations = payload.game.total_combinations
      || this.game.fields.reduce((acc, f) => acc * combinations(f.pool, f.pick), 1);

    this.recentWinners = (payload.recent_winners || []).map((t) => flat(asTicket(this.game, t)));
    this.recentWinnerKeys = new Set(this.recentWinners.map((c) => c.join(',')));
  }

  literatureWeight(n) {
    const nw = this.cfg.number_weights;
    if (nw.overrides[String(n)] !== undefined) return nw.overrides[String(n)];
    if (n <= 12) return nw.base_1_12;
    if (n <= 31) return nw.base_13_31;
    return nw.base_32_45;
  }

  numberFactor(ticket) {
    let out = 1;
    ticket.forEach((combo, i) => {
      if (this.calibration) {
        const w = this.calibration.field_weights[i];
        for (const n of combo) out *= w[n - 1];
      } else if (i === 0) {
        for (const n of combo) out *= this.literatureWeight(n);
      }
    });
    return out;
  }

  consecutiveFactor(combo) {
    const c = this.cfg.consecutive_run;
    let best = 1;
    let run = 1;
    for (let i = 1; i < combo.length; i += 1) {
      run = combo[i] === combo[i - 1] + 1 ? run + 1 : 1;
      if (run > best) best = run;
    }
    if (best === 1) return c.no_adjacent_pair_bonus;
    const mult = c.run_length_multiplier[String(best)];
    return mult === undefined ? 1 : mult;
  }

  arithmeticFactor(combo) {
    const c = this.cfg.arithmetic_progression;
    const diffs = new Set();
    for (let i = 1; i < combo.length; i += 1) diffs.add(combo[i] - combo[i - 1]);
    if (diffs.size === 1 && !diffs.has(1)) return c.full_ap_multiplier;
    if (combo.length >= 5) {
      for (let s = 0; s + 5 <= combo.length; s += 1) {
        const w = new Set();
        for (let i = s + 1; i < s + 5; i += 1) w.add(combo[i] - combo[i - 1]);
        if (w.size === 1 && !w.has(1)) return c.partial_ap_5_multiplier;
      }
    }
    return 1;
  }

  gridFactor(combo, cols) {
    const c = this.cfg.grid_pattern;
    const positions = combo
      .map((n) => [Math.floor((n - 1) / cols), (n - 1) % cols])
      .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const rows = positions.map((p) => p[0]);
    const cs = positions.map((p) => p[1]);
    const k = combo.length;

    if (new Set(rows).size === 1) return c.full_row_multiplier;
    if (new Set(cs).size === 1) return c.full_col_multiplier;

    for (const dc of [1, -1]) {
      let best = 1;
      let run = 1;
      for (let i = 1; i < positions.length; i += 1) {
        const [r0, c0] = positions[i - 1];
        const [r1, c1] = positions[i];
        run = r1 - r0 === 1 && c1 - c0 === dc ? run + 1 : 1;
        if (run > best) best = run;
      }
      if (best >= Math.min(5, k)) return c.diagonal_multiplier;
    }

    const count = (arr) => {
      const m = new Map();
      for (const v of arr) m.set(v, (m.get(v) || 0) + 1);
      return Math.max(...m.values());
    };
    const threshold = Math.max(4, k - 2);
    let factor = 1;
    if (count(rows) >= threshold) factor *= c.single_row_concentration_multiplier;
    if (count(cs) >= threshold) factor *= c.single_col_concentration_multiplier;
    return factor;
  }

  sumFactor(combo) {
    const c = this.cfg.sum_window;
    const total = combo.reduce((a, b) => a + b, 0);
    const z = (total - c.human_peak) / c.sigma;
    return 1 + (c.peak_multiplier - 1) * Math.exp(-0.5 * z * z);
  }

  parityFactor(combo) {
    const c = this.cfg.parity_balance;
    const evens = combo.filter((n) => n % 2 === 0).length;
    const k = combo.length;
    if (k % 2 === 0 && evens === k / 2) return c.balanced_3_3_multiplier;
    if (evens === 0 || evens === k) return c.extreme_0_6_multiplier;
    return 1;
  }

  rangeFactor(combo) {
    const c = this.cfg.decade_clustering;
    return combo[combo.length - 1] - combo[0] <= c.narrow_range_threshold
      ? c.narrow_range_multiplier
      : 1;
  }

  historyFactor(ticket) {
    if (!this.recentWinners.length) return 1;
    const c = this.cfg.past_winner_repeat;
    const key = flat(ticket);
    if (this.recentWinnerKeys.has(key.join(','))) return c.exact_repeat_multiplier;
    const need = key.length - 1;
    const target = new Set(key);
    for (const old of this.recentWinners) {
      let hits = 0;
      for (const n of old) if (target.has(n)) hits += 1;
      if (hits >= need) return c.five_of_six_repeat_multiplier;
    }
    return 1;
  }

  breakdown(input) {
    const ticket = asTicket(this.game, input);
    const out = {
      numbers: this.numberFactor(ticket),
      consecutive: 1,
      arithmetic: 1,
      grid: 1,
      sum: 1,
      parity: 1,
      range: 1,
      history: this.historyFactor(ticket),
    };
    ticket.forEach((combo, i) => {
      const field = this.game.fields[i];
      if (field.pick < MIN_PATTERN_PICK) return;
      out.consecutive *= this.consecutiveFactor(combo);
      out.arithmetic *= this.arithmeticFactor(combo);
      out.grid *= this.gridFactor(combo, field.slip.cols);
      out.sum *= this.sumFactor(combo);
      out.parity *= this.parityFactor(combo);
      out.range *= this.rangeFactor(combo);
    });
    return out;
  }

  weight(ticket) {
    return Object.values(this.breakdown(ticket)).reduce((a, b) => a * b, 1);
  }

  /**
   * Доля всех ставок тиража, приходящаяся на этот билет. Автовыбор делит
   * свою долю поровну между всеми билетами, остальные ставки следуют весу.
   */
  pickShare(ticket) {
    const rho = this.randomShare;
    return (rho + (1 - rho) * this.weight(ticket) / this.meanWeight) / this.totalCombinations;
  }
}

// ---------------------------------------------------------------------------
// Ожидаемая выплата
// ---------------------------------------------------------------------------

export function fieldMatchProbability(field, matched) {
  const { pick, pool } = field;
  if (matched < 0 || matched > pick) return 0;
  return (combinations(pick, matched) * combinations(pool - pick, pick - matched))
    / combinations(pool, pick);
}

/** Сочетание совпадений по полям; число — совпадения в главном поле. */
export function matchProbability(game, matched) {
  const m = Array.isArray(matched) ? matched : [matched];
  let out = 1;
  m.forEach((k, i) => { out *= fieldMatchProbability(game.fields[i], k); });
  return out;
}

export function categoryProbability(game, index) {
  return game.categories[index].match.reduce((s, m) => s + matchProbability(game, m), 0);
}

/** E[1/(1+K)] для K ~ Poisson(lam): ожидаемая доля суперприза. */
export function expectedShareFactor(lam) {
  if (lam <= 1e-12) return 1;
  return (1 - Math.exp(-lam)) / lam;
}

export function fixedTiersEV(game) {
  let total = 0;
  game.prizes_rub.forEach((prize, i) => {
    if (prize === null || i >= game.categories.length) return;
    total += categoryProbability(game, i) * Number(prize);
  });
  return total;
}

export function evaluateEV(model, ticket, jackpotRub, players) {
  const game = model.game;
  const n = players || game.typical_players_per_draw;
  const q = model.pickShare(ticket);

  const lam = Math.max(n - 1, 0) * q;
  const share = expectedShareFactor(lam);
  const lamBase = Math.max(n - 1, 0) / model.totalCombinations;
  const shareBase = expectedShareFactor(lamBase);

  const evFixed = fixedTiersEV(game);
  const evJackpot = (1 / model.totalCombinations) * jackpotRub * share;
  const gross = evFixed + evJackpot;

  return {
    pickShare: q,
    expectedCoWinners: lam,
    shareFactor: share,
    baselineShareFactor: shareBase,
    payoutAdvantage: shareBase ? share / shareBase : 1,
    evFixedTiers: evFixed,
    evJackpot,
    evTotal: gross - game.ticket_price_rub,
    rtp: gross / game.ticket_price_rub,
  };
}

export function breakevenJackpot(model, shareFactor = 1) {
  const deficit = model.game.ticket_price_rub - fixedTiersEV(model.game);
  if (deficit <= 0) return 0;
  return deficit * model.totalCombinations / shareFactor;
}

// ---------------------------------------------------------------------------
// Генератор
// ---------------------------------------------------------------------------

/** Частичный Фишер—Йетс: равномерная выборка `need` из `work` (на месте). */
function sampleUniform(work, need) {
  for (let i = 0; i < need; i += 1) {
    const j = i + Math.floor(Math.random() * (work.length - i));
    [work[i], work[j]] = [work[j], work[i]];
  }
  return work.slice(0, need);
}

/** Взвешенная выборка без возвращения (Эфраимидис—Спиракис). */
function sampleWeighted(work, need, weights) {
  return work
    .map((n) => [Math.random() ** (1 / Math.max(weights[n - 1], 1e-9)), n])
    .sort((a, b) => b[0] - a[0])
    .slice(0, need)
    .map(([, n]) => n);
}

export function randomTicket(game) {
  return game.fields.map((f) => {
    const work = Array.from({ length: f.pool }, (_, i) => i + 1);
    return sampleUniform(work, f.pick).sort((a, b) => a - b);
  });
}

/**
 * Отбор наименее популярных билетов из равномерной выборки.
 *
 * Фильтрация не меняет вероятность выигрыша: каждый уцелевший билет остаётся
 * ровно так же вероятен, как любой другой. include/exclude относятся к
 * главному полю.
 *
 * numberWeights — оценки нейросети по полям (массив массивов, индекс n-1).
 * Если заданы, кандидаты выбираются с перевесом в сторону чисел, которые сеть
 * считает вероятнее, а в рейтинге популярность делится на оценку сети.
 */
export function generate(model, options = {}) {
  const {
    count = 5,
    include = [],
    exclude = [],
    candidates = 12000,
    maxOverlap = null,
    numberWeights = null,
  } = options;

  const game = model.game;
  const main = game.fields[0];
  const fixed = [...new Set(include)].sort((a, b) => a - b);
  const excluded = new Set(exclude);
  if (fixed.some((n) => excluded.has(n))) {
    throw new Error('Число нельзя одновременно включить и исключить');
  }
  if (fixed.length > main.pick) {
    throw new Error(`Можно зафиксировать не больше ${main.pick} чисел`);
  }

  const pools = game.fields.map((f, i) => {
    const out = [];
    for (let n = 1; n <= f.pool; n += 1) {
      if (i === 0 && (excluded.has(n) || fixed.includes(n))) continue;
      out.push(n);
    }
    return out;
  });
  const needs = game.fields.map((f, i) => (i === 0 ? f.pick - fixed.length : f.pick));
  if (pools[0].length < needs[0]) throw new Error('После ограничений осталось мало чисел');

  const aiMeans = numberWeights
    ? pools.map((pool, i) => pool.reduce((s, n) => s + numberWeights[i][n - 1], 0) / pool.length)
    : null;

  const scored = [];
  const seen = new Set();
  for (let iter = 0; iter < candidates; iter += 1) {
    const ticket = pools.map((pool, i) => {
      const drawn = numberWeights
        ? sampleWeighted(pool, needs[i], numberWeights[i])
        : sampleUniform(pool, needs[i]);
      return (i === 0 ? [...fixed, ...drawn] : drawn).sort((a, b) => a - b);
    });
    const key = ticket.map((f) => f.join(',')).join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    const breakdown = model.breakdown(ticket);
    const weight = Object.values(breakdown).reduce((a, b) => a * b, 1);
    let aiScore = 1;
    if (numberWeights) {
      ticket.forEach((combo, i) => {
        for (const n of combo) aiScore *= numberWeights[i][n - 1] / aiMeans[i];
      });
    }
    scored.push({ ticket, combo: ticket[0], weight, breakdown, aiScore, rank: weight / aiScore });
  }

  scored.sort((a, b) => a.rank - b.rank);
  if (maxOverlap === null) return scored.slice(0, count);

  const chosen = [];
  for (const cand of scored) {
    const ok = chosen.every((other) => {
      const s = new Set(other.combo);
      return cand.combo.filter((n) => s.has(n)).length <= maxOverlap;
    });
    if (ok) chosen.push(cand);
    if (chosen.length === count) break;
  }
  return chosen;
}

/** Доля случайных билетов популярнее данного (1.0 = непопулярнее всех). */
export function unpopularityPercentile(model, ticket, samples = 4000) {
  const target = model.weight(ticket);
  let heavier = 0;
  for (let iter = 0; iter < samples; iter += 1) {
    if (model.weight(randomTicket(model.game)) > target) heavier += 1;
  }
  return heavier / samples;
}
