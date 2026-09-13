"""Нейросеть, обученная на истории тиражей.

Честно о том, что это. Сеть — настоящая: многослойный перцептрон, который
учится по прошлым тиражам предсказывать, выпадет ли каждое число в следующем.
Обучается по расписанию на всей накопленной истории, веса публикуются в
docs/data/<игра>_ai.json, а Mini App считает прямой проход сам.

И так же честно о том, чего она не может. Тиражи независимы, поэтому лучшее,
чего способна достичь любая модель, — сойтись к «все числа равновероятны».
Каждый раз при обучении мы откладываем последние тиражи, которых сеть не
видела, и публикуем, сколько чисел она на них угадала против случайного
выбора. Этот результат показывается пользователю рядом с подбором.

Реализация на чистом Python без numpy: ядро проекта работает на стандартной
библиотеке, а сеть маленькая. Формулы продублированы в docs/ai.js, их
совпадение проверяет tests/parity.test.mjs.
"""
from __future__ import annotations

import math
import random
from datetime import datetime, timezone
from typing import Sequence

Draw = Sequence[int]

WINDOWS = (5, 10, 25, 50)
GAP_CAP = 50
HIDDEN = 12
N_FEATURES = 4 + len(WINDOWS) + 1  # позиция, чётность, окна, разрыв, прошлый тираж, соседи

# Меньше этого сеть учится буквально на паре примеров. Порог низкий
# сознательно: архив растёт каждый день, и модель переобучается вместе с ним.
MIN_DRAWS_FOR_AI = 10
# Обучаем на последних тиражах: чистый Python не любит сотни тысяч примеров,
# а более старая история для этих признаков ничего не добавляет.
MAX_TRAIN_DRAWS = 250
WARMUP = 5


def features(history: Sequence[Draw], n: int, pool: int, pick: int) -> list[float]:
    """Признаки числа n перед следующим тиражом. history — от старых к новым."""
    rate = pick / pool
    out = [n / pool, float(n % 2)]
    for w in WINDOWS:
        chunk = history[-w:]
        hits = sum(1 for draw in chunk if n in draw)
        out.append(hits / max(len(chunk), 1) / rate)
    gap = GAP_CAP
    for back, draw in enumerate(reversed(history[-GAP_CAP:])):
        if n in draw:
            gap = back
            break
    out.append(gap / GAP_CAP)
    last = history[-1] if history else ()
    out.append(1.0 if n in last else 0.0)
    out.append(1.0 if (n - 1 in last or n + 1 in last) else 0.0)
    return out


def _dataset(draws: Sequence[Draw], steps: Sequence[int], pool: int, pick: int):
    xs, ys = [], []
    for t in steps:
        past = draws[:t]
        target = set(draws[t])
        for n in range(1, pool + 1):
            xs.append(features(past, n, pool, pick))
            ys.append(1.0 if n in target else 0.0)
    return xs, ys


def _sigmoid(z: float) -> float:
    if z >= 0:
        return 1.0 / (1.0 + math.exp(-z))
    e = math.exp(z)
    return e / (1.0 + e)


