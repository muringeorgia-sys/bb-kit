// Ответы TG — упоминания в Telegram с вариантами ответа в вашем тоне.
// Логика — ./core/core.mjs (тот же код запускает core/run.mjs для проверки без bb).
// Telegram — свой telegram-mcp (github.com/chigwell/telegram-mcp) на отдельной сессии: чтение + ответ + черновик,
// отправка только по кнопке в панели. Ключи Telegram API — секреты в настройках плагина.
// Расписание поиска — настройка «Расписание» (cron), по умолчанию будни 10:00–17:45 каждые 15 минут.
import { spawn } from "node:child_process";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { createCore as createCoreJs, DEFAULT_MCP_DIR } from "./core/core.mjs";

type View = { auth: { state: string }; job: { running: boolean } } & Record<string, unknown>;
type Core = {
  DATA_DIR: string;
  scan(by: string): Promise<unknown>;
  view(): View;
  generate(key: string, hint?: string): Promise<unknown>;
  send(key: string, text: string, fromIdx: number): Promise<{ sim: number | null }>;
  draft(key: string, text: string, fromIdx: number): Promise<void>;
  done(key: string): void;
  dismiss(key: string): void;
  restore(key: string): void;
  ignoreChat(chatId: string, on: boolean): void;
  setCfg(patch: Record<string, unknown>): void;
  setManual(text: string): void;
  buildProfile(by?: string): Promise<void>;
  startLogin(): unknown;
  loginPassword(pw: string): void;
  cancelLogin(): void;
  checkAuth(): Promise<boolean>;
  dispose(): void;
};

const okSchema = z.object({ ok: z.boolean(), message: z.string().optional() });
const key = z.object({ key: z.string() });
const reply = z.object({ key: z.string(), text: z.string().max(4096), fromIdx: z.number().int() });

