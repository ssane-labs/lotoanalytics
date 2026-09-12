/**
 * Mini App: подбор непопулярных комбинаций, разбор своей комбинации,
 * статистика тиражей и проверка предсказуемости.
 *
 * Всё считается в браузере: на GitHub Pages нет бэкенда, а данные приезжают
 * статическими JSON из docs/data/, которые собирает GitHub Actions.
 */

import {
  PopularityModel,
  FACTOR_LABELS,
  generate,
  evaluateEV,
  breakevenJackpot,
  unpopularityPercentile,
} from './model.js';

const GAME = '6x45';
const DEFAULT_JACKPOT = 300_000_000;

const tg = window.Telegram?.WebApp;
const state = {
  model: null,
  meta: null,
  stats: null,
  proof: null,
  selected: new Set(),
  jackpot: DEFAULT_JACKPOT,
  genCount: 1,
};

// --------------------------------------------------------------- утилиты

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
};

const nf = new Intl.NumberFormat('ru-RU');
/** Дробное число с запятой — как принято в русской типографике. */
const fmtDec = (n, digits = 2) => n.toFixed(digits).replace('.', ',');
const fmtInt = (n) => nf.format(Math.round(n));
const fmtMoney = (n) => `${nf.format(Math.round(n))} ₽`;

function fmtBig(n) {
  if (n >= 1e9) return `${fmtDec(n / 1e9, 1)} млрд ₽`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(0)} млн ₽`;
  return fmtMoney(n);
}

/** Читаемая запись «1 к 8 145 060». */
const fmtOdds = (total) => `1 к ${nf.format(total)}`;

function haptic(kind = 'light') {
  try {
    tg?.HapticFeedback?.impactOccurred?.(kind);
  } catch {
    /* вне Telegram вибрации нет — это нормально */
  }
}

async function loadJSON(name, { optional = false } = {}) {
  // cache-busting по дате: данные обновляются раз в сутки, но Pages кэширует.
  const stamp = new Date().toISOString().slice(0, 10);
  try {
    const res = await fetch(`data/${name}?v=${stamp}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    if (optional) return null;
    throw new Error(`Не удалось загрузить data/${name}: ${err.message}`);
  }
}

// ------------------------------------------------------------ навигация

function initTabs() {
  const tabs = [...document.querySelectorAll('.tab')];
  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      const target = tab.dataset.view;
      tabs.forEach((t) => t.classList.toggle('is-active', t === tab));
      document.querySelectorAll('.view').forEach((view) => {
        view.hidden = view.id !== `view-${target}`;
      });
      window.scrollTo({ top: 0 });
      haptic('light');
    });
  });
}

// ------------------------------------------------------- общие фрагменты

/**
 * Шкала непопулярности. Показывает, какую долю случайных комбинаций наша
 * комбинация обходит по «незаметности» для других игроков.
 */
function gaugeNode(percentile) {
  const wrap = el('div', 'gauge');
  const track = el('div', 'gauge__track');
  const fill = el('div', 'gauge__fill');
  const pct = Math.round(percentile * 100);
  fill.style.width = `${Math.max(pct, 2)}%`;
  if (pct < 40) fill.classList.add('is-bad');
  else if (pct < 70) fill.classList.add('is-mid');
  track.append(fill);

  const label = el('div', 'gauge__label');
  label.append(el('span', null, 'Незаметность для других игроков'), el('span', null, `${pct} / 100`));
  wrap.append(track, label);
  return wrap;
}

function kvNode(key, value, tone) {
  const row = el('div', 'kv');
  row.append(el('span', 'kv__k', key));
  const v = el('span', 'kv__v', value);
  if (tone) v.classList.add(tone === 'good' ? 'is-good' : 'is-bad');
  row.append(v);
  return row;
}

function ballsNode(combo, soft = false) {
  const wrap = el('div', 'ticket__nums');
  combo.forEach((n) => wrap.append(el('span', soft ? 'ball ball--soft' : 'ball', String(n))));
  return wrap;
}

/**
 * Раскрытие «почему такая оценка»: показываем только факторы, которые реально
 * сдвинули вес. Множитель > 1 означает «так делают многие» — это против нас.
 */
function whyNode(breakdown) {
  const details = el('details', 'why');
  details.append(el('summary', null, 'Из чего сложилась оценка'));
  const entries = Object.entries(breakdown)
    .filter(([, v]) => Math.abs(v - 1) > 0.01)
    .sort((a, b) => b[1] - a[1]);

  if (!entries.length) {
    details.append(el('p', 'muted', 'Ни один шаблон не сработал — комбинация ничем не выделяется.'));
    return details;
  }
  entries.forEach(([key, value]) => {
    const worse = value > 1;
    details.append(
      kvNode(
        FACTOR_LABELS[key] || key,
        `${worse ? '×' : '÷'}${fmtDec(worse ? value : 1 / value)}`,
        worse ? 'bad' : 'good',
      ),
    );
  });
  details.append(
    el('p', 'muted', '× — так выбирают чаще (плохо для нас). ÷ — так выбирают реже (хорошо).'),
  );
  return details;
}

