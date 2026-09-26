"""Накопленная история тиражей: числа и итоги по категориям.

Два файла на игру в data/:
  draws_<игра>.csv     — номер, дата, числа (поля через « | »);
  results_<игра>.jsonl — ставок в тираже, суперприз, победители и выплаты
                         по категориям. Нужен для обучения модели популярности
                         и для реальных, а не выдуманных сумм выигрышей.

Архив только растёт: каждый прогон дописывает новые тиражи и никогда не
затирает старые, чтобы сбой одного запроса не стоил месяцев данных.
"""
from __future__ import annotations

import csv
import json
import os
from dataclasses import dataclass, field
from typing import Callable, Sequence

from .stoloto_api import ApiDraw, iter_archive

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DATA_DIR = os.path.join(ROOT, "data")

Fields = tuple[tuple[int, ...], ...]


@dataclass(frozen=True)
class Draw:
    draw_id: int
    date: str
    fields: Fields

    def to_dict(self) -> dict:
        return {"draw": self.draw_id, "date": self.date, "numbers": [list(f) for f in self.fields]}


@dataclass
class Result:
    draw_id: int
    columns: int | None
    super_prize: int | None
    ticket_price: int | None
    counts: list[int] = field(default_factory=list)
    amounts: list[int] = field(default_factory=list)
    # Названия категорий пишем, только если они отличаются от нынешних
    # правил игры: такие тиражи в обучение не берём.
    titles: list[str] | None = None

    def to_json(self) -> str:
        out = {"draw": self.draw_id, "cols": self.columns, "super": self.super_prize,
               "price": self.ticket_price, "n": self.counts, "amt": self.amounts}
        if self.titles is not None:
            out["t"] = self.titles
        return json.dumps(out, ensure_ascii=False, separators=(",", ":"))

    @classmethod
    def from_json(cls, line: str) -> "Result":
        d = json.loads(line)
        return cls(d["draw"], d.get("cols"), d.get("super"), d.get("price"),
                   d.get("n") or [], d.get("amt") or [], d.get("t"))


def aligned(result: Result, expected: Sequence[str]) -> tuple[list[int | None], list[int | None]]:
    """Победители и выплаты в порядке категорий игры, по названиям.

    Часть тиражей разыгрывается с урезанным набором категорий (например, без
    «2 из 6»). Отсутствующая категория — None, а не ноль: ноль означал бы
    «никто не угадал», и модель училась бы на неправде.
    """
    titles = result.titles if result.titles is not None else list(expected)
    index = {t.strip(): i for i, t in enumerate(titles)}
    counts: list[int | None] = []
    amounts: list[int | None] = []
    for title in expected:
        i = index.get(title)
        if i is None or i >= len(result.counts):
            counts.append(None)
            amounts.append(None)
        else:
            counts.append(result.counts[i])
            amounts.append(result.amounts[i] if i < len(result.amounts) else None)
    return counts, amounts


def draws_path(key: str) -> str:
    return os.path.join(DATA_DIR, f"draws_{key}.csv")


def results_path(key: str) -> str:
    return os.path.join(DATA_DIR, f"results_{key}.jsonl")


def upcoming_path(key: str) -> str:
    return os.path.join(DATA_DIR, f"upcoming_{key}.json")


