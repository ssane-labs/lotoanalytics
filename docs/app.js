/**
 * Mini App: подбор непопулярных комбинаций, разбор своей комбинации и
 * история тиражей.
 *
 * Вся математика считается в браузере: на GitHub Pages нет бэкенда, данные
 * приезжают статическими JSON из docs/data/. Воркер нужен только для кошелька
 * прокруток — без него приложение работает, просто с бесплатным лимитом.
 *
 * Билет везде — массив полей: [[…6 чисел]] в «6 из 45», два поля по четыре
 * числа в «4 из 20», пять чисел и бонусный номер в «5 из 36».
 */

import {
  PopularityModel,
  FACTOR_LABELS,
  generate,
  evaluateEV,
  unpopularityPercentile,
} from './model.js?v=89671c74';
import { CONFIG } from './config.js?v=89671c74';
import { DrawAI } from './ai.js?v=89671c74';
import { Wallet, spinsWord } from './wallet.js?v=89671c74';
import { NumberField } from './numfield.js?v=89671c74';

const DEFAULT_GAME = '6x45';
const GAME_STORAGE_KEY = 'loto.game';
const UNLOCKED_KEY = 'loto.unlocked';

const tg = window.Telegram?.WebApp;
const wallet = new Wallet(CONFIG, tg);

const state = {
  /** Список игр из data/meta.json и выбранная игра. */
  games: [],
  gameKey: DEFAULT_GAME,
  model: null,
  meta: null,
  stats: null,
  /** Сырой _model.json: в нём сведения об обучении модели популярности. */
  modelData: null,
  /** Нейросеть текущей игры: сырой JSON и модель (null, если не обучена). */
  aiData: null,
  ai: null,
  genMode: 'classic',
  /** Отмеченные на бланке числа — по множеству на каждое поле. */
  selected: [],
  jackpot: 300_000_000,
  genCount: 1,
  /** Поля «мои числа» и «убрать» — компонент с числами-фишками. */
  includeField: null,
  excludeField: null,
  /** Комбинации, разбор которых уже оплачен. Второй раз не списываем. */
  unlocked: loadUnlocked(),
  busy: false,
};

const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

// --------------------------------------------------------------- утилиты

const $ = (sel) => document.querySelector(sel);

const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
};

/** Иконка из спрайта в index.html. */
function icon(name, size = 16) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.5');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

const nf = new Intl.NumberFormat('ru-RU');
const fmtDec = (n, digits = 2) => n.toFixed(digits).replace('.', ',');
const fmtInt = (n) => nf.format(Math.round(n));
const fmtMoney = (n) => `${nf.format(Math.round(n))} ₽`;
const fmtOdds = (total) => `1 к ${nf.format(total)}`;

function fmtBig(n) {
  if (n >= 1e9) return `${fmtDec(n / 1e9, 1)} млрд`;
  if (n >= 1e6) return `${Math.round(n / 1e6)} млн`;
  return fmtInt(n);
}

