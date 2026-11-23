// Релизы — общий модуль плагина bb «Релизы» и запуска из командной строки (core/run.mjs).
// Сбор из Jira Cloud → data.json; итоги, прогноз и кейсы вне нормы → view(); сводка в Telegram; запись в Jira.
// Адрес Jira, доступы, проекты, поля, продукты и статусы задаёт configure() — из настроек плагина или переменных окружения (run.mjs).
// Только встроенные модули Node.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Папка данных: ~/.config/bb-releases (переменная BB_RELEASES_DATA — другая папка, например для проверки).
export const OUT_DIR = process.env.BB_RELEASES_DATA || path.join(os.homedir(), ".config", "bb-releases");
const DATA_FILE = path.join(OUT_DIR, "data.json");
const NOTES_FILE = path.join(OUT_DIR, "notes.json");
const HIST_DIR = path.join(OUT_DIR, "history");
const JOURNAL = path.join(OUT_DIR, "journal.jsonl");

// ---------- настройки (configure) ----------
// Роли проектов Jira: epic — эпики продукта; dev — задачи разработки; design и qa — необязательные проекты дизайна и QA-анализа.
// Продукты делят одни проекты Jira: продукт задаёт имя версии «<version> ДД/ММ/ГГГГ» (version по умолчанию = name)
// и значение поля эпика «Продукт» (field по умолчанию = name). Первый продукт в списке — основной: его файлы лежат в корне папки данных.
export const PLACEHOLDER_PRODUCT = { id: "main", name: "Продукт A", short: "A", emoji: "🚀" };
const ST_DEFAULT = {
  groups: { done: ["Done", "Ready to release", "Готово", "Ready to Release"], test: ["Review", "Ready to test", "Testing", "Проверка", "Тестирование", "In Testing"], hold: ["On Hold", "Holding"], kick: ["Kickback"], todo: ["Backlog", "To Do", "К выполнению", "Open", "Selected for Development", "Сделать"] },
  phases: {
    pre: ["Backlog", "Инициатива", "Исследование", "Оценка и приоритизация", "Формирование требований", "Discovery Backlog", "Бэклог исследования", "Review", "to dev", "Selected for Development", "Open"],
    qa: ["Бэклог QA анализа", "В работе QA", "Ответ продакта", "Ответить QA", "QA анализ завершён", "QA анализ"],
    design: ["Бэклог дизайна", "Дизайн", "На согласовании", "На оценку", "Готово к дизайну"],
    ready: ["Готово к тех оценке", "Нужна доработка", "Тех оценка", "Декомпозировать"],
    dev: ["Бэклог разработки", "Разработка"],
    done: ["Готово к выпуску", "Выпущено"],
    parked: ["Отложено", "Отклонено", "Отменено"],
  },
  designDone: "Дизайн готов", qaDone: "QA анализ завершён", epicReady: "Готово к выпуску", epicReleased: "Выпущено", canceled: "Отменено", rejected: "Отклонено",
};
const CFG_DEFAULT = {
  site: "", email: "", token: "", tgToken: "", tgChatId: "", claudeBin: "",
  projects: { epic: "", dev: "", design: "", qa: "" },
  fields: { product: "", reqLink: "", designLink: "", noDesign: "" },
  products: [], statuses: null, utcOffset: null,
};
let C = JSON.parse(JSON.stringify(CFG_DEFAULT));
export let SITE = "";
export let PRODUCTS = [PLACEHOLDER_PRODUCT];
export let PRODUCT_IDS = PRODUCTS.map((p) => p.id);
let PJ = { ...CFG_DEFAULT.projects };
let PROJECTS = [], TASK_PROJECTS = [];
let ST = ST_DEFAULT, G = ST.groups, PH = ST.phases;
// Сдвиг часового пояса в мс: utcOffset (часы) или пояс компьютера.
let TZ = -new Date().getTimezoneOffset() * 60e3;
const KEY_RE = /^[A-Z][A-Z0-9_]{0,19}$/, FIELD_RE = /^customfield_\d+$/, PID_RE = /^[a-z][a-z0-9_-]{0,19}$/;
const strArr = (x) => (Array.isArray(x) ? x.filter((s) => typeof s === "string" && s.trim()).map((s) => s.trim()) : null);
// Разбор списка продуктов: JSON-массив [{ id, name, short?, emoji?, version?, field? }] или строка. Ошибка — исключение с понятным текстом.
export function parseProducts(src) {
  const raw = typeof src === "string" ? (src.trim() ? JSON.parse(src) : []) : src || [];
  if (!Array.isArray(raw)) throw new Error("Продукты: нужен JSON-массив");
  const out = [];
  for (const x of raw) {
    const id = String(x?.id || "").trim().toLowerCase(), name = String(x?.name || "").trim();
    if (!PID_RE.test(id)) throw new Error(`Продукты: id «${id}» — латиница в нижнем регистре, цифры, _ или -, до 20 знаков`);
    if (!name) throw new Error(`Продукты: у «${id}» нет name`);
    if (out.some((p) => p.id === id)) throw new Error(`Продукты: id «${id}» повторяется`);
    out.push({ id, name, short: String(x.short || name).trim(), emoji: String(x.emoji || "").trim(), version: String(x.version || name).trim(), field: String(x.field || name).trim() });
  }
  return out;
}
export function configure(o = {}) {
  const pj = { ...CFG_DEFAULT.projects }, fl = { ...CFG_DEFAULT.fields };
  for (const k of Object.keys(pj)) { const v = String(o.projects?.[k] || "").trim().toUpperCase(); if (v && !KEY_RE.test(v)) throw new Error(`Проект Jira «${v}»: только латиница, цифры и _`); pj[k] = v; }
  for (const k of Object.keys(fl)) { const v = String(o.fields?.[k] || "").trim(); if (v && !FIELD_RE.test(v)) throw new Error(`Поле Jira «${v}»: формат customfield_12345`); fl[k] = v; }
  const prods = parseProducts(o.products);
  let st = ST_DEFAULT;
  if (o.statuses) {
    const s = typeof o.statuses === "string" ? (o.statuses.trim() ? JSON.parse(o.statuses) : {}) : o.statuses;
    st = { ...ST_DEFAULT, groups: { ...ST_DEFAULT.groups }, phases: { ...ST_DEFAULT.phases } };
    for (const k of Object.keys(st.groups)) { const a = strArr(s.groups?.[k]); if (a) st.groups[k] = a; }
    for (const k of Object.keys(st.phases)) { const a = strArr(s.phases?.[k]); if (a) st.phases[k] = a; }
    for (const k of ["designDone", "qaDone", "epicReady", "epicReleased", "canceled", "rejected"]) if (typeof s[k] === "string" && s[k].trim()) st[k] = s[k].trim();
  }
  const off = o.utcOffset === "" || o.utcOffset == null ? null : Number(o.utcOffset);
  C = { ...CFG_DEFAULT, ...o, site: String(o.site || "").trim().replace(/\/+$/, ""), projects: pj, fields: fl, products: prods, statuses: st, utcOffset: Number.isFinite(off) ? off : null };
  SITE = C.site;
  PJ = pj;
  PROJECTS = [pj.epic, pj.dev, pj.design, pj.qa].filter(Boolean);
  TASK_PROJECTS = [pj.dev, pj.design, pj.qa].filter(Boolean);
  PRODUCTS = prods.length ? prods : [PLACEHOLDER_PRODUCT];
  PRODUCT_IDS = PRODUCTS.map((p) => p.id);
  CUR = PRODUCTS[0];
  RE_CACHE.clear();
  ST = st; G = st.groups; PH = st.phases;
  TZ = C.utcOffset != null ? C.utcOffset * 3600e3 : -new Date().getTimezoneOffset() * 60e3;
  FIELDS = [...BASE_FIELDS, ...Object.values(fl).filter(Boolean)];
  return missing();
}
// Чего не хватает для сбора из Jira: пустой список — можно обновлять.
export function missing() {
  const m = [];
  if (!/^https:\/\/[^/]+$/.test(C.site)) m.push("адрес Jira (https://…)");
  if (!C.email) m.push("email пользователя Jira");
  if (!C.token) m.push("API-токен Jira");
  if (!PJ.epic) m.push("проект эпиков");
  if (!PJ.dev) m.push("проект задач разработки");
  if (!C.products.length) m.push("список продуктов");
  return m;
}
export const projects = () => ({ ...PJ });
export const statuses = () => ST;
export const product = (id) => PRODUCTS.find((p) => p.id === id || p.name === id) || PRODUCTS[0];
export const prodOf = (data) => product(data?.product);
const verName = (p) => p.version || p.name;
const isMain = (p) => p.id === PRODUCTS[0].id;
// Кейсы и заявки неосновных продуктов помечены префиксом id «<id>|…», у основного — без префикса.
export const idPre = (pid) => (isMain(product(pid)) ? "" : product(pid).id + "|");
export const idProd = (id) => { const m = String(id || "").match(/^([a-z][a-z0-9_-]*)\|/); return m && PRODUCT_IDS.includes(m[1]) ? m[1] : PRODUCTS[0].id; };
// Продукты логина из «Доступов»: нет поля — основной продукт.
export const loginProducts = (x) => (Array.isArray(x?.products) ? x.products.filter((p) => PRODUCT_IDS.includes(p)) : [PRODUCTS[0].id]);
// Текущий продукт синхронного расчёта (view, findAnomalies): ставится на время вызова и возвращается обратно.
let CUR = PRODUCTS[0];
const withProd = (p, fn) => { const prev = CUR; CUR = p; try { return fn(); } finally { CUR = prev; } };
const RE_CACHE = new Map();
const reOf = (p) => { if (!RE_CACHE.has(p.id)) RE_CACHE.set(p.id, new RegExp(verName(p).replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + " (\\d{2})\\/(\\d{2})\\/(\\d{4})$")); return RE_CACHE.get(p.id); };
const dataFile = (p) => (isMain(p) ? DATA_FILE : path.join(OUT_DIR, `data-${p.id}.json`));
const histDir = (p) => (isMain(p) ? HIST_DIR : path.join(HIST_DIR, p.id));
// Ожидаемая выручка эпиков (необязательно, из другого инструмента): rev.json / rev-<id>.json в папке данных, { "<ключ эпика>": число }.
const revFile = (p) => path.join(OUT_DIR, isMain(p) ? "rev.json" : `rev-${p.id}.json`);
const STUCK_DAYS = 3;
const DESIGN_WARN_DAYS = 7;
// Готовность следующего релиза (режим PO): за сколько дней до старта спринта напоминать в сводке; какие итоги = «не готов».
export const READY_WARN_DAYS = 7;
export const READY_GAP = ["n_req", "n_qa", "n_design", "n_notask"];

