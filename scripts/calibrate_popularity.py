"""Обучение модели популярности на итогах тиражей Столото.

Идея. В каждом тираже известно, сколько было ставок и сколько из них угадали
2, 3, 4… числа. Если бы все ставили числа наугад, победителей в каждой
категории было бы ровно «ставки × вероятность». На деле, когда выпадают
числа, которые люди любят ставить (1–31, семёрка), угадавших больше, а когда
выпадают нелюбимые — меньше. По тысячам тиражей это отклонение позволяет
восстановить, насколько охотно ставят каждое число.

Модель ставок. Доля ρ ставок — автовыбор, равномерно по всем билетам.
Остальные выбирают люди: вероятность набора чисел в поле пропорциональна
произведению весов a_n входящих в него чисел. Для такой модели распределение
числа совпадений с тиражом считается точно, через элементарные симметрические
многочлены весов:

    P(совпало m | тираж D) = e_m(a_D) · e_{k-m}(a_{не D}) / e_k(a),

поэтому обучение — обычная максимизация правдоподобия (Пуассон по числу
победителей в каждой категории) без Монте-Карло. Когда число ставок в тираже
не опубликовано, оно выносится за скобки, и учится только распределение
победителей между категориями.

Честная проверка: модель учится на первых 80 % тиражей и оценивается на
последних 20 %, которых не видела, — против модели «все ставят наугад».
Опубликованные веса потом обучаются на всей истории.

    python scripts/calibrate_popularity.py            # все игры
    python scripts/calibrate_popularity.py --game 6x45

Нужен torch (только для этого скрипта, не для сборки данных).
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sys
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8")
    except (AttributeError, OSError):
        pass

import numpy as np  # noqa: E402
import scipy.sparse  # noqa: E402
import torch  # noqa: E402

from lotto import history  # noqa: E402
from lotto.popularity import load_params, popularity_config, _PARAMS_PATH  # noqa: E402
from lotto.params_io import dump_params  # noqa: E402

torch.set_default_dtype(torch.float64)

# Сколько последних тиражей брать. Привычки игроков и сама аудитория меняются:
# данные десятилетней давности описывают других людей.
MAX_DRAWS = 8000
HOLDOUT_SHARE = 0.2
# Априорный разброс log-весов: вес числа скорее в пределах ×/÷ e, чем за
# ними. Без этого редкие числа в малых играх получали бы веса из шума.
PRIOR_SD = 1.0


def esp(a: torch.Tensor, mask: torch.Tensor, k: int) -> torch.Tensor:
    """e_0..e_k весов, отобранных маской. a: (n,), mask: (B, n) -> (B, k+1)."""
    batch = mask.shape[0]
    e = torch.zeros(batch, k + 1)
    e[:, 0] = 1.0
    for x in range(a.shape[0]):
        ax = (a[x] * mask[:, x]).unsqueeze(1)
        e = torch.cat([e[:, :1], e[:, 1:] + ax * e[:, :-1]], dim=1)
    return e


def hypergeom(pool: int, pick: int) -> np.ndarray:
    return np.array([math.comb(pick, m) * math.comb(pool - pick, pick - m) / math.comb(pool, pick)
                     for m in range(pick + 1)])


class BetModel(torch.nn.Module):
    def __init__(self, fields: list[dict]):
        super().__init__()
        self.fields = fields
        self.theta = torch.nn.ParameterList(
            [torch.nn.Parameter(torch.zeros(f["pool"])) for f in fields])
        self.rho_logit = torch.nn.Parameter(torch.tensor(0.0))

    def weights(self, i: int) -> torch.Tensor:
        t = self.theta[i]
        return torch.exp(t - t.mean())

    @property
    def rho(self) -> torch.Tensor:
        return torch.sigmoid(self.rho_logit)

    def field_probs(self, i: int, masks: torch.Tensor) -> torch.Tensor:
        """P_human(m | D) для поля i: (B, k+1)."""
        k = self.fields[i]["pick"]
        a = self.weights(i)
        inside = esp(a, masks, k)
        outside = esp(a, 1.0 - masks, k)
        total = esp(a, torch.ones(1, a.shape[0]), k)[0, k]
        # m совпадений: m из выпавших и k-m из остальных.
        return torch.stack([inside[:, m] * outside[:, k - m] for m in range(k + 1)], dim=1) / total

    def category_probs(self, masks: list[torch.Tensor], cats: list, uniform: bool = False) -> torch.Tensor:
        batch = masks[0].shape[0]
        rand = [torch.tensor(hypergeom(f["pool"], f["pick"])) for f in self.fields]
        human = None if uniform else [self.field_probs(i, m) for i, m in enumerate(masks)]
        rho = torch.tensor(1.0) if uniform else self.rho
        out = []
        for combos in cats:
            p = torch.zeros(batch)
            for match in combos:
                pr = torch.ones(batch)
                for i, m in enumerate(match):
                    pr = pr * rand[i][m]
                if human is None:
                    p = p + pr
                    continue
                ph = torch.ones(batch)
                for i, m in enumerate(match):
                    ph = ph * human[i][:, m]
                p = p + rho * pr + (1 - rho) * ph
            out.append(p)
        return torch.stack(out, dim=1)


def nll(probs: torch.Tensor, counts: torch.Tensor, cols: torch.Tensor,
        present: torch.Tensor) -> torch.Tensor:
    """Пуассон там, где число ставок известно; иначе оно выносится за скобки.

    present — маска категорий, разыгранных в тираже.
    """
    known = cols > 0
    lam = probs * cols.unsqueeze(1)
    pois = ((lam - counts * torch.log(lam.clamp_min(1e-300))) * present).sum(dim=1)
    masked = probs * present
    pnorm = masked / masked.sum(dim=1, keepdim=True)
    multi = -(counts * present * torch.log(pnorm.clamp_min(1e-300))).sum(dim=1)
    return torch.where(known, pois, multi)


def total_nll(probs, data) -> float:
    """То, что сравниваем на отложенных тиражах."""
    return nll(probs, data["counts"], data["cols"], data["present"]).sum().item()


def load_dataset(key: str, spec: dict) -> dict:
    draws = history.load_draws(key, spec["fields"])
    results = history.load_results(key)
    expected = [c["title"] for c in spec["categories"]]
    rows = []
    for d in draws:
        r = results.get(d.draw_id)
        if not r or not r.counts:
            continue
        counts, _ = history.aligned(r, expected)
        # Нужны хотя бы две категории: иначе распределение победителей
        # между ними ничего не говорит.
        if sum(c is not None for c in counts) < 2 or not sum(c or 0 for c in counts):
            continue
        rows.append((d, r, counts))
    rows = rows[-MAX_DRAWS:]
    masks = []
    for i, f in enumerate(spec["fields"]):
        m = np.zeros((len(rows), f["pool"]))
        for j, (d, _, _) in enumerate(rows):
            for n in d.fields[i]:
                m[j, n - 1] = 1.0
        masks.append(torch.tensor(m))
    return {
        "masks": masks,
        "counts": torch.tensor([[c or 0 for c in cs] for _, _, cs in rows], dtype=torch.float64),
        "present": torch.tensor([[c is not None for c in cs] for _, _, cs in rows], dtype=torch.float64),
        "cols": torch.tensor([float(r.columns or 0) for _, r, _ in rows]),
        "dates": [d.date for d, _, _ in rows],
    }


def subset(data: dict, sl: slice) -> dict:
    return {
        "masks": [m[sl] for m in data["masks"]],
        "counts": data["counts"][sl],
        "present": data["present"][sl],
        "cols": data["cols"][sl],
        "dates": data["dates"][sl],
    }


def fit(model: BetModel, data: dict, cats, steps: int = 400) -> float:
    opt = torch.optim.LBFGS(model.parameters(), lr=0.5, max_iter=steps,
                            line_search_fn="strong_wolfe", tolerance_grad=1e-9)
    scale = data["counts"].sum().item()

    def closure():
        opt.zero_grad()
        probs = model.category_probs(data["masks"], cats)
        loss = nll(probs, data["counts"], data["cols"], data["present"]).sum() / scale
        # Априорный штраф в тех же единицах, что и правдоподобие.
        reg = sum((t - t.mean()).pow(2).sum() for t in model.theta) / (2 * PRIOR_SD ** 2) / scale
        total = loss + reg
        total.backward()
        return total

    opt.step(closure)
    return closure().item()


# ---------------------------------------------------------------------------
# Второй этап: структурные факторы.
#
# Соседние числа, баланс чётных, «человеческая» сумма, узкий диапазон —
# свойства набора целиком, через веса отдельных чисел их не выразить, и
# точной формулы для совпадений с ними нет. Поэтому здесь выборка по
# значимости: M случайных билетов, у каждого известны числа и признаки, а
# вероятность категории в тираже — доля веса билетов, которые в неё попали.
# Веса чисел учатся заново вместе со структурой (из первого этапа — старт):
# любовь к малым числам и к малым суммам иначе не разделить.
#
# Берутся категории, в которые попадает не больше 3 % билетов (иначе
# выборка не помещается в память) и не меньше 20 билетов выборки на тираж
# (иначе оценка шумит).
# ---------------------------------------------------------------------------

STRUCT_KEYS = ["no_adjacent", "run3", "balanced", "extreme", "sum_peak", "narrow", "patterns"]
# Коридор для множителей: ÷30…×30. Без него в играх, где число ставок не
# публикуется, оптимизатор находит вырожденные решения — сжимает весь вес
# на горстке билетов выборки.
LOG_BOUND = math.log(30.0)
# Структура «никакая»: все множители единица, узоров нет.
NEUTRAL_STRUCTURE = {k: 1.0 for k in STRUCT_KEYS[:6]} | {"patterns": 0.0}


def bounded(x: torch.Tensor) -> torch.Tensor:
    return LOG_BOUND * torch.tanh(x / LOG_BOUND)
MAX_SAMPLES = 400_000
MAX_NNZ = 20_000_000


def sample_fields(fields: list[dict], m: int, seed: int) -> list[np.ndarray]:
    rng = np.random.default_rng(seed)
    out = []
    for f in fields:
        keys = rng.random((m, f["pool"]))
        out.append(np.sort(np.argsort(keys, axis=1)[:, :f["pick"]] + 1, axis=1))
    return out


def bitmask(tickets: np.ndarray) -> np.ndarray:
    return np.bitwise_or.reduce(np.left_shift(np.uint64(1), (tickets - 1).astype(np.uint64)), axis=1)


def structure_features(tickets: list[np.ndarray], fields: list[dict], cfg: dict):
    """Признаки билетов и неподгоняемый остаток литературных факторов.

    Возвращает (признаки M×len(STRUCT_KEYS), log-смещение M). Столбец
    sum_peak — колокол суммы, остальные — сколько полей билета обладают
    признаком. Прогрессии, линии бланка и серии от четырёх чисел в случайной
    выборке почти не встречаются, данных о них нет — они из литературы.
    """
    from lotto.popularity import _arithmetic_factor, _grid_factor

    m = tickets[0].shape[0]
    feats = np.zeros((m, len(STRUCT_KEYS)))
    offset = np.zeros(m)
    runs_cfg = cfg["consecutive_run"]["run_length_multiplier"]
    sw = cfg["sum_window"]
    thr = cfg["decade_clustering"]["narrow_range_threshold"]
    for t, f in zip(tickets, fields):
        k = f["pick"]
        if k < 3:
            continue
        adj = np.diff(t, axis=1) == 1
        run = np.ones(m, dtype=int)
        cur = np.ones(m, dtype=int)
        for j in range(adj.shape[1]):
            cur = np.where(adj[:, j], cur + 1, 1)
            run = np.maximum(run, cur)
        evens = (t % 2 == 0).sum(axis=1)
        feats[:, 0] += run == 1
        feats[:, 1] += run == 3
        feats[:, 2] += (k % 2 == 0) & (evens == k // 2)
        feats[:, 3] += (evens == 0) | (evens == k)
        z = (t.sum(axis=1) - sw["human_peak"]) / sw["sigma"]
        feats[:, 4] += np.exp(-0.5 * z * z)
        feats[:, 5] += (t[:, -1] - t[:, 0]) <= thr
        for i in np.nonzero(run >= 4)[0]:
            offset[i] += math.log(float(runs_cfg.get(str(run[i]), 1.0)))
        # Прогрессии и узоры бланка — дорогие проверки, но только для
        # кандидатов: у прогрессии все разности равны, у узора есть строка
        # или столбец, где собрались почти все числа.
        diffs = np.diff(t, axis=1)
        cols = f["slip"]["cols"]
        maybe = (diffs == diffs[:, :1]).all(axis=1)
        if k >= 5:
            for s0 in range(k - 4):
                w = diffs[:, s0:s0 + 4]
                maybe |= (w == w[:, :1]).all(axis=1)
        r = (t - 1) // cols
        c = (t - 1) % cols
        conc = np.zeros(m, dtype=int)
        for vals in (r, c):
            for v in range(int(vals.max()) + 1):
                conc = np.maximum(conc, (vals == v).sum(axis=1))
        maybe |= conc >= min(max(4, k - 2), k)
        dr = np.diff(r, axis=1)
        dc = np.diff(c, axis=1)
        maybe |= ((dr == 1) & (np.abs(dc) == 1)).sum(axis=1) >= min(5, k) - 1
        for i in np.nonzero(maybe)[0]:
            row = tuple(int(x) for x in t[i])
            a = _arithmetic_factor(row, cfg)
            g = _grid_factor(row, cfg, cols)
            offset[i] += math.log(a) + math.log(g)
    return feats, offset


class StructModel(torch.nn.Module):
    def __init__(self, fields: list[dict], theta0: list[torch.Tensor], rho0: float):
        super().__init__()
        self.fields = fields
        self.theta = torch.nn.ParameterList([torch.nn.Parameter(t.clone()) for t in theta0])
        self.beta = torch.nn.Parameter(torch.zeros(len(STRUCT_KEYS)))
        r = min(max(rho0, 1e-4), 1 - 1e-4)
        self.rho_logit = torch.nn.Parameter(torch.tensor(math.log(r / (1 - r))))

    @property
    def rho(self):
        return torch.sigmoid(self.rho_logit)

    def log_weights(self, i: int) -> torch.Tensor:
        th = self.theta[i]
        return bounded(th - th.mean())

    @property
    def patterns(self) -> torch.Tensor:
        """Степень к литературным множителям узоров: 1 — как в литературе,
        0 — узоры на выбор людей не влияют."""
        return 2 * torch.sigmoid(self.beta[6])

    def log_u(self, idx: list[torch.Tensor], feats: torch.Tensor, offset: torch.Tensor) -> torch.Tensor:
        out = offset * self.patterns
        for i, ix in enumerate(idx):
            out = out + self.log_weights(i)[ix].sum(dim=1)
        beta = bounded(self.beta)
        lin = torch.cat([beta[:4], beta[5:6]])
        out = out + feats[:, [0, 1, 2, 3, 5]] @ lin
        # Колокол суммы: множитель 1 + (pm - 1)·колокол, pm = e^beta.
        out = out + torch.log1p((torch.exp(beta[4]) - 1) * feats[:, 4])
        return out

    def multipliers(self) -> dict:
        b = bounded(self.beta.detach()).exp().tolist()
        out = {k: round(v, 4) for k, v in zip(STRUCT_KEYS[:6], b)}
        out["patterns"] = round(float(self.patterns.detach()), 4)
        return out


def build_is(data: dict, spec: dict, cfg: dict, seed: int = 7):
    """Выборка билетов и разреженная матрица «тираж×категория — билеты»."""
    fields = spec["fields"]
    n_draws = data["counts"].shape[0]
    rand = [hypergeom(f["pool"], f["pick"]) for f in fields]
    p0 = []
    for c in spec["categories"]:
        p = 0.0
        for match in c["match"]:
            pr = 1.0
            for i, mm in enumerate(match):
                pr *= rand[i][mm]
            p += pr
        p0.append(p)
    usable = [j for j, p in enumerate(p0) if p <= 0.03]
    m = MAX_SAMPLES
    mass = sum(p0[j] for j in usable)
    if mass * n_draws * m > MAX_NNZ:
        m = int(MAX_NNZ / (mass * n_draws))
    usable = [j for j in usable if p0[j] * m >= 20]
    if not usable or not any(f["pick"] >= 3 for f in fields):
        return None

    tickets = sample_fields(fields, m, seed)
    masks = [bitmask(t) for t in tickets]
    feats, offset = structure_features(tickets, fields, cfg)

    # Категория билета по сочетанию совпадений в полях.
    lookup = np.full([f["pick"] + 1 for f in fields], -1, dtype=np.int64)
    for pos, j in enumerate(usable):
        for match in spec["categories"][j]["match"]:
            lookup[tuple(match)] = pos

    draw_bits = []
    for i, f in enumerate(fields):
        dm = data["masks"][i].numpy().astype(bool)
        bits = np.zeros(n_draws, dtype=np.uint64)
        for n in range(f["pool"]):
            bits |= np.where(dm[:, n], np.uint64(1) << np.uint64(n), np.uint64(0))
        draw_bits.append(bits)

    rows, cols_ = [], []
    for d in range(n_draws):
        matches = [np.bitwise_count(mk & bits[d]).astype(np.int64) for mk, bits in zip(masks, draw_bits)]
        cat = lookup[tuple(matches)]
        hit = np.nonzero(cat >= 0)[0]
        rows.append(d * len(usable) + cat[hit])
        cols_.append(hit)
    rows = np.concatenate(rows)
    cols_ = np.concatenate(cols_)
    S = scipy.sparse.csr_matrix((np.ones(len(rows)), (rows, cols_)), shape=(n_draws * len(usable), m))
    return {
        "usable": usable, "m": m, "S": S, "ST": S.T.tocsr(),
        "idx": [torch.tensor(t - 1) for t in tickets],
        "feats": torch.tensor(feats), "offset": torch.tensor(offset),
        "p0": torch.tensor([p0[j] for j in usable]),
    }


class SparseMul(torch.autograd.Function):
    """y = S·u для разреженной S из scipy. Транспонированная матрица
    готовится один раз: обратный проход torch пересобирал её на каждом шаге."""

    @staticmethod
    def forward(ctx, u, S, ST):
        ctx.ST = ST
        return torch.from_numpy(S @ u.detach().numpy())

    @staticmethod
    def backward(ctx, grad):
        return torch.from_numpy(ctx.ST @ grad.numpy()), None, None


def is_probs(model: StructModel, isd: dict, draws: slice, n_total: int) -> torch.Tensor:
    lu = model.log_u(isd["idx"], isd["feats"], isd["offset"])
    u = torch.exp(lu - lu.max())
    k = len(isd["usable"])
    ph = SparseMul.apply(u, isd["S"], isd["ST"]).reshape(n_total, k)[draws] / u.sum()
    return model.rho * isd["p0"] + (1 - model.rho) * ph


def fit_struct(model: StructModel, isd: dict, data: dict, draws: slice, steps: int = 200) -> None:
    n_total = data["counts"].shape[0]
    u = isd["usable"]
    counts = data["counts"][draws][:, u]
    present = data["present"][draws][:, u]
    cols = data["cols"][draws]
    scale = counts.sum().item()
    opt = torch.optim.LBFGS(model.parameters(), lr=0.5, max_iter=steps,
                            line_search_fn="strong_wolfe", tolerance_grad=1e-9)

    # LBFGS на плоском правдоподобии иногда улетает в nan. Запоминаем лучшую
    # конечную точку и откатываемся к ней.
    best = {"loss": math.inf, "state": None}

    def closure():
        opt.zero_grad()
        loss = nll(is_probs(model, isd, draws, n_total), counts, cols, present).sum() / scale
        reg = (sum((t - t.mean()).pow(2).sum() for t in model.theta) + model.beta.pow(2).sum()) \
            / (2 * PRIOR_SD ** 2) / scale
        total = loss + reg
        value = total.item()
        if not math.isfinite(value):
            return torch.tensor(math.inf)
        if value < best["loss"]:
            best["loss"] = value
            best["state"] = {k: v.detach().clone() for k, v in model.state_dict().items()}
        total.backward()
        return total

    try:
        opt.step(closure)
    except RuntimeError:
        pass
    if best["state"] is not None:
        model.load_state_dict(best["state"])


def struct_nll(model: StructModel, isd: dict, data: dict, draws: slice) -> float:
    u = isd["usable"]
    with torch.no_grad():
        probs = is_probs(model, isd, draws, data["counts"].shape[0])
        return nll(probs, data["counts"][draws][:, u], data["cols"][draws],
                   data["present"][draws][:, u]).sum().item()


def literature_beta(cfg: dict) -> torch.Tensor:
    c = cfg["consecutive_run"]
    p = cfg["parity_balance"]
    return torch.cat([torch.log(torch.tensor([
        c["no_adjacent_pair_bonus"], float(c["run_length_multiplier"].get("3", 1.0)),
        p["balanced_3_3_multiplier"], p["extreme_0_6_multiplier"],
        cfg["sum_window"]["peak_multiplier"], cfg["decade_clustering"]["narrow_range_multiplier"],
    ])), torch.zeros(1)])


def calibrate(key: str, spec: dict, params: dict) -> dict | None:
    data = load_dataset(key, spec)
    n = data["counts"].shape[0]
    if n < 200:
        print(f"  {key}: мало тиражей с итогами ({n}), пропуск")
        return None
    cats = [c["match"] for c in spec["categories"]]
    cut = int(n * (1 - HOLDOUT_SHARE))
    train, test = subset(data, slice(0, cut)), subset(data, slice(cut, n))

    probe = BetModel(spec["fields"])
    fit(probe, train, cats)
    with torch.no_grad():
        nll_model = total_nll(probe.category_probs(test["masks"], cats), test)
        nll_uniform = total_nll(probe.category_probs(test["masks"], cats, uniform=True), test)
    # Разница log-правдоподобий на отложенных тиражах: насколько лучше модель
    # объясняет число победителей, чем «все ставят наугад».
    gain = nll_uniform - nll_model
    print(f"  {key}: {n} тиражей, отложено {n - cut}, выигрыш log-правдоподобия {gain:.1f} "
          f"({gain / (n - cut):.3f} на тираж)")

    model = BetModel(spec["fields"])
    fit(model, data, cats)

    # Второй этап: структура. Литературные множители — точка сравнения:
    # насколько обученные лучше тех, что стояли в модели раньше.
    # Литературная конфигурация — без прошлой калибровки этой игры: иначе
    # повторное обучение стартовало бы с собственного прошлого результата.
    clean = json.loads(json.dumps(params))
    clean["games"][key].pop("calibration", None)
    cfg = popularity_config(clean, key)
    isd = build_is(data, spec, cfg)
    structure, struct_holdout = None, None
    if isd:
        print(f"  структура: выборка {isd['m']} билетов, категории "
              f"{[spec['categories'][j]['title'] for j in isd['usable']]}")
        tr, te = slice(0, cut), slice(cut, n)
        theta1 = [t.detach() for t in probe.theta]
        base = StructModel(spec["fields"], theta1, float(probe.rho.detach()))
        with torch.no_grad():
            base.beta[6] = -40.0  # без узоров вовсе
        lit = StructModel(spec["fields"], theta1, float(probe.rho.detach()))
        with torch.no_grad():
            lit.beta.copy_(literature_beta(cfg))
        s_probe = StructModel(spec["fields"], theta1, float(probe.rho.detach()))
        fit_struct(s_probe, isd, data, tr)
        nll_base = struct_nll(base, isd, data, te)
        nll_lit = struct_nll(lit, isd, data, te)
        nll_fit = struct_nll(s_probe, isd, data, te)
        struct_holdout = {
            "vs_numbers_only": round(nll_base - nll_fit, 1),
            "vs_literature": round(nll_lit - nll_fit, 1),
        }
        print(f"    на отложенных: лучше модели без структуры на {nll_base - nll_fit:.1f}, "
              f"лучше литературных множителей на {nll_lit - nll_fit:.1f}")
        if nll_base - nll_fit > 0:
            final = StructModel(spec["fields"], [t.detach() for t in model.theta], float(model.rho.detach()))
            fit_struct(final, isd, data, slice(0, n))
            structure = final.multipliers()
            print(f"    множители: {structure}")
            weights = [torch.exp(final.log_weights(i)).detach().numpy() for i in range(len(spec["fields"]))]
            rho = float(final.rho.detach())
        else:
            # Структура не помогает на тиражах, которых модель не видела, —
            # значит, она подгоняется под шум. Остаются только веса чисел, а
            # структурные множители нейтральны: литературные здесь ещё хуже.
            structure = dict(NEUTRAL_STRUCTURE)
            print("    структура на отложенных хуже — оставлены только веса чисел")
            weights = [model.weights(i).detach().numpy() for i in range(len(spec["fields"]))]
            rho = float(model.rho.detach())
    else:
        weights = [model.weights(i).detach().numpy() for i in range(len(spec["fields"]))]
        rho = float(model.rho.detach())

    field_weights = [[round(float(w / ws.mean()), 4) for w in ws] for ws in weights]
    for i, ws in enumerate(field_weights):
        top = sorted(range(len(ws)), key=lambda j: -ws[j])
        print(f"    поле {i + 1}: чаще всех {[t + 1 for t in top[:6]]}, реже всех {[t + 1 for t in top[-6:]]}")
        print(f"      веса: {ws}")
    print(f"    автовыбор: {rho:.1%}")

    cols = data["cols"]
    return {
        "_comment": "Обучено scripts/calibrate_popularity.py на итогах тиражей Столото. Не править руками.",
        "fitted_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "draws": n,
        "date_from": data["dates"][0],
        "date_to": data["dates"][-1],
        "bets": int(cols[cols > 0].sum().item()),
        "winners": int(data["counts"].sum().item()),
        "random_share": round(rho, 4),
        "holdout": {
            "draws": n - cut,
            "loglik_gain": round(gain, 1),
            "loglik_gain_per_draw": round(gain / (n - cut), 4),
            "structure": struct_holdout,
        },
        "structure": structure,
        "field_weights": field_weights,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--game")
    args = parser.parse_args()
    params = load_params()
    params = json.loads(json.dumps(params))  # копия: load_params кэширует
    keys = [args.game] if args.game else list(params["games"])
    for key in keys:
        print(params["games"][key]["title"])
        cal = calibrate(key, params["games"][key], params)
        if cal:
            params["games"][key]["calibration"] = cal
    dump_params(params, _PARAMS_PATH)
    print("Записано в model_params.json")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
