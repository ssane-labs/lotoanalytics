"""Архив тиражей из API Столото.

Это тот же адрес, с которого архив тиражей берут сайт и приложение Столото.
Кроме выпавших чисел он отдаёт то, чего нет ни на одном агрегаторе: сколько
ставок было в тираже и сколько из них выиграло в каждой категории. Именно на
этих числах обучается модель популярности (scripts/calibrate_popularity.py):
если выпали числа, которые люди любят ставить, победителей больше ожидаемого.

Страница — не больше 50 тиражей, от новых к старым. Между запросами пауза:
архив публичный, но нагружать его без нужды незачем.
"""
from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Iterator, Sequence

ARCHIVE_URL = "https://www.stoloto.ru/p/api/mobile/api/v35/service/draws/archive"
# Заголовок, без которого архив отвечает 403. Его отправляет сам сайт.
PARTNER_HEADER = ("Gosloto-Partner", "bXMjXFRXZ3coWXh6R3s1NTdUX3dnWlBMLUxmdg")
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
)
PAGE_SIZE = 50
PAUSE_SEC = 0.25


class ApiUnavailable(RuntimeError):
    """Архив не ответил или ответил не тем."""


@dataclass
class ApiDraw:
    draw_id: int
    date: str
    fields: tuple[tuple[int, ...], ...]
    # Итоги: None, если архив их не отдал (у части старых тиражей их нет).
    columns: int | None = None
    super_prize: int | None = None
    ticket_price: int | None = None
    counts: list[int] = field(default_factory=list)
    amounts: list[int] = field(default_factory=list)
    titles: list[str] = field(default_factory=list)


def _get(game: str, page: int, timeout: int = 40) -> dict:
    url = f"{ARCHIVE_URL}?game={game}&count={PAGE_SIZE}&page={page}"
    req = urllib.request.Request(url, headers={
        "User-Agent": USER_AGENT,
        "Accept": "application/json",
        PARTNER_HEADER[0]: PARTNER_HEADER[1],
    })
    last = None
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                data = json.loads(resp.read().decode("utf-8"))
            if data.get("requestStatus") != "success":
                raise ApiUnavailable(f"{url}: {data.get('errors')}")
            return data
        except (urllib.error.URLError, TimeoutError, OSError, ValueError) as exc:
            last = exc
            time.sleep(2 * (attempt + 1))
    raise ApiUnavailable(f"{url}: {last}")


def _split(numbers: Sequence[int], picks: Sequence[int]) -> tuple[tuple[int, ...], ...]:
    if len(numbers) != sum(picks):
        raise ValueError(f"чисел {len(numbers)}, ожидалось {sum(picks)}")
    out, pos = [], 0
    for k in picks:
        out.append(tuple(sorted(numbers[pos:pos + k])))
        pos += k
    return tuple(out)


def parse_draw(raw: dict, picks: Sequence[int]) -> ApiDraw | None:
    """Один тираж из ответа архива. None — тираж ещё не разыгран."""
    if not raw.get("completed"):
        return None
    combo = raw.get("combination") or {}
    nums = combo.get("structured")
    if not isinstance(nums, list):
        nums = [int(x) for x in combo.get("serialized") or raw.get("winningCombination") or []]
    if not nums:
        return None
    rec = ApiDraw(
        draw_id=int(raw["number"]),
        date=str(raw.get("date", ""))[:10],
        fields=_split([int(x) for x in nums], picks),
        super_prize=int(raw["superPrize"]) if raw.get("superPrize") is not None else None,
        ticket_price=int(raw["ticketPrice"]) if raw.get("ticketPrice") else None,
    )
    cats = sorted(raw.get("winCategories") or [], key=lambda c: c.get("number", 0))
    rec.counts = [int(c.get("participants") or 0) for c in cats]
    rec.amounts = [int(c.get("amount") or 0) for c in cats]
    rec.titles = [str((c.get("title") or {}).get("ru") or c.get("description") or "") for c in cats]
    if raw.get("winningCategories"):
        try:
            wc = json.loads(raw["winningCategories"])
            if wc.get("columns"):
                rec.columns = int(wc["columns"])
        except (ValueError, TypeError):
            pass
    return rec


def iter_archive(
    game: str,
    picks: Sequence[int],
    stop_below: int = 0,
    max_pages: int = 10_000,
    log=None,
    on_upcoming=None,
) -> Iterator[ApiDraw]:
    """Тиражи от новых к старым, пока не дойдём до stop_below или начала архива.

    on_upcoming получает ещё не разыгранные тиражи: их суперприз — это то,
    что стоит на кону сейчас.
    """
    for page in range(1, max_pages + 1):
        data = _get(game, page)
        draws = data.get("draws") or []
        if not draws:
            return
        oldest = None
        for raw in draws:
            if on_upcoming and not raw.get("completed") and raw.get("number"):
                on_upcoming({
                    "draw": int(raw["number"]),
                    "date": str(raw.get("date", ""))[:16],
                    "super_prize": raw.get("superPrize"),
                    "ticket_price": raw.get("ticketPrice"),
                })
            try:
                rec = parse_draw(raw, picks)
            except (ValueError, KeyError, TypeError):
                continue
            if rec is None:
                continue
            oldest = rec.draw_id
            if rec.draw_id <= stop_below:
                return
            yield rec
        if log and page % 20 == 0:
            log(f"  {game}: страница {page}, тираж {oldest}")
        if len(draws) < PAGE_SIZE:
            return
        time.sleep(PAUSE_SEC)
