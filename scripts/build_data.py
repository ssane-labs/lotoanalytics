"""Сборка статических данных для Mini App.

Запускается по расписанию в GitHub Actions и коммитит результат в docs/data/.
Mini App — чистая статика на GitHub Pages: браузер тянет эти JSON и считает
всё на клиенте.

Источник — архив Столото (scripts/lotto/stoloto_api.py), накопленный в data/.
Для каждой игры пишутся <игра>_meta.json, _model.json, _stats.json и _ai.json,
а общий meta.json перечисляет игры, для которых данные есть.

Экономика игры берётся из итогов тиражей, а не из головы: цена билета и
суперприз — из архива, выплаты по категориям — средние за последние тиражи,
число ставок в тираже — медиана опубликованного.

Запуск:
    python scripts/build_data.py            # из накопленного архива
    python scripts/build_data.py --fetch    # сначала дотянуть новые тиражи
    python scripts/build_data.py --game 6x45
"""
from __future__ import annotations

import argparse
import json
import os
import statistics
import sys
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8")
    except (AttributeError, OSError):
        pass

from lotto import ai as lai  # noqa: E402
from lotto import ev as lev  # noqa: E402
from lotto import history  # noqa: E402
from lotto import stats as lstats  # noqa: E402
from lotto.popularity import GameSpec, load_game, load_params, mean_weight, popularity_config  # noqa: E402
from lotto.stoloto_api import ApiUnavailable  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(ROOT, "docs", "data")

# Сколько последних тиражей отдаём клиенту для фактора «повтор выпавшей
# комбинации». Больше не нужно: люди переставляют недавние тиражи.
HISTORY_FOR_MODEL = 400
# По скольким последним тиражам считаем выплаты и число ставок.
ECONOMY_WINDOW = 300
# Сколько страниц архива читать за ежедневный прогон. Новых тиражей за
# сутки меньше страницы у всех игр, кроме «5 из 36» (около двух).
FETCH_PAGES = 30
LATEST_DRAWS = 12


def write_json(name: str, payload: dict) -> str:
    os.makedirs(DATA_DIR, exist_ok=True)
    path = os.path.join(DATA_DIR, name)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, separators=(",", ":"))
    size = os.path.getsize(path)
    print(f"  {name:<28} {size / 1024:7.1f} КБ")
    return path


def economy(game: GameSpec, draws: list, results: dict, upcoming: dict | None) -> dict:
    """Цена билета, суперприз, выплаты по категориям и ставки в тираже."""
    recent = [results[d.draw_id] for d in draws[-ECONOMY_WINDOW:] if d.draw_id in results]
    recent = [r for r in recent if r.titles is None and r.counts]
    n_cats = len(game.categories)

    price = next((r.ticket_price for r in reversed(recent) if r.ticket_price), None)
    if upcoming and upcoming.get("ticket_price"):
        price = upcoming["ticket_price"]
    jackpot = (upcoming or {}).get("super_prize") or next(
        (r.super_prize for r in reversed(recent) if r.super_prize), None)

    # Выплата категории — средняя по тиражам, где в ней кто-то выиграл.
    # Первая категория — суперприз: он делится, и считается отдельно.
    everything = [r for r in results.values() if r.titles is None and r.counts]
    prizes: list[float | None] = [None]
    for i in range(1, n_cats):
        won = [r.amounts[i] for r in recent if len(r.amounts) > i and r.counts[i] > 0 and r.amounts[i] > 0]
        if len(won) < 5:
            won = [r.amounts[i] for r in everything[-3000:]
                   if len(r.amounts) > i and r.counts[i] > 0 and r.amounts[i] > 0]
        prizes.append(round(statistics.fmean(won), 2) if won else 0.0)

    # Ставок в тираже: опубликованное число, а где его нет — оценка по числу
    # победителей в массовых категориях (их доля от ставок известна точно).
    known = [r.columns for r in recent if r.columns]
    if known:
        players = int(statistics.median(known))
        players_source = "опубликовано"
    else:
        probs = [lev.category_probability(game, i) for i in range(n_cats)]
        mass = sorted(range(n_cats), key=lambda i: -probs[i])[:3]
        est = [sum(r.counts[i] for i in mass) / sum(probs[i] for i in mass) for r in recent]
        players = int(statistics.median(est)) if est else game.typical_players_per_draw
        players_source = "оценка по победителям"

    return {
        "ticket_price_rub": price or game.ticket_price_rub,
        "jackpot_rub": jackpot or game.default_jackpot_rub,
        "prizes_rub": prizes,
        "players_per_draw": players,
        "players_source": players_source,
    }


