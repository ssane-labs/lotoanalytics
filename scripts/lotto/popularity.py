"""Модель популярности комбинаций — ключевая идея продукта.

Вероятность выиграть у любой комбинации одинакова: 1/C(45,6) в «6 из 45».
Изменить её нельзя, и мы этого не обещаем. Но суперприз пари-мьютюэльный —
он делится между всеми, кто угадал. Игроки выбирают числа крайне неравномерно
(дни рождения, «счастливые» числа, узоры на бланке), поэтому одни комбинации
поставлены многими, а другие — почти никем.

Непопулярная комбинация не повышает шанс выиграть, но повышает ожидаемую
ВЫПЛАТУ при выигрыше, потому что делить суперприз будет не с кем.

Откуда веса. Структурные факторы (узоры, прогрессии, суммы) — из исследований
выбора чисел. Веса отдельных чисел и доля случайных ставок («автовыбор»)
обучены на итогах тиражей Столото: если выпали числа, которые люди любят
ставить, победителей в тираже больше ожидаемого. Этим занимается
scripts/calibrate_popularity.py, результат лежит в блоке calibration игры.

Билет — кортеж полей. В «6 из 45» поле одно, в «4 из 20» два по 4 из 20, в
«5 из 36» — 5 чисел и бонусный номер 1 из 4. Структурные факторы считаются
только в полях от трёх чисел: у пары из десяти не бывает «узора».
"""
from __future__ import annotations

import json
import math
import os
from dataclasses import dataclass
from functools import lru_cache
from typing import Iterable, Sequence

Combo = tuple[int, ...]
Ticket = tuple[Combo, ...]

_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
_PARAMS_PATH = os.path.join(_ROOT, "model_params.json")

# Поля меньше этого размера узоров не образуют: только веса чисел.
MIN_PATTERN_PICK = 3


@lru_cache(maxsize=4)
def load_params(path: str | None = None) -> dict:
    with open(path or _PARAMS_PATH, encoding="utf-8") as fh:
        return json.load(fh)


@dataclass(frozen=True)
class FieldSpec:
    pick: int
    pool: int
    slip_rows: int
    slip_cols: int

    @property
    def combinations(self) -> int:
        return math.comb(self.pool, self.pick)


@dataclass(frozen=True)
class GameSpec:
    key: str
    title: str
    fields: tuple[FieldSpec, ...]
    ticket_price_rub: float
    typical_players_per_draw: int
    default_jackpot_rub: float
    # Категории выигрыша в порядке Столото: первая — суперприз. match — какие
    # сочетания совпадений по полям в неё попадают.
    categories: tuple[tuple[tuple[int, ...], ...], ...] = ()
    category_titles: tuple[str, ...] = ()
    # Выплата по категориям, None — делится между победителями (суперприз).
    prizes_rub: tuple[float | None, ...] = ()
    stoloto: str | None = None

    # Главное поле — для совместимости с однопольным кодом.
    @property
    def pick(self) -> int:
        return self.fields[0].pick

    @property
    def pool(self) -> int:
        return self.fields[0].pool

    @property
    def slip_rows(self) -> int:
        return self.fields[0].slip_rows

    @property
    def slip_cols(self) -> int:
        return self.fields[0].slip_cols

    @property
    def total_combinations(self) -> int:
        out = 1
        for f in self.fields:
            out *= f.combinations
        return out


def load_game(key: str = "6x45", params: dict | None = None) -> GameSpec:
    p = params or load_params()
    g = p["games"][key]
    fields = tuple(
        FieldSpec(f["pick"], f["pool"], f["slip"]["rows"], f["slip"]["cols"])
        for f in g["fields"]
    )
    cats = g.get("categories", [])
    return GameSpec(
        key=key,
        title=g["title"],
        fields=fields,
        ticket_price_rub=g["ticket_price_rub"],
        typical_players_per_draw=g["typical_players_per_draw"],
        default_jackpot_rub=g.get("default_jackpot_rub", 100_000_000),
        categories=tuple(tuple(tuple(m) for m in c["match"]) for c in cats),
        category_titles=tuple(c["title"] for c in cats),
        prizes_rub=tuple(g.get("prizes_rub") or [None] * len(cats)),
        stoloto=g.get("stoloto"),
    )


