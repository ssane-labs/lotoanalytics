"""Нейросеть, обученная на истории тиражей.

Что это. Перцептрон с двумя скрытыми слоями: по 15 признакам числа (частоты
в окнах от 5 до 1000 тиражей, сколько тиражей оно не выпадало, было ли в
прошлом тираже, частота за всю историю) оценивает вероятность, что число
выпадет в следующем тираже. Учится на всей накопленной истории каждой игры,
для каждого поля билета отдельно; веса публикуются в docs/data/<игра>_ai.json,
Mini App считает прямой проход сам (docs/ai.js).

Как проверяется. Сеть учится на первых 80 % тиражей и угадывает последние
20 %, которых не видела. В отчёт идут среднее число угаданных чисел против
случайного выбора и лог-потеря против базовой частоты. Тиражи независимы,
поэтому честный результат — «на уровне случайного выбора», и именно его
приложение показывает рядом с подбором.

Формулы продублированы в docs/ai.js, совпадение проверяет tests/parity.test.mjs.
"""
from __future__ import annotations

import math
from datetime import datetime, timezone
from typing import Sequence

import numpy as np

Draw = Sequence[int]

WINDOWS = (5, 10, 25, 50, 100, 250, 1000)
GAP_CAP = 200
HIDDEN = (32, 16)
N_FEATURES = 2 + len(WINDOWS) + 2 + 3 + 1  # позиция, чётность, окна, разрыв×2, прошлые тиражи×3, вся история

MIN_DRAWS_FOR_AI = 60
# Первые тиражи истории — разгон признаков: у окна в тысячу тиражей нет
# смысла, пока тысячи тиражей не было.
WARMUP = 50
HOLDOUT_SHARE = 0.2


def feature_matrix(draws: Sequence[Draw], pool: int, pick: int) -> np.ndarray:
    """Признаки перед каждым тиражом t (по draws[:t]) для всех чисел.

    Возвращает массив (len(draws)+1, pool, N_FEATURES): строка t — признаки
    перед тиражом t, последняя строка — перед следующим, ещё не сыгранным.
    """
    T = len(draws)
    rate = pick / pool
    hit = np.zeros((T, pool), dtype=np.float64)
    for t, d in enumerate(draws):
        for n in d:
            hit[t, n - 1] = 1.0
    cum = np.vstack([np.zeros((1, pool)), np.cumsum(hit, axis=0)])  # cum[t] = за draws[:t]
    steps = np.arange(T + 1)

    out = np.zeros((T + 1, pool, N_FEATURES), dtype=np.float64)
    nums = np.arange(1, pool + 1)
    out[:, :, 0] = nums / pool
    out[:, :, 1] = nums % 2
    col = 2
    for w in WINDOWS:
        lo = np.maximum(steps - w, 0)
        span = np.maximum(steps - lo, 1)
        out[:, :, col] = (cum[steps] - cum[lo]) / span[:, None] / rate
        col += 1

    # Разрыв: сколько тиражей число не выпадало (0 — выпало в прошлом).
    gap = np.full(pool, float(GAP_CAP))
    gaps = np.zeros((T + 1, pool))
    for t in range(T + 1):
        gaps[t] = gap
        if t < T:
            gap = np.where(hit[t] > 0, 0.0, np.minimum(gap + 1, GAP_CAP))
    out[:, :, col] = gaps / GAP_CAP
    out[:, :, col + 1] = np.log1p(gaps) / math.log1p(GAP_CAP)
    col += 2

    last = np.vstack([np.zeros((1, pool)), hit])  # last[t] = тираж t-1
    out[:, :, col] = last
    neigh = np.zeros_like(last)
    neigh[:, 1:] += last[:, :-1]
    neigh[:, :-1] += last[:, 1:]
    out[:, :, col + 1] = (neigh > 0).astype(np.float64)
    lo3 = np.maximum(steps - 3, 0)
    out[:, :, col + 2] = (cum[steps] - cum[lo3]) / 3.0
    col += 3

    out[:, :, col] = cum[steps] / np.maximum(steps, 1)[:, None] / rate
    return out