function haptic(kind = 'light') {
  try {
    tg?.HapticFeedback?.impactOccurred?.(kind);
  } catch { /* вне Telegram вибрации нет */ }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function loadJSON(name, { optional = false } = {}) {
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

function loadUnlocked() {
  try {
    return new Set(JSON.parse(localStorage.getItem(UNLOCKED_KEY) || '[]'));
  } catch {
    return new Set();
  }
}

function rememberUnlocked(key) {
  state.unlocked.add(key);
  try {
    // Держим только последние полсотни: список нужен, чтобы не списать дважды,
    // а не чтобы хранить историю навсегда.
    const all = [...state.unlocked].slice(-50);
    localStorage.setItem(UNLOCKED_KEY, JSON.stringify(all));
  } catch { /* приватный режим — переживём */ }
}

// ---------------------------------------------------- строительные блоки

function section(eyebrow, { accent = false } = {}) {
  const node = el('div', 'section');
  if (eyebrow) node.append(el('span', `eyebrow${accent ? ' eyebrow--accent' : ''}`, eyebrow));
  return node;
}

/** Сетка «подпись / значение» — основной способ показа данных в этом языке. */
function specGrid(items) {
  const grid = el('div', 'spec');
  items.forEach(({ k, v, tone }) => {
    const cell = el('div', 'spec__cell');
    cell.append(el('span', 'spec__k', k));
    cell.append(el('span', `spec__v${tone ? ` is-${tone}` : ''}`, v));
    grid.append(cell);
  });
  return grid;
}

function rowsList(items) {
  const dl = el('dl', 'rows');
  items.forEach(({ k, v, tone }) => {
    const row = el('div');
    row.append(el('dt', null, k));
    row.append(el('dd', tone ? `is-${tone}` : null, v));
    dl.append(row);
  });
  return dl;
}

/**
 * Шары билета. Второе поле и бонусный номер идут после «+» другим цветом:
 * это отдельный набор чисел, а не продолжение первого.
 */
function ballsNode(ticket, { accent = false, roll = false, quiet = false } = {}) {
  const fields = Array.isArray(ticket[0]) ? ticket : [ticket];
  const wrap = el('div', `balls${fields.length > 1 ? ' balls--multi' : ''}`);
  const items = [];
  fields.forEach((combo, f) => {
    if (f > 0) wrap.append(el('span', 'balls__plus', '+'));
    combo.forEach((n) => {
      let cls = 'ball';
      if (f > 0) cls += ' ball--extra';
      else if (accent) cls += ' ball--accent';
      if (quiet) cls += ' ball--quiet';
      const b = el('div', cls, String(n));
      b.style.animationDelay = `${items.length * 45}ms`;
      wrap.append(b);
      items.push({ node: b, value: n, pool: state.model?.game?.fields?.[f]?.pool || 45 });
    });
  });
  if (roll) rollBalls(items);
  return wrap;
}

/**
 * Числа на шарах «докручиваются» до результата.
 *
 * Один общий цикл на все шары экрана: отдельный requestAnimationFrame на
 * каждый шар при десяти билетах превращается в шестьдесят параллельных
 * циклов и заметно греет телефон.
 */
const rolling = [];
let rollLoop = null;

function rollBalls(items) {
  if (reduceMotion) return;
  const now = performance.now();
  items.forEach(({ node, value, pool }, i) => {
    node.classList.add('is-rolling');
    rolling.push({ node, value, until: now + 340 + i * 75, pool });
  });
  if (!rollLoop) rollLoop = requestAnimationFrame(rollTick);

  // Страховка. requestAnimationFrame замирает, когда вкладка уходит в фон, а
  // вместе с ним замирает и докрутка — шар так и остался бы показывать
  // случайное число вместо подобранного. Таймер доводит числа до места
  // независимо от того, рисует ли браузер кадры.
  const lastLanding = 340 + (items.length - 1) * 75 + 120;
  setTimeout(() => settleRolling({ force: true }), lastLanding);
}

/** Один шаг докрутки: что долетело — ставим на место, остальным крутим числа. */
function settleRolling({ force = false } = {}) {
  const now = performance.now();
  for (let i = rolling.length - 1; i >= 0; i -= 1) {
    const item = rolling[i];
    if (force || !item.node.isConnected || now >= item.until) {
      item.node.textContent = String(item.value);
      item.node.classList.remove('is-rolling');
      item.node.classList.add('is-landed');
      rolling.splice(i, 1);
    } else {
      item.node.textContent = String(1 + Math.floor(Math.random() * item.pool));
    }
  }
}

function rollTick() {
  settleRolling();
  rollLoop = rolling.length ? requestAnimationFrame(rollTick) : null;
}

function meterNode(percentile) {
  const wrap = el('div', 'meter');
  const track = el('div', 'meter__track');
  const fill = el('div', 'meter__fill');
  const pct = Math.round(percentile * 100);
  fill.style.width = `${Math.max(pct, 1)}%`;
  track.append(fill);

  const label = el('div', 'meter__label');
  const right = el('span');
  right.append(el('b', null, String(pct)), document.createTextNode(' / 100'));
  label.append(el('span', null, 'Незаметность'), right);
  wrap.append(track, label);
  return wrap;
}

/** Раскрытие «из чего сложилась оценка» — только сработавшие факторы. */
function whyNode(breakdown) {
  const details = el('details', 'why');
  const summary = el('summary');
  summary.append(document.createTextNode('Из чего сложилась оценка'));
  const chev = icon('chevron', 12);
  chev.classList.add('chev');
  summary.append(chev);
  details.append(summary);

  const entries = Object.entries(breakdown)
    .filter(([, v]) => Math.abs(v - 1) > 0.01)
    .sort((a, b) => b[1] - a[1]);

  if (!entries.length) {
    details.append(el('p', 'muted', 'Ни один шаблон не сработал — комбинация ничем не выделяется.'));
    return details;
  }
  details.append(rowsList(entries.map(([key, value]) => {
    const worse = value > 1;
    return {
      k: FACTOR_LABELS[key] || key,
      v: `${worse ? '×' : '÷'}${fmtDec(worse ? value : 1 / value)}`,
      tone: worse ? 'accent' : 'good',
    };
  })));
  details.append(el('p', 'muted',
    '× — такие комбинации выбирают чаще среднего, ÷ — реже.'));
  return details;
}

/** Полный разбор одного билета. */
function analysisSection(ticket, breakdown, { title, roll = false } = {}) {
  const node = section(title || null);
  node.append(ballsNode(ticket, { accent: true, roll }));
  node.append(meterNode(unpopularityPercentile(state.model, ticket, 3000)));

  const ev = evaluateEV(state.model, ticket, state.jackpot);
  const rivals = ev.expectedCoWinners;
  // Во сколько раз чаще или реже среднего ставят этот билет — с учётом
  // автовыбора, который распределяет свою долю поровну.
  const density = ev.pickShare * state.model.totalCombinations;

  node.append(specGrid([
    {
      k: 'Ставят',
      v: `×${fmtDec(density)}`,
      tone: density < 0.95 ? 'good' : density > 1.5 ? 'accent' : null,
    },
    {
      k: 'Соперников',
      v: rivals < 0.01 ? '< 0,01' : fmtDec(rivals),
      tone: rivals < 0.5 ? 'good' : 'accent',
    },
    {
      k: 'Ваша доля',
      v: `${Math.round(ev.shareFactor * 100)}%`,
      tone: ev.shareFactor > 0.8 ? 'good' : ev.shareFactor < 0.4 ? 'accent' : null,
    },
    { k: 'Ваш суперприз', v: `${fmtBig(state.jackpot * ev.shareFactor)} ₽`, tone: 'dim' },
  ]));

  let cls = 'note note--good';
  let text = density < 0.95
    ? `Такую комбинацию ставят в ${fmtDec(1 / density, 1)} раза реже среднего. При выигрыше суперприз, скорее всего, достанется вам целиком.`
    : 'При выигрыше суперприз, скорее всего, достанется вам целиком.';
  if (ev.shareFactor < 0.4) {
    cls = 'note';
    text = `Популярная комбинация. При выигрыше вам достанется около ${Math.round(ev.shareFactor * 100)}% суперприза, остальное — тем, кто поставил то же самое.`;
  } else if (ev.shareFactor < 0.85) {
    cls = 'note';
    text = 'Комбинацию ставят заметно чаще среднего: суперприз, возможно, придётся делить.';
  } else if (density > 1.5) {
    cls = 'note';
    text = `Такую комбинацию ставят в ${fmtDec(density, 1)} раза чаще среднего.`;
  }
  const note = el('div', cls);
  note.style.marginTop = '18px';
  note.append(el('p', 'muted', text));
  node.append(note);

  node.append(whyNode(breakdown));
  return node;
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

function showView(name) {
  document.querySelectorAll('.tab').forEach((t) => {
    t.classList.toggle('is-active', t.dataset.view === name);
  });
  document.querySelectorAll('.view').forEach((view) => {
    view.hidden = view.id !== `view-${name}`;
  });
}

// ------------------------------------------------------- кошелёк и магазин

const cost = {
  get perTicket() {
    return wallet.economy.COST_PER_TICKET;
  },
  get check() {
    return wallet.economy.COST_CHECK;
  },
  get generate() {
    return state.genCount * wallet.economy.COST_PER_TICKET;
  },
};

/**
 * Перейти в магазин. Он живёт на вкладке подбора, поэтому вести туда нужно и
 * с других экранов: прокрутить к скрытому элементу браузер не может.
 */
function goToStore() {
  renderStore({ open: true });
  showView('generate');
  // Прокрутка — следующим кадром: до перерисовки вкладки у скрытого блока
  // нет ни размеров, ни положения.
  setTimeout(() => {
    $('#store-section').scrollIntoView({
      behavior: reduceMotion ? 'auto' : 'smooth',
      block: 'start',
    });
  }, 0);
}

/** Полоса с балансом над настройками. */
function renderWallet() {
  const bar = $('#wallet-bar');
  bar.hidden = false;
  bar.replaceChildren();

  const left = el('div', 'wallet__left');
  const value = el('span', 'wallet__value', String(wallet.total));
  left.append(icon('dice', 15), value, el('span', 'wallet__label', wordTail(wallet.total)));

  const hint = el('span', 'wallet__hint', walletHint());

  const top = el('button', 'wallet__top');
  top.type = 'button';
  top.textContent = 'Пополнить';
  top.addEventListener('click', () => {
    haptic('light');
    goToStore();
  });

  const body = el('div', 'wallet__body');
  body.append(left, hint);
  bar.append(body, top);
  bar.classList.toggle('is-empty', wallet.total === 0);
}

function wordTail(n) {
  return spinsWord(n).replace(/^\d+\s/, '');
}

function walletHint() {
  const b = wallet.balance;
  if (wallet.online) {
    if (b.free > 0) return 'Бесплатная на сегодня доступна';
    if (wallet.adsLeft > 0) return `Ещё ${wallet.adsLeft} за рекламу на этой неделе`;
    if (wallet.total === 0) return 'Бесплатная вернётся завтра';
    return 'Купленные прокрутки не сгорают';
  }
  if (b.free > 0) return 'Бесплатная прокрутка на сегодня';
  return 'Следующая бесплатная — завтра';
}

/** Магазин: реклама и пакеты прокруток. */
function renderStore({ open = false } = {}) {
  const host = $('#store-section');
  host.replaceChildren();
  host.hidden = false;
  if (open) host.dataset.open = '1';

  host.append(el('span', 'eyebrow eyebrow--accent', 'Прокрутки'));
  host.append(el('h3', null, 'Как это устроено'));
  host.append(el('p', 'muted',
    `Прокрутка — одна подобранная комбинация. ${wallet.economy.FREE_PER_DAY} бесплатная каждый день, ` +
    `ещё до ${wallet.economy.ADS_PER_WEEK} в неделю за просмотр рекламы. ` +
    'Купленные прокрутки не сгорают, подписки нет.'));

  host.append(adNode());

  if (wallet.canBuy) {
    host.append(packsNode());
    host.append(el('p', 'fineprint',
      'Оплата звёздами Telegram. Возврат — командой /refund боту в течение 48 часов ' +
      'после покупки, если прокрутки не потрачены.'));
  } else {
    const note = el('div', 'note note--quiet');
    note.append(el('p', 'muted', wallet.error
      || 'Пакеты прокруток открываются внутри Telegram.'));
    if (!wallet.online && CONFIG.PACKS.length) {
      note.append(el('p', 'fineprint', `Цены: ${CONFIG.PACKS
        .map((p) => `${p.spins} — ${p.stars} ⭐`).join(', ')}.`));
    }
    host.append(note);
  }

  const ref = referralNode();
  if (ref) host.append(ref);

}

/** Кнопка просмотра рекламы. Прячем целиком, если рекламы нет. */
function adNode() {
  const wrap = el('div', 'adbox');
  if (!wallet.online || !wallet.adBlockId) {
    wrap.hidden = true;
    return wrap;
  }
  const left = wallet.adsLeft;
  const head = el('div', 'adbox__head');
  head.append(el('span', 'adbox__title', 'Бесплатно за просмотр'));
  head.append(el('span', 'adbox__count', left > 0 ? `${left} из ${wallet.economy.ADS_PER_WEEK}` : 'на неделе всё'));
  wrap.append(head);

  const btn = el('button', 'btn btn--ghost');
  btn.type = 'button';
  btn.append(icon('play', 16),
    document.createTextNode(`Смотреть рекламу · +${wallet.economy.AD_REWARD}`));
  btn.disabled = left <= 0;
  btn.addEventListener('click', async () => {
    haptic('light');
    btn.disabled = true;
    const label = btn.lastChild;
    label.textContent = 'Открываем рекламу…';
    const result = await wallet.watchAd();
    wrap.querySelectorAll('.pay-note').forEach((n) => n.remove());
    if (result.ok) {
      haptic('medium');
      renderStore({ open: true });
      $('#store-section .adbox')?.append(el('p', 'muted pay-note',
        `Начислено: ${spinsWord(result.reward || wallet.economy.AD_REWARD)}.`));
      return;
    }
    btn.disabled = wallet.adsLeft <= 0;
    label.textContent = `Смотреть рекламу · +${wallet.economy.AD_REWARD}`;
    wrap.append(el('p', 'error pay-note', result.error || 'Реклама недоступна.'));
  });
  wrap.append(btn);
  wrap.append(el('p', 'fineprint',
    'Рекламу показывает сеть Adsgram. Прокрутка начисляется, если досмотреть ' +
    'рекламу до конца.'));
  return wrap;
}

/** Пакеты прокруток. Выгода считается от цены одиночной прокрутки. */
function packsNode() {
  const base = wallet.packs.reduce((max, p) => Math.max(max, p.per), 0);
  const grid = el('div', 'packs');
  wallet.packs.forEach((pack) => {
    const btn = el('button', 'pack');
    btn.type = 'button';
    const save = base > 0 ? Math.round((1 - pack.per / base) * 100) : 0;
    if (save >= 15) btn.classList.add('is-best');

    const head = el('div', 'pack__head');
    head.append(el('span', 'pack__spins', String(pack.spins)));
    head.append(el('span', 'pack__unit', wordTail(pack.spins)));
    btn.append(head);

    const price = el('div', 'pack__price');
    price.append(document.createTextNode(String(pack.stars)), icon('star', 13));
    btn.append(price);
    btn.append(el('span', 'pack__per', `${pack.per} ⭐ за прокрутку`));
    if (save >= 15) btn.append(el('span', 'pack__save', `−${save}%`));

    btn.addEventListener('click', () => buyPack(pack, btn));
    grid.append(btn);
  });
  return grid;
}

/**
 * Открывает оплату.
 *
 * Основной путь — openInvoice: он показывает счёт поверх приложения и
 * сообщает результат. Но на части клиентов вызов уходит в пустоту: событие
 * отправлено, счёт не открывается, обратный вызов не приходит никогда.
 * Поэтому есть запасной путь — отдать ссылку самому Telegram через
 * openTelegramLink, где счёт открывается обычным способом.
 *
 * Запасной путь не срабатывает сам: если счёт всё-таки открылся, таймер
 * продолжает идти, и автоматический вызов открыл бы второй экран поверх.
 * Поэтому предлагаем его кнопкой.
 */
async function buyPack(pack, button) {
  const host = $('#store-section');
  const say = (text, kind = 'error') => {
    host.querySelectorAll('.pay-note').forEach((n) => n.remove());
    const fallback = host.querySelector('.pay-fallback');
    const note = el('p', `${kind} pay-note`, text);
    if (fallback) host.insertBefore(note, fallback);
    else host.append(note);
  };
  const dropFallback = () => host.querySelectorAll('.pay-fallback').forEach((n) => n.remove());

  const version = tg?.version || '?';
  if (typeof tg?.openInvoice !== 'function') {
    say(`Оплата недоступна в этом клиенте Telegram (версия API ${version}).`);
    return;
  }

  let link;
  button.disabled = true;
  try {
    link = await wallet.invoiceLink(pack);
  } catch (err) {
    button.disabled = false;
    say(`Не удалось получить счёт: ${err.message}`);
    return;
  }
  button.disabled = false;

  say('Открываем оплату…', 'muted');
  watchForPayment();

  let answered = false;
  const offerFallback = () => {
    if (host.querySelector('.pay-fallback')) return;
    say('Telegram не открыл счёт внутри приложения. Откройте его напрямую — ' +
        'прокрутки появятся здесь сами.', 'muted');
    const btn = el('button', 'btn btn--accent pay-fallback');
    btn.type = 'button';
    btn.append(icon('star', 16), document.createTextNode(`Открыть счёт на ${pack.stars} ⭐`));
    btn.addEventListener('click', () => {
      haptic('light');
      if (tg.openTelegramLink) tg.openTelegramLink(link);
      else window.open(link, '_blank', 'noopener');
      watchForPayment();
    });
    host.append(btn);
  };
  const timer = setTimeout(() => { if (!answered) offerFallback(); }, 4000);

  try {
    tg.openInvoice(link, async (status) => {
      answered = true;
      clearTimeout(timer);
      if (status === 'paid') {
        haptic('medium');
        dropFallback();
        say('Оплачено, начисляем прокрутки…', 'muted');
        await wallet.load();
        renderStore({ open: true });
      } else if (status === 'cancelled') {
        // Тот же статус приходит и когда счёт вообще не открылся, поэтому
        // запасную кнопку не убираем и подсказываем причину.
        say('Счёт закрылся без оплаты.', 'muted');
        offerFallback();
      } else {
        say(`Telegram вернул статус «${status}».`);
        offerFallback();
      }
    });
  } catch (err) {
    answered = true;
    clearTimeout(timer);
    say(`Не удалось открыть оплату: ${err.message} (версия API ${version})`);
  }
}

/**
 * После начала оплаты прокрутки могут появиться без всякого обратного
 * вызова — например, если счёт оплачен в обычном окне Telegram. Поэтому
 * какое-то время переспрашиваем сервер сами.
 */
let paymentWatch = null;
function watchForPayment() {
  if (paymentWatch) return;
  const started = Date.now();
  const before = wallet.total;
  const check = async () => {
    await wallet.load();
    if (wallet.total > before) {
      stopPaymentWatch();
      haptic('medium');
      renderStore({ open: true });
      return;
    }
    if (Date.now() - started > 180_000) stopPaymentWatch();
  };
  paymentWatch = setInterval(check, 5000);
  document.addEventListener('visibilitychange', onVisible);
}

function stopPaymentWatch() {
  if (!paymentWatch) return;
  clearInterval(paymentWatch);
  paymentWatch = null;
  document.removeEventListener('visibilitychange', onVisible);
}

async function onVisible() {
  if (document.visibilityState !== 'visible') return;
  await wallet.load();
}

/** Приглашение друзей: прокрутки получают оба. */
function referralNode() {
  const ref = wallet.server?.referral;
  if (!ref?.link) return null;
  const node = el('div', 'referral');
  node.append(el('span', 'eyebrow eyebrow--accent', 'Позвать друга'));
  node.append(el('p', 'muted',
    `${spinsWord(ref.bonus_spins)} вам и столько же другу за каждого, кто придёт по ссылке. ` +
    `Засчитываем до ${ref.max_friends} друзей, уже пришло: ${ref.invited}.`));
  const btn = el('button', 'btn btn--ghost');
  btn.type = 'button';
  btn.append(icon('share', 16), document.createTextNode('Отправить приглашение'));
  btn.addEventListener('click', () => shareLink(
    ref.link,
    'Лотерейный аналитик считает, сколько человек играют теми же числами, что и ты, ' +
    `и подбирает те, которых нет ни у кого. По ссылке — ${spinsWord(ref.bonus_spins)} в подарок.`,
  ));
  node.append(btn);
  return node;
}

/** Ссылка, по которой отправляем друзей: личная, если есть, иначе на бота. */
function inviteLink() {
  return wallet.server?.referral?.link || window.location.href;
}

/**
 * Поделиться через выбор чата Telegram. Вне Telegram — системное меню
 * «Поделиться», а если его нет, открываем ссылку на share.
 */
async function shareLink(url, text) {
  haptic('light');
  const shareUrl = `https://t.me/share/url?url=${encodeURIComponent(url)}` +
    `&text=${encodeURIComponent(text)}`;
  if (tg?.openTelegramLink && tg.platform && tg.platform !== 'unknown') {
    tg.openTelegramLink(shareUrl);
    return;
  }
  if (navigator.share) {
    try {
      await navigator.share({ text, url });
      return;
    } catch { /* пользователь закрыл меню */ return; }
  }
  window.open(shareUrl, '_blank', 'noopener');
}

const ticketText = (ticket) => ticket.map((f) => f.join(' ')).join(' + ');

function shareCombos(picks) {
  const { title } = state.model.game;
  const lines = picks.map((p) => ticketText(p.ticket));
  const how = state.genMode === 'ai' ? 'нейросеть' : 'модель популярности';
  shareLink(
    inviteLink(),
    `Мои числа для ${title} (подобрала ${how}):\n${lines.join('\n')}`,
  );
}

/** Донат — отдельно от прокруток: это не покупка доступа. */
function renderDonate() {
  const host = $('#support-section');
  host.replaceChildren();
  if (!CONFIG.DONATE_URL) return;

  host.append(el('span', 'eyebrow', 'Поддержка'));
  host.append(el('h3', null, 'Поддержать проект'));
  host.append(el('p', 'muted',
    'Если приложение пригодилось, можно поддержать разработку на Boosty.'));
  const btn = el('button', 'btn btn--ghost');
  btn.type = 'button';
  btn.append(icon('heart', 16), document.createTextNode('Поддержать на Boosty'));
  btn.addEventListener('click', openDonate);
  host.append(btn);
}

// -------------------------------------------------------------- генератор

const MODE_HINTS = {
  classic: 'Из 15 000 случайных комбинаций выбирается та, которую, по оценке ' +
    'модели популярности, реже всего ставят другие игроки.',
  ai: 'Нейросеть отбирает числа по истории тиражей, из её вариантов ' +
    'выбирается самый редкий у других игроков.',
};

function initGenerator() {
  const counts = $('#gen-count');
  counts.addEventListener('click', (event) => {
    const chip = event.target.closest('.seg__btn');
    if (!chip) return;
    [...counts.children].forEach((c) => c.classList.toggle('is-active', c === chip));
    state.genCount = Number(chip.dataset.count);
    $('#row-spread').hidden = state.genCount < 2;
    renderRunButton();
    haptic('light');
  });

  $('#gen-mode').addEventListener('click', (event) => {
    const chip = event.target.closest('.seg__btn');
    if (!chip) return;
    state.genMode = chip.dataset.mode;
    renderModeChips();
    haptic('light');
  });

  $('#gen-run').addEventListener('click', runGenerator);
  renderModeChips();
}

function renderModeChips() {
  document.querySelectorAll('#gen-mode .seg__btn').forEach((chip) => {
    chip.classList.toggle('is-active', chip.dataset.mode === state.genMode);
  });
  $('#gen-mode-hint').textContent = MODE_HINTS[state.genMode];
}

/** Надпись и цена на кнопке подбора. */
function renderRunButton() {
  const need = cost.generate;
  // Пока барабан крутится, надпись принадлежит анимации: списание меняет
  // баланс и дёргает эту функцию как раз в этот момент.
  if (!state.busy) $('#gen-run-label').textContent = 'Подобрать';
  const price = $('#gen-run-price');
  price.textContent = String(need);
  const btn = $('#gen-run');
  btn.classList.toggle('is-short', wallet.total < need);
  // Именительный падеж не случаен: «за 1 прокрутка» звучит как машинный
  // перевод, а склонять число ради одной подписи незачем.
  btn.setAttribute('aria-label', `Подобрать. Спишется ${spinsWord(need)}`);
}

/** Справка о нейросети рядом с её подбором. */
function aiNoteNode() {
  const d = state.aiData.fields[0];
  const node = el('div', 'note note--quiet');
  node.style.marginTop = '4px';
  const p = el('p', 'muted');
  p.append(el('strong', null, 'Нейросеть. '));
  p.append(document.createTextNode(
    `Перцептрон ${d.arch.inputs}→${d.arch.hidden.join('→')}→1, обучен на ` +
    `${fmtInt(d.draws_used)} тиражах (${fmtInt(d.samples)} примеров), ` +
    'переобучается каждый день.',
  ));
  node.append(p);
  return node;
}

/** Не хватило прокруток: объясняем и ведём в магазин. */
function shortOnSpins(need) {
  const node = section('Не хватает прокруток', { accent: true });
  const note = el('div', 'note');
  note.append(el('p', null, `Чтобы продолжить, нужно ещё ${spinsWord(need)}.`));
  note.append(el('p', 'muted', wallet.canWatchAds
    ? 'Прокрутку можно получить за просмотр рекламы или купить пакетом — купленные не сгорают.'
    : 'Одна прокрутка приходит бесплатно каждый день. Пакеты — ниже.'));
  node.append(note);
  const btn = el('button', 'btn btn--accent');
  btn.type = 'button';
  btn.style.marginTop = '14px';
  btn.append(icon('coin', 16), document.createTextNode('Пополнить баланс'));
  btn.addEventListener('click', goToStore);
  node.append(btn);
  return node;
}

/** Анимация кнопки: пока крутится барабан, кнопка занята и это видно. */
function setRunning(on) {
  const btn = $('#gen-run');
  btn.classList.toggle('is-running', on);
  btn.disabled = on;
  $('#gen-run-label').textContent = on ? 'Подбор…' : 'Подобрать';
  $('#gen-run-price').hidden = on;
}

async function runGenerator() {
  if (state.busy) return;
  const errBox = $('#gen-error');
  const results = $('#gen-results');
  errBox.hidden = true;

  const useAI = state.genMode === 'ai';
  if (useAI && !state.ai) {
    const d = state.aiData;
    errBox.textContent = d?.insufficient
      ? `Нейросеть ещё не обучена: нужно ${d.draws_needed} тиражей, собрано ${d.draws}.`
      : 'Нейросеть для этой игры пока не опубликована.';
    errBox.hidden = false;
    results.replaceChildren();
    return;
  }

  // Параметры читаем до списания: если ограничения противоречивы, прокрутки
  // не должны сгореть впустую. Ограничения — для главного поля.
  const { pool, pick } = state.model.game.fields[0];
  const include = state.includeField.value();
  const exclude = state.excludeField.value();
  const clash = include.filter((n) => exclude.includes(n));
  if (clash.length) {
    errBox.textContent = `Числа ${clash.join(', ')} нельзя одновременно оставить и убрать.`;
    errBox.hidden = false;
    return;
  }
  if (include.length > pick) {
    errBox.textContent = `Своих чисел не может быть больше ${pick}.`;
    errBox.hidden = false;
    return;
  }
  if (pool - exclude.length < pick) {
    errBox.textContent = 'Убрано слишком много чисел — выбирать не из чего.';
    errBox.hidden = false;
    return;
  }

  const need = cost.generate;
  state.busy = true;
  setRunning(true);
  haptic('medium');

  const paid = await wallet.spend(need, 'generate');
  if (!paid.ok) {
    state.busy = false;
    setRunning(false);
    if (paid.error) {
      errBox.textContent = paid.error;
      errBox.hidden = false;
      return;
    }
    results.replaceChildren(shortOnSpins(paid.need || need));
    renderStore({ open: true });
    haptic('light');
    return;
  }

  // Барабан крутится ощутимо: подбор занимает миллисекунды, и без паузы
  // результат появлялся бы раньше, чем палец отпустит кнопку.
  results.replaceChildren();
  const spinFloor = sleep(reduceMotion ? 0 : 620);

  try {
    const spread = $('#gen-spread').checked;
    const picks = generate(state.model, {
      count: state.genCount,
      include,
      exclude,
      // Взвешенная выборка дороже равномерной, кандидатов берём меньше.
      candidates: useAI ? 6000 : 15000,
      maxOverlap: spread && state.genCount > 1 ? 2 : null,
      numberWeights: useAI ? state.ai.probabilities() : null,
    });
    if (!picks.length) throw new Error('С такими ограничениями подобрать не удалось');

    await spinFloor;
    results.replaceChildren();
    if (picks.length === 1) {
      results.append(analysisSection(picks[0].ticket, picks[0].breakdown,
        { title: 'Ваша комбинация', roll: true }));
    } else {
      // Несколько билетов свёрнуты до самих чисел: полный разбор каждого
      // занимает экран, и список из десяти таких разборов не читается.
      const list = section(`Билеты · ${picks.length}`, { accent: true });
      picks.forEach((pick, i) => list.append(ticketNode(pick, i, picks.length)));
      results.append(list);
    }

    const tail = section(null);
    if (useAI) tail.append(aiNoteNode());
    const share = el('button', 'btn btn--ghost share-btn');
    share.type = 'button';
    share.append(icon('share', 16), document.createTextNode('Поделиться билетами'));
    share.addEventListener('click', () => shareCombos(picks));
    tail.append(share);
    results.append(tail);
    haptic('medium');
    results.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'nearest' });
  } catch (err) {
    await spinFloor;
    results.replaceChildren();
    errBox.textContent = err.message;
    errBox.hidden = false;
  } finally {
    state.busy = false;
    setRunning(false);
  }

}

/** Свёрнутый билет: в заголовке только числа, разбор — по нажатию. */
function ticketNode(pick, index, total) {
  const details = el('details', 'ticket');
  const summary = el('summary');
  const head = el('div', 'ticket__head');
  head.append(el('span', null, `Билет ${index + 1} из ${total}`));
  const chev = icon('chevron', 14);
  chev.classList.add('chev');
  head.append(chev);
  summary.append(head, ballsNode(pick.ticket, { accent: true, roll: index < 4 }));
  details.append(summary);

  // Разбор строится при первом раскрытии: оценка незаметности перебирает
  // тысячи комбинаций, и считать её для свёрнутых билетов незачем.
  details.addEventListener('toggle', () => {
    if (!details.open || details.dataset.ready) return;
    details.dataset.ready = '1';
    const body = analysisSection(pick.ticket, pick.breakdown);
    body.querySelector('.balls')?.remove();
    details.append(body);
    haptic('light');
  });
  return details;
}

// ---------------------------------------------------------- свой билет

/** Бланк — по сетке на каждое поле игры. */
function buildSlip() {
  const host = $('#slip');
  const { fields } = state.model.game;
  host.replaceChildren();
  state.selected = fields.map(() => new Set());
  fields.forEach((field, f) => {
    const wrap = el('div', 'slip-field');
    if (fields.length > 1) {
      const label = el('div', 'slip-field__label');
      label.append(el('span', null, `Поле ${f + 1} · ${field.pick} из ${field.pool}`));
      const counter = el('span', null, '');
      counter.dataset.counter = String(f);
      label.append(counter);
      wrap.append(label);
    }
    const grid = el('div', 'slip');
    // Колонок не меньше, чем у главного поля: иначе бонусный номер из
    // четырёх клеток растянулся бы на всю ширину огромными кругами.
    const cols = Math.max(field.slip?.cols || 5, fields[0].slip?.cols || 5);
    grid.style.setProperty('--slip-cols', String(cols));
    for (let n = 1; n <= field.pool; n += 1) {
      const cell = el('button', 'slip__cell', String(n));
      cell.type = 'button';
      cell.dataset.n = String(n);
      cell.dataset.field = String(f);
      cell.setAttribute('aria-pressed', 'false');
      grid.append(cell);
    }
    wrap.append(grid);
    host.append(wrap);
  });
  renderSlip();
}

function initSlip() {
  $('#slip').addEventListener('click', (event) => {
    const cell = event.target.closest('.slip__cell');
    if (!cell) return;
    const n = Number(cell.dataset.n);
    const f = Number(cell.dataset.field);
    const chosen = state.selected[f];
    if (chosen.has(n)) chosen.delete(n);
    else if (chosen.size < state.model.game.fields[f].pick) chosen.add(n);
    else return;
    haptic('light');
    renderSlip();
  });

  $('#slip-clear').addEventListener('click', () => {
    state.selected.forEach((s) => s.clear());
    renderSlip();
  });

  $('#slip-random').addEventListener('click', () => {
    state.selected = state.model.game.fields.map(({ pick, pool }) => {
      const bag = Array.from({ length: pool }, (_, i) => i + 1);
      for (let i = 0; i < pick; i += 1) {
        const j = i + Math.floor(Math.random() * (bag.length - i));
        [bag[i], bag[j]] = [bag[j], bag[i]];
      }
      return new Set(bag.slice(0, pick));
    });
    haptic('medium');
    renderSlip();
  });
}

const comboKey = (ticket) => `${state.gameKey}:${ticket.map((f) => f.join('-')).join('+')}`;

/** Предложение оплатить разбор. Цена названа до нажатия, а не после. */
function checkOfferSection(ticket) {
  const node = section('Разбор комбинации', { accent: true });
  node.append(ballsNode(ticket, { accent: false }));
  node.append(el('p', 'muted',
    'Разбор покажет, во сколько раз чаще или реже среднего ставят эту ' +
    'комбинацию, сколько ещё людей, вероятно, поставили её же и какая доля ' +
    'суперприза достанется вам.'));

  const btn = el('button', 'btn btn--accent btn--roll');
  btn.type = 'button';
  btn.style.marginTop = '4px';
  const face = el('span', 'btn__face');
  face.append(icon('slip', 16), document.createTextNode('Показать разбор'));
  const price = el('span', 'btn__price', String(cost.check));
  face.append(price);
  btn.append(el('span', 'btn__sheen'), face);
  btn.addEventListener('click', async () => {
    if (state.busy) return;
    state.busy = true;
    btn.disabled = true;
    haptic('medium');
    const paid = await wallet.spend(cost.check, 'check');
    state.busy = false;
    btn.disabled = false;
    if (!paid.ok) {
      if (paid.error) {
        node.querySelectorAll('.pay-note').forEach((n) => n.remove());
        node.append(el('p', 'error pay-note', paid.error));
        return;
      }
      // Остаёмся на этом экране: человек только что выбрал числа, и увести
      // его на другую вкладку — значит заставить выбирать заново.
      $('#check-result').replaceChildren(shortOnSpins(paid.need || cost.check));
      renderStore();
      return;
    }
    rememberUnlocked(comboKey(ticket));
    renderSlip({ roll: true });
  });
  node.append(btn);
  node.append(el('p', 'fineprint',
    `Спишется ${spinsWord(cost.check)}. Эту же комбинацию потом открываем бесплатно.`));
  return node;
}

function renderSlip({ roll = false } = {}) {
  if (!state.model) return;
  const { fields } = state.model.game;
  const full = fields.every((f, i) => state.selected[i].size === f.pick);

  document.querySelectorAll('.slip__cell').forEach((cell) => {
    const f = Number(cell.dataset.field);
    const on = state.selected[f].has(Number(cell.dataset.n));
    cell.classList.toggle('is-on', on);
    cell.setAttribute('aria-pressed', String(on));
    cell.disabled = state.selected[f].size === fields[f].pick && !on;
  });
  document.querySelectorAll('[data-counter]').forEach((node) => {
    const f = Number(node.dataset.counter);
    node.textContent = `${state.selected[f].size} / ${fields[f].pick}`;
  });
  const picked = state.selected.reduce((s, set) => s + set.size, 0);
  const need = fields.reduce((s, f) => s + f.pick, 0);
  $('#slip-counter').textContent = `${picked} / ${need}`;

  const box = $('#check-result');
  if (!full) {
    box.replaceChildren(el('p', 'skeleton',
      `Отметьте ещё ${need - picked}, чтобы увидеть разбор`));
    return;
  }

  const ticket = state.selected.map((s) => [...s].sort((a, b) => a - b));
  if (!state.unlocked.has(comboKey(ticket))) {
    box.replaceChildren(checkOfferSection(ticket));
    return;
  }

  box.replaceChildren(
    analysisSection(ticket, state.model.breakdown(ticket), { title: 'Ваша комбинация', roll }),
    jackpotSection(),
  );
}

function jackpotSection() {
  const node = section('Размер суперприза');
  node.append(el('p', 'muted', 'По умолчанию — суперприз ближайшего тиража. Можно подставить свой.'));
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
  node.append(input);
  return node;
}

// ---------------------------------------------------------------- данные

const fmtDate = (iso, opts = { day: 'numeric', month: 'short', year: 'numeric' }) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('ru-RU', opts);
};

