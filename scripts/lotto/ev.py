"""Ожидаемая выплата с учётом деления джекпота.

Всё, что здесь считается, — обычная комбинаторика и распределение Пуассона.
Никакого «предсказания»: вероятность угадать фиксирована и равна
C(6,m)*C(39,6-m)/C(45,6). Меняется только ожидаемый РАЗМЕР выплаты, потому
что джекпот делится между всеми угадавшими.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, asdict
from typing import Iterable

from .popularity import GameSpec, pick_share


def match_probability(game: GameSpec, matched: int) -> float:
    """Вероятность угадать ровно `matched` чисел одним билетом."""
    k, n = game.pick, game.pool
    if not 0 <= matched <= k:
        return 0.0
    return math.comb(k, matched) * math.comb(n - k, k - matched) / math.comb(n, k)


def expected_share_factor(lam: float) -> float:
    """E[1/(1+K)] для K ~ Poisson(lam) — ожидаемая доля джекпота.

    K — число ДРУГИХ игроков с той же комбинацией. При lam -> 0 стремится к 1
    (джекпот целиком ваш), при большом lam убывает как 1/lam.
    """
    if lam <= 1e-12:
        return 1.0
    return (1.0 - math.exp(-lam)) / lam


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
    combo: Iterable[int],
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

    # Ожидаемое число ДРУГИХ игроков с той же комбинацией.
    lam = max(players - 1, 0) * q
    share = expected_share_factor(lam)

    # База для сравнения: комбинация средней популярности.
    lam_baseline = max(players - 1, 0) / game.total_combinations
    share_baseline = expected_share_factor(lam_baseline)

    ev_fixed = 0.0
    for matched, prize in sorted(game.prizes_rub.items()):
        if prize is None:
            continue
        ev_fixed += match_probability(game, matched) * float(prize)

    p_jackpot = match_probability(game, game.pick)
    ev_jack = p_jackpot * jackpot_rub * share

    ev_total = ev_fixed + ev_jack - game.ticket_price_rub
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
        ev_total=ev_total,
        ev_per_100_rub=ev_total / game.ticket_price_rub * 100.0,
        rtp=gross / game.ticket_price_rub,
    )


def breakeven_jackpot(
    game: GameSpec,
    share_factor: float = 1.0,
) -> float:
    """Джекпот, при котором билет перестаёт быть убыточным (EV = 0).

    Полезно для честного ответа на вопрос «когда вообще имеет смысл играть».
    Обычно это значение в разы выше любого реального джекпота — и это надо
    показывать пользователю, а не прятать.
    """
    ev_fixed = sum(
        match_probability(game, m) * float(p)
        for m, p in game.prizes_rub.items()
        if p is not None
    )
    deficit = game.ticket_price_rub - ev_fixed
    if deficit <= 0:
        return 0.0
    p_jackpot = match_probability(game, game.pick)
    return deficit / (p_jackpot * share_factor)