def load_upcoming(key: str) -> dict | None:
    """Ближайший тираж: номер, время и суперприз, который сейчас на кону."""
    try:
        with open(upcoming_path(key), encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return None


def format_fields(fields: Fields) -> str:
    return " | ".join(" ".join(map(str, f)) for f in fields)


def parse_fields(raw: str, picks: Sequence[int]) -> Fields:
    """«1 2 3 4 | 5 6 7 8». Однопольные игры пишутся без разделителя."""
    parts = [p for p in raw.split("|")]
    if len(parts) == 1 and len(picks) > 1:
        nums = [int(x) for x in parts[0].split()]
        out, pos = [], 0
        for k in picks:
            out.append(tuple(sorted(nums[pos:pos + k])))
            pos += k
        return tuple(out)
    return tuple(tuple(sorted(int(x) for x in p.split())) for p in parts)


def validate(fields: Fields, spec_fields: Sequence[dict]) -> None:
    if len(fields) != len(spec_fields):
        raise ValueError(f"полей {len(fields)}, ожидалось {len(spec_fields)}")
    for nums, spec in zip(fields, spec_fields):
        if len(nums) != spec["pick"]:
            raise ValueError(f"в поле {len(nums)} чисел, ожидалось {spec['pick']}")
        if len(set(nums)) != len(nums):
            raise ValueError(f"числа повторяются: {nums}")
        if not all(1 <= n <= spec["pool"] for n in nums):
            raise ValueError(f"число вне 1..{spec['pool']}: {nums}")


def load_draws(key: str, spec_fields: Sequence[dict]) -> list[Draw]:
    path = draws_path(key)
    if not os.path.exists(path):
        return []
    picks = [f["pick"] for f in spec_fields]
    out: dict[int, Draw] = {}
    with open(path, encoding="utf-8", newline="") as fh:
        for row in csv.DictReader(fh):
            fields = parse_fields(row["numbers"], picks)
            validate(fields, spec_fields)
            out[int(row["draw"])] = Draw(int(row["draw"]), row["date"], fields)
    return [out[k] for k in sorted(out)]


def save_draws(key: str, draws: Sequence[Draw]) -> None:
    os.makedirs(DATA_DIR, exist_ok=True)
    with open(draws_path(key), "w", encoding="utf-8", newline="") as fh:
        writer = csv.writer(fh, lineterminator="\n")
        writer.writerow(["draw", "date", "numbers"])
        for d in sorted(draws, key=lambda d: d.draw_id):
            writer.writerow([d.draw_id, d.date, format_fields(d.fields)])


def load_results(key: str) -> dict[int, Result]:
    path = results_path(key)
    if not os.path.exists(path):
        return {}
    out = {}
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            if line.strip():
                r = Result.from_json(line)
                out[r.draw_id] = r
    return out


def save_results(key: str, results: dict[int, Result]) -> None:
    os.makedirs(DATA_DIR, exist_ok=True)
    with open(results_path(key), "w", encoding="utf-8", newline="\n") as fh:
        for k in sorted(results):
            fh.write(results[k].to_json() + "\n")


def update(key: str, spec: dict, max_pages: int = 10_000, log: Callable = print) -> tuple[int, int]:
    """Дотянуть из архива Столото всё, чего нет локально. -> (новых, всего)."""
    spec_fields = spec["fields"]
    draws = {d.draw_id: d for d in load_draws(key, spec_fields)}
    results = load_results(key)
    # Итоги тиража публикуются чуть позже чисел: последние тиражи, у которых
    # нет итогов, перезапрашиваем, а не считаем уже загруженными.
    complete = [k for k in draws if k in results and results[k].counts]
    known_max = max(complete) if complete else 0
    expected = [c["title"] for c in spec.get("categories", [])]
    picks = [f["pick"] for f in spec_fields]

    upcoming: list[dict] = []
    added = 0
    for rec in iter_archive(spec["stoloto"], picks, stop_below=known_max,
                            max_pages=max_pages, log=log, on_upcoming=upcoming.append):
        try:
            validate(rec.fields, spec_fields)
        except ValueError as exc:
            log(f"  {key}: тираж {rec.draw_id} пропущен — {exc}")
            continue
        if rec.draw_id not in draws:
            added += 1
        draws[rec.draw_id] = Draw(rec.draw_id, rec.date, rec.fields)
        results[rec.draw_id] = Result(
            rec.draw_id, rec.columns, rec.super_prize, rec.ticket_price,
            rec.counts, rec.amounts,
            None if [t.strip() for t in rec.titles] == expected else rec.titles,
        )
    save_draws(key, draws.values())
    save_results(key, results)
    if upcoming:
        nearest = min(upcoming, key=lambda u: u["draw"])
        with open(upcoming_path(key), "w", encoding="utf-8") as fh:
            json.dump(nearest, fh, ensure_ascii=False)
    return added, len(draws)
