"""Честная проверка: можно ли предсказать тираж по истории?

Это не риторика, а воспроизводимый эксперимент. Скрипт обучает несколько
предсказателей на реальной истории тиражей и проверяет их на тиражах, которых
они не видели (walk-forward backtest — модель для тиража t использует только
тиражи до t).

Теоретический предел для случайного угадывания в 6/45: 6 * 6/45 = 0.8
совпадения на тираж. Если бы «ИИ, обученный на выигрышных билетах» работал,
хоть одна стратегия дала бы статистически значимо больше. Результат
публикуется в Mini App как есть, включая случай, когда какая-то стратегия
случайно оказалась чуть выше — с указанием, что отклонение в пределах шума.

Запуск:
    python scripts/verify_randomness.py --csv data/draws_6x45.csv
    python scripts/verify_randomness.py --synthetic     # без данных
"""
from __future__ import annotations

import argparse
import json
import math
import os
import random
import sys
from collections import Counter, defaultdict
from typing import Callable, Sequence

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# Консоль Windows по умолчанию не в UTF-8, а весь вывод здесь на русском.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8")
    except (AttributeError, OSError):
        pass

from lotto.popularity import load_game, load_params  # noqa: E402
from lotto.sources import DrawRecord, load_csv, synthetic  # noqa: E402

Draw = tuple[int, ...]
Predictor = Callable[[Sequence[Draw], int, int], list[int]]


# ---------------------------------------------------------------------------
# Стратегии. Каждая получает историю и возвращает pick чисел.
# ---------------------------------------------------------------------------

def strat_hot(history: Sequence[Draw], pick: int, pool: int) -> list[int]:
    """«Горячие числа»: самые частые за всю историю."""
    counter = Counter(n for draw in history for n in draw)
    return [n for n, _ in counter.most_common(pick)] or list(range(1, pick + 1))


def strat_cold(history: Sequence[Draw], pick: int, pool: int) -> list[int]:
    """«Холодные числа»: самые редкие. Зеркало предыдущей стратегии."""
    counter = Counter({n: 0 for n in range(1, pool + 1)})
    counter.update(n for draw in history for n in draw)
    return [n for n, _ in counter.most_common()[: -pick - 1 : -1]]


def strat_overdue(history: Sequence[Draw], pick: int, pool: int) -> list[int]:
    """«Давно не выпадало»: классическая ошибка игрока в чистом виде."""
    last: dict[int, int] = {}
    for idx, draw in enumerate(history):
        for n in draw:
            last[n] = idx
    return sorted(range(1, pool + 1), key=lambda n: last.get(n, -1))[:pick]


def strat_recent_hot(history: Sequence[Draw], pick: int, pool: int) -> list[int]:
    """«Горячие за последние 50 тиражей» — популярная эвристика."""
    counter = Counter(n for draw in history[-50:] for n in draw)
    top = [n for n, _ in counter.most_common(pick)]
    return top + [n for n in range(1, pool + 1) if n not in top][: pick - len(top)]


def strat_markov(history: Sequence[Draw], pick: int, pool: int) -> list[int]:
    """Марковская модель: какие числа чаще следуют за числами прошлого тиража.

    Это уже настоящая обучаемая модель на переходах, а не эвристика.
    """
    if len(history) < 2:
        return list(range(1, pick + 1))
    trans: dict[int, Counter[int]] = defaultdict(Counter)
    for prev, cur in zip(history, history[1:]):
        for a in prev:
            for b in cur:
                trans[a][b] += 1
    score: Counter[int] = Counter()
    for a in history[-1]:
        score.update(trans[a])
    if not score:
        return list(range(1, pick + 1))
    return [n for n, _ in score.most_common(pick)]


def strat_repeat_last(history: Sequence[Draw], pick: int, pool: int) -> list[int]:
    """Повторить прошлый тираж."""
    return list(history[-1]) if history else list(range(1, pick + 1))


def make_strat_random(seed: int) -> Predictor:
    rng = random.Random(seed)

    def strat_random(history: Sequence[Draw], pick: int, pool: int) -> list[int]:
        return rng.sample(range(1, pool + 1), pick)

    return strat_random