function freqChart(summary) {
  const chart = el('div', 'freq');
  const counts = summary.numbers.map((x) => x.count);
  const maxCount = Math.max(...counts, 1);
  const expected = summary.numbers[0]?.expected || 0;
  const hot = new Set(summary.hot.map((x) => x.n));
  summary.numbers.forEach((item, i) => {
    const bar = el('div', 'freq__bar');
    bar.style.height = `${(item.count / maxCount) * 100}%`;
    bar.style.animationDelay = `${i * 8}ms`;
    if (hot.has(item.n)) bar.classList.add('is-hot');
    bar.title = `${item.n}: ${item.count} (в среднем ${item.expected})`;
    chart.append(bar);
  });
  const mean = el('div', 'freq__mean');
  mean.style.bottom = `${(expected / maxCount) * 100}%`;
  chart.append(mean);
  return chart;
}

function renderStats() {
  const { meta, model, stats } = state;
  const { fields } = model.game;
  const main = stats.fields[0];

  $('#stats-title').textContent = model.game.title;
  // Дата кончается на «г.», поэтому предложение после неё без своей точки.
  $('#stats-lede').textContent =
    `${fmtInt(meta.draws_count)} тиражей, с ${fmtDate(meta.first_date)} по ` +
    `${fmtDate(meta.latest_draw.date)} Источник — архив тиражей Столото, ` +
    'обновляется каждый день.';

  const draws = $('#latest-draws');
  draws.replaceChildren();
  (meta.latest_draws || []).slice(0, 10).forEach((d) => {
    const li = el('li');
    const m = el('span', 'draws__meta');
    m.append(el('b', null, `№ ${d.draw}`), document.createTextNode(fmtDate(d.date, { day: 'numeric', month: 'short' })));
    li.append(m, ballsNode(d.numbers, { quiet: false }));
    draws.append(li);
  });

  const charts = $('#freq-charts');
  charts.replaceChildren();
  stats.fields.forEach((summary, i) => {
    const wrap = el('div', 'freq-field');
    if (fields.length > 1) wrap.append(el('span', 'freq-field__label', `Поле ${i + 1}`));
    wrap.append(freqChart(summary));
    charts.append(wrap);
  });

  const fillList = (sel, items, suffix) => {
    const list = $(sel);
    list.replaceChildren();
    // В играх с двумя полями списки — по первому полю, и это сказано в
    // заголовке, а не в каждой строке.
    const eyebrow = list.parentElement.querySelector('.eyebrow');
    eyebrow.dataset.base = eyebrow.dataset.base || eyebrow.textContent;
    eyebrow.textContent = fields.length > 1 ? `${eyebrow.dataset.base} · поле 1` : eyebrow.dataset.base;
    items.forEach((item) => {
      const li = el('li');
      li.append(el('span', 'ball ball--quiet', String(item.n)));
      li.append(el('span', null, suffix(item)));
      list.append(li);
    });
  };
  fillList('#list-hot', main.hot,
    (x) => `${fmtInt(x.count)} раз · ${x.deviation > 0 ? '+' : ''}${fmtInt(x.deviation)} к среднему`);
  fillList('#list-cold', main.cold,
    (x) => `${fmtInt(x.count)} раз · ${fmtInt(x.deviation)} к среднему`);
  fillList('#list-overdue', main.overdue, (x) => `${fmtInt(x.gap)} тиражей назад`);

  const { pick } = fields[0];
  const evens = Math.floor(pick / 2);
  const balanced = main.parity[`${evens}_even_${pick - evens}_odd`] || 0;
  const uni = main.uniformity;
  const facts = rowsList([
    { k: 'С парой соседних чисел', v: `${Math.round(main.consecutive_share * 100)}%` },
    { k: `Средняя сумма ${pick} чисел`, v: String(main.sums.mean).replace('.', ',') },
    { k: 'Диапазон сумм (90% тиражей)', v: `${main.sums.p05} – ${main.sums.p95}` },
    {
      k: `${evens} чётных и ${pick - evens} нечётных`,
      v: `${Math.round((balanced / Math.max(main.draws_analyzed, 1)) * 100)}%`,
    },
    { k: 'Равномерность, хи-квадрат', v: `p = ${String(uni.p_value).replace('.', ',')}` },
  ]);
  facts.id = 'facts';
  $('#facts').replaceWith(facts);

  renderModelInfo();
  renderGameFacts();
}