// ---------- time (пояс из настроек или компьютера) ----------
const DAY = 86400e3;
const ms = (s) => Date.parse(s + "T00:00:00Z") - TZ;
const endOf = (s) => ms(s) + DAY - 1;
export const iso = (t) => new Date(t + TZ).toISOString().slice(0, 10);
export const fd = (t) => (t == null ? "—" : iso(t).slice(8, 10) + "." + iso(t).slice(5, 7));
export const fdt = (t) => fd(t) + " " + new Date(t + TZ).toISOString().slice(11, 16);
export const dd = (date) => date.slice(8, 10) + "." + date.slice(5, 7);
const ts = (s) => (typeof s === "number" ? s : s ? Date.parse(String(s).replace(/([+-]\d\d)(\d\d)$/, "$1:$2")) : null);
const addDays = (date, n) => iso(ms(date) + n * DAY);
function workdays(fromT, toT) {
  let n = 0;
  for (let t = ms(iso(fromT)) + DAY; t <= toT; t += DAY) {
    const d = new Date(t + TZ).getUTCDay();
    if (d && d < 6) n++;
  }
  return n;
}

// ---------- files ----------
export const readJson = (f, dflt = null) => {
  try {
    return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8").replace(/^\uFEFF/, "")) : dflt;
  } catch {
    return dflt;
  }
};
export const writeJson = (f, v) => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f + ".tmp", JSON.stringify(v), "utf8");
  fs.renameSync(f + ".tmp", f);
};
export const journal = (rec) => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.appendFileSync(JOURNAL, JSON.stringify({ t: new Date().toISOString(), ...rec }) + "\n", "utf8");
};
export const loadData = (pid) => { const p = product(pid), d = readJson(dataFile(p)); if (d) d.product ||= p.id; return d; };
// Правки PO (итог, причина, скрытые кейсы, даты спринта) — свои у каждого продукта. Доступы и Telegram — общие.
// Для неосновных продуктов возвращается вид на notes.prod.<id>; saveNotes пишет корень файла.
export function loadNotes(pid) {
  const n = readJson(NOTES_FILE, {}) || {};
  n.over ||= {}; n.notes ||= {}; n.ack ||= {}; n.cfg ||= {}; n.prod ||= {};
  n.cfg.starts ||= {}; n.cfg.cutoffs ||= {}; n.cfg.tg ||= {}; n.cfg.pms ||= []; n.cfg.pos ||= [];
  // Чат сводки из настроек главнее найденного кнопкой «Найти чат».
  if (C.tgChatId) { const id = String(C.tgChatId).trim(); n.cfg.tg.chatId = /^-?\d+$/.test(id) ? Number(id) : id; n.cfg.tg.title ||= id; }
  const p = product(pid ?? CUR.id);
  if (isMain(p)) return n;
  const s = (n.prod[p.id] ||= {});
  s.over ||= {}; s.notes ||= {}; s.ack ||= {}; s.starts ||= {}; s.cutoffs ||= {};
  const out = { ...n, over: s.over, notes: s.notes, ack: s.ack, cfg: { ...n.cfg, starts: s.starts, cutoffs: s.cutoffs } };
  Object.defineProperty(out, "_root", { value: n, enumerable: false });
  return out;
}
export const saveNotes = (n) => writeJson(NOTES_FILE, n._root || n);

// ---------- доступы (из configure; значения не печатаются) ----------
export function env(name) {
  if (name === "TELEGRAM_BOT_TOKEN") return C.tgToken || "";
  if (name === "CLAUDE_BIN") return C.claudeBin || "";
  return "";
}
function auth() {
  if (!C.email || !C.token) throw new Error("Нет email или API-токена Jira — заполните настройки плагина");
  return "Basic " + Buffer.from(`${C.email}:${C.token}`).toString("base64");
}
async function api(method, p, body) {
  const m = missing().filter((x) => !x.startsWith("список продуктов"));
  if (m.length) throw new Error(`Не заполнены настройки: ${m.join(", ")}`);
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(SITE + p, {
      method,
      headers: { Authorization: auth(), Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (r.status === 429 && attempt < 4) { await new Promise((ok) => setTimeout(ok, 3000 * (attempt + 1))); continue; }
    const txt = await r.text();
    if (!r.ok) throw new Error(`Jira ${method} ${p.split("?")[0]} → ${r.status} ${txt.slice(0, 300)}`);
    return txt ? JSON.parse(txt) : {};
  }
}

// ---------- statuses (группы задач G и стадии эпика PH — из ST, настройка «Статусы Jira») ----------
const grp = (s) => { if (s == null) return null; for (const k in G) if (G[k].includes(s)) return k; return "work"; };
const phase = (s) => { for (const k in PH) if (PH[k].includes(s)) return k; return "other"; };
const closedEpic = (s) => s === ST.epicReleased || PH.parked.includes(s);
const isDoneTask = (t) => t.cat === "done" || grp(t.status) === "done" || [ST.designDone, ST.qaDone, ST.canceled].includes(t.status);
// Конечный статус после релиза: Done / отменено. «Ready to release» после даты релиза — ещё не конец.
export const isFinal = (t) => t.cat === "done" || PH.parked.includes(t.status);
const inSlot = (iv, t) => iv.some(([a, b]) => a <= t && (b == null || b > t));
function statusAt(it, t) { if (it.created > t) return null; let s = it.status; for (let i = it.st.length - 1; i >= 0; i--) { if (it.st[i].t > t) s = it.st[i].from; else break; } return s; }
function lastTo(it, name, t) { let r = null; for (const e of it.st) if (e.t <= t && e.to === name) r = e.t; return r; }
// Задача разработки продукта: проект dev, не эпик, без релизов или с релизом этого продукта.
// p — продукт; в .filter(isMash) вторым аргументом приходит индекс — тогда текущий продукт.
export const isMash = (t, p) => { const P = p?.name ? p : CUR; return !!PJ.dev && t.project === PJ.dev && t.type !== "Epic" && !(t.versions.length && !t.versions.some((v) => v.includes(verName(P)))); };
const BUCKET = /фикс багов|tech debt|техдолг/i;
export const verDate = (name, p) => { const m = String(name).match(reOf(p?.name ? p : CUR)); return m ? `${m[3]}-${m[2]}-${m[1]}` : null; };
const shortV = (v) => { const d = verDate(v); return d ? dd(d) + (d.slice(0, 4) !== String(new Date().getFullYear()) ? "." + d.slice(2, 4) : "") : v; };
const mver = (vs) => vs.filter((v) => !PRODUCTS.some((q) => q.id !== CUR.id && v.includes(verName(q))));
// Ранг приоритета: 0 = самый высокий. «High (migrated)» = «High». Незнакомое имя — по порядку Jira после известных; пусто — в конец.
const PRIO_TIER = { highest: 0, "наивысший": 0, blocker: 0, critical: 1, high: 2, "высокий": 2, major: 2, medium: 3, "средний": 3, low: 4, "низкий": 4, minor: 4, lowest: 5, "самый низкий": 5, trivial: 5 };
const prioNorm = (n) => String(n || "").replace(/\s*\(.*\)\s*$/, "").trim().toLowerCase();
export function prioRank(name, order = []) {
  const n = prioNorm(name);
  if (!n) return 999;
  if (n in PRIO_TIER) return PRIO_TIER[n];
  const i = [...new Set(order.map(prioNorm))].indexOf(n);
  return i >= 0 ? 100 + i : 500;
}

// =====================================================================
// Сбор из Jira
// =====================================================================
const BASE_FIELDS = ["summary", "status", "issuetype", "created", "fixVersions", "parent", "assignee", "project", "comment", "priority", "labels"];
let FIELDS = BASE_FIELDS;

async function search(jql, fields) {
  fields ||= FIELDS;
  const rows = []; let tok = null;
  do {
    const r = await api("POST", "/rest/api/3/search/jql", { jql, fields, maxResults: 100, ...(tok ? { nextPageToken: tok } : {}) });
    rows.push(...r.issues); tok = r.nextPageToken;
  } while (tok);
  return rows;
}
async function changelogs(ids) {
  const out = {};
  for (let i = 0; i < ids.length; i += 1000) {
    let tok = null;
    do {
      const r = await api("POST", "/rest/api/3/changelog/bulkfetch", { issueIdsOrKeys: ids.slice(i, i + 1000), maxResults: 10000, ...(tok ? { nextPageToken: tok } : {}) });
      for (const c of r.issueChangeLogs || []) (out[c.issueId] ||= []).push(...(c.changeHistories || []));
      tok = r.nextPageToken;
    } while (tok);
  }
  return out;
}
const chunks = (a, n) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));

