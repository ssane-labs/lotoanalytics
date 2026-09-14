/**
 * Mini App: подбор непопулярных комбинаций, разбор своей комбинации,
 * статистика тиражей и проверка предсказуемости.
 *
 * Вся математика считается в браузере: на GitHub Pages нет бэкенда, данные
 * приезжают статическими JSON из docs/data/. Воркер нужен только для кошелька
 * прокруток — без него приложение работает, просто с бесплатным лимитом.
 */

import {
  PopularityModel,
  FACTOR_LABELS,
  generate,
  evaluateEV,
  breakevenJackpot,
  unpopularityPercentile,
} from './model.js?v=7a9d6659';
import { CONFIG } from './config.js?v=7a9d6659';
import { DrawAI } from './ai.js?v=7a9d6659';
import { Wallet, spinsWord } from './wallet.js?v=7a9d6659';
import { NumberField } from './numfield.js?v=7a9d6659';

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
  proof: null,
  /** Нейросеть текущей игры: сырой JSON и модель (null, если не обучена). */
  aiData: null,
  ai: null,
  genMode: 'classic',
  selected: new Set(),
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

function ballsNode(combo, { accent = false, roll = false } = {}) {
  const wrap = el('div', 'balls');
  combo.forEach((n, i) => {
    const b = el('div', `ball${accent ? ' ball--accent' : ''}`, String(n));
    b.style.animationDelay = `${i * 45}ms`;
    wrap.append(b);
  });
  if (roll) rollBalls(wrap, combo);
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

function rollBalls(wrap, combo) {
  if (reduceMotion) return;
  const pool = state.model?.game?.pool || 45;
  const now = performance.now();
  [...wrap.children].forEach((node, i) => {
    node.classList.add('is-rolling');
    rolling.push({ node, value: combo[i], until: now + 340 + i * 75, pool });
  });
  if (!rollLoop) rollLoop = requestAnimationFrame(rollTick);

  // Страховка. requestAnimationFrame замирает, когда вкладка уходит в фон, а
  // вместе с ним замирает и докрутка — шар так и остался бы показывать
  // случайное число вместо подобранного. Таймер доводит числа до места
  // независимо от того, рисует ли браузер кадры.
  const lastLanding = 340 + (combo.length - 1) * 75 + 120;
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
    '× — так выбирают чаще, это против нас. ÷ — так выбирают реже.'));
  return details;
}

/** Полный разбор одной комбинации. */
function analysisSection(combo, breakdown, { title, roll = false } = {}) {
  const node = section(title || null);
  node.append(ballsNode(combo, { accent: true, roll }));
  node.append(meterNode(unpopularityPercentile(state.model, combo, 3000)));

  const ev = evaluateEV(state.model, combo, state.jackpot);
  const rivals = ev.expectedCoWinners;

  node.append(specGrid([
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
    {
      k: 'К средней',
      v: `×${fmtDec(ev.payoutAdvantage)}`,
      tone: ev.payoutAdvantage >= 1 ? 'good' : 'accent',
    },
    { k: 'Выплата', v: fmtMoney(ev.evTotal + state.model.game.ticket_price_rub), tone: 'dim' },
  ]));

  let cls = 'note note--good';
  let text = 'Чисто: такую комбинацию почти наверняка не поставил никто, кроме вас. Джекпот делить не придётся.';
  if (ev.shareFactor < 0.4) {
    cls = 'note';
    text = `Ходовой шаблон. При выигрыше вам достанется около ${Math.round(ev.shareFactor * 100)}% джекпота — остальное заберут те, кто выбрал то же самое.`;
  } else if (ev.shareFactor < 0.85) {
    cls = 'note';
    text = 'Комбинация умеренно популярна — есть шанс поделить джекпот с кем-то ещё.';
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
        if (view.id === 'banners') return;
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
    if (view.id === 'banners') return;
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
    if (b.free > 0) return 'Одна бесплатная сегодня уже здесь';
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
    `ещё до ${wallet.economy.ADS_PER_WEEK} в неделю — за короткий ролик. ` +
    'Купленные не сгорают и не требуют подписки: платите только за то, чем пользуетесь.'));

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

  // Дисклеймер стоит именно здесь, а не только на вкладке «Проверка»: это
  // экран, где человек платит, и предупреждение обязано быть там же, где
  // деньги, а не в разделе, куда можно не зайти.
  const note = el('div', 'note note--quiet');
  note.style.marginTop = '22px';
  note.append(el('p', 'fineprint',
    'Приложение не предсказывает результаты тиражей и не повышает шанс ' +
    'выигрыша — это невозможно, и во вкладке «Проверка» мы это измерили. ' +
    'Прокрутки оплачивают подбор комбинаций, которые редко выбирают другие ' +
    'игроки: это влияет на размер выплаты при выигрыше, а не на его ' +
    'вероятность. Ожидаемая выплата билета ниже его цены — так устроена ' +
    'любая лотерея. Лотерея это развлечение, а не способ заработка: ' +
    'не тратьте больше, чем готовы потерять.'));
  host.append(note);
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
    document.createTextNode(`Смотреть ролик · +${wallet.economy.AD_REWARD}`));
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
      return;
    }
    btn.disabled = wallet.adsLeft <= 0;
    label.textContent = `Смотреть ролик · +${wallet.economy.AD_REWARD}`;
    wrap.append(el('p', 'error pay-note', result.error || 'Реклама недоступна.'));
  });
  wrap.append(btn);
  wrap.append(el('p', 'fineprint',
    'Ролик короткий, его показывает рекламная сеть Telegram. Прокрутка ' +
    'начисляется после полного просмотра.'));
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

