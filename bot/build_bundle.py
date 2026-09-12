"""Сборка worker.js и verify.js в один файл для веб-панели Cloudflare.

Зачем. Исходники разделены осознанно: проверка подписи initData живёт
отдельным модулем, потому что она критична для безопасности и покрыта своим
тестом. Но редактор в панели Cloudflare рассчитан на один файл, и просить
человека вручную склеивать два — верный способ получить рассинхрон.

Поэтому склейка автоматическая, а результат коммитится в репозиторий.
CI проверяет, что bundle собран из текущих исходников (см. tests.yml).

Запуск:  python bot/build_bundle.py
Проверка без записи:  python bot/build_bundle.py --check
"""
from __future__ import annotations

import argparse
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
WORKER = os.path.join(HERE, "worker.js")
VERIFY = os.path.join(HERE, "verify.js")
BUNDLE = os.path.join(HERE, "worker.bundle.js")

HEADER = """// СОБРАННЫЙ ФАЙЛ — НЕ РЕДАКТИРОВАТЬ ВРУЧНУЮ.
//
// Склеен из bot/worker.js и bot/verify.js скриптом bot/build_bundle.py.
// Правки вносите в исходники и пересобирайте, иначе они потеряются при
// следующей сборке.
//
// Этот файл существует ради веб-панели Cloudflare: туда удобно вставить
// ровно один файл. Целиком скопируйте его содержимое в редактор воркера.

"""


def build() -> str:
    verify = open(VERIFY, encoding="utf-8").read()
    worker = open(WORKER, encoding="utf-8").read()

    # Из модуля проверки убираем экспорт: после склейки функции и так лежат
    # в одной области видимости.
    verify_body = re.sub(
        r"^export \{[^}]*\};\s*$", "", verify, flags=re.M
    ).rstrip()

    # Из воркера убираем импорт того, что теперь объявлено выше.
    worker_body = re.sub(
        r"^import \{ verifyInitData \} from '\./verify\.js';\s*$",
        "",
        worker,
        flags=re.M,
    )

    return (
        HEADER
        + "// ===== из bot/verify.js =====\n\n"
        + verify_body
        + "\n\n// ===== из bot/worker.js =====\n"
        + worker_body
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--check",
        action="store_true",
        help="только проверить, что собранный файл совпадает с исходниками",
    )
    args = parser.parse_args()

    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except (AttributeError, OSError):
            pass

    fresh = build()

    if args.check:
        if not os.path.exists(BUNDLE):
            print("worker.bundle.js отсутствует. Запустите python bot/build_bundle.py",
                  file=sys.stderr)
            return 1
        current = open(BUNDLE, encoding="utf-8").read()
        if current != fresh:
            print(
                "worker.bundle.js устарел относительно исходников.\n"
                "Запустите python bot/build_bundle.py и закоммитьте результат.",
                file=sys.stderr,
            )
            return 1
        print("worker.bundle.js актуален")
        return 0

    with open(BUNDLE, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(fresh)
    lines = fresh.count("\n") + 1
    print(f"Собрано: {os.path.relpath(BUNDLE, os.path.dirname(HERE))} "
          f"({lines} строк, {len(fresh)} символов)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