def as_ticket(combo: Iterable, game: GameSpec) -> Ticket:
    """Билет из чего угодно: плоского списка чисел или списка полей."""
    items = list(combo)
    if items and isinstance(items[0], (list, tuple)):
        return tuple(tuple(sorted(f)) for f in items)
    out, pos = [], 0
    for f in game.fields:
        out.append(tuple(sorted(items[pos:pos + f.pick])))
        pos += f.pick
    return tuple(out)


def popularity_config(params: dict, game_key: str) -> dict:
    """Параметры популярности для конкретной игры.

    Общие веса лежат в params["popularity"], игра может переопределить
    отдельные группы (окно суммы у каждой игры своё). Результат обучения —
    блок calibration — кладётся сюда же под ключом "calibration".
    """
    base = params["popularity"]
    game = params["games"].get(game_key, {})
    merged = dict(base)
    for group, values in (game.get("popularity_overrides") or {}).items():
        if isinstance(values, dict):
            merged[group] = {**base.get(group, {}), **values}
    cal = game.get("calibration")
    if cal:
        merged["calibration"] = {
            "random_share": cal["random_share"],
            "field_weights": cal["field_weights"],
        }
        # Обученные структурные множители заменяют литературные там, где
        # данные о них есть. Прогрессии и линии бланка остаются из литературы.
        s = cal.get("structure")
        if s:
            # Узоры (прогрессии, линии бланка, серии от четырёх) — литературные
            # множители в обученной степени: 1 — как в литературе, 0 — никак.
            g = s.get("patterns", 1.0)
            powered = lambda group: {k: (v ** g if isinstance(v, (int, float)) else v)  # noqa: E731
                                     for k, v in group.items()}
            merged["arithmetic_progression"] = powered(merged["arithmetic_progression"])
            merged["grid_pattern"] = powered(merged["grid_pattern"])
            run = {k: (v ** g if int(k) >= 4 else v)
                   for k, v in merged["consecutive_run"]["run_length_multiplier"].items()}
            run["3"] = s["run3"]
            merged["consecutive_run"] = {**merged["consecutive_run"],
                                         "no_adjacent_pair_bonus": s["no_adjacent"],
                                         "run_length_multiplier": run}
            merged["parity_balance"] = {**merged["parity_balance"],
                                        "balanced_3_3_multiplier": s["balanced"],
                                        "extreme_0_6_multiplier": s["extreme"]}
            merged["sum_window"] = {**merged["sum_window"], "peak_multiplier": s["sum_peak"]}
            merged["decade_clustering"] = {**merged["decade_clustering"],
                                           "narrow_range_multiplier": s["narrow"]}
    return merged


# ---------------------------------------------------------------------------
# Отдельные факторы. Каждый возвращает мультипликатор относительно равномерного
# выбора: >1 — игроки ставят такую комбинацию чаще, <1 — реже.
# ---------------------------------------------------------------------------

def _literature_number_weight(n: int, nw: dict) -> float:
    overrides = nw["overrides"]
    if str(n) in overrides:
        return overrides[str(n)]
    if n <= 12:
        return nw["base_1_12"]
    if n <= 31:
        return nw["base_13_31"]
    return nw["base_32_45"]


def _number_factor(ticket: Ticket, cfg: dict) -> float:
    cal = cfg.get("calibration")
    out = 1.0
    for i, combo in enumerate(ticket):
        if cal:
            weights = cal["field_weights"][i]
            for n in combo:
                out *= weights[n - 1]
        elif i == 0:
            for n in combo:
                out *= _literature_number_weight(n, cfg["number_weights"])
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


