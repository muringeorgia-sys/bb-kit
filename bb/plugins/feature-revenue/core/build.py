# -*- coding: utf-8 -*-
"""Калькулятор выручки фич релиза, версия 3: json-конфиг -> xlsx с формулами + md + json.

Запуск:  python build.py releases/<дата>.json [--out-dir ПАПКА]
--out-dir: сохранить xlsx, md и json в эту папку (имена файлов из конфига), исходные файлы не трогать.
--explain: ничего не сохранять, напечатать json с шагами расчёта (для панели bb «Выручка фич»).
           Из stdin берёт {"overrides": {"inputs": {ключ фичи: {id входа: значение}}, "k": число}, "slim": bool}:
           значение входа заменяет ожидаемый сценарий (или value у входа без сценариев).
--release: для конфига со всеми фичами (поле tracker) — посчитать только фичи этого релиза в трекере (ГГГГ-ММ-ДД),
           all — все фичи, none — фичи без релиза в трекере.
Конфиг со всеми фичами: поле tracker.source — файл с данными трекера (эпики, статусы, релизы; путь от папки
конфига). Файла нет — статус и релиз берутся из самой фичи (status, planned). Срок — по release_offsets
(сдвиг в релизах от планового, раздел 7 методики).
Строки выручки, валюта и коэффициент k — из конфига: lines, currency, fin_total (spend_lines, topup_line, spend_share).
Методика: Методика.md в папке данных плагина (версия 3)
"""
import argparse
import json
import math
import re
import sys
from datetime import date, datetime, timedelta
from pathlib import Path
from statistics import median

from openpyxl import Workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter

SC = ["neg", "exp", "pos"]
DAYS_IN_MONTH = 30.4
LEVELS = ["У1", "У2", "У3", "У4", "У5"]
WEAK = ("У3", "У4", "У5")
CONF_BY_LEVEL = {"У1": "высокая", "У2": "высокая", "У3": "средняя", "У4": "низкая", "У5": "низкая"}
# ICE для эпика в трекере: Confidence — по уровню главного входа, Effort — часы по размеру
CONF_PCT = {"У1": 100, "У2": 80, "У3": 50, "У4": 30, "У5": 20}
EFFORT_HOURS = {"S": 16, "M": 40, "L": 80, "XL": 160}
MECHANICS = ["цена", "платный шаг", "новая услуга", "интерфейс", "коммуникация",
             "бонусы и скидки", "кредит и партнёры", "B2B"]
# Строки выручки задаёт конфиг (main -> setup_lines): lines и fin_total.spend_lines / topup_line / extra_lines.
SPEND_LINES = []      # траты с внутреннего баланса: в итог выручки идут × k
TOPUP_LINE = None     # строка пополнений баланса
KNOWN_LINES = []
CUR = "₽"             # валюта: поле currency конфига


def setup_lines(cfg):
    global SPEND_LINES, TOPUP_LINE, KNOWN_LINES, CUR
    ft = cfg.get("fin_total", {})
    SPEND_LINES = list(ft.get("spend_lines", []))
    TOPUP_LINE = ft.get("topup_line")
    KNOWN_LINES = list(dict.fromkeys(SPEND_LINES + ([TOPUP_LINE] if TOPUP_LINE else []) +
                                     list(cfg.get("lines", {})) + list(ft.get("extra_lines", []))))
    CUR = cfg.get("currency") or "₽"
LONG_TAIL_MECH = {"новая услуга", "бонусы и скидки"}   # замер ещё через 90 дней
COST_MECH = {"цена", "бонусы и скидки"}                 # нужен порог окупаемости
MONEY_RU = {"spend": "траты", "topup": "пополнения", "direct": "прямые"}

HEAD_FILL = PatternFill("solid", fgColor="E7EAEE")
FEAT_FILL = PatternFill("solid", fgColor="F3F5F7")
RES_FILL = PatternFill("solid", fgColor="E8F1FB")
HIT_FILL = PatternFill("solid", fgColor="FDECEA")
THIN = Side(style="thin", color="C9CED6")
BORDER = Border(left=THIN, right=THIN, top=THIN, bottom=THIN)
NUM = "#,##0;-#,##0;0"
NUM2 = "0.00"
PCT = "0.0%"

# ---------- проверки (раздел 8 методики) ----------
C_SRC = "Вход без источника или логики"
C_LVL = "Вход без уровня доказательства"
C_SCEN = "Неблагоприятный сценарий не по правилу: компонент с плюсом на У3–У5 больше 0"
C_ANALOG = "У2: ожидаемый не равен значению аналога"
C_MAIN = "Больше двух главных входов в компоненте"
C_FIXED = "Слабый вход (У3–У5) одинаков во всех сценариях"
C_CONF = "Уверенность в конфиге не совпадает с правилом"
C_LINE = "Компонент без одной строки выручки"
C_MECH = "Компонент без механики из списка"
C_STEPS = "Компонент без шагов расчёта или последний шаг не равен формуле"
C_BE = "Нет порога окупаемости (цена, бонусы и скидки)"
C_OVL = "Пересечение: одна группа у нескольких фич"
C_GROW = "Сумма ожидаемых эффектов по строке больше наибольшего роста строки за месяц"
C_NOISE = "Эффект меньше обычного колебания строки"
C_PREV = "Расхождение с прошлой оценкой больше чем в 2 раза"
C_STATUS = "Статус эпика не найден в правилах срока"
C_TRACKER = "Фича не найдена в данных трекера: статус и релиз взяты из конфига"
C_NOREL = "У эпика нет релиза в трекере: фича не попадает ни в один релиз"
C_K = "Не задан коэффициент k: траты → итог выручки"
C_MEASURE = "Нет прямой метрики замера с прогнозом"
C_EFFORT = "Нет оценки трудозатрат (effort) у фичи с числом: ICE не считается"
C_RAMP = "Кривая разгона: плато вне (0; 1]"
C_HORIZON = "Горизонт оценки"

CHECKS = [
    (C_SRC, "Вход не идёт в расчёт, пока нет источника, периода или логики в одну строку"),
    (C_LVL, "Проставить У1–У5 по критериям раздела 4"),
    (C_SCEN, "По разделу 5 неблагоприятный = 0 (расходы остаются). Иначе — поле deviation с причиной"),
    (C_ANALOG, "Ожидаемый = значение аналога. Иначе — поле deviation с причиной"),
    (C_MAIN, "Сценарии различаются 1–2 входами: объединить входы в один множитель или deviation у компонента"),
    (C_FIXED, "Сделать вход главным, объединить с главным множителем или deviation с причиной"),
    (C_CONF, "Уверенность = самый слабый уровень среди входов. Поправить уровень входа или убрать confidence"),
    (C_LINE, "Разбить компонент: одна строка выручки на компонент (поле line)"),
    (C_MECH, "Поле mechanic из списка: " + ", ".join(MECHANICS)),
    (C_STEPS, "Записать steps: одна операция на шаг, название словами, последний шаг = formula (раздел 3 методики)"),
    (C_BE, "Записать breakeven: при каком значении главного входа эффект = 0"),
    (C_OVL, "Вычесть пересечение отдельным компонентом или записать groups.<группа>.note"),
    (C_GROW, "Пересмотреть пересечения и входы"),
    (C_NOISE, "Пометка «без A/B не измерить»: факт сверяем только по прямой метрике"),
    (C_PREV, "Объяснить причину одной строкой в prev_reason"),
    (C_STATUS, "Добавить статус в release_rules (release_offsets) или release_override у фичи"),
    (C_TRACKER, "Проверить ключ эпика или обновить данные кнопкой «Обновить из трекера»"),
    (C_NOREL, "Поставить эпику релиз (fixVersion) в трекере или убрать фичу из конфига"),
    (C_K, "Задать fin_total.spend_share или lines со строкой пополнений и строками трат"),
    (C_MEASURE, "До релиза записать measure: метрика, прогноз по сценариям, способ"),
    (C_EFFORT, "Записать effort: размер S/M/L/XL (16/40/80/160 ч) или часы разработчиков; XL — предложить разбить"),
    (C_RAMP, "Кривая — доля полного эффекта, последняя точка от 0 до 1"),
]
ACTION = dict(CHECKS)


class Checks:
    def __init__(self):
        self.hits = {name: [] for name, _ in CHECKS}
        self.info = []

    def hit(self, name, where, note="", reason=None):
        status = "с причиной" if reason else "сработала"
        self.hits[name].append((where, status, ("Причина: " + reason) if reason else note))

    def rows(self):
        out = []
        for name, action in CHECKS:
            if self.hits[name]:
                for where, status, note in self.hits[name]:
                    out.append([name, where, status, note if status == "с причиной" else ((note + ". ") if note else "") + action])
            else:
                out.append([name, "все", "прошла", ""])
        for where, note in self.info:
            out.append([C_HORIZON, where, "к сведению", note])
        return out

    def triggered(self):
        return [(n, w, s, t) for n, _ in CHECKS for (w, s, t) in self.hits[n] if s == "сработала"]


# ---------- время ----------
def d(s):
    y, m, dd = map(int, s.split("-"))
    return date(y, m, dd)


def ramp_share(profile, day):
    """Доля полного эффекта на day-й день после старта денег (линейно между точками)."""
    pts = sorted((int(k), v) for k, v in profile.items())
    if day <= pts[0][0]:
        return pts[0][1]
    for (d0, v0), (d1, v1) in zip(pts, pts[1:]):
        if d0 <= day <= d1:
            return v0 + (v1 - v0) * (day - d0) / (d1 - d0)
    return pts[-1][1]


def plateau(profile):
    return sorted((int(k), v) for k, v in profile.items())[-1][1]


def effect_months(start, profile, p_from, p_to, decay=0.0):
    """Месяцев эффекта «на полном разгоне» в периоде: сумма долей разгона ÷ плато ÷ 30,4, с затуханием."""
    top = plateau(profile) or 1.0
    total = 0.0
    cur = max(start, p_from)
    while cur <= p_to:
        days = (cur - start).days
        total += ramp_share(profile, days) / top * (1 - decay) ** (days / DAYS_IN_MONTH)
        cur += timedelta(days=1)
    return total / DAYS_IN_MONTH


# ---------- формулы ----------
def py_eval(expr, values):
    return eval(expr, {"__builtins__": {}, "min": min, "max": max}, values)


