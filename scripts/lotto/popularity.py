"""Модель популярности комбинаций — ключевая идея продукта.

Вероятность выиграть у любой комбинации одинакова: 1/C(45,6). Изменить её
нельзя, и мы этого не обещаем. Но джекпот в «6 из 45» пари-мьютюэльный — он
делится между всеми, кто угадал. Игроки выбирают числа крайне неравномерно
(дни рождения, «счастливые» числа, узоры на бланке), поэтому одни комбинации
поставлены тысячами человек, а другие — почти никем.

Непопулярная комбинация не повышает шанс выиграть, но повышает ожидаемую
ВЫПЛАТУ при выигрыше, потому что делить джекпот будет не с кем. Это
единственный математически честный «эдж» в лотерее, и он измерим.

Веса факторов — оценки из опубликованных исследований выбора чисел игроками,
а не измерения на российских данных. См. model_params.json.
"""
from __future__ import annotations

import json
import math
import os
from dataclasses import dataclass
from functools import lru_cache
from typing import Iterable, Sequence

Combo = tuple[int, ...]

_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
_PARAMS_PATH = os.path.join(_ROOT, "model_params.json")


@lru_cache(maxsize=4)
def load_params(path: str | None = None) -> dict:
    with open(path or _PARAMS_PATH, encoding="utf-8") as fh:
        return json.load(fh)


@dataclass(frozen=True)
class GameSpec:
    key: str
    title: str
    pick: int
    pool: int
    ticket_price_rub: float
    slip_rows: int
    slip_cols: int
    prizes_rub: dict[int, float | None]
    typical_players_per_draw: int

    @property
    def total_combinations(self) -> int:
        return math.comb(self.pool, self.pick)


def load_game(key: str = "6x45", params: dict | None = None) -> GameSpec:
    p = params or load_params()
    g = p["games"][key]
    return GameSpec(
        key=key,
        title=g["title"],
        pick=g["pick"],
        pool=g["pool"],
        ticket_price_rub=g["ticket_price_rub"],
        slip_rows=g["slip"]["rows"],
        slip_cols=g["slip"]["cols"],
        prizes_rub={int(k): v for k, v in g["prizes_rub"].items()},
        typical_players_per_draw=g["typical_players_per_draw"],
    )


# ---------------------------------------------------------------------------
# Отдельные факторы. Каждый возвращает мультипликатор относительно равномерного
# выбора: >1 — игроки ставят такую комбинацию чаще, <1 — реже.
# ---------------------------------------------------------------------------

def _number_factor(combo: Sequence[int], cfg: dict) -> float:
    nw = cfg["number_weights"]
    overrides = {int(k): v for k, v in nw["overrides"].items()}
    out = 1.0
    for n in combo:
        if n in overrides:
            out *= overrides[n]
        elif n <= 12:
            out *= nw["base_1_12"]
        elif n <= 31:
            out *= nw["base_13_31"]
        else:
            out *= nw["base_32_45"]
    return out


def _max_run_length(combo: Sequence[int]) -> int:
    best = run = 1
    for prev, cur in zip(combo, combo[1:]):
        run = run + 1 if cur == prev + 1 else 1
        best = max(best, run)
    return best


def _consecutive_factor(combo: Sequence[int], cfg: dict) -> float:
    c = cfg["consecutive_run"]
    run = _max_run_length(combo)
    if run == 1:
        # Ни одной соседней пары: игроки считают такие наборы «более случайными»
        # и выбирают их чаще. Для нас это минус.
        return c["no_adjacent_pair_bonus"]
    return float(c["run_length_multiplier"].get(str(run), 1.0))


def _arithmetic_factor(combo: Sequence[int], cfg: dict) -> float:
    c = cfg["arithmetic_progression"]
    diffs = {b - a for a, b in zip(combo, combo[1:])}
    if len(diffs) == 1 and diffs != {1}:
        # Ровная прогрессия с шагом > 1 (шаг 1 уже наказан как run).
        return c["full_ap_multiplier"]
    if len(combo) >= 5:
        for start in range(len(combo) - 4):
            window = combo[start : start + 5]
            wdiffs = {b - a for a, b in zip(window, window[1:])}
            if len(wdiffs) == 1 and wdiffs != {1}:
                return c["partial_ap_5_multiplier"]
    return 1.0