function adfText(n) {
  if (n == null) return "";
  if (typeof n === "string") return n;
  if (n.type === "text") return n.text || "";
  if (n.type === "mention") return n.attrs?.text || "";
  if (n.type === "inlineCard") return n.attrs?.url || "";
  if (n.type === "hardBreak") return "\n";
  let s = (n.content || []).map(adfText).join("");
  if (["paragraph", "heading", "listItem", "codeBlock"].includes(n.type)) s += "\n";
  return s;
}
function verEvents(ch) {
  const out = [];
  for (const h of ch) {
    let e = null;
    for (const i of h.items || []) {
      if (i.fieldId !== "fixVersions" && i.field !== "Fix Version" && i.field !== "fixVersions") continue;
      e ||= { t: ts(h.created), who: h.author?.displayName || "", add: [], rem: [] };
      if (i.to) e.add.push([i.to, i.toString || ""]);
      if (i.from) e.rem.push([i.from, i.fromString || ""]);
    }
    if (e) out.push(e);
  }
  return out;
}
function intervals(curIds, evs, ids, created) {
  const has = (arr) => arr.some((a) => ids.has(a[0]));
  let state = curIds.some((id) => ids.has(id));
  for (let k = evs.length - 1; k >= 0; k--) { if (has(evs[k].add)) state = false; if (has(evs[k].rem)) state = true; }
  const iv = []; let start = state ? created : null;
  for (const e of evs) {
    if (has(e.rem) && start != null) { iv.push([start, e.t]); start = null; }
    if (has(e.add) && start == null) start = e.t;
  }
  if (start != null) iv.push([start, null]);
  return iv;
}
function norm(r, logs, relIds) {
  const f = r.fields;
  const ch = (logs[r.id] || []).slice().sort((a, b) => ts(a.created) - ts(b.created));
  const evs = verEvents(ch), created = ts(f.created), curIds = (f.fixVersions || []).map((v) => v.id);
  const iv = {};
  for (const [date, ids] of Object.entries(relIds)) iv[date] = intervals(curIds, evs, ids, created);
  const st = [];
  for (const h of ch) for (const i of h.items || []) if (i.field === "status") st.push({ t: ts(h.created), who: h.author?.displayName || "", from: i.fromString, to: i.toString });
  let designLinkAt = null;
  const DL = C.fields.designLink;
  if (DL) for (const h of ch) for (const i of h.items || []) if (designLinkAt == null && i.fieldId === DL && (i.toString || i.to)) designLinkAt = ts(h.created);
  const fv = (id) => (id ? f[id] : undefined);
  const prodVals = [].concat(fv(C.fields.product) ?? []).map((x) => (typeof x === "string" ? x : x?.value ?? x?.name ?? "")).filter(Boolean);
  const comments = ((f.comment?.comments) || []).slice(-10).map((c) => ({ t: c.created.slice(0, 16), ms: Date.parse(c.created), up: c.updated && c.updated !== c.created ? Date.parse(c.updated) : undefined, who: c.author?.displayName || "", text: adfText(c.body).trim().slice(0, 600) })).filter((c) => c.text);
  return {
    key: r.key, url: SITE + "/browse/" + r.key, project: f.project.key, type: f.issuetype.name, summary: f.summary,
    status: f.status.name, cat: f.status.statusCategory.key, created, assignee: f.assignee?.displayName || "",
    priority: f.priority?.name || "", labels: f.labels || [],
    parent: f.parent?.key || null, versions: (f.fixVersions || []).map((v) => v.name),
    // Поле «Ссылка на требования» не задано — правило «нет ссылки на требования» не срабатывает.
    products: prodVals, reqLink: C.fields.reqLink ? !!fv(C.fields.reqLink) : true, designLink: !!fv(C.fields.designLink),
    noDesign: !!fv(C.fields.noDesign), designLinkAt,
    st, vev: evs.map((e) => ({ t: e.t, who: e.who, add: e.add.map((a) => a[1]), rem: e.rem.map((a) => a[1]) })), iv, comments,
  };
}

// Все продукты подряд; ошибка одного не останавливает остальные. Возвращает { <id>: data | null, … }.
export async function collectAll(log = () => {}, now = Date.now()) {
  const m = missing();
  if (m.length) throw new Error(`Не заполнены настройки плагина: ${m.join(", ")}`);
  const out = {}, errors = [];
  let vers = null;
  for (const P of PRODUCTS) {
    try { vers ||= await projectVersions(); out[P.id] = await collect((m) => log(`${P.short}: ${m}`), now, P.id, vers); }
    catch (e) { out[P.id] = null; errors.push(`${P.short}: ${e.message || e}`); log(`${P.short}: ошибка ${e.message || e}`); }
  }
  if (errors.length === PRODUCTS.length) throw new Error(errors.join(" · "));
  return out;
}
async function projectVersions() {
  const out = {};
  for (const p of PROJECTS) out[p] = await api("GET", `/rest/api/3/project/${p}/versions`);
  return out;
}
export async function collect(log = () => {}, now = Date.now(), pid, vers = null) {
  const today = iso(now), P = product(pid);
  vers ||= await projectVersions();
  // 1. версии «<Продукт> ДД/ММ/ГГГГ» во всех проектах
  const versions = {};
  for (const p of PROJECTS) {
    for (const v of vers[p]) {
      const date = verDate(v.name, P);
      if (!date || v.archived) continue;
      (versions[date] ||= {})[p] = { id: v.id, name: v.name, released: !!v.released, releaseDate: v.releaseDate || null };
    }
  }
  const dates = Object.keys(versions).sort();
  const past = dates.filter((d) => d < today), future = dates.filter((d) => d >= today);
  const pick = [
    past.length ? { date: past[past.length - 1], slot: "prev", mode: "fact" } : null,
    future[0] ? { date: future[0], slot: "cur", mode: "forecast" } : null,
    future[1] ? { date: future[1], slot: "next", mode: "plan" } : null,
  ].filter(Boolean);
  // Старт спринта: следующий день после прошлого релиза (или за 13 дней до релиза); поправить — в панели, карточка релиза.
  const releases = pick.map((r) => {
    const i = dates.indexOf(r.date);
    const start = i > 0 ? addDays(dates[i - 1], 1) : addDays(r.date, -13);
    const prodRd = versions[r.date][PJ.epic]?.releaseDate;
    return { ...r, name: dd(r.date), start, cutoff: prodRd && prodRd >= r.date ? prodRd : r.date, ids: Object.fromEntries(Object.entries(versions[r.date]).map(([p, v]) => [p, v.id])) };
  });
  const relIds = Object.fromEntries(releases.map((r) => [r.date, new Set(Object.values(r.ids))]));
  const prodIds = releases.map((r) => r.ids[PJ.epic]).filter(Boolean);
  const taskIds = releases.flatMap((r) => TASK_PROJECTS.map((p) => r.ids[p])).filter(Boolean);
  const olderProd = past.filter((d) => !releases.some((r) => r.date === d)).map((d) => versions[d][PJ.epic]?.id).filter(Boolean);
  const pastTaskIds = past.flatMap((d) => TASK_PROJECTS.map((p) => versions[d][p]?.id)).filter(Boolean);

  // 2. эпики, их задачи и подзадачи, задачи релизов вне эпиков, хвосты прошлых версий
  log(`релизы: ${releases.map((r) => r.name).join(", ")}`);
  const L = (a) => a.join(", ");
  const TP = L(TASK_PROJECTS);
  let epics = [];
  if (prodIds.length) {
    let jql = `project = ${PJ.epic} AND (fixVersion WAS IN (${L(prodIds)}) OR fixVersion in (${L(prodIds)}))`;
    if (olderProd.length) jql = `project = ${PJ.epic} AND (fixVersion WAS IN (${L(prodIds)}) OR fixVersion in (${L([...prodIds, ...olderProd])}))`;
    epics = await search(jql);
  }
  log(`эпиков ${PJ.epic}: ${epics.length}`);
  const kids = [];
  for (const c of chunks(epics.map((e) => e.key), 50)) kids.push(...(await search(`parent in (${L(c)})`)));
  const sub = [];
  for (const c of chunks(kids.map((k) => k.key), 50)) sub.push(...(await search(`parent in (${L(c)})`)));
  const have = new Set([...epics, ...kids, ...sub].map((x) => x.key));
  const orphRaw = taskIds.length ? (await search(`project in (${TP}) AND (fixVersion WAS IN (${L(taskIds)}) OR fixVersion in (${L(taskIds)}))`)).filter((o) => !have.has(o.key)) : [];
  orphRaw.forEach((o) => have.add(o.key));
  const tailRaw = pastTaskIds.length ? (await search(`project in (${TP}) AND fixVersion in (${L(pastTaskIds)}) AND statusCategory != Done`)).filter((o) => !have.has(o.key)) : [];
  log(`задач в эпиках: ${kids.length + sub.length}, вне эпиков: ${orphRaw.length}, хвосты прошлых версий: ${tailRaw.length}`);
  const all = [...epics, ...kids, ...sub, ...orphRaw, ...tailRaw];
  const logs = await changelogs(all.map((r) => r.id));
  log(`история: ${Object.values(logs).reduce((s, x) => s + x.length, 0)} записей`);

  // 3. нормализация
  const byParent = {};
  for (const k of [...kids, ...sub]) (byParent[k.fields.parent.key] ||= []).push(k);
  const allKids = (key) => (byParent[key] || []).flatMap((k) => [norm(k, logs, relIds), ...allKids(k.key)]);
  const outEpics = [];
  for (const e of epics) {
    const n = norm(e, logs, relIds);
    if (n.products.length && !n.products.includes(P.field || P.name)) continue;
    const inAny = Object.values(n.iv).some((iv) => iv.length) || n.versions.some((v) => verDate(v, P) && verDate(v, P) < today);
    if (!inAny) continue;
    n.tasks = allKids(e.key);
    outEpics.push(n);
  }
  const keep = (t) => !(t.versions.length && !t.versions.some((v) => v.includes(verName(P))));
  const orph = orphRaw.map((o) => norm(o, logs, relIds)).filter(keep);
  const tails = tailRaw.map((o) => norm(o, logs, relIds)).filter(keep);
  const sums = Object.fromEntries(all.map((r) => [r.key, r.fields.summary]));
  const miss = [...new Set([...orph, ...tails].map((t) => t.parent).filter((p) => p && !sums[p]))];
  for (const c of chunks(miss, 50)) for (const r of await search(`key in (${L(c)})`, ["summary"])) sums[r.key] = r.fields.summary;
  for (const t of [...orph, ...tails]) t.parentSummary = t.parent ? sums[t.parent] || "" : "";

  // порядок приоритетов Jira (от высшего к низшему) — для сортировки кейсов в боте ПМ
  let priorities = [];
  try { priorities = ((await api("GET", "/rest/api/3/priority/search?maxResults=100")).values || []).map((p) => p.name); }
  catch { try { priorities = (await api("GET", "/rest/api/3/priority")).map((p) => p.name); } catch { priorities = []; } }
  const data = { schema: "release-dashboard/1", product: P.id, generated: now, today, releases, versions, priorities, epics: outEpics, orph, tails };
  writeJson(dataFile(P), data);
  log(`готово: ${outEpics.length} эпиков, ${outEpics.reduce((s, e) => s + e.tasks.length, 0)} задач`);
  return data;
}

