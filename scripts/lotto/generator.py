"""Генератор непопулярных комбинаций.

ВАЖНО про честность метода. Мы отбираем билеты из РАВНОМЕРНОЙ выборки по
всему пространству. Любая фильтрация оставляет каждый уцелевший билет ровно
так же вероятным, как любой другой: шанс выиграть у выданного билета тот же
самый 1/C(45,6). Мы не «повышаем шанс» — мы выбираем среди равновероятных тот,
который вряд ли поставил кто-то ещё.

Ограничения include/exclude относятся к главному полю: именно там человек
хочет «оставить свою семёрку». Остальные поля подбираются целиком.
"""
from __future__ import annotations

import random
from dataclasses import dataclass
from typing import Sequence

from .popularity import GameSpec, Ticket, as_ticket, popularity_breakdown, popularity_weight, random_ticket


@dataclass
class Candidate:
    ticket: Ticket
    weight: float
    breakdown: dict[str, float]

    @property
    def combo(self) -> tuple[int, ...]:
        """Главное поле — для однопольных игр это весь билет."""
        return self.ticket[0]

    def to_dict(self) -> dict:
        return {
            "numbers": [list(f) for f in self.ticket],
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
    """Вернуть `count` билетов с наименьшим весом популярности.

    distinct_overlap — максимально допустимое пересечение главных полей
    выданных билетов, чтобы набор покрывал разные числа.
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
    seen: set[Ticket] = set()

    for _ in range(candidates):
        rest = random_ticket(game, rng)[1:]
        main = tuple(sorted(include + tuple(rng.sample(pool, need))))
        ticket = (main,) + rest
        if ticket in seen:
            continue
        seen.add(ticket)
        breakdown = popularity_breakdown(ticket, game, params, past_winners)
        weight = 1.0
        for value in breakdown.values():
            weight *= value
        scored.append(Candidate(ticket, weight, breakdown))

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
    combo,
    game: GameSpec,
    params: dict | None = None,
    samples: int = 20_000,
    seed: int = 777,
) -> float:
    """Доля случайных билетов, которые популярнее данного (0..1).

    1.0 означает «непопулярнее всех» — то, что нам нужно.
    """
    rng = random.Random(seed)
    target = popularity_weight(as_ticket(combo, game), game, params)
    heavier = 0
    for _ in range(samples):
        if popularity_weight(random_ticket(game, rng), game, params) > target:
            heavier += 1
    return heavier / samples