/** Что модель популярности узнала из итогов тиражей. */
function renderModelInfo() {
  const body = $('#model-body');
  body.replaceChildren();
  const cal = state.modelData.calibration;
  const cfg = state.model.cfg;
  if (!cal) {
    body.append(el('p', 'muted',
      'Для этой игры оценка популярности пока построена по опубликованным ' +
      'исследованиям выбора чисел, без обучения на итогах тиражей.'));
    return;
  }
  body.append(el('p', 'muted',
    `Модель обучена на итогах ${fmtInt(cal.draws)} тиражей ` +
    `(${fmtDate(cal.date_from)} — ${fmtDate(cal.date_to)}). Если выпадают числа, ` +
    'которые люди любят ставить, победителей больше расчётного, если нелюбимые — ' +
    `меньше. По ${fmtInt(cal.winners)} выигравшим ставкам восстановлено, как ` +
    'игроки выбирают числа.'));

  const weights = cfg.calibration.field_weights[0];
  const order = weights.map((w, i) => [w, i + 1]).sort((a, b) => b[0] - a[0]);
  const s = cfg.consecutive_run;
  const p = cfg.parity_balance;
  const mult = (v) => {
    if (Math.abs(Math.log(v)) < Math.log(1.1)) return 'не влияет';
    return v >= 1 ? `×${fmtDec(v, 1)}` : `÷${fmtDec(1 / v, 1)}`;
  };
  const rows = [
    { k: 'Чаще всего ставят', v: order.slice(0, 5).map(([, n]) => n).join(', ') },
    { k: 'Реже всего ставят', v: order.slice(-5).map(([, n]) => n).join(', ') },
  ];
  // Структурные множители показываем, только если обучение их приняло:
  // там, где они не улучшили прогноз, модель держится на весах чисел.
  if (cal.structure && cal.structure.patterns > 0) {
    rows.push(
      { k: 'Без соседних чисел', v: mult(s.no_adjacent_pair_bonus) },
      { k: 'Три числа подряд', v: mult(Number(s.run_length_multiplier['3'] ?? 1)) },
      { k: 'Поровну чётных и нечётных', v: mult(p.balanced_3_3_multiplier) },
      { k: 'Все чётные или все нечётные', v: mult(p.extreme_0_6_multiplier) },
      { k: 'Все числа в узком диапазоне', v: mult(cfg.decade_clustering.narrow_range_multiplier) },
    );
  }
  body.append(rowsList(rows));
  body.append(el('p', 'fineprint',
    (cal.structure && cal.structure.patterns > 0
      ? 'Множители — во сколько раз чаще или реже такие комбинации выбирают те, ' +
        'кто ставит числа сам. '
      : '') +
    `Модель проверена на ${fmtInt(cal.holdout.draws)} последних тиражах.`));
}

