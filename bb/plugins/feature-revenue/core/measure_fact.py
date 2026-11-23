# Факт замера из панели «Выручка фич»: дописать или убрать {date, value} в measure.facts фичи.
# Запуск: python measure_fact.py <конфиг.json> <DEMO-1> <ГГГГ-ММ-ДД> <число | пусто — убрать факт за дату>
# Файл пишется тем же форматом (json, отступ 1, без экранирования кириллицы, те же переводы строк): если формат другой — не пишем.
import datetime
import json
import pathlib
import sys

CRLF = b"\r\n"


def main() -> None:
    if len(sys.argv) != 5:
        raise SystemExit("нужно 4 аргумента: конфиг, ключ, дата, значение")
    cfg, key, date, value = sys.argv[1:5]
    datetime.date.fromisoformat(date)
    p = pathlib.Path(cfg)
    crlf = CRLF in p.read_bytes()
    src = p.read_text(encoding="utf-8")
    data = json.loads(src)
    if json.dumps(data, ensure_ascii=False, indent=1).strip() != src.strip():
        raise SystemExit("формат файла не json с отступом 1 — не пишу, чтобы не переформатировать конфиг")
    feat = next((f for f in data.get("features", []) if f.get("key") == key), None)
    if feat is None:
        raise SystemExit(f"нет фичи {key} в {p.name}")
    meas = feat.get("measure")
    if not isinstance(meas, dict):
        raise SystemExit(f"у фичи {key} нет метрики замера: сначала записать measure")
    facts = [x for x in (meas.get("facts") or []) if x.get("date") != date]
    if value.strip():
        facts.append({"date": date, "value": float(value)})
    meas["facts"] = sorted(facts, key=lambda x: x.get("date", ""))
    out = json.dumps(data, ensure_ascii=False, indent=1)
    if src.endswith("\n"):
        out += "\n"
    p.write_text(out, encoding="utf-8", newline=CRLF.decode() if crlf else "\n")
    print(json.dumps({"ok": True, "facts": meas["facts"]}, ensure_ascii=False))


if __name__ == "__main__":
    main()
