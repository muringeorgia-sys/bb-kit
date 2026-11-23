// Релизы — панель релизов по Jira Cloud: один или несколько продуктов в общих проектах Jira.
// Вся логика (сбор, итоги, прогноз, кейсы вне нормы, Telegram, запись в Jira) — в ./core/core.mjs и ./core/pm.mjs:
// тот же код запускает core/run.mjs из командной строки.
// Адрес Jira, проекты, поля, продукты, статусы и Telegram — настройки плагина (bb → Settings → Installed plugins → «Релизы»).
// API-токен Jira и токен бота — секреты (файл 0600, в панель не уходят).
// Расписание: будни 10:00 по часам компьютера — обновить из Jira все продукты и разослать сводки
// (каждому ПМ и продакту — по сообщению на каждый его продукт); если bb был закрыт в 10:00, сводка уходит при запуске (10:00–18:00 будни, один раз в день).
// Все RPC панели принимают product (id продукта из настроек), по умолчанию первый продукт.
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import * as coreJs from "./core/core.mjs";
import { createPm } from "./core/pm.mjs";

type View = { today: string; anomalies: { ack: unknown }[] } & Record<string, unknown>;
type Product = { id: string; name: string; short: string; emoji: string };
type Core = {
  OUT_DIR: string;
  PRODUCTS: Product[];
  configure(o: Record<string, unknown>): string[];
  missing(): string[];
  iso(t: number): string;
  collectAll(log: (m: string) => void): Promise<Record<string, unknown>>;
  loadData(pid?: string): unknown;
  loadNotes(pid?: string): { cfg: { tg: { lastSent?: { date: string } } } };
  view(data: unknown): View | null;
  saveSnapshot(v: View | null): void;
  sendTelegram(v: View, by: string): Promise<{ ok: boolean; chars: number }>;
  detectChat(): Promise<{ ok: boolean; title?: string; error?: string }>;
  telegramText(v: View, perGroup?: number, opts?: { po?: boolean; footer?: string }): string;
  setOverride(date: string, key: string, res: string | null, pid: string): unknown;
  setNote(date: string, key: string, text: string, pid: string): unknown;
  setAck(id: string, note: string | null, pid: string): unknown;
  setDates(date: string, start: string | null, cutoff: string | null, pid: string): unknown;
  jiraTransitions(key: string): Promise<{ id: string; name: string; to: string }[]>;
  jiraTransition(key: string, id: string, by: string): Promise<{ ok: boolean; to: string }>;
  jiraSetRelease(key: string, date: string | null, withChildren: boolean, by: string, pid: string): Promise<{ ok: boolean; changed: string[]; errors: string[] }>;
};

type Pm = {
  pollOnce(signal: AbortSignal, onClaim: () => void, onError: (e: unknown) => void): Promise<number>;
  verify(o?: { notify?: boolean }): Promise<{ checked: number }>;
  morning(by: string, o?: { dry?: boolean }): Promise<{ sent: number; errors: string[]; list: { chatId: number; login: string | null; product: string; chars: number; text?: string }[] }>;
  addPm(login: string, products?: string[]): unknown;
  removePm(login: string): unknown;
  addPo(login: string, products?: string[]): unknown;
  removePo(login: string): unknown;
  setProducts(kind: "pms" | "pos", login: string, products: string[]): unknown;
  setJira(login: string, name: string): unknown;
  setOff(kind: "pms" | "pos", login: string, off: boolean): Promise<unknown>;
  setKnownCfg(cfg: { maxDays: number; labels: { label: string; mode: "days" | "next"; days?: number }[] }): unknown;
  panel(pid?: string): unknown;
};

const C = coreJs as unknown as Core;
// pm.mjs делает снимок продуктов при создании — пересоздаём после смены настроек.
let pmInst: Pm | null = null;
const core = async (): Promise<Core> => C;
const pm = async (): Promise<Pm> => (pmInst ||= (createPm as unknown as (c: Core) => Pm)(C));