function renderGameFacts() {
  const { model, meta } = state;
  const game = model.game;
  const up = meta.upcoming;
  const rows = [
    { k: 'Цена билета', v: fmtMoney(game.ticket_price_rub) },
    { k: up ? `Суперприз тиража № ${up.draw}` : 'Суперприз', v: `${fmtBig(state.jackpot)} ₽`, tone: 'accent' },
    { k: 'Шанс выиграть суперприз', v: fmtOdds(model.totalCombinations) },
    {
      k: game.players_source === 'опубликовано' ? 'Ставок в тираже' : 'Ставок в тираже (оценка)',
      v: fmtInt(game.typical_players_per_draw),
    },
  ];
  const facts = rowsList(rows);
  facts.id = 'game-facts';
  $('#game-facts').replaceWith(facts);
}

// ------------------------------------------------------------------ старт

function renderMeta() {
  const { meta, model } = state;
  $('#game-title').textContent = model.game.title;
  const when = fmtDate(meta.generated_at, { day: 'numeric', month: 'short' });
  $('#data-meta').textContent = `${fmtInt(meta.draws_count)} тиражей · ${when}`;
}

/** Кнопки выбора лотереи. При одной игре выбирать нечего — скрыты. */
function renderGamePicker() {
  const picker = $('#game-picker');
  picker.replaceChildren();
  picker.hidden = state.games.length < 2;
  state.games.forEach((game) => {
    const f = game.fields?.[0] || game;
    const chip = el('button', `seg__btn${game.key === state.gameKey ? ' is-active' : ''}`,
      game.short || `${f.pick} из ${f.pool}`);
    chip.type = 'button';
    chip.dataset.game = game.key;
    chip.title = game.title || '';
    picker.append(chip);
  });
}

