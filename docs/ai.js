/**
 * Нейросеть в браузере — прямой проход модели из scripts/lotto/ai.py.
 *
 * Обучение идёт в GitHub Actions на всей истории тиражей, сюда приезжают
 * веса и хвост истории (docs/data/<игра>_ai.json), по одной сети на каждое
 * поле билета. Признаки и формулы обязаны совпадать с Python до бита — это
 * проверяет tests/parity.test.mjs.
 */

export class FieldAI {
  constructor(payload) {
    this.p = payload;
    this.pool = payload.pool;
    this.pick = payload.pick;
  }

  /** Признаки числа n перед следующим тиражом. Порядок — как в ai.py. */
  features(n) {
    const { windows, gap_cap: gapCap, history } = this.p;
    const rate = this.pick / this.pool;
    const recent = history.recent;
    const total = history.draws;
    const out = [n / this.pool, n % 2];
    for (const w of windows) {
      const span = Math.min(w, total);
      const chunk = recent.slice(recent.length - Math.min(w, recent.length));
      let hits = 0;
      for (const draw of chunk) if (draw.includes(n)) hits += 1;
      out.push(hits / Math.max(span, 1) / rate);
    }
    const gap = history.gaps[n - 1];
    out.push(gap / gapCap);
    out.push(Math.log1p(gap) / Math.log1p(gapCap));
    const last = recent.length ? recent[recent.length - 1] : [];
    out.push(last.includes(n) ? 1 : 0);
    out.push(last.includes(n - 1) || last.includes(n + 1) ? 1 : 0);
    let last3 = 0;
    for (const draw of recent.slice(-3)) if (draw.includes(n)) last3 += 1;
    out.push(last3 / 3);
    out.push(history.counts[n - 1] / Math.max(total, 1) / rate);
    return out;
  }

  predict(x) {
    const { mean, std } = this.p.norm;
    let h = x.map((v, j) => (v - mean[j]) / std[j]);
    const layers = this.p.W.length;
    for (let l = 0; l < layers; l += 1) {
      const W = this.p.W[l];
      const b = this.p.b[l];
      const next = W.map((row, i) => {
        let s = 0;
        for (let j = 0; j < row.length; j += 1) s += row[j] * h[j];
        return s + b[i];
      });
      h = l < layers - 1 ? next.map(Math.tanh) : next;
    }
    const z = Math.max(-40, Math.min(40, h[0]));
    return 1 / (1 + Math.exp(-z));
  }

  /** Вероятность выпадения каждого числа в следующем тираже, индекс n-1. */
  probabilities() {
    const out = [];
    for (let n = 1; n <= this.pool; n += 1) out.push(this.predict(this.features(n)));
    return out;
  }
}

/** Сети всех полей игры. */
export class DrawAI {
  constructor(payload) {
    this.payload = payload;
    this.fields = payload.fields.map((f) => new FieldAI(f));
  }

  /** Главное поле — для подписи под подбором. */
  get main() {
    return this.payload.fields[0];
  }

  probabilities() {
    return this.fields.map((f) => f.probabilities());
  }
}