/** Карточка с полным разбором одной комбинации. */
function analysisCard(combo, breakdown, { title, percentile } = {}) {
  const card = el('div', 'ticket');
  if (title) card.append(el('h3', null, title));
  card.append(ballsNode(combo));

  const pct = percentile ?? unpopularityPercentile(state.model, combo, 3000);
  card.append(gaugeNode(pct));

  const ev = evaluateEV(state.model, combo, state.jackpot);
  const rivals = ev.expectedCoWinners;

  card.append(
    kvNode('Ожидаемых совладельцев джекпота', rivals < 0.01 ? 'меньше 0,01' : fmtDec(rivals)),
    kvNode(
      'Ваша доля джекпота при выигрыше',
      `${Math.round(ev.shareFactor * 100)}%`,
      ev.shareFactor > 0.8 ? 'good' : ev.shareFactor < 0.4 ? 'bad' : null,
    ),
    kvNode('Против средней комбинации', `×${fmtDec(ev.payoutAdvantage)}`,
      ev.payoutAdvantage >= 1 ? 'good' : 'bad'),
    kvNode('Ожидаемая выплата с билета', fmtMoney(ev.evTotal + state.model.game.ticket_price_rub)),
  );

  let tone = 'good';
  let text = 'Такую комбинацию почти наверняка не поставил больше никто — джекпот делить не придётся.';
  if (ev.shareFactor < 0.4) {
    tone = 'bad';
    text = `Очень популярный шаблон. При выигрыше вы получите примерно ${Math.round(ev.shareFactor * 100)}% джекпота — остальное уйдёт тем, кто выбрал то же самое.`;
  } else if (ev.shareFactor < 0.85) {
    tone = 'warn';
    text = 'Комбинация умеренно популярна. Есть шанс поделить джекпот с кем-то ещё.';
  }
  card.append(el('div', `verdict verdict--${tone}`, text));
  card.append(whyNode(breakdown));
  return card;
}

// -------------------------------------------------------------- генератор

function initGenerator() {
  const counts = $('#gen-count');
  counts.addEventListener('click', (event) => {
    const chip = event.target.closest('.chip');
    if (!chip) return;
    [...counts.children].forEach((c) => c.classList.toggle('is-active', c === chip));
    state.genCount = Number(chip.dataset.count);
    haptic('light');
  });

  $('#gen-run').addEventListener('click', runGenerator);
}

function parseNumbers(raw, pool) {
  const nums = (raw.match(/\d+/g) || []).map(Number);
  const bad = nums.filter((n) => n < 1 || n > pool);
  if (bad.length) throw new Error(`Вне диапазона 1–${pool}: ${bad.join(', ')}`);
  return [...new Set(nums)];
}

function runGenerator() {
  const errBox = $('#gen-error');
  const results = $('#gen-results');
  errBox.hidden = true;
  results.replaceChildren(el('p', 'skeleton', 'Перебираем варианты…'));

  // Отдаём кадр браузеру, чтобы успел отрисоваться индикатор.
  setTimeout(() => {
    try {
      const pool = state.model.game.pool;
      const include = parseNumbers($('#gen-include').value, pool);
      const exclude = parseNumbers($('#gen-exclude').value, pool);
      const spread = $('#gen-spread').checked;

      const picks = generate(state.model, {
        count: state.genCount,
        include,
        exclude,
        candidates: 15000,
        maxOverlap: spread && state.genCount > 1 ? 2 : null,
      });

      if (!picks.length) throw new Error('Не удалось подобрать комбинацию с такими ограничениями');

      results.replaceChildren();
      picks.forEach((pick, i) => {
        results.append(
          analysisCard(pick.combo, pick.breakdown, {
            title: picks.length > 1 ? `Билет ${i + 1}` : null,
          }),
        );
      });
      results.append(
        el(
          'p',
          'muted',
          'Каждая из этих комбинаций выигрывает ровно с той же вероятностью, ' +
            'что и любая другая. Отличие только в том, сколько человек поставили ' +
            'то же самое.',
        ),
      );
      haptic('medium');
    } catch (err) {
      results.replaceChildren();
      errBox.textContent = err.message;
      errBox.hidden = false;
    }
  }, 16);
}

// ---------------------------------------------------------- свой билет

