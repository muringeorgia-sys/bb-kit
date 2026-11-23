// Выручка фич — панель bb: оценка выручки фич вашего продукта по методике v3 (ICE, вилка, план, замеры).
// Числа считает core/build.py (calc.ts). Скрипты едут строками (core/py_scripts.mjs) и пишутся в папку данных.
// Конфиги — <папка данных>/releases/*.json: features.json — все фичи (релиз и статус — из трекера или из фичи),
// ГГГГ-ММ-ДД.json — снимки оценки одного релиза. Без трекера всё работает на ручном вводе.
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { aiContract, aiHandlers } from "./ai";
import { Calc } from "./calc";
import { icePlan, iceOf, readIce, type IceVals } from "./ice";
import { listReleases } from "./releases";
import {
  DEFAULT_DATA_DIR, ensureData, findPython, openPath, parseIceFields, refreshTracker, trackerClient,
  type DataPaths, type IceFields, type TrackerCall,
} from "./core/core.mjs";

const fileSchema = z.string().regex(/^[\w.\-]+\.json$/);
const keySchema = z.string().regex(/^[A-Z][A-Z0-9]*-\d+$/);
const inputsSchema = z.record(z.string(), z.record(z.string(), z.number()));
const okSchema = z.object({ ok: z.boolean(), message: z.string().optional() });
const releaseSchema = z.string().regex(/^(\d{4}-\d{2}-\d{2}|all|none)$/).nullable().optional();
const relItem = z.object({
  key: z.string(), file: z.string(), release: z.string().nullable(), group: z.enum(["tracker", "snap"]), label: z.string(),
  name: z.string(), v3: z.boolean(), features: z.number(), planned: z.string().nullable(),
});

export const rpcContract = defineRpcContract({
  releases: { input: z.object({}), output: z.object({ list: z.array(relItem) }) },
  load: { input: z.object({ file: fileSchema, release: releaseSchema }), output: z.object({ data: z.unknown(), ms: z.number() }) },
  what_if: {
    input: z.object({ file: fileSchema, release: releaseSchema, inputs: inputsSchema, k: z.number().nullable() }),
    output: z.object({ data: z.unknown(), ms: z.number() }),
  },
  open: { input: z.object({ what: z.enum(["method", "config", "folder"]), file: fileSchema.optional() }), output: okSchema },
  tracker_state: {
    input: z.object({ file: fileSchema, release: releaseSchema }),
    output: z.object({ rows: z.array(z.unknown()), at: z.string(), sync: z.unknown(), offline: z.string().nullable() }),
  },
  tracker_write: {
    input: z.object({ file: fileSchema, release: releaseSchema, keys: z.array(keySchema) }),
    output: z.object({ results: z.array(z.object({ key: z.string(), ok: z.boolean(), written: z.unknown(), error: z.string().optional() })) }),
  },
  tracker_sync: { input: z.object({}), output: z.object({ ok: z.boolean(), changed: z.array(z.string()), message: z.string() }) },
  // факт замера: дописать или убрать {date, value} в measure.facts фичи (вкладка «Замеры»)
  measure_fact: {
    input: z.object({ file: fileSchema, key: keySchema, date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), value: z.number().nullable() }),
    output: okSchema,
  },
  ...aiContract,
});