// =====================================================================
// Итоги по релизам (из template.html разбора 11.11 / 25.11)
// =====================================================================
export const RES = {
  done: ["Сделано", "good"], qa: ["Разработано, не протестировано", "info"], partial: ["Частично", "warn"], notdone: ["Не сделано", "bad"],
  moved: ["Перенесено", "purple"], parked: ["Отложено / снято", "muted"],
  ok: ["Успевает", "info"], risk: ["Под риском", "warn"], high: ["Высокий риск", "serious"], wont: ["Не успеет", "bad"],
  n_ready: ["Готов к разработке", "good"], n_design: ["В дизайне", "warn"], n_qa: ["QA-анализ", "warn"], n_req: ["Требования", "bad"], n_notask: ["Нет задач разработки", "serious"],
};
const ORDERS = {
  fact: ["done", "qa", "partial", "notdone", "moved", "parked"],
  forecast: ["done", "ok", "risk", "high", "wont", "moved", "parked"],
  plan: ["done", "n_ready", "n_notask", "n_design", "n_qa", "n_req", "moved", "parked"],
};
const SORT = { wont: 0, notdone: 1, n_req: 1, high: 2, n_qa: 2, risk: 3, n_design: 3, n_notask: 3, partial: 4, qa: 5, n_ready: 5, moved: 6, parked: 7, ok: 8, done: 9 };
export const RC = {
  design: "Дизайн не готов", req: "Требования или QA-анализ не готовы", notask: "Нет задач разработки", notstarted: "Разработка не начата",
  partstart: "Часть задач не начата", test: "Задачи не протестированы / в тесте", work: "Задачи ещё в разработке", hold: "Пауза или возврат на доработку",
  dlate: "Дизайн появился уже в спринте", rlate: "Готов к разработке только в спринте", added: "Добавлен в релиз после старта", scope: "В эпик добавили задачи после старта",
};

function taskStats(e, C, S) {
  const g = { done: 0, test: 0, work: 0, hold: 0, kick: 0, todo: 0, total: 0, added: 0, later: 0 };
  for (const t of e.tasks.filter(isMash)) {
    const s = statusAt(t, C);
    if (s == null) { g.later++; continue; }
    g[grp(s)]++; g.total++;
    if (t.created > S) g.added++;
  }
  return g;
}
function designAt(e, C) {
  let ds = e.tasks.filter((t) => !!PJ.design && t.project === PJ.design && t.created <= C);
  const stories = ds.filter((t) => t.type !== "Sub-task");
  if (stories.length) ds = stories;
  if (ds.length) {
    const sts = ds.map((t) => statusAt(t, C));
    if (sts.every((s) => s === ST.designDone)) {
      const last = Math.max(...ds.map((t) => lastTo(t, ST.designDone, C) || t.created));
      let first = Math.max(...ds.map((t) => { const x = t.st.find((y) => y.to === ST.designDone && y.t <= C); return x ? x.t : t.created; }));
      if (e.designLinkAt && e.designLinkAt < first) first = e.designLinkAt;
      return { state: "ready", at: first, last, src: ds.map((t) => t.key).join(", ") };
    }
    return { state: "notready", src: ds.map((t, i) => t.key + " «" + sts[i] + "»").join(", ") };
  }
  const ph = phase(statusAt(e, C));
  if (e.designLinkAt && e.designLinkAt <= C && ph !== "design") return { state: "ready", at: e.designLinkAt, src: "ссылка на дизайн в эпике" };
  if (ph === "design") return { state: "notready", src: "эпик в «" + statusAt(e, C) + "»" };
  if (e.noDesign) return { state: "none", src: "отмечено «Не нужен дизайн»" };
  return { state: "none", src: "дизайн-задачи нет" };
}
function devReadyAt(e, C) {
  const ok = (s) => ["ready", "dev", "done"].includes(phase(s)); let r = null;
  for (const x of e.st) { if (x.t > C) break; if (ok(x.to) && !ok(x.from)) r = x.t; }
  return r;
}
function exitInfo(it, date, from, to) {
  let best = null;
  for (const [, b] of it.iv[date] || []) if (b != null && b > from && b <= to && (best == null || b > best)) best = b;
  if (best == null) return null;
  const ev = (it.vev || []).find((x) => x.t === best) || { add: [], who: "" };
  return { t: best, to: mver(ev.add).map(shortV), who: ev.who };
}

function classify(e, r, now) {
  const { S, C } = r, iv = e.iv[r.date] || [];
  if (!iv.length) return null;
  const atStart = inSlot(iv, S), during = iv.some(([a, b]) => (b == null || b > S) && a <= C);
  const o = { e, S, C };
  if (atStart) o.origin = "plan";
  else if (during) { o.origin = "added"; o.addedAt = Math.min(...iv.filter(([a]) => a > S && a <= C).map((x) => x[0])); }
  else if (iv.some(([a]) => a <= S)) { o.origin = "pre"; o.pre = exitInfo(e, r.date, -Infinity, S); return o; }
  else return null;
  o.inNow = inSlot(iv, now);
  o.move = inSlot(iv, C) ? null : exitInfo(e, r.date, S, C);
  const T = o.move ? o.move.t : C;
  o.T = T; o.status = statusAt(e, T); o.ph = phase(o.status);
  o.g = taskStats(e, T, S); o.gNow = taskStats(e, now, S);
  o.d = designAt(e, T); o.ready = devReadyAt(e, T);
  o.bucket = BUCKET.test(e.summary);
  const g = o.g, R = []; let res, score = 0;
  const add = (n, c, t) => { score += n; R.push({ c, t }); };
  const allDone = g.total > 0 && g.done === g.total;
  if (o.move) {
    res = o.ph === "parked" ? "parked" : "moved";
    add(0, "move", "Перенесли → " + (o.move.to.length ? o.move.to.join(", ") : "без релиза") + " (" + fd(o.move.t) + (o.move.who ? ", " + o.move.who : "") + ")");
    add(0, "info", "Статус эпика в момент переноса: «" + o.status + "»");
  } else if (o.ph === "done" || allDone) res = "done";
  else if (o.ph === "parked") res = "parked";
  else if (r.mode === "fact") res = g.total > 0 && g.todo + g.work + g.hold + g.kick === 0 ? "qa" : g.done > 0 ? "partial" : "notdone";
  else if (r.mode === "plan") res = o.ph === "pre" ? "n_req" : o.ph === "qa" ? "n_qa" : o.ph === "design" || o.d.state === "notready" ? "n_design" : g.total === 0 ? "n_notask" : "n_ready";
  if (res !== "done") {
    if (!o.bucket) {
      if (o.d.state === "notready") add(3, "design", "Дизайн не готов: " + o.d.src);
      if (o.ph === "pre") add(3, "req", "Требования не готовы: эпик в «" + o.status + "»");
      if (o.ph === "qa") add(3, "req", "QA-анализ не завершён: эпик в «" + o.status + "»");
    }
    if (g.total === 0) add(2, "notask", "Нет задач разработки");
    else if (g.todo === g.total) add(2, "notstarted", "Разработка не начата: все " + g.total + " задач в Backlog / To Do");
    else if (g.todo > 0) add(1, "partstart", "Не начаты " + g.todo + " из " + g.total + " задач");
    if (g.test) add(0, "test", (r.mode === "fact" ? "Не протестированы к релизу: " : "Ждут или идут в тесте: ") + g.test + " из " + g.total);
    if (g.work) add(0, "work", "В разработке: " + g.work + " из " + g.total);
    if (g.hold || g.kick) add((g.hold ? 1 : 0) + (g.kick ? 1 : 0), "hold", [g.hold ? "на паузе (On Hold): " + g.hold : "", g.kick ? "возврат на доработку (Kickback): " + g.kick : ""].filter(Boolean).join(", ").replace(/^./, (c) => c.toUpperCase()));
  }
  if (r.mode !== "plan") {
    if (o.d.state === "ready" && o.d.at > S) add(res === "done" ? 0 : 1, "dlate", "Дизайн появился только " + fd(o.d.at) + " — уже в спринте");
    if (o.ready && o.ready > S && !o.bucket) add(0, "rlate", "Готов к разработке только " + fd(o.ready));
    if (o.origin === "added") add(0, "added", "Добавлен в релиз " + fd(o.addedAt) + " — после старта спринта");
    if (g.added) add(0, "scope", "В эпик добавлено задач после старта: " + g.added);
  }
  if (e.comments.length) { const c = e.comments[e.comments.length - 1]; add(0, "comment", "Комментарий " + c.t.slice(8, 10) + "." + c.t.slice(5, 7) + " (" + c.who + "): " + c.text.split("\n")[0].slice(0, 160)); }
  if (r.mode === "forecast" && !res) res = score >= 3 ? "wont" : score === 2 ? "high" : score === 1 ? "risk" : "ok";
  o.res = res; o.reasons = R; o.score = score;
  return o;
}

function details(o) {
  const e = o.e, S = o.S, T = o.T, ev = [];
  for (const v of e.vev) { const a = mver(v.add).map(shortV), m = mver(v.rem).map(shortV); if (a.length || m.length) ev.push({ t: v.t, v: true, txt: "Релиз: " + (m.length ? m.join(", ") : "—") + " → " + (a.length ? a.join(", ") : "без релиза"), who: v.who }); }
  for (const s of e.st) ev.push({ t: s.t, v: false, txt: "«" + (s.from || "") + "» → «" + s.to + "»", who: s.who });
  ev.sort((a, b) => a.t - b.t);
  const from = S - 21 * DAY;
  const hist = ev.filter((x) => x.t >= from).map((x) => ({ at: fdt(x.t), txt: x.txt, who: x.who, after: x.t > S, v: x.v }));
  const groups = [];
  for (const [p, title] of [[PJ.dev, `Разработка (${PJ.dev})`], [PJ.design, `Дизайн (${PJ.design})`], [PJ.qa, `QA-анализ (${PJ.qa})`], [PJ.epic, `Подзадачи ${PJ.epic}`]].filter(([p]) => p)) {
    const ts_ = e.tasks.filter((t) => t.project === p);
    if (!ts_.length) continue;
    ts_.sort((a, b) => Number(grp(statusAt(a, T)) === "done") - Number(grp(statusAt(b, T)) === "done") || a.created - b.created);
    groups.push({
      title, total: ts_.length,
      tasks: ts_.slice(0, 40).map((t) => {
        const sa = statusAt(t, T);
        const isD = (x) => G.done.includes(x) || x === ST.designDone || x === ST.qaDone;
        const dn = isD(t.status) ? t.st.filter((x) => isD(x.to)).map((x) => x.t).pop() : null;
        return { key: t.key, url: t.url, summary: t.summary.slice(0, 110), statusAt: sa, status: t.status, assignee: t.assignee, created: fd(t.created), after: t.created > S, done: dn ? fd(dn) : null, other: p === PJ.dev && !isMash(t), versions: t.versions.map(shortV) };
      }),
    });
  }
  return { hist, since: fd(from), groups, comments: e.comments, created: fd(e.created) };
}