def build_game(key: str, params: dict, args, generated: str) -> dict | None:
    game = load_game(key, params)
    spec = params["games"][key]
    print(f"\n=== {game.title} ===")

    if args.fetch:
        try:
            added, total = history.update(key, spec, max_pages=FETCH_PAGES, log=print)
            print(f"Архив Столото: новых тиражей {added}, всего {total}")
        except ApiUnavailable as exc:
            print(f"  архив недоступен, собираю из накопленного: {exc}", file=sys.stderr)

    draws = history.load_draws(key, spec["fields"])
    if not draws:
        print(f"ПРОПУСК: для {key} нет ни одного тиража.", file=sys.stderr)
        return None
    results = history.load_results(key)
    upcoming = history.load_upcoming(key)
    econ = economy(game, draws, results, upcoming)
    print(f"Тиражей: {len(draws)}, билет {econ['ticket_price_rub']} ₽, "
          f"суперприз {econ['jackpot_rub']:,} ₽, ставок в тираже ~{econ['players_per_draw']}")

    print("Считаю нормировку модели популярности...")
    mw = mean_weight(game, params, samples=args.mc_samples)
    print(f"  средний вес = {mw:.6f}")

    cfg = popularity_config(params, key)
    cal = spec.get("calibration")
    latest = draws[-1]

    write_json(f"{key}_meta.json", {
        "generated_at": generated,
        "source": "stoloto",
        "draws_count": len(draws),
        "first_date": draws[0].date,
        "latest_draw": latest.to_dict(),
        "latest_draws": [d.to_dict() for d in reversed(draws[-LATEST_DRAWS:])],
        "upcoming": upcoming,
    })

    write_json(f"{key}_model.json", {
        "game": {
            "key": key,
            "title": game.title,
            "short": spec.get("short", game.title),
            "fields": [{"pick": f.pick, "pool": f.pool, "slip": {"rows": f.slip_rows, "cols": f.slip_cols}}
                       for f in game.fields],
            "ticket_price_rub": econ["ticket_price_rub"],
            "categories": [{"title": t, "match": [list(m) for m in c]}
                           for t, c in zip(game.category_titles, game.categories)],
            "prizes_rub": econ["prizes_rub"],
            "typical_players_per_draw": econ["players_per_draw"],
            "players_source": econ["players_source"],
            "default_jackpot_rub": econ["jackpot_rub"],
            "total_combinations": game.total_combinations,
        },
        # Уже с переопределениями игры и обученными весами.
        "popularity": cfg,
        "mean_weight": mw,
        "mc_samples": args.mc_samples,
        "calibration": None if not cal else {
            "draws": cal["draws"], "bets": cal["bets"], "winners": cal["winners"],
            "date_from": cal["date_from"], "date_to": cal["date_to"],
            "random_share": cal["random_share"], "holdout": cal["holdout"],
            "structure": cal.get("structure"),
        },
        "recent_winners": [[list(f) for f in d.fields] for d in draws[-HISTORY_FOR_MODEL:]],
    })

    field_stats = []
    for i, f in enumerate(game.fields):
        nums = [d.fields[i] for d in draws]
        summary = lstats.summarize(nums, f.pool, f.pick)
        summary.pop("top_pairs", None)
        field_stats.append(summary)
    u = field_stats[0]["uniformity"]
    print(f"  хи-квадрат = {u['chi2']:.1f}, p = {u['p_value']}")
    write_json(f"{key}_stats.json", {"generated_at": generated, "fields": field_stats})

    # Нейросеть переобучается при каждой сборке — на всей свежей истории.
    if len(draws) >= lai.MIN_DRAWS_FOR_AI:
        nets = []
        for i, f in enumerate(game.fields):
            print(f"Обучаю нейросеть, поле {i + 1}...")
            net, info = lai.train([d.fields[i] for d in draws], f.pool, f.pick, epochs=args.ai_epochs)
            h = info["holdout"]
            print(f"  проверка на {h['draws']} тиражах: угадано {h['mean_matches']} "
                  f"(наугад {h['expected_by_chance']}), log-loss {h['log_loss']} "
                  f"против {h['log_loss_base_rate']}")
            nets.append(lai.export(net, info, [d.fields[i] for d in draws], f.pool, f.pick))
        write_json(f"{key}_ai.json", lai.export_game(nets, key))
    else:
        write_json(f"{key}_ai.json", {
            "game": key, "insufficient": True,
            "draws": len(draws), "draws_needed": lai.MIN_DRAWS_FOR_AI,
        })

    # Файлы прежних версий: бэктест вкладки «Проверка» и сырой архив.
    for stale in (f"{key}_randomness.json", f"{key}_draws.json"):
        path = os.path.join(DATA_DIR, stale)
        if os.path.exists(path):
            os.remove(path)
    return {"key": key, "title": game.title, "short": spec.get("short", game.title),
            "fields": [{"pick": f.pick, "pool": f.pool} for f in game.fields]}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fetch", action="store_true", help="Сначала дотянуть новые тиражи")
    parser.add_argument("--game", help="Собрать только эту игру (по умолчанию все)")
    parser.add_argument("--mc-samples", type=int, default=100_000,
                        help="Размер выборки Монте-Карло для нормировки модели популярности")
    parser.add_argument("--ai-epochs", type=int, default=12, help="Эпох обучения нейросети")
    args = parser.parse_args()

    params = load_params()
    keys = [args.game] if args.game else list(params["games"])
    generated = datetime.now(timezone.utc).isoformat(timespec="seconds")
    built = {}
    for key in keys:
        entry = build_game(key, params, args, generated)
        if entry:
            built[key] = entry

    # Прежний список сохраняем, если собирали одну игру.
    index_path = os.path.join(DATA_DIR, "meta.json")
    known = {}
    if args.game and os.path.exists(index_path):
        with open(index_path, encoding="utf-8") as fh:
            known = {g["key"]: g for g in json.load(fh).get("games", []) if isinstance(g, dict)}
    listed = [built.get(k) or known.get(k) for k in params["games"] if k in built or k in known]

    if not listed:
        print("\nОШИБКА: нет ни одного тиража ни для одной игры. "
              "Запустите python scripts/fetch_history.py", file=sys.stderr)
        return 1

    print("\nОбщий индекс:")
    write_json("meta.json", {
        "generated_at": generated,
        "default_game": listed[0]["key"],
        "games": listed,
    })
    print("\nГотово.")
    return 0 if len(built) == len(keys) else 1


if __name__ == "__main__":
    raise SystemExit(main())