function initGamePicker() {
  $('#game-picker').addEventListener('click', async (event) => {
    const chip = event.target.closest('.seg__btn');
    if (!chip || chip.dataset.game === state.gameKey) return;
    haptic('light');
    try {
      localStorage.setItem(GAME_STORAGE_KEY, chip.dataset.game);
    } catch { /* хранилище недоступно — просто не запомним */ }
    try {
      await loadGame(chip.dataset.game);
    } catch (err) {
      const box = $('#gen-error');
      box.textContent = err.message;
      box.hidden = false;
    }
  });
}

/** Поля «мои числа» и «убрать» — для главного поля билета. */
function initNumberFields() {
  const { pool } = state.model.game.fields[0];
  state.includeField = new NumberField($('#gen-include'), {
    pool,
    placeholder: 'например 7',
  });
  state.excludeField = new NumberField($('#gen-exclude'), {
    pool,
    placeholder: 'например 13',
  });
}

/** Загружает данные игры и перерисовывает все экраны под неё. */
async function loadGame(key) {
  const [meta, modelData, stats, aiData] = await Promise.all([
    loadJSON(`${key}_meta.json`),
    loadJSON(`${key}_model.json`),
    loadJSON(`${key}_stats.json`),
    loadJSON(`${key}_ai.json`, { optional: true }),
  ]);
  state.aiData = aiData;
  state.ai = aiData && !aiData.insufficient && aiData.fields ? new DrawAI(aiData) : null;

  state.gameKey = key;
  state.meta = meta;
  state.modelData = modelData;
  state.model = new PopularityModel(modelData);
  state.stats = stats;
  state.jackpot = modelData.game.default_jackpot_rub || state.jackpot;

  $('#gen-results').replaceChildren();
  $('#gen-error').hidden = true;

  const { pool } = state.model.game.fields[0];
  if (!state.includeField) initNumberFields();
  else {
    state.includeField.setPool(pool);
    state.excludeField.setPool(pool);
  }

  renderGamePicker();
  renderMeta();
  buildSlip();
  renderStats();
  renderRunButton();
}

