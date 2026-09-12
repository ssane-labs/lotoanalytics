"""Сборка статических данных для Mini App.

Запускается по расписанию в GitHub Actions и коммитит результат в docs/data/.
Mini App — чистая статика на GitHub Pages, никакого сервера: браузер тянет
эти JSON и считает всё на клиенте.

Запуск:
    python scripts/build_data.py --csv data/draws_6x45.csv
    python scripts/build_data.py --fetch              # тянуть из Столото
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
from lotto.popularity import load_game, load_params, mean_weight  # noqa: E402
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


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--csv", help="Готовый CSV с историей тиражей")
    parser.add_argument("--fetch", action="store_true", help="Тянуть из Столото")
    parser.add_argument(
        "--allow-synthetic",
        action="store_true",
        help="Разрешить синтетику, если данных нет (только для отладки)",
    )
    parser.add_argument("--game", default="6x45")
    parser.add_argument(
        "--mc-samples",
        type=int,
        default=200_000,
        help="Размер выборки Монте-Карло для нормировки модели популярности",
    )
    args = parser.parse_args()

    params = load_params()
    game = load_game(args.game, params)

    # --- данные ---------------------------------------------------------
    # Архив накапливается: каждый прогон добавляет новые тиражи к тому, что
    # уже собрано, и никогда не затирает историю. Иначе один сбойный запрос
    # к сайту обнулил бы месяцы накопленных данных.
    cache_path = os.path.join(ROOT, "data", f"draws_{args.game}.csv")
    collected: list = []
    sources_used: list[str] = []
    errors: list[str] = []

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
        for name, fetcher in (
            ("stoloto", lambda: fetch_stoloto(args.game, pick=game.pick, pool=game.pool)),
            ("lotocafe", lambda: fetch_lotocafe(pick=game.pick, pool=game.pool)),
        ):
            try:
                fresh = fetcher()
            except SourceUnavailable as exc:
                errors.append(f"{name}: {exc}")
                continue
            before = len(collected)
            collected = merge(collected, fresh)
            sources_used.append(name)
            print(f"{name}: получено {len(fresh)}, новых {len(collected) - before}")

    if not collected:
        if not args.allow_synthetic:
            print("ОШИБКА: нет ни одного тиража.", file=sys.stderr)
            for err in errors:
                print(f"  {err}", file=sys.stderr)
            print(
                "\nВарианты:\n"
                "  1. Скачайте архив с https://www.stoloto.ru/6x45/archive\n"
                "     и запустите: python scripts/build_data.py --csv <файл>\n"
                "  2. Для отладки без данных: --allow-synthetic",
                file=sys.stderr,
            )
            return 1
        collected = synthetic(1500, game.pick, game.pool)
        sources_used = ["synthetic"]

    records = collected
    draws = [r.numbers for r in records]
    is_synthetic = sources_used == ["synthetic"]
    source = "+".join(sources_used)

    print(f"\nИсточник: {source}, всего тиражей: {len(draws)}")
    if is_synthetic:
        print("ВНИМАНИЕ: данные синтетические. Публиковать в прод нельзя.")
    else:
        save_csv(cache_path, records)
        print(f"Архив сохранён: {os.path.relpath(cache_path, ROOT)}")

    # --- расчёты --------------------------------------------------------
    print("\nСчитаю нормировку модели популярности...")
    mw = mean_weight(game, params, samples=args.mc_samples)
    print(f"  средний вес = {mw:.6f}")

    print("Считаю статистику тиражей...")
    summary = lstats.summarize(draws, game.pool, game.pick)
    print(f"  хи-квадрат = {summary['uniformity']['chi2']:.1f}, "
          f"p = {summary['uniformity']['p_value']}")

    generated = datetime.now(timezone.utc).isoformat(timespec="seconds")

    print("\nПишу файлы:")

    write_json(
        "meta.json",
        {
            "generated_at": generated,
            "source": source,
            "synthetic": is_synthetic,
            "draws_count": len(draws),
            "enough_for_stats": len(draws) >= MIN_DRAWS_FOR_STATS,
            "enough_for_backtest": len(draws) >= MIN_DRAWS_FOR_BACKTEST,
            "min_draws_for_stats": MIN_DRAWS_FOR_STATS,
            "latest_draw": records[-1].to_dict() if records else None,
            "games": [args.game],
            "disclaimer": (
                "Вероятность выигрыша не зависит от выбора чисел и равна "
                "1/8145060 для «6 из 45». Сервис не предсказывает результаты "
                "и не может их предсказывать. Он считает, насколько редко "
                "выбранную комбинацию ставят другие игроки, чтобы при выигрыше "
                "джекпот не пришлось делить."
            ),
        },
    )

    write_json(
        f"{args.game}_model.json",
        {
            "game": {
                "key": game.key,
                "title": game.title,
                "pick": game.pick,
                "pool": game.pool,
                "ticket_price_rub": game.ticket_price_rub,
                "slip": {"rows": game.slip_rows, "cols": game.slip_cols},
                "prizes_rub": {str(k): v for k, v in game.prizes_rub.items()},
                "typical_players_per_draw": game.typical_players_per_draw,
                "total_combinations": game.total_combinations,
            },
            "popularity": params["popularity"],
            "mean_weight": mw,
            "mc_samples": args.mc_samples,
            "recent_winners": [list(d) for d in draws[-HISTORY_FOR_MODEL:]],
        },
    )

    write_json(
        f"{args.game}_stats.json",
        {"generated_at": generated, "synthetic": is_synthetic, **summary},
    )

    write_json(
        f"{args.game}_draws.json",
        {
            "generated_at": generated,
            "synthetic": is_synthetic,
            "draws": [r.to_dict() for r in records[-500:]],
        },
    )

    print("\nГотово.")
    if is_synthetic:
        print("Напоминание: пересоберите с реальными данными перед публикацией.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