def _grid_factor(combo: Sequence[int], cfg: dict, cols_per_row: int) -> float:
    c = cfg["grid_pattern"]
    positions = sorted(((n - 1) // cols_per_row, (n - 1) % cols_per_row) for n in combo)
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


def _flat(ticket: Ticket) -> tuple[int, ...]:
    """Числа всех полей в одном ряду, поле зашито в число: 1-е поле — n,
    2-е — 100 + n. Так повтор прошлого тиража ищется одной проверкой."""
    return tuple(i * 100 + n for i, combo in enumerate(ticket) for n in combo)


def _history_factor(ticket: Ticket, cfg: dict, past: set[Combo] | None) -> float:
    if not past:
        return 1.0
    c = cfg["past_winner_repeat"]
    key = _flat(ticket)
    if key in past:
        return c["exact_repeat_multiplier"]
    target = set(key)
    need = len(key) - 1
    for old in past:
        if len(target.intersection(old)) >= need:
            return c["five_of_six_repeat_multiplier"]
    return 1.0


def past_winner_keys(draws: Iterable[Sequence[Sequence[int]]]) -> set[Combo]:
    """Прошлые тиражи в том виде, в каком их ищет фактор history."""
    return {_flat(tuple(tuple(sorted(f)) for f in d)) for d in draws}


FACTOR_LABELS = {
    "numbers": "Выбор отдельных чисел",
    "consecutive": "Подряд идущие числа",
    "arithmetic": "Арифметическая прогрессия",
    "grid": "Узор на бланке (строка, столбец, диагональ)",
    "sum": "Сумма чисел",
    "parity": "Чётные и нечётные",
    "range": "Все числа в узком диапазоне",
    "history": "Повтор выпавшей комбинации",
}


def popularity_breakdown(
    combo: Iterable,
    game: GameSpec,
    params: dict | None = None,
    past_winners: set[Combo] | None = None,
) -> dict[str, float]:
    """Разложение веса популярности по факторам. Произведение = итоговый вес."""
    ticket = as_ticket(combo, game)
    cfg = popularity_config(params or load_params(), game.key)
    out = {
        "numbers": _number_factor(ticket, cfg),
        "consecutive": 1.0,
        "arithmetic": 1.0,
        "grid": 1.0,
        "sum": 1.0,
        "parity": 1.0,
        "range": 1.0,
        "history": _history_factor(ticket, cfg, past_winners),
    }
    for fld, nums in zip(game.fields, ticket):
        if fld.pick < MIN_PATTERN_PICK:
            continue
        out["consecutive"] *= _consecutive_factor(nums, cfg)
        out["arithmetic"] *= _arithmetic_factor(nums, cfg)
        out["grid"] *= _grid_factor(nums, cfg, fld.slip_cols)
        out["sum"] *= _sum_factor(nums, cfg)
        out["parity"] *= _parity_factor(nums, cfg)
        out["range"] *= _range_factor(nums, cfg)
    return out


def popularity_weight(
    combo: Iterable,
    game: GameSpec,
    params: dict | None = None,
    past_winners: set[Combo] | None = None,
) -> float:
    """Ненормированный вес: во сколько раз чаще равномерного ставят комбинацию
    те, кто выбирает числа сам."""
    out = 1.0
    for value in popularity_breakdown(combo, game, params, past_winners).values():
        out *= value
    return out


def random_ticket(game: GameSpec, rng) -> Ticket:
    return tuple(tuple(sorted(rng.sample(range(1, f.pool + 1), f.pick))) for f in game.fields)


def mean_weight(
    game: GameSpec,
    params: dict | None = None,
    samples: int = 200_000,
    seed: int = 12345,
) -> float:
    """Средний вес по равномерной выборке билетов.

    Нужен для нормировки: доля ставок на конкретный билет равна
    weight / (mean_weight * число_билетов). Оценка Монте-Карло несмещённая,
    поскольку выборка равномерна по всему пространству.
    """
    import random

    rng = random.Random(seed)
    total = 0.0
    for _ in range(samples):
        total += popularity_weight(random_ticket(game, rng), game, params)
    return total / samples


def random_share(game: GameSpec, params: dict | None = None) -> float:
    """Доля ставок, числа в которых выбрал автомат, а не человек."""
    cal = (params or load_params())["games"][game.key].get("calibration")
    return float(cal["random_share"]) if cal else 0.0


def pick_share(
    combo: Iterable,
    game: GameSpec,
    mean_w: float,
    params: dict | None = None,
    past_winners: set[Combo] | None = None,
) -> float:
    """Оценка доли всех ставок тиража, приходящейся на этот билет.

    Автовыбор распределяет свою долю ставок поровну между всеми билетами,
    остальные ставки следуют весу популярности.
    """
    rho = random_share(game, params)
    w = popularity_weight(combo, game, params, past_winners)
    return (rho + (1.0 - rho) * w / mean_w) / game.total_combinations
