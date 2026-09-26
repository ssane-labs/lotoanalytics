"""Запись model_params.json в читаемом виде.

json.dump с отступом раскладывает каждый элемент массива на свою строку, и
сорок пять весов чисел превращаются в сорок пять строк. Здесь короткие
массивы и объекты пишутся в строку, длинные — по элементу.
"""
from __future__ import annotations

import json

INLINE_LIMIT = 100


def _inline(value) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(", ", ": "))


def _dump(value, indent: int) -> str:
    pad = "  " * indent
    flat = _inline(value)
    if not isinstance(value, (dict, list)) or len(flat) + len(pad) <= INLINE_LIMIT:
        return flat
    if isinstance(value, list):
        # Массив чисел — строками по ширине, а не по элементу.
        if all(not isinstance(v, (dict, list)) for v in value):
            lines, line = [], ""
            for v in value:
                item = _inline(v)
                if line and len(pad) + 2 + len(line) + len(item) + 2 > INLINE_LIMIT:
                    lines.append(line.rstrip())
                    line = ""
                line += item + ", "
            lines.append(line.rstrip(", "))
            inner = ",\n".join(f"{pad}  {ln.rstrip(',')}" for ln in lines)
            return "[\n" + inner + "\n" + pad + "]"
        items = [f"{pad}  {_dump(v, indent + 1)}" for v in value]
        return "[\n" + ",\n".join(items) + "\n" + pad + "]"
    items = [f"{pad}  {_inline(k)}: {_dump(v, indent + 1)}" for k, v in value.items()]
    return "{\n" + ",\n".join(items) + "\n" + pad + "}"


def dump_params(params: dict, path: str) -> None:
    with open(path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(_dump(params, 0) + "\n")