function prepRelease(r, notes, now) {
  const start = notes.cfg.starts[r.date] || r.start;
  const cutoff = notes.cfg.cutoffs[r.date] || r.cutoff;
  const S = r.mode === "plan" ? Math.min(endOf(start), now) : endOf(start);
  const C = r.mode === "fact" ? endOf(cutoff) : now;
  return { ...r, start, cutoff, S, C };
}

// =====================================================================
// Кейсы вне нормы
// =====================================================================
export const GROUPS = { tail: "Хвосты релиза", notready: "Не готово к разработке", scope: "Изменения скоупа", stuck: "Застряло" };
export const CODES = {
  ver_unreleased: ["tail", "Версия не выпущена в Jira"],
  tail_epic: ["tail", "Релиз прошёл, эпик не закрыт"],
  tail_task: ["tail", "Релиз прошёл, задача не готова"],
  status_lag: ["tail", "Задачи готовы, статус эпика не проставлен"],
  phase_early: ["notready", "Требования или QA-анализ не готовы"],
  design_notready: ["notready", "Дизайн не готов"],
  no_req: ["notready", "Нет ссылки на требования"],
  no_tasks: ["notready", "Нет задач разработки"],
  no_assignee: ["notready", "Нет исполнителя"],
  moved_out: ["scope", "Перенесли из релиза"],
  added_late: ["scope", "Добавили после старта спринта"],
  scope_growth: ["scope", "В эпик добавили задачи после старта"],
  ver_mismatch: ["scope", "Задачи эпика без релиза"],
  epic_task_later: ["scope", "Релиз задачи позже релиза эпика"],
  hold: ["stuck", "На паузе (On Hold)"],
  kick: ["stuck", "Возврат на доработку (Kickback)"],
  no_move: ["stuck", `Нет движения ${STUCK_DAYS}+ раб. дня`],
  orphan: ["stuck", "Задача релиза без эпика в релизе"],
};

function findAnomalies(data, rels, rowsByDate, now) {
  const A = [], today = iso(now);
  const push = (code, sev, rel, it, text, extra = {}) => A.push({ id: `${code}:${it?.key || rel}:${rel || ""}`, code, group: CODES[code][0], sev, rel, relName: rel ? dd(rel) : "", key: it?.key || "", url: it?.url || "", title: it?.summary || "", priority: it?.priority || "", prio: prioRank(it?.priority, data.priorities || []), text, product: CUR.id, epicCase: !!it && it.project === PJ.epic, ...extra, id: idPre(CUR.id) + (extra.id || `${code}:${it?.key || rel}:${rel || ""}`) });
  const cur = rels.find((r) => r.slot === "cur"), next = rels.find((r) => r.slot === "next");
  const taskPool = new Map();
  for (const e of data.epics) for (const t of e.tasks) taskPool.set(t.key, { t, epic: e });
  for (const t of [...data.orph, ...data.tails]) if (!taskPool.has(t.key)) taskPool.set(t.key, { t, epic: null });

  // --- хвосты: версии, эпики и задачи в прошедших релизах
  for (const date of Object.keys(data.versions).sort()) {
    if (date >= today) continue;
    const notRel = PROJECTS.filter((p) => data.versions[date][p] && !data.versions[date][p].released);
    if (notRel.length) { const vs = notRel.map((p) => ({ p, url: `${SITE}/projects/${p}/versions/${data.versions[date][p].id}` })); push("ver_unreleased", date >= addDays(today, -30) ? 2 : 1, date, null, `Версия ${dd(date)} не выпущена в Jira: ${notRel.join(", ")}`, { vers: vs, vname: data.versions[date][notRel[0]].name, url: vs[0].url }); }
  }
  for (const e of data.epics) {
    for (const v of e.versions) {
      const date = verDate(v);
      if (!date || date >= today || closedEpic(e.status)) continue;
      const g = taskStats(e, now, 0);
      const ready = e.status === ST.epicReady;
      push("tail_epic", ready ? 1 : 3, date, e, ready ? `${dd(date)} прошёл, эпик в «${ST.epicReady}» — поставьте «${ST.epicReleased}»` : `${dd(date)} прошёл, эпик в «${e.status}»${g.total ? `, разработка ${g.done}/${g.total} готово` : ""} — перенести или закрыть`);
    }
  }
  const tailByRel = {};
  for (const { t, epic } of taskPool.values()) {
    if (isFinal(t)) continue;
    for (const v of t.versions) {
      const date = verDate(v);
      if (!date || date >= today) continue;
      if (epic && epic.versions.some((x) => verDate(x) === date) && !closedEpic(epic.status)) { (tailByRel[epic.key + date] ||= []).push(t); continue; }
      push("tail_task", 1, date, t, `${dd(date)} прошёл, задача в «${t.status}»${t.assignee ? ` (${t.assignee})` : ""}${epic ? ` · эпик ${epic.key} уже не в ${dd(date)}` : ""}`, { parent: epic?.key || t.parent || "" });
    }
  }
  // задачи хвостовых эпиков — одной строкой к эпику, а не по штуке
  for (const a of A) if (a.code === "tail_epic") { const ts_ = tailByRel[a.key + a.rel]; if (ts_?.length) a.more = `Не в конечном статусе ${ts_.length}: ${ts_.slice(0, 8).map((t) => t.key).join(", ")}${ts_.length > 8 ? "…" : ""}`; }

  // --- релиз задачи позже релиза эпика: эпик 11.11, задача 25.11 — так нельзя (любой релиз)
  for (const e of data.epics) {
    const eDates = e.versions.map(verDate).filter(Boolean).sort();
    if (!eDates.length || [ST.canceled, ST.rejected].includes(e.status)) continue;
    const eDate = eDates[eDates.length - 1], later = {};
    for (const t of e.tasks) {
      if (isFinal(t) || !TASK_PROJECTS.includes(t.project) || (t.project === PJ.dev && !isMash(t))) continue;
      const tDates = t.versions.map(verDate).filter(Boolean).sort();
      const tDate = tDates[tDates.length - 1];
      if (tDate && tDate > eDate) (later[tDate] ||= []).push(t);
    }
    for (const [tDate, ts_] of Object.entries(later)) {
      push("epic_task_later", 2, eDate, e, `Эпик в ${dd(eDate)}, а ${ts_.length} ${ts_.length === 1 ? "задача" : "задач"} в ${dd(tDate)}: ${ts_.slice(0, 6).map((t) => t.key).join(", ")}${ts_.length > 6 ? "…" : ""}`,
        { id: `epic_task_later:${e.key}:${tDate}`, laterRel: tDate, laterKeys: ts_.map((t) => t.key), mashKeys: ts_.filter((t) => t.project === PJ.dev).map((t) => t.key) });
    }
  }

  for (const r of rels) {
    for (const o of rowsByDate[r.date] || []) {
      const e = o.e;
      if (!o.inNow || o.move) continue;
      if (o.gNow.total > 0 && o.gNow.done === o.gNow.total && !["done", "parked"].includes(phase(e.status)))
        push("status_lag", 2, r.date, e, `Все ${o.gNow.total} задач разработки готовы, а эпик в «${e.status}» — поставьте «${ST.epicReady}»`);
    }
  }

  // --- текущий релиз: готовность, скоуп, застрявшее
  if (cur) {
    const daysLeft = Math.round((ms(cur.date) - ms(today)) / DAY);
    for (const o of rowsByDate[cur.date] || []) {
      const e = o.e, ph = phase(e.status), closed = ["done", "parked"].includes(ph);
      if (o.move) { push("moved_out", 1, cur.date, e, `Перенесли из ${cur.name} → ${o.move.to.length ? o.move.to.join(", ") : "без релиза"} (${fd(o.move.t)}${o.move.who ? ", " + o.move.who : ""}), статус «${o.status}»`); continue; }
      if (!o.inNow || closed) continue;
      if (o.origin === "added") push("added_late", 1, cur.date, e, `Добавили в ${cur.name} ${fd(o.addedAt)} — после старта спринта ${dd(cur.start)}`);
      if (o.gNow.added) push("scope_growth", 1, cur.date, e, `В эпик добавили задач после старта: ${o.gNow.added}`);
      if (!o.bucket) {
        if (ph === "pre" || ph === "qa") push("phase_early", 3, cur.date, e, `Спринт идёт, а эпик в «${e.status}»: ${ph === "pre" ? "требования" : "QA-анализ"} не готов${ph === "pre" ? "ы" : ""}`);
        const d = designAt(e, now);
        if (d.state === "notready") push("design_notready", daysLeft <= DESIGN_WARN_DAYS ? 3 : 2, cur.date, e, `Дизайн не готов: ${d.src} · до релиза ${daysLeft} дн.`);
        if (!e.reqLink) push("no_req", 2, cur.date, e, "В эпике пустое поле «Ссылка на требования»");
      }
      if (o.gNow.total === 0 && !["pre", "qa", "design"].includes(ph)) push("no_tasks", 2, cur.date, e, `В эпике нет задач разработки, а эпик в «${e.status}»`);
      if (!e.assignee) push("no_assignee", 1, cur.date, e, "У эпика нет исполнителя");
      // задачи эпика без релиза (позже эпика — отдельное правило epic_task_later, раньше — хвосты)
      const noVer = [];
      for (const t of e.tasks) {
        if (isDoneTask(t) || t.project !== PJ.dev || !isMash(t)) continue;
        if (!t.versions.some((v) => verDate(v))) noVer.push(t.key);
      }
      if (noVer.length) push("ver_mismatch", 1, cur.date, e, `Без релиза ${noVer.length}: ${noVer.slice(0, 5).join(", ")}${noVer.length > 5 ? "…" : ""}`, { mashKeys: noVer });
    }
    // задачи текущего релиза (в эпиках релиза и вне эпиков)
    const curEpics = new Set((rowsByDate[cur.date] || []).filter((o) => o.inNow && !o.move).map((o) => o.e.key));
    const seen = new Set();
    for (const { t, epic } of taskPool.values()) {
      const inRel = (epic && curEpics.has(epic.key)) || t.versions.some((v) => verDate(v) === cur.date);
      if (!inRel || seen.has(t.key) || isDoneTask(t) || t.project === PJ.epic || (t.project === PJ.dev && !isMash(t))) continue;
      seen.add(t.key);
      const g = grp(t.status);
      const parent = epic?.key || t.parent || "";
      if (t.project === PJ.dev && !t.assignee && g !== "todo") push("no_assignee", 1, cur.date, t, `Задача в «${t.status}» без исполнителя`, { parent });
      if (g === "hold") push("hold", 2, cur.date, t, `На паузе (On Hold)${t.assignee ? `, ${t.assignee}` : ""}`, { parent });
      if (g === "kick") push("kick", 2, cur.date, t, `Возврат на доработку (Kickback)${t.assignee ? `, ${t.assignee}` : ""}`, { parent });
      if (t.project === PJ.dev && (g === "work" || g === "test")) {
        const last = t.st.length ? t.st[t.st.length - 1].t : t.created;
        const wd = workdays(last, now);
        if (wd >= STUCK_DAYS) push("no_move", wd >= STUCK_DAYS + 2 ? 2 : 1, cur.date, t, `В «${t.status}» ${wd} раб. дн. без движения${t.assignee ? ` (${t.assignee})` : ""}`, { parent });
      }
      if (!epic || !curEpics.has(epic.key)) push("orphan", 1, cur.date, t, `${t.project} в ${cur.name}, ${t.parent ? `родитель ${t.parent} не в релизе` : "без эпика"} · «${t.status}»`, { parent });
    }
  }
  // --- следующий релиз: за неделю до старта его спринта всё должно быть готово к разработке
  if (next) {
    const toStart = Math.round((ms(next.start) - ms(today)) / DAY);
    if (toStart <= DESIGN_WARN_DAYS) {
      for (const o of rowsByDate[next.date] || []) {
        const e = o.e, ph = phase(e.status);
        if (!o.inNow || ["done", "parked"].includes(ph) || o.bucket) continue;
        if (ph === "pre" || ph === "qa") push("phase_early", 2, next.date, e, `До старта спринта ${next.name} ${toStart} дн., эпик в «${e.status}»`);
        else if (designAt(e, now).state === "notready") push("design_notready", 2, next.date, e, `До старта спринта ${next.name} ${toStart} дн., дизайн не готов`);
        else if (o.gNow.total === 0) push("no_tasks", 1, next.date, e, `До старта спринта ${next.name} ${toStart} дн., нет задач разработки`);
        if (!e.reqLink) push("no_req", 1, next.date, e, "В эпике пустое поле «Ссылка на требования»");
      }
    }
  }
  const uniq = new Map();
  for (const a of A) if (!uniq.has(a.id)) uniq.set(a.id, a);
  return [...uniq.values()];
}

