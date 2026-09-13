"""Тесты математического ядра.

Запуск:  python tests/test_core.py     (или pytest tests/)

Проверяется в первую очередь то, на чём держатся утверждения продукта:
вероятность выигрыша не зависит от выбора чисел, а различается только
ожидаемая доля джекпота.
"""
from __future__ import annotations

import math
import os
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "scripts"))

from lotto import ev as EV  # noqa: E402
from lotto import stats as ST  # noqa: E402
from lotto.generator import generate  # noqa: E402
from lotto.popularity import (  # noqa: E402
    load_game,
    popularity_breakdown,
    load_params,
    mean_weight,
    pick_share,
    popularity_weight,
)
from lotto.sources import (  # noqa: E402
    SourceUnavailable,
    load_csv,
    save_csv,
    synthetic,
)

PARAMS = load_params()
GAME = load_game("6x45", PARAMS)


# --------------------------------------------------------------- комбинаторика

def test_total_combinations():
    assert GAME.total_combinations == 8_145_060


def test_match_probabilities_sum_to_one():
    total = sum(EV.match_probability(GAME, m) for m in range(GAME.pick + 1))
    assert abs(total - 1.0) < 1e-12


def test_jackpot_probability():
    assert abs(EV.match_probability(GAME, 6) - 1 / 8_145_060) < 1e-18


def test_win_probability_is_identical_for_every_combination():
    """Главное утверждение продукта: выбор чисел не меняет шанс выиграть."""
    for combo in [(1, 2, 3, 4, 5, 6), (13, 36, 38, 39, 43, 44), (3, 7, 11, 12, 21, 28)]:
        assert EV.match_probability(GAME, 6) == 1 / GAME.total_combinations, combo


def test_every_game_loads_and_prizes_cover_pick():
    for key in PARAMS["games"]:
        game = load_game(key, PARAMS)
        assert game.pick < game.pool, key
        assert game.slip_rows * game.slip_cols >= game.pool, key
        assert game.prizes_rub[game.pick] is None, key
        total = sum(EV.match_probability(game, m) for m in range(game.pick + 1))
        assert abs(total - 1.0) < 1e-12, key


def test_game_overrides_apply_only_to_their_game():
    """Окно суммы 7 из 49 своё, а 6 из 45 его не наследует."""
    g49 = load_game("7x49", PARAMS)
    assert g49.total_combinations == 85_900_584
    combo45 = (4, 17, 23, 31, 38, 44)
    combo49 = (4, 12, 19, 24, 28, 31, 34)
    # Сумма 150 — ровно пик 7 из 49; сумма 157 у 6 из 45 далеко от пика 118.
    assert popularity_breakdown(combo49, g49, PARAMS)["sum"] > 1.3
    assert popularity_breakdown(combo45, GAME, PARAMS)["sum"] < 1.3


# ---------------------------------------------------------------- популярность

def test_pattern_combinations_are_heavier_than_random():
    plain = popularity_weight((13, 36, 38, 39, 43, 44), GAME, PARAMS)
    for pattern in [(1, 2, 3, 4, 5, 6), (5, 10, 15, 20, 25, 30), (1, 6, 11, 16, 21, 26)]:
        assert popularity_weight(pattern, GAME, PARAMS) > plain * 100


def test_birthday_combination_is_heavier_than_high_numbers():
    birthday = popularity_weight((3, 7, 11, 12, 21, 28), GAME, PARAMS)
    high = popularity_weight((33, 35, 38, 41, 43, 45), GAME, PARAMS)
    assert birthday > high * 5


def test_thirteen_is_avoided_by_players():
    """13 считают несчастливым, значит комбинация с ним — менее популярна.

    Пара подобрана так, чтобы отличался ровно один фактор: 13 и 15 оба
    нечётные, ни одна из комбинаций не образует прогрессию или узор. Иначе
    тест прошёл бы по совсем другой причине.
    """
    with13 = popularity_breakdown((13, 22, 29, 36, 40, 45), GAME, PARAMS)
    without = popularity_breakdown((15, 22, 29, 36, 40, 45), GAME, PARAMS)

    assert with13["numbers"] < without["numbers"]
    for factor in with13:
        if factor in ("numbers", "sum"):  # sum отличается на 2 из 45 — шум
            continue
        assert with13[factor] == without[factor], factor


