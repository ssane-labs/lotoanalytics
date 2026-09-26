/**
 * Кошелёк прокруток.
 *
 * Прокрутка — единица работы приложения: одна подобранная комбинация или
 * половина разбора своей (разбор стоит две). Подписки нет намеренно: человек
 * приходит раз в неделю перед тиражом, и платить за тридцать дней доступа ему
 * незачем. Прокрутки не сгорают.
 *
 * Где считается баланс. Внутри Telegram — на воркере: клиент можно подделать,
 * поэтому списание идёт запросом к серверу, и он же решает, хватило ли. Вне
 * Telegram подтвердить, кто это, нечем, поэтому работает запасной кошелёк в
 * localStorage: бесплатная прокрутка в день, без рекламы и покупок. Так
 * приложение остаётся полностью рабочим по прямой ссылке, а платная часть
 * живёт там, где её можно защитить.
 */

const LOCAL_KEY = 'loto.wallet';

/** Сутки считаем по Москве: аудитория и тиражи живут в этом времени. */
const MSK_SHIFT_MS = 3 * 3600 * 1000;

export function dayKey(now = Date.now()) {
  return new Date(now + MSK_SHIFT_MS).toISOString().slice(0, 10);
}

/** Номер ISO-недели — период, за который считается лимит рекламы. */
export function weekKey(now = Date.now()) {
  const d = new Date(now + MSK_SHIFT_MS);
  d.setUTCHours(0, 0, 0, 0);
  // Четверг той же недели однозначно задаёт её год и номер.
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((d.getTime() - yearStart) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

export class Wallet {
  constructor(config, tg) {
    this.config = config;
    this.tg = tg;
    this.economy = { ...config.ECONOMY };
    /** Ответ воркера. null — сервер не отвечает или мы вне Telegram. */
    this.server = null;
    this.error = null;
    this.packs = config.PACKS.map((p) => ({
      ...p,
      per: Math.round(p.stars / p.spins),
      title: spinsWord(p.spins),
    }));
    this.adBlockId = config.ADSGRAM_BLOCK_ID || '';
    this.local = readLocal();
    this.listeners = new Set();
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit() {
    this.listeners.forEach((fn) => {
      try {
        fn(this);
      } catch (err) {
        console.error('wallet listener failed', err);
      }
    });
  }

  // ------------------------------------------------------------- состояние

  /** Внутри Telegram — только если клиент дал подписанный initData. */
  get online() {
    return Boolean(this.config.WORKER_URL && this.tg?.initData && this.server);
  }

  get canBuy() {
    return this.online && this.packs.length > 0;
  }

  get canWatchAds() {
    return this.online && Boolean(this.adBlockId) && this.adsLeft > 0;
  }

  get balance() {
    if (this.online) return this.server.spins;
    const rec = this.refreshedLocal();
    return {
      free: Math.max(0, this.economy.FREE_PER_DAY - rec.free_used),
      bonus: 0,
      paid: 0,
    };
  }

  get total() {
    const b = this.balance;
    return b.free + b.bonus + b.paid;
  }

  get adsLeft() {
    if (!this.online) return 0;
    return Math.max(0, this.server.ads_left || 0);
  }

  /** Обновляет локальную запись, если сменились сутки или неделя. */
  refreshedLocal() {
    const today = dayKey();
    if (this.local.free_day !== today) {
      this.local = { ...this.local, free_day: today, free_used: 0 };
      writeLocal(this.local);
    }
    return this.local;
  }

  // ------------------------------------------------------------------ сеть

  async post(path, body) {
    const res = await fetch(`${this.config.WORKER_URL}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ initData: this.tg?.initData, ...body }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `сервер ответил ${res.status}`);
    return data;
  }

  applyServer(data) {
    this.server = data;
    this.error = null;
    if (data.economy) this.economy = { ...this.economy, ...data.economy };
    if (data.packs?.length) {
      this.packs = data.packs.map((p) => ({
        ...p,
        per: p.per || Math.round(p.stars / p.spins),
        title: p.title || spinsWord(p.spins),
      }));
    }
    if (data.ad_block_id) this.adBlockId = data.ad_block_id;
    this.emit();
    return data;
  }

  /** Спрашивает воркер, сколько прокруток у пользователя. */
  async load() {
    if (!this.config.WORKER_URL) {
      this.error = 'Сервер не настроен: доступна бесплатная прокрутка в день.';
      this.emit();
      return null;
    }
    if (!this.tg?.initData) {
      // Подпись выдаёт только клиент Telegram. В обычном браузере её нет, и
      // подтвердить покупку нечем — это не поломка, а ожидаемый режим.
      this.error = 'Покупки и реклама работают внутри Telegram.';
      this.emit();
      return null;
    }
    try {
      return this.applyServer(await this.post('/api/state'));
    } catch (err) {
      this.server = null;
      this.error = `Нет связи с сервером: ${err.message}`;
      this.emit();
      return null;
    }
  }

  /**
   * Списывает прокрутки. Возвращает { ok } либо { ok: false, need } — сколько
   * не хватило, чтобы интерфейс сразу предложил их получить.
   */
  async spend(cost, reason) {
    if (cost <= 0) return { ok: true };
    if (this.online) {
      try {
        const data = await this.post('/api/spend', { cost, reason });
        if (data.ok === false) {
          this.applyServer(data);
          return { ok: false, need: Math.max(1, cost - this.total) };
        }
        this.applyServer(data);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err.message, need: 0 };
      }
    }

    const rec = this.refreshedLocal();
    const free = Math.max(0, this.economy.FREE_PER_DAY - rec.free_used);
    if (free < cost) return { ok: false, need: cost - free };
    this.local = { ...rec, free_used: rec.free_used + cost };
    writeLocal(this.local);
    this.emit();
    return { ok: true };
  }

  /**
   * Показывает рекламный ролик и начисляет прокрутку.
   *
   * Начисляет сервер, а не клиент: страницу можно переписать в консоли.
   * Недельный лимит проверяется там же, поэтому даже поддельный вызов
   * ничего не даёт сверх пяти прокруток.
   */
  async watchAd() {
    if (!this.adBlockId) return { ok: false, error: 'Реклама не подключена.' };
    if (!this.online) return { ok: false, error: 'Реклама доступна внутри Telegram.' };
    const before = this.total;

    // Признак досмотра — событие onReward, а не только исход show(). На части
    // клиентов промис отклоняется уже после того, как награда засчитана
    // (например, если закрыть экран после ролика), и без этого прокрутка
    // пропадала бы у человека, который честно всё досмотрел.
    let rewarded = false;
    let controller;
    const onReward = () => { rewarded = true; };
    try {
      controller = await adController(this.adBlockId);
      controller.addEventListener?.('onReward', onReward);
      const result = await controller.show();
      if (result?.done) rewarded = true;
    } catch (err) {
      if (!rewarded) {
        const reason = describeAdError(err);
        this.post('/api/ad-claim', { failed: reason }).catch(() => {});
        return { ok: false, error: reason };
      }
    } finally {
      controller?.removeEventListener?.('onReward', onReward);
    }

    try {
      const data = await this.post('/api/ad-claim');
      this.applyServer(data);
      if (data.ok === false) return { ok: false, error: data.reason || 'Начислить не удалось.' };
      return { ok: true, reward: data.reward || this.economy.AD_REWARD };
    } catch (err) {
      // Запрос мог не дойти, а Adsgram тем временем начислил прокрутку сам,
      // через Reward URL. Прежде чем показывать ошибку, спрашиваем баланс.
      for (let i = 0; i < 3; i += 1) {
        await new Promise((r) => setTimeout(r, 1500));
        await this.load();
        if (this.total > before) return { ok: true, reward: this.total - before };
      }
      return { ok: false, error: `Не удалось начислить: ${err.message}` };
    }
  }

  /** Ссылка на счёт: приходит заранее вместе с балансом, иначе запросим. */
  async invoiceLink(pack) {
    if (pack.link) return pack.link;
    const data = await this.post('/api/invoice', { pack: pack.key });
    if (!data.link) throw new Error(data.error || 'счёт не создан');
    return data.link;
  }
}

// ------------------------------------------------------------ вспомогательное

export function spinsWord(n) {
  const abs = Math.abs(n) % 100;
  const last = abs % 10;
  if (abs > 10 && abs < 20) return `${n} прокруток`;
  if (last === 1) return `${n} прокрутка`;
  if (last >= 2 && last <= 4) return `${n} прокрутки`;
  return `${n} прокруток`;
}

/** Ответ Adsgram при отказе — в понятную фразу. Сырые описания английские. */
function describeAdError(err) {
  const raw = String(err?.description || err?.error || err?.message || '').toLowerCase();
  if (err?.state === 'playing' || raw.includes('skip') || raw.includes('close')) {
    return 'Реклама закрыта до конца — прокрутка не начислена.';
  }
  if (raw.includes('no ad') || raw.includes('not found') || raw.includes('nobanner') || raw.includes('banner')) {
    return 'Сейчас нет рекламы для показа. Попробуйте позже.';
  }
  if (raw.includes('too long') || raw.includes('nonstop') || raw.includes('non stop')) {
    return 'Рекламная сеть ограничила показы. Попробуйте позже.';
  }
  return raw ? `Реклама не показалась: ${raw}` : 'Реклама не досмотрена — прокрутка не начислена.';
}

function readLocal() {
  const empty = { free_day: dayKey(), free_used: 0 };
  try {
    const raw = localStorage.getItem(LOCAL_KEY);
    if (!raw) return empty;
    const data = JSON.parse(raw);
    return { ...empty, ...data };
  } catch {
    return empty;
  }
}

function writeLocal(rec) {
  try {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(rec));
  } catch { /* приватный режим — просто не запомним */ }
}

/**
 * Загружает SDK Adsgram один раз и по требованию: до первого нажатия на
 * «Смотреть рекламу» скрипт рекламной сети приложению не нужен, а лишний
 * сторонний скрипт на старте — это и задержка, и чужой код на экране, где
 * его никто не просил.
 */
let adSdk = null;
let adCtl = null;

function loadAdSdk() {
  if (adSdk) return adSdk;
  adSdk = new Promise((resolve, reject) => {
    if (window.Adsgram) {
      resolve(window.Adsgram);
      return;
    }
    const script = document.createElement('script');
    script.src = 'https://sad.adsgram.ai/js/sad.min.js';
    script.async = true;
    script.onload = () => (window.Adsgram
      ? resolve(window.Adsgram)
      : reject(new Error('SDK рекламы загрузился, но не объявил себя')));
    script.onerror = () => reject(new Error('не удалось загрузить рекламу'));
    document.head.append(script);
  }).catch((err) => {
    adSdk = null; // следующая попытка начнётся заново
    throw err;
  });
  return adSdk;
}

async function adController(blockId) {
  const sdk = await loadAdSdk();
  if (!adCtl) adCtl = sdk.init({ blockId });
  return adCtl;
}
