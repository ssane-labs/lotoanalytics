/**
 * Mini App: подбор непопулярных комбинаций, разбор своей комбинации,
 * статистика тиражей, проверка предсказуемости и подписка.
 *
 * Вся математика считается в браузере: на GitHub Pages нет бэкенда, данные
 * приезжают статическими JSON из docs/data/. Воркер нужен только для оплаты —
 * без него приложение работает полностью, просто без платных функций.
 */

import {
  PopularityModel,
  FACTOR_LABELS,
  generate,
  evaluateEV,
  breakevenJackpot,
  unpopularityPercentile,
} from './model.js?v=552a3515';
import { CONFIG } from './config.js?v=552a3515';

const DEFAULT_GAME = '6x45';
const GAME_STORAGE_KEY = 'loto.game';

const tg = window.Telegram?.WebApp;
const state = {
  /** Список игр из data/meta.json и выбранная игра. */
  games: [],
  gameKey: DEFAULT_GAME,
  model: null,
  meta: null,
  stats: null,
  proof: null,
  selected: new Set(),
  jackpot: 300_000_000,
  genCount: 1,
  /** Подписка: null пока не проверяли, иначе ответ воркера. */
  entitlement: null,
  entitlementError: null,
  usedToday: 0,
};

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

function ballsNode(combo, { accent = false } = {}) {
  const wrap = el('div', 'balls');
  combo.forEach((n, i) => {
    const b = el('div', `ball${accent ? ' ball--accent' : ''}`, String(n));
    b.style.animationDelay = `${i * 45}ms`;
    wrap.append(b);
  });
  return wrap;
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
function analysisSection(combo, breakdown, { title } = {}) {
  const node = section(title || null);
  node.append(ballsNode(combo, { accent: true }));
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
  let text = 'Такую комбинацию почти наверняка не поставил больше никто — джекпот делить не придётся.';
  if (ev.shareFactor < 0.4) {
    cls = 'note';
    text = `Очень популярный шаблон. При выигрыше вы получите примерно ${Math.round(ev.shareFactor * 100)}% джекпота — остальное уйдёт тем, кто выбрал то же самое.`;
  } else if (ev.shareFactor < 0.85) {
    cls = 'note';
    text = 'Комбинация умеренно популярна. Есть шанс поделить джекпот с кем-то ещё.';
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

// -------------------------------------------------------------- подписка

/**
 * Спрашиваем воркер, оплачено ли у этого пользователя. Подпись initData
 * проверяется на сервере — здесь ей верить нельзя, клиент можно подделать.
 */
async function loadEntitlement() {
  if (!CONFIG.WORKER_URL) {
    state.entitlementError = 'Сервер подписок не настроен.';
    return null;
  }
  if (!tg?.initData) {
    // Подпись пользователя выдаёт только клиент Telegram. В обычном браузере
    // её нет, и подтвердить покупку нечем — это не поломка.
    state.entitlementError = 'Подписка доступна только внутри Telegram.';
    return null;
  }
  try {
    const res = await fetch(`${CONFIG.WORKER_URL}/api/entitlement`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ initData: tg.initData }),
    });
    if (!res.ok) {
      state.entitlementError = `Сервер подписок ответил ${res.status}.`;
      return null;
    }
    state.entitlementError = null;
    return await res.json();
  } catch (err) {
    // Ошибку показываем, а не прячем: молчаливый сбой здесь означает просто
    // исчезнувший блок подписки, и причину потом не найти.
    state.entitlementError = `Нет связи с сервером подписок: ${err.message}`;
    return null;
  }
}

/**
 * Открывает оплату. Ссылка приходит заранее вместе с данными о подписке —
 * в момент нажатия сети не требуется. Запрос остаётся только на случай,
 * если заранее ссылку получить не удалось.
 */