// =====================================================================
// Вид для панели и Telegram
// =====================================================================
function latestSnapshot(before, p = CUR) {
  try {
    const f = fs.readdirSync(histDir(p)).filter((x) => /^anomalies-\d{4}-\d{2}-\d{2}\.json$/.test(x) && x.slice(10, 20) < before).sort().pop();
    return f ? readJson(path.join(histDir(p), f)) : null;
  } catch { return null; }
}

// Вид по одному продукту: продукт берётся из data.product. notes не передали — правки PO этого продукта.
// =====================================================================
// Известные проблемы (вариант B «Только Jira», решения PO 19.11)
// ПМ пишет в задаче Jira причину и срок («до 26.11») или ставит метку. Бот в Jira не пишет, только читает.
// Состояния: known — до срока не дёргаем ПМ и продакта; long — срок дальше maxDays, ждёт продакта;
// overdue — срок прошёл, проблема осталась; nodate — комментарий есть, срока нет.
// =====================================================================
export const KNOWN_DEFAULT = { maxDays: 14, labels: [{ label: "тест-на-проде", mode: "days", days: 7 }, { label: "ios-позже", mode: "next" }] };
export const knownCfg = (notes) => {
  const k = notes?.cfg?.known || {};
  return { maxDays: Number.isFinite(k.maxDays) ? k.maxDays : KNOWN_DEFAULT.maxDays, labels: Array.isArray(k.labels) ? k.labels : KNOWN_DEFAULT.labels };
};
const KNOWN_TAIL = new Set(["tail_task", "tail_epic"]);
const MON = [["январ", 1], ["феврал", 2], ["март", 3], ["апрел", 4], ["ма", 5], ["июн", 6], ["июл", 7], ["август", 8], ["сентябр", 9], ["октябр", 10], ["ноябр", 11], ["декабр", 12]];
const pad2 = (n) => String(n).padStart(2, "0");
const okDate = (y, m, d) => { if (m < 1 || m > 12 || d < 1 || d > 31) return null; const x = `${y}-${pad2(m)}-${pad2(d)}`; return iso(ms(x)) === x ? x : null; };
// Срок из текста: «до 26.11», «26.11.2026», «до 26 ноября», «25 числа», «неделю», «2 недели», «5 дней», «3 раб. дня».
// base — день комментария (ГГГГ-ММ-ДД). Берём дату после «до», иначе самую позднюю; даты раньше комментария не считаем.
export function dateFromText(text, base) {
  const t = String(text || "").toLowerCase().replace(/ё/g, "е").replace(/https?:\/\/\S+/g, " ");
  const y0 = +base.slice(0, 4), m0 = +base.slice(5, 7), d0 = +base.slice(8, 10);
  const lim = addDays(base, 366), out = [];
  const add = (date, i) => { if (date && date >= base && date <= lim) out.push({ date, pre: /до\s*$/.test(t.slice(Math.max(0, i - 4), i)) }); };
  const fix = (y, m, d) => { const x = okDate(y, m, d); return x && x < base ? okDate(y + 1, m, d) : x; };
  for (const m of t.matchAll(/(?<![\d.])(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?(?![\d.])/g)) {
    const y = m[3] ? (m[3].length === 2 ? 2000 + +m[3] : +m[3]) : null;
    add(y ? okDate(y, +m[2], +m[1]) : fix(y0, +m[2], +m[1]), m.index);
  }
  for (const m of t.matchAll(/(?<!\d)(\d{1,2})\s+([а-я]+)/g)) {
    const mo = MON.find(([p]) => m[2].startsWith(p) && (p !== "ма" || /^ма[яй]$/.test(m[2])));
    if (mo) add(fix(y0, mo[1], +m[1]), m.index);
  }
  for (const m of t.matchAll(/(?<!\d)(\d{1,2})(?:-?го)?\s+числа/g)) {
    const d = +m[1];
    add(d >= d0 ? okDate(y0, m0, d) : okDate(m0 === 12 ? y0 + 1 : y0, m0 === 12 ? 1 : m0 + 1, d), m.index);
  }
  for (const m of t.matchAll(/(?<!\d)(\d{1,2})?\s*(раб\.?\s*|рабочих\s+)?(дн[а-я]*|день|недел[а-я]*)/g)) {
    if (!m[1] && !/^недел/.test(m[3])) continue;
    const n = +(m[1] || 1);
    if (/^недел/.test(m[3])) add(addDays(base, 7 * n), m.index);
    else if (m[2]) { let d = base, k = 0; while (k < n) { d = addDays(d, 1); const wd = new Date(ms(d) + TZ).getUTCDay(); if (wd !== 0 && wd !== 6) k++; } add(d, m.index); }
    else add(addDays(base, n), m.index);
  }
  if (!out.length) return null;
  const pre = out.filter((x) => x.pre);
  return (pre.length ? pre : out).map((x) => x.date).sort().pop();
}
// Первый день, когда кейс попал в снимок (history/).
const firstSeenCache = new Map();
function firstSeen(p) {
  const dir = histDir(p);
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => /^anomalies-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort(); } catch { return new Map(); }
  const sig = files.join("|"), c = firstSeenCache.get(p.id);
  if (c && c.sig === sig) return c.map;
  const map = new Map();
  for (const f of files) for (const id of readJson(path.join(dir, f), {})?.ids || []) if (!map.has(id)) map.set(id, f.slice(10, 20));
  firstSeenCache.set(p.id, { sig, map });
  return map;
}
// Контекст для knownOf: задачи по ключу, эпик задачи, имена ПМ и продактов в Jira, отметки бота, ответы продакта.
function knownCtx(data, notes, today, P, io = {}) {
  const issues = new Map(), epicOf = new Map();
  for (const e of data.epics) { issues.set(e.key, e); for (const t of e.tasks) { issues.set(t.key, t); epicOf.set(t.key, e.key); } }
  for (const t of [...(data.orph || []), ...(data.tails || [])]) if (!issues.has(t.key)) issues.set(t.key, t);
  const names = new Map(); // имя в Jira (нижний регистр) → логин Telegram
  for (const kind of ["pms", "pos"]) for (const x of notes.cfg[kind] || []) if (x.jira) names.set(String(x.jira).trim().toLowerCase(), x.login);
  const claims = io.claims || readJson(path.join(OUT_DIR, "pm-claims.json"), {}) || {};
  const asks = io.asks || readJson(path.join(OUT_DIR, "pm-asks.json"), {}) || {};
  const approved = new Set(Object.values(asks).filter((x) => x.auto === "long" && x.status === "answered" && x.answer?.opt === "ok").map((x) => x.id));
  const vers = Object.keys(data.versions).sort();
  return { issues, epicOf, names, claims, approved, cfg: knownCfg(notes), first: firstSeen(P), today, nextAfter: (d) => vers.find((x) => x > d) || null };
}
const cmMs = (c) => c.ms ?? (Date.parse(c.t + ":00Z") - TZ);
function knownOf(a, X) {
  const mk = (k) => {
    const from = k.from || X.today;
    const state = k.until < X.today ? "overdue" : k.src !== "label" && Math.round((ms(k.until) - ms(from)) / DAY) > X.cfg.maxDays && !X.approved.has(a.id) ? "long" : "known";
    return { ...k, state };
  };
  const c = X.claims[a.id];
  // Срок кнопкой в боте — только для кейсов без задачи (версия не выпущена: у версии нет комментариев).
  if (!a.key) return c?.status === "known" && c.until ? mk({ src: "bot", until: c.until.slice(0, 10), from: c.at.slice(0, 10), login: c.by, text: c.reason || "" }) : null;
  const it = X.issues.get(a.key);
  if (!it) return null;
  const chain = [];
  for (const k of [it.key, it.parent, X.epicOf.get(it.key)]) { const x = k && X.issues.get(k); if (x && !chain.includes(x)) chain.push(x); }
  // Метка — только хвосты релиза; метку можно поставить и на родителя или эпик.
  if (KNOWN_TAIL.has(a.code)) for (const L of X.cfg.labels) {
    const on = chain.find((x) => (x.labels || []).some((l) => l.toLowerCase() === String(L.label).toLowerCase()));
    if (!on) continue;
    const until = L.mode === "next" ? X.nextAfter(a.rel) || addDays(a.rel, 14) : addDays(a.rel, Number(L.days) || 7);
    return mk({ src: "label", label: L.label, until, from: a.rel, key: on.key, url: on.url, onParent: on.key !== a.key, text: `метка «${L.label}»` });
  }
  // Комментарий ПМ или продакта после появления проблемы; в родителе или эпике — действует на все задачи.
  const ref = KNOWN_TAIL.has(a.code) ? a.rel : X.first.get(a.id) || X.today;
  const viaBot = c?.kind === "jira" ? Date.parse(c.at) : null; // ПМ нажал «Написал в Jira»: берём любой комментарий после нажатия
  let best = null;
  for (const x of chain) for (const cm of x.comments || []) {
    if (x !== it && !KNOWN_TAIL.has(a.code)) continue; // родитель и эпик — только для хвостов релиза (та же проблема у всех задач)
    const t = cmMs(cm), day = iso(t);
    if (day < ref) continue;
    const login = X.names.get(String(cm.who).trim().toLowerCase()) || null;
    if (!login && !(viaBot && t >= viaBot - 60e3)) continue;
    if (!best || t > best.t) best = { t, day, cm, x, login };
  }
  if (!best) return null;
  const until = dateFromText(best.cm.text, best.day);
  const k = { src: "comment", who: best.cm.who, login: best.login, text: best.cm.text.slice(0, 300), at: new Date(best.t).toISOString(), from: best.day, key: best.x.key, url: best.x.url, onParent: best.x.key !== a.key, viaBot: !best.login };
  return until ? mk({ ...k, until }) : { ...k, state: "nodate" };
}

