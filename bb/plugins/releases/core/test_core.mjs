// Офлайн-тест ядра «Релизов» на вымышленной Jira (fetch подменён): node core/test_core.mjs → «ошибок 0».
// Данные пишутся во временную папку, сеть не нужна.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bb-releases-test-"));
process.env.BB_RELEASES_DATA = DIR;
const core = await import("./core.mjs");
const { createPm } = await import("./pm.mjs");

let fails = 0, checks = 0;
const ok = (cond, name) => { checks++; if (!cond) { fails++; console.log("ОШИБКА:", name); } else console.log("ok:", name); };
const rejects = async (p, re, name) => { try { await p; ok(false, name); } catch (e) { ok(re.test(String(e.message || e)), `${name} (${e.message})`); } };

// 1. Без настроек: понятные подсказки, ничего не падает.
ok(core.missing().length >= 5, "без настроек missing() перечисляет поля");
await rejects(core.collectAll(), /Не заполнены настройки/, "collectAll без настроек");
ok(core.view(core.loadData()) === null, "view без данных → null");
ok(core.PRODUCTS[0].id === "main", "продукт-заглушка");
const pm0 = createPm(core);
ok(Array.isArray(pm0.panel().products), "panel() без настроек");
await rejects(core.tg("getMe"), /TELEGRAM_BOT_TOKEN/, "Telegram без токена");

// 2. Ошибки настроек.
let threw = null;
try { core.configure({ products: "[{\"id\":\"A B\",\"name\":\"x\"}]" }); } catch (e) { threw = e.message; }
ok(/id/.test(threw || ""), "плохой id продукта");
threw = null;
try { core.configure({ projects: { epic: "EP; DROP" } }); } catch (e) { threw = e.message; }
ok(/Проект Jira/.test(threw || ""), "плохой ключ проекта");
threw = null;
try { core.configure({ products: "{oops" }); } catch (e) { threw = e.message; }
ok(!!threw, "битый JSON продуктов");

// 3. Настроенная вымышленная Jira.
const SITE = "https://jira.example.com";
const miss = core.configure({
  site: SITE, email: "user@example.com", token: "test-token",
  projects: { epic: "EPIC", dev: "DEV", design: "DES", qa: "" },
  fields: { product: "customfield_1", reqLink: "customfield_2" },
  products: JSON.stringify([{ id: "a", name: "Продукт A", emoji: "🅰" }, { id: "b", name: "Продукт B" }]),
  utcOffset: 3,
});
ok(miss.length === 0, "все настройки заполнены");
ok(core.PRODUCTS.length === 2 && core.SITE === SITE, "продукты и адрес из настроек");

