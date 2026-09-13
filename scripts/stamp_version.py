"""Проставляет версии файлам Mini App, чтобы обновления не застревали в кэше.

Проблема. GitHub Pages отдаёт файлы с Cache-Control: max-age=600, а WebView
внутри Telegram держит их и дольше. Из-за этого свежий деплой доходит до
пользователя с задержкой, а иногда не доходит вовсе, пока он не почистит кэш
клиента вручную. Просить об этом пользователей нельзя.

Решение. К ссылкам на styles.css, app.js и на модули, которые импортирует
app.js, приписывается ?v=<хэш содержимого>. Адрес меняется вместе с файлом,
поэтому браузер обязан скачать новую версию, а неизменившиеся файлы
продолжает брать из кэша.

Хэш считается по содержимому БЕЗ уже проставленных меток — иначе каждая
простановка меняла бы файл и хэш вместе с ним, до бесконечности.

Запуск:  python scripts/stamp_version.py
Проверка: python scripts/stamp_version.py --check
"""
from __future__ import annotations

import argparse
import hashlib
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DOCS = os.path.join(ROOT, "docs")

# Файл -> какие ссылки в нём версионировать.
TARGETS = {
    "index.html": ["styles.css", "app.js"],
    "app.js": ["model.js", "config.js", "ai.js"],
}
HASHED = ["app.js", "model.js", "config.js", "ai.js", "styles.css"]

_VERSION_RE = re.compile(r"\?v=[0-9a-f]{8}")


def strip_versions(text: str) -> str:
    return _VERSION_RE.sub("", text)


def content_hash() -> str:
    """Общий хэш по всем файлам приложения, без меток версий."""
    h = hashlib.sha256()
    for name in sorted(HASHED):
        path = os.path.join(DOCS, name)
        with open(path, encoding="utf-8") as fh:
            h.update(strip_versions(fh.read()).encode("utf-8"))
    return h.hexdigest()[:8]


def stamp(text: str, assets: list[str], version: str) -> str:
    text = strip_versions(text)
    for asset in assets:
        # Ссылка может быть в src=, href= или в import ... from './x.js'
        text = re.sub(
            rf"(['\"](?:\./)?{re.escape(asset)})(['\"])",
            rf"\1?v={version}\2",
            text,
        )
    return text


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true",
                        help="только проверить, что версии проставлены верно")
    args = parser.parse_args()

    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except (AttributeError, OSError):
            pass

    version = content_hash()
    stale = []

    for name, assets in TARGETS.items():
        path = os.path.join(DOCS, name)
        current = open(path, encoding="utf-8").read()
        updated = stamp(current, assets, version)
        if current == updated:
            continue
        if args.check:
            stale.append(name)
        else:
            with open(path, "w", encoding="utf-8", newline="\n") as fh:
                fh.write(updated)
            print(f"  {name}: версия {version}")

    if args.check:
        if stale:
            print(
                f"Версии устарели в файлах: {', '.join(stale)}.\n"
                "Запустите python scripts/stamp_version.py и закоммитьте результат.",
                file=sys.stderr,
            )
            return 1
        print(f"Версии актуальны ({version})")
        return 0

    print(f"Готово. Версия содержимого: {version}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
