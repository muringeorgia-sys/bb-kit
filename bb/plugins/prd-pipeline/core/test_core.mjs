// Проверка core.mjs на копии скилла: правка параметров, агента, цепочки, правка вне панели, откат, черновик.
// node test_core.mjs [папка навыка] [папка агентов]
// По умолчанию — навык и агенты из сборки bb-kit (plugins/prd-pipeline). Работает на копии во временной папке
// (PRD_TEST_DIR или системный tmp), установленный навык и журнал не трогает.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const KIT = path.resolve(HERE, "..", "..", "..", "..", "plugins", "prd-pipeline");
const SRC_SKILL = path.resolve(process.argv[2] || path.join(KIT, "skills", "prd"));
const SRC_AGENTS = path.resolve(process.argv[3] || path.join(KIT, "agents"));
const T = path.join(process.env.PRD_TEST_DIR || os.tmpdir(), `prd-skill-test-${Date.now()}`);
const H = path.join(T, "home", ".claude");
fs.cpSync(SRC_SKILL, path.join(H, "skills", "prd"), { recursive: true });
fs.mkdirSync(path.join(H, "agents"), { recursive: true });
for (const f of fs.readdirSync(SRC_AGENTS)) if (/^prd-.*\.md$/.test(f)) fs.copyFileSync(path.join(SRC_AGENTS, f), path.join(H, "agents", f));
process.env.PRD_SKILL_TEST = T;
const core = await import(pathToFileURL(path.join(HERE, "core.mjs")).href + `?t=${Date.now()}`);

let fails = 0;
const ok = (cond, name) => {
  console.log(`${cond ? "ok  " : "FAIL"} ${name}`);
  if (!cond) fails++;
};
const read = (rel) => fs.readFileSync(path.join(H, "skills", "prd", rel), "utf8");
const throws = (fn) => {
  try {
    fn();
    return null;
  } catch (e) {
    return e.message;
  }
};

ok(core.LIVE.skill.startsWith(T), "тестовая папка вместо рабочего скилла");
const v0 = core.snapshot(core.LIVE, { by: "тест", title: "база" });
core.saveState(v0);
ok(core.check().length === 0, "исходная копия: ошибок меток 0");

// 1. параметры
let r = core.applyChange({ kind: "params", values: { "prd.lite.words": 700 } }, { by: "PO", title: "Lite 700" });
ok(r.ok, "сохранение параметра");
ok(read("SKILL.md").includes("<!--p:prd.lite.words-->700<!--/p-->") && read("references/cleanup.md").includes("-->700<"), "700 во всех метках");
ok(core.readSettings().params["prd.lite.words"].value === 700, "settings.json = 700");
ok(core.check().length === 0, "после правки ошибок 0");
ok(!!throws(() => core.planChange({ kind: "params", values: { "prd.lite.words": -5 } })), "отрицательное число отклонено");

// 2. агент: модель, лимит, выключение
r = core.applyChange({ kind: "agent", name: "prd-ux-writer", patch: { model: "opus", effort: "high", calls: 70, minutes: 45, enabled: false } }, { by: "PO", title: "ux-writer" });
const off = path.join(H, "agents-disabled", "prd-ux-writer.md");
ok(fs.existsSync(off) && !fs.existsSync(path.join(H, "agents", "prd-ux-writer.md")), "агент перенесён в agents-disabled");
ok(/model: opus/.test(fs.readFileSync(off, "utf8")) && /не больше 70 вызовов инструментов или 45 минут/.test(fs.readFileSync(off, "utf8")), "шапка и лимит агента");
ok(read("references/routing.md").includes("<!--a:prd-ux-writer-->Opus 5.5 · high<!--/a-->"), "routing.md: модель агента");
ok(r.warnings.some((w) => w.includes("prd-ux-writer")), "предупреждение: выключенный агент в цепочке");

// 3. цепочка: аналитик из волны 4 в волну 5
const S = core.readSettings();
const f = structuredClone(S.flows.full);
const an = f.steps[5].groups[0].splice(2, 1)[0];
f.steps[6].groups[0].push(an);
r = core.applyChange({ kind: "flow", flowId: "full", flow: f }, { by: "PO", title: "аналитик в волну 5" });
ok(read("SKILL.md").includes("**Волна 5, параллельно.**") && !/\*\*Волна 4, параллельно\.\*\*[^\n]*prd-product-analyst/.test(read("SKILL.md")), "SKILL.md: волны пересобраны");
ok(core.check().length === 0, "после цепочки ошибок 0");

