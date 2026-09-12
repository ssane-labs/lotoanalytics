"""Генератор непопулярных комбинаций.

ВАЖНО про честность метода. Мы отбираем комбинации из РАВНОМЕРНОЙ выборки по
всему пространству. Любая фильтрация оставляет каждую уцелевшую комбинацию
ровно так же вероятной, как и любую другую: шанс выиграть у выданного билета
точно тот же самый 1/C(45,6). Мы не «повышаем шанс» — мы выбираем среди
равновероятных ту, которую вряд ли поставил кто-то ещё.
"""
from __future__ import annotations

import random
from dataclasses import dataclass
from typing import Sequence

from .popularity import GameSpec, popularity_breakdown, popularity_weight


@dataclass
class Candidate:
    combo: tuple[int, ...]
    weight: float
    breakdown: dict[str, float]

    def to_dict(self) -> dict:
        return {
            "combo": list(self.combo),
            "weight": self.weight,
            "breakdown": self.breakdown,
        }


def generate(
    game: GameSpec,
    count: int = 5,
    include: Sequence[int] = (),
    exclude: Sequence[int] = (),
    candidates: int = 20_000,
    params: dict | None = None,
    past_winners: set[tuple[int, ...]] | None = None,
    seed: int | None = None,
    distinct_overlap: int | None = None,
) -> list[Candidate]:
    """Вернуть `count` комбинаций с наименьшим весом популярности.

    include/exclude — пользовательские ограничения (например, «оставь мою
    семёрку»). Они сужают пространство, но внутри него выбор остаётся
    равномерным, поэтому вероятность выигрыша не меняется.

    distinct_overlap — максимально допустимое пересечение между выданными
    комбинациями, чтобы набор билетов покрывал разные числа.
    """
    include = tuple(sorted(set(include)))
    excluded = set(exclude)
    if set(include) & excluded:
        raise ValueError("Число нельзя одновременно включить и исключить")
    if len(include) > game.pick:
        raise ValueError(f"Можно зафиксировать не больше {game.pick} чисел")

    pool = [n for n in range(1, game.pool + 1) if n not in excluded and n not in include]
    need = game.pick - len(include)
    if len(pool) < need:
        raise ValueError("После ограничений осталось слишком мало чисел")

    rng = random.Random(seed)
    scored: list[Candidate] = []
    seen: set[tuple[int, ...]] = set()

    for _ in range(candidates):
        combo = tuple(sorted(include + tuple(rng.sample(pool, need))))
        if combo in seen:
            continue
        seen.add(combo)
        breakdown = popularity_breakdown(combo, game, params, past_winners)
        weight = 1.0
        for value in breakdown.values():
            weight *= value
        scored.append(Candidate(combo, weight, breakdown))

    scored.sort(key=lambda c: c.weight)

    if distinct_overlap is None:
        return scored[:count]

    chosen: list[Candidate] = []
    for cand in scored:
        if all(
            len(set(cand.combo) & set(other.combo)) <= distinct_overlap
            for other in chosen
        ):
            chosen.append(cand)
        if len(chosen) == count:
            break
    return chosen


def percentile_of(
    combo: Sequence[int],
    game: GameSpec,
    params: dict | None = None,
    samples: int = 20_000,
    seed: int = 777,
) -> float:
    """Доля случайных комбинаций, которые популярнее данной (0..1).

    1.0 означает «непопулярнее всех» — то, что нам нужно.
    """
    rng = random.Random(seed)
    target = popularity_weight(combo, game, params)
    pool = list(range(1, game.pool + 1))
    heavier = 0
    for _ in range(samples):
        other = rng.sample(pool, game.pick)
        if popularity_weight(other, game, params) > target:
            heavier += 1
    return heavier / samples
