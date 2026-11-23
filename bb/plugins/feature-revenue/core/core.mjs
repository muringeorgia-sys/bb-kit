// Ядро «Выручки фич» без bb: папка данных, Python, данные трекера.
// server.ts импортирует его статически (bb собирает плагин в один файл); test_core.mjs гоняет то же без bb.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { demoConfig } from "./demo.mjs";
import { METHOD_MD } from "./method.mjs";
import { PY_SCRIPTS } from "./py_scripts.mjs";

export const DEFAULT_DATA_DIR = path.join(os.homedir(), ".config", "bb-feature-revenue");

const writeIfChanged = (p, text) => {
  let cur = null;
  try { cur = readFileSync(p, "utf8"); } catch { /* нет файла */ }
  if (cur !== text) writeFileSync(p, text, "utf8");
};

/**
 * Готовит папку данных: py/ (скрипты калькулятора — всегда свежие из плагина), Методика.md,
 * releases/features.json с демо-фичами, если в releases нет ни одного конфига.
 */
export function ensureData(dataDir, { currency = "₽", today = new Date() } = {}) {
  const dir = dataDir || DEFAULT_DATA_DIR;
  const py = path.join(dir, "py");
  const releases = path.join(dir, "releases");
  for (const d of [dir, py, releases, path.join(dir, "out"), path.join(dir, "reviews")]) mkdirSync(d, { recursive: true });
  for (const [name, text] of Object.entries(PY_SCRIPTS)) writeIfChanged(path.join(py, name), text);
  writeIfChanged(path.join(dir, "Методика.md"), METHOD_MD);
  let demo = false;
  if (!readdirSync(releases).some((f) => f.endsWith(".json"))) {
    writeFileSync(path.join(releases, "features.json"), JSON.stringify(demoConfig(today, currency), null, 1) + "\n", "utf8");
    demo = true;
  }
  return {
    dir, releases, demo,
    build: path.join(py, "build.py"),
    measureFact: path.join(py, "measure_fact.py"),
    reviewMark: path.join(py, "review_mark.py"),
    method: path.join(dir, "Методика.md"),
    iceDir: path.join(dir, "ice"),
    reviewsDir: path.join(dir, "reviews"),
  };
}

/** Python ≥ 3.10 с openpyxl: путь из настройки или python / python3 / py из PATH. Ошибка — понятным текстом. */
export function findPython(setting) {
  const cands = setting ? [[setting, []]] : process.platform === "win32"
    ? [["python", []], ["py", ["-3"]], ["python3", []]]
    : [["python3", []], ["python", []]];
  const tried = [];
  for (const [cmd, pre] of cands) {
    try {
      const out = execFileSync(cmd, [...pre, "-c", "import sys, openpyxl; print('%d.%d' % sys.version_info[:2])"], {
        encoding: "utf8", windowsHide: true, timeout: 20_000, stdio: ["ignore", "pipe", "pipe"],
      }).trim();
      const [maj, min] = out.split(".").map(Number);
      if (maj > 3 || (maj === 3 && min >= 10)) return { cmd, pre, version: out };
      tried.push(`${cmd}: Python ${out}, нужен 3.10+`);
    } catch (e) {
      const err = String(e?.stderr || e?.message || e);
      tried.push(`${cmd}: ${/openpyxl/.test(err) ? "нет пакета openpyxl (pip install openpyxl)" : "не запускается"}`);
    }
  }
  throw new Error(`Нужен Python 3.10+ с пакетом openpyxl. Проверено — ${tried.join("; ")}. Укажите путь в настройке «Путь к Python».`);
}

/** Поля ICE из настройки «impact,confidence,effort,ice» -> объект или null. */
export function parseIceFields(s) {
  const p = String(s || "").split(",").map((x) => x.trim()).filter(Boolean);
  return p.length === 4 ? { impact: p[0], confidence: p[1], effort: p[2], ice: p[3] } : null;
}

/** REST API трекера (Atlassian Cloud, v3): Basic email:токен, повтор при 429. */
export function trackerClient({ url, email, token }) {
  if (!url || !email || !token) return null;
  const site = String(url).replace(/\/+$/, "");
  const auth = "Basic " + Buffer.from(`${email}:${token}`).toString("base64");
  return async function call(method, p, body) {
    for (let attempt = 0; ; attempt++) {
      const r = await fetch(site + p, {
        method,
        headers: { Authorization: auth, Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (r.status === 429 && attempt < 4) { await new Promise((res) => setTimeout(res, 1500 * (attempt + 1))); continue; }
      const text = await r.text();
      if (!r.ok) throw new Error(`трекер ${r.status}: ${text.slice(0, 300)}`);
      return text ? JSON.parse(text) : null;
    }
  };
}

/**
 * Эпики, статусы и релизы (fixVersions) из трекера -> <папка данных>/tracker.json в формате калькулятора.
 * Релиз эпика — releaseDate версии или дата в имени (ГГГГ-ММ-ДД или ДД/ММ/ГГГГ).
 */
export async function refreshTracker(call, jql, file, { maxIssues = 2000 } = {}) {
  const epics = [];
  const versions = {};
  let token;
  do {
    const r = await call("POST", "/rest/api/3/search/jql", {
      jql, maxResults: 100, fields: ["summary", "status", "issuetype", "fixVersions"], ...(token ? { nextPageToken: token } : {}),
    });
    for (const it of r?.issues ?? []) {
      const f = it.fields ?? {};
      const vs = [];
      for (const v of f.fixVersions ?? []) {
        const dt = v.releaseDate || (/(\d{4}-\d{2}-\d{2})/.exec(v.name ?? "") ?? [])[1] || null;
        if (dt) { versions[dt] = v.name ?? dt; vs.push(dt); } else if (v.name) vs.push(v.name);
      }
      const type = f.issuetype?.hierarchyLevel === 1 || /^(epic|эпик)$/i.test(f.issuetype?.name ?? "") ? "Epic" : f.issuetype?.name ?? "";
      epics.push({ key: it.key, type, status: f.status?.name ?? "", summary: f.summary ?? "", versions: vs });
    }
    token = r?.nextPageToken;
  } while (token && epics.length < maxIssues);
  const now = new Date();
  const data = { generated: now.getTime(), today: now.toISOString().slice(0, 10), versions, epics };
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(data, null, 1), "utf8");
  return { epics: epics.length, versions: Object.keys(versions).length };
}

/** Открыть файл или папку системной программой. */
export function openPath(target) {
  const [cmd, args] = process.platform === "win32" ? ["explorer.exe", [target]] : process.platform === "darwin" ? ["open", [target]] : ["xdg-open", [target]];
  return { cmd, args };
}

export { existsSync };