const jobSchema = z.object({
  running: z.boolean(),
  by: z.string().nullable(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  error: z.string().nullable(),
  log: z.array(z.string()),
  telegram: z.string().nullable(),
});
type Job = z.infer<typeof jobSchema>;
const okSchema = z.object({ ok: z.boolean(), message: z.string().optional() });
// Продукт выбранной вкладки панели; панель добавляет его в каждый вызов.
const P = { product: z.string().optional() };
const pidOf = (x: { product?: string }) => (x.product && C.PRODUCTS.some((p) => p.id === x.product) ? x.product : C.PRODUCTS[0].id);
const prodsSchema = z.array(z.string()).optional();

export const rpcContract = defineRpcContract({
  load: {
    input: z.object({ ...P }),
    output: z.object({
      view: z.unknown(),
      job: jobSchema,
      products: z.array(z.object({ id: z.string(), name: z.string(), short: z.string(), emoji: z.string(), open: z.number().nullable() })),
      setup: z.object({ missing: z.array(z.string()), error: z.string().nullable() }),
    }),
  },
  refresh: { input: z.object({ telegram: z.boolean().optional(), ...P }), output: jobSchema },
  telegram_preview: { input: z.object({ ...P }), output: z.object({ text: z.string() }) },
  telegram_send: { input: z.object({ all: z.boolean().optional(), ...P }), output: okSchema },
  telegram_detect: { input: z.object({ ...P }), output: okSchema },
  telegram_plan: { input: z.object({ ...P }), output: z.object({ list: z.array(z.object({ login: z.string().nullable(), product: z.string(), chars: z.number() })) }) },
  set_override: { input: z.object({ date: z.string(), key: z.string(), res: z.string().nullable(), ...P }), output: okSchema },
  set_note: { input: z.object({ date: z.string(), key: z.string(), text: z.string(), ...P }), output: okSchema },
  set_ack: { input: z.object({ id: z.string(), note: z.string().nullable(), ...P }), output: okSchema },
  set_dates: { input: z.object({ date: z.string(), start: z.string().nullable(), cutoff: z.string().nullable(), ...P }), output: okSchema },
  jira_transitions: { input: z.object({ key: z.string(), ...P }), output: z.object({ list: z.array(z.object({ id: z.string(), name: z.string(), to: z.string() })) }) },
  jira_transition: { input: z.object({ key: z.string(), id: z.string(), ...P }), output: okSchema },
  jira_set_release: { input: z.object({ key: z.string(), date: z.string().nullable(), withChildren: z.boolean(), ...P }), output: okSchema },
  open_folder: { input: z.object({ ...P }), output: okSchema },
  pm_load: { input: z.object({ ...P }), output: z.object({ panel: z.unknown(), bot: z.object({ running: z.boolean(), lastOk: z.string().nullable(), error: z.string().nullable() }) }) },
  pm_add: { input: z.object({ login: z.string(), products: prodsSchema, ...P }), output: okSchema },
  pm_remove: { input: z.object({ login: z.string(), ...P }), output: okSchema },
  po_add: { input: z.object({ login: z.string(), products: prodsSchema, ...P }), output: okSchema },
  po_remove: { input: z.object({ login: z.string(), ...P }), output: okSchema },
  access_products: { input: z.object({ kind: z.enum(["pms", "pos"]), login: z.string(), products: z.array(z.string()), ...P }), output: okSchema },
  access_jira: { input: z.object({ login: z.string(), name: z.string(), ...P }), output: okSchema },
  access_off: { input: z.object({ kind: z.enum(["pms", "pos"]), login: z.string(), off: z.boolean(), ...P }), output: okSchema },
  known_cfg: { input: z.object({ maxDays: z.number(), labels: z.array(z.object({ label: z.string(), mode: z.enum(["days", "next"]), days: z.number().optional() })), ...P }), output: okSchema },
});

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

const PRODUCTS_HELP =
  'JSON-массив. Пример: [{"id":"a","name":"Продукт A","emoji":"🚀"},{"id":"b","name":"Продукт B"}]. ' +
  "id — латиница в нижнем регистре; name — начало имени версии в Jira «<name> ДД/ММ/ГГГГ» и значение поля эпика «Продукт». " +
  "Необязательно: short — короткое имя, version — другое начало имени версии, field — другое значение поля «Продукт». Первый продукт — основной.";

export default async function plugin(bb: BbPluginApi) {
  // Настройки плагина: bb → Settings → Installed plugins → «Релизы».
  const settings = bb.settings.define({
    jiraUrl: { type: "string", label: "Адрес вашей Jira", description: "Jira Cloud, например https://your-company.atlassian.net", default: "" },
    jiraEmail: { type: "string", label: "Email пользователя Jira", description: "Под ним плагин читает Jira и по вашей кнопке меняет статус и релиз", default: "" },
    jiraToken: { type: "string", label: "API-токен Jira", description: "id.atlassian.com → Security → API tokens. Хранится секретом bb", secret: true },
    projectEpic: { type: "string", label: "Проект эпиков (ключ)", description: "Проект, где живут эпики продукта, например PROJ", default: "" },
    projectDev: { type: "string", label: "Проект задач разработки (ключ)", description: "Задачи разработчиков под эпиками, например DEV", default: "" },
    projectDesign: { type: "string", label: "Проект дизайна (ключ, необязательно)", description: "Пусто — дизайн считается по статусу эпика и полю «Ссылка на дизайн»", default: "" },
    projectQa: { type: "string", label: "Проект QA-анализа (ключ, необязательно)", description: "Пусто — проекта QA нет", default: "" },
    products: { type: "string", label: "Продукты", description: PRODUCTS_HELP, experimental_multiline: true, default: "" },
    fieldProduct: { type: "string", label: "Поле эпика «Продукт» (id)", description: "customfield_12345. Нужно, если продуктов несколько. Пусто — эпики отбираются только по версии", default: "" },
    fieldReqLink: { type: "string", label: "Поле «Ссылка на требования» (id)", description: "customfield_…; пусто — правило «нет ссылки на требования» выключено", default: "" },
    fieldDesignLink: { type: "string", label: "Поле «Ссылка на дизайн» (id)", description: "customfield_…; когда заполнили — дизайн готов (если нет задач в проекте дизайна)", default: "" },
    fieldNoDesign: { type: "string", label: "Поле «Не нужен дизайн» (id)", description: "customfield_…; необязательно", default: "" },
    statuses: {
      type: "string",
      label: "Статусы Jira (JSON, необязательно)",
      description:
        'Пусто — встроенные. Можно заменить часть: {"groups":{"done":[…],"test":[…],"hold":[…],"kick":[…],"todo":[…]},' +
        '"phases":{"pre":[…],"qa":[…],"design":[…],"ready":[…],"dev":[…],"done":[…],"parked":[…]},' +
        '"designDone":"…","qaDone":"…","epicReady":"…","epicReleased":"…","canceled":"…","rejected":"…"}. Список встроенных — в README плагина',
      experimental_multiline: true,
      default: "",
    },
    tgToken: { type: "string", label: "Токен Telegram-бота", description: "От @BotFather. Без токена панель работает, сводки и бот выключены. Хранится секретом bb", secret: true },
    tgChatId: { type: "string", label: "Чат сводки (id, необязательно)", description: "Пусто — напишите боту /start и нажмите в панели «Найти чат»", default: "" },
    utcOffset: { type: "string", label: "Часовой пояс, часы от UTC (необязательно)", description: "Например 3. Пусто — пояс компьютера", default: "" },
    claudeBin: { type: "string", label: "Путь к Claude CLI (необязательно)", description: "Проверка комментариев ПМ моделью. Пусто — ~/.local/bin/claude или claude из PATH", default: "" },
  });

  let setupError: string | null = null;
  const apply = (s: Record<string, unknown>) => {
    const str = (k: string) => (typeof s[k] === "string" ? (s[k] as string) : "");
    try {
      C.configure({
        site: str("jiraUrl"), email: str("jiraEmail"), token: str("jiraToken"), tgToken: str("tgToken"), tgChatId: str("tgChatId"), claudeBin: str("claudeBin"),
        projects: { epic: str("projectEpic"), dev: str("projectDev"), design: str("projectDesign"), qa: str("projectQa") },
        fields: { product: str("fieldProduct"), reqLink: str("fieldReqLink"), designLink: str("fieldDesignLink"), noDesign: str("fieldNoDesign") },
        products: str("products"), statuses: str("statuses"), utcOffset: str("utcOffset"),
      });
      setupError = null;
    } catch (e) {
      setupError = msg(e);
      bb.log.error(`настройки: ${setupError}`);
      try { C.configure({}); } catch { /* пустые настройки не падают */ }
    }
    pmInst = null;
  };
  let tgToken = "";
  const initial = (await settings.get()) as Record<string, unknown>;
  tgToken = typeof initial.tgToken === "string" ? initial.tgToken : "";
  apply(initial);

  let job: Job = { running: false, by: null, startedAt: null, finishedAt: null, error: null, log: [], telegram: null };

  settings.onChange((next) => {
    const s = next as Record<string, unknown>;
    tgToken = typeof s.tgToken === "string" ? s.tgToken : "";
    apply(s);
    bb.realtime.publish("job", job);
    bb.realtime.publish("pm", {});
  });
  const setup = () => ({ missing: C.missing(), error: setupError });
  const ready = () => !setupError && !C.missing().length;

  const refresh = async (by: string, telegram: boolean) => {
    if (job.running) return;
    job = { running: true, by, startedAt: new Date().toISOString(), finishedAt: null, error: null, log: [], telegram: null };
    bb.realtime.publish("job", job);
    try {
      if (setupError) throw new Error(`Ошибка в настройках плагина: ${setupError}`);
      const c = await core();
      const all = await c.collectAll((m) => { job.log.push(m); bb.realtime.publish("job", job); });
      for (const p of c.PRODUCTS) if (all[p.id]) c.saveSnapshot(c.view(c.loadData(p.id)));
      try {
        const r = await (await pm()).verify({ notify: true });
        if (r.checked) job.log.push(`проверено заявок ПМ: ${r.checked}`);
      } catch (e) {
        bb.log.error(`pm verify: ${msg(e)}`);
      }
      if (telegram) {
        try {
          const r = await (await pm()).morning(by);
          job.telegram = `отправлено сообщений: ${r.sent}${r.errors.length ? ` · ошибки: ${r.errors.join("; ")}` : ""}`;
        } catch (e) {
          job.telegram = `не отправлено: ${msg(e)}`;
        }
      }
    } catch (e) {
      job.error = msg(e);
      bb.log.error(`refresh (${by}): ${job.error}`);
    } finally {
      job.running = false;
      job.finishedAt = new Date().toISOString();
      bb.log.info(`refresh (${by}): ${job.error ?? "ok"}${job.telegram ? ", telegram " + job.telegram : ""}`);
      bb.realtime.publish("job", job);
    }
  };
  const ok = async (fn: (c: Core) => unknown): Promise<{ ok: boolean; message?: string }> => {
    try {
      await fn(await core());
      return { ok: true };
    } catch (e) {
      return { ok: false, message: msg(e) };
    }
  };

  const okPm = async (fn: (p: Pm) => unknown): Promise<{ ok: boolean; message?: string }> => {
    try {
      await fn(await pm());
      bb.realtime.publish("pm", {});
      return { ok: true };
    } catch (e) {
      return { ok: false, message: msg(e) };
    }
  };

  // ---------- Бот для ПМ: long polling, пока bb запущен; без токена бота — ждём настройку ----------
  const bot = { running: false, lastOk: null as string | null, error: null as string | null };
  let claimTimer: ReturnType<typeof setTimeout> | null = null;
  // ПМ отметил «Решено» — через 3 минуты тишины обновляем данные из Jira и проверяем заявки.
  const onClaim = () => {
    bb.realtime.publish("pm", {});
    if (claimTimer) clearTimeout(claimTimer);
    claimTimer = setTimeout(() => { claimTimer = null; void refresh("проверка заявок ПМ", false); }, 3 * 60_000);
  };
  const ac = new AbortController();
  let stopped = false;
  const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
  const pollLoop = async () => {
    while (!stopped) {
      if (!tgToken) {
        bot.running = false;
        bot.error = "Нет токена Telegram-бота в настройках плагина";
        await sleep(15_000);
        continue;
      }
      bot.running = true;
      try {
        await (await pm()).pollOnce(ac.signal, onClaim, (e) => bb.log.error(`бот: ${msg(e)}`));
        bot.lastOk = new Date().toISOString();
        bot.error = null;
      } catch (e) {
        if (stopped) break;
        bot.error = msg(e);
        bb.log.error(`бот: ${bot.error}`);
        await sleep(15_000);
      }
    }
    bot.running = false;
  };
  void pollLoop();
  bb.onDispose(() => { stopped = true; ac.abort(); if (claimTimer) clearTimeout(claimTimer); });

  bb.rpc.register(rpcContract, {
    load: async (x) => {
      const c = await core(), pid = pidOf(x);
      let view: View | null = null;
      const products = c.PRODUCTS.map((p) => {
        const v = c.view(c.loadData(p.id));
        if (p.id === pid) view = v;
        return { id: p.id, name: p.name, short: p.short, emoji: p.emoji, open: v ? v.anomalies.filter((a) => !a.ack).length : null };
      });
      return { view, job, products, setup: setup() };
    },
    refresh: async ({ telegram }) => {
      void refresh("кнопка", !!telegram);
      return job;
    },
    telegram_preview: async (x) => {
      const c = await core();
      const v = c.view(c.loadData(pidOf(x)));
      return { text: v ? c.telegramText(v) : ready() ? "Нет данных — нажмите «Обновить»" : `Сначала заполните настройки плагина: ${[setupError, ...c.missing()].filter(Boolean).join(", ")}` };
    },
    // all — разослать всем по продуктам (как в 10:00); иначе — сводка выбранного продукта в чат сводки.
    telegram_send: async (x) => {
      try {
        if (x.all) {
          const r = await (await pm()).morning("кнопка «Разослать всем»");
          return { ok: !r.errors.length, message: `Отправлено сообщений: ${r.sent}${r.errors.length ? ` · ошибки: ${r.errors.join("; ")}` : ""}` };
        }
        const c = await core();
        const v = c.view(c.loadData(pidOf(x)));
        if (!v) throw new Error("Нет данных — нажмите «Обновить»");
        const r = await c.sendTelegram(v, "кнопка");
        return { ok: true, message: `Отправлено, ${r.chars} знаков` };
      } catch (e) {
        return { ok: false, message: msg(e) };
      }
    },
    telegram_plan: async () => {
      const r = await (await pm()).morning("план", { dry: true });
      return { list: r.list.map((m) => ({ login: m.login, product: m.product, chars: m.chars })) };
    },
    telegram_detect: async () => {
      try {
        const r = await (await core()).detectChat();
        return r.ok ? { ok: true, message: `Чат: ${r.title}` } : { ok: false, message: r.error || "Чат не найден" };
      } catch (e) {
        return { ok: false, message: msg(e) };
      }
    },
    set_override: (x) => ok((c) => c.setOverride(x.date, x.key, x.res, pidOf(x))),
    set_note: (x) => ok((c) => c.setNote(x.date, x.key, x.text, pidOf(x))),
    set_ack: (x) => ok((c) => c.setAck(x.id, x.note, pidOf(x))),
    set_dates: (x) => ok((c) => c.setDates(x.date, x.start, x.cutoff, pidOf(x))),
    jira_transitions: async ({ key }) => ({ list: await (await core()).jiraTransitions(key) }),
    jira_transition: async ({ key, id }) => {
      try {
        const r = await (await core()).jiraTransition(key, id, "панель");
        void refresh(`после правки ${key}`, false);
        return { ok: true, message: `${key} → «${r.to}»` };
      } catch (e) {
        return { ok: false, message: msg(e) };
      }
    },
    jira_set_release: async (x) => {
      const { key, date, withChildren } = x;
      try {
        const r = await (await core()).jiraSetRelease(key, date, withChildren, "панель", pidOf(x));
        void refresh(`после переноса ${key}`, false);
        return { ok: r.ok, message: [`Изменено: ${r.changed.join(", ") || "—"}`, ...r.errors].join(" · ") };
      } catch (e) {
        return { ok: false, message: msg(e) };
      }
    },
    pm_load: async (x) => ({ panel: (await pm()).panel(pidOf(x)), bot }),
    pm_add: (x) => okPm((p) => p.addPm(x.login, x.products ?? [pidOf(x)])),
    pm_remove: ({ login }) => okPm((p) => p.removePm(login)),
    po_add: (x) => okPm((p) => p.addPo(x.login, x.products ?? [pidOf(x)])),
    po_remove: ({ login }) => okPm((p) => p.removePo(login)),
    access_products: ({ kind, login, products }) => okPm((p) => p.setProducts(kind, login, products)),
    access_jira: ({ login, name }) => okPm((p) => p.setJira(login, name)),
    access_off: ({ kind, login, off }) => okPm((p) => p.setOff(kind, login, off)),
    known_cfg: ({ maxDays, labels }) => okPm((p) => p.setKnownCfg({ maxDays, labels })),
    // Папка данных в файловом менеджере ОС.
    open_folder: async () => {
      const dir = (await core()).OUT_DIR;
      const cmd = process.platform === "win32" ? "explorer.exe" : process.platform === "darwin" ? "open" : "xdg-open";
      try {
        mkdirSync(dir, { recursive: true });
        spawn(cmd, [dir], { detached: true, stdio: "ignore", windowsHide: true }).unref();
        return { ok: true };
      } catch (e) {
        return { ok: false, message: msg(e) };
      }
    },
  });

  const daily = async (by: string) => {
    if (!ready()) return bb.log.info(`${by}: настройки не заполнены — пропуск`);
    const c = await core();
    const today = c.iso(Date.now());
    if (c.loadNotes().cfg.tg.lastSent?.date === today) return bb.log.info(`${by}: сводка за ${today} уже отправлена`);
    await refresh(by, true);
  };
  bb.background.schedule("daily-10", "0 10 * * 1-5", () => daily("расписание 10:00"));

  // Догоняем, если в 10:00 bb был закрыт: будни 10:00–18:00 по часам компьютера, раз в день.
  const t = setTimeout(() => {
    const d = new Date(), day = d.getDay(), hour = d.getHours();
    if (day >= 1 && day <= 5 && hour >= 10 && hour < 18) void daily("запуск bb после 10:00");
  }, 90_000);
  bb.onDispose(() => clearTimeout(t));
}