/** Boosty открывается во внешнем браузере: внутри Mini App платить нельзя. */
function openDonate() {
  haptic('light');
  if (tg?.openLink) tg.openLink(CONFIG.DONATE_URL);
  else window.open(CONFIG.DONATE_URL, '_blank', 'noopener');
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
    // Тема следует за клиентом Telegram — но только если мы действительно
    // внутри него. Вне Telegram SDK отдаёт platform: 'unknown' и colorScheme:
    // 'light', и слепое доверие этому перебивало бы системную тёмную тему у
    // тех, кто открыл приложение по ссылке в браузере.
    const inTelegram = Boolean(tg) && tg.platform && tg.platform !== 'unknown';
    if (inTelegram) {
      document.documentElement.dataset.theme = tg.colorScheme;
      tg.onEvent?.('themeChanged', () => {
        document.documentElement.dataset.theme = tg.colorScheme;
      });
    }
  } catch { /* открыто вне Telegram */ }

  initTabs();

  // Баланс влияет и на полосу сверху, и на цену на кнопке, и на магазин.
  wallet.onChange(() => {
    renderWallet();
    renderRunButton();
  });

  try {
    const index = await loadJSON('meta.json');
    state.games = (index.games || []).filter((g) => g && g.key);
    if (!state.games.length) state.games = [{ key: DEFAULT_GAME, short: '6 из 45' }];

    let saved = null;
    try {
      saved = localStorage.getItem(GAME_STORAGE_KEY);
    } catch { /* хранилище недоступно */ }
    const known = (key) => state.games.some((g) => g.key === key);
    const first = known(saved) ? saved : (known(index.default_game) ? index.default_game : state.games[0].key);

    initGenerator();
    initSlip();
    initGamePicker();
    await loadGame(first);
    renderDonate();
    renderWallet();

    // Кошелёк грузится последним: без него приложение полностью рабочее,
    // просто с бесплатным лимитом.
    await wallet.load();
    renderStore();
  } catch (err) {
    fail(
      `${err.message}\n\nЕсли вы открыли файл напрямую с диска, запустите ` +
      'локальный сервер: python -m http.server 8000 из папки docs.',
    );
  }
}

main();
