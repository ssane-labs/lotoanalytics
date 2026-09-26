"""Генерация эталонных векторов для проверки идентичности Python и JS.

Модель популярности живёт в двух реализациях (Python для сборки данных, JS для
Mini App). Расхождение между ними означало бы, что пользователь видит не те
числа, что мы считали при сборке. Этот файл фиксирует эталон по каждой игре —
вместе с итоговыми параметрами модели (литература + обученное), — а
tests/parity.test.mjs проверяет по нему JS.

Для «6 из 45» дополнительно снимается эталон на литературных весах: так
проверяется ветка модели, которая работает до обучения.

Запуск:  python tests/make_vectors.py
"""
from __future__ import annotations

import copy
import json
import os
import random
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "scripts"))

from lotto.popularity import (  # noqa: E402
    load_game,
    load_params,
    popularity_breakdown,
    popularity_config,
    random_ticket,
)

# Пограничные случаи «6 из 45», которые ловят ошибки в отдельных факторах.
EDGE_CASES = [
    [1, 2, 3, 4, 5, 6],            # максимальный run
    [5, 10, 15, 20, 25, 30],       # арифметическая прогрессия
    [1, 6, 11, 16, 21, 26],        # столбец бланка (cols=5)
    [1, 2, 3, 4, 5, 45],           # run=5 + разброс
    [40, 41, 42, 43, 44, 45],      # хвост диапазона, узкий range
    [2, 4, 6, 8, 10, 12],          # все чётные, прогрессия
    [1, 3, 5, 7, 9, 11],           # все нечётные
    [7, 13, 3, 11, 21, 33],        # все с override, порядок вперемешку
    [13, 26, 39, 44, 45, 1],       # смешанные диапазоны
    [1, 7, 13, 19, 25, 31],        # прогрессия шага 6
    [8, 16, 24, 32, 40, 44],       # частичная прогрессия
    [4, 17, 23, 31, 38, 44],       # «средняя» случайная
]
PER_GAME = 150


def game_payload(game, cfg: dict) -> dict:
    return {
        "key": game.key,
        "fields": [{"pick": f.pick, "pool": f.pool, "slip": {"rows": f.slip_rows, "cols": f.slip_cols}}
                   for f in game.fields],
        "total_combinations": game.total_combinations,
        "popularity": cfg,
    }


def vectors_for(game, params: dict, tickets) -> list[dict]:
    out = []
    for ticket in tickets:
        breakdown = popularity_breakdown(ticket, game, params)
        weight = 1.0
        for value in breakdown.values():
            weight *= value
        out.append({"ticket": [list(f) for f in ticket], "breakdown": breakdown, "weight": weight})
    return out


def main() -> int:
    params = load_params()
    literature = copy.deepcopy(params)
    for g in literature["games"].values():
        g.pop("calibration", None)

    rng = random.Random(20240915)
    suites = []

    g45 = load_game("6x45", literature)
    edge = [(tuple(sorted(c)),) for c in EDGE_CASES]
    suites.append({
        "name": "6x45 (литература)",
        "game": game_payload(g45, popularity_config(literature, "6x45")),
        "vectors": vectors_for(g45, literature, edge + [random_ticket(g45, rng) for _ in range(PER_GAME)]),
    })

    for key in params["games"]:
        game = load_game(key, params)
        tickets = [random_ticket(game, rng) for _ in range(PER_GAME)]
        if key == "6x45":
            tickets = edge + tickets
        suites.append({
            "name": key,
            "game": game_payload(game, popularity_config(params, key)),
            "vectors": vectors_for(game, params, tickets),
        })

    out = os.path.join(ROOT, "tests", "vectors.json")
    with open(out, "w", encoding="utf-8") as fh:
        json.dump(
            {
                "note": (
                    "Эталон Python-модели. Сгенерирован tests/make_vectors.py. "
                    "past_winners намеренно пуст: фактор history проверяется "
                    "отдельно, он зависит от загруженных данных."
                ),
                "suites": suites,
            },
            fh,
            ensure_ascii=False,
            separators=(",", ":"),
        )
    total = sum(len(s["vectors"]) for s in suites)
    print(f"Записано векторов: {total} в {len(suites)} наборах -> {os.path.relpath(out, ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