def features(history: Sequence[Draw], n: int, pool: int, pick: int) -> list[float]:
    """Признаки одного числа перед следующим тиражом (для тестов и сверки с JS)."""
    return feature_matrix(history, pool, pick)[-1, n - 1].tolist()


class MLP:
    """Входы → tanh → tanh → сигмоида."""

    def __init__(self, n_in: int, hidden: Sequence[int] = HIDDEN, seed: int = 20260926):
        rng = np.random.default_rng(seed)
        sizes = [n_in, *hidden, 1]
        self.W = [rng.normal(0, 1 / math.sqrt(a), (b, a)) for a, b in zip(sizes, sizes[1:])]
        self.b = [np.zeros(b) for b in sizes[1:]]
        self.mean = np.zeros(n_in)
        self.std = np.ones(n_in)

    def forward(self, x: np.ndarray) -> tuple[list[np.ndarray], np.ndarray]:
        acts = [(x - self.mean) / self.std]
        h = acts[0]
        for W, b in zip(self.W[:-1], self.b[:-1]):
            h = np.tanh(h @ W.T + b)
            acts.append(h)
        z = (h @ self.W[-1].T + self.b[-1])[:, 0]
        return acts, 1.0 / (1.0 + np.exp(-np.clip(z, -40, 40)))

    def predict(self, x: np.ndarray) -> np.ndarray:
        return self.forward(np.atleast_2d(x))[1]

    def fit(self, X: np.ndarray, y: np.ndarray, epochs: int = 12, lr: float = 2e-3,
            batch: int = 2048, l2: float = 1e-4, seed: int = 1,
            X_val: np.ndarray | None = None, y_val: np.ndarray | None = None) -> dict:
        self.mean = X.mean(axis=0)
        std = X.std(axis=0)
        self.std = np.where(std > 1e-12, std, 1.0)
        base = float(np.clip(y.mean(), 1e-6, 1 - 1e-6))
        self.b[-1][:] = math.log(base / (1 - base))

        params = self.W + self.b
        m = [np.zeros_like(p) for p in params]
        v = [np.zeros_like(p) for p in params]
        rng = np.random.default_rng(seed)
        step = 0
        best, best_state, history = math.inf, None, []
        for _ in range(epochs):
            order = rng.permutation(len(X))
            for s in range(0, len(X), batch):
                idx = order[s:s + batch]
                acts, p = self.forward(X[idx])
                grads_W, grads_b = [], []
                delta = ((p - y[idx]) / len(idx))[:, None]
                for layer in range(len(self.W) - 1, -1, -1):
                    grads_W.insert(0, delta.T @ acts[layer] + l2 * self.W[layer])
                    grads_b.insert(0, delta.sum(axis=0))
                    if layer:
                        delta = (delta @ self.W[layer]) * (1 - acts[layer] ** 2)
                step += 1
                for i, g in enumerate(grads_W + grads_b):
                    m[i] = 0.9 * m[i] + 0.1 * g
                    v[i] = 0.999 * v[i] + 0.001 * g * g
                    mh = m[i] / (1 - 0.9 ** step)
                    vh = v[i] / (1 - 0.999 ** step)
                    params[i] -= lr * mh / (np.sqrt(vh) + 1e-8)
            if X_val is not None:
                loss = log_loss(self.predict(X_val), y_val)
                history.append(loss)
                # Ранняя остановка: на случайных данных сеть быстро начинает
                # заучивать шум, и лучшая эпоха — одна из первых.
                if loss < best:
                    best = loss
                    best_state = ([w.copy() for w in self.W], [b.copy() for b in self.b])
        if best_state:
            self.W, self.b = best_state
        return {"val_loss": history}


def log_loss(p: np.ndarray, y: np.ndarray) -> float:
    p = np.clip(p, 1e-12, 1 - 1e-12)
    return float(-(y * np.log(p) + (1 - y) * np.log(1 - p)).mean())


def _dataset(feats: np.ndarray, draws: Sequence[Draw], steps: Sequence[int], pool: int):
    X = feats[list(steps)].reshape(-1, feats.shape[2])
    y = np.zeros((len(steps), pool))
    for row, t in enumerate(steps):
        for n in draws[t]:
            y[row, n - 1] = 1.0
    return X, y.reshape(-1)