function initSlip() {
  const slip = $('#slip');
  const { pool } = state.model.game;
  for (let n = 1; n <= pool; n += 1) {
    const cell = el('button', 'slip__cell', String(n));
    cell.type = 'button';
    cell.dataset.n = String(n);
    cell.setAttribute('aria-pressed', 'false');
    slip.append(cell);
  }

  slip.addEventListener('click', (event) => {
    const cell = event.target.closest('.slip__cell');
    if (!cell) return;
    const n = Number(cell.dataset.n);
    if (state.selected.has(n)) state.selected.delete(n);
    else if (state.selected.size < state.model.game.pick) state.selected.add(n);
    else return;
    haptic('light');
    renderSlip();
  });

  $('#slip-clear').addEventListener('click', () => {
    state.selected.clear();
    renderSlip();
  });

  $('#slip-random').addEventListener('click', () => {
    const { pick, pool: size } = state.model.game;
    const bag = Array.from({ length: size }, (_, i) => i + 1);
    for (let i = 0; i < pick; i += 1) {
      const j = i + Math.floor(Math.random() * (bag.length - i));
      [bag[i], bag[j]] = [bag[j], bag[i]];
    }
    state.selected = new Set(bag.slice(0, pick));
    haptic('medium');
    renderSlip();
  });

  renderSlip();
}

function renderSlip() {
  const { pick } = state.model.game;
  const full = state.selected.size === pick;

  document.querySelectorAll('.slip__cell').forEach((cell) => {
    const on = state.selected.has(Number(cell.dataset.n));
    cell.classList.toggle('is-on', on);
    cell.setAttribute('aria-pressed', String(on));
    cell.disabled = full && !on;
  });
  $('#slip-counter').textContent = `Выбрано ${state.selected.size} из ${pick}`;

  const box = $('#check-result');
  if (!full) {
    box.replaceChildren(
      el('p', 'skeleton', `Отметьте ${pick - state.selected.size} чис${
        pick - state.selected.size === 1 ? 'ло' : 'ла'
      }, чтобы увидеть разбор.`),
    );
    return;
  }

  const combo = [...state.selected].sort((a, b) => a - b);
  box.replaceChildren(
    analysisCard(combo, state.model.breakdown(combo), { title: 'Ваша комбинация' }),
    jackpotControl(),
  );
}

/** Поле «размер джекпота»: от него зависит вся арифметика выплаты. */
function jackpotControl() {
  const card = el('div', 'card');
  card.append(el('h3', null, 'Размер джекпота'));
  card.append(
    el('p', 'muted', 'Подставьте текущий суперприз — расчёт доли пересчитается.'),
  );
  const input = el('input');
  input.type = 'text';
  input.inputMode = 'numeric';
  input.value = nf.format(state.jackpot);
  input.addEventListener('change', () => {
    const parsed = Number((input.value.match(/\d/g) || []).join(''));
    if (parsed > 0) {
      state.jackpot = parsed;
      renderSlip();
    }
  });
  card.append(input);
  return card;
}

// ------------------------------------------------------------ статистика

function renderStats() {
  const stats = state.stats;
  const banner = $('#uniformity-banner');
  const uni = stats.uniformity;

  banner.className = `banner ${uni.p_value >= 0.01 ? 'banner--good' : 'banner--warn'}`;
  banner.replaceChildren(
    el('strong', null, `Проверка хи-квадрат: p = ${String(uni.p_value).replace('.', ',')}. `),
    document.createTextNode(uni.verdict),
  );

  // Гистограмма частот.
  const chart = $('#freq-chart');
  chart.replaceChildren();
  const counts = stats.numbers.map((x) => x.count);
  const maxCount = Math.max(...counts, 1);
  const expected = stats.numbers[0]?.expected || 0;
  const hot = new Set(stats.hot.map((x) => x.n));
  const cold = new Set(stats.cold.map((x) => x.n));

  stats.numbers.forEach((item) => {
    const bar = el('div', 'freq__bar');
    bar.style.height = `${(item.count / maxCount) * 100}%`;
    if (hot.has(item.n)) bar.classList.add('is-hot');
    if (cold.has(item.n)) bar.classList.add('is-cold');
    bar.title = `${item.n}: ${item.count} раз (ожидалось ${item.expected})`;
    chart.append(bar);
  });
  const mean = el('div', 'freq__mean');
  mean.style.bottom = `${(expected / maxCount) * 100}%`;
  chart.append(mean);

  const fillList = (sel, items, suffix) => {
    const list = $(sel);
    list.replaceChildren();
    items.forEach((item) => {
      const li = el('li');
      li.append(el('span', 'ball ball--soft', String(item.n)));
      li.append(el('span', 'muted', suffix(item)));
      list.append(li);
    });
  };
  fillList('#list-hot', stats.hot, (x) => `${x.count} раз (${x.deviation > 0 ? '+' : ''}${x.deviation} к среднему)`);
  fillList('#list-cold', stats.cold, (x) => `${x.count} раз (${x.deviation} к среднему)`);
  fillList('#list-overdue', stats.overdue, (x) => `${x.gap} тиражей назад`);

  const facts = $('#facts');
  facts.replaceChildren();
  const addFact = (term, value) => {
    const row = el('div');
    row.append(el('dt', null, term), el('dd', null, value));
    facts.append(row);
  };
  addFact('Тиражей в выборке', fmtInt(stats.draws_analyzed));
  addFact(
    'Тиражей с парой соседних чисел',
    `${Math.round(stats.consecutive_share * 100)}%`,
  );
  addFact('Средняя сумма шести чисел', String(stats.sums.mean).replace('.', ','));
  addFact('Диапазон сумм (90% тиражей)', `${stats.sums.p05} – ${stats.sums.p95}`);
  const balanced = stats.parity['3_even_3_odd'] || 0;
  addFact(
    'Тиражей с балансом 3 чётных / 3 нечётных',
    `${Math.round((balanced / stats.draws_analyzed) * 100)}%`,
  );
}