def zero_point(ix, comps, exp_vals, total):
    """Значение входа, при котором «в месяц, ожидаемый» фичи = 0 (остальные входы — ожидаемые).
    Только для панели: в xlsx и md не попадает. None — в разумных пределах ноля нет."""
    if abs(ix["lever"].get("neg", 0)) + abs(ix["lever"].get("pos", 0)) <= 0.5:
        return None
    used = [cx for cx in comps if not cx["window_days"] and ix["id"] in cx["inputs"]]

    def f(x):
        vv = dict(exp_vals)
        vv[ix["id"]] = x
        try:
            return total + sum(py_eval(cx["formula"], vv) * cx["plateau"] - cx["month"]["exp"] for cx in used)
        except (ZeroDivisionError, OverflowError, ValueError):
            return float("nan")

    vs = [ix["values"][s] for s in SC]
    lo, hi, x_exp = min(vs), max(vs), ix["values"]["exp"]
    span = (hi - lo) or abs(x_exp) or 1.0
    a, b = lo - 3 * span, hi + 3 * span
    if lo >= 0:
        a = max(a, 0.0)
    if hi <= 0:
        b = min(b, 0.0)
    if ix.get("unit") == "доля":
        b = min(b, max(1.0, hi))
    n = 400
    xs = [a + (b - a) * i / n for i in range(n + 1)]
    ys = [f(x) for x in xs]
    tol = max(1.0, abs(total) * 1e-6)
    roots = []
    for i in range(n + 1):
        if ys[i] == ys[i] and abs(ys[i]) < tol:
            roots.append(xs[i])
        elif i and ys[i - 1] == ys[i - 1] and ys[i] == ys[i] and ys[i - 1] * ys[i] < 0:
            x0, x1, f0 = xs[i - 1], xs[i], ys[i - 1]
            for _ in range(80):
                m = (x0 + x1) / 2
                fm = f(m)
                if fm != fm:
                    break
                if f0 * fm <= 0:
                    x1 = m
                else:
                    x0, f0 = m, fm
            r = (x0 + x1) / 2
            if f(r) == f(r) and abs(f(r)) < tol * 10:  # не полюс
                roots.append(r)
    if not roots:
        return None
    return round(min(roots, key=lambda r: abs(r - x_exp)), 6)


def to_excel(expr, refs):
    out = re.sub(r"\bmin\(", "MIN(", expr)
    out = re.sub(r"\bmax\(", "MAX(", out)
    for name in sorted(refs, key=len, reverse=True):
        out = re.sub(r"\b%s\b" % re.escape(name), refs[name], out)
    return out


def ids_in(expr, ids):
    return [t for t in dict.fromkeys(re.findall(r"[A-Za-z_][A-Za-z0-9_]*", expr)) if t in ids]


def money_of(comp, line):
    if comp.get("money"):
        return comp["money"]
    if TOPUP_LINE and line.startswith(TOPUP_LINE):
        return "topup"
    if any(s in line for s in SPEND_LINES):
        return "spend"
    return "direct"


def line_ok(line):
    return line in KNOWN_LINES or line.startswith("Новая")


def find_root(p):
    """Папка данных: родитель папки releases с конфигом (пути out_xlsx и tracker.source — от неё)."""
    return p.parent.parent if p.parent.name == "releases" else p.parent


def line_stats(spec):
    months = [v for _, v in sorted(spec.get("months", {}).items())]
    last = months[-3:]
    base = spec.get("base", sum(last) / len(last) if last else None)
    growth = [b - a for a, b in zip(months, months[1:])]
    max_growth = spec.get("max_growth", max(growth) if growth else None)
    rel = [abs(b - a) / a for a, b in zip(months, months[1:]) if a]
    noise = spec.get("noise", median(rel) if rel else None)
    return base, max_growth, noise


def spend_share(cfg):
    ft = cfg.get("fin_total", {})
    if "spend_share" in ft:
        return ft["spend_share"], ft.get("source", "")
    lines = cfg.get("lines", {})
    if not SPEND_LINES:
        return 1.0, "нет строк трат с баланса (fin_total.spend_lines): k = 1"
    if TOPUP_LINE in lines and all(s in lines for s in SPEND_LINES):
        keys = sorted(lines[TOPUP_LINE]["months"])[-3:]
        top = sum(lines[TOPUP_LINE]["months"][k] for k in keys)
        spend = sum(lines[s]["months"].get(k, 0) for s in SPEND_LINES for k in keys)
        if spend:
            return top / spend, "%s ÷ траты с баланса за %s – %s (lines)" % (TOPUP_LINE, keys[0], keys[-1])
    return None, ""


def k_by_month(cfg):
    """k по каждому из 3 последних закрытых месяцев: пополнения ÷ траты с баланса (для панели)."""
    lines = cfg.get("lines", {})
    if not SPEND_LINES or TOPUP_LINE not in lines or not all(s in lines for s in SPEND_LINES):
        return []
    out = []
    for key in sorted(lines[TOPUP_LINE]["months"])[-3:]:
        spend = sum(lines[s]["months"].get(key, 0) for s in SPEND_LINES)
        if spend:
            out.append({"month": key, "k": lines[TOPUP_LINE]["months"][key] / spend})
    return out


def apply_overrides(cfg, ov):
    """Что-если из панели: значение входа заменяет ожидаемый сценарий; k — вместо расчётного."""
    for key, inputs in (ov.get("inputs") or {}).items():
        f = next((x for x in cfg["features"] if x["key"] == key), None)
        for iid, val in (inputs or {}).items():
            inp = next((i for i in (f or {}).get("inputs", []) if i["id"] == iid), None)
            if inp is None:
                continue
            if any(s in inp for s in SC):
                inp["exp"] = val
            else:
                inp["value"] = val
    if ov.get("k") is not None:
        cfg.setdefault("fin_total", {})["spend_share"] = ov["k"]
        cfg["fin_total"]["source"] = "задано в панели"


# ---------- Трекер: статус и релиз фичи ----------
def tracker_ver_date(name, product=None):
    """Релиз -> date: ISO «2027-03-10» или имя версии с датой «… 10/03/2027». product — префикс имени версии
    (tracker.product): версии других продуктов — None. Без даты — None."""
    s = str(name).strip()
    if product and not s.startswith(product) and not re.fullmatch(r"\d{4}-\d{2}-\d{2}", s):
        return None
    m = re.search(r"(\d{4})-(\d{2})-(\d{2})", s)
    if m:
        return date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
    m = re.search(r"(\d{2})[./](\d{2})[./](\d{4})", s)
    return date(int(m.group(3)), int(m.group(2)), int(m.group(1))) if m else None


def load_tracker(cfg, root):
    """Данные трекера (эпики, статусы, релизы) — файл tracker.source, его пишет плагин кнопкой «Обновить из трекера».
    Файла нет — пустые данные: статус и релиз из конфига. None — конфиг одного релиза без поля tracker.
    Формат: {"generated": мс, "today": "ГГГГ-ММ-ДД", "versions": {"ГГГГ-ММ-ДД": "имя"},
             "epics": [{"key", "type", "status", "summary", "versions": ["ГГГГ-ММ-ДД" или имя версии с датой]}]}"""
    jc = cfg.get("tracker")
    if not jc:
        return None
    p = root / jc.get("source", "tracker.json")
    raw = json.loads(p.read_text(encoding="utf-8")) if p.exists() else {}
    cal = {d(iso) for iso in (raw.get("versions") or {})}
    cal |= {d(v) for v in cfg["release"].get("dates", {}).values()}
    gen = raw.get("generated")
    at = datetime.fromtimestamp(gen / 1000) if isinstance(gen, (int, float)) else None
    today = d(raw["today"]) if raw.get("today") else (at.date() if at else date.today())
    return {"epics": {e["key"]: e for e in raw.get("epics", [])}, "product": jc.get("product") or None,
            "cancelled": set(jc.get("cancelled_statuses", ["Отменено", "Отклонено"])),
            "calendar": sorted(cal), "today": today, "at": at.isoformat(timespec="minutes") if at else None,
            "source": jc.get("source", "tracker.json") if p.exists() else None, "step": jc.get("step_days", 14)}


def tracker_of(f, tracker):
    """Статус и плановый релиз фичи: из трекера, если эпик есть в данных, иначе из конфига (status, planned)."""
    e = tracker["epics"].get(f["key"])
    if not e:
        return {"found": False, "status": f.get("status", ""), "planned": d(f["planned"]) if f.get("planned") else None,
                "versions": [], "summary": None}
    vs = sorted(x for x in (tracker_ver_date(v, tracker["product"]) for v in e.get("versions") or []) if x)
    return {"found": True, "status": e.get("status", ""), "planned": vs[0] if vs else None,
            "versions": [x.isoformat() for x in vs], "summary": e.get("summary")}


def shift_release(tracker, planned, n):
    """Релиз через n релизов после планового: календарь версий трекера, после последней — шагом step_days."""
    cal = sorted(set(tracker["calendar"]) | {planned})
    i = cal.index(planned) + n
    if i < len(cal):
        return cal[i]
    return cal[-1] + timedelta(days=tracker["step"] * (i - len(cal) + 1))


def offsets_rule(cfg, status, planned, today):
    """Сдвиг срока по статусу (раздел 7): до релиза меньше near_days — таблица near, иначе far.
    -> (правило {neg, exp, pos} в релизах от планового или None — «в релизе не считаем», статус найден, таблица)."""
    ro = cfg["release_offsets"]
    tab = "near" if (planned - today).days < ro.get("near_days", 14) else "far"
    st = ro.get("same_as", {}).get(status, status)
    if st in ro[tab]:
        return ro[tab][st], True, tab
    return ro["default"], False, tab


def pool_releases(cfg, tracker):
    """Релизы для выбора в панели: будущие версии трекера и релизы с фичами конфига; эпики релиза без оценки."""
    keys = {f["key"] for f in cfg["features"]}
    by, nores = {}, []
    for f in cfg["features"]:
        jx = tracker_of(f, tracker)
        if jx["planned"] is None:
            nores.append(f["key"])
            continue
        b = by.setdefault(jx["planned"], {"keys": [], "num": 0})
        b["keys"].append(f["key"])
        b["num"] += 1 if f.get("components") else 0
    un = {}
    for e in tracker["epics"].values():
        if e.get("type") != "Epic" or e["key"] in keys or e.get("status") in tracker["cancelled"]:
            continue
        vs = sorted(x for x in (tracker_ver_date(v, tracker["product"]) for v in e.get("versions") or []) if x)
        if vs:
            un.setdefault(vs[0], []).append({"key": e["key"], "summary": e.get("summary", ""), "status": e.get("status", "")})
    out = []
    for x in sorted({x for x in tracker["calendar"] if x >= tracker["today"]} | set(by)):
        b, u = by.get(x, {"keys": [], "num": 0}), un.get(x, [])
        if b["keys"] or u:
            out.append({"release": x.isoformat(), "estimated": len(b["keys"]), "with_number": b["num"],
                        "keys": b["keys"], "unestimated": u})
    return {"releases": out, "no_release": nores, "tracker_at": tracker["at"], "tracker_today": tracker["today"].isoformat(),
            "features": len(cfg["features"])}


def in_release(jx, release):
    """Фича попадает в выбранный релиз: None или all — все, none — без релиза, ГГГГ-ММ-ДД — плановый релиз в трекере."""
    if release in (None, "all"):
        return True
    if release == "none":
        return jx["planned"] is None
    return jx["planned"] is not None and jx["planned"].isoformat() == release