def train(draws: Sequence[Draw], pool: int, pick: int, epochs: int = 12,
          seed: int = 20260926) -> tuple[MLP, dict]:
    """Обучить сеть на истории. Возвращает модель и сведения об обучении."""
    if len(draws) < MIN_DRAWS_FOR_AI:
        raise ValueError(f"нужно минимум {MIN_DRAWS_FOR_AI} тиражей, есть {len(draws)}")
    feats = feature_matrix(draws, pool, pick)
    warm = min(WARMUP, len(draws) // 3)
    steps = list(range(warm, len(draws)))
    cut = max(1, int(len(steps) * HOLDOUT_SHARE))
    train_steps, test_steps = steps[:-cut], steps[-cut:]
    val = max(1, len(train_steps) // 10)

    # Проверка на тиражах, которых сеть не видела.
    probe = MLP(N_FEATURES, seed=seed)
    Xtr, ytr = _dataset(feats, draws, train_steps[:-val], pool)
    Xva, yva = _dataset(feats, draws, train_steps[-val:], pool)
    probe.fit(Xtr, ytr, epochs=epochs, seed=seed, X_val=Xva, y_val=yva)
    Xte, yte = _dataset(feats, draws, test_steps, pool)
    p_test = probe.predict(Xte).reshape(len(test_steps), pool)
    matches = []
    for row, t in enumerate(test_steps):
        top = np.argsort(-p_test[row], kind="stable")[:pick] + 1
        matches.append(len(set(top.tolist()) & set(draws[t])))
    base_rate = pick / pool
    holdout = {
        "draws": len(test_steps),
        "mean_matches": round(float(np.mean(matches)), 4),
        "expected_by_chance": round(pick * pick / pool, 4),
        "log_loss": round(log_loss(p_test.reshape(-1), yte), 6),
        "log_loss_base_rate": round(log_loss(np.full(len(yte), base_rate), yte), 6),
    }

    # Публикуемая сеть — на всей истории. Последние 10 % служат только для
    # ранней остановки.
    model = MLP(N_FEATURES, seed=seed)
    tr_steps = steps[:-val]
    Xa, ya = _dataset(feats, draws, tr_steps, pool)
    Xv, yv = _dataset(feats, draws, steps[-val:], pool)
    report = model.fit(Xa, ya, epochs=epochs, seed=seed, X_val=Xv, y_val=yv)
    info = {
        "draws_used": len(steps),
        "samples": len(steps) * pool,
        "epochs": epochs,
        "val_loss": [round(x, 6) for x in report["val_loss"]],
        "holdout": holdout,
    }
    return model, info


def export(model: MLP, info: dict, draws: Sequence[Draw], pool: int, pick: int) -> dict:
    """Веса, нормировка и хвост истории, из которого JS считает признаки."""
    recent = [list(d) for d in draws[-max(WINDOWS):]]
    feats = feature_matrix(draws, pool, pick)[-1]
    probs = model.predict(feats)
    counts = [0] * pool
    for d in draws:
        for n in d:
            counts[n - 1] += 1
    # Разрыв для чисел, не выпадавших дольше хвоста истории, JS не вычислит
    # сам — отдаём его готовым.
    gaps = (feats[:, 2 + len(WINDOWS)] * GAP_CAP).round().astype(int).tolist()
    return {
        "pool": pool,
        "pick": pick,
        "arch": {"inputs": N_FEATURES, "hidden": list(HIDDEN), "activation": "tanh", "output": "sigmoid"},
        "windows": list(WINDOWS),
        "gap_cap": GAP_CAP,
        "norm": {"mean": model.mean.tolist(), "std": model.std.tolist()},
        "W": [w.tolist() for w in model.W],
        "b": [b.tolist() for b in model.b],
        "history": {"draws": len(draws), "counts": counts, "gaps": gaps, "recent": recent},
        "probs": probs.tolist(),
        **info,
    }


def export_game(nets: Sequence[dict], game_key: str) -> dict:
    return {
        "game": game_key,
        "insufficient": False,
        "trained_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "fields": list(nets),
    }