def _grid_pos(n: int, cols: int) -> tuple[int, int]:
    return ((n - 1) // cols, (n - 1) % cols)


def _grid_factor(combo: Sequence[int], cfg: dict, game: GameSpec) -> float:
    c = cfg["grid_pattern"]
    positions = sorted(_grid_pos(n, game.slip_cols) for n in combo)
    rows = [r for r, _ in positions]
    cols = [x for _, x in positions]
    k = len(combo)

    if len(set(rows)) == 1:
        return c["full_row_multiplier"]
    if len(set(cols)) == 1:
        return c["full_col_multiplier"]

    # Диагональ: одинаковый шаг по строкам и столбцам.
    for dc in (1, -1):
        best = run = 1
        for (r0, c0), (r1, c1) in zip(positions, positions[1:]):
            run = run + 1 if (r1 - r0 == 1 and c1 - c0 == dc) else 1
            best = max(best, run)
        if best >= min(5, k):
            return c["diagonal_multiplier"]

    factor = 1.0
    threshold = max(4, k - 2)
    if max(rows.count(r) for r in set(rows)) >= threshold:
        factor *= c["single_row_concentration_multiplier"]
    if max(cols.count(x) for x in set(cols)) >= threshold:
        factor *= c["single_col_concentration_multiplier"]
    return factor


def _sum_factor(combo: Sequence[int], cfg: dict) -> float:
    c = cfg["sum_window"]
    z = (sum(combo) - c["human_peak"]) / c["sigma"]
    return 1.0 + (c["peak_multiplier"] - 1.0) * math.exp(-0.5 * z * z)


def _parity_factor(combo: Sequence[int], cfg: dict) -> float:
    c = cfg["parity_balance"]
    evens = sum(1 for n in combo if n % 2 == 0)
    k = len(combo)
    if k % 2 == 0 and evens == k // 2:
        return c["balanced_3_3_multiplier"]
    if evens in (0, k):
        return c["extreme_0_6_multiplier"]
    return 1.0


def _range_factor(combo: Sequence[int], cfg: dict) -> float:
    c = cfg["decade_clustering"]
    if combo[-1] - combo[0] <= c["narrow_range_threshold"]:
        return c["narrow_range_multiplier"]
    return 1.0


def _history_factor(combo: Sequence[int], cfg: dict, past: set[Combo] | None) -> float:
    if not past:
        return 1.0
    c = cfg["past_winner_repeat"]
    key = tuple(combo)
    if key in past:
        return c["exact_repeat_multiplier"]
    target = set(key)
    need = len(key) - 1
    for old in past:
        if len(target.intersection(old)) >= need:
            return c["five_of_six_repeat_multiplier"]
    return 1.0


FACTOR_LABELS = {
    "numbers": "Выбор отдельных чисел (дни рождения, «счастливые»)",
    "consecutive": "Подряд идущие числа",
    "arithmetic": "Арифметическая прогрессия",
    "grid": "Узор на бланке (строка, столбец, диагональ)",
    "sum": "Сумма чисел в «человеческом» диапазоне",
    "parity": "Баланс чётных и нечётных",
    "range": "Все числа в узком диапазоне",
    "history": "Повтор ранее выпавшей комбинации",
}


def popularity_breakdown(
    combo: Iterable[int],
    game: GameSpec,
    params: dict | None = None,
    past_winners: set[Combo] | None = None,
) -> dict[str, float]:
    """Разложение веса популярности по факторам. Произведение = итоговый вес."""
    combo = tuple(sorted(combo))
    cfg = (params or load_params())["popularity"]
    return {
        "numbers": _number_factor(combo, cfg),
        "consecutive": _consecutive_factor(combo, cfg),
        "arithmetic": _arithmetic_factor(combo, cfg),
        "grid": _grid_factor(combo, cfg, game),
        "sum": _sum_factor(combo, cfg),
        "parity": _parity_factor(combo, cfg),
        "range": _range_factor(combo, cfg),
        "history": _history_factor(combo, cfg, past_winners),
    }


def popularity_weight(
    combo: Iterable[int],
    game: GameSpec,
    params: dict | None = None,
    past_winners: set[Combo] | None = None,
) -> float:
    """Ненормированный вес: во сколько раз чаще равномерного ставят комбинацию."""
    out = 1.0
    for value in popularity_breakdown(combo, game, params, past_winners).values():
        out *= value
    return out


def mean_weight(
    game: GameSpec,
    params: dict | None = None,
    samples: int = 200_000,
    seed: int = 12345,
) -> float:
    """Средний вес по равномерной выборке комбинаций.

    Нужен для нормировки: доля игроков, поставивших конкретную комбинацию,
    равна weight(combo) / (mean_weight * C(pool, pick)). Оценка Монте-Карло
    несмещённая, поскольку выборка равномерна по всему пространству.
    """
    import random

    rng = random.Random(seed)
    pool = list(range(1, game.pool + 1))
    total = 0.0
    for _ in range(samples):
        combo = tuple(sorted(rng.sample(pool, game.pick)))
        total += popularity_weight(combo, game, params)
    return total / samples


def pick_share(
    combo: Iterable[int],
    game: GameSpec,
    mean_w: float,
    params: dict | None = None,
    past_winners: set[Combo] | None = None,
) -> float:
    """Оценка доли всех ставок тиража, приходящейся на эту комбинацию."""
    w = popularity_weight(combo, game, params, past_winners)
    return w / (mean_w * game.total_combinations)