// -------------------------------------------------------------- проверка

function renderProof() {
  const tbody = $('#proof-table tbody');
  tbody.replaceChildren();

  if (!state.proof) {
    $('#proof-note').textContent =
      'Результаты бэктеста ещё не собраны. Запустите scripts/verify_randomness.py.';
    return;
  }

  $('#proof-baseline').textContent = fmtDec(state.proof.expected_by_chance, 3);

  const rows = Object.entries(state.proof.results).sort(
    (a, b) => (b[1].mean_matches || 0) - (a[1].mean_matches || 0),
  );
  rows.forEach(([name, res]) => {
    const tr = el('tr');
    tr.append(el('td', null, name));
    tr.append(el('td', null, fmtDec(res.mean_matches ?? 0, 3)));
    const p = el('td', res.significant ? 'is-flag' : null,
      fmtDec(res.p_value ?? 1, 3));
    tr.append(p);
    tbody.append(tr);
  });

  $('#proof-note').textContent = state.proof.any_significant
    ? 'Одна из стратегий формально прошла порог значимости. При восьми проверках сразу это ожидаемая случайность, а не находка.'
    : `Ни одна стратегия не обошла случайный выбор. Проверено на ${fmtInt(state.proof.draws)} тиражах.`;

  // Экономика игры — тоже часть честного разговора.
  const evFacts = $('#ev-facts');
  evFacts.replaceChildren();
  const addFact = (term, value) => {
    const row = el('div');
    row.append(el('dt', null, term), el('dd', null, value));
    evFacts.append(row);
  };
  const game = state.model.game;
  const sample = evaluateEV(state.model, [4, 17, 23, 31, 38, 44], state.jackpot);
  addFact('Цена билета', fmtMoney(game.ticket_price_rub));
  addFact('Шанс сорвать джекпот', fmtOdds(state.model.totalCombinations));
  addFact('Возврат игроку при джекпоте ' + fmtBig(state.jackpot),
    `${Math.round(sample.rtp * 100)}%`);
  addFact('Джекпот, при котором билет окупается', fmtBig(breakevenJackpot(state.model)));
}

// ------------------------------------------------------------------ старт

function renderMeta() {
  const { meta, model } = state;
  $('#game-title').textContent = model.game.title;
  $('#odds-line').textContent = fmtOdds(model.totalCombinations);

  const when = new Date(meta.generated_at);
  const date = Number.isNaN(when.getTime())
    ? meta.generated_at
    : when.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
  $('#data-meta').textContent =
    `${fmtInt(meta.draws_count)} тиражей · обновлено ${date}`;

  if (meta.synthetic) $('#synthetic-banner').hidden = false;
}

function fail(message) {
  $('#app').hidden = true;
  const box = $('#fatal');
  box.hidden = false;
  box.textContent = message;
}

async function main() {
  try {
    tg?.ready?.();
    tg?.expand?.();
    tg?.setHeaderColor?.('secondary_bg_color');
  } catch {
    /* открыто вне Telegram */
  }

  initTabs();

  try {
    const [meta, modelData, stats, proof] = await Promise.all([
      loadJSON('meta.json'),
      loadJSON(`${GAME}_model.json`),
      loadJSON(`${GAME}_stats.json`),
      loadJSON(`${GAME}_randomness.json`, { optional: true }),
    ]);

    state.meta = meta;
    state.model = new PopularityModel(modelData);
    state.stats = stats;
    state.proof = proof;

    renderMeta();
    initGenerator();
    initSlip();
    renderStats();
    renderProof();
  } catch (err) {
    fail(
      `${err.message}\n\nЕсли вы открыли файл напрямую с диска, запустите ` +
        'локальный сервер: python -m http.server 8000 из папки docs.',
    );
  }
}

main();