function defineSettings(bb: BbPluginApi) {
  // bb → Settings → Installed plugins → «Выручка фич». Токен трекера — секрет: не уходит в панель.
  return bb.settings.define({
    productName: { type: "string", label: "Название продукта", description: "Для подсказок ИИ и подписей панели", default: "ваш продукт" },
    currency: { type: "string", label: "Валюта", description: "Подпись денег в панели и xlsx, если в конфиге нет поля currency", default: "₽" },
    revenueLines: {
      type: "string",
      label: "Строки выручки",
      description: "Через запятую, в порядке цветов панели. Пример: «Подписки, Разовые покупки, Реклама». ИИ берёт строки для компонентов отсюда",
      default: "Подписки, Разовые покупки, Реклама",
    },
    dataDir: { type: "string", label: "Папка данных", description: `Пусто — ${DEFAULT_DATA_DIR}`, default: "" },
    pythonPath: { type: "string", label: "Путь к Python", description: "Python 3.10+ с openpyxl. Пусто — python, py или python3 из PATH", default: "" },
    trackerUrl: {
      type: "string", label: "Адрес трекера",
      description: "Облачный трекер Atlassian с REST API v3: https://<ваш-сайт>.atlassian.net. Пусто — без трекера, статус и релиз из конфига",
      default: "",
    },
    trackerEmail: { type: "string", label: "Email в трекере", description: "Логин, к которому выпущен API-токен", default: "" },
    trackerToken: { type: "string", label: "API-токен трекера", description: "Профиль Atlassian → Security → API tokens", secret: true },
    trackerJql: {
      type: "string", label: "JQL эпиков",
      description: "Какие эпики читать для статуса и релиза. Пример: project = ABC AND issuetype = Epic",
      default: "issuetype = Epic AND updated >= -180d ORDER BY updated DESC",
    },
    iceFields: {
      type: "string", label: "Поля ICE в трекере",
      description: "id числовых полей через запятую: Impact, Confidence, Effort, ICE (customfield_…). Пусто — ICE только в панели",
      default: "",
    },
    aiProjectId: { type: "string", label: "Проект bb для ИИ", description: "id проекта bb для тредов оценки. Пусто — проект по умолчанию", default: "" },
    aiEnvironmentId: { type: "string", label: "Окружение bb для ИИ", description: "id окружения для повторного использования. Пусто — папка данных плагина", default: "" },
  });
}

