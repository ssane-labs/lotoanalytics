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


def _without_calibration(params: dict) -> dict:
    """Параметры с литературными весами — для тестов механики факторов.

    Обученные веса меняются от прогона к прогону и отражают российских
    игроков (у них, например, 13 популярно), а тесты ниже проверяют, что
    каждый фактор считается как задумано.
    """
    import copy

    out = copy.deepcopy(params)
    for game in out["games"].values():
        game.pop("calibration", None)
    return out


LIT = _without_calibration(PARAMS)


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


def test_every_game_loads_and_categories_are_consistent():
    for key in PARAMS["games"]:
        game = load_game(key, PARAMS)
        for f in game.fields:
            assert f.pick < f.pool, key
            assert f.slip_rows * f.slip_cols >= f.pool, key
            total = sum(EV.field_match_probability(f, m) for m in range(f.pick + 1))
            assert abs(total - 1.0) < 1e-12, key
        # Первая категория — суперприз: совпало всё во всех полях.
        assert game.categories[0] == (tuple(f.pick for f in game.fields),), key
        assert abs(EV.category_probability(game, 0) - 1 / game.total_combinations) < 1e-18, key
        assert game.prizes_rub[0] is None, key
        # Категории не пересекаются, и вместе их вероятность меньше единицы.
        seen = [m for c in game.categories for m in c]
        assert len(seen) == len(set(seen)), key
        assert sum(EV.category_probability(game, i) for i in range(len(game.categories))) < 1, key


def test_two_field_games_multiply_their_odds():
    assert load_game("4x20", PARAMS).total_combinations == 4845 ** 2
    assert load_game("5x36plus", PARAMS).total_combinations == 376_992 * 4
    assert load_game("5x2", PARAMS).total_combinations == 2_118_760 * 45


def test_game_overrides_apply_only_to_their_game():
    """Окно суммы 7 из 49 своё, а 6 из 45 его не наследует."""
    g49 = load_game("7x49", PARAMS)
    assert g49.total_combinations == 85_900_584
    combo45 = (4, 17, 23, 31, 38, 44)
    combo49 = (4, 12, 19, 24, 28, 31, 34)
    # Сумма 150 — ровно пик 7 из 49; сумма 157 у 6 из 45 далеко от пика 118.
    assert popularity_breakdown(combo49, g49, LIT)["sum"] > 1.3
    assert popularity_breakdown(combo45, GAME, LIT)["sum"] < 1.3


# ---------------------------------------------------------------- популярность

def test_pattern_combinations_are_heavier_than_random():
    plain = popularity_weight((13, 36, 38, 39, 43, 44), GAME, LIT)
    for pattern in [(1, 2, 3, 4, 5, 6), (5, 10, 15, 20, 25, 30), (1, 6, 11, 16, 21, 26)]:
        assert popularity_weight(pattern, GAME, LIT) > plain * 100


def test_birthday_combination_is_heavier_than_high_numbers():
    birthday = popularity_weight((3, 7, 11, 12, 21, 28), GAME, LIT)
    high = popularity_weight((33, 35, 38, 41, 43, 45), GAME, LIT)
    assert birthday > high * 5


def test_thirteen_is_avoided_by_players():
    """13 считают несчастливым, значит комбинация с ним — менее популярна.

    Пара подобрана так, чтобы отличался ровно один фактор: 13 и 15 оба
    нечётные, ни одна из комбинаций не образует прогрессию или узор. Иначе
    тест прошёл бы по совсем другой причине.
    """
    with13 = popularity_breakdown((13, 22, 29, 36, 40, 45), GAME, LIT)
    without = popularity_breakdown((15, 22, 29, 36, 40, 45), GAME, LIT)

    assert with13["numbers"] < without["numbers"]
    for factor in with13:
        if factor in ("numbers", "sum"):  # sum отличается на 2 из 45 — шум
            continue
        assert with13[factor] == without[factor], factor


def test_weight_is_order_independent():
    a = popularity_weight((44, 13, 38, 36, 43, 39), GAME, LIT)
    b = popularity_weight((13, 36, 38, 39, 43, 44), GAME, LIT)
    assert a == b


def test_calibration_learned_known_preferences():
    """Обученная модель видит то, что видно и простой регрессией по итогам:
    числа до 31 («дни рождения») ставят охотнее, чем числа за 31."""
    cal = PARAMS["games"]["6x45"].get("calibration")
    if not cal:
        return
    w = cal["field_weights"][0]
    assert max(range(45), key=lambda i: w[i]) + 1 in (7, 11, 13)
    assert sum(w[:31]) / 31 > sum(w[31:]) / 14
    assert 0 <= cal["random_share"] < 1
    assert cal["holdout"]["loglik_gain"] > 0