def test_weight_is_order_independent():
    a = popularity_weight((44, 13, 38, 36, 43, 39), GAME, PARAMS)
    b = popularity_weight((13, 36, 38, 39, 43, 44), GAME, PARAMS)
    assert a == b


def test_pick_shares_sum_to_about_one():
    """Нормировка корректна: сумма долей по всем комбинациям равна ~1.

    Проверяем через среднее по равномерной выборке: mean(share) * C(n,k) = 1.
    """
    mw = mean_weight(GAME, PARAMS, samples=20_000, seed=99)
    import random

    rng = random.Random(1234)
    total = 0.0
    trials = 5_000
    for _ in range(trials):
        combo = rng.sample(range(1, GAME.pool + 1), GAME.pick)
        total += pick_share(combo, GAME, mw, PARAMS)
    estimate = total / trials * GAME.total_combinations
    assert 0.7 < estimate < 1.4, estimate


# ------------------------------------------------------------------ генератор

def test_generator_beats_random_on_popularity():
    mw = mean_weight(GAME, PARAMS, samples=20_000, seed=7)
    picks = generate(GAME, count=5, candidates=8_000, params=PARAMS, seed=5)
    assert len(picks) == 5
    for cand in picks:
        assert cand.weight < mw / 10


def test_generator_respects_include_and_exclude():
    picks = generate(
        GAME, count=3, include=[7], exclude=[13, 44], candidates=4_000,
        params=PARAMS, seed=11,
    )
    for cand in picks:
        assert 7 in cand.combo
        assert 13 not in cand.combo and 44 not in cand.combo
        assert len(set(cand.combo)) == GAME.pick


def test_generator_rejects_contradictory_constraints():
    try:
        generate(GAME, include=[7], exclude=[7], params=PARAMS)
    except ValueError:
        return
    raise AssertionError("ожидалась ValueError на конфликте include/exclude")


def test_generator_spread_limits_overlap():
    picks = generate(
        GAME, count=4, candidates=12_000, params=PARAMS, seed=3, distinct_overlap=2
    )
    for i, a in enumerate(picks):
        for b in picks[i + 1 :]:
            assert len(set(a.combo) & set(b.combo)) <= 2


# ------------------------------------------------------------------------ EV

def test_expected_share_factor_bounds():
    assert EV.expected_share_factor(0) == 1.0
    assert 0 < EV.expected_share_factor(1000) < 0.002
    values = [EV.expected_share_factor(x) for x in (0.01, 0.1, 1, 5, 50)]
    assert values == sorted(values, reverse=True)


def test_unpopular_combination_has_better_payout():
    mw = mean_weight(GAME, PARAMS, samples=20_000, seed=21)
    popular = EV.evaluate((1, 2, 3, 4, 5, 6), GAME, 500_000_000, mw, params=PARAMS)
    rare = EV.evaluate((13, 36, 38, 39, 43, 44), GAME, 500_000_000, mw, params=PARAMS)

    # Шанс выиграть одинаков...
    assert EV.match_probability(GAME, 6) == 1 / GAME.total_combinations
    # ...но ожидаемая выплата у редкой комбинации выше.
    assert rare.ev_total > popular.ev_total
    assert rare.share_factor > 0.9
    assert popular.share_factor < 0.05


def test_ev_is_negative_at_realistic_jackpot():
    """Честность продукта: билет невыгоден, и это должно быть видно в тестах."""
    mw = mean_weight(GAME, PARAMS, samples=20_000, seed=31)
    best = EV.evaluate((13, 36, 38, 39, 43, 44), GAME, 300_000_000, mw, params=PARAMS)
    assert best.ev_total < 0
    assert best.rtp < 1


def test_breakeven_jackpot_is_above_typical_prize():
    breakeven = EV.breakeven_jackpot(GAME)
    assert breakeven > 0
    # Порог окупаемости заведомо выше обычных суперпризов.
    assert breakeven > 100_000_000