export default async function plugin(bb: BbPluginApi) {
  const settings = defineSettings(bb);
  let cur = await settings.get();
  let paths: DataPaths = ensureData(cur.dataDir, { currency: cur.currency });
  if (paths.demo) bb.log.info(`создан демо-конфиг: ${path.join(paths.releases, "features.json")}`);
  const cache = new Map<string, unknown>();
  const calc = new Calc((m) => bb.log.error(m), () => paths, () => cur.pythonPath);
  settings.onChange((next) => {
    const reset = next.pythonPath !== cur.pythonPath || next.dataDir !== cur.dataDir;
    cur = next;
    cache.clear();
    if (reset) {
      paths = ensureData(cur.dataDir, { currency: cur.currency });
      calc.resetPython();
    }
  });
  bb.onDispose(() => calc.stop());

  const cfgPath = (file: string) => {
    const p = path.join(paths.releases, file);
    if (!existsSync(p)) throw new Error(`нет конфига ${file}`);
    return p;
  };
  const trackerFile = () => path.join(paths.dir, "tracker.json");
  const iceStateFile = () => path.join(paths.iceDir, "ice_state.json");
  const iceLog = (entry: Record<string, unknown>) => {
    mkdirSync(paths.iceDir, { recursive: true });
    appendFileSync(path.join(paths.iceDir, "ice_log.jsonl"), JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n", "utf8");
  };
  const client = () => trackerClient({ url: cur.trackerUrl, email: cur.trackerEmail, token: cur.trackerToken });
  const iceConf = (): { call: TrackerCall; fields: IceFields } => {
    const call = client();
    if (!call) throw new Error("трекер не настроен: адрес, email и API-токен — в настройках плагина. ICE посчитан в панели, запись выключена");
    const fields = parseIceFields(cur.iceFields);
    if (!fields) throw new Error("не заданы поля ICE в трекере (настройка «Поля ICE в трекере»). ICE посчитан в панели, запись выключена");
    return { call, fields };
  };
  // в панель: порядок строк (цвета) и название продукта из настроек
  const decorate = (data: any) => {
    if (data?._meta) {
      const lines = String(cur.revenueLines || "").split(",").map((s) => s.trim()).filter(Boolean);
      data._meta.line_order = [...new Set([...lines, ...(data._meta.line_order ?? [])])];
      data._meta.product = cur.productName || "ваш продукт";
    }
    return data;
  };
  const cacheKey = (file: string, release: string | null | undefined) => {
    const tm = existsSync(trackerFile()) ? statSync(trackerFile()).mtimeMs : 0;
    return `${file}:${release ?? ""}:${statSync(cfgPath(file)).mtimeMs}:${statSync(paths.build).mtimeMs}:${tm}`;
  };
  // расчёт релиза, как у вкладки «Релиз» (без правок «Что если»)
  const loadData = async (file: string, release: string | null | undefined): Promise<any> => {
    const key = cacheKey(file, release);
    if (!cache.has(key)) cache.set(key, decorate(await calc.ask({ config: cfgPath(file), release: release ?? null })));
    return cache.get(key);
  };
  const readState = (): any => {
    try { return JSON.parse(readFileSync(iceStateFile(), "utf8")); } catch { return {}; }
  };
  const poolFile = () => readdirSync(paths.releases).find((f) => {
    try { return f.endsWith(".json") && !!JSON.parse(readFileSync(path.join(paths.releases, f), "utf8")).tracker; } catch { return false; }
  });
  // сверка: обновить tracker.json; разработчики поменяли Effort в трекере → переписать только ICE
  const syncAll = async (by: string): Promise<{ changed: string[]; note: string }> => {
    const call = client();
    if (!call) return { changed: [], note: "трекер не настроен — статус и релиз берутся из конфига" };
    const t = await refreshTracker(call, cur.trackerJql, trackerFile());
    let note = `трекер: эпиков ${t.epics}, релизов ${t.versions}`;
    const fields = parseIceFields(cur.iceFields);
    const file = poolFile();
    const changed: string[] = [];
    if (fields && file) {
      const cfg = JSON.parse(readFileSync(path.join(paths.releases, file), "utf8"));
      const keys: string[] = (cfg.features ?? []).map((f: any) => f.key);
      const vals = await readIce(call, fields, keys);
      for (const k of keys) {
        const c = vals[k];
        if (!c || c.impact == null || c.effort == null) continue;
        const ice = iceOf(c.impact, c.confidence, c.effort);
        if (ice == null || ice === c.ice) continue;
        await call("PUT", `/rest/api/3/issue/${encodeURIComponent(k)}`, { fields: { [fields.ice]: ice } });
        iceLog({ by, key: k, write: { ice }, was: c.ice, effort: c.effort });
        changed.push(k);
      }
      note += changed.length ? `; ICE обновлён: ${changed.join(", ")}` : "; Effort в трекере не менялся: ICE совпадает";
    }
    mkdirSync(paths.iceDir, { recursive: true });
    const lastSync = { date: new Date().toISOString().slice(0, 10), at: new Date().toISOString(), by, changed };
    writeFileSync(iceStateFile(), JSON.stringify({ ...readState(), lastSync }, null, 1), "utf8");
    return { changed, note };
  };
  const daily = async (by: string) => {
    if (!client() || readState().lastSync?.date === new Date().toISOString().slice(0, 10)) return;
    try {
      const r = await syncAll(by);
      cache.clear();
      bb.log.info(`сверка (${by}): ${r.note}`);
    } catch (e) {
      bb.log.error(`сверка: ${(e as Error).message}`);
    }
  };

  bb.rpc.register(rpcContract, {
    // ИИ: оценка фич релиза и ревью (ai.ts)
    ...aiHandlers(bb, {
      paths: () => paths,
      settings: () => ({
        productName: cur.productName || "ваш продукт", revenueLines: cur.revenueLines, currency: cur.currency,
        aiProjectId: cur.aiProjectId, aiEnvironmentId: cur.aiEnvironmentId, python: cur.pythonPath || "python",
      }),
      pool: (file) => calc.ask({ config: cfgPath(file), list: true }),
      data: (file, release) => loadData(file, release),
    }),
    tracker_state: async ({ file, release }) => {
      const data = await loadData(file, release);
      let vals: Record<string, IceVals & { summary: string }> = {};
      let offline: string | null = null;
      try {
        const { call, fields } = iceConf();
        vals = await readIce(call, fields, (data._explain ?? []).map((f: any) => f.key));
      } catch (e) {
        offline = (e as Error).message;
      }
      const rows = (data._explain ?? []).map((f: any) => {
        const calcV = data._ice?.[f.key] ?? null;
        const plan = icePlan(calcV, offline ? undefined : vals[f.key]);
        return { key: f.key, name: f.name, calc: calcV, tracker: vals[f.key] ?? null, ...plan, ...(offline ? { write: {} } : {}) };
      });
      return { rows, at: new Date().toISOString(), sync: readState().lastSync ?? null, offline };
    },
    tracker_write: async ({ file, release, keys }) => {
      const { call, fields } = iceConf();
      const data = await loadData(file, release);
      const vals = await readIce(call, fields, keys);
      const results: { key: string; ok: boolean; written: unknown; error?: string }[] = [];
      for (const k of keys) {
        const plan = icePlan(data._ice?.[k], vals[k]);
        const body: Record<string, number> = {};
        for (const [name, v] of Object.entries(plan.write)) if (typeof v === "number") body[fields[name as keyof IceFields]] = v;
        if (!Object.keys(body).length) { results.push({ key: k, ok: true, written: {} }); continue; }
        try {
          await call("PUT", `/rest/api/3/issue/${encodeURIComponent(k)}`, { fields: body });
          iceLog({ by: "кнопка в панели", key: k, write: plan.write, was: vals[k] ?? null });
          results.push({ key: k, ok: true, written: plan.write });
        } catch (e) {
          results.push({ key: k, ok: false, written: {}, error: (e as Error).message });
        }
      }
      return { results };
    },
    tracker_sync: async () => {
      try {
        const r = await syncAll("кнопка «Сверить сейчас»");
        cache.clear();
        return { ok: true, changed: r.changed, message: r.note };
      } catch (e) {
        return { ok: false, changed: [], message: (e as Error).message };
      }
    },
    releases: async () => ({ list: await listReleases(calc, paths.releases, (m) => bb.log.error(m)) }),
    load: async ({ file, release }) => {
      const t = Date.now();
      const data = await loadData(file, release);
      return { data, ms: Date.now() - t };
    },
    what_if: async ({ file, release, inputs, k }) => {
      const t = Date.now();
      const data = decorate(await calc.ask({ config: cfgPath(file), release: release ?? null, overrides: { inputs, k } }));
      return { data, ms: Date.now() - t };
    },
    measure_fact: async ({ file, key, date, value }) => {
      try {
        const py = findPython(cur.pythonPath);
        execFileSync(py.cmd, [...py.pre, paths.measureFact, cfgPath(file), key, date, value == null ? "" : String(value)], { encoding: "utf8", windowsHide: true, timeout: 30_000 });
      } catch (e: any) {
        const msg = String(e?.stderr || e?.message || e).trim().split(/\r?\n/).pop() || "ошибка записи";
        return { ok: false, message: msg };
      }
      bb.log.info(`факт замера ${key} ${date}: ${value ?? "убран"}`);
      return { ok: true };
    },
    open: async ({ what, file }) => {
      const target = what === "method" ? paths.method : what === "config" && file ? cfgPath(file) : paths.dir;
      const o = openPath(target);
      spawn(o.cmd, o.args, { detached: true, stdio: "ignore", windowsHide: true }).unref();
      return { ok: true };
    },
  });

  // прогрев: импорт openpyxl идёт несколько секунд, делаем его до первого открытия панели
  const warm = setTimeout(() => {
    const files = readdirSync(paths.releases).filter((f) => f.endsWith(".json"));
    const first = files.includes("features.json") ? "features.json" : files[0];
    if (first) calc.ask({ config: path.join(paths.releases, first), slim: true }).catch((e) => bb.log.error(`прогрев: ${e.message}`));
  }, 5_000);
  bb.onDispose(() => clearTimeout(warm));

  // сверка с трекером раз в день: будни 10:15 и догон через 2 минуты после запуска bb (только если трекер настроен)
  bb.background.schedule("tracker-sync-1015", "15 10 * * 1-5", () => daily("расписание 10:15"));
  const syncT = setTimeout(() => void daily("запуск bb"), 120_000);
  bb.onDispose(() => clearTimeout(syncT));
}
