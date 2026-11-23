// Управление скиллом prd: настройки, метки в текстах, цепочка, агенты, версии, журнал, черновики.
// Источник правды — ~/.claude/skills/prd/settings.json. Тексты скилла держат значения в метках:
//   <!--p:KEY-->значение<!--/p-->          число или строка из params (":code" — в обратных кавычках)
//   <!--c:KEY#SLOT-->текст<!--/c-->        текст варианта выбора (params[KEY].slots[SLOT][value])
//   <!--a:prd-agent-->Модель · уровень<!--/a-->   модель из шапки файла агента
//   <!--gen:flow.ID--> … <!--/gen-->       шаги цепочки из settings.flows[ID]
// Места без меток (код, шапка SKILL.md) — params[KEY].plain: шаблон с {v} или слот выбора.
// Плагин bb «Конвейер PRD» импортирует этот модуль и вызывает configure() с папками из настроек;
// из командной строки папки берутся из переменных окружения (см. configure).
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

// Тесты подменяют папки: PRD_SKILL_TEST=<папка> -> <папка>/home/.claude/{skills/prd,agents}, <папка>/data.
const TEST = process.env.PRD_SKILL_TEST;
const HOME = TEST ? path.join(TEST, "home") : os.homedir();
const hasSettings = (dir) => !!dir && fs.existsSync(path.join(dir, "settings.json"));

// Где установлен навык prd: копия для правки в ~/.claude/skills/prd, иначе кэш плагина Claude Code
// prd-pipeline (самая свежая версия). Кэш плагина перезаписывается при обновлении плагина.
export function findSkill(home = HOME) {
  const own = path.join(home, ".claude", "skills", "prd");
  if (hasSettings(own)) return { dir: own, kind: "user" };
  const found = [];
  const cache = path.join(home, ".claude", "plugins", "cache");
  if (fs.existsSync(cache)) {
    for (const market of fs.readdirSync(cache)) {
      const p = path.join(cache, market, "prd-pipeline");
      if (!fs.existsSync(p)) continue;
      for (const ver of fs.readdirSync(p)) {
        const dir = path.join(p, ver, "skills", "prd");
        if (hasSettings(dir)) found.push({ dir, mtime: fs.statSync(path.join(dir, "settings.json")).mtimeMs });
      }
    }
  }
  found.sort((a, b) => b.mtime - a.mtime);
  return found.length ? { dir: found[0].dir, kind: "plugin" } : { dir: own, kind: "missing" };
}
// Агенты рядом с навыком: <плагин>/agents, если навык лежит в плагине; иначе ~/.claude/agents.
export function agentsFor(skillDir, home = HOME) {
  const pluginRoot = path.resolve(skillDir, "..", "..");
  if (fs.existsSync(path.join(pluginRoot, ".claude-plugin"))) return path.join(pluginRoot, "agents");
  return path.join(home, ".claude", "agents");
}

export let DATA;
export let LIVE;
export let SKILL_KIND = "user";
let DIRS, JOURNAL, STATE, EVALS;
const SKIP = [/^evals\/reference-check\//, /(^|\/)node_modules\//, /(^|\/)\.DS_Store$/];

// Папки модуля. Пустое значение — по умолчанию:
//   skill    PRD_SKILL_DIR или findSkill()
//   agents   PRD_AGENTS_DIR или agentsFor(skill)
//   disabled рядом с agents: <agents>/../agents-disabled
//   data     PRD_DATA_DIR или ~/.config/bb-prd-pipeline (журнал, версии, черновики)
export function configure(opts = {}) {
  const env = TEST ? {} : process.env;
  const found = opts.skill || env.PRD_SKILL_DIR ? null : findSkill();
  const skill = path.resolve(opts.skill || env.PRD_SKILL_DIR || found.dir);
  SKILL_KIND = found ? found.kind : "custom";
  const agents = path.resolve(opts.agents || env.PRD_AGENTS_DIR || agentsFor(skill));
  const disabled = opts.disabled ? path.resolve(opts.disabled) : path.join(path.dirname(agents), "agents-disabled");
  DATA = path.resolve(opts.data || (TEST ? path.join(TEST, "data") : env.PRD_DATA_DIR || path.join(HOME, ".config", "bb-prd-pipeline")));
  LIVE = { skill, agents, disabled };
  DIRS = { versions: path.join(DATA, "versions"), drafts: path.join(DATA, "drafts") };
  JOURNAL = path.join(DATA, "journal.jsonl");
  STATE = path.join(DATA, "state.json");
  EVALS = path.join(DATA, "evals.json");
  return { ...LIVE, data: DATA, kind: SKILL_KIND };
}
configure();

// Копия для правки: навык и агенты плагина -> ~/.claude/skills/prd и ~/.claude/agents.
// Не перезаписывает: если навык или агент уже есть — отказ.
export function copyToUser(home = HOME) {
  const toSkill = path.join(home, ".claude", "skills", "prd");
  const toAgents = path.join(home, ".claude", "agents");
  if (fs.existsSync(toSkill)) throw new Error(`Уже есть ${toSkill}: копия не нужна или удалите её сами`);
  const files = listFiles(LIVE);
  const clash = Object.keys(files).filter((rel) => agentName(rel) && fs.existsSync(path.join(toAgents, `${agentName(rel)}.md`)));
  if (clash.length) throw new Error(`В ${toAgents} уже есть ${clash.map(agentName).join(", ")}`);
  copyRoot(LIVE, { skill: toSkill, agents: toAgents, disabled: path.join(home, ".claude", "agents-disabled") });
  return configure({ skill: toSkill, agents: toAgents, data: DATA });
}

export const draftRoot = (id) => {
  const d = path.join(DIRS.drafts, id);
  return { skill: path.join(d, "skill"), agents: path.join(d, "agents"), disabled: path.join(d, "agents-disabled") };
};

// ---------- files ----------
function readText(abs) {
  const raw = fs.readFileSync(abs, "utf8");
  const bom = raw.startsWith("\uFEFF");
  const s = bom ? raw.slice(1) : raw;
  const crlf = s.includes("\r\n");
  return { text: crlf ? s.replace(/\r\n/g, "\n") : s, crlf, bom };
}
function writeText(abs, text, fmt = {}) {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  let out = fmt.crlf ? text.replace(/\r?\n/g, "\r\n") : text;
  if (fmt.bom) out = "\uFEFF" + out;
  fs.writeFileSync(abs, out, "utf8");
}
const readJson = (abs, dflt = null) => {
  try {
    return JSON.parse(readText(abs).text);
  } catch {
    return dflt;
  }
};
const writeJson = (abs, v) => writeText(abs, JSON.stringify(v, null, 2) + "\n");
const sha = (s) => crypto.createHash("sha1").update(s).digest("hex").slice(0, 12);
const isText = (rel) => /\.(md|json|js|mjs|cjs|txt|ya?ml|html|css)$/i.test(rel);

function walk(dir, base = dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    const rel = path.relative(base, abs).split(path.sep).join("/");
    if (SKIP.some((r) => r.test(rel + (e.isDirectory() ? "/" : "")))) continue;
    if (e.isDirectory()) walk(abs, base, out);
    else out.push(rel);
  }
  return out;
}

