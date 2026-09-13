"""Сборка статических данных для Mini App.

Запускается по расписанию в GitHub Actions и коммитит результат в docs/data/.
Mini App — чистая статика на GitHub Pages, никакого сервера: браузер тянет
эти JSON и считает всё на клиенте.

По умолчанию собираются все игры из model_params.json. Для каждой пишутся
<игра>_meta.json, _model.json, _stats.json и _draws.json, а общий meta.json
перечисляет игры, для которых данные есть.

Запуск:
    python scripts/build_data.py                      # из накопленных архивов
    python scripts/build_data.py --fetch              # дотянуть свежие тиражи
    python scripts/build_data.py --game 6x45 --csv архив.csv
    python scripts/build_data.py --allow-synthetic    # для локальной отладки
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8")
    except (AttributeError, OSError):
        pass

from lotto import stats as lstats  # noqa: E402
from lotto.popularity import (  # noqa: E402
    GameSpec,
    load_game,
    load_params,
    mean_weight,
    popularity_config,
)
from lotto.sources import (  # noqa: E402
    SourceUnavailable,
    fetch_lotocafe,
    fetch_stoloto,
    load_csv,
    merge,
    save_csv,
    synthetic,
)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(ROOT, "docs", "data")

# Сколько последних тиражей отдаём клиенту для фактора «повтор выпавшей
# комбинации». Больше не нужно: люди переставляют недавние тиражи.
HISTORY_FOR_MODEL = 400

# Ниже этих порогов показывать статистику и бэктест нечестно: на десятке
# тиражей любая «закономерность» — чистый шум. Интерфейс в таком случае
# честно пишет, сколько данных накоплено, вместо красивых, но пустых графиков.
MIN_DRAWS_FOR_STATS = 200
MIN_DRAWS_FOR_BACKTEST = 300


def write_json(name: str, payload: dict) -> str:
    os.makedirs(DATA_DIR, exist_ok=True)
    path = os.path.join(DATA_DIR, name)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, separators=(",", ":"))
    size = os.path.getsize(path)
    print(f"  {name:<28} {size / 1024:7.1f} КБ")
    return path


def collect(game: GameSpec, args) -> tuple[list, str, bool]:
    """Тиражи игры: архив + импорт + сеть. Пустой список — данных нет.

    Архив накапливается: каждый прогон добавляет новые тиражи к тому, что
    уже собрано, и никогда не затирает историю. Иначе один сбойный запрос
    к сайту обнулил бы месяцы накопленных данных.
    """
    cache_path = os.path.join(ROOT, "data", f"draws_{game.key}.csv")
    collected: list = []
    sources_used: list[str] = []

    if os.path.exists(cache_path):
        cached = load_csv(cache_path, game.pick, game.pool)
        collected = merge(collected, cached)
        sources_used.append("архив")
        print(f"Архив: {len(cached)} тиражей")

    if args.csv and os.path.exists(args.csv):
        imported = load_csv(args.csv, game.pick, game.pool)
        before = len(collected)
        collected = merge(collected, imported)
        sources_used.append("csv")
        print(f"Импорт {os.path.basename(args.csv)}: {len(imported)} тиражей, "
              f"новых {len(collected) - before}")

    if args.fetch:
        fetchers = [("stoloto", lambda: fetch_stoloto(game.key, pick=game.pick, pool=game.pool))]
        if game.lotocafe_slug:
            fetchers.append((
                "lotocafe",
                lambda: fetch_lotocafe(pick=game.pick, pool=game.pool, slug=game.lotocafe_slug),
            ))
        for name, fetcher in fetchers:
            try:
                fresh = fetcher()
            except SourceUnavailable as exc:
                print(f"  {name}: {exc}", file=sys.stderr)
                continue
            before = len(collected)
            collected = merge(collected, fresh)
            sources_used.append(name)
            print(f"{name}: получено {len(fresh)}, новых {len(collected) - before}")

    if not collected:
        if not args.allow_synthetic:
            return [], "", False
        return synthetic(1500, game.pick, game.pool), "synthetic", True

    save_csv(cache_path, collected)
    print(f"Архив сохранён: {os.path.relpath(cache_path, ROOT)}")
    return collected, "+".join(sources_used), False


def build_game(game: GameSpec, params: dict, args, generated: str) -> bool:
    print(f"\n=== {game.title} ===")
    records, source, is_synthetic = collect(game, args)
    if not records:
        print(f"ПРОПУСК: для {game.key} нет ни одного тиража.", file=sys.stderr)
        return False

    draws = [r.numbers for r in records]
    print(f"Источник: {source}, всего тиражей: {len(draws)}")
    if is_synthetic:
        print("ВНИМАНИЕ: данные синтетические. Публиковать в прод нельзя.")

    print("Считаю нормировку модели популярности...")
    mw = mean_weight(game, params, samples=args.mc_samples)
    print(f"  средний вес = {mw:.6f}")

    summary = lstats.summarize(draws, game.pool, game.pick)
    print(f"  хи-квадрат = {summary['uniformity']['chi2']:.1f}, "
          f"p = {summary['uniformity']['p_value']}")

    write_json(f"{game.key}_meta.json", {
        "generated_at": generated,
        "source": source,
        "synthetic": is_synthetic,
        "draws_count": len(draws),
        "enough_for_stats": len(draws) >= MIN_DRAWS_FOR_STATS,
        "enough_for_backtest": len(draws) >= MIN_DRAWS_FOR_BACKTEST,
        "min_draws_for_stats": MIN_DRAWS_FOR_STATS,
        "latest_draw": records[-1].to_dict(),
        "disclaimer": (
            "Вероятность выигрыша не зависит от выбора чисел и равна "
            f"1/{game.total_combinations} для «{game.pick} из {game.pool}». "
            "Сервис не предсказывает результаты и не может их предсказывать. "
            "Он считает, насколько редко выбранную комбинацию ставят другие "
            "игроки, чтобы при выигрыше джекпот не пришлось делить."
        ),
    })

    write_json(f"{game.key}_model.json", {
        "game": {
            "key": game.key,
            "title": game.title,
            "pick": game.pick,
            "pool": game.pool,
            "ticket_price_rub": game.ticket_price_rub,
            "slip": {"rows": game.slip_rows, "cols": game.slip_cols},
            "prizes_rub": {str(k): v for k, v in game.prizes_rub.items()},
            "typical_players_per_draw": game.typical_players_per_draw,
            "default_jackpot_rub": game.default_jackpot_rub,
            "total_combinations": game.total_combinations,
        },
        # Уже с переопределениями игры: клиенту не нужно знать про слияние.
        "popularity": popularity_config(params, game.key),
        "mean_weight": mw,
        "mc_samples": args.mc_samples,
        "recent_winners": [list(d) for d in draws[-HISTORY_FOR_MODEL:]],
    })

    write_json(f"{game.key}_stats.json",
               {"generated_at": generated, "synthetic": is_synthetic, **summary})

    write_json(f"{game.key}_draws.json", {
        "generated_at": generated,
        "synthetic": is_synthetic,
        "draws": [r.to_dict() for r in records[-500:]],
    })
    return True


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--csv", help="Готовый CSV с историей тиражей (нужен --game)")
    parser.add_argument("--fetch", action="store_true", help="Тянуть свежие тиражи из сети")
    parser.add_argument(
        "--allow-synthetic",
        action="store_true",
        help="Разрешить синтетику, если данных нет (только для отладки)",
    )
    parser.add_argument("--game", help="Собрать только эту игру (по умолчанию все)")
    parser.add_argument(
        "--mc-samples",
        type=int,
        default=200_000,
        help="Размер выборки Монте-Карло для нормировки модели популярности",
    )
    args = parser.parse_args()

    params = load_params()
    keys = [args.game] if args.game else list(params["games"])
    if args.csv and not args.game:
        parser.error("--csv относится к одной игре: укажите --game")

    generated = datetime.now(timezone.utc).isoformat(timespec="seconds")
    built = [key for key in keys if build_game(load_game(key, params), params, args, generated)]

    # Игры без единого тиража в список не попадают: приложение не должно
    # предлагать выбор, за которым пустой экран. Прежний список сохраняем,
    # если собирали одну игру.
    index_path = os.path.join(DATA_DIR, "meta.json")
    known = []
    if args.game and os.path.exists(index_path):
        with open(index_path, encoding="utf-8") as fh:
            known = [g["key"] for g in json.load(fh).get("games", []) if isinstance(g, dict)]
    listed = [k for k in params["games"] if k in built or k in known]

    if not listed:
        print(
            "\nОШИБКА: нет ни одного тиража ни для одной игры.\n"
            "Варианты:\n"
            "  1. Скачайте архив с https://www.stoloto.ru/6x45/archive\n"
            "     и запустите: python scripts/build_data.py --game 6x45 --csv <файл>\n"
            "  2. Для отладки без данных: --allow-synthetic",
            file=sys.stderr,
        )
        return 1

    print("\nОбщий индекс:")
    write_json("meta.json", {
        "generated_at": generated,
        "default_game": listed[0],
        "games": [
            {
                "key": k,
                "title": params["games"][k]["title"],
                "pick": params["games"][k]["pick"],
                "pool": params["games"][k]["pool"],
            }
            for k in listed
        ],
    })

    print("\nГотово.")
    return 0 if set(keys) <= set(built) or not args.game else 1


if __name__ == "__main__":
    raise SystemExit(main())