export function view(data, notes, now = Date.now(), io = {}) {
  if (!data) return null;
  const P = prodOf(data);
  return withProd(P, () => viewOf(data, notes || loadNotes(P.id), now ?? Date.now(), P, io));
}
function viewOf(data, notes, now, P, io = {}) {
  const today = iso(now);
  const rev = readJson(revFile(P), {}) || {}; // ожидаемая выручка эпиков, если файл есть
  const rels = data.releases.map((r) => prepRelease(r, notes, now));
  const rowsByDate = {};
  const releases = rels.map((r) => {
    const all = data.epics.map((e) => classify(e, r, now)).filter(Boolean);
    rowsByDate[r.date] = all.filter((o) => o.origin !== "pre");
    const R = (o) => notes.over[r.date + ":" + o.e.key] || o.res;
    const rows = rowsByDate[r.date].map((o) => ({
      key: o.e.key, url: o.e.url, summary: o.e.summary, status: o.e.status, versions: o.e.versions.map(shortV),
      origin: o.origin, addedAt: o.addedAt ? fd(o.addedAt) : null, res: R(o), resAuto: o.res, score: o.score, reasons: o.reasons,
      codes: [...new Set(o.reasons.map((x) => x.c))], g: o.g, gNow: o.gNow, move: o.move ? { ...o.move, at: fd(o.move.t) } : null,
      d: { state: o.d.state, at: o.d.at ? fd(o.d.at) : null, last: o.d.last && fd(o.d.last) !== fd(o.d.at) ? fd(o.d.last) : null, inSprint: o.d.state === "ready" && o.d.at > o.S, src: o.d.src },
      rev: rev[o.e.key] ?? null, note: notes.notes[r.date + ":" + o.e.key] || "", over: notes.over[r.date + ":" + o.e.key] || null,
      inNow: o.inNow, isEpic: true, details: details(o), sort: SORT[R(o)] ?? 9,
    })).sort((a, b) => a.sort - b.sort || (a.origin === b.origin ? 0 : a.origin === "plan" ? -1 : 1) || a.key.localeCompare(b.key, "en", { numeric: true }));
    const pre = all.filter((o) => o.origin === "pre").map((o) => ({ key: o.e.key, url: o.e.url, summary: o.e.summary, status: o.e.status, versions: o.e.versions.map(shortV), at: o.pre ? fd(o.pre.t) : "—", who: o.pre?.who || "", to: o.pre?.to || [] }));
    const counts = {};
    for (const x of rows) counts[x.res] = (counts[x.res] || 0) + 1;
    const orph = data.orph.map((t) => {
      const iv = t.iv[r.date] || [];
      if (!iv.length) return null;
      const atS = inSlot(iv, r.S), during = iv.some(([a, b]) => (b == null || b > r.S) && a <= r.C);
      if (!atS && !during) return null;
      const moved = !inSlot(iv, r.C);
      const sa = statusAt(t, moved ? (exitInfo(t, r.date, r.S, r.C) || { t: r.C }).t : r.C);
      return { key: t.key, url: t.url, type: t.type, project: t.project, summary: t.summary, parent: t.parent, parentSummary: t.parentSummary || "", added: atS ? null : fd(Math.min(...iv.filter(([a]) => a > r.S).map((x) => x[0]))), moved, statusAt: sa, g: grp(sa), status: t.status, created: fd(t.created), assignee: t.assignee };
    }).filter(Boolean).sort((a, b) => (a.parent || "").localeCompare(b.parent || "") || a.key.localeCompare(b.key, "en", { numeric: true }));
    return {
      slot: r.slot, mode: r.mode, date: r.date, name: r.name, start: r.start, cutoff: r.cutoff,
      startLabel: dd(r.start), workdaysLeft: r.mode === "fact" ? 0 : workdays(now, ms(r.date)), daysLeft: Math.round((ms(r.date) - ms(today)) / DAY),
      startDaysLeft: Math.round((ms(r.start) - ms(today)) / DAY), startWorkdaysLeft: r.start > today ? workdays(now, ms(r.start)) : 0,
      released: Object.fromEntries(PROJECTS.filter((p) => data.versions[r.date]?.[p]).map((p) => [p, data.versions[r.date][p].released])),
      order: ORDERS[r.mode], rows, pre, counts, orph,
      plan: rows.filter((x) => x.origin === "plan").length, added: rows.filter((x) => x.origin === "added").length,
    };
  });
  const found = findAnomalies(data, rels, rowsByDate, now);
  const prevSnap = latestSnapshot(today);
  const prevIds = prevSnap ? new Set(prevSnap.ids) : null;
  const KX = knownCtx(data, notes, today, P, io);
  const anomalies = found.map((a) => ({ ...a, label: CODES[a.code][1], isNew: prevIds ? !prevIds.has(a.id) : false, ack: notes.ack[a.id] || null, known: knownOf(a, KX) }))
    .sort((a, b) => Number(!!a.ack) - Number(!!b.ack) || b.sev - a.sev || Number(b.isNew) - Number(a.isNew) || a.code.localeCompare(b.code) || a.key.localeCompare(b.key, "en", { numeric: true }));
  const moveTargets = Object.keys(data.versions).filter((d) => d >= today).sort().map((d) => ({ date: d, name: dd(d) + (d.slice(0, 4) !== today.slice(0, 4) ? "." + d.slice(2, 4) : "") }));
  return {
    product: P.id, productName: P.name, productShort: P.short, productEmoji: P.emoji, products: PRODUCTS,
    generated: data.generated, generatedLabel: fdt(data.generated), today, stale: iso(data.generated) !== today,
    releases, anomalies, prevSnapDate: prevSnap?.date || null, moveTargets,
    meta: { res: RES, rc: RC, groups: GROUPS, codes: Object.fromEntries(Object.entries(CODES).map(([k, v]) => [k, { group: v[0], label: v[1] }])), stuckDays: STUCK_DAYS, designWarnDays: DESIGN_WARN_DAYS },
    tg: { chatId: notes.cfg.tg.chatId || null, chatTitle: notes.cfg.tg.title || null, lastSent: notes.cfg.tg.lastSent || null, tokenSet: !!C.tgToken, chatFromSettings: !!C.tgChatId },
    jira: { site: SITE, projects: { ...PJ }, missing: missing() },
    outDir: OUT_DIR,
  };
}

export function saveSnapshot(v) {
  if (!v) return;
  const ids = v.anomalies.filter((a) => !a.ack).map((a) => a.id);
  writeJson(path.join(histDir(product(v.product)), `anomalies-${v.today}.json`), { date: v.today, generated: v.generated, ids, counts: Object.fromEntries(Object.keys(GROUPS).map((g) => [g, v.anomalies.filter((a) => a.group === g && !a.ack).length])) });
}

// =====================================================================
// Ручные правки (итог, причина, скрытие кейса, даты спринта)
// =====================================================================
export function setOverride(date, key, res, pid) { const n = loadNotes(pid); if (res) n.over[date + ":" + key] = res; else delete n.over[date + ":" + key]; saveNotes(n); return { ok: true }; }
export function setNote(date, key, text, pid) { const n = loadNotes(pid); if (text) n.notes[date + ":" + key] = text; else delete n.notes[date + ":" + key]; saveNotes(n); return { ok: true }; }
export function setAck(id, note, pid = idProd(id)) { const n = loadNotes(pid); if (note === null) delete n.ack[id]; else n.ack[id] = { at: new Date().toISOString(), note: note || "" }; saveNotes(n); return { ok: true }; }
export function setDates(date, start, cutoff, pid) {
  const n = loadNotes(pid);
  if (start) n.cfg.starts[date] = start; else delete n.cfg.starts[date];
  if (cutoff) n.cfg.cutoffs[date] = cutoff; else delete n.cfg.cutoffs[date];
  saveNotes(n); return { ok: true };
}