function shareCombos(picks) {
  const { title } = state.model.game;
  const lines = picks.map((p) => p.combo.join(' · '));
  const how = state.genMode === 'ai' ? 'нейросеть' : 'аналитик';
  shareLink(
    inviteLink(),
    `Мои числа для ${title}, подобрал ${how}:\n${lines.join('\n')}\n\n` +
    'Такие комбинации почти никто не ставит — при выигрыше джекпот не придётся делить.',
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
    'Расчёты, история тиражей и проверка моделей открыты и бесплатны. ' +
    'Если проект оказался полезен — можно поддержать разработку.'));
  const btn = el('button', 'btn btn--ghost');
  btn.type = 'button';
  btn.append(icon('heart', 16), document.createTextNode('Поддержать на Boosty'));
  btn.addEventListener('click', openDonate);
  host.append(btn);
}

// -------------------------------------------------------------- генератор

const MODE_HINTS = {
  classic: 'Считаем, как часто такую комбинацию выбирают люди, и берём ту, ' +
    'что не встречается почти ни у кого.',
  ai: 'Сеть обучена на всей истории тиражей и переобучается каждый день. ' +
    'Из её вариантов оставляем самые редкие у игроков.',
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

/** Честная справка о нейросети рядом с её подбором. */
function aiNoteNode() {
  const d = state.aiData;
  const node = el('div', 'note note--quiet');
  node.style.marginTop = '4px';
  const p = el('p', 'muted');
  p.append(el('strong', null, 'Нейросеть. '));
  p.append(document.createTextNode(
    `Перцептрон ${d.arch.inputs}→${d.arch.hidden}→1, обучен на ` +
    `${fmtInt(d.draws_used)} тиражах (${fmtInt(d.samples)} примеров) и ` +
    'переобучается каждый день. Сеть выбирает числа, которые считает ' +
    'вероятнее, а из её вариантов мы берём те, что реже ставят другие.',
  ));
  node.append(p);
  if (!d.holdout || d.holdout.draws < 10) {
    // На паре тиражей средняя «угаданность» — чистый шум, показывать её как
    // результат нечестно в обе стороны.
    node.append(el('p', 'muted',
      'Проверку на тиражах, которых сеть не видела, покажем, когда их накопится ' +
      'хотя бы десять. Шанс выиграть от нейросети не меняется: тиражи независимы.'));
  } else {
    node.append(el('p', 'muted',
      `На ${fmtInt(d.holdout.draws)} тиражах, которых сеть не видела, она угадала в среднем ` +
      `${fmtDec(d.holdout.mean_matches)} числа — случайный выбор даёт ` +
      `${fmtDec(d.holdout.expected_by_chance)}. Шанс выиграть от этого не меняется: ` +
      'тиражи независимы, и это видно по цифрам.'));
  }
  return node;
}

/** Не хватило прокруток: объясняем и ведём в магазин. */
function shortOnSpins(need) {
  const node = section('Не хватает прокруток', { accent: true });
  const note = el('div', 'note');
  note.append(el('p', null, `Чтобы продолжить, нужно ещё ${spinsWord(need)}.`));
  note.append(el('p', 'muted', wallet.canWatchAds
    ? 'Посмотрите короткий ролик — прокрутка начислится сразу. Или возьмите пакет, он не сгорает.'
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
  $('#gen-run-label').textContent = on ? 'Крутим барабан' : 'Подобрать';
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
  // не должны сгореть впустую.
  const pool = state.model.game.pool;
  const include = state.includeField.value();
  const exclude = state.excludeField.value();
  const clash = include.filter((n) => exclude.includes(n));
  if (clash.length) {
    errBox.textContent = `Числа ${clash.join(', ')} нельзя одновременно оставить и убрать.`;
    errBox.hidden = false;
    return;
  }
  if (include.length > state.model.game.pick) {
    errBox.textContent = `Своих чисел не может быть больше ${state.model.game.pick}.`;
    errBox.hidden = false;
    return;
  }
  if (pool - exclude.length < state.model.game.pick) {
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
      numberWeights: useAI ? state.ai.probabilities(state.model.recentWinners) : null,
    });
    if (!picks.length) throw new Error('С такими ограничениями подобрать не удалось');

    await spinFloor;
    results.replaceChildren();
    if (picks.length === 1) {
      results.append(analysisSection(picks[0].combo, picks[0].breakdown,
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
    tail.append(el('p', 'muted',
      'Каждая из этих комбинаций выигрывает ровно с той же вероятностью, ' +
      'что и любая другая. Отличается только одно — сколько человек поставили ' +
      'то же самое.'));
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
  summary.append(head, ballsNode(pick.combo, { accent: true, roll: index < 4 }));
  details.append(summary);

  // Разбор строится при первом раскрытии: оценка незаметности перебирает
  // тысячи комбинаций, и считать её для свёрнутых билетов незачем.
  details.addEventListener('toggle', () => {
    if (!details.open || details.dataset.ready) return;
    details.dataset.ready = '1';
    const body = analysisSection(pick.combo, pick.breakdown);
    body.querySelector('.balls')?.remove();
    details.append(body);
    haptic('light');
  });
  return details;
}

// ---------------------------------------------------------- свой билет

/** Клетки бланка — заново для каждой игры: размер поля у игр разный. */
function buildSlip() {
  const slip = $('#slip');
  const { pool, slip: layout } = state.model.game;
  slip.replaceChildren();
  slip.style.setProperty('--slip-cols', String(layout?.cols || 5));
  for (let n = 1; n <= pool; n += 1) {
    const cell = el('button', 'slip__cell', String(n));
    cell.type = 'button';
    cell.dataset.n = String(n);
    cell.setAttribute('aria-pressed', 'false');
    slip.append(cell);
  }
  state.selected.clear();
  renderSlip();
}

function initSlip() {
  const slip = $('#slip');
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
}

const comboKey = (combo) => `${state.gameKey}:${combo.join('-')}`;

/** Предложение оплатить разбор. Цена названа до нажатия, а не после. */
function checkOfferSection(combo) {
  const node = section('Разбор комбинации', { accent: true });
  node.append(ballsNode(combo, { accent: false }));
  node.append(el('p', 'muted',
    'Посчитаем ожидаемое число соперников на тот же билет, вашу долю джекпота ' +
    'и покажем, какие привычки игроков сработали против вас.'));

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
      // Остаёмся на этом экране: человек только что выбрал шесть чисел, и
      // увести его на другую вкладку — значит заставить выбирать заново.
      // Кнопка внутри блока уведёт в магазин, когда он сам решит.
      $('#check-result').replaceChildren(shortOnSpins(paid.need || cost.check));
      renderStore();
      return;
    }
    rememberUnlocked(comboKey(combo));
    renderSlip({ roll: true });
  });
  node.append(btn);
  node.append(el('p', 'fineprint',
    `Спишется ${spinsWord(cost.check)}. Эту же комбинацию потом открываем бесплатно.`));
  return node;
}

function renderSlip({ roll = false } = {}) {
  if (!state.model) return;
  const { pick } = state.model.game;
  const full = state.selected.size === pick;

  document.querySelectorAll('.slip__cell').forEach((cell) => {
    const on = state.selected.has(Number(cell.dataset.n));
    cell.classList.toggle('is-on', on);
    cell.setAttribute('aria-pressed', String(on));
    cell.disabled = full && !on;
  });
  $('#slip-counter').textContent = `${state.selected.size} / ${pick}`;

  const box = $('#check-result');
  if (!full) {
    box.replaceChildren(el('p', 'skeleton',
      `Отметьте ещё ${pick - state.selected.size}, чтобы увидеть разбор`));
    return;
  }

  const combo = [...state.selected].sort((a, b) => a - b);
  if (!state.unlocked.has(comboKey(combo))) {
    box.replaceChildren(checkOfferSection(combo));
    return;
  }

  box.replaceChildren(
    analysisSection(combo, state.model.breakdown(combo), { title: 'Ваша комбинация', roll }),
    jackpotSection(),
  );
}

function jackpotSection() {
  const node = section('Размер джекпота');
  node.append(el('p', 'muted', 'Подставьте текущий суперприз — доля пересчитается.'));
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

// ------------------------------------------------------------ статистика

function renderStats() {
  const stats = state.stats;
  const banner = $('#uniformity-banner');
  const uni = stats.uniformity;

  // На малом архиве статистика — это шум, и показывать её как знание нечестно.
  if (!state.meta.enough_for_stats) {
    banner.className = 'note';
    banner.replaceChildren(
      (() => {
        const p = el('p');
        p.append(el('strong', null, 'Данных пока мало. '));
        p.append(document.createTextNode(
          `Собрано ${fmtInt(state.meta.draws_count)} тиражей из ` +
          `${fmtInt(state.meta.min_draws_for_stats)}, нужных для выводов. ` +
          'Архив пополняется каждый день. Всё ниже — то, что уже собрано, ' +
          'а не закономерность.',
        ));
        return p;
      })(),
    );
  } else {
    banner.className = uni.p_value >= 0.01 ? 'note note--good' : 'note';
    const p = el('p');
    p.append(el('strong', null, `Хи-квадрат: p = ${String(uni.p_value).replace('.', ',')}. `));
    p.append(document.createTextNode(uni.verdict));
    banner.replaceChildren(p);
  }

  const chart = $('#freq-chart');
  chart.replaceChildren();
  const counts = stats.numbers.map((x) => x.count);
  const maxCount = Math.max(...counts, 1);
  const expected = stats.numbers[0]?.expected || 0;
  const hot = new Set(stats.hot.map((x) => x.n));

  stats.numbers.forEach((item, i) => {
    const bar = el('div', 'freq__bar');
    bar.style.height = `${(item.count / maxCount) * 100}%`;
    bar.style.animationDelay = `${i * 8}ms`;
    if (hot.has(item.n)) bar.classList.add('is-hot');
    bar.title = `${item.n}: ${item.count} (ожидалось ${item.expected})`;
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
      li.append(el('span', 'ball ball--quiet', String(item.n)));
      li.append(el('span', null, suffix(item)));
      list.append(li);
    });
  };
  fillList('#list-hot', stats.hot,
    (x) => `${x.count} раз · ${x.deviation > 0 ? '+' : ''}${x.deviation} к среднему`);
  fillList('#list-cold', stats.cold,
    (x) => `${x.count} раз · ${x.deviation} к среднему`);
  fillList('#list-overdue', stats.overdue, (x) => `${x.gap} тиражей назад`);

  const { pick } = state.model.game;
  const evens = Math.floor(pick / 2);
  const balanced = stats.parity[`${evens}_even_${pick - evens}_odd`] || 0;
  const facts = rowsList([
    { k: 'Тиражей в выборке', v: fmtInt(stats.draws_analyzed) },
    { k: 'С парой соседних чисел', v: `${Math.round(stats.consecutive_share * 100)}%` },
    { k: `Средняя сумма ${pick} чисел`, v: String(stats.sums.mean).replace('.', ',') },
    { k: 'Диапазон сумм (90%)', v: `${stats.sums.p05} – ${stats.sums.p95}` },
    {
      k: `Баланс ${evens} чётных / ${pick - evens} нечётных`,
      v: `${Math.round((balanced / Math.max(stats.draws_analyzed, 1)) * 100)}%`,
    },
  ]);
  facts.id = 'facts';
  $('#facts').replaceWith(facts);
}

// -------------------------------------------------------------- проверка

function renderProof() {
  const tbody = $('#proof-table tbody');
  tbody.replaceChildren();

  if (!state.proof) {
    $('#proof-note').textContent = 'Результаты бэктеста ещё не собраны.';
    renderEvFacts();
    return;
  }

  $('#proof-baseline').textContent = fmtDec(state.proof.expected_by_chance, 3);

  if (state.proof.insufficient) {
    // Пока данных мало, таблицу не показываем: на коротком архиве она врала
    // бы в обе стороны. Появится сама, когда тиражей хватит.
    $('#proof-table-wrap').hidden = true;
    $('#proof-note').replaceChildren();
    renderEvFacts();
    return;
  }
  $('#proof-table-wrap').hidden = false;

  Object.entries(state.proof.results)
    .sort((a, b) => (b[1].mean_matches || 0) - (a[1].mean_matches || 0))
    .forEach(([name, res]) => {
      const tr = el('tr');
      tr.append(el('td', null, name));
      tr.append(el('td', null, fmtDec(res.mean_matches ?? 0, 3)));
      tr.append(el('td', res.significant ? 'is-flag' : null, fmtDec(res.p_value ?? 1, 3)));
      tbody.append(tr);
    });

  $('#proof-note').textContent = state.proof.any_significant
    ? 'Одна из стратегий формально прошла порог значимости. При восьми проверках сразу это ожидаемая случайность, а не находка.'
    : `Ни одна стратегия не обошла случайный выбор. Проверено на ${fmtInt(state.proof.draws)} тиражах.`;

  renderEvFacts();
}

function renderEvFacts() {
  const game = state.model.game;
  // Равномерно разнесённые числа: доля джекпота у них близка к полной.
  const sampleCombo = Array.from({ length: game.pick },
    (_, i) => Math.min(game.pool, Math.round(((i + 0.5) * game.pool) / game.pick)));
  const sample = evaluateEV(state.model, sampleCombo, state.jackpot);
  const evFacts = rowsList([
    { k: 'Цена билета', v: fmtMoney(game.ticket_price_rub) },
    { k: 'Шанс сорвать джекпот', v: fmtOdds(state.model.totalCombinations) },
    { k: `Возврат при джекпоте ${fmtBig(state.jackpot)} ₽`, v: `${Math.round(sample.rtp * 100)}%`, tone: 'accent' },
    { k: 'Джекпот безубыточности', v: `${fmtBig(breakevenJackpot(state.model))} ₽` },
  ]);
  evFacts.id = 'ev-facts';
  $('#ev-facts').replaceWith(evFacts);
}

// ------------------------------------------------------------------ старт

function renderMeta() {
  const { meta, model } = state;
  $('#game-title').textContent = model.game.title;
  $('#odds-line').textContent = fmtOdds(model.totalCombinations);

  const when = new Date(meta.generated_at);
  const date = Number.isNaN(when.getTime())
    ? meta.generated_at
    : when.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
  $('#data-meta').textContent = `${fmtInt(meta.draws_count)} тиражей · ${date}`;

  $('#banners').hidden = !meta.synthetic;
  $('#synthetic-banner').hidden = !meta.synthetic;
}

/** Кнопки выбора лотереи. При одной игре выбирать нечего — скрыты. */
function renderGamePicker() {
  const picker = $('#game-picker');
  picker.replaceChildren();
  picker.hidden = state.games.length < 2;
  state.games.forEach((game) => {
    const chip = el('button', `seg__btn${game.key === state.gameKey ? ' is-active' : ''}`,
      `${game.pick} из ${game.pool}`);
    chip.type = 'button';
    chip.dataset.game = game.key;
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

/** Поля «мои числа» и «убрать». Диапазон зависит от игры. */
function initNumberFields() {
  const pool = state.model.game.pool;
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
  const [meta, modelData, stats, proof, aiData] = await Promise.all([
    loadJSON(`${key}_meta.json`),
    loadJSON(`${key}_model.json`),
    loadJSON(`${key}_stats.json`),
    loadJSON(`${key}_randomness.json`, { optional: true }),
    loadJSON(`${key}_ai.json`, { optional: true }),
  ]);
  state.aiData = aiData;
  state.ai = aiData && !aiData.insufficient ? new DrawAI(aiData) : null;

  state.gameKey = key;
  state.meta = meta;
  state.model = new PopularityModel(modelData);
  state.stats = stats;
  state.proof = proof;
  state.jackpot = modelData.game.default_jackpot_rub || state.jackpot;

  $('#gen-results').replaceChildren();
  $('#gen-error').hidden = true;
  $('#proof-table-wrap').hidden = false;

  if (!state.includeField) initNumberFields();
  else {
    state.includeField.setPool(state.model.game.pool);
    state.excludeField.setPool(state.model.game.pool);
  }

  renderGamePicker();
  renderMeta();
  buildSlip();
  renderStats();
  renderProof();
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
    if (!state.games.length) state.games = [{ key: DEFAULT_GAME, pick: 6, pool: 45 }];

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