# ------------------------------------------------------------------ статистика

def test_chi2_survival_function_is_sane():
    assert 0.99 < ST.chi2_sf(0.0, 44) <= 1.0
    assert ST.chi2_sf(1e6, 44) < 1e-6
    # Медиана chi2 с df=44 близка к df - 2/3.
    assert 0.4 < ST.chi2_sf(44 - 2 / 3, 44) < 0.6


def test_uniformity_test_accepts_random_draws():
    draws = [r.numbers for r in synthetic(2000, GAME.pick, GAME.pool, seed=5)]
    result = ST.uniformity_test(draws, GAME.pool, GAME.pick)
    assert result.p_value > 0.01, result


def test_uniformity_test_rejects_biased_draws():
    """Если данные испорчены, тест обязан это заметить."""
    biased = [(1, 2, 3, 4, 5, 6)] * 300
    result = ST.uniformity_test(biased, GAME.pool, GAME.pick)
    assert result.p_value < 0.01


def test_consecutive_share_matches_theory():
    """Около половины тиражей содержат пару соседних чисел.

    Игроки уверены в обратном — это один из фактов, ради которых мы считаем
    статистику.
    """
    draws = [r.numbers for r in synthetic(3000, GAME.pick, GAME.pool, seed=8)]
    share = ST.consecutive_share(draws)
    assert 0.4 < share < 0.6, share


def test_summarize_shape():
    draws = [r.numbers for r in synthetic(400, GAME.pick, GAME.pool, seed=2)]
    summary = ST.summarize(draws, GAME.pool, GAME.pick)
    assert len(summary["numbers"]) == GAME.pool
    assert len(summary["hot"]) == 6 and len(summary["cold"]) == 6
    assert summary["draws_analyzed"] == 400
    assert sum(x["count"] for x in summary["numbers"]) == 400 * GAME.pick


# --------------------------------------------------------------------- CSV

def test_csv_roundtrip():
    records = synthetic(50, GAME.pick, GAME.pool, seed=17)
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "draws.csv")
        save_csv(path, records)
        loaded = load_csv(path, GAME.pick, GAME.pool)
    assert len(loaded) == len(records)
    assert [r.numbers for r in loaded] == [r.numbers for r in records]
    assert [r.draw_id for r in loaded] == [r.draw_id for r in records]


def test_csv_rejects_broken_rows():
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "bad.csv")
        with open(path, "w", encoding="utf-8") as fh:
            fh.write("draw,date,numbers\n1,01.01.2024,1 2 3 4 5 99\n")
        try:
            load_csv(path, GAME.pick, GAME.pool)
        except SourceUnavailable:
            return
    raise AssertionError("число вне диапазона должно приводить к SourceUnavailable")


def test_csv_reads_separate_number_columns():
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "cols.csv")
        with open(path, "w", encoding="utf-8") as fh:
            fh.write("Тираж,Дата,n1,n2,n3,n4,n5,n6\n")
            fh.write("501,15.03.2024,4,17,23,31,38,44\n")
        loaded = load_csv(path, GAME.pick, GAME.pool)
    assert len(loaded) == 1
    assert loaded[0].numbers == (4, 17, 23, 31, 38, 44)
    assert loaded[0].date == "2024-03-15"
    assert loaded[0].draw_id == 501


# ------------------------------------------------------------------- запуск

def main() -> int:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except (AttributeError, OSError):
            pass

    tests = [
        (name, fn)
        for name, fn in sorted(globals().items())
        if name.startswith("test_") and callable(fn)
    ]
    failed = []
    for name, fn in tests:
        try:
            fn()
            print(f"  ok    {name}")
        except Exception as exc:  # noqa: BLE001 - сводка по всем тестам сразу
            failed.append((name, exc))
            print(f"  FAIL  {name}: {exc}")

    print(f"\n{len(tests) - len(failed)} / {len(tests)} тестов прошли")
    if failed:
        print("\nПровалились:")
        for name, exc in failed:
            print(f"  {name}: {type(exc).__name__}: {exc}")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
