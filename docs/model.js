/**
 * Модель популярности и расчёт EV — порт scripts/lotto/popularity.py и ev.py.
 *
 * Логика продублирована на двух языках сознательно: Python нужен для сборки
 * данных и тестов, JS — чтобы Mini App считал всё на клиенте и работал без
 * сервера на GitHub Pages. Идентичность двух реализаций проверяется тестом
 * tests/test_parity.py по общему набору векторов.
 *
 * Параметры модели приходят из docs/data/6x45_model.json — единственного
 * источника правды (генерируется из model_params.json).
 */

export const FACTOR_LABELS = {
  numbers: 'Выбор отдельных чисел',
  consecutive: 'Подряд идущие числа',
  arithmetic: 'Арифметическая прогрессия',
  grid: 'Узор на бланке',
  sum: 'Сумма чисел',
  parity: 'Чётные / нечётные',
  range: 'Узкий диапазон',
  history: 'Повтор прошлого тиража',
};

export function combinations(n, k) {
  if (k < 0 || k > n) return 0;
  let out = 1;
  for (let i = 0; i < k; i += 1) out = (out * (n - i)) / (i + 1);
  return Math.round(out);
}

/** Модель, собранная из JSON. Хранит параметры и предвычисленные структуры. */
export class PopularityModel {
  constructor(payload) {
    this.game = payload.game;
    this.cfg = payload.popularity;
    this.meanWeight = payload.mean_weight;
    this.totalCombinations =
      payload.game.total_combinations ||
      combinations(payload.game.pool, payload.game.pick);

    this.numberOverrides = new Map(
      Object.entries(this.cfg.number_weights.overrides).map(([k, v]) => [
        Number(k),
        v,
      ]),
    );
    // Для фактора «повтор выпавшей комбинации»: точные совпадения ищем по
    // ключу, «5 из 6» — перебором, но только по последним тиражам.
    this.recentWinners = (payload.recent_winners || []).map((c) =>
      [...c].sort((a, b) => a - b),
    );
    this.recentWinnerKeys = new Set(this.recentWinners.map((c) => c.join(',')));
  }