// rel -> { abs, disabled }; агенты — "agents/prd-x.md" независимо от того, включены они или нет.
export function listFiles(root = LIVE) {
  const files = {};
  for (const rel of walk(root.skill)) files[rel] = { abs: path.join(root.skill, rel), disabled: false };
  for (const [dir, disabled] of [
    [root.disabled, true],
    [root.agents, false],
  ]) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) if (/^prd-[\w-]+\.md$/.test(f)) files[`agents/${f}`] = { abs: path.join(dir, f), disabled };
  }
  return files;
}
const agentAbs = (root, name, disabled) => path.join(disabled ? root.disabled : root.agents, `${name}.md`);
const agentName = (rel) => /^agents\/(prd-[\w-]+)\.md$/.exec(rel)?.[1] ?? null;

export function hashAll(root = LIVE) {
  const out = {};
  for (const [rel, f] of Object.entries(listFiles(root))) {
    const body = isText(rel) ? readText(f.abs).text : fs.readFileSync(f.abs);
    out[rel] = sha(body) + (f.disabled ? ":off" : "");
  }
  return out;
}

// ---------- settings and agents ----------
export const readSettings = (root = LIVE) => {
  const s = readJson(path.join(root.skill, "settings.json"));
  if (!s) throw new Error(`Нет settings.json в ${root.skill}`);
  return s;
};
const unquote = (v) => v.trim().replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
const LIMIT_RE = /(Лимит работы:\s*не больше\s+)(\d+)(\s+вызовов инструментов или\s+)(\d+)(\s+минут)/;

export function parseAgent(text) {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  const fields = {};
  for (const line of (m?.[1] ?? "").split("\n")) {
    const kv = /^([A-Za-z_][\w-]*):\s?(.*)$/.exec(line);
    if (kv) fields[kv[1]] = unquote(kv[2]);
  }
  const lim = LIMIT_RE.exec(text);
  return {
    model: fields.model ?? "",
    effort: fields.effort ?? "",
    tools: fields.tools ?? "",
    description: fields.description ?? "",
    calls: lim ? Number(lim[2]) : null,
    minutes: lim ? Number(lim[4]) : null,
  };
}

function setField(text, key, val) {
  const m = /^---\n([\s\S]*?)\n---/.exec(text);
  if (!m) throw new Error("У файла агента нет шапки ---");
  let fm = m[1];
  const line = new RegExp(`^${key}:.*$`, "m");
  if (val === "" || val == null) fm = fm.replace(new RegExp(`^${key}:.*(\\n|$)`, "m"), "");
  else if (line.test(fm)) fm = fm.replace(line, `${key}: ${val}`);
  else {
    const anchor = key === "effort" && /^model:.*$/m.test(fm) ? /^model:.*$/m : /^description:.*$/m;
    fm = anchor.test(fm) ? fm.replace(anchor, (l) => `${l}\n${key}: ${val}`) : `${fm}\n${key}: ${val}`;
  }
  return text.replace(m[0], `---\n${fm.replace(/\n+$/, "")}\n---`);
}

export function readAgents(root = LIVE) {
  const out = {};
  for (const [rel, f] of Object.entries(listFiles(root))) {
    const name = agentName(rel);
    if (!name) continue;
    const text = readText(f.abs).text;
    out[name] = { name, rel, ...parseAgent(text), state: f.disabled ? "disabled" : "active", file: f.abs, updatedAt: fs.statSync(f.abs).mtime.toISOString() };
  }
  return out;
}

const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : "");
export const agentLabel = (a, S) => [a.model ? (S.modelNames?.[a.model] ?? cap(a.model)) : "модель треда", a.effort].filter(Boolean).join(" · ");

// ---------- render ----------
const fmtVal = (v, code) => (code ? "`" + v + "`" : String(v));
const pMarker = (key, code, v) => `<!--p:${key}${code ? ":code" : ""}-->${fmtVal(v, code)}<!--/p-->`;
const RE = {
  p: /<!--p:([\w.]+)(:code)?-->([\s\S]*?)<!--\/p-->/g,
  a: /<!--a:([\w-]+)-->([\s\S]*?)<!--\/a-->/g,
  c: /<!--c:([\w.]+)#([\w-]+)-->([\s\S]*?)<!--\/c-->/g,
  gen: /(<!--gen:flow\.([\w-]+)-->\n)([\s\S]*?)(\n<!--\/gen-->)/g,
};
export const stripMarkers = (s) =>
  s.replace(/<!--gen:[\w.-]+-->\n/g, "").replace(/\n<!--\/gen-->/g, "").replace(/<!--\/?(?:p|a|c)(?::[^>]*)?-->/g, "");

export function fill(text, S, plainValues = false) {
  return String(text ?? "").replace(/\{\{([\w.]+)(:code)?\}\}/g, (m, k, c) => {
    const p = S.params?.[k];
    if (!p) return m;
    return plainValues ? fmtVal(p.value, !!c) : pMarker(k, !!c, p.value);
  });
}

