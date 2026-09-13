/**
 * Нейросеть в браузере — прямой проход модели из scripts/lotto/ai.py.
 *
 * Обучение идёт в GitHub Actions на всей истории тиражей, сюда приезжают
 * только веса (docs/data/<игра>_ai.json). Признаки и формулы обязаны
 * совпадать с Python до бита — это проверяет tests/parity.test.mjs.
 */

export class DrawAI {
  constructor(payload) {
    this.p = payload;
    this.pool = payload.pool;
    this.pick = payload.pick;
  }

  features(history, n) {
    const { windows, gap_cap: gapCap } = this.p;
    const rate = this.pick / this.pool;
    const out = [n / this.pool, n % 2];
    for (const w of windows) {
      const chunk = history.slice(-w);
      let hits = 0;
      for (const draw of chunk) if (draw.includes(n)) hits += 1;
      out.push(hits / Math.max(chunk.length, 1) / rate);
    }
    let gap = gapCap;
    const recent = history.slice(-gapCap);
    for (let back = 0; back < recent.length; back += 1) {
      if (recent[recent.length - 1 - back].includes(n)) {
        gap = back;
        break;
      }
    }
    out.push(gap / gapCap);
    const last = history.length ? history[history.length - 1] : [];
    out.push(last.includes(n) ? 1 : 0);
    out.push(last.includes(n - 1) || last.includes(n + 1) ? 1 : 0);
    return out;
  }

  predict(x) {
    const { mean, std } = this.p.norm;
    const xn = x.map((v, j) => (v - mean[j]) / std[j]);
    let z = this.p.b2;
    this.p.W1.forEach((row, i) => {
      let s = this.p.b1[i];
      row.forEach((w, j) => { s += w * xn[j]; });
      z += this.p.w2[i] * Math.tanh(s);
    });
    if (z >= 0) return 1 / (1 + Math.exp(-z));
    const e = Math.exp(z);
    return e / (1 + e);
  }

  /** Вероятность выпадения каждого числа в следующем тираже, индекс n-1. */
  probabilities(history) {
    const out = [];
    for (let n = 1; n <= this.pool; n += 1) out.push(this.predict(this.features(history, n)));
    return out;
  }
}