# ---------- оформление ----------
STYLE = True  # в режиме explain оформление ячеек не нужно: оно занимает ~2/3 времени расчёта


def style_header(ws, row, ncols):
    if not STYLE:
        return
    for c in range(1, ncols + 1):
        cell = ws.cell(row=row, column=c)
        cell.font = Font(bold=True)
        cell.fill = HEAD_FILL
        cell.border = BORDER
        cell.alignment = Alignment(wrap_text=True, vertical="center", horizontal="center")


def set_widths(ws, widths):
    for i, w in enumerate(widths, start=1):
        ws.column_dimensions[get_column_letter(i)].width = w


def box(ws, row, ncols, fill=None):
    if not STYLE:
        return
    for c in range(1, ncols + 1):
        cell = ws.cell(row=row, column=c)
        cell.border = BORDER
        cell.alignment = Alignment(wrap_text=True, vertical="top")
        if fill:
            cell.fill = fill


def fmt_money(v):
    if v is None:
        return "—"
    r = round(v / 1000)
    if r == 0 and abs(v) >= 1:
        return ("%.1f" % (v / 1000)).replace(".", ",")
    return "{:,}".format(int(r)).replace(",", " ").replace("-", "−")


def plus(cells, prefix=""):
    return "+".join(prefix + c for c in cells) if cells else "0"


def new_acc():
    return {"cells": {g: {s: [] for s in SC} for g in ("month", "cy", "ny")},
            "vals": {g: {s: 0.0 for s in SC} for g in ("month", "cy", "ny")},
            "late_cells": {"cy": [], "ny": []}, "late_vals": {"cy": 0.0, "ny": 0.0}}


def add_acc(acc, g, s, cell, val):
    acc["cells"][g][s].append(cell)
    acc["vals"][g][s] += val