// 4. правка вне панели
const cl = path.join(H, "skills", "prd", "references", "cleanup.md");
fs.appendFileSync(cl, "\nстрока из чата\n");
ok(core.outsideChanges().some((c) => c.rel === "references/cleanup.md"), "правка вне панели замечена");
r = core.applyChange({ kind: "params", values: { "brief.words": 350 } }, { by: "PO", title: "brief 350" });
ok(core.readJournal().some((e) => e.kind === "outside"), "правка вне панели записана в журнал перед сохранением");
ok(core.outsideChanges().length === 0, "после сохранения расхождений нет");

// 5. ручная правка текста: метки защищены
const sk = read("SKILL.md");
ok(!!throws(() => core.planChange({ kind: "text", rel: "SKILL.md", content: sk.replace("<!--p:prd.lite.words-->700<!--/p-->", "<!--p:prd.lite.words-->650<!--/p-->") })), "текст: число в метке не меняется руками");
r = core.applyChange({ kind: "text", rel: "SKILL.md", content: sk.replace("# PRD: оркестратор", "# PRD: оркестратор (тест)") }, { by: "PO", title: "заголовок" });
ok(r.ok && read("SKILL.md").includes("оркестратор (тест)"), "текст: обычная правка сохраняется");

// 6. откат к базе
const pv = core.previewRestore(v0);
ok(pv.files.length > 0 && pv.moves.some((m) => m.name === "prd-ux-writer" && m.disabled === false), "предпросмотр отката: файлы и включение агента");
r = core.applyRestore(v0, "PO");
ok(read("SKILL.md").includes("<!--p:prd.lite.words-->600<!--/p-->") && fs.existsSync(path.join(H, "agents", "prd-ux-writer.md")) && !fs.existsSync(off), "откат: 600 и агент снова включён");
ok(core.check().length === 0, "после отката ошибок 0");

// 7. черновик
const d = core.createDraft("Поставь лимит критериев Full 14");
const dr = core.draftRoot(d.id);
const ds = JSON.parse(fs.readFileSync(path.join(dr.skill, "settings.json"), "utf8"));
ds.params["prd.full.criteria"].value = 14;
fs.writeFileSync(path.join(dr.skill, "settings.json"), JSON.stringify(ds, null, 2) + "\n");
const ctx = { S: ds, agents: core.readAgents(dr) };
for (const [rel, x] of Object.entries(core.listFiles(dr))) {
  if (!rel.endsWith(".md") || rel.startsWith("agents/")) continue;
  const t = fs.readFileSync(x.abs, "utf8").replace(/\r\n/g, "\n");
  const rr = core.renderText(rel, t, ctx);
  if (rr !== t) fs.writeFileSync(x.abs, rr);
}
ok(core.draftInfo(d.id).status === "work", "черновик в работе, пока нет result.json");
fs.writeFileSync(path.join(T, "data", "drafts", d.id, "result.json"), JSON.stringify({ status: "ready", title: "Full: до 14 критериев", summary: "settings.json и 4 файла" }));
const pd = core.previewDraft(d.id);
ok(pd.files.length >= 5 && pd.problems.length === 0, `предпросмотр черновика: ${pd.files.length} файлов, ошибок ${pd.problems.length}`);
ok(read("SKILL.md").includes("<!--p:prd.full.criteria-->12<!--/p-->"), "до «Принять» рабочий скилл не изменён");
r = core.acceptDraft(d.id);
ok(r.ok && read("SKILL.md").includes("<!--p:prd.full.criteria-->14<!--/p-->") && core.draftInfo(d.id).status === "accepted", "черновик принят");

// 8. конфликт черновика
const d2 = core.createDraft("Тест конфликта");
fs.appendFileSync(path.join(core.draftRoot(d2.id).skill, "references", "cleanup.md"), "\nиз черновика\n");
fs.writeFileSync(path.join(T, "data", "drafts", d2.id, "result.json"), JSON.stringify({ status: "ready", title: "конфликт" }));
core.applyChange({ kind: "text", rel: "references/cleanup.md", content: read("references/cleanup.md").replace(/\r\n/g, "\n") + "\nиз панели\n" }, { by: "PO", title: "конфликт" });
ok(/изменился в тех же файлах/.test(throws(() => core.acceptDraft(d2.id)) ?? ""), "конфликт черновика остановлен");

ok(core.readJournal().length >= 7 && core.listVersions().length >= 7, `журнал ${core.readJournal().length} записей, версий ${core.listVersions().length}`);
const L = core.load();
ok(L.problems.length === 0 && L.drafts.length === 2 && L.versions.length >= 7, "load() для панели");
console.log(fails ? `\nпровалено: ${fails}` : "\nвсе проверки прошли");
process.exitCode = fails ? 1 : 0;