/**
 * Открывает оплату. Ссылка приходит заранее вместе с данными о подписке —
 * в момент нажатия сети не требуется.
 *
 * Здесь намеренно много видимой диагностики: платёж уходит в клиент Telegram,
 * и если он молча ничего не делает, снаружи это неотличимо от «кнопка не
 * работает». Показываем версию клиента, доступность метода и то, чем
 * закончился вызов.
 */
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
async function buyPlan(plan, button) {
  const host = button.closest('.section') || button.parentElement;
  // Текст сообщения и запасная кнопка живут независимо: обратный вызов
  // «отменено» приходит и когда счёт просто не открылся, и раньше стирал
  // кнопку, которой пользователь ещё не успел воспользоваться.
  const say = (text, kind = 'error') => {
    host.querySelectorAll('.pay-note').forEach((n) => n.remove());
    const fallback = host.querySelector('.pay-fallback');
    const note = el('p', `${kind} pay-note`, text);
    if (fallback) host.insertBefore(note, fallback);
    else host.append(note);
  };
  const dropFallback = () =>
    host.querySelectorAll('.pay-fallback, .pay-hint').forEach((n) => n.remove());

  const version = tg?.version || '?';
  if (typeof tg?.openInvoice !== 'function') {
    say(`Оплата недоступна в этом клиенте (версия API ${version}).`);
    return;
  }

  let link = plan.link;
  if (!link) {
    button.disabled = true;
    say('Запрашиваем счёт…', 'muted');
    try {
      const res = await fetch(`${CONFIG.WORKER_URL}/api/invoice`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ initData: tg.initData, plan: plan.key }),
      });
      const data = await res.json().catch(() => ({}));
      link = data.link;
      if (!link) throw new Error(data.error || `сервер ответил ${res.status}`);
    } catch (err) {
      button.disabled = false;
      say(`Не удалось получить счёт: ${err.message}`);
      return;
    }
    button.disabled = false;
  }

  say('Открываем оплату…', 'muted');
  watchForPayment();

  let answered = false;
  const offerFallback = () => {
    if (host.querySelector('.pay-fallback')) return;
    say('Telegram не открыл счёт внутри приложения. Попробуйте открыть его ' +
        'напрямую — подписка появится здесь сама.', 'muted');
    const btn = el('button', 'btn btn--accent pay-fallback');
    btn.type = 'button';
    btn.append(icon('star', 16), document.createTextNode(`Открыть счёт на ${plan.stars} ⭐`));
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
        say('Оплачено, обновляем подписку…', 'muted');
        state.entitlement = await loadEntitlement();
        onEntitlementChanged();
      } else if (status === 'cancelled') {
        // Тот же статус приходит и когда счёт вообще не открылся, поэтому
        // запасную кнопку не убираем и подсказываем причину.
        say('Счёт закрылся без оплаты.', 'muted');
        offerFallback();
        addOwnerHint(host);
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
 * Владелец бота не может оплатить покупку в собственном боте: Telegram
 * блокирует это как защиту от мошенничества и случайных покупок
 * администратором, причём молча. Со стороны выглядит как «счёт не
 * открывается». Подсказка нужна тому, кто тестирует свой же бот.
 */
function addOwnerHint(host) {
  if (host.querySelector('.pay-hint')) return;
  const hint = el('p', 'muted pay-hint',
    'Если вы владелец или администратор этого бота — оплата не пройдёт: ' +
    'Telegram запрещает покупки в собственном боте. Проверяйте с другого ' +
    'аккаунта.');
  host.append(hint);
}

/**
 * После начала оплаты подписка может появиться без всякого обратного вызова —
 * например, если счёт оплачен в обычном окне Telegram. Поэтому какое-то время
 * переспрашиваем сервер сами и обновляем экран, как только увидим оплату.
 */
let paymentWatch = null;
function watchForPayment() {
  if (paymentWatch) return;
  const started = Date.now();
  const check = async () => {
    const fresh = await loadEntitlement();
    if (fresh?.active) {
      state.entitlement = fresh;
      stopPaymentWatch();
      haptic('medium');
      onEntitlementChanged();
      return;
    }
    if (Date.now() - started > 180_000) stopPaymentWatch();
  };
  paymentWatch = setInterval(check, 5000);
  // Возврат в приложение — самый вероятный момент, когда оплата уже прошла.
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
  const fresh = await loadEntitlement();
  if (fresh?.active) {
    state.entitlement = fresh;
    stopPaymentWatch();
    onEntitlementChanged();
  }
}

const isSubscribed = () => Boolean(state.entitlement?.active);

/** Подписка влияет на два экрана: блок тарифов и разбор своей комбинации. */
function onEntitlementChanged() {
  renderSubscribe();
  if (state.model) renderSlip();
}

/** Кнопки тарифов. Возвращает null, если купить сейчас нечего. */
function plansNode() {
  const plans = state.entitlement?.plans;
  if (!plans?.length) return null;
  const wrap = el('div', 'plans');
  plans.forEach((plan) => {
    const btn = el('button', 'plan');
    btn.type = 'button';
    const body = el('div', 'plan__body');
    body.append(el('span', 'plan__title', plan.title));
    body.append(el('span', 'plan__meta', `${plan.days} дней`));
    const price = el('span', 'plan__price');
    price.append(document.createTextNode(String(plan.stars)), icon('star', 14));
    btn.append(body, price);
    btn.addEventListener('click', () => buyPlan(plan, btn));
    wrap.append(btn);
  });
  return wrap;
}

/** Отмена без возврата звёзд: доступ закрывается сразу. */
async function cancelSubscription(button) {
  const question = 'Отменить подписку? Доступ закончится сразу, звёзды не возвращаются.';
  const confirmed = await new Promise((resolve) => {
    if (typeof tg?.showConfirm === 'function') {
      try {
        tg.showConfirm(question, resolve);
        return;
      } catch { /* старый клиент — спросим браузером */ }
    }
    resolve(window.confirm(question));
  });
  if (!confirmed) return;

  button.disabled = true;
  try {
    const res = await fetch(`${CONFIG.WORKER_URL}/api/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ initData: tg?.initData }),
    });
    if (!res.ok) throw new Error(`сервер ответил ${res.status}`);
    haptic('medium');
    state.entitlement = await loadEntitlement();
    onEntitlementChanged();
  } catch (err) {
    button.disabled = false;
    button.after(el('p', 'error pay-note', `Не удалось отменить: ${err.message}`));
  }
}

/** Подписка — на вкладке подбора, где пользователь упирается в лимит. */
function renderSubscribe() {
  const host = $('#subscribe-section');
  const ent = state.entitlement;

  host.hidden = false;
  host.replaceChildren();

  if (!ent) {
    host.append(el('span', 'eyebrow', 'Подписка'));
    const note = el('div', 'note note--quiet');
    note.append(el('p', 'muted', state.entitlementError || 'Подписка недоступна.'));
    host.append(note);
    return;
  }

  if (isSubscribed()) {
    host.append(el('span', 'eyebrow eyebrow--accent', 'Подписка'));
    const note = el('div', 'note note--good');
    const p = el('p');
    p.append(icon('check', 14), document.createTextNode(` Активна до ${ent.until_text}.`));
    note.append(p);
    note.append(el('p', 'muted',
      'Напоминаем то, за что вы НЕ платили: шанс выиграть не изменился и ' +
      'измениться не может. Подписка влияет на размер выплаты, а не на вероятность.'));
    host.append(note);
    const cancel = el('button', 'btn btn--danger', 'Отменить подписку');
    cancel.type = 'button';
    cancel.addEventListener('click', () => cancelSubscription(cancel));
    host.append(cancel);
    return;
  }

  const plans = plansNode();
  if (!plans) {
    host.hidden = true;
    return;
  }

  host.append(el('span', 'eyebrow eyebrow--accent', 'Подписка'));
  host.append(el('h3', null, 'Снять ограничение'));
  host.append(el('p', 'muted',
    `Бесплатно — ${CONFIG.FREE_DAILY_LIMIT} комбинация за раз. ` +
    'По подписке — пакеты билетов с непересекающимися числами, ' +
    'неограниченный подбор и разбор своей комбинации. Оплата звёздами внутри Telegram.'));
  host.append(plans);
}

/** Донат — отдельно от подписки: это не покупка доступа. */
function renderDonate() {
  const host = $('#support-section');
  host.replaceChildren();
  if (!CONFIG.DONATE_URL) return;

  host.append(el('span', 'eyebrow', 'Поддержка'));
  host.append(el('h3', null, 'Поддержать проект'));
  host.append(el('p', 'muted',
    'Проект открытый и бесплатный в основе. Если он вам полезен — ' +
    'можно поддержать разработку.'));
  const btn = el('button', 'btn btn--ghost');
  btn.type = 'button';
  btn.append(icon('heart', 16), document.createTextNode('Поддержать на Boosty'));
  btn.addEventListener('click', openDonate);
  host.append(btn);
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

/**
 * Мягкое ограничение бесплатного тарифа.
 *
 * Честно про его надёжность: генерация идёт целиком в браузере, поэтому обойти
 * счётчик может любой, кто откроет консоль. Настоящая защита возможна только
 * если считать на сервере, а это стоило бы приложению работы без сети. Мы
 * сознательно выбрали работать всегда и ограничивать по-джентльменски.
 */
function freeLimitExceeded() {
  if (isSubscribed()) return false;
  return state.genCount > CONFIG.FREE_DAILY_LIMIT;
}

function runGenerator() {
  const errBox = $('#gen-error');
  const results = $('#gen-results');
  errBox.hidden = true;

  if (freeLimitExceeded()) {
    results.replaceChildren();
    const node = section('Нужна подписка', { accent: true });
    const note = el('div', 'note');
    const p = el('p');
    p.append(icon('lock', 14), document.createTextNode(
      ` Без подписки доступна ${CONFIG.FREE_DAILY_LIMIT} комбинация за раз.`,
    ));
    note.append(p);
    note.append(el('p', 'muted', CONFIG.WORKER_URL
      ? 'Тарифы — ниже на этом экране.'
      : 'Подписка ещё не подключена — выберите 1 комбинацию.'));
    node.append(note);
    results.append(node);
    haptic('light');
    return;
  }

  results.replaceChildren(el('p', 'skeleton', 'Перебираем варианты…'));

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
      if (!picks.length) throw new Error('С такими ограничениями подобрать не удалось');

      results.replaceChildren();
      if (picks.length === 1) {
        results.append(analysisSection(picks[0].combo, picks[0].breakdown, { title: 'Результат' }));
      } else {
        // Несколько билетов свёрнуты до самих чисел: полный разбор каждого
        // занимает экран, и список из десяти таких разборов не читается.
        const list = section(`Билеты · ${picks.length}`, { accent: true });
        picks.forEach((pick, i) => list.append(ticketNode(pick, i, picks.length)));
        results.append(list);
      }
      const tail = section(null);
      tail.append(el('p', 'muted',
        'Каждая из этих комбинаций выигрывает ровно с той же вероятностью, ' +
        'что и любая другая. Отличие только в том, сколько человек поставили ' +
        'то же самое.'));
      results.append(tail);
      haptic('medium');
    } catch (err) {
      results.replaceChildren();
      errBox.textContent = err.message;
      errBox.hidden = false;
    }
  }, 16);
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
  summary.append(head, ballsNode(pick.combo, { accent: true }));
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

/** Разбор своей комбинации доступен по подписке — вместо него тарифы. */
function paywallSection() {
  const node = section('Разбор по подписке', { accent: true });
  const note = el('div', 'note');
  const p = el('p');
  p.append(icon('lock', 14), document.createTextNode(
    ' Узнать, насколько популярна ваша комбинация и какую долю джекпота ' +
    'она сохранит, можно по подписке.',
  ));
  note.append(p);
  node.append(note);

  const plans = plansNode();
  if (plans) {
    node.append(plans);
  } else {
    node.append(el('p', 'muted', state.entitlementError ||
      'Тарифы появятся, когда откроете приложение внутри Telegram.'));
    note.style.marginBottom = '14px';
  }
  return node;
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
  $('#slip-counter').textContent = `${state.selected.size} / ${pick}`;

  const box = $('#check-result');
  if (!full) {
    box.replaceChildren(el('p', 'skeleton',
      `Отметьте ещё ${pick - state.selected.size}, чтобы увидеть разбор`));
    return;
  }

  if (!isSubscribed()) {
    box.replaceChildren(paywallSection());
    return;
  }

  const combo = [...state.selected].sort((a, b) => a - b);
  box.replaceChildren(
    analysisSection(combo, state.model.breakdown(combo), { title: 'Ваша комбинация' }),
    jackpotSection(),
  );
}

function jackpotSection() {
  const node = section('Размер джекпота');
  node.append(el('p', 'muted', 'Подставьте текущий суперприз — расчёт доли пересчитается.'));
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
    $('#proof-table-wrap').hidden = true;
    const note = $('#proof-note');
    note.replaceChildren();
    note.append(el('strong', null, 'Бэктест ещё не запускался. '));
    note.append(document.createTextNode(
      `Нужно ${fmtInt(state.proof.draws_needed)} тиражей, собрано ` +
      `${fmtInt(state.proof.draws)}. На коротком архиве разброс перекроет ` +
      'любую разницу между стратегиями, и таблица врала бы в обе стороны. ' +
      'Как только данных хватит, результат появится здесь автоматически — ' +
      'какой бы он ни был.',
    ));
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
    const chip = el('button', `chip${game.key === state.gameKey ? ' is-active' : ''}`,
      `${game.pick} из ${game.pool}`);
    chip.type = 'button';
    chip.dataset.game = game.key;
    picker.append(chip);
  });
}

function initGamePicker() {
  $('#game-picker').addEventListener('click', async (event) => {
    const chip = event.target.closest('.chip');
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

/** Загружает данные игры и перерисовывает все экраны под неё. */
async function loadGame(key) {
  const [meta, modelData, stats, proof] = await Promise.all([
    loadJSON(`${key}_meta.json`),
    loadJSON(`${key}_model.json`),
    loadJSON(`${key}_stats.json`),
    loadJSON(`${key}_randomness.json`, { optional: true }),
  ]);

  state.gameKey = key;
  state.meta = meta;
  state.model = new PopularityModel(modelData);
  state.stats = stats;
  state.proof = proof;
  state.jackpot = modelData.game.default_jackpot_rub || state.jackpot;

  $('#gen-results').replaceChildren();
  $('#gen-error').hidden = true;
  $('#proof-table-wrap').hidden = false;

  renderGamePicker();
  renderMeta();
  buildSlip();
  renderStats();
  renderProof();
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

    // Подписка грузится последней: без неё приложение полностью рабочее.
    state.entitlement = await loadEntitlement();
    onEntitlementChanged();
  } catch (err) {
    fail(
      `${err.message}\n\nЕсли вы открыли файл напрямую с диска, запустите ` +
      'локальный сервер: python -m http.server 8000 из папки docs.',
    );
  }
}

main();