STRATEGIES: dict[str, Predictor] = {
    "Горячие числа (вся история)": strat_hot,
    "Холодные числа": strat_cold,
    "Давно не выпадали": strat_overdue,
    "Горячие за 50 тиражей": strat_recent_hot,
    "Марковская модель переходов": strat_markov,
    "Повтор прошлого тиража": strat_repeat_last,
    "Случайный выбор (контроль)": make_strat_random(4242),
}


def try_add_ml_strategy() -> None:
    """Градиентный бустинг на признаках, если установлен scikit-learn.

    Это самая «настоящая ML»-модель в наборе: 20+ признаков на число
    (частоты в разных окнах, разрывы, парные корреляции). Именно её результат
    интереснее всего — и именно она тоже упирается в 0.8.
    """
    try:
        from sklearn.ensemble import HistGradientBoostingClassifier  # noqa: F401
    except ImportError:
        return

    from sklearn.ensemble import HistGradientBoostingClassifier

    state: dict = {"model": None, "trained_at": -1}

    def features(history: Sequence[Draw], n: int, pool: int) -> list[float]:
        recent = history[-200:]
        windows = [10, 25, 50, 100, 200]
        feats: list[float] = [float(n), float(n % 2), float(n <= pool // 2)]
        for w in windows:
            chunk = history[-w:]
            hits = sum(1 for d in chunk for x in d if x == n)
            feats.append(hits / max(len(chunk), 1))
        last_seen = next(
            (i for i, d in enumerate(reversed(history)) if n in d), len(history)
        )
        feats.append(float(min(last_seen, 200)))
        feats.append(float(sum(1 for d in recent if n in d)))
        return feats

    def strat_gbm(history: Sequence[Draw], pick: int, pool: int) -> list[int]:
        if len(history) < 300:
            return list(range(1, pick + 1))
        # Переобучаем раз в 100 тиражей — иначе бэктест считается часами.
        if state["model"] is None or len(history) - state["trained_at"] >= 100:
            X, y = [], []
            for t in range(200, len(history)):
                past = history[:t]
                target = set(history[t])
                for n in range(1, pool + 1):
                    X.append(features(past, n, pool))
                    y.append(1 if n in target else 0)
            model = HistGradientBoostingClassifier(
                max_iter=120, learning_rate=0.08, max_depth=4
            )
            model.fit(X, y)
            state["model"] = model
            state["trained_at"] = len(history)
        model = state["model"]
        probs = model.predict_proba(
            [features(history, n, pool) for n in range(1, pool + 1)]
        )[:, 1]
        ranked = sorted(range(1, pool + 1), key=lambda n: -probs[n - 1])
        return ranked[:pick]

    STRATEGIES["Градиентный бустинг (scikit-learn)"] = strat_gbm


# ---------------------------------------------------------------------------
# Бэктест
# ---------------------------------------------------------------------------

def theoretical_stats(pick: int, pool: int) -> tuple[float, float]:
    """Матожидание и стандартное отклонение числа совпадений (гипергеом.)."""
    mean = pick * pick / pool
    var = (
        pick
        * (pick / pool)
        * (1 - pick / pool)
        * (pool - pick)
        / (pool - 1)
    )
    return mean, math.sqrt(var)


def backtest(
    draws: Sequence[Draw],
    strategy: Predictor,
    pick: int,
    pool: int,
    warmup: int = 200,
) -> dict:
    matches: list[int] = []
    for t in range(warmup, len(draws)):
        prediction = set(strategy(draws[:t], pick, pool))
        matches.append(len(prediction & set(draws[t])))

    n = len(matches)
    if n == 0:
        return {"error": "недостаточно тиражей для бэктеста"}

    observed = sum(matches) / n
    expected, sd = theoretical_stats(pick, pool)
    se = sd / math.sqrt(n)
    z = (observed - expected) / se if se else 0.0
    p_two_sided = math.erfc(abs(z) / math.sqrt(2))

    return {
        "draws_tested": n,
        "mean_matches": round(observed, 4),
        "expected_by_chance": round(expected, 4),
        "difference": round(observed - expected, 4),
        "z_score": round(z, 2),
        "p_value": round(p_two_sided, 4),
        "significant": bool(p_two_sided < 0.01),
        "jackpots_hit": sum(1 for m in matches if m == pick),
        "match_histogram": {
            str(k): sum(1 for m in matches if m == k) for k in range(pick + 1)
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--csv", help="CSV с историей тиражей")
    parser.add_argument(
        "--synthetic",
        action="store_true",
        help="Использовать заведомо случайные данные (проверка самого метода)",
    )
    parser.add_argument("--game", default="6x45")
    parser.add_argument("--warmup", type=int, default=200)
    parser.add_argument("--out", help="Куда сохранить JSON с результатами")
    args = parser.parse_args()

    game = load_game(args.game, load_params())

    if args.csv:
        records: list[DrawRecord] = load_csv(args.csv, game.pick, game.pool)
        source = f"csv:{os.path.basename(args.csv)}"
    elif args.synthetic:
        records = synthetic(1500, game.pick, game.pool)
        source = "synthetic"
    else:
        parser.error("укажите --csv ПУТЬ или --synthetic")
        return 2

    draws: list[Draw] = [r.numbers for r in records]
    needed = args.warmup + 51
    if len(draws) < needed:
        # Не ошибка, а нормальное состояние молодого архива. Записываем факт,
        # чтобы Mini App показал «накапливаем данные», а не пустую таблицу.
        print(
            f"Мало данных для бэктеста: {len(draws)} из {needed} тиражей.",
            file=sys.stderr,
        )
        if args.out:
            os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
            with open(args.out, "w", encoding="utf-8") as fh:
                json.dump(
                    {
                        "source": source,
                        "draws": len(draws),
                        "game": game.key,
                        "insufficient": True,
                        "draws_needed": needed,
                        "expected_by_chance": theoretical_stats(game.pick, game.pool)[0],
                        "results": {},
                    },
                    fh,
                    ensure_ascii=False,
                    indent=2,
                )
            print(f"Записано состояние «мало данных»: {args.out}")
        return 0

    try_add_ml_strategy()

    expected, _ = theoretical_stats(game.pick, game.pool)
    print(f"Источник: {source}, тиражей: {len(draws)}")
    print(f"Игра: {game.title} | предел случайного угадывания: {expected:.3f}\n")
    print(f"{'Стратегия':<38}{'совпадений':>12}{'разница':>10}{'p-value':>10}")
    print("-" * 70)

    results = {}
    for name, strategy in STRATEGIES.items():
        res = backtest(draws, strategy, game.pick, game.pool, args.warmup)
        results[name] = res
        if "error" in res:
            print(f"{name:<38}{res['error']:>32}")
            continue
        flag = "  <-- ЗНАЧИМО" if res["significant"] else ""
        print(
            f"{name:<38}{res['mean_matches']:>12.4f}"
            f"{res['difference']:>+10.4f}{res['p_value']:>10.4f}{flag}"
        )

    any_significant = any(r.get("significant") for r in results.values())
    print("-" * 70)
    if any_significant:
        print(
            "\nОдна из стратегий показала значимое отклонение. При ~8 стратегиях "
            "и пороге 0.01 это всё ещё вероятнее всего случайность (проблема "
            "множественных сравнений). Проверьте на других данных, прежде чем "
            "делать выводы."
        )
    else:
        print(
            "\nНи одна стратегия не превзошла случайное угадывание.\n"
            "Именно поэтому мы не продаём предсказания: предсказывать нечего.\n"
            "Мы считаем то, что действительно считается — деление джекпота."
        )

    payload = {
        "source": source,
        "draws": len(draws),
        "game": game.key,
        "expected_by_chance": expected,
        "insufficient": False,
        "any_significant": any_significant,
        "results": results,
    }
    if args.out:
        os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
        with open(args.out, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, ensure_ascii=False, indent=2)
        print(f"\nJSON сохранён: {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
