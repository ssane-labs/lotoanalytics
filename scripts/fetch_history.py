"""Докачать историю тиражей из архива Столото в data/.

    python scripts/fetch_history.py                 # все игры, всё недостающее
    python scripts/fetch_history.py --game 6x45
    python scripts/fetch_history.py --max-pages 400 # не глубже 20 000 тиражей

Первый запуск тянет архив целиком (у «6 из 45» это около 380 страниц), потом
каждый прогон берёт только новые тиражи.
"""
from __future__ import annotations

import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8")
    except (AttributeError, OSError):
        pass

from lotto import history  # noqa: E402
from lotto.popularity import load_params  # noqa: E402
from lotto.stoloto_api import ApiUnavailable  # noqa: E402

# Сколько страниц архива читать при первом заходе. У «5 из 36» тираж каждые
# 15 минут, и полная история — это десятки тысяч страниц; для обучения хватает
# последних двадцати тысяч тиражей.
DEFAULT_MAX_PAGES = {"5x36plus": 400}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--game")
    parser.add_argument("--max-pages", type=int)
    args = parser.parse_args()

    params = load_params()
    keys = [args.game] if args.game else list(params["games"])
    failed = 0
    for key in keys:
        spec = params["games"][key]
        pages = args.max_pages or DEFAULT_MAX_PAGES.get(key, 10_000)
        print(f"{spec['title']}...")
        try:
            added, total = history.update(key, spec, max_pages=pages)
        except ApiUnavailable as exc:
            print(f"  архив недоступен: {exc}", file=sys.stderr)
            failed += 1
            continue
        print(f"  новых {added}, всего {total}")
    return 1 if failed == len(keys) else 0


if __name__ == "__main__":
    raise SystemExit(main())