  numberFactor(combo) {
    const nw = this.cfg.number_weights;
    let out = 1;
    for (const n of combo) {
      if (this.numberOverrides.has(n)) out *= this.numberOverrides.get(n);
      else if (n <= 12) out *= nw.base_1_12;
      else if (n <= 31) out *= nw.base_13_31;
      else out *= nw.base_32_45;
    }
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

  gridFactor(combo) {
    const c = this.cfg.grid_pattern;
    const cols = this.game.slip.cols;
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

  historyFactor(combo) {
    if (!this.recentWinners.length) return 1;
    const c = this.cfg.past_winner_repeat;
    if (this.recentWinnerKeys.has(combo.join(','))) return c.exact_repeat_multiplier;
    const need = combo.length - 1;
    const target = new Set(combo);
    for (const old of this.recentWinners) {
      let hits = 0;
      for (const n of old) if (target.has(n)) hits += 1;
      if (hits >= need) return c.five_of_six_repeat_multiplier;
    }
    return 1;
  }

  breakdown(input) {
    const combo = [...input].sort((a, b) => a - b);
    return {
      numbers: this.numberFactor(combo),
      consecutive: this.consecutiveFactor(combo),
      arithmetic: this.arithmeticFactor(combo),
      grid: this.gridFactor(combo),
      sum: this.sumFactor(combo),
      parity: this.parityFactor(combo),
      range: this.rangeFactor(combo),
      history: this.historyFactor(combo),
    };
  }

  weight(combo) {
    return Object.values(this.breakdown(combo)).reduce((a, b) => a * b, 1);
  }

  /** Оценка доли всех ставок тиража, приходящейся на эту комбинацию. */
  pickShare(combo) {
    return this.weight(combo) / (this.meanWeight * this.totalCombinations);
  }
}

// ---------------------------------------------------------------------------
// Ожидаемая выплата
// ---------------------------------------------------------------------------

export function matchProbability(game, matched) {
  const { pick, pool } = game;
  if (matched < 0 || matched > pick) return 0;
  return (
    (combinations(pick, matched) * combinations(pool - pick, pick - matched)) /
    combinations(pool, pick)
  );
}

/** E[1/(1+K)] для K ~ Poisson(lam): ожидаемая доля джекпота. */
export function expectedShareFactor(lam) {
  if (lam <= 1e-12) return 1;
  return (1 - Math.exp(-lam)) / lam;
}

export function evaluateEV(model, combo, jackpotRub, players) {
  const game = model.game;
  const n = players || game.typical_players_per_draw;
  const q = model.pickShare(combo);

  const lam = Math.max(n - 1, 0) * q;
  const share = expectedShareFactor(lam);
  const lamBase = Math.max(n - 1, 0) / model.totalCombinations;
  const shareBase = expectedShareFactor(lamBase);

  let evFixed = 0;
  for (const [k, prize] of Object.entries(game.prizes_rub)) {
    if (prize === null) continue;
    evFixed += matchProbability(game, Number(k)) * Number(prize);
  }

  const pJackpot = matchProbability(game, game.pick);
  const evJackpot = pJackpot * jackpotRub * share;
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
  const game = model.game;
  let evFixed = 0;
  for (const [k, prize] of Object.entries(game.prizes_rub)) {
    if (prize === null) continue;
    evFixed += matchProbability(game, Number(k)) * Number(prize);
  }
  const deficit = game.ticket_price_rub - evFixed;
  if (deficit <= 0) return 0;
  return deficit / (matchProbability(game, game.pick) * shareFactor);
}

// ---------------------------------------------------------------------------
// Генератор
// ---------------------------------------------------------------------------

/**
 * Отбор наименее популярных комбинаций из равномерной выборки.
 *
 * Фильтрация не меняет вероятность выигрыша: каждая уцелевшая комбинация
 * остаётся ровно так же вероятна, как любая другая. Мы выбираем среди
 * равновероятных ту, которую вряд ли поставил кто-то ещё.
 */
export function generate(model, options = {}) {
  const {
    count = 5,
    include = [],
    exclude = [],
    candidates = 12000,
    maxOverlap = null,
    // Оценки ИИ по числам (индекс n-1). Если заданы, кандидаты выбираются
    // с перевесом в сторону чисел, которые сеть считает вероятнее, а в
    // рейтинге популярность делится на суммарную оценку сети.
    numberWeights = null,
  } = options;

  const game = model.game;
  const fixed = [...new Set(include)].sort((a, b) => a - b);
  const excluded = new Set(exclude);
  if (fixed.some((n) => excluded.has(n))) {
    throw new Error('Число нельзя одновременно включить и исключить');
  }
  if (fixed.length > game.pick) {
    throw new Error(`Можно зафиксировать не больше ${game.pick} чисел`);
  }

  const pool = [];
  for (let n = 1; n <= game.pool; n += 1) {
    if (!excluded.has(n) && !fixed.includes(n)) pool.push(n);
  }
  const need = game.pick - fixed.length;
  if (pool.length < need) throw new Error('После ограничений осталось мало чисел');

  const scored = [];
  const seen = new Set();
  const work = [...pool];

  let aiMean = 1;
  if (numberWeights) {
    aiMean = pool.reduce((s, n) => s + numberWeights[n - 1], 0) / pool.length;
  }

  for (let iter = 0; iter < candidates; iter += 1) {
    let drawn;
    if (numberWeights) {
      // Взвешенная выборка без возвращения (Эфраимидис—Спиракис):
      // ключ u^(1/w), берём `need` наибольших.
      drawn = work
        .map((n) => [Math.random() ** (1 / Math.max(numberWeights[n - 1], 1e-9)), n])
        .sort((a, b) => b[0] - a[0])
        .slice(0, need)
        .map(([, n]) => n);
    } else {
      // Частичный Фишер—Йетс: равномерная выборка `need` из пула.
      for (let i = 0; i < need; i += 1) {
        const j = i + Math.floor(Math.random() * (work.length - i));
        [work[i], work[j]] = [work[j], work[i]];
      }
      drawn = work.slice(0, need);
    }
    const combo = [...fixed, ...drawn].sort((a, b) => a - b);
    const key = combo.join(',');
    if (seen.has(key)) continue;
    seen.add(key);
    const breakdown = model.breakdown(combo);
    const weight = Object.values(breakdown).reduce((a, b) => a * b, 1);
    let aiScore = 1;
    if (numberWeights) {
      for (const n of combo) aiScore *= numberWeights[n - 1] / aiMean;
    }
    scored.push({ combo, weight, breakdown, aiScore, rank: weight / aiScore });
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

/** Доля случайных комбинаций популярнее данной (1.0 = непопулярнее всех). */
export function unpopularityPercentile(model, combo, samples = 4000) {
  const target = model.weight(combo);
  const game = model.game;
  const work = [];
  for (let n = 1; n <= game.pool; n += 1) work.push(n);
  let heavier = 0;
  for (let iter = 0; iter < samples; iter += 1) {
    for (let i = 0; i < game.pick; i += 1) {
      const j = i + Math.floor(Math.random() * (work.length - i));
      [work[i], work[j]] = [work[j], work[i]];
    }
    const other = work.slice(0, game.pick).sort((a, b) => a - b);
    if (model.weight(other) > target) heavier += 1;
  }
  return heavier / samples;
}