const DAY = 86400e3, iso = (t) => new Date(t + 3 * 3600e3).toISOString().slice(0, 10);
const vname = (p, t) => { const d = iso(t); return `${p} ${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`; };
const now = Date.now(), PAST = now - 10 * DAY, CUR = now + 5 * DAY, NEXT = now + 19 * DAY;
const projects = ["EPIC", "DEV", "DES"];
const versions = {};
let vid = 100;
for (const p of projects) versions[p] = [PAST, CUR, NEXT].flatMap((t) => ["Продукт A", "Продукт B"].map((n) => ({ id: String(vid++), name: vname(n, t), released: false, archived: false })));
const ver = (p, t, n = "Продукт A") => versions[p].find((v) => v.name === vname(n, t));
const created = new Date(now - 40 * DAY).toISOString();
const issue = (key, status, cat, type, fixT, extra = {}) => ({
  id: String(1000 + Number(key.split("-")[1]) + key.length * 100), key,
  fields: {
    summary: `Задача ${key}`, status: { name: status, statusCategory: { key: cat } }, issuetype: { name: type }, created,
    fixVersions: fixT.map((t) => ({ id: ver(key.split("-")[0], t).id, name: ver(key.split("-")[0], t).name })),
    parent: extra.parent ? { key: extra.parent } : undefined, assignee: extra.noAssignee ? null : { displayName: "Исполнитель" },
    project: { key: key.split("-")[0] }, comment: { comments: [] }, priority: { name: "High" }, labels: [],
    customfield_1: type === "Epic" ? [{ value: "Продукт A" }] : null, customfield_2: extra.req ? "https://example.com/req" : null,
  },
});
const EPICS = [
  issue("EPIC-1", "Разработка", "indeterminate", "Epic", [CUR], { req: true }),
  issue("EPIC-2", "Разработка", "indeterminate", "Epic", [PAST], { req: true }),
  issue("EPIC-3", "Формирование требований", "new", "Epic", [CUR]),
];
const KIDS = [
  issue("DEV-1", "In Progress", "indeterminate", "Task", [CUR], { parent: "EPIC-1" }),
  issue("DES-1", "Дизайн готов", "done", "Task", [CUR], { parent: "EPIC-1" }),
  issue("DEV-3", "On Hold", "indeterminate", "Task", [PAST], { parent: "EPIC-2" }),
];
const ORPH = [issue("DEV-2", "To Do", "new", "Task", [CUR])];
const calls = [];
globalThis.fetch = async (url, init = {}) => {
  const u = String(url), body = init.body ? JSON.parse(init.body) : null;
  calls.push(u + (body?.jql ? " " + body.jql : ""));
  if (!u.startsWith(SITE)) throw new Error("чужой адрес " + u);
  if (!/^Basic /.test(init.headers?.Authorization || "")) throw new Error("нет авторизации");
  const res = (j) => ({ ok: true, status: 200, text: async () => JSON.stringify(j), json: async () => j });
  let m = u.match(/\/project\/([A-Z]+)\/versions$/);
  if (m) return res(versions[m[1]] || []);
  if (u.endsWith("/search/jql")) {
    const q = body.jql;
    if (q.startsWith("project = EPIC")) return res({ issues: EPICS });
    if (/^parent in \(EPIC/.test(q)) return res({ issues: KIDS.filter((k) => q.includes(k.fields.parent.key)) });
    if (q.startsWith("parent in")) return res({ issues: [] });
    if (q.startsWith("project in (DEV, DES)") && q.includes("WAS IN")) return res({ issues: ORPH });
    return res({ issues: [] });
  }
  if (u.endsWith("/changelog/bulkfetch")) return res({ issueChangeLogs: [] });
  if (u.includes("/priority")) return res({ values: [{ name: "Highest" }, { name: "High" }] });
  return { ok: false, status: 404, text: async () => "not found" };
};

const all = await core.collectAll(() => {});
ok(all.a && all.b !== undefined, "collectAll по двум продуктам");
ok(calls.some((c) => c.includes("project = EPIC AND")), "JQL с проектом эпиков из настроек");
ok(calls.some((c) => c.includes("project in (DEV, DES)")), "JQL с проектами задач из настроек (QA пустой — не в запросе)");
ok(fs.existsSync(path.join(DIR, "data.json")) && fs.existsSync(path.join(DIR, "data-b.json")), "файлы данных: основной и второй продукт");

const v = core.view(core.loadData("a"));
ok(v && v.releases.length === 3, "три релиза: прошлый, текущий, следующий");
const cur = v.releases.find((r) => r.slot === "cur");
ok(cur.rows.some((x) => x.key === "EPIC-1") && cur.rows.some((x) => x.key === "EPIC-3"), "эпики текущего релиза");
const codes = new Set(v.anomalies.map((a) => a.code));
ok(codes.has("tail_epic"), "кейс: релиз прошёл, эпик не закрыт");
ok(codes.has("orphan"), "кейс: задача релиза без эпика");
ok(codes.has("phase_early"), "кейс: требования не готовы");
ok(codes.has("no_req"), "кейс: нет ссылки на требования");
ok(codes.has("ver_unreleased"), "кейс: версия не выпущена");
ok(v.anomalies.find((a) => a.code === "ver_unreleased").url.startsWith(SITE + "/projects/EPIC/versions/"), "ссылка на версию в вашей Jira");
const ep1 = cur.rows.find((x) => x.key === "EPIC-1");
ok(ep1.details.groups.some((g) => g.title === "Разработка (DEV)") && ep1.details.groups.some((g) => g.title === "Дизайн (DES)"), "группы задач по проектам из настроек");
ok(ep1.d.state === "ready", "дизайн готов по статусу «Дизайн готов»");
ok(v.jira?.site === SITE && v.jira.projects.dev === "DEV", "view.jira для панели");
const text = core.telegramText(v);
ok(text.includes("Релизы Продукт A") && text.includes("Вне нормы"), "текст сводки");
ok(!/MASH|PRODUCT-/.test(JSON.stringify(v)), "в виде нет зашитых проектов");

const vb = core.view(core.loadData("b"));
ok(vb && vb.product === "b" && vb.releases.every((r) => r.rows.length === 0), "второй продукт: эпики с полем «Продукт A» не попали");

// 4. Правки PO и режим ПМ.
core.setAck(v.anomalies[0].id, "проверено", "a");
ok(core.view(core.loadData("a")).anomalies.some((a) => a.ack), "скрытие кейса");
core.setDates(cur.date, iso(now - 3 * DAY), null, "a");
ok(core.view(core.loadData("a")).releases.find((r) => r.slot === "cur").start === iso(now - 3 * DAY), "ручная дата старта спринта");
const pm = createPm(core);
const d = core.loadData("a");
const list = pm.problems(core.view(d), d);
ok(list.some((p) => p.key === "DEV-2"), "ПМ видит задачи проекта разработки");
pm.addPm("test_pm", ["a", "b"]);
ok(pm.panel("a").pms?.some?.((x) => x.login === "test_pm") ?? true, "логин ПМ добавлен");
const plan = await pm.morning("тест", { dry: true });
ok(Array.isArray(plan.list), "план рассылки без отправки");

// 5. Чат из настроек.
core.configure({ ...{ site: SITE, email: "u@example.com", token: "t" }, projects: { epic: "EPIC", dev: "DEV" }, products: [{ id: "a", name: "Продукт A" }], tgChatId: "12345" });
ok(core.loadNotes().cfg.tg.chatId === 12345, "чат сводки из настроек");

fs.rmSync(DIR, { recursive: true, force: true });
console.log(`проверок ${checks}, ошибок ${fails}`);
process.exit(fails ? 1 : 0);
