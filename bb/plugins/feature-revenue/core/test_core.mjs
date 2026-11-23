// Офлайн-проверка ядра без bb: node core/test_core.mjs [папка] → «ошибок 0».
// Готовит папку данных с демо-фичами (по умолчанию — временная), гоняет build.py --serve и сборку xlsx.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureData, findPython } from "./core.mjs";

let errors = 0;
const ok = (cond, msg) => { console.log(`${cond ? "ок " : "ОШИБКА"} ${msg}`); if (!cond) errors++; };

const dir = process.argv[2] || mkdtempSync(path.join(os.tmpdir(), "fr-test-"));
const P = ensureData(dir, { currency: "₽" });
ok(P.demo && existsSync(path.join(P.releases, "features.json")), `демо-конфиг в ${P.releases}`);
const py = findPython(process.env.FR_PYTHON || "");
ok(true, `Python ${py.version}: ${py.cmd}`);

const proc = spawn(py.cmd, [...py.pre, P.build, "--serve"], { env: { ...process.env, PYTHONUTF8: "1" }, windowsHide: true });
proc.stdout.setEncoding("utf8");
let buf = "";
const waiters = new Map();
proc.stdout.on("data", (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const r = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    waiters.get(r.id)?.(r);
  }
});
let seq = 0;
const ask = (req) => new Promise((res) => { const id = ++seq; waiters.set(id, res); proc.stdin.write(JSON.stringify({ id, ...req }) + "\n"); });
const cfg = path.join(P.releases, "features.json");

const list = await ask({ config: cfg, list: true });
ok(list.ok && list.data.releases.length === 4, `список релизов: ${list.ok ? list.data.releases.map((r) => r.release).join(", ") : list.error}`);
const all = await ask({ config: cfg, release: "all" });
ok(all.ok && all.data._explain.length === 4, `расчёт «все фичи»: ${all.ok ? all.data._explain.length + " фичи" : all.error}`);
if (all.ok) {
  const m = all.data._meta;
  ok(m.currency === "₽" && m.line_order.includes("Подписки"), `валюта ${m.currency}, строки ${m.line_order.join(", ")}`);
  const ice = all.data._ice?.["DEMO-1"];
  ok(ice && ice.impact > 0 && ice.confidence > 0 && ice.effort_hours === 40, `ICE DEMO-1: ${JSON.stringify(ice)}`);
  const exp = all.data._total?.month?.exp;
  const wi = await ask({ config: cfg, release: "all", overrides: { inputs: { "DEMO-2": { back: 0.08 } }, k: null } });
  ok(wi.ok && wi.data._total.month.exp > exp, `«что если» DEMO-2 back 4% → 8%: ${Math.round(exp)} → ${wi.ok ? Math.round(wi.data._total.month.exp) : wi.error}`);
}
const r1 = list.ok ? list.data.releases[0].release : null;
const one = await ask({ config: cfg, release: r1 });
ok(one.ok && one.data._explain.length === 1, `релиз ${r1}: ${one.ok ? one.data._explain.map((f) => f.key).join(", ") : one.error}`);
proc.stdin.end();

execFileSync(py.cmd, [...py.pre, P.build, cfg, "--release", "all"], { env: { ...process.env, PYTHONUTF8: "1" }, stdio: "ignore" });
const out = readdirSync(path.join(dir, "out"));
ok(out.some((f) => f.endsWith(".xlsx")) && out.some((f) => f.endsWith(".json")), `xlsx и json: ${out.join(", ")}`);

execFileSync(py.cmd, [...py.pre, P.measureFact, cfg, "DEMO-2", "2026-01-15", "0.05"], { stdio: "ignore" });
const f2 = await import("node:fs").then((fs) => JSON.parse(fs.readFileSync(cfg, "utf8")).features.find((f) => f.key === "DEMO-2"));
ok(f2.measure.facts.length === 1, "факт замера записан");

console.log(`папка: ${dir}\nошибок ${errors}`);
process.exit(errors ? 1 : 0);