// =====================================================================
// Telegram
// =====================================================================
const EMO = { tail: "🔴", notready: "🟠", scope: "🟡", stuck: "🔵" };
export const h = (s) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
// opts.po — строки продакта (🧭 вопросы, 🚦 готовность); opts.footer — последняя строка (по умолчанию — про панель bb).
export function telegramText(v, perGroup = 5, opts = {}) {
  const po = opts.po !== false;
  const L = [`<b>${v.productEmoji || ""} Релизы ${v.productName || ""} · ${v.generatedLabel}</b>`.replace("<b> ", "<b>")];
  for (const r of v.releases) {
    const c = (k) => r.counts[k] || 0, total = r.rows.length;
    if (r.mode === "fact") L.push("", `<b>${r.name} — итог</b> · ${total} эпиков: сделано ${c("done")} · не протестировано ${c("qa")} · частично ${c("partial")} · не сделано ${c("notdone")} · перенесли ${c("moved") + c("parked")}`);
    if (r.mode === "forecast") L.push("", `<b>${r.name} — прогноз</b> · ${r.daysLeft <= 0 ? "сегодня релиз" : `через ${r.workdaysLeft} раб. дн.`} · ${total} эпиков`, `готово ${c("done")} · успевает ${c("ok")} · под риском ${c("risk")} · высокий риск ${c("high")} · не успеет ${c("wont")}${c("moved") + c("parked") ? ` · перенесли ${c("moved") + c("parked")}` : ""}`);
    if (r.mode === "plan") L.push("", `<b>${r.name} — следующий</b> · ${total} эпиков: готовы к разработке ${c("n_ready")} · в дизайне ${c("n_design")} · QA ${c("n_qa")} · требования ${c("n_req")} · нет задач ${c("n_notask")}`);
  }
  // Режим PO (pm.mjs): вопросы ПМ без ответа и готовность следующего релиза за 7 дней до старта спринта.
  const asks = Object.values(readJson(path.join(OUT_DIR, "pm-asks.json"), {}) || {}), present = new Set(v.anomalies.map((a) => a.id));
  const waiting = asks.filter((x) => x.status === "open" && present.has(x.id)).sort((a, b) => a.at.localeCompare(b.at));
  const nx = v.releases.find((r) => r.mode === "plan");
  const notReady = nx ? nx.rows.filter((x) => READY_GAP.includes(x.res)).length : 0;
  const poLines = [];
  if (waiting.length) poLines.push(`🧭 <b>Ждут решения продакта: ${waiting.length}</b> · первый вопрос ${fdt(Date.parse(waiting[0].at))} — кнопка «🧭 Ждут моего решения»`);
  if (nx && nx.startDaysLeft >= 0 && nx.startDaysLeft <= READY_WARN_DAYS && notReady) poLines.push(`🚦 <b>Старт спринта ${nx.name} ${nx.startDaysLeft ? `через ${nx.startWorkdaysLeft} раб. дн.` : "сегодня"}</b>: не готовы к разработке ${notReady} из ${nx.rows.length} — кнопка «🚦 Готовность релиза»`);
  if (po && poLines.length) L.push("", ...poLines);
  const isKnown = (a) => a.known?.state === "known";
  const knownN = v.anomalies.filter((a) => !a.ack && isKnown(a)).length, overN = v.anomalies.filter((a) => !a.ack && a.known?.state === "overdue").length;
  const act = v.anomalies.filter((a) => !a.ack && !isKnown(a)), news = act.filter((a) => a.isNew).length;
  L.push("", `<b>Вне нормы: ${act.length}</b>${v.prevSnapDate ? ` · новых ${news} с ${dd(v.prevSnapDate)}` : ""}`);
  if (knownN || overN) L.push(`💬 Известные: ${knownN} — причина и срок в Jira, делать ничего не нужно${overN ? ` · ⏰ срок прошёл: ${overN}` : ""}`);
  const blocks = [];
  for (const [g, title] of Object.entries(GROUPS)) {
    const list = act.filter((a) => a.group === g);
    if (!list.length) continue;
    const byCode = {};
    for (const a of list) byCode[a.code] = (byCode[a.code] || 0) + 1;
    const kinds = Object.entries(byCode).sort((a, b) => b[1] - a[1]).map(([c, n]) => `${CODES[c][1].toLowerCase()} ${n}`).join(" · ");
    const cut = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
    const top = list.slice(0, perGroup).map((a) => `• ${a.known?.state === "overdue" ? "⏰ " : ""}${a.isNew ? "🆕 " : ""}${a.key ? `<a href="${a.url}">${a.key}</a> ` : ""}${a.title ? h(cut(a.title, 40)) + " — " : ""}${h(cut(a.text, 110))}`);
    blocks.push([`${EMO[g]} <b>${title} — ${list.length}</b>`, `<i>${h(kinds)}</i>`, ...top, ...(list.length > perGroup ? [`  …ещё ${list.length - perGroup}`] : [])].join("\n"));
  }
  if (!blocks.length) L.push("Всё в норме.");
  else L.push(blocks.join("\n\n"));
  const ackN = v.anomalies.length - act.length;
  L.push("", `${ackN ? `Скрыто PO: ${ackN}. ` : ""}${opts.footer || "Подробно — панель «Релизы» в bb."}`);
  const text = L.join("\n");
  return text.length > 4000 && perGroup > 1 ? telegramText(v, perGroup - 1, opts) : text.slice(0, 4090);
}
export async function tg(method, body) {
  const tok = env("TELEGRAM_BOT_TOKEN");
  if (!tok) throw new Error("Нет TELEGRAM_BOT_TOKEN в переменных пользователя Windows");
  const r = await fetch(`https://api.telegram.org/bot${tok}/${method}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
  const j = await r.json();
  if (!j.ok) throw new Error(`Telegram ${method}: ${j.description || r.status}`);
  return j.result;
}
// Чат — из последнего сообщения боту (/start в личке или упоминание в группе).
// Когда плагин слушает бота (режим ПМ, pm.mjs), сообщения забирает он: чат берём из pm-state.json (lastOther — не ПМ).
export async function detectChat() {
  const st = readJson(path.join(OUT_DIR, "pm-state.json"));
  let chat = st?.lastOther?.chat || null;
  if (!chat) {
    const ups = await tg("getUpdates", { limit: 50 });
    const msgs = ups.map((u) => u.message || u.my_chat_member || u.channel_post).filter(Boolean);
    chat = msgs.pop()?.chat || null;
  }
  if (!chat) return { ok: false, error: "Боту ещё никто не писал. Напишите вашему боту /start и нажмите ещё раз." };
  const title = chat.title || [chat.first_name, chat.last_name].filter(Boolean).join(" ") || chat.username || String(chat.id);
  const n = loadNotes(); n.cfg.tg.chatId = chat.id; n.cfg.tg.title = title; saveNotes(n);
  journal({ action: "tg_chat", title });
  return { ok: true, title };
}
export async function sendTelegram(v, by = "кнопка") {
  const n = loadNotes();
  if (!n.cfg.tg.chatId) throw new Error("Чат Telegram не выбран: напишите боту /start и нажмите «Найти чат»");
  const text = telegramText(v);
  await tg("sendMessage", { chat_id: n.cfg.tg.chatId, text, parse_mode: "HTML", disable_web_page_preview: true });
  n.cfg.tg.lastSent = { at: new Date().toISOString(), by, date: v.today };
  saveNotes(n);
  journal({ action: "tg_send", by, chars: text.length, anomalies: v.anomalies.filter((a) => !a.ack).length });
  return { ok: true, chars: text.length };
}

// =====================================================================
// Запись в Jira (из панели, по кнопке пользователя)
// =====================================================================
export async function jiraTransitions(key) {
  const r = await api("GET", `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`);
  return (r.transitions || []).map((t) => ({ id: t.id, name: t.name, to: t.to?.name || t.name }));
}
export async function jiraTransition(key, id, by = "панель") {
  const tr = (await jiraTransitions(key)).find((t) => t.id === id);
  if (!tr) throw new Error(`Переход ${id} недоступен для ${key}`);
  await api("POST", `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`, { transition: { id } });
  journal({ action: "transition", key, to: tr.to, by });
  return { ok: true, to: tr.to };
}
async function setIssueRelease(key, date, versions, P) {
  const r = await api("GET", `/rest/api/3/issue/${encodeURIComponent(key)}?fields=fixVersions,project`);
  const p = r.fields.project.key;
  const keep = (r.fields.fixVersions || []).filter((v) => !verDate(v.name, P));
  let add = null;
  if (date) {
    add = versions[date]?.[p];
    if (!add) throw new Error(`${key}: в проекте ${p} нет версии ${verName(P)} ${dd(date)}`);
  }
  const before = (r.fields.fixVersions || []).map((v) => v.name);
  await api("PUT", `/rest/api/3/issue/${encodeURIComponent(key)}`, { fields: { fixVersions: [...keep.map((v) => ({ id: v.id })), ...(add ? [{ id: add.id }] : [])] } });
  return { key, before, after: [...keep.map((v) => v.name), ...(add ? [add.name] : [])] };
}
// Перенос релиза: эпик и (по желанию) его незакрытые задачи разработки, дизайна и QA, у которых стоял тот же релиз.
export async function jiraSetRelease(key, date, withChildren, by = "панель", pid) {
  const P = product(pid), data = loadData(P.id);
  if (!data) throw new Error(`Нет данных ${P.name} — сначала обновите данные`);
  const done = [], errors = [];
  const e = data.epics.find((x) => x.key === key);
  try { done.push(await setIssueRelease(key, date, data.versions, P)); } catch (err) { errors.push(String(err.message || err)); }
  if (withChildren && e && !errors.length) {
    const old = new Set(e.versions.map((v) => verDate(v, P)).filter(Boolean));
    for (const t of e.tasks) {
      if (!TASK_PROJECTS.includes(t.project) || isDoneTask(t)) continue;
      if (!t.versions.some((v) => old.has(verDate(v, P)))) continue;
      try { done.push(await setIssueRelease(t.key, date, data.versions, P)); } catch (err) { errors.push(String(err.message || err)); }
    }
  }
  journal({ action: "set_release", product: P.id, key, to: date ? dd(date) : "без релиза", withChildren, changed: done.map((d) => d.key), errors, by });
  return { ok: !errors.length, changed: done.map((d) => d.key), errors };
}
