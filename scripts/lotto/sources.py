"""Источники истории тиражей.

Три пути получения данных, по убыванию удобства:

1. `fetch_stoloto` — разбор официального архива. Сайт не даёт публичного API и
   может менять вёрстку, поэтому адаптер намеренно параноидальный: при любом
   сомнении он падает с внятной ошибкой, а не возвращает мусор.
2. `load_csv` — импорт файла, скачанного вручную кнопкой «Скачать архив».
   Это гарантированный путь, он не зависит от вёрстки сайта.
3. `synthetic` — заведомо случайные данные для локальной разработки. Всегда
   помечаются флагом `synthetic: true`, чтобы их нельзя было спутать с
   настоящими и случайно опубликовать как реальную статистику.
"""
from __future__ import annotations

import csv
import io
import json
import os
import random
import re
import urllib.error
import urllib.request
from dataclasses import dataclass, asdict
from datetime import date, datetime, timedelta
from typing import Iterator, Sequence

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
)


class SourceUnavailable(RuntimeError):
    """Источник недоступен или изменил формат."""


@dataclass(frozen=True)
class DrawRecord:
    draw_id: int
    date: str  # ISO 8601
    numbers: tuple[int, ...]

    def to_dict(self) -> dict:
        return {"draw": self.draw_id, "date": self.date, "numbers": list(self.numbers)}


def _validate(rec: DrawRecord, pick: int, pool: int) -> None:
    if len(rec.numbers) != pick:
        raise SourceUnavailable(
            f"Тираж {rec.draw_id}: чисел {len(rec.numbers)}, ожидалось {pick}"
        )
    if len(set(rec.numbers)) != pick:
        raise SourceUnavailable(f"Тираж {rec.draw_id}: числа повторяются")
    if not all(1 <= n <= pool for n in rec.numbers):
        raise SourceUnavailable(f"Тираж {rec.draw_id}: число вне диапазона 1..{pool}")


# ---------------------------------------------------------------------------
# CSV
# ---------------------------------------------------------------------------

_DATE_FORMATS = ("%d.%m.%Y", "%Y-%m-%d", "%d/%m/%Y", "%d.%m.%y")


def _parse_date(raw: str) -> str:
    raw = raw.strip().split()[0] if raw.strip() else ""
    for fmt in _DATE_FORMATS:
        try:
            return datetime.strptime(raw, fmt).date().isoformat()
        except ValueError:
            continue
    raise SourceUnavailable(f"Не разобрана дата: {raw!r}")


def load_csv(path: str, pick: int = 6, pool: int = 45) -> list[DrawRecord]:
    """Импорт CSV. Ожидаются колонки с номером тиража, датой и числами.

    Заголовки распознаются гибко: подойдут и `draw,date,n1..n6`, и русские
    `Тираж,Дата,Числа` (числа одной строкой через пробел или запятую).
    """
    with open(path, encoding="utf-8-sig", newline="") as fh:
        sample = fh.read(4096)
        fh.seek(0)
        try:
            dialect = csv.Sniffer().sniff(sample, delimiters=",;\t")
        except csv.Error:
            dialect = csv.excel
        rows = list(csv.reader(fh, dialect))

    if not rows:
        raise SourceUnavailable(f"Пустой файл: {path}")

    header = [c.strip().lower() for c in rows[0]]
    body = rows[1:]

    def find(*names: str) -> int | None:
        for i, col in enumerate(header):
            if any(name in col for name in names):
                return i
        return None

    i_draw = find("тираж", "draw", "номер")
    i_date = find("дата", "date")
    i_nums = find("числа", "комбинац", "numbers", "результат")

    out: list[DrawRecord] = []
    for lineno, row in enumerate(body, start=2):
        if not any(cell.strip() for cell in row):
            continue
        try:
            draw_id = int(re.sub(r"\D", "", row[i_draw])) if i_draw is not None else lineno
            iso = _parse_date(row[i_date]) if i_date is not None else ""
            if i_nums is not None:
                nums = tuple(int(x) for x in re.findall(r"\d+", row[i_nums]))
            else:
                # Отдельные колонки n1..n6 — берём все числовые ячейки, кроме
                # номера тиража и даты.
                skip = {i for i in (i_draw, i_date) if i is not None}
                nums = tuple(
                    int(cell)
                    for i, cell in enumerate(row)
                    if i not in skip and cell.strip().isdigit()
                )
            rec = DrawRecord(draw_id, iso, tuple(sorted(nums)))
            _validate(rec, pick, pool)
            out.append(rec)
        except SourceUnavailable:
            raise
        except (ValueError, IndexError) as exc:
            raise SourceUnavailable(f"Строка {lineno} не разобрана: {exc}") from exc

    if not out:
        raise SourceUnavailable(f"В файле {path} не найдено ни одного тиража")
    out.sort(key=lambda r: r.draw_id)
    return out