export function flowTags(f) {
  let n = f.numberFrom ?? 0;
  return f.steps.map((st) => (st.kind === "stop" ? "стоп" : st.kind === "final" ? "итог" : String(n++)));
}

export function renderFlow(S, id) {
  const f = S.flows[id];
  const tags = flowTags(f);
  const items = [];
  f.steps.forEach((st, i) => {
    if (!st.gen) return;
    const texted = (st.groups ?? []).map((g) => g.filter((c) => c.text));
    const callsText = texted
      .map((g) => g.map((c) => fill(c.text, S)).join(st.join ?? "; "))
      .filter(Boolean)
      .join(st.seqJoin ?? ", затем ");
    const parallel = texted.some((g) => g.length > 1);
    let body = callsText ? callsText + "." : "";
    if (st.text) body += (body ? " " : "") + fill(st.text, S);
    if (f.gen === "list") {
      if (parallel) body = (f.parallelLead ?? "") + body;
    } else {
      const head = st.kind === "stop" ? "**Стоп-точка.** " : `**Волна ${tags[i]}${parallel ? ", параллельно" : ""}.** `;
      body = head + body;
    }
    if (st.joinPrev && items.length) items[items.length - 1] += " " + body;
    else items.push(body);
  });
  return f.gen === "list" ? items.map((b, i) => `${i + 1}. ${b}`).join("\n") : items.join("\n\n");
}

const plainOf = (p, v) => (p.slot ? null : p.pattern.split("{v}").join(String(v)));

// Переписывает метки и места без меток по настройкам S. prevS — настройки до правки (для мест без меток).
export function renderText(rel, text, ctx, prevS = ctx.S) {
  const { S, agents } = ctx;
  let t = text.replace(RE.gen, (m, a, id, _body, b) => (S.flows?.[id]?.gen ? a + renderFlow(S, id) + b : m));
  t = t.replace(RE.c, (m, k, slot) => {
    const p = S.params?.[k];
    const txt = p?.slots?.[slot]?.[p.value];
    return txt == null ? m : `<!--c:${k}#${slot}-->${fill(txt, S)}<!--/c-->`;
  });
  t = t.replace(RE.p, (m, k, c) => {
    const p = S.params?.[k];
    return p ? pMarker(k, !!c, p.value) : m;
  });
  t = t.replace(RE.a, (m, n) => (agents?.[n] ? `<!--a:${n}-->${agentLabel(agents[n], S)}<!--/a-->` : m));
  for (const [k, p] of Object.entries(S.params ?? {})) {
    for (const pl of p.plain ?? []) {
      if (pl.file !== rel) continue;
      const before = prevS.params?.[k]?.value ?? p.value;
      if (pl.slot) {
        const texts = Object.values(p.slots?.[pl.slot] ?? {});
        const want = p.slots[pl.slot][p.value];
        const found = texts.find((x) => t.includes(x));
        if (found && found !== want) t = t.split(found).join(want);
      } else {
        const from = plainOf(pl, before);
        const to = plainOf(pl, p.value);
        if (from !== to) t = t.split(from).join(to);
      }
    }
  }
  return t;
}

const lineOf = (text, idx) => text.slice(0, idx).split("\n").length;

// Где в текстах живёт каждый параметр (для вкладки «Параметры»).
export function occurrences(root = LIVE, S = readSettings(root)) {
  const out = Object.fromEntries(Object.keys(S.params).map((k) => [k, []]));
  for (const [rel, f] of Object.entries(listFiles(root))) {
    if (!rel.endsWith(".md") || rel.startsWith("agents/")) continue;
    const text = readText(f.abs).text;
    for (const m of text.matchAll(RE.p)) out[m[1]]?.push({ file: rel, line: lineOf(text, m.index) });
    for (const m of text.matchAll(RE.c)) out[m[1]]?.push({ file: rel, line: lineOf(text, m.index), slot: m[2] });
    for (const [k, p] of Object.entries(S.params)) {
      for (const pl of p.plain ?? []) {
        if (pl.file !== rel) continue;
        const needle = pl.slot ? p.slots[pl.slot][p.value] : plainOf(pl, p.value);
        const i = text.indexOf(needle);
        out[k].push({ file: rel, line: i >= 0 ? lineOf(text, i) : 0, plain: true });
      }
    }
  }
  if (out["__"] === undefined) delete out["__"];
  return out;
}