def main(cfg_path, out_dir=None, overrides=None, explain=False, release=None):
    """explain=True: файлы не сохраняются, возвращается dump с шагами расчёта (_explain, _meta).
    release: для конфига со всеми фичами — фильтр по релизу в трекере (ГГГГ-ММ-ДД, all, none)."""
    global STYLE
    STYLE = not explain
    cfg_path = Path(cfg_path).resolve()
    cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
    setup_lines(cfg)
    k_cfg, _ = spend_share(cfg)  # k до правок панели
    if overrides:
        apply_overrides(cfg, overrides)
    save = not explain
    exp_feats = []
    root = find_root(cfg_path)
    rel = cfg["release"]
    y_end = d(rel["year_end"])
    cy, ny = y_end.year, y_end.year + 1
    ny_from, ny_to = date(ny, 1, 1), date(ny, 12, 31)
    dates = {k: d(v) for k, v in rel.get("dates", {}).items()}
    ramps = cfg["ramps"]
    rules = cfg.get("release_rules", {})
    k_val, k_src = spend_share(cfg)
    chk = Checks()

    # конфиг со всеми фичами: статус и релиз — из трекера, считаем только фичи выбранного релиза
    tracker = load_tracker(cfg, root)
    jx_of = {}
    features = cfg["features"]
    if tracker:
        all_inputs = {f["key"]: [i["id"] for i in f.get("inputs", [])] for f in cfg["features"]}
        jx_of = {f["key"]: tracker_of(f, tracker) for f in cfg["features"]}
        features = [f for f in cfg["features"] if in_release(jx_of[f["key"]], release)]
        chk.info.append(("Трекер на %s" % (tracker["at"] or tracker["today"].isoformat()).replace("T", " "),
                         "Статус и релиз фичи — из трекера. Правила срока по дням до релиза фичи: меньше %d — таблица "
                         "«менее чем за 2 недели», иначе «за 2 недели и раньше» (раздел 7)" % cfg["release_offsets"].get("near_days", 14)))
    elif release not in (None, "all"):
        raise ValueError("фильтр по релизу работает только в конфиге со всеми фичами (поле tracker)")

    if rel.get("assessed") and not tracker:
        planned = d(rel["planned"]) if rel.get("planned") else min(dates.values())
        days_left = (planned - d(rel["assessed"])).days
        chk.info.append(("релиз %s" % planned.strftime("%d.%m.%Y"),
                         "До релиза %d дн.: правила срока — таблица для оценки %s (раздел 7)" % (
                             days_left, "менее чем за 2 недели" if days_left < 14 else "за 2 недели и раньше")))

    wb = Workbook()
    ws_sum = wb.active
    ws_sum.title = "Итог"
    ws_calc = wb.create_sheet("Расчёт")
    ws_line = wb.create_sheet("По строкам")
    ws_chk = wb.create_sheet("Проверки")
    ws_meas = wb.create_sheet("Замеры релиза")
    ws_sp = wb.create_sheet("Вилки фич")
    ws_ice = wb.create_sheet("ICE")

    # ---------- Расчёт ----------
    calc_cols = ["Фича", "Вход или результат", "Ед.", "Негативный", "Ожидаемый", "Позитивный", "Уровень", "Источник и логика"]
    ws_calc.append(calc_cols)
    style_header(ws_calc, 1, len(calc_cols))
    set_widths(ws_calc, [30, 46, 9, 14, 14, 14, 9, 92])
    ws_calc.freeze_panes = "C2"
    col_of = {"neg": "D", "exp": "E", "pos": "F"}

    results = []
    lines = {}
    money_cells = {g: {s: {m: [] for m in MONEY_RU} for s in SC} for g in ("month", "cy", "ny")}
    money_vals = {g: {s: {m: 0.0 for m in MONEY_RU} for s in SC} for g in ("month", "cy", "ny")}
    money_late = {g: {m: [] for m in MONEY_RU} for g in ("cy", "ny")}
    money_late_v = {g: {m: 0.0 for m in MONEY_RU} for g in ("cy", "ny")}
    groups = {}
    line_dev = {}  # строка выручки -> [сумма квадратов сдвигов вниз, вверх] по входам всех фич (в месяц)

    row = 2
    for fi, f in enumerate(features):
        key = f["key"]
        inputs = f.get("inputs", [])
        ids = [i["id"] for i in inputs]
        by_id = {i["id"]: i for i in inputs}
        comps = f.get("components", [])
        # срок релиза: эффект всех сценариев — при ожидаемом сроке, поздний срок — отдельно
        jx = jx_of.get(key)
        skip = None
        rd = None
        if jx:
            f["status"] = jx["status"]
            if not jx["found"]:
                if tracker["source"]: chk.hit(C_TRACKER, key, "статус «%s», релиз %s" % (jx["status"], jx["planned"] or "нет"))
            if "release_override" in f:
                ro_ = f["release_override"]
                rd = {s: dates[ro_[s]] if ro_[s] in dates else d(ro_[s]) for s in SC}
            elif jx["planned"] is None:
                chk.hit(C_NOREL, key)
                skip = "Нет релиза в трекере"
            else:
                rule, known, _tab = offsets_rule(cfg, jx["status"], jx["planned"], tracker["today"])
                if not known:
                    chk.hit(C_STATUS, key, "статус «%s», взято правило default" % jx["status"])
                if rule is None:
                    skip = "Статус «%s»: в релизе не считаем (раздел 7)" % jx["status"]
                else:
                    rd = {s: shift_release(tracker, jx["planned"], rule[s]) for s in SC}
        else:
            if "release_override" in f:
                rule = f["release_override"]
            elif f["status"] in rules:
                rule = rules[f["status"]]
            else:
                rule = rules["default"]
                chk.hit(C_STATUS, key, "статус «%s», взято правило default" % f["status"])
            rd = {s: dates[rule[s]] for s in SC if rule.get(s) in dates}
        if skip:
            comps = []
            f["main_assumption"] = skip + ". " + f.get("main_assumption", "")
        head_row = row
        ws_calc.cell(row=row, column=1, value="%s · %s" % (f["name"], key)).font = Font(bold=True)
        box(ws_calc, row, len(calc_cols), FEAT_FILL)
        row += 1

        refs = {s: {} for s in SC}
        vals = {s: {} for s in SC}
        for inp in inputs:
            ws_calc.cell(row=row, column=2, value=inp["name"])
            ws_calc.cell(row=row, column=3, value=inp.get("unit", ""))
            for s in SC:
                v = inp[s] if s in inp else inp["value"]
                cell = ws_calc.cell(row=row, column=4 + SC.index(s), value=v)
                cell.number_format = NUM2 if isinstance(v, float) and abs(v) < 10 else NUM
                if inp.get("percent"):
                    cell.number_format = PCT
                refs[s][inp["id"]] = "%s%d" % (col_of[s], row)
                vals[s][inp["id"]] = v
            ws_calc.cell(row=row, column=7, value=inp.get("level", ""))
            note = inp.get("source", "")
            if "analog" in inp:
                av = inp["analog"]["value"] if isinstance(inp["analog"], dict) else inp["analog"]
                note += " · Аналог: %s" % av
            if inp.get("deviation"):
                note += " · Отступление: " + inp["deviation"]
            ws_calc.cell(row=row, column=8, value=note)
            box(ws_calc, row, len(calc_cols))
            where = "%s · %s" % (key, inp["name"])
            if not str(inp.get("source", "")).strip():
                chk.hit(C_SRC, where)
            if inp.get("level") not in LEVELS:
                chk.hit(C_LVL, where)
            if "analog" in inp:
                av = inp["analog"]["value"] if isinstance(inp["analog"], dict) else inp["analog"]
                ev_ = inp.get("exp", inp.get("value"))
                if abs(ev_ - av) > max(1e-9, abs(av) * 0.01):
                    chk.hit(C_ANALOG, where, "ожидаемый %s, аналог %s" % (ev_, av), inp.get("deviation"))
            row += 1

        d_exp, d_late = (rd["exp"], rd["neg"]) if rd else (None, None)
        fx = {"key": key, "name": f["name"], "type": f.get("type", ""), "category": f.get("category", ""),
              "status": f["status"], "main_assumption": f.get("main_assumption", ""),
              "breakeven": f.get("breakeven"), "measure": f.get("measure"),
              "prev_estimate": f.get("prev_estimate"), "prev_reason": f.get("prev_reason"),
              "release": {s: v.isoformat() for s, v in (rd or {}).items()},
              "tracker": ({"found": jx["found"], "planned": jx["planned"].isoformat() if jx["planned"] else None,
                        "versions": jx["versions"], "summary": jx["summary"]} if jx else None),
              "skip": skip,
              "inputs": [{"id": i["id"], "name": i["name"], "unit": i.get("unit", ""), "level": i.get("level", ""),
                          "source": i.get("source", ""), "deviation": i.get("deviation"),
                          "analog": (i["analog"]["value"] if isinstance(i["analog"], dict) else i["analog"]) if "analog" in i else None,
                          "values": {s: vals[s][i["id"]] for s in SC},
                          "varied": any(s in i for s in SC)} for i in inputs],
              "components": []}

        acc = new_acc()
        parts = {}
        used = []
        first_money = None
        mechs = []
        for comp in comps:
            prof = ramps[comp.get("ramp", "instant")]
            top = plateau(prof)
            if not (0 < top <= 1):
                chk.hit(C_RAMP, "%s · %s" % (key, comp["name"]), "плато %s" % top)
                top = top if top > 0 else 1.0
            refd = ids_in(comp["formula"], ids)
            used += [i for i in refd if i not in used]
            varied = [i for i in refd if any(s in by_id[i] for s in SC)]
            line = comp.get("line") or f.get("line") or f.get("category", "")
            money = money_of(comp, line)
            mech = comp.get("mechanic") or f.get("mechanic", "")
            if mech and mech not in mechs:
                mechs.append(mech)
            part = comp.get("part", comp["name"])
            group = comp.get("group")
            if group:
                groups.setdefault(group, [])
                if fi not in groups[group]:
                    groups[group].append(fi)
            lag = comp.get("lag_days", 0)
            window = comp.get("window_days")
            cap = comp.get("months_ny_cap")
            cwhere = "%s · %s" % (key, comp["name"])

            def start_of(base_date):
                st = base_date + timedelta(days=lag)
                if comp.get("start_date"):
                    st = max(st, d(comp["start_date"]))
                return st

            def months(st, decay):
                end_cy, end_ny = y_end, ny_to
                if window:
                    w_end = st + timedelta(days=window - 1)
                    end_cy, end_ny = min(y_end, w_end), min(ny_to, w_end)
                m_cy = effect_months(st, prof, st, end_cy, decay) if st <= end_cy else 0.0
                f_ny = max(ny_from, st)
                m_ny = effect_months(st, prof, f_ny, end_ny, decay) if f_ny <= end_ny else 0.0
                if cap is not None:
                    m_ny = min(m_ny, cap)
                return round(m_cy, 2), round(m_ny, 2)

            def decay_of(s):
                dv = comp.get("decay", 0)
                return vals[s][dv] if isinstance(dv, str) else dv

            st_exp, st_late = start_of(d_exp), start_of(d_late)
            first_money = st_exp if first_money is None else min(first_money, st_exp)

            r0 = row
            labels = [
                ("%s: в месяц на полном разгоне" % comp["name"], CUR),
                ("%s: месяцев эффекта до конца %d" % (comp["name"], cy), "мес."),
                ("%s: месяцев эффекта в %d" % (comp["name"], ny), "мес."),
                ("%s: за %d" % (comp["name"], cy), CUR),
                ("%s: за %d" % (comp["name"], ny), CUR),
                ("%s: за %d при позднем сроке" % (comp["name"], cy), CUR),
                ("%s: за %d при позднем сроке" % (comp["name"], ny), CUR),
            ]
            for i, (lab, unit) in enumerate(labels):
                ws_calc.cell(row=r0 + i, column=2, value=lab)
                ws_calc.cell(row=r0 + i, column=3, value=unit)
            mv = {}
            cvals = {"cy": {}, "ny": {}, "months": {}}
            for s in SC:
                col = col_of[s]
                raw = py_eval(comp["formula"], vals[s])
                mv[s] = raw * top
                m_cy, m_ny = months(st_exp, decay_of(s))
                cvals["cy"][s], cvals["ny"][s], cvals["months"][s] = mv[s] * m_cy, mv[s] * m_ny, {"cy": m_cy, "ny": m_ny}
                expr = to_excel(comp["formula"], refs[s])
                ws_calc["%s%d" % (col, r0)] = "=" + expr if top == 1 else "=(%s)*%s" % (expr, round(top, 4))
                ws_calc["%s%d" % (col, r0 + 1)] = m_cy
                ws_calc["%s%d" % (col, r0 + 2)] = m_ny
                ws_calc["%s%d" % (col, r0 + 3)] = "=%s%d*%s%d" % (col, r0, col, r0 + 1)
                ws_calc["%s%d" % (col, r0 + 4)] = "=%s%d*%s%d" % (col, r0, col, r0 + 2)
                for rr, fmt in ((r0, NUM), (r0 + 1, NUM2), (r0 + 2, NUM2), (r0 + 3, NUM), (r0 + 4, NUM)):
                    ws_calc["%s%d" % (col, rr)].number_format = fmt
                cells = {"month": "%s%d" % (col, r0), "cy": "%s%d" % (col, r0 + 3), "ny": "%s%d" % (col, r0 + 4)}
                v_month = round(mv[s], 6)
                v_cy, v_ny = mv[s] * m_cy, mv[s] * m_ny
                pacc = parts.setdefault(part, {"acc": new_acc(), "lines": []})
                if line not in pacc["lines"]:
                    pacc["lines"].append(line)
                for target in (acc, pacc["acc"]):
                    if not window:
                        add_acc(target, "month", s, cells["month"], v_month)
                    add_acc(target, "cy", s, cells["cy"], v_cy)
                    add_acc(target, "ny", s, cells["ny"], v_ny)
                if not window:
                    money_cells["month"][s][money].append("'Расчёт'!" + cells["month"])
                    money_vals["month"][s][money] += v_month
                    ln = lines.setdefault(line, {"money": [], "cells": {x: [] for x in SC}, "vals": {x: 0.0 for x in SC}})
                    if money not in ln["money"]:
                        ln["money"].append(money)
                    ln["cells"][s].append("'Расчёт'!" + cells["month"])
                    ln["vals"][s] += v_month
                for g, v in (("cy", v_cy), ("ny", v_ny)):
                    money_cells[g][s][money].append("'Расчёт'!" + cells[g])
                    money_vals[g][s][money] += v
            # поздний срок: ожидаемый эффект при сроке из колонки «негатив»
            ml_cy, ml_ny = months(st_late, decay_of("exp"))
            for i, (g, mm) in enumerate((("cy", ml_cy), ("ny", ml_ny))):
                rr = r0 + 5 + i
                ws_calc["E%d" % rr] = "=E%d*%s" % (r0, mm)
                ws_calc["E%d" % rr].number_format = NUM
                v = mv["exp"] * mm
                for target in (acc, parts[part]["acc"]):
                    target["late_cells"][g].append("E%d" % rr)
                    target["late_vals"][g] += v
                money_late[g][money].append("'Расчёт'!E%d" % rr)
                money_late_v[g][money] += v
            # шаги расчёта для панели: каждый шаг — формула от входов и прошлых шагов; в xlsx не идут
            steps_out = None
            if comp.get("steps"):
                steps_out, sv = [], {x: {} for x in SC}
                for stp in comp["steps"]:
                    v = {}
                    for s in SC:
                        try:
                            v[s] = py_eval(stp["formula"], {**vals[s], **sv[s]})
                        except Exception:  # noqa: BLE001 — ошибку шага панель покажет как «не сходится»
                            v[s] = None
                        sv[s][stp["id"]] = v[s] if v[s] is not None else float("nan")
                    steps_out.append({"id": stp["id"], "name": stp["name"], "group": stp.get("group"), "formula": stp["formula"],
                                      "unit": stp.get("unit", ""), "values": v})
            # проверка шагов: есть у каждого компонента и сходятся с формулой
            if not steps_out:
                chk.hit(C_STEPS, cwhere, "шагов нет")
            else:
                clash = [x["id"] for x in steps_out if x["id"] in ids]
                off = [s for s in SC if steps_out[-1]["values"][s] is None
                       or abs(steps_out[-1]["values"][s] - mv[s] / top) > max(1.0, abs(mv[s] / top) * 0.005)]
                if clash or off:
                    chk.hit(C_STEPS, cwhere, "; ".join(
                        (["id шага совпадает с входом: " + ", ".join(clash)] if clash else [])
                        + (["последний шаг не равен формуле: " + ", ".join(off)] if off else [])))
            fx["components"].append({
                "steps": steps_out,
                "name": comp["name"], "part": part, "line": line, "money": money, "mechanic": mech, "group": group,
                "formula": comp["formula"], "formula_text": comp.get("formula_text", comp["formula"]),
                "ramp": comp.get("ramp", "instant"), "ramp_text": comp.get("ramp_text", ""), "plateau": top,
                "lag_days": lag, "window_days": window, "decay": comp.get("decay", 0), "deviation": comp.get("deviation"),
                "start": st_exp.isoformat(), "start_late": st_late.isoformat(), "inputs": refd, "varied": varied,
                "month": {s: (0.0 if window else mv[s]) for s in SC}, "month_raw": mv,
                "cy": cvals["cy"], "ny": cvals["ny"], "months": cvals["months"],
                "late": {"cy": mv["exp"] * ml_cy, "ny": mv["exp"] * ml_ny}, "months_late": {"cy": ml_cy, "ny": ml_ny}})

            note = "Формула: " + comp.get("formula_text", comp["formula"])
            note += ". Строка: %s; деньги: %s; механика: %s" % (line, MONEY_RU.get(money, money), mech or "—")
            if group:
                note += "; группа: " + group
            if window:
                note += ". Разовый эффект: %d дн. от старта, в «месяц на полном разгоне» не входит" % window
            if top != 1:
                note += ". Плато кривой %s: месяц = формула × плато" % str(round(top, 4)).replace(".", ",")
            if comp.get("deviation"):
                note += ". Отступление: " + comp["deviation"]
            ws_calc.cell(row=r0, column=8, value=note)
            start_txt = (", не раньше %s" % d(comp["start_date"]).strftime("%d.%m.%Y")) if comp.get("start_date") else ""
            dec = comp.get("decay", 0)
            ws_calc.cell(row=r0 + 1, column=8, value="Старт денег: ожидаемый срок %s%s%s; разгон: %s%s" % (
                d_exp.strftime("%d.%m.%Y"), (" + %d дн." % lag) if lag else "", start_txt,
                comp.get("ramp_text", comp.get("ramp", "instant")),
                ("; затухание в месяц: %s" % dec) if dec else ""))
            ws_calc.cell(row=r0 + 5, column=8, value="Поздний срок: %s%s; месяцев эффекта: %s / %s" % (
                d_late.strftime("%d.%m.%Y"), (" + %d дн." % lag) if lag else "",
                str(ml_cy).replace(".", ","), str(ml_ny).replace(".", ",")))
            for i in range(7):
                box(ws_calc, r0 + i, len(calc_cols), RES_FILL if i in (0, 3, 4) else None)
            row += 7

            # проверки компонента
            if not line_ok(line):
                chk.hit(C_LINE, cwhere, "строка «%s»" % line)
            if mech not in MECHANICS:
                chk.hit(C_MECH, cwhere)
            if len(varied) > 2:
                chk.hit(C_MAIN, cwhere, "меняются: " + ", ".join(by_id[i]["name"] for i in varied), comp.get("deviation"))
            # слабый аналог (У3 с полем analog) идёт по строке «аналог» раздела 5, не по правилу нуля
            weak_varied = [i for i in varied if by_id[i].get("level") in WEAK and "analog" not in by_id[i]]
            if not window and mv["exp"] > 0.5 and weak_varied and mv["neg"] > 0.5:
                reason = comp.get("deviation") or next((by_id[i]["deviation"] for i in weak_varied if by_id[i].get("deviation")), None)
                chk.hit(C_SCEN, cwhere, "негатив %s при ожидаемом %s" % (fmt_money(mv["neg"]), fmt_money(mv["exp"])), reason)
            if mech in COST_MECH and not f.get("breakeven"):
                chk.hit(C_BE, cwhere)

        # рычаги: сдвиг «в месяц, ожидаемый» фичи, если один вход взять из негатива или позитива
        for ix in fx["inputs"]:
            if not ix["varied"]:
                continue
            ix["lever"] = {}
            for s in ("neg", "pos"):
                vv = dict(vals["exp"])
                vv[ix["id"]] = vals[s][ix["id"]]
                ix["lever"][s] = sum(py_eval(cx["formula"], vv) * cx["plateau"] - cx["month"]["exp"]
                                     for cx in fx["components"] if not cx["window_days"] and ix["id"] in cx["inputs"])
            ix["zero"] = zero_point(ix, fx["components"], vals["exp"], acc["vals"]["month"]["exp"])
        # главный вход — тот, что сильнее всего двигает «в месяц» фичи
        main_ix = None
        lever_w = lambda ix: abs(ix["lever"]["neg"]) + abs(ix["lever"]["pos"])  # noqa: E731
        cand = [ix for ix in fx["inputs"] if ix.get("lever") and ix["id"] in used]
        if comps and cand and lever_w(max(cand, key=lever_w)) > 0.5:
            main_ix = max(cand, key=lever_w)

        # вилка фичи: входы независимы — негатив и позитив =
        # ожидаемый ∓ корень из суммы квадратов сдвигов: каждый вход отдельно из негатива или позитива, остальные ожидаемые
        var_ids = [ix["id"] for ix in fx["inputs"] if ix["varied"] and ix["id"] in used]
        dl = {}
        for iid in var_ids:
            for s in ("neg", "pos"):
                vv = dict(vals["exp"])
                vv[iid] = vals[s][iid]
                dl[(iid, s)] = [(py_eval(cx["formula"], vv) * cx["plateau"] - cx["month_raw"]["exp"]) if iid in cx["inputs"] else 0.0
                                for cx in fx["components"]]

        def hs(vec, g, pick=None):
            """сдвиг на горизонте g: в месяц — без разовых частей, за год — × месяцев эффекта части"""
            t = 0.0
            for cx, dv in zip(fx["components"], vec):
                if pick and not pick(cx):
                    continue
                if g == "month":
                    t += 0.0 if cx["window_days"] else dv
                else:
                    t += dv * cx["months"]["exp"][g]
            return t

        def spread(pick=None):
            out = {}
            for g in ("month", "cy", "ny"):
                dn = up = 0.0
                for iid in var_ids:
                    a, b = hs(dl[(iid, "neg")], g, pick), hs(dl[(iid, "pos")], g, pick)
                    dn += min(0.0, a, b) ** 2
                    up += max(0.0, a, b) ** 2
                out[g] = (math.sqrt(dn), math.sqrt(up))
            return out

        sp = spread()
        for g in ("month", "cy", "ny"):
            e_ = acc["vals"][g]["exp"]
            acc["vals"][g]["neg"], acc["vals"][g]["pos"] = e_ - sp[g][0], e_ + sp[g][1]
        for p_, x_ in parts.items():
            x_["spread"] = spread(lambda cx, p_=p_: cx["part"] == p_)
            for g in ("month", "cy", "ny"):
                e_ = x_["acc"]["vals"][g]["exp"]
                x_["acc"]["vals"][g]["neg"], x_["acc"]["vals"][g]["pos"] = e_ - x_["spread"][g][0], e_ + x_["spread"][g][1]
        spread_rows, fin_in = [], []
        for iid in var_ids:
            row_ = {"name": by_id[iid]["name"], "level": by_id[iid].get("level", "")}
            for g in ("month", "cy", "ny"):
                a, b = hs(dl[(iid, "neg")], g), hs(dl[(iid, "pos")], g)
                row_[g] = (-min(0.0, a, b), max(0.0, a, b))
            spread_rows.append(row_)
            fin_in.append({g: {s: {m: hs(dl[(iid, s)], g, lambda cx, m=m: cx["money"] == m) for m in MONEY_RU} for s in ("neg", "pos")}
                           for g in ("month", "cy", "ny")})
            for ln_ in {cx["line"] for cx in fx["components"] if not cx["window_days"] and iid in cx["inputs"]}:
                a = hs(dl[(iid, "neg")], "month", lambda cx, ln_=ln_: cx["line"] == ln_)
                b = hs(dl[(iid, "pos")], "month", lambda cx, ln_=ln_: cx["line"] == ln_)
                ld = line_dev.setdefault(ln_, [0.0, 0.0])
                ld[0] += min(0.0, a, b) ** 2
                ld[1] += max(0.0, a, b) ** 2

        # уверенность и проверки фичи: уверенность — по уровню главного входа; входов с вилкой нет — по самому слабому
        weakest = None
        if comps:
            for i in used:
                inp = by_id[i]
                if not any(s in inp for s in SC) and inp.get("level") in WEAK:
                    chk.hit(C_FIXED, "%s · %s" % (key, inp["name"]), "уровень %s" % inp["level"], inp.get("deviation"))
            lv = [by_id[i].get("level") for i in used if by_id[i].get("level") in LEVELS]
            weakest = max(lv, key=LEVELS.index) if lv else None
            if main_ix:
                conf = CONF_BY_LEVEL.get(main_ix["level"], "—")
            else:
                conf = CONF_BY_LEVEL[weakest] if weakest else "—"
            if f.get("confidence") and f["confidence"] != conf:
                chk.hit(C_CONF, key, "в конфиге «%s», по правилу «%s»" % (f["confidence"], conf))
            m_exp = acc["vals"]["month"]["exp"]
            if abs(m_exp) > 0.5 and not f.get("measure"):
                chk.hit(C_MEASURE, key)
            pe = f.get("prev_estimate")
            if pe and pe.get("value") is not None:
                pv = pe["value"]
                big = (pv == 0 and abs(m_exp) > 0.5) or (pv != 0 and (m_exp / pv > 2 or m_exp / pv < 0.5))
                if big:
                    chk.hit(C_PREV, key, "было %s (%s), сейчас %s" % (fmt_money(pv), pe.get("date", ""), fmt_money(m_exp)), f.get("prev_reason"))
        else:
            conf = f.get("confidence", "—")
        ws_calc.cell(row=head_row, column=8, value="%s · %s · статус в трекере: %s · уверенность по правилу: %s%s" % (
            f.get("category", ""), f.get("type", ""), f["status"], conf,
            (" (главный вход: %s, %s)" % (main_ix["name"], main_ix["level"])) if main_ix else ""))
        fx.update({"main_input": main_ix["id"] if main_ix else None, "weakest_level": weakest})
        fx.update({"confidence": conf, "mechanics": mechs, "has": bool(comps),
                   "first_money": first_money.isoformat() if first_money else None,
                   "vals": acc["vals"], "late": acc["late_vals"],
                   "parts": {p: {"vals": x["acc"]["vals"], "lines": x["lines"]} for p, x in parts.items()}})
        exp_feats.append(fx)
        results.append({"f": f, "acc": acc, "parts": parts, "has": bool(comps), "conf": conf,
                        "mechs": mechs, "first_money": first_money, "spread": sp, "spread_rows": spread_rows, "fin_in": fin_in})
        row += 1

    # вилка строки: те же независимые входы, что у фич
    for ln_, (dn2, up2) in line_dev.items():
        if ln_ in lines:
            e_ = lines[ln_]["vals"]["exp"]
            lines[ln_]["vals"]["neg"], lines[ln_]["vals"]["pos"] = e_ - math.sqrt(dn2), e_ + math.sqrt(up2)

    # ---------- Вилки фич: сдвиги по входам и корень из суммы квадратов (формулы для листа «Итог») ----------
    sp_cols = ["Фича", "Вход с вилкой", "Уровень", "В месяц: вниз", "вверх", "До конца %d: вниз" % cy, "вверх",
               "За %d: вниз" % ny, "вверх"]
    ws_sp.append(sp_cols)
    style_header(ws_sp, 1, len(sp_cols))
    set_widths(ws_sp, [34, 52, 9, 12, 12, 13, 12, 12, 12])
    ws_sp.freeze_panes = "C2"
    rs = 2
    for res in results:
        res["spread_cells"] = None
        if not res["has"]:
            continue
        first_r = rs
        for row_ in res["spread_rows"]:
            ws_sp.cell(row=rs, column=1, value="%s · %s" % (res["f"]["name"], res["f"]["key"]))
            ws_sp.cell(row=rs, column=2, value=row_["name"])
            ws_sp.cell(row=rs, column=3, value=row_["level"])
            for gi, g in enumerate(("month", "cy", "ny")):
                for j in (0, 1):
                    ws_sp.cell(row=rs, column=4 + gi * 2 + j, value=round(row_[g][j], 2)).number_format = NUM
            box(ws_sp, rs, len(sp_cols))
            rs += 1
        ws_sp.cell(row=rs, column=1, value="%s · %s" % (res["f"]["name"], res["f"]["key"])).font = Font(bold=True)
        ws_sp.cell(row=rs, column=2, value="Итог фичи: корень из суммы квадратов" if res["spread_rows"] else "Входов с вилкой нет: негатив = позитив = ожидаемый")
        cells = {}
        for gi, g in enumerate(("month", "cy", "ny")):
            pair = []
            for j in (0, 1):
                col = get_column_letter(4 + gi * 2 + j)
                v_ = "=SQRT(SUMSQ(%s%d:%s%d))" % (col, first_r, col, rs - 1) if res["spread_rows"] else 0
                ws_sp.cell(row=rs, column=4 + gi * 2 + j, value=v_).number_format = NUM
                ws_sp.cell(row=rs, column=4 + gi * 2 + j).font = Font(bold=True)
                pair.append("'Вилки фич'!$%s$%d" % (col, rs))
            cells[g] = pair
        box(ws_sp, rs, len(sp_cols), RES_FILL)
        res["spread_cells"] = cells
        rs += 2

    # ---------- По строкам ----------
    line_cols =["Строка выручки", "Деньги", ("База в месяц, " + CUR + ""), "Эффект в месяц: негатив", "ожидаем", "позитив",
                 "Ожидаемый к базе", ("Наибольший рост за месяц, " + CUR + ""), "Обычное колебание", "Проверка"]
    ws_line.append(line_cols)
    style_header(ws_line, 1, len(line_cols))
    set_widths(ws_line, [26, 13, 13, 13, 12, 12, 11, 14, 11, 56])
    ws_line.freeze_panes = "B2"
    order = [x for x in KNOWN_LINES if x in lines] + [x for x in lines if x not in KNOWN_LINES]
    line_specs = cfg.get("lines", {})
    r = 2
    line_out = {}
    for ln_name in order:
        ln = lines[ln_name]
        ws_line.cell(row=r, column=1, value=ln_name)
        ws_line.cell(row=r, column=2, value=", ".join(MONEY_RU.get(m, m) for m in ln["money"]))
        base = max_g = noise = None
        if ln_name in line_specs:
            base, max_g, noise = line_stats(line_specs[ln_name])
        ws_line.cell(row=r, column=3, value=round(base) if base else "—").number_format = NUM
        for si, s in enumerate(SC):
            if s != "exp" and ln_name in line_dev:  # негатив и позитив строки — по независимым входам, числом
                c = ws_line.cell(row=r, column=4 + si, value=round(ln["vals"][s], 2))
            else:
                c = ws_line.cell(row=r, column=4 + si, value="=" + plus(ln["cells"][s]))
            c.number_format = NUM
        ws_line.cell(row=r, column=7, value='=IF(ISNUMBER(C%d),E%d/C%d,"")' % (r, r, r)).number_format = PCT
        ws_line.cell(row=r, column=8, value=round(max_g) if max_g is not None else "—").number_format = NUM
        ws_line.cell(row=r, column=9, value=noise if noise is not None else "—").number_format = PCT
        e = ln["vals"]["exp"]
        notes = []
        if max_g is not None and max_g > 0 and e > max_g:
            notes.append("Больше наибольшего роста за месяц: пересмотреть пересечения")
            chk.hit(C_GROW, ln_name, "ожидаемый %s при наибольшем росте %s" % (fmt_money(e), fmt_money(max_g)))
        if noise is not None and base and abs(e) < noise * base:
            notes.append("Меньше обычного колебания: без A/B не измерить")
            chk.hit(C_NOISE, ln_name, "ожидаемый %s при колебании %s" % (fmt_money(e), fmt_money(noise * base)))
        if base is None:
            notes.append("Нет базы в lines: проверки роста и колебания не выполнены")
        ws_line.cell(row=r, column=10, value="; ".join(notes) if notes else "ок")
        box(ws_line, r, len(line_cols), HIT_FILL if notes and base is not None else None)
        line_out[ln_name] = {"vals": ln["vals"], "base": base, "max_growth": max_g, "noise": noise}
        r += 1
    k_row = r + 1
    ws_line.cell(row=k_row, column=1, value="k: доля трат с баланса, которая попадает в итог выручки").font = Font(bold=True)
    if k_val is None:
        chk.hit(C_K, "конфиг", "взято k = 1")
        ws_line.cell(row=k_row, column=3, value=1.0)
        ws_line.cell(row=k_row, column=10, value="Не задан: взято 1. Задать fin_total.spend_share или lines")
    else:
        ws_line.cell(row=k_row, column=3, value=round(k_val, 4))
        ws_line.cell(row=k_row, column=10, value=k_src)
    ws_line.cell(row=k_row, column=3).number_format = PCT
    box(ws_line, k_row, len(line_cols), RES_FILL)
    k_ref = "'По строкам'!$C$%d" % k_row
    k_num = round(k_val, 4) if k_val is not None else 1.0  # как в ячейке, чтобы xlsx и md совпали до единицы

    # ---------- Итог ----------
    G_COLS = {"month": (6, 7, 8), "cy": (9, 10, 11), "ny": (13, 14, 15)}
    LATE_COLS = {"cy": 12, "ny": 16}
    NC = 18
    head1 = ["Фича", "Строка выручки", "Тип", "Механика", "Статус в трекере", ("В месяц на полном разгоне, " + CUR + ""), "", "",
             ("До конца %d, " + CUR + "") % cy, "", "", "", ("За %d, " + CUR + "") % ny, "", "", "", "Уверен-ность", "Главное допущение"]
    head2 = ["", "", "", "", "", "негатив", "ожидаем", "позитив", "негатив", "ожидаем", "позитив", "поздний срок",
             "негатив", "ожидаем", "позитив", "поздний срок", "", ""]
    ws_sum.append(head1)
    ws_sum.append(head2)
    for a, b in (("F1", "H1"), ("I1", "L1"), ("M1", "P1")):
        ws_sum.merge_cells("%s:%s" % (a, b))
    for c in (1, 2, 3, 4, 5, 17, 18):
        ws_sum.merge_cells(start_row=1, start_column=c, end_row=2, end_column=c)
    style_header(ws_sum, 1, NC)
    style_header(ws_sum, 2, NC)
    set_widths(ws_sum, [34, 15, 5, 12, 13, 10, 10, 10, 10, 10, 10, 10, 11, 11, 11, 11, 9, 48])
    ws_sum.freeze_panes = "B3"

    def write_acc(rr, acc, sp_cells=None, sp_vals=None):
        """ожидаемый — сумма частей из «Расчёта»; негатив и позитив — ожидаемый ∓ вилка по независимым входам:
        ссылка на лист «Вилки фич» (фича) или число (часть фичи)"""
        for g, cols in G_COLS.items():
            e_ref = "%s%d" % (get_column_letter(cols[1]), rr)
            for s, c in zip(SC, cols):
                if s == "exp" or (sp_cells is None and sp_vals is None):
                    v_ = "=" + plus(acc["cells"][g][s], "'Расчёт'!")
                elif sp_cells is not None:
                    v_ = "=%s%s%s" % (e_ref, "-" if s == "neg" else "+", sp_cells[g][0 if s == "neg" else 1])
                else:
                    v_ = "=%s%s%s" % (e_ref, "-" if s == "neg" else "+", round(sp_vals[g][0 if s == "neg" else 1], 2))
                cell = ws_sum.cell(row=rr, column=c, value=v_)
                cell.number_format = NUM
        for g, c in LATE_COLS.items():
            cell = ws_sum.cell(row=rr, column=c, value="=" + plus(acc["late_cells"][g], "'Расчёт'!"))
            cell.number_format = NUM

    r = 3
    feat_rows = []
    for res in results:
        f = res["f"]
        res["row"] = r
        feat_rows.append(r)
        ws_sum.cell(row=r, column=1, value="%s\n%s" % (f["name"], f["key"]))
        ws_sum.cell(row=r, column=2, value=f.get("category", ""))
        ws_sum.cell(row=r, column=3, value=f.get("type", ""))
        ws_sum.cell(row=r, column=4, value=", ".join(res["mechs"]))
        ws_sum.cell(row=r, column=5, value=f["status"])
        if res["has"]:
            write_acc(r, res["acc"], sp_cells=res["spread_cells"])
        else:
            for c in list(sum(G_COLS.values(), ())) + list(LATE_COLS.values()):
                ws_sum.cell(row=r, column=c, value=0).number_format = NUM
        ws_sum.cell(row=r, column=17, value=res["conf"])
        ws_sum.cell(row=r, column=18, value=f.get("main_assumption", ""))
        box(ws_sum, r, NC)
        r += 1
        # части с разными знаками — отдельными строками (раздел 6)
        pv = [(p, (x["acc"]["vals"]["month"]["exp"] or x["acc"]["vals"]["ny"]["exp"])) for p, x in res["parts"].items()]
        if len(pv) >= 2 and any(v > 0.5 for _, v in pv) and any(v < -0.5 for _, v in pv):
            res["part_rows"] = []
            for p, x in res["parts"].items():
                ws_sum.cell(row=r, column=1, value="   · " + p).font = Font(italic=True, color="555555")
                ws_sum.cell(row=r, column=2, value=", ".join(x["lines"]))
                write_acc(r, x["acc"], sp_vals=x["spread"])
                box(ws_sum, r, NC)
                for c in range(6, 17):
                    ws_sum.cell(row=r, column=c).font = Font(italic=True, color="555555")
                res["part_rows"].append((p, x))
                r += 1

    def col_l(c):
        return get_column_letter(c)

    # итого: простая сумма
    r_sum = r
    ws_sum.cell(row=r_sum, column=1, value="Итого, простая сумма").font = Font(bold=True)
    for c in list(sum(G_COLS.values(), ())) + list(LATE_COLS.values()):
        cell = ws_sum.cell(row=r_sum, column=c, value="=" + plus(["%s%d" % (col_l(c), x) for x in feat_rows]))
        cell.number_format = NUM
        cell.font = Font(bold=True)
    box(ws_sum, r_sum, NC, HEAD_FILL)
    ws_sum.cell(row=r_sum, column=18, value="Сумма крайних сценариев фич — не сценарий релиза")

    # вилка релиза: фичи из одной группы пересечений — одна единица
    parent = list(range(len(results)))

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x
    for g, fis in groups.items():
        for a in fis[1:]:
            parent[find(a)] = find(fis[0])
    units = {}
    for i, res in enumerate(results):
        if res["has"]:
            units.setdefault(find(i), []).append(i)
    r_rss = r_sum + 1
    ws_sum.cell(row=r_rss, column=1, value="Вилка релиза: фичи независимы").font = Font(bold=True)
    rss_vals = {}
    for g, (cn, ce, cp) in G_COLS.items():
        ln_, le_, lp_ = col_l(cn), col_l(ce), col_l(cp)
        down, up = [], []
        dv, uv = 0.0, 0.0
        for members in units.values():
            rows_ = [results[i]["row"] for i in members]
            e_ = "(%s)" % "+".join("%s%d" % (le_, x) for x in rows_)
            n_ = "(%s)" % "+".join("%s%d" % (ln_, x) for x in rows_)
            p_ = "(%s)" % "+".join("%s%d" % (lp_, x) for x in rows_)
            down.append("MAX(0,%s-%s)^2" % (e_, n_))
            up.append("MAX(0,%s-%s)^2" % (p_, e_))
            ev = sum(results[i]["acc"]["vals"][g]["exp"] for i in members)
            nv = sum(results[i]["acc"]["vals"][g]["neg"] for i in members)
            pv_ = sum(results[i]["acc"]["vals"][g]["pos"] for i in members)
            dv += max(0.0, ev - nv) ** 2
            uv += max(0.0, pv_ - ev) ** 2
        tot_e = "%s%d" % (le_, r_sum)
        ws_sum.cell(row=r_rss, column=cn, value="=%s-SQRT(%s)" % (tot_e, "+".join(down) or "0"))
        ws_sum.cell(row=r_rss, column=ce, value="=%s" % tot_e)
        ws_sum.cell(row=r_rss, column=cp, value="=%s+SQRT(%s)" % (tot_e, "+".join(up) or "0"))
        te = sum(res["acc"]["vals"][g]["exp"] for res in results if res["has"])
        rss_vals[g] = {"neg": te - math.sqrt(dv), "exp": te, "pos": te + math.sqrt(uv)}
        for c in (cn, ce, cp):
            ws_sum.cell(row=r_rss, column=c).number_format = NUM
            ws_sum.cell(row=r_rss, column=c).font = Font(bold=True)
    box(ws_sum, r_rss, NC, HEAD_FILL)
    merged = [", ".join(results[i]["f"]["key"] for i in m) for m in units.values() if len(m) > 1]
    ws_sum.cell(row=r_rss, column=18, value="Ожидаемый ± корень из суммы квадратов отклонений фич" + (
        ". Одной единицей: " + "; ".join(merged) if merged else ""))

    # итог выручки
    r_fin = r_rss + 1
    ws_sum.cell(row=r_fin, column=1, value="Итог выручки: траты × k + пополнения + прямые").font = Font(bold=True)
    fin_vals = {}
    # негатив и позитив итога выручки: сумма по фичам вилок в деньгах отчёта о выручке (траты × k), входы независимы
    fin_dev = {g: [0.0, 0.0] for g in G_COLS}
    for res in results:
        for g in G_COLS:
            dn = up = 0.0
            for item in res.get("fin_in") or []:
                a = k_num * item[g]["neg"]["spend"] + item[g]["neg"]["topup"] + item[g]["neg"]["direct"]
                b = k_num * item[g]["pos"]["spend"] + item[g]["pos"]["topup"] + item[g]["pos"]["direct"]
                dn += min(0.0, a, b) ** 2
                up += max(0.0, a, b) ** 2
            fin_dev[g][0] += math.sqrt(dn)
            fin_dev[g][1] += math.sqrt(up)
    for g, cols in G_COLS.items():
        fin_vals[g] = {}
        mc = money_cells[g]["exp"]
        e_ref = "%s%d" % (get_column_letter(cols[1]), r_fin)
        ws_sum.cell(row=r_fin, column=cols[1], value="=%s*(%s)+(%s)+(%s)" % (
            k_ref, plus(mc["spend"]), plus(mc["topup"]), plus(mc["direct"]))).number_format = NUM
        mvv = money_vals[g]["exp"]
        fin_vals[g]["exp"] = k_num * mvv["spend"] + mvv["topup"] + mvv["direct"]
        fin_vals[g]["neg"] = fin_vals[g]["exp"] - round(fin_dev[g][0], 2)
        fin_vals[g]["pos"] = fin_vals[g]["exp"] + round(fin_dev[g][1], 2)
        ws_sum.cell(row=r_fin, column=cols[0], value="=%s-%s" % (e_ref, round(fin_dev[g][0], 2))).number_format = NUM
        ws_sum.cell(row=r_fin, column=cols[2], value="=%s+%s" % (e_ref, round(fin_dev[g][1], 2))).number_format = NUM
    for g, c in LATE_COLS.items():
        mc = money_late[g]
        ws_sum.cell(row=r_fin, column=c, value="=%s*(%s)+(%s)+(%s)" % (
            k_ref, plus(mc["spend"]), plus(mc["topup"]), plus(mc["direct"]))).number_format = NUM
        mvv = money_late_v[g]
        fin_vals["late_" + g] = k_num * mvv["spend"] + mvv["topup"] + mvv["direct"]
    for c in range(6, 17):
        ws_sum.cell(row=r_fin, column=c).font = Font(bold=True)
    box(ws_sum, r_fin, NC, HEAD_FILL)
    ws_sum.cell(row=r_fin, column=18, value="k = %s (лист «По строкам»). %s" % (
        ("%.0f%%" % (k_num * 100)) if k_val is not None else "не задан, взято 1", cfg.get("total_note", "")))

    # ---------- ICE для эпика в трекере ----------
    # Impact — ожидаемый в месяц как в отчёте о выручке (траты × k + пополнения + прямые), денег; Confidence — % по уровню
    # главного входа (нет входов с вилкой — по самому слабому); Effort — часы; ICE = Impact × Confidence ÷ Effort
    ice_cols = ["Фича", "Ключ", ("Impact, " + CUR + " в месяц"), "Confidence, %", "По какому входу", "Effort, ч", "Размер и кто оценил", "ICE", "Как оценён effort"]
    ws_ice.append(ice_cols)
    style_header(ws_ice, 1, len(ice_cols))
    set_widths(ws_ice, [34, 13, 13, 12, 40, 9, 16, 9, 60])
    ws_ice.freeze_panes = "C2"
    ice_out = {}
    ri = 2
    for res, fxe in zip(results, exp_feats):
        f = res["f"]
        impact = 0.0  # фича без числа (типы C, D без цепочки до денег): Impact 0, ICE 0
        if res["has"]:
            impact = sum(cx["month"]["exp"] * (k_num if cx["money"] == "spend" else 1.0) for cx in fxe["components"])
        mi = next((x for x in fxe["inputs"] if x["id"] == fxe.get("main_input")), None)
        lvl = mi["level"] if mi else fxe.get("weakest_level")
        conf_pct = CONF_PCT.get(lvl) if res["has"] else None
        ef = f.get("effort") or {}
        hours = ef.get("hours") or EFFORT_HOURS.get(ef.get("size"))
        if not hours:
            ice = None
        elif not res["has"]:
            ice = 0
        else:
            ice = round(impact * conf_pct / 100 / hours) if conf_pct is not None else None
        if res["has"] and abs(impact or 0) > 0.5 and not hours:
            chk.hit(C_EFFORT, f["key"])
        ice_out[f["key"]] = {"impact": round(impact) if impact is not None else None, "confidence": conf_pct, "level": lvl,
                             "by_input": mi["name"] if mi else ("самый слабый вход" if lvl else None),
                             "effort_hours": hours, "effort_size": ef.get("size"), "effort_by": ef.get("by"),
                             "effort_note": ef.get("note", ""), "effort_split": ef.get("split"), "value": ice}
        fxe["ice"] = ice_out[f["key"]]
        x = ice_out[f["key"]]
        for ci, v in enumerate([f["name"], f["key"], x["impact"], x["confidence"], x["by_input"] or "—", x["effort_hours"],
                                " · ".join(t for t in (x["effort_size"], x["effort_by"]) if t) or "—", x["value"],
                                x["effort_note"] + ((" Разбить: " + x["effort_split"]) if x["effort_split"] else "")], start=1):
            c = ws_ice.cell(row=ri, column=ci, value=v if v is not None else "—")
            if isinstance(v, (int, float)):
                c.number_format = NUM
        box(ws_ice, ri, len(ice_cols))
        ri += 1

    # ---------- Замеры релиза ----------
    meas_cols = ["Фича", "Механика", "Прямая метрика", "Прогноз: негатив", "ожидаем", "позитив", "Даты замера",
                 "Факт", "Факт − прогноз", "Факт ÷ прогноз", ("Выручка, ожидаем в месяц, " + CUR + ""), "Способ замера"]
    ws_meas.append(meas_cols)
    style_header(ws_meas, 1, len(meas_cols))
    set_widths(ws_meas, [30, 14, 34, 10, 10, 10, 18, 10, 11, 10, 13, 40])
    ws_meas.freeze_panes = "B2"
    r = 2
    meas_out = []
    for res in results:
        f = res["f"]
        m = f.get("measure")
        if not m:
            continue
        start = res["first_money"]
        windows = m.get("windows") or ([14, 30, 90] if set(res["mechs"]) & LONG_TAIL_MECH else [14, 30])
        dts = " / ".join((start + timedelta(days=w)).strftime("%d.%m.%Y") for w in windows) if start else "—"
        ws_meas.cell(row=r, column=1, value="%s\n%s" % (f["name"], f["key"]))
        ws_meas.cell(row=r, column=2, value=", ".join(res["mechs"]))
        ws_meas.cell(row=r, column=3, value="%s, %s" % (m["metric"], m.get("unit", "")))
        for si, s in enumerate(SC):
            v = m[s] if s in m else m.get("value")
            ws_meas.cell(row=r, column=4 + si, value=v).number_format = NUM2 if isinstance(v, float) and abs(v) < 10 else NUM
        ws_meas.cell(row=r, column=7, value=dts)
        facts = m.get("facts") or []
        if facts:  # последний внесённый факт — в столбец «Факт»
            ws_meas.cell(row=r, column=8, value=facts[-1].get("value"))
        ws_meas.cell(row=r, column=9, value='=IF(H%d="","",H%d-E%d)' % (r, r, r))
        ws_meas.cell(row=r, column=10, value='=IF(OR(H%d="",E%d=0),"",H%d/E%d)' % (r, r, r, r)).number_format = NUM2
        ws_meas.cell(row=r, column=11, value="='Итог'!G%d" % res["row"]).number_format = NUM
        ws_meas.cell(row=r, column=12, value=m.get("method", "") + ((" · Отделим: " + m["separable"]) if m.get("separable") else ""))
        box(ws_meas, r, len(meas_cols))
        meas_out.append({"key": f["key"], "name": f["name"], "metric": m["metric"], "dates": dts, "unit": m.get("unit", ""),
                         "base": m.get("base"), "better": m.get("better"),
                         "values": {s: (m[s] if s in m else m.get("value")) for s in SC},
                         "method": m.get("method", ""), "separable": m.get("separable", ""), "windows": windows,
                         "date_list": [(start + timedelta(days=w)).isoformat() for w in windows] if start else [],
                         "first_money": start.isoformat() if start else None, "facts": facts, "draft": m.get("draft"),
                         "revenue_exp": res["acc"]["vals"]["month"]["exp"], "mechanics": res["mechs"]})
        r += 1
    if r == 2:
        ws_meas.cell(row=2, column=1, value="Ни у одной фичи нет measure: прогноз прямой метрики не записан")

    # ---------- Проверки ----------
    chk_cols = ["Проверка", "Где", "Результат", "Что сделать или причина"]
    ws_chk.append(chk_cols)
    style_header(ws_chk, 1, len(chk_cols))
    set_widths(ws_chk, [50, 42, 13, 90])
    ws_chk.freeze_panes = "B2"
    for i, rr in enumerate(chk.rows(), start=2):
        ws_chk.append(rr)
        box(ws_chk, i, len(chk_cols), HIT_FILL if rr[2] == "сработала" else None)

    # ---------- Прочие листы из конфига ----------
    for sh in cfg.get("sheets", []):
        ws = wb.create_sheet(sh["name"])
        ws.append(sh["columns"])
        style_header(ws, 1, len(sh["columns"]))
        set_widths(ws, sh["widths"])
        ws.freeze_panes = sh.get("freeze", "B2")
        for rr in sh["rows"]:
            ws.append(rr)
        for line in ws.iter_rows(min_row=2, max_row=ws.max_row, max_col=len(sh["columns"])):
            for cell in line:
                cell.border = BORDER
                cell.alignment = Alignment(wrap_text=True, vertical="top")
                if isinstance(cell.value, (int, float)) and not isinstance(cell.value, bool):
                    cell.number_format = NUM2 if isinstance(cell.value, float) and abs(cell.value) < 10 else NUM

    rel_tag = release if release not in (None, "all") else "все"
    out_xlsx = root / cfg["out_xlsx"].replace("{release}", rel_tag)
    out_md = root / cfg["out_md_table"].replace("{release}", rel_tag)
    if out_dir:
        od = Path(out_dir).resolve()
        od.mkdir(parents=True, exist_ok=True)
        out_xlsx, out_md = od / out_xlsx.name, od / out_md.name
    if save:
        out_xlsx.parent.mkdir(parents=True, exist_ok=True)
        out_md.parent.mkdir(parents=True, exist_ok=True)
        wb.save(out_xlsx)

    # ---------- md ----------
    lines_md = []
    lines_md.append("| Фича | Строка | Статус в трекере | В месяц: негатив | ожидаем | позитив | До конца %d: негатив | ожидаем | позитив | поздний срок | За %d: негатив | ожидаем | позитив | поздний срок | Уверенность |" % (cy, ny))
    lines_md.append("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|")
    tot = {g: {s: 0.0 for s in SC} for g in ("month", "cy", "ny")}
    tot_late = {"cy": 0.0, "ny": 0.0}

    def md_cells(acc, has=True):
        cells = []
        for g in ("month", "cy", "ny"):
            for s in SC:
                cells.append(fmt_money(acc["vals"][g][s] if has else 0.0))
            if g != "month":
                cells.append(fmt_money(acc["late_vals"][g] if has else 0.0))
        return cells

    for res in results:
        f = res["f"]
        cells = md_cells(res["acc"], res["has"])
        if res["has"]:
            for g in ("month", "cy", "ny"):
                for s in SC:
                    tot[g][s] += res["acc"]["vals"][g][s]
            for g in ("cy", "ny"):
                tot_late[g] += res["acc"]["late_vals"][g]
        for i in (1, 4, 8):
            cells[i] = "**%s**" % cells[i]
        lines_md.append("| %s<br>%s | %s | %s | %s | %s |" % (f["name"], f["key"], f.get("category", ""), f["status"], " | ".join(cells), res["conf"]))
        for p, x in res.get("part_rows", []):
            lines_md.append("| · %s | %s | | %s | |" % (p, ", ".join(x["lines"]), " | ".join(md_cells(x["acc"]))))
    tc = []
    for g in ("month", "cy", "ny"):
        tc += [fmt_money(tot[g][s]) for s in SC]
        if g != "month":
            tc.append(fmt_money(tot_late[g]))
    lines_md.append("| **Итого, простая сумма** | | | %s | |" % " | ".join("**%s**" % c for c in tc))
    rc = []
    for g in ("month", "cy", "ny"):
        rc += [fmt_money(rss_vals[g][s]) for s in SC]
        if g != "month":
            rc.append("")
    lines_md.append("| **Вилка релиза, фичи независимы** | | | %s | |" % " | ".join(rc))
    fc = []
    for g in ("month", "cy", "ny"):
        fc += [fmt_money(fin_vals[g][s]) for s in SC]
        if g != "month":
            fc.append(fmt_money(fin_vals["late_" + g]))
    lines_md.append("| **Итог выручки (k = %s)** | | | %s | |" % (
        ("%.0f%%" % (k_num * 100)) if k_val is not None else "не задан", " | ".join(fc)))
    trig = chk.triggered()
    lines_md.append("")
    lines_md.append("Проверки: сработали %d (лист «Проверки»)." % len(trig))
    for n, w, _, t in trig:
        lines_md.append("- %s — %s%s" % (n, w, (": " + t) if t else ""))
    if save:
        out_md.write_text("\n".join(lines_md) + "\n", encoding="utf-8")

    dump = {res["f"]["key"]: {"vals": res["acc"]["vals"], "late": res["acc"]["late_vals"], "confidence": res["conf"]} for res in results}
    dump["_total"] = tot
    dump["_total_late"] = tot_late
    dump["_range"] = rss_vals
    dump["_fin_total"] = fin_vals
    dump["_k"] = k_val
    dump["_lines"] = line_out
    dump["_measures"] = meas_out
    dump["_ice"] = ice_out
    # реестр прошлых замеров (лист конфига «Реестр»): точность прошлых прогнозов во вкладке «Замеры»
    reg = next((sh for sh in cfg.get("sheets", []) if sh.get("name") == "Реестр"), None)
    dump["_registry"] = {"columns": reg["columns"], "rows": reg["rows"]} if reg else None
    dump["_checks"] = [{"check": n, "where": w, "status": s, "note": t} for n, _ in CHECKS for (w, s, t) in chk.hits[n]]
    # строки выручки к плану: база, план по месяцам, эффект фич — для блока панели
    plan_lines = []
    for ln_name in list(line_specs) + [x for x in order if x not in line_specs]:
        spec = line_specs.get(ln_name, {})
        b_, g_, n_ = line_stats(spec) if spec else (None, None, None)
        plan_lines.append({"line": ln_name, "base": b_, "max_growth": g_, "noise": n_, "plan": spec.get("plan") or {},
                           "vals": lines[ln_name]["vals"] if ln_name in lines else {s: 0.0 for s in SC}})
    dump["_plan_lines"] = plan_lines
    # доля разрыва до плана месяца, которую закрывают фичи: только строки, где план выше базы (редизайн панели 19.11.2026)
    plan_cover = {}
    for m_ in sorted({k for r in plan_lines for k in (r["plan"] or {})}):
        rows_ = [r for r in plan_lines if r["base"] is not None and (r["plan"] or {}).get(m_) is not None and r["plan"][m_] - r["base"] > 0]
        need_ = sum(r["plan"][m_] - r["base"] for r in rows_)
        give_ = sum(r["vals"]["exp"] for r in rows_)
        plan_cover[m_] = {"need": need_, "give": give_, "share": (give_ / need_) if need_ else None, "lines": [r["line"] for r in rows_]}
    dump["_plan_cover"] = plan_cover
    dump["_plan_source"] = cfg.get("plan_source", "")
    # все строки листа «Проверки», включая прошедшие и «к сведению» — для вкладки «Проверки» панели
    dump["_check_rows"] = [{"check": r[0], "where": r[1], "status": r[2], "note": r[3]} for r in chk.rows()]
    if explain:
        v3 = bool(cfg.get("lines")) or any("mechanic" in c or "line" in c for f in cfg["features"] for c in f.get("components", []))
        dump["_meta"] = {"name": rel.get("name", cfg_path.stem), "file": cfg_path.name, "v3": v3,
                         "assessed": rel.get("assessed"), "planned": rel.get("planned"), "year_end": rel["year_end"],
                         "cy": cy, "ny": ny, "dates": rel.get("dates", {}), "rules": rules, "ramps": ramps,
                         "k": k_val, "k_config": k_cfg, "k_source": k_src, "k_months": k_by_month(cfg),
                         "k_used": k_num, "groups": cfg.get("groups", {}), "total_note": cfg.get("total_note", ""),
                         "checks_triggered": len(chk.triggered()), "pool": bool(tracker),
                         "currency": CUR, "line_order": KNOWN_LINES}
        if tracker:
            # конфиг со всеми фичами: релиз — фильтр; правки входов храним для всех фич, а не только видимых
            dump["_meta"].update({"assessed": tracker["today"].isoformat(), "tracker_at": tracker["at"], "tracker_source": tracker["source"],
                                  "release_filter": release or "all", "rules": cfg["release_offsets"],
                                  "pool_releases": pool_releases(cfg, tracker), "all_inputs": all_inputs})
        dump["_explain"] = exp_feats
        return dump
    (out_md.parent / (out_md.stem + ".json")).write_text(json.dumps(dump, ensure_ascii=False, indent=1, default=str), encoding="utf-8")
    print("xlsx:", out_xlsx)
    print("md:", out_md)
    for g in ("month", "cy", "ny"):
        print(g, "сумма", {s: round(tot[g][s]) for s in SC}, "| вилка", {s: round(rss_vals[g][s]) for s in SC},
              "| отчёт о выручке", {s: round(fin_vals[g][s]) for s in SC})
    print("поздний срок, ожидаемый:", {g: round(v) for g, v in tot_late.items()})
    print("k:", round(k_val, 4) if k_val is not None else None, "| проверок сработало:", len(trig))


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="Калькулятор выручки фич релиза, методика версии 3")
    ap.add_argument("config", nargs="?", help="releases/<дата>.json (не нужен с --serve)")
    ap.add_argument("--out-dir", help="папка для xlsx, md и json вместо путей из конфига")
    ap.add_argument("--explain", action="store_true", help="не сохранять файлы, напечатать json с шагами расчёта")
    ap.add_argument("--serve", action="store_true", help="для панели bb: запросы explain построчно из stdin, ответы построчно в stdout")
    ap.add_argument("--release", help="конфиг со всеми фичами: релиз в трекере ГГГГ-ММ-ДД, all или none")
    a = ap.parse_args()
    if not a.serve and not a.config:
        ap.error("нужен конфиг: releases/<дата>.json")
    if a.serve:
        # один процесс на всё время работы панели: импорт openpyxl только один раз
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stdin.reconfigure(encoding="utf-8")
        here = Path(__file__).resolve().parent
        for line in sys.stdin:
            if not line.strip():
                continue
            req = {}
            try:
                req = json.loads(line)
                cfg = Path(req["config"])
                cfg = cfg if cfg.is_absolute() else here / cfg
                if req.get("list"):
                    # список релизов конфига со всеми фичами: без расчёта, только трекер
                    c_ = json.loads(cfg.read_text(encoding="utf-8"))
                    setup_lines(c_)
                    j_ = load_tracker(c_, find_root(cfg))
                    out = pool_releases(c_, j_) if j_ else None
                else:
                    out = main(cfg, overrides=req.get("overrides"), explain=True, release=req.get("release"))
                    if req.get("slim"):
                        out.pop("_explain", None)
                resp = {"id": req.get("id"), "ok": True, "data": out}
            except Exception as e:  # noqa: BLE001 — ошибку конфига отдаём панели текстом
                resp = {"id": req.get("id"), "ok": False, "error": "%s: %s" % (type(e).__name__, e)}
            sys.stdout.write(json.dumps(resp, ensure_ascii=False, default=str) + "\n")
            sys.stdout.flush()
    elif a.explain:
        sys.stdout.reconfigure(encoding="utf-8")
        raw = sys.stdin.read() if not sys.stdin.isatty() else ""
        req = json.loads(raw) if raw.strip() else {}
        out = main(a.config, overrides=req.get("overrides"), explain=True, release=a.release or req.get("release"))
        if req.get("slim"):  # что-если: итоги фич уже в ключах dump, шаги расчёта не нужны
            out.pop("_explain", None)
        sys.stdout.write(json.dumps(out, ensure_ascii=False, default=str))
    else:
        main(a.config, a.out_dir, release=a.release)