def save_csv(path: str, draws: Sequence[DrawRecord]) -> None:
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="") as fh:
        writer = csv.writer(fh)
        writer.writerow(["draw", "date", "numbers"])
        for rec in draws:
            writer.writerow([rec.draw_id, rec.date, " ".join(map(str, rec.numbers))])


# ---------------------------------------------------------------------------
# Столото
# ---------------------------------------------------------------------------

_ROW_RE = re.compile(
    r"(?P<draw>\d{3,7})\s*(?:тираж)?\s*(?:от\s*)?(?P<date>\d{2}\.\d{2}\.\d{4})"
    r"(?P<tail>(?:\D{0,40}\d{1,2}){6})",
    re.IGNORECASE,
)


def _http_get(url: str, timeout: int = 30) -> str:
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": USER_AGENT,
            "Accept": "text/html,application/json;q=0.9,*/*;q=0.8",
            "Accept-Language": "ru-RU,ru;q=0.9",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            charset = resp.headers.get_content_charset() or "utf-8"
            return resp.read().decode(charset, errors="replace")
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise SourceUnavailable(f"Сеть недоступна для {url}: {exc}") from exc


def fetch_stoloto(
    game: str = "6x45",
    pages: int = 8,
    pick: int = 6,
    pool: int = 45,
) -> list[DrawRecord]:
    """Разбор архива Столото.

    Официального API нет; страницы генерируются на клиенте, поэтому разбор
    может перестать работать после редизайна. Это НОРМАЛЬНО и предусмотрено:
    вызывающий код должен ловить SourceUnavailable и откатываться на CSV.
    """
    found: dict[int, DrawRecord] = {}
    errors: list[str] = []

    for page in range(1, pages + 1):
        url = f"https://www.stoloto.ru/{game}/archive?page={page}"
        try:
            html = _http_get(url)
        except SourceUnavailable as exc:
            errors.append(str(exc))
            break

        text = re.sub(r"<[^>]+>", " ", html)
        text = re.sub(r"\s+", " ", text)
        before = len(found)
        for match in _ROW_RE.finditer(text):
            nums = tuple(sorted(int(x) for x in re.findall(r"\d{1,2}", match["tail"])))
            if len(nums) < pick:
                continue
            nums = nums[:pick]
            try:
                rec = DrawRecord(int(match["draw"]), _parse_date(match["date"]), nums)
                _validate(rec, pick, pool)
            except SourceUnavailable:
                continue
            found.setdefault(rec.draw_id, rec)
        if len(found) == before:
            # Страница не дала новых тиражей — дальше смысла нет.
            break

    if not found:
        raise SourceUnavailable(
            "Не удалось разобрать архив Столото. "
            "Скачайте архив вручную с https://www.stoloto.ru/6x45/archive "
            "и положите файл в data/draws_6x45.csv, затем запустите "
            "scripts/build_data.py --csv data/draws_6x45.csv. "
            + (" | ".join(errors) if errors else "")
        )
    return sorted(found.values(), key=lambda r: r.draw_id)


# ---------------------------------------------------------------------------
# lotocafe.ru — независимый агрегатор
# ---------------------------------------------------------------------------

_MONTHS_RU = {
    "января": 1, "февраля": 2, "марта": 3, "апреля": 4, "мая": 5, "июня": 6,
    "июля": 7, "августа": 8, "сентября": 9, "октября": 10, "ноября": 11,
    "декабря": 12,
}

