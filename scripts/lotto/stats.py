"""Статистика по реальным тиражам.

Здесь считаются «горячие» и «холодные» числа — но с честной подписью. Частоты
показывают, что уже выпало, и НЕ говорят, что выпадет дальше: шары не помнят
прошлых тиражей. Функция `uniformity_test` существует именно для того, чтобы
это проверять и показывать пользователю результат проверки.
"""
from __future__ import annotations

import math
from collections import Counter
from dataclasses import dataclass
from typing import Sequence

Draw = tuple[int, ...]


def _norm_sf(z: float) -> float:
    """P(Z > z) для стандартного нормального распределения."""
    return 0.5 * math.erfc(z / math.sqrt(2.0))


def chi2_sf(x: float, df: int) -> float:
    """P(chi2_df > x), приближение Уилсона—Хилферти.

    Точность порядка 1e-3 при df >= 5, чего достаточно: нас интересует, лежит
    ли p-value в разумном диапазоне, а не его четвёртый знак.
    """
    if df <= 0:
        return float("nan")
    if x <= 0:
        return 1.0
    t = (x / df) ** (1.0 / 3.0)
    mean = 1.0 - 2.0 / (9.0 * df)
    sd = math.sqrt(2.0 / (9.0 * df))
    return _norm_sf((t - mean) / sd)


@dataclass
class UniformityTest:
    chi2: float
    df: int
    p_value: float
    verdict: str

    def to_dict(self) -> dict:
        return {
            "chi2": round(self.chi2, 3),
            "df": self.df,
            "p_value": round(self.p_value, 4),
            "verdict": self.verdict,
        }


def number_counts(draws: Sequence[Draw], pool: int) -> list[int]:
    counter = Counter(n for draw in draws for n in draw)
    return [counter.get(n, 0) for n in range(1, pool + 1)]


def uniformity_test(draws: Sequence[Draw], pool: int, pick: int) -> UniformityTest:
    """Проверка гипотезы «все числа равновероятны» критерием хи-квадрат."""
    counts = number_counts(draws, pool)
    total = len(draws) * pick
    expected = total / pool
    if expected <= 0:
        return UniformityTest(0.0, 0, float("nan"), "недостаточно данных")
    chi2 = sum((c - expected) ** 2 / expected for c in counts)
    df = pool - 1
    p = chi2_sf(chi2, df)
    if p < 0.01:
        verdict = (
            "Отклонение от равномерности статистически значимо. "
            "Это повод перепроверить данные, а не искать закономерность."
        )
    else:
        verdict = (
            "Данные неотличимы от равномерной случайности. "
            "Это ожидаемый результат: прошлые тиражи не влияют на будущие."
        )
    return UniformityTest(chi2, df, p, verdict)


def gaps_since_last(draws: Sequence[Draw], pool: int) -> list[int | None]:
    """Сколько тиражей назад число выпадало в последний раз.

    `draws` — от старых к новым. None означает «не выпадало ни разу».
    """
    last: dict[int, int] = {}
    for idx, draw in enumerate(draws):
        for n in draw:
            last[n] = idx
    total = len(draws)
    return [
        (total - 1 - last[n]) if n in last else None for n in range(1, pool + 1)
    ]


def sum_distribution(draws: Sequence[Draw]) -> dict[str, float]:
    sums = [sum(d) for d in draws]
    if not sums:
        return {}
    mean = sum(sums) / len(sums)
    var = sum((s - mean) ** 2 for s in sums) / len(sums)
    ordered = sorted(sums)
    return {
        "mean": round(mean, 2),
        "std": round(math.sqrt(var), 2),
        "min": ordered[0],
        "max": ordered[-1],
        "p05": ordered[int(0.05 * (len(ordered) - 1))],
        "p50": ordered[int(0.50 * (len(ordered) - 1))],
        "p95": ordered[int(0.95 * (len(ordered) - 1))],
    }


def parity_distribution(draws: Sequence[Draw], pick: int) -> dict[str, int]:
    counter = Counter(sum(1 for n in d if n % 2 == 0) for d in draws)
    return {f"{e}_even_{pick - e}_odd": counter.get(e, 0) for e in range(pick + 1)}


def pair_counts(draws: Sequence[Draw], top: int = 15) -> list[dict]:
    counter: Counter[tuple[int, int]] = Counter()
    for draw in draws:
        ordered = sorted(draw)
        for i, a in enumerate(ordered):
            for b in ordered[i + 1 :]:
                counter[(a, b)] += 1
    return [
        {"pair": [a, b], "count": c} for (a, b), c in counter.most_common(top)
    ]


def consecutive_share(draws: Sequence[Draw]) -> float:
    """Доля тиражей, где встретилась хотя бы одна пара соседних чисел.

    Полезный факт против интуиции: для 6/45 это около 50%, хотя игроки
    считают соседние числа «маловероятными» и избегают их.
    """
    if not draws:
        return 0.0
    hits = 0
    for draw in draws:
        ordered = sorted(draw)
        if any(b - a == 1 for a, b in zip(ordered, ordered[1:])):
            hits += 1
    return hits / len(draws)


def summarize(draws: Sequence[Draw], pool: int, pick: int) -> dict:
    counts = number_counts(draws, pool)
    gaps = gaps_since_last(draws, pool)
    expected = (len(draws) * pick / pool) if draws else 0.0
    numbers = [
        {
            "n": i + 1,
            "count": counts[i],
            "expected": round(expected, 2),
            "deviation": round(counts[i] - expected, 2),
            "gap": gaps[i],
        }
        for i in range(pool)
    ]
    return {
        "draws_analyzed": len(draws),
        "numbers": numbers,
        "hot": sorted(numbers, key=lambda x: -x["count"])[:6],
        "cold": sorted(numbers, key=lambda x: x["count"])[:6],
        "overdue": sorted(
            (x for x in numbers if x["gap"] is not None),
            key=lambda x: -x["gap"],
        )[:6],
        "uniformity": uniformity_test(draws, pool, pick).to_dict(),
        "sums": sum_distribution(draws),
        "parity": parity_distribution(draws, pick),
        "top_pairs": pair_counts(draws),
        "consecutive_share": round(consecutive_share(draws), 4),
    }