// ---------- check ----------
export function check(root = LIVE) {
  const problems = [];
  let S;
  try {
    S = readSettings(root);
  } catch (e) {
    return [{ file: "settings.json", line: 0, kind: "settings", text: String(e.message ?? e) }];
  }
  const agents = readAgents(root);
  const ctx = { S, agents };
  const genSeen = new Set();
  for (const [rel, f] of Object.entries(listFiles(root))) {
    if (!rel.endsWith(".md") || rel.startsWith("agents/")) continue;
    const text = readText(f.abs).text;
    for (const t of ["p", "a", "c"]) {
      const open = (text.match(new RegExp(`<!--${t}:`, "g")) ?? []).length;
      const close = (text.match(new RegExp(`<!--/${t}-->`, "g")) ?? []).length;
      if (open !== close) problems.push({ file: rel, line: 0, kind: "broken", text: `Метки ${t}: открыто ${open}, закрыто ${close}` });
    }
    for (const m of text.matchAll(RE.p)) {
      const p = S.params[m[1]];
      if (!p) problems.push({ file: rel, line: lineOf(text, m.index), kind: "unknown", key: m[1], text: `Нет параметра ${m[1]} в settings.json` });
      else if (m[3] !== fmtVal(p.value, !!m[2]))
        problems.push({ file: rel, line: lineOf(text, m.index), kind: "value", key: m[1], found: m[3].replace(/`/g, ""), expected: String(p.value), text: `${p.label}: в тексте ${m[3]}, в настройках ${p.value}` });
    }
    for (const m of text.matchAll(RE.a)) {
      const a = agents[m[1]];
      if (!a) problems.push({ file: rel, line: lineOf(text, m.index), kind: "unknown", text: `Нет файла агента ${m[1]}` });
      else if (m[2] !== agentLabel(a, S)) problems.push({ file: rel, line: lineOf(text, m.index), kind: "agent", text: `${m[1]}: в тексте «${m[2]}», в файле агента «${agentLabel(a, S)}»` });
    }
    for (const m of text.matchAll(RE.gen)) genSeen.add(m[2]);
    for (const [k, p] of Object.entries(S.params)) {
      for (const pl of p.plain ?? []) {
        if (pl.file !== rel) continue;
        const needle = pl.slot ? p.slots[pl.slot][p.value] : plainOf(pl, p.value);
        if (!text.includes(needle)) problems.push({ file: rel, line: 0, kind: "plain", key: k, text: `${p.label}: не найдено «${needle}»` });
      }
    }
    const want = renderText(rel, text, ctx);
    if (want !== text && !problems.some((p) => p.file === rel)) {
      const d = lineDiff(stripMarkers(text), stripMarkers(want));
      const first = d.hunks[0]?.lines.find((l) => l.t !== " ");
      problems.push({ file: rel, line: first?.a ?? first?.b ?? 0, kind: "drift", text: "Текст отличается от настроек (блок цепочки или вариант выбора)" });
    }
  }
  for (const [id, f] of Object.entries(S.flows ?? {})) {
    if (f.gen && !genSeen.has(id)) problems.push({ file: "SKILL.md", line: 0, kind: "gen", text: `Нет блока цепочки <!--gen:flow.${id}-->` });
    for (const st of f.steps ?? [])
      for (const c of (st.groups ?? []).flat())
        if (/^prd-/.test(c.actor) && !agents[c.actor]) problems.push({ file: "settings.json", line: 0, kind: "flow", text: `${f.label}: нет агента ${c.actor}` });
  }
  return problems;
}

// ---------- diff ----------
export function lineDiff(a, b, context = 2) {
  const A = a.split("\n");
  const B = b.split("\n");
  let s = 0;
  while (s < A.length && s < B.length && A[s] === B[s]) s++;
  let e = 0;
  while (e < A.length - s && e < B.length - s && A[A.length - 1 - e] === B[B.length - 1 - e]) e++;
  const a1 = A.slice(s, A.length - e);
  const b1 = B.slice(s, B.length - e);
  const n = a1.length;
  const m = b1.length;
  const ops = [];
  for (let k = 0; k < s; k++) ops.push({ t: " ", text: A[k], a: k + 1, b: k + 1 });
  if (n * m > 4e6) {
    a1.forEach((x, i) => ops.push({ t: "-", text: x, a: s + i + 1 }));
    b1.forEach((x, j) => ops.push({ t: "+", text: x, b: s + j + 1 }));
  } else {
    const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a1[i] === b1[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (a1[i] === b1[j]) {
        ops.push({ t: " ", text: a1[i], a: s + i + 1, b: s + j + 1 });
        i++;
        j++;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) ops.push({ t: "-", text: a1[i], a: s + 1 + i++ });
      else ops.push({ t: "+", text: b1[j], b: s + 1 + j++ });
    }
    while (i < n) ops.push({ t: "-", text: a1[i], a: s + 1 + i++ });
    while (j < m) ops.push({ t: "+", text: b1[j], b: s + 1 + j++ });
  }
  for (let k = 0; k < e; k++) ops.push({ t: " ", text: A[A.length - e + k], a: A.length - e + k + 1, b: B.length - e + k + 1 });
  const hunks = [];
  let cur = null;
  let lastChange = -Infinity;
  ops.forEach((op, idx) => {
    if (op.t === " ") return;
    const from = Math.max(0, idx - context);
    if (!cur || from > lastChange + context + 1) {
      cur = { from, to: idx, lines: [] };
      hunks.push(cur);
    }
    cur.to = idx;
    lastChange = idx;
  });
  for (const h of hunks) {
    h.lines = ops.slice(h.from, Math.min(ops.length, h.to + context + 1));
    delete h.from;
    delete h.to;
  }
  return { hunks, added: ops.filter((o) => o.t === "+").length, removed: ops.filter((o) => o.t === "-").length };
}

// ---------- changes ----------
const PARAM_TYPES = ["number", "text", "select", "choice"];
function setParam(S, k, v) {
  const p = S.params[k];
  if (!p) throw new Error(`Нет параметра ${k}`);
  if (p.type === "number") {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`${p.label}: нужно положительное число`);
    if (p.min != null && n < p.min) throw new Error(`${p.label}: не меньше ${p.min}`);
    if (p.max != null && n > p.max) throw new Error(`${p.label}: не больше ${p.max}`);
    p.value = Math.round(n);
  } else if (p.type === "select") {
    if (!p.options.includes(v)) throw new Error(`${p.label}: допустимо ${p.options.join(", ")}`);
    p.value = v;
  } else if (p.type === "choice") {
    if (!p.options.some((o) => o.value === v)) throw new Error(`${p.label}: нет варианта ${v}`);
    p.value = v;
  } else {
    const s = String(v ?? "").trim();
    if (!s || /[<>`\n]/.test(s)) throw new Error(`${p.label}: пустое значение или недопустимые символы`);
    p.value = s;
  }
}

function cleanFlow(flow) {
  const f = structuredClone(flow);
  for (const st of f.steps) {
    st.groups = (st.groups ?? []).map((g) => g.filter((c) => c && c.actor)).filter((g) => g.length);
    for (const c of st.groups.flat()) {
      for (const k of ["in", "out"]) if (Array.isArray(c[k])) c[k] = c[k].map((x) => String(x).trim()).filter(Boolean);
      if (c.count != null && !(c.count > 1)) delete c.count;
    }
  }
  return f;
}

function numberRefsOutsideGen(texts) {
  const out = [];
  for (const [rel, text] of Object.entries(texts)) {
    if (!rel.endsWith(".md") || rel.startsWith("agents/")) continue;
    const plain = text.replace(RE.gen, (m, a, id, body, b) => a + body.replace(/[^\n]/g, " ") + b);
    for (const m of plain.matchAll(/[Вв]олн[аеуыой]{1,2}\s+\d+/g)) out.push({ file: rel, line: lineOf(plain, m.index), text: m[0] });
  }
  return out;
}

// План правки без записи: новые тексты, переносы агентов, предупреждения.
export function planChange(change, root = LIVE) {
  const S0 = readSettings(root);
  const S = structuredClone(S0);
  const files = listFiles(root);
  const cache = {};
  const cur = (rel) => (cache[rel] ??= files[rel] ? readText(files[rel].abs) : { text: "", crlf: false, bom: false });
  const next = {}; // rel -> text
  const moves = {}; // agent name -> disabled boolean
  const warnings = [];
  const agents = readAgents(root);

  switch (change.kind) {
    case "params":
      for (const [k, v] of Object.entries(change.values ?? {})) setParam(S, k, v);
      break;
    case "flow": {
      if (!S.flows[change.flowId]) throw new Error(`Нет цепочки ${change.flowId}`);
      S.flows[change.flowId] = cleanFlow(change.flow);
      const f = S.flows[change.flowId];
      for (const st of f.steps) {
        if (!st.gen) continue;
        const texted = st.groups.flat().some((c) => c.text) || st.text;
        if (!texted) warnings.push(`«${st.title}»: нет текста задания — в SKILL.md шаг будет пустым`);
      }
      break;
    }
    case "roles":
      S.roles = change.roles;
      break;
    case "agent":
    case "agents": {
      // agents: { items: [{ name, patch }], roles: [{ id, patch: { does, writes, runtime } }] }
      const items = change.kind === "agent" ? [{ name: change.name, patch: change.patch }] : (change.items ?? []);
      for (const { name, patch } of items) {
        const a = agents[name];
        if (!a) throw new Error(`Нет агента ${name}`);
        const rel = a.rel;
        let t = next[rel] ?? cur(rel).text;
        const p = patch ?? {};
        if (p.model !== undefined) t = setField(t, "model", p.model);
        if (p.effort !== undefined) t = setField(t, "effort", p.effort);
        if (p.calls != null || p.minutes != null) {
          const calls = Number(p.calls ?? a.calls);
          const minutes = Number(p.minutes ?? a.minutes);
          if (!(calls > 0 && minutes > 0)) throw new Error(`${name}: лимит — положительные числа`);
          if (!LIMIT_RE.test(t)) throw new Error(`В ${rel} нет строки «Лимит работы: не больше N вызовов инструментов или M минут»`);
          t = t.replace(LIMIT_RE, `$1${Math.round(calls)}$3${Math.round(minutes)}$5`);
        }
        if (t !== cur(rel).text) next[rel] = t;
        if (p.enabled !== undefined && p.enabled !== (a.state === "active")) {
          moves[name] = !p.enabled;
          if (!p.enabled) {
            const used = Object.values(S.flows).filter((f) => f.steps.some((st) => (st.groups ?? []).flat().some((c) => c.actor === name)));
            if (used.length) warnings.push(`${name} выключается, но участвует в цепочках: ${used.map((f) => f.label).join(", ")}`);
          }
        }
        if (p.does !== undefined || p.writes !== undefined) {
          const r = S.roles.find((x) => x.id === name);
          if (r) {
            if (p.does !== undefined) r.does = String(p.does);
            if (p.writes !== undefined) r.writes = p.writes;
          }
        }
      }
      for (const { id, patch } of change.roles ?? []) {
        const r = S.roles.find((x) => x.id === id);
        if (!r) throw new Error(`Нет роли ${id}`);
        for (const k of ["role", "does", "writes", "runtime", "fallback"]) if (patch?.[k] !== undefined) r[k] = patch[k];
      }
      break;
    }
    case "role": {
      const r = S.roles.find((x) => x.id === change.id);
      if (!r) throw new Error(`Нет роли ${change.id}`);
      Object.assign(r, change.patch ?? {});
      break;
    }
    case "text": {
      const rel = change.rel;
      if (!files[rel] || !isText(rel)) throw new Error(`Нельзя править ${rel}`);
      const content = String(change.content).replace(/\r\n/g, "\n");
      if (rel === "settings.json") {
        let parsed;
        try {
          parsed = JSON.parse(content);
        } catch (e) {
          throw new Error(`settings.json: ошибка JSON — ${e.message}`);
        }
        Object.keys(S).forEach((k) => delete S[k]);
        Object.assign(S, parsed);
        break;
      }
      if (rel.endsWith(".md") && !rel.startsWith("agents/")) {
        const want = renderText(rel, content, { S, agents });
        if (want !== content) {
          const d = lineDiff(content, want);
          const lines = d.hunks.flatMap((h) => h.lines.filter((l) => l.t === "-").map((l) => l.a));
          throw new Error(
            `Строки ${lines.slice(0, 6).join(", ")}: значения в метках или блок цепочки отличаются от настроек. Числа меняются во вкладке «Параметры», шаги — во вкладке «Цепочка».`,
          );
        }
      }
      if (content !== cur(rel).text) next[rel] = content;
      break;
    }
    case "files": {
      // Готовые тексты (черновик, откат): rel -> text; агенты могут переехать.
      for (const [rel, text] of Object.entries(change.files ?? {})) if (text !== cur(rel).text) next[rel] = text;
      Object.assign(moves, change.moves ?? {});
      break;
    }
    default:
      throw new Error(`Неизвестная правка ${change.kind}`);
  }

  if (change.kind !== "files") {
    // Агенты после правки: из новых текстов шапок.
    const agents2 = structuredClone(agents);
    for (const [rel, t] of Object.entries(next)) {
      const n = agentName(rel);
      if (n) Object.assign(agents2[n], parseAgent(t));
    }
    const ctx = { S, agents: agents2 };
    for (const rel of Object.keys(files)) {
      if (!rel.endsWith(".md") || rel.startsWith("agents/")) continue;
      const base = next[rel] ?? cur(rel).text;
      const r = renderText(rel, base, ctx, S0);
      if (r !== cur(rel).text) next[rel] = r;
      else delete next[rel];
    }
    if (JSON.stringify(S) !== JSON.stringify(S0)) next["settings.json"] = JSON.stringify(S, null, 2) + "\n";
    const order = (f) => (f?.steps ?? []).map((st) => `${st.id}:${st.kind ?? ""}`).join(",");
    if (change.kind === "flow" && order(S0.flows[change.flowId]) !== order(S.flows[change.flowId])) {
      const texts = Object.fromEntries(Object.keys(files).filter((r) => r.endsWith(".md")).map((r) => [r, next[r] ?? cur(r).text]));
      const refs = numberRefsOutsideGen(texts);
      if (refs.length) warnings.push(`Проверь ссылки на номера волн вне цепочки: ${refs.map((r) => `${r.file}:${r.line} «${r.text}»`).join("; ")}`);
    }
  }
  return { next, moves, warnings, fmt: Object.fromEntries(Object.keys(next).map((rel) => [rel, cur(rel)])), S };
}

export function previewChange(change, root = LIVE) {
  const plan = planChange(change, root);
  const files = Object.entries(plan.next).map(([rel, text]) => {
    const before = plan.fmt[rel].text;
    const d = lineDiff(rel.endsWith(".md") ? stripMarkers(before) : before, rel.endsWith(".md") ? stripMarkers(text) : text);
    return { rel, added: d.added, removed: d.removed, hunks: d.hunks, onlyMarkers: d.added + d.removed === 0 };
  });
  const moves = Object.entries(plan.moves).map(([name, disabled]) => ({ name, disabled }));
  return { files, moves, warnings: plan.warnings };
}

function writePlan(plan, root) {
  const files = listFiles(root);
  for (const [rel, text] of Object.entries(plan.next)) {
    const name = agentName(rel);
    const abs = name ? agentAbs(root, name, plan.moves[name] ?? files[rel]?.disabled ?? false) : files[rel]?.abs ?? path.join(root.skill, rel);
    writeText(abs, text, plan.fmt[rel]);
  }
  for (const [name, disabled] of Object.entries(plan.moves)) {
    const rel = `agents/${name}.md`;
    const from = files[rel]?.abs;
    const to = agentAbs(root, name, disabled);
    if (!from || from === to) continue;
    if (plan.next[rel] !== undefined) {
      if (fs.existsSync(from) && from !== to) fs.unlinkSync(from);
    } else {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.renameSync(from, to);
    }
  }
}

// Расхождения текста и настроек: «переписать тексты по настройкам» или «взять числа из текста».
export function fixChange(mode, root = LIVE) {
  if (mode === "adopt") {
    const byKey = {};
    for (const p of check(root)) if (p.kind === "value") (byKey[p.key] ??= new Set()).add(p.found);
    const values = {};
    for (const [k, set] of Object.entries(byKey)) {
      if (set.size !== 1) throw new Error(`${k}: в текстах разные значения (${[...set].join(", ")}) — выбери число во вкладке «Параметры»`);
      const S = readSettings(root);
      values[k] = S.params[k].type === "number" ? Number([...set][0]) : [...set][0];
    }
    if (!Object.keys(values).length) throw new Error("Нет чисел, которые можно взять из текста");
    return { kind: "params", values };
  }
  const S = readSettings(root);
  const ctx = { S, agents: readAgents(root) };
  const files = {};
  for (const [rel, f] of Object.entries(listFiles(root))) {
    if (!rel.endsWith(".md") || rel.startsWith("agents/")) continue;
    const t = readText(f.abs).text;
    const r = renderText(rel, t, ctx);
    if (r !== t) files[rel] = r;
  }
  return { kind: "files", files };
}

// ---------- versions, journal, state ----------
const stamp = (d = new Date()) => {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
};
export function listVersions() {
  if (!fs.existsSync(DIRS.versions)) return [];
  return fs
    .readdirSync(DIRS.versions)
    .filter((d) => /^v\d{4}_/.test(d))
    .sort()
    .map((id) => ({ id, ...(readJson(path.join(DIRS.versions, id, "meta.json"), {}) ?? {}), id }));
}
export function snapshot(root, meta) {
  const vs = listVersions();
  const n = vs.length ? Number(vs[vs.length - 1].id.slice(1, 5)) + 1 : 0;
  const id = `v${String(n).padStart(4, "0")}_${stamp()}`;
  const dir = path.join(DIRS.versions, id);
  for (const [rel, f] of Object.entries(listFiles(root))) {
    const name = agentName(rel);
    const to = name ? path.join(dir, f.disabled ? "agents-disabled" : "agents", `${name}.md`) : path.join(dir, "skill", rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(f.abs, to);
  }
  writeJson(path.join(dir, "meta.json"), { id, ts: new Date().toISOString(), ...meta });
  return id;
}
const versionRoot = (id) => {
  const d = path.join(DIRS.versions, id);
  return { skill: path.join(d, "skill"), agents: path.join(d, "agents"), disabled: path.join(d, "agents-disabled") };
};

export function readJournal() {
  if (!fs.existsSync(JOURNAL)) return [];
  return readText(JOURNAL)
    .text.split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}
export function journal(entry) {
  const all = readJournal();
  const seq = all.length ? all[all.length - 1].seq + 1 : 1;
  const e = { seq, ts: new Date().toISOString(), ...entry };
  fs.mkdirSync(DATA, { recursive: true });
  fs.appendFileSync(JOURNAL, JSON.stringify(e) + "\n", "utf8");
  return e;
}
export const readState = () => readJson(STATE, { hashes: {}, version: null });
export const saveState = (version) => writeJson(STATE, { hashes: hashAll(LIVE), version, ts: new Date().toISOString() });

export function outsideChanges() {
  const st = readState();
  if (!st.version) return [];
  const now = hashAll(LIVE);
  const out = [];
  for (const rel of new Set([...Object.keys(now), ...Object.keys(st.hashes)])) {
    if (now[rel] === st.hashes[rel]) continue;
    out.push({ rel, kind: !st.hashes[rel] ? "new" : !now[rel] ? "deleted" : "changed" });
  }
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

export function acknowledgeOutside(by = "чат") {
  const changed = outsideChanges();
  if (!changed.length) return null;
  const prev = readState().version;
  const version = snapshot(LIVE, { by, title: "Правка вне панели" });
  const e = journal({ by, kind: "outside", title: "Правка вне панели", files: changed.map((c) => c.rel), version, prev });
  saveState(version);
  return e;
}

export function applyChange(change, meta = {}) {
  const plan = planChange(change, LIVE);
  if (!Object.keys(plan.next).length && !Object.keys(plan.moves).length) return { ok: false, message: "Нечего сохранять: всё уже так" };
  acknowledgeOutside();
  writePlan(plan, LIVE);
  const by = meta.by ?? "PO";
  const title = meta.title ?? change.kind;
  const prev = readState().version;
  const version = snapshot(LIVE, { by, title });
  const files = [...Object.keys(plan.next), ...Object.keys(plan.moves).map((n) => `agents/${n}.md`)];
  const e = journal({ by, kind: change.kind, title, files: [...new Set(files)], version, prev, ...(meta.extra ?? {}) });
  saveState(version);
  return { ok: true, entry: e, warnings: plan.warnings };
}

function filesOf(root) {
  const out = {};
  const moves = {};
  for (const [rel, f] of Object.entries(listFiles(root))) {
    if (!isText(rel)) continue;
    out[rel] = readText(f.abs).text;
    const n = agentName(rel);
    if (n) moves[n] = f.disabled;
  }
  return { files: out, moves };
}

// Вернуть скилл к версии: файлы версии перезаписывают текущие; файлы, которых в версии не было, остаются.
export function restoreChange(versionId) {
  const vr = versionRoot(versionId);
  if (!fs.existsSync(vr.skill)) throw new Error(`Нет версии ${versionId}`);
  const { files, moves } = filesOf(vr);
  const live = listFiles(LIVE);
  const realMoves = Object.fromEntries(Object.entries(moves).filter(([n, d]) => live[`agents/${n}.md`] && live[`agents/${n}.md`].disabled !== d));
  return { kind: "files", files, moves: realMoves };
}
export const previewRestore = (versionId) => previewChange(restoreChange(versionId), LIVE);
export function applyRestore(versionId, by = "PO") {
  const meta = listVersions().find((v) => v.id === versionId);
  return applyChange(restoreChange(versionId), { by, title: `Возврат к версии ${versionId.slice(0, 5)} (${meta?.title ?? ""})`.trim(), extra: { restoredFrom: versionId } });
}

// ---------- drafts ----------
function copyRoot(from, to) {
  for (const [rel, f] of Object.entries(listFiles(from))) {
    const n = agentName(rel);
    const dest = n ? agentAbs(to, n, f.disabled) : path.join(to.skill, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(f.abs, dest);
  }
}
export function listDrafts() {
  if (!fs.existsSync(DIRS.drafts)) return [];
  return fs
    .readdirSync(DIRS.drafts)
    .sort()
    .reverse()
    .map((id) => draftInfo(id))
    .filter(Boolean);
}
export function draftInfo(id) {
  const dir = path.join(DIRS.drafts, id);
  const meta = readJson(path.join(dir, "meta.json"));
  if (!meta) return null;
  const result = readJson(path.join(dir, "result.json"));
  const evalFile = path.join(dir, "eval.md");
  const status = meta.status === "work" && result ? (result.status === "failed" ? "failed" : "ready") : meta.status;
  return { ...meta, status, result, eval: fs.existsSync(evalFile) ? readText(evalFile).text : null, dir };
}
export function createDraft(request) {
  const text = String(request ?? "").trim();
  if (text.length < 5) throw new Error("Опиши правку словами");
  acknowledgeOutside();
  let id = `d_${stamp()}`;
  for (let i = 2; fs.existsSync(path.join(DIRS.drafts, id)); i++) id = `d_${stamp()}_${i}`;
  const dir = path.join(DIRS.drafts, id);
  const base = { skill: path.join(dir, "base", "skill"), agents: path.join(dir, "base", "agents"), disabled: path.join(dir, "base", "agents-disabled") };
  copyRoot(LIVE, draftRoot(id));
  copyRoot(LIVE, base);
  writeText(path.join(dir, "request.md"), text + "\n");
  writeJson(path.join(dir, "meta.json"), { id, ts: new Date().toISOString(), request: text, base: readState().version, baseHashes: hashAll(LIVE), status: "work" });
  return draftInfo(id);
}
export function setDraftMeta(id, patch) {
  const f = path.join(DIRS.drafts, id, "meta.json");
  const meta = readJson(f);
  if (!meta) throw new Error(`Нет черновика ${id}`);
  writeJson(f, { ...meta, ...patch });
}
function draftChange(id) {
  const dir = path.join(DIRS.drafts, id);
  const base = { skill: path.join(dir, "base", "skill"), agents: path.join(dir, "base", "agents"), disabled: path.join(dir, "base", "agents-disabled") };
  const a = filesOf(base);
  const b = filesOf(draftRoot(id));
  const files = {};
  for (const [rel, t] of Object.entries(b.files)) if (a.files[rel] !== t) files[rel] = t;
  const moves = {};
  for (const [n, d] of Object.entries(b.moves)) if (a.moves[n] !== d) moves[n] = d;
  return { files, moves, base: a };
}
export function previewDraft(id) {
  const { files, moves, base } = draftChange(id);
  const out = Object.entries(files).map(([rel, text]) => {
    const before = base.files[rel] ?? "";
    const d = lineDiff(rel.endsWith(".md") ? stripMarkers(before) : before, rel.endsWith(".md") ? stripMarkers(text) : text);
    return { rel, added: d.added, removed: d.removed, hunks: d.hunks, onlyMarkers: d.added + d.removed === 0, isNew: !(rel in base.files) };
  });
  return { files: out, moves: Object.entries(moves).map(([name, disabled]) => ({ name, disabled })), problems: check(draftRoot(id)) };
}
export function acceptDraft(id, by = "ИИ") {
  const info = draftInfo(id);
  if (!info) throw new Error(`Нет черновика ${id}`);
  if (info.status !== "ready") throw new Error("Черновик ещё не готов или уже закрыт");
  const problems = check(draftRoot(id));
  if (problems.length) throw new Error(`В черновике ${problems.length} ошибок меток: ${problems[0].file} — ${problems[0].text}`);
  const { files, moves } = draftChange(id);
  const now = hashAll(LIVE);
  const conflicts = Object.keys(files).filter((rel) => now[rel] !== info.baseHashes[rel]);
  if (conflicts.length) throw new Error(`После создания черновика рабочий скилл изменился в тех же файлах: ${conflicts.join(", ")}. Отклони черновик и попроси заново.`);
  const res = applyChange({ kind: "files", files, moves }, { by, title: info.result?.title || info.request.slice(0, 80), extra: { draft: id } });
  setDraftMeta(id, { status: "accepted", closedAt: new Date().toISOString() });
  return res;
}
export const rejectDraft = (id) => setDraftMeta(id, { status: "rejected", closedAt: new Date().toISOString() });

// ---------- eval status ----------
export function evalStatus() {
  const f = path.join(LIVE.skill, "evals", "runs.md");
  const runs = readJson(EVALS, []) ?? [];
  if (!fs.existsSync(f)) return { last: null, after: readJournal().length, runs };
  const text = readText(f).text;
  const rows = text.split("\n").filter((l) => /^\|\s*\d{4}-\d{2}-\d{2}/.test(l));
  const cells = (l) => l.split("|").slice(1, -1).map((c) => c.trim());
  const last = rows.length ? cells(rows[rows.length - 1]) : null;
  const mtime = fs.statSync(f).mtime.toISOString();
  const after = readJournal().filter((e) => e.ts > mtime && e.kind !== "migration").length;
  return { last: last ? { date: last[0], what: last[1], cases: last[2], auto: last[3], judge: last[4], cost: last[5], notes: last[6] } : null, mtime, after, runs };
}
export function recordEvalRun(run) {
  const runs = readJson(EVALS, []) ?? [];
  runs.push({ ts: new Date().toISOString(), ...run });
  writeJson(EVALS, runs.slice(-50));
}

// ---------- load for the panel ----------
export function load() {
  const S = readSettings(LIVE);
  const agents = readAgents(LIVE);
  const files = Object.entries(listFiles(LIVE))
    .filter(([rel]) => isText(rel) && (rel.endsWith(".md") || rel === "settings.json"))
    .map(([rel, f]) => ({ rel, disabled: f.disabled, size: fs.statSync(f.abs).size, mtime: fs.statSync(f.abs).mtime.toISOString() }))
    .sort((a, b) => a.rel.localeCompare(b.rel));
  return {
    settings: S,
    agents: Object.values(agents),
    occurrences: occurrences(LIVE, S),
    files,
    problems: check(LIVE),
    outside: outsideChanges(),
    journal: readJournal().slice(-60).reverse(),
    versions: listVersions().reverse().slice(0, 60),
    drafts: listDrafts().slice(0, 20),
    eval: evalStatus(),
    flowsRendered: Object.fromEntries(Object.entries(S.flows).filter(([, f]) => f.gen).map(([id]) => [id, stripMarkers(renderFlow(S, id))])),
    paths: { skill: LIVE.skill, agents: LIVE.agents, data: DATA, kind: SKILL_KIND },
  };
}
export const readFileText = (rel, root = LIVE) => {
  const f = listFiles(root)[rel];
  if (!f || !isText(rel)) throw new Error(`Нет файла ${rel}`);
  return readText(f.abs).text;
};

// Переписать метки и блоки цепочки по settings.json (обычно — черновика). Возвращает изменённые файлы.
export function renderRoot(root) {
  const S = readSettings(root);
  const ctx = { S, agents: readAgents(root) };
  const changed = [];
  for (const [rel, f] of Object.entries(listFiles(root))) {
    if (!rel.endsWith(".md") || rel.startsWith("agents/")) continue;
    const cur = readText(f.abs);
    const r = renderText(rel, cur.text, ctx);
    if (r !== cur.text) {
      writeText(f.abs, r, cur);
      changed.push(rel);
    }
  }
  return changed;
}

// ---------- CLI ----------
// node core.mjs check  [--draft <id>]   ошибки меток
// node core.mjs render [--draft <id>]   переписать метки и блоки цепочки по settings.json
// node core.mjs diff    --draft <id>    что изменено в черновике
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const [cmd, ...rest] = process.argv.slice(2);
  const di = rest.indexOf("--draft");
  const draft = di >= 0 ? rest[di + 1] : null;
  const root = draft ? draftRoot(draft) : LIVE;
  const out = (v) => console.log(typeof v === "string" ? v : JSON.stringify(v, null, 2));
  if (cmd === "check") {
    const p = check(root);
    out(p.length ? p.map((x) => `${x.file}:${x.line} ${x.text}`).join("\n") : "ошибок 0");
    process.exitCode = p.length ? 1 : 0;
  } else if (cmd === "render") {
    if (!draft && !rest.includes("--live")) {
      console.error("render без --draft меняет рабочий скилл: добавь --live, если это нужно");
      process.exit(2);
    }
    const files = renderRoot(root);
    for (const rel of files) console.log(`переписан ${rel}`);
    out(`файлов переписано: ${files.length}`);
  } else if (cmd === "diff") {
    if (!draft) throw new Error("нужен --draft <id>");
    const p = previewDraft(draft);
    for (const f of p.files) {
      console.log(`\n=== ${f.rel} (+${f.added} −${f.removed})`);
      for (const h of f.hunks) console.log(h.lines.map((l) => `${l.t}${l.text}`).join("\n") + "\n…");
    }
    for (const m of p.moves) console.log(`агент ${m.name}: ${m.disabled ? "выключен" : "включён"}`);
    console.log(p.problems.length ? `\nошибки меток:\n${p.problems.map((x) => `${x.file}:${x.line} ${x.text}`).join("\n")}` : "\nошибок меток 0");
  } else {
    out("команды: check | render [--draft id | --live] | diff --draft id");
  }
}