export const rpcContract = defineRpcContract({
  load: { input: z.object({}), output: z.object({ view: z.unknown() }) },
  refresh: { input: z.object({}), output: okSchema },
  generate: { input: z.object({ key: z.string(), hint: z.string().max(500).optional() }), output: okSchema },
  send: { input: reply, output: okSchema },
  draft: { input: reply, output: okSchema },
  done: { input: key, output: okSchema },
  dismiss: { input: key, output: okSchema },
  restore: { input: key, output: okSchema },
  ignore_chat: { input: z.object({ chatId: z.string(), on: z.boolean() }), output: okSchema },
  set_cfg: {
    input: z.object({
      lookbackDays: z.number().optional(),
      names: z.array(z.string()).optional(),
      privateChats: z.boolean().optional(),
      autoGenerate: z.boolean().optional(),
      model: z.string().optional(),
      rebuildEvery: z.number().optional(),
    }),
    output: okSchema,
  },
  set_manual: { input: z.object({ text: z.string().max(3000) }), output: okSchema },
  build_profile: { input: z.object({}), output: okSchema },
  login_start: { input: z.object({}), output: okSchema },
  login_password: { input: z.object({ password: z.string().min(1).max(256) }), output: okSchema },
  login_cancel: { input: z.object({}), output: okSchema },
  open_data: { input: z.object({}), output: okSchema },
});

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export default async function plugin(bb: BbPluginApi) {
  // Обновления панели не чаще раза в 700 мс.
  let pubTimer: ReturnType<typeof setTimeout> | null = null;
  const publish = () => {
    if (pubTimer) return;
    pubTimer = setTimeout(() => {
      pubTimer = null;
      bb.realtime.publish("tg", {});
    }, 700);
  };

  // Настройки плагина: bb → Настройки → Плагины → «Ответы TG». Ключи — секреты (файл 0600, не уходят в панель).
  const settings = bb.settings.define({
    apiId: { type: "string", label: "Telegram api_id", description: "С my.telegram.org → API development tools", secret: true },
    apiHash: { type: "string", label: "Telegram api_hash", description: "Там же, где api_id", secret: true },
    about: {
      type: "string",
      label: "Кто вы",
      description: "Одна строка для модели: имя, роль, где работаете. Пример: «Анна, менеджер продукта в интернет-магазине»",
      default: "",
    },
    deviceName: { type: "string", label: "Имя устройства в Telegram", description: "Так сессия видна в Telegram → Устройства", default: "TG-ответы (bb)" },
    mcpDir: { type: "string", label: "Папка telegram-mcp", description: `Пусто — ${DEFAULT_MCP_DIR}`, default: "" },
    claudePath: { type: "string", label: "Путь к Claude CLI", description: "Пусто — ~/.local/bin/claude или claude из PATH", default: "" },
    schedule: {
      type: "string",
      label: "Расписание поиска (cron)",
      description: "По умолчанию будни 10:00–17:45 каждые 15 минут. Изменение — после перезагрузки плагина",
      default: "*/15 10-17 * * 1-5",
    },
  });
  let current = await settings.get();
  settings.onChange((next) => {
    current = next;
  });

  const instance: Core = (createCoreJs as unknown as (o: unknown) => Core)({
    log: (m: string) => bb.log.info(m),
    notify: publish,
    settings: () => current,
  });
  const core = async (): Promise<Core> => instance;
  bb.onDispose(() => {
    if (pubTimer) clearTimeout(pubTimer);
    instance.dispose();
  });

  const ok = async (fn: (c: Core) => unknown, message?: (r: unknown) => string): Promise<{ ok: boolean; message?: string }> => {
    try {
      const r = await fn(await core());
      const m = message?.(r);
      return m ? { ok: true, message: m } : { ok: true };
    } catch (e) {
      return { ok: false, message: msg(e).replace(/^AUTH:\s*/, "") };
    }
  };

  let authCheck: Promise<boolean> | null = null;
  const scan = async (by: string) => {
    const c = await core();
    const v = c.view();
    if (v.auth.state === "needed" || v.job.running) return;
    await c.scan(by);
  };

  bb.rpc.register(rpcContract, {
    load: async () => {
      const c = await core();
      const view = c.view();
      // вход ещё не проверен (старт или перезагрузка core) — проверить в фоне, панель обновится по realtime
      if (view.auth.state === "unknown" && !authCheck) authCheck = c.checkAuth().finally(() => (authCheck = null));
      return { view };
    },
    refresh: () => ok((c) => void c.scan("кнопка")),
    generate: ({ key, hint }) => ok((c) => void c.generate(key, hint)),
    send: ({ key, text, fromIdx }) => ok((c) => c.send(key, text, fromIdx), () => "Отправлено"),
    draft: ({ key, text, fromIdx }) => ok((c) => c.draft(key, text, fromIdx), () => "Черновик в Telegram: откройте чат и допишите"),
    done: ({ key }) => ok((c) => c.done(key)),
    dismiss: ({ key }) => ok((c) => c.dismiss(key)),
    restore: ({ key }) => ok((c) => c.restore(key)),
    ignore_chat: ({ chatId, on }) => ok((c) => c.ignoreChat(chatId, on)),
    set_cfg: (patch) => ok((c) => c.setCfg(patch)),
    set_manual: ({ text }) => ok((c) => c.setManual(text), () => "Правила сохранены"),
    build_profile: () => ok((c) => c.buildProfile("кнопка"), () => "Профиль тона обновлён"),
    login_start: () => ok((c) => c.startLogin()),
    login_password: ({ password }) => ok((c) => c.loginPassword(password)),
    login_cancel: () => ok((c) => c.cancelLogin()),
    open_data: () =>
      ok(async (c) => {
        const opener = process.platform === "win32" ? "explorer.exe" : process.platform === "darwin" ? "open" : "xdg-open";
        spawn(opener, [c.DATA_DIR], { detached: true, stdio: "ignore", windowsHide: true }).unref();
      }),
  });

  bb.background.schedule("scan", current.schedule || "*/15 10-17 * * 1-5", () => scan("расписание"));

  // При запуске bb: проверить вход и сразу поискать упоминания.
  const t = setTimeout(() => {
    void (async () => {
      try {
        const c = await core();
        if (!current.apiId || !current.apiHash) return; // ключи ещё не заданы — панель подскажет
        if (!(await c.checkAuth())) return;
        await scan("запуск bb");
      } catch (e) {
        bb.log.error(`старт: ${msg(e)}`);
      }
    })();
  }, 20_000);
  bb.onDispose(() => clearTimeout(t));
}