_LOTOCAFE_ROW = re.compile(
    r"Тираж\s+(?P<draw>\d{3,7})\s+"
    r"(?P<day>\d{1,2})\s+(?P<month>[а-яё]+)\s+"
    r"(?P<nums>(?:\d{1,2}\s+){5}\d{1,2})",
    re.IGNORECASE,
)

LOTOCAFE_URL = "https://lotocafe.ru/archive-6-iz-45"


def fetch_lotocafe(pick: int = 6, pool: int = 45) -> list[DrawRecord]:
    """Последние тиражи со страницы-списка lotocafe.ru.

    Осознанное ограничение: забираем ровно одну страницу — те ~12 тиражей,
    что отдаются в HTML. Подгрузка остальных идёт через /wp-admin/admin-ajax.php,
    а robots.txt сайта запрещает весь /wp-. Массовую выкачку истории отсюда
    делать нельзя, и мы её не делаем.

    Для ежедневного обновления этого достаточно с запасом: в «6 из 45»
    проводится порядка десяти тиражей в сутки. История накапливается в
    data/draws_6x45.csv от запуска к запуску, а разовый бэкфилл делается
    импортом официального архива (см. load_csv).
    """
    html = _http_get(LOTOCAFE_URL)
    text = re.sub(r"<[^>]+>", " ", html)
    text = re.sub(r"&nbsp;?", " ", text)
    text = re.sub(r"\s+", " ", text)

    today = date.today()
    found: dict[int, DrawRecord] = {}

    for match in _LOTOCAFE_ROW.finditer(text):
        month = _MONTHS_RU.get(match["month"].lower())
        if not month:
            continue
        # Год на странице не указан. Берём текущий, а если дата оказалась в
        # будущем — значит, это декабрь прошлого года.
        year = today.year
        try:
            when = date(year, month, int(match["day"]))
        except ValueError:
            continue
        if when > today:
            when = date(year - 1, month, int(match["day"]))

        nums = tuple(sorted(int(x) for x in match["nums"].split()))
        try:
            rec = DrawRecord(int(match["draw"]), when.isoformat(), nums)
            _validate(rec, pick, pool)
        except SourceUnavailable:
            continue
        found.setdefault(rec.draw_id, rec)

    if not found:
        raise SourceUnavailable(
            f"Не удалось разобрать {LOTOCAFE_URL} — вероятно, изменилась вёрстка."
        )
    return sorted(found.values(), key=lambda r: r.draw_id)


def merge(*groups: Sequence[DrawRecord]) -> list[DrawRecord]:
    """Объединить наборы тиражей по номеру; более поздний источник побеждает."""
    merged: dict[int, DrawRecord] = {}
    for group in groups:
        for rec in group:
            merged[rec.draw_id] = rec
    return sorted(merged.values(), key=lambda r: r.draw_id)


# ---------------------------------------------------------------------------
# Синтетика для локальной разработки
# ---------------------------------------------------------------------------

def synthetic(
    count: int = 1500,
    pick: int = 6,
    pool: int = 45,
    seed: int = 2024,
    start: date | None = None,
) -> list[DrawRecord]:
    """Заведомо случайные тиражи. Только для разработки и тестов."""
    rng = random.Random(seed)
    start = start or (date.today() - timedelta(days=count))
    numbers = list(range(1, pool + 1))
    return [
        DrawRecord(
            draw_id=10000 + i,
            date=(start + timedelta(days=i)).isoformat(),
            numbers=tuple(sorted(rng.sample(numbers, pick))),
        )
        for i in range(count)
    ]


def load_any(
    csv_path: str | None,
    game: str = "6x45",
    pick: int = 6,
    pool: int = 45,
    allow_synthetic: bool = False,
) -> tuple[list[DrawRecord], str]:
    """Данные + метка источника. Порядок: CSV -> сеть -> синтетика."""
    if csv_path and os.path.exists(csv_path):
        return load_csv(csv_path, pick, pool), "csv"
    try:
        return fetch_stoloto(game, pick=pick, pool=pool), "stoloto"
    except SourceUnavailable:
        if not allow_synthetic:
            raise
        return synthetic(pick=pick, pool=pool), "synthetic"
