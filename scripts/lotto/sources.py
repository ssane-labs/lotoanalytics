"""Импорт архивов тиражей из CSV и синтетические тиражи для тестов.

Основной источник данных — архив Столото (stoloto_api.py и history.py).
Здесь то, что нужно помимо него:

1. `load_csv` — импорт однопольного архива, скачанного вручную. Заголовки
   распознаются гибко: и `draw,date,n1..n6`, и русские `Тираж,Дата,Числа`.
2. `synthetic` — заведомо случайные тиражи для тестов и отладки.
"""
from __future__ import annotations

import csv
import os
import random
import re
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from typing import Sequence

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