class MLP:
    """Перцептрон: входы → tanh-слой → сигмоида."""

    def __init__(self, n_in: int, hidden: int, seed: int):
        rng = random.Random(seed)
        scale = 1.0 / math.sqrt(n_in)
        self.W1 = [[rng.gauss(0, scale) for _ in range(n_in)] for _ in range(hidden)]
        self.b1 = [0.0] * hidden
        self.w2 = [rng.gauss(0, 1.0 / math.sqrt(hidden)) for _ in range(hidden)]
        self.b2 = 0.0
        self.mean = [0.0] * n_in
        self.std = [1.0] * n_in

    def normalize(self, x: Sequence[float]) -> list[float]:
        return [(v - m) / s for v, m, s in zip(x, self.mean, self.std)]

    def forward(self, xn: Sequence[float]) -> tuple[list[float], float]:
        h = [math.tanh(sum(w * v for w, v in zip(row, xn)) + b)
             for row, b in zip(self.W1, self.b1)]
        p = _sigmoid(sum(w * v for w, v in zip(self.w2, h)) + self.b2)
        return h, p

    def predict(self, x: Sequence[float]) -> float:
        return self.forward(self.normalize(x))[1]

    def fit(self, xs, ys, epochs: int, lr: float, l2: float, seed: int) -> list[float]:
        n_in = len(xs[0])
        count = len(xs)
        self.mean = [sum(x[j] for x in xs) / count for j in range(n_in)]
        self.std = []
        for j in range(n_in):
            var = sum((x[j] - self.mean[j]) ** 2 for x in xs) / count
            self.std.append(math.sqrt(var) if var > 1e-12 else 1.0)
        data = [(self.normalize(x), y) for x, y in zip(xs, ys)]

        # Числа выпадают редко (6 из 45), и без стартового смещения сеть
        # первые эпохи тратит только на то, чтобы выучить базовую частоту.
        base = min(max(sum(ys) / count, 1e-6), 1 - 1e-6)
        self.b2 = math.log(base / (1 - base))

        rng = random.Random(seed)
        losses = []
        for _ in range(epochs):
            rng.shuffle(data)
            total = 0.0
            for xn, y in data:
                h, p = self.forward(xn)
                total -= y * math.log(max(p, 1e-12)) + (1 - y) * math.log(max(1 - p, 1e-12))
                dz = p - y
                for i, hi in enumerate(h):
                    dh = dz * self.w2[i] * (1 - hi * hi)
                    self.w2[i] -= lr * (dz * hi + l2 * self.w2[i])
                    row = self.W1[i]
                    for j, v in enumerate(xn):
                        row[j] -= lr * (dh * v + l2 * row[j])
                    self.b1[i] -= lr * dh
                self.b2 -= lr * dz
            losses.append(total / count)
        return losses


def train(
    draws: Sequence[Draw],
    pool: int,
    pick: int,
    epochs: int = 30,
    lr: float = 0.02,
    l2: float = 1e-4,
    seed: int = 20260913,
) -> tuple[MLP, dict]:
    """Обучить сеть на истории. Возвращает модель и сведения об обучении."""
    if len(draws) < MIN_DRAWS_FOR_AI:
        raise ValueError(f"нужно минимум {MIN_DRAWS_FOR_AI} тиражей, есть {len(draws)}")
    start = max(WARMUP, len(draws) - MAX_TRAIN_DRAWS)
    steps = list(range(start, len(draws)))

    # Отложенная проверка по времени: сеть учится на ранних тиражах и
    # угадывает поздние, которых не видела. Иначе проверка ничего не значит.
    cut = max(1, len(steps) // 5)
    train_steps, test_steps = steps[:-cut], steps[-cut:]
    holdout = None
    if train_steps:
        probe = MLP(N_FEATURES, HIDDEN, seed)
        probe.fit(*_dataset(draws, train_steps, pool, pick), epochs, lr, l2, seed)
        matches = []
        for t in test_steps:
            past = draws[:t]
            ranked = sorted(range(1, pool + 1),
                            key=lambda n: -probe.predict(features(past, n, pool, pick)))
            matches.append(len(set(ranked[:pick]) & set(draws[t])))
        holdout = {
            "draws": len(test_steps),
            "mean_matches": round(sum(matches) / len(matches), 4),
            "expected_by_chance": round(pick * pick / pool, 4),
        }

    model = MLP(N_FEATURES, HIDDEN, seed)
    xs, ys = _dataset(draws, steps, pool, pick)
    losses = model.fit(xs, ys, epochs, lr, l2, seed)
    info = {
        "draws_used": len(steps),
        "samples": len(xs),
        "epochs": epochs,
        "final_loss": round(losses[-1], 6),
        "holdout": holdout,
    }
    return model, info


def export(model: MLP, info: dict, draws: Sequence[Draw], game_key: str,
           pool: int, pick: int) -> dict:
    """JSON для Mini App: веса, нормировка и эталон для проверки JS."""
    check_history = [list(d) for d in draws[-(GAP_CAP + 10):]]
    return {
        "game": game_key,
        "insufficient": False,
        "trained_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "arch": {"inputs": N_FEATURES, "hidden": HIDDEN, "activation": "tanh", "output": "sigmoid"},
        "windows": list(WINDOWS),
        "gap_cap": GAP_CAP,
        "pool": pool,
        "pick": pick,
        "norm": {"mean": model.mean, "std": model.std},
        "W1": model.W1,
        "b1": model.b1,
        "w2": model.w2,
        "b2": model.b2,
        **info,
        "check": {
            "history": check_history,
            "probs": [model.predict(features(check_history, n, pool, pick))
                      for n in range(1, pool + 1)],
        },
    }