def test_random_share_puts_a_floor_under_pick_share():
    """Автовыбор ставит любой билет с одинаковой частотой, поэтому доля
    ставок на билет не падает ниже доли автовыбора."""
    from lotto.popularity import random_share

    rho = random_share(GAME, PARAMS)
    mw = mean_weight(GAME, PARAMS, samples=5_000, seed=3)
    for combo in [(36, 37, 38, 39, 40, 41), (1, 2, 3, 4, 5, 6), (13, 36, 38, 39, 43, 44)]:
        share = pick_share(combo, GAME, mw, PARAMS) * GAME.total_combinations
        assert share >= rho - 1e-12


def test_multi_field_ticket_breakdown():
    g = load_game("4x20", PARAMS)
    flat = popularity_weight([1, 2, 3, 4, 5, 9, 13, 17], g, PARAMS)
    nested = popularity_weight([[1, 2, 3, 4], [5, 9, 13, 17]], g, PARAMS)
    assert flat == nested
    # Бонусный номер «5 из 36» узоров не образует: одно поле из пяти чисел
    # даёт ровно те же структурные множители, что и билет целиком.
    g = load_game("5x36plus", PARAMS)
    a = popularity_breakdown([[3, 11, 19, 27, 35], [2]], g, PARAMS)
    b = popularity_breakdown([[3, 11, 19, 27, 35], [4]], g, PARAMS)
    assert a["consecutive"] == b["consecutive"] and a["sum"] == b["sum"]


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
    mw = mean_weight(GAME, LIT, samples=20_000, seed=7)
    picks = generate(GAME, count=5, candidates=8_000, params=LIT, seed=5)
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
    mw = mean_weight(GAME, LIT, samples=20_000, seed=21)
    # Полтора миллиона ставок — чтобы деление суперприза было заметно.
    popular = EV.evaluate((1, 2, 3, 4, 5, 6), GAME, 500_000_000, mw, players=1_500_000, params=LIT)
    rare = EV.evaluate((13, 36, 38, 39, 43, 44), GAME, 500_000_000, mw, players=1_500_000, params=LIT)

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
    # Порог окупаемости заведомо выше суперприза, который сейчас на кону.
    assert breakeven > GAME.default_jackpot_rub


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


# ------------------------------------------------------------------ нейросеть

def test_ai_features_shape_and_ranges():
    from lotto import ai as AI

    draws = [r.numbers for r in synthetic(60, GAME.pick, GAME.pool, seed=4)]
    gap = 2 + len(AI.WINDOWS)
    for n in (1, 23, 45):
        x = AI.features(draws, n, GAME.pool, GAME.pick)
        assert len(x) == AI.N_FEATURES
        assert 0 <= x[gap] <= 1  # разрыв нормирован
    assert AI.features([], 7, GAME.pool, GAME.pick)[-1] == 0.0


def test_ai_trains_deterministically_and_reports_holdout():
    import numpy as np
    from lotto import ai as AI

    draws = [r.numbers for r in synthetic(150, GAME.pick, GAME.pool, seed=9)]
    m1, info = AI.train(draws, GAME.pool, GAME.pick, epochs=2)
    m2, _ = AI.train(draws, GAME.pool, GAME.pick, epochs=2)
    assert all(np.array_equal(a, b) for a, b in zip(m1.W, m2.W))
    feats = AI.feature_matrix(draws, GAME.pool, GAME.pick)[-1]
    probs = m1.predict(feats)
    assert ((probs > 0) & (probs < 1)).all()
    # Средняя вероятность близка к базовой частоте 6/45.
    assert abs(probs.mean() - GAME.pick / GAME.pool) < 0.08
    assert info["holdout"]["expected_by_chance"] == round(36 / 45, 4)


def test_ai_refuses_too_little_history():
    from lotto import ai as AI

    try:
        AI.train([(1, 2, 3, 4, 5, 6)] * 3, GAME.pool, GAME.pick)
    except ValueError:
        return
    raise AssertionError("на трёх тиражах обучение должно отказываться")


def test_history_fields_roundtrip():
    from lotto import history as H

    fields = ((3, 7, 12, 18), (2, 9, 14, 20))
    assert H.parse_fields(H.format_fields(fields), [4, 4]) == fields
    assert H.parse_fields("6 10 18 15 3 7 10 16", [4, 4]) == ((6, 10, 15, 18), (3, 7, 10, 16))
    try:
        H.validate(((1, 2, 3, 4), (5, 6, 7, 21)), [{"pick": 4, "pool": 20}] * 2)
    except ValueError:
        return
    raise AssertionError("число 21 в поле «4 из 20» должно отвергаться")


def test_results_aligned_by_title():
    """Тираж без категории «2 из 6» не должен учить модель, что в ней никто
    не выиграл."""
    from lotto import history as H

    r = H.Result(1, 1000, None, 70, [0, 1, 20, 300], [0, 1, 2, 3],
                 ["6 из 6", "5 из 6", "4 из 6", "3 из 6"])
    counts, _ = H.aligned(r, ["6 из 6", "5 из 6", "4 из 6", "3 из 6", "2 из 6"])
    assert counts == [0, 1, 20, 300, None]


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
