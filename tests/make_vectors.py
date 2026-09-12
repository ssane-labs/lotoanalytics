"""Генерация эталонных векторов для проверки идентичности Python и JS.

Модель популярности живёт в двух реализациях (Python для сборки данных, JS для
Mini App). Расхождение между ними означало бы, что пользователь видит не те
числа, что мы считали при сборке. Этот файл фиксирует эталон, а
tests/parity.test.mjs проверяет по нему JS.

Запуск:  python tests/make_vectors.py
"""
from __future__ import annotations

import json
import os
import random
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "scripts"))

from lotto.popularity import load_game, load_params, popularity_breakdown  # noqa: E402

# Пограничные случаи, которые ловят ошибки в отдельных факторах.
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


def main() -> int:
    params = load_params()
    game = load_game("6x45", params)

    rng = random.Random(20240915)
    combos = [sorted(c) for c in EDGE_CASES]
    seen = {tuple(c) for c in combos}
    while len(combos) < 400:
        cand = tuple(sorted(rng.sample(range(1, game.pool + 1), game.pick)))
        if cand not in seen:
            seen.add(cand)
            combos.append(list(cand))

    vectors = []
    for combo in combos:
        breakdown = popularity_breakdown(combo, game, params)
        weight = 1.0
        for value in breakdown.values():
            weight *= value
        vectors.append({"combo": combo, "breakdown": breakdown, "weight": weight})

    out = os.path.join(ROOT, "tests", "vectors.json")
    with open(out, "w", encoding="utf-8") as fh:
        json.dump(
            {
                "note": (
                    "Эталон Python-модели. Сгенерирован tests/make_vectors.py. "
                    "past_winners намеренно пуст: фактор history проверяется "
                    "отдельно, он зависит от загруженных данных."
                ),
                "game": "6x45",
                "vectors": vectors,
            },
            fh,
            ensure_ascii=False,
            indent=1,
        )
    print(f"Записано векторов: {len(vectors)} -> {os.path.relpath(out, ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
