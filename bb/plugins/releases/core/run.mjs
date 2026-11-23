// Командная строка для «Релизов»: node core/run.mjs check | refresh | view | telegram [--dry] | morning [--dry] | detect-chat | pm-report <дата> | pm-list | pm-verify | po-list | po-ready
// Продукт: --p=<id> (по умолчанию первый в списке). refresh обновляет все продукты.
// Настройки: переменные JIRA_URL, JIRA_EMAIL, JIRA_API_TOKEN, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
// и файл config.json в папке данных (~/.config/bb-releases или BB_RELEASES_DATA): { projects, fields, products, statuses, utcOffset } — без секретов.
import path from "node:path";
import * as core from "./core.mjs";
import { createPm } from "./pm.mjs";
const file = core.readJson(path.join(core.OUT_DIR, "config.json"), {}) || {};
const { JIRA_URL, JIRA_EMAIL, JIRA_API_TOKEN: jiraKey, TELEGRAM_BOT_TOKEN: botKey, TELEGRAM_CHAT_ID, CLAUDE_BIN } = process.env;
const miss = core.configure({ ...file, site: JIRA_URL || file.site, email: JIRA_EMAIL || file.email, token: jiraKey, tgToken: botKey, tgChatId: TELEGRAM_CHAT_ID || file.tgChatId, claudeBin: CLAUDE_BIN || file.claudeBin });
const pm = createPm(core);
const argv = process.argv.slice(2);
const pid = (argv.find((a) => a.startsWith("--p=")) || "--p=" + core.PRODUCTS[0].id).slice(4);
const [cmd = "view", ...args] = argv.filter((a) => !a.startsWith("--p="));
const log = (m) => console.log(`[${new Date().toLocaleTimeString("ru-RU")}] ${m}`);
const data = () => core.loadData(pid);
if (cmd === "check" || (miss.length && cmd !== "view" && cmd !== "telegram")) {
  console.log("папка данных:", core.OUT_DIR);
  console.log(miss.length ? `не заполнено: ${miss.join("; ")}` : "настройки заполнены");
  process.exit(cmd === "check" ? 0 : 1);
}
if (["view", "telegram"].includes(cmd) && !data()) {
  console.log(`Нет данных продукта «${core.product(pid).name}» в ${core.OUT_DIR}. ${miss.length ? `Сначала заполните настройки: ${miss.join("; ")}.` : "Запустите: node core/run.mjs refresh"}`);
  process.exit(0);
}
if (cmd === "refresh") {
  const t0 = Date.now();
  const all = await core.collectAll(log);
  for (const p of core.PRODUCTS) {
    if (!all[p.id]) continue;
    const v = core.view(core.loadData(p.id));
    core.saveSnapshot(v);
    log(`${p.short}: вне нормы ${v.anomalies.length}`);
  }
  log(`проверка заявок ПМ: ${JSON.stringify(await pm.verify({ notify: !args.includes("--quiet") }))}`);
  log(`${((Date.now() - t0) / 1000).toFixed(0)} с`);
} else if (cmd === "view") {
  const v = core.view(data());
  console.log(v.productName);
  for (const r of v.releases) console.log(r.name, r.mode, "старт", r.start, "эпиков", r.rows.length, JSON.stringify(r.counts), "вне эпиков", r.orph.length, "сняли до старта", r.pre.length);
  const by = {};
  for (const a of v.anomalies) by[a.code] = (by[a.code] || 0) + 1;
  console.log("вне нормы", v.anomalies.length, JSON.stringify(by));
  if (args.includes("--list")) for (const a of v.anomalies) console.log(a.sev, a.code, a.relName, a.key, "|", a.text);
} else if (cmd === "telegram") {
  const v = core.view(data());
  if (args.includes("--dry")) console.log(core.telegramText(v));
  else console.log(await core.sendTelegram(v, "командная строка"));
} else if (cmd === "morning") {
  const r = await pm.morning("командная строка", { dry: args.includes("--dry") });
  for (const x of r.list) console.log(x.login || "чат сводки", x.product, x.chars, "знаков", x.error || "");
  console.log("отправлено", args.includes("--dry") ? 0 : r.sent, r.errors.length ? "ошибки: " + r.errors.join("; ") : "");
} else if (cmd === "detect-chat") {
  console.log(await core.detectChat());
} else if (cmd === "pm-list") {
  const d = data(), list = pm.problems(core.view(d), d);
  for (const p of list) console.log(p.info ? "info" : p.sev, p.code, p.relName, p.key, "|", p.text, "\n   →", p.solution);
  console.log("всего", list.length, "к сведению", list.filter((p) => p.info).length);
} else if (cmd === "pm-report") {
  const d = data();
  for (const t of pm.reportMessages(core.view(d), d, args[0])) console.log(t.length, "знаков\n" + t + "\n-----");
} else if (cmd === "po-list") {
  const d = data(), v = core.view(d);
  const list = pm.poProblems(v, d), ready = pm.readyItems(v, d);
  for (const p of list) console.log(p.info ? "info" : p.sev, p.code, p.relName, p.key, "|", p.text);
  console.log("эпики: всего", list.length, "к сведению", list.filter((p) => p.info).length, "· не готовы к разработке в следующем релизе", ready.length);
} else if (cmd === "po-ready") {
  const d = data();
  for (const t of pm.readyReport(core.view(d), d)) console.log(t.length, "знаков\n" + t + "\n-----");
} else if (cmd === "pm-verify") {
  console.log(await pm.verify({ notify: false }));
} else console.log("команды: refresh [--quiet] | view [--list] | telegram [--dry] | morning [--dry] | detect-chat | pm-list | pm-report <ГГГГ-ММ-ДД> | pm-verify | po-list | po-ready · продукт --p=<id>");
