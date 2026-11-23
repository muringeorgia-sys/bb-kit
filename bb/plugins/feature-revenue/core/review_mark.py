"""Отметка ИИ в ревью PO.

ИИ доработал фичу по ревью или ему нужен ответ PO:
    python review_mark.py --release 2026-11-25 --key DEMO-1 --status done --note "что поменял; итог было → стало"
    python review_mark.py --release 2026-11-25 --key DEMO-1 --status question --note "вопрос к PO"

Пишет в <папка данных плагина>/reviews/<релиз>.json: статус фичи, заметку, время.
Панель видит отметку и показывает фичу в ревью как «ИИ доработал» или «ИИ спрашивает».
"""
import argparse
import datetime
import json
import os
import pathlib
import re
import sys

# скрипт лежит в <папка данных>/py/, ревью — в <папка данных>/reviews/ (или FR_REVIEWS_DIR)
DIR = pathlib.Path(os.environ.get("FR_REVIEWS_DIR") or pathlib.Path(__file__).resolve().parents[1] / "reviews")


def main() -> int:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")  # консоль Windows: русский текст без кракозябр
        except Exception:
            pass
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--release", required=True, help="ГГГГ-ММ-ДД, all или none — как в панели")
    ap.add_argument("--key", required=True, help="ключ эпика, например DEMO-1")
    ap.add_argument("--status", choices=["done", "question"], default="done")
    ap.add_argument("--note", required=True, help="что поменял (done) или вопрос к PO (question)")
    a = ap.parse_args()
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}|all|none", a.release):
        print("release: ГГГГ-ММ-ДД, all или none", file=sys.stderr)
        return 2
    path = DIR / f"{a.release}.json"
    if not path.exists():
        print(f"нет файла ревью {path}: PO ещё не отправлял задачи по этому релизу", file=sys.stderr)
        return 1
    rv = json.loads(path.read_text(encoding="utf-8"))
    item = rv.setdefault("items", {}).get(a.key)
    if not item:
        print(f"{a.key} нет в ревью релиза {a.release}", file=sys.stderr)
        return 1
    item["status"] = a.status
    item["ai_note"] = a.note.strip()
    item["ai_at"] = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(rv, ensure_ascii=False, indent=1), encoding="utf-8")
    os.replace(tmp, path)
    print(f"{a.key}: {a.status} — отмечено в {path.name}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
