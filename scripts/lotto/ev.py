"""Ожидаемая выплата с учётом деления суперприза.

Всё, что здесь считается, — обычная комбинаторика и распределение Пуассона.
Никакого «предсказания»: вероятность угадать фиксирована и равна
C(6,m)*C(39,6-m)/C(45,6) в «6 из 45». Меняется только ожидаемый РАЗМЕР
выплаты, потому что суперприз делится между всеми угадавшими.

В играх с двумя полями вероятность категории — сумма по сочетаниям
совпадений, которые в неё входят: «3 X 2 и 2 X 3» в «4 из 20» — это
(3 в первом, 2 во втором) или наоборот. Поля независимы, так что вероятность
сочетания — произведение вероятностей по полям.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, asdict
from typing import Iterable, Sequence

from .popularity import FieldSpec, GameSpec, pick_share


def field_match_probability(field: FieldSpec, matched: int) -> float:
    """Вероятность угадать ровно `matched` чисел в одном поле."""
    k, n = field.pick, field.pool
    if not 0 <= matched <= k:
        return 0.0
    return math.comb(k, matched) * math.comb(n - k, k - matched) / math.comb(n, k)


def match_probability(game: GameSpec, matched: int | Sequence[int]) -> float:
    """Вероятность сочетания совпадений по полям. Число вместо кортежа —
    совпадения в главном поле, остальные поля не учитываются."""
    if isinstance(matched, int):
        matched = (matched,)
    out = 1.0
    for fld, m in zip(game.fields, matched):
        out *= field_match_probability(fld, m)
    return out


def category_probability(game: GameSpec, index: int) -> float:
    return sum(match_probability(game, m) for m in game.categories[index])


def jackpot_probability(game: GameSpec) -> float:
    return 1.0 / game.total_combinations


def expected_share_factor(lam: float) -> float:
    """E[1/(1+K)] для K ~ Poisson(lam) — ожидаемая доля суперприза.

    K — число ДРУГИХ игроков с той же комбинацией. При lam -> 0 стремится к 1
    (суперприз целиком ваш), при большом lam убывает как 1/lam.
    """
    if lam <= 1e-12:
        return 1.0
    return (1.0 - math.exp(-lam)) / lam


def fixed_tiers_ev(game: GameSpec) -> float:
    """Ожидаемый выигрыш во всех категориях, кроме суперприза."""
    total = 0.0
    for i, prize in enumerate(game.prizes_rub):
        if prize is None or i >= len(game.categories):
            continue
        total += category_probability(game, i) * float(prize)
    return total


@dataclass
class EVResult:
    ticket_price: float
    jackpot: float
    players: int
    pick_share: float
    expected_co_winners: float
    share_factor: float
    baseline_share_factor: float
    payout_advantage: float
    ev_fixed_tiers: float
    ev_jackpot: float
    ev_total: float
    ev_per_100_rub: float
    rtp: float

    def to_dict(self) -> dict:
        return asdict(self)


def evaluate(
    combo: Iterable,
    game: GameSpec,
    jackpot_rub: float,
    mean_w: float,
    players: int | None = None,
    params: dict | None = None,
    past_winners: set[tuple[int, ...]] | None = None,
) -> EVResult:
    """Полная оценка ожидаемой ценности одного билета с этой комбинацией."""
    players = players or game.typical_players_per_draw
    q = pick_share(combo, game, mean_w, params, past_winners)

    # Ожидаемое число ДРУГИХ ставок с той же комбинацией.
    lam = max(players - 1, 0) * q
    share = expected_share_factor(lam)

    # База для сравнения: комбинация средней популярности.
    lam_baseline = max(players - 1, 0) / game.total_combinations
    share_baseline = expected_share_factor(lam_baseline)

    ev_fixed = fixed_tiers_ev(game)
    ev_jack = jackpot_probability(game) * jackpot_rub * share
    gross = ev_fixed + ev_jack

    return EVResult(
        ticket_price=game.ticket_price_rub,
        jackpot=jackpot_rub,
        players=players,
        pick_share=q,
        expected_co_winners=lam,
        share_factor=share,
        baseline_share_factor=share_baseline,
        payout_advantage=share / share_baseline if share_baseline else 1.0,
        ev_fixed_tiers=ev_fixed,
        ev_jackpot=ev_jack,
        ev_total=gross - game.ticket_price_rub,
        ev_per_100_rub=(gross - game.ticket_price_rub) / game.ticket_price_rub * 100.0,
        rtp=gross / game.ticket_price_rub,
    )


def breakeven_jackpot(game: GameSpec, share_factor: float = 1.0) -> float:
    """Суперприз, при котором билет перестаёт быть убыточным (EV = 0)."""
    deficit = game.ticket_price_rub - fixed_tiers_ev(game)
    if deficit <= 0:
        return 0.0
    return deficit / (jackpot_probability(game) * share_factor)
