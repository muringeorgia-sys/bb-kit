// Конвейер PRD — сервер панели для навыка /prd. Всё о навыке (settings.json, метки в текстах, агенты,
// версии, журнал, черновики) — в ./core/core.mjs. Папки навыка, агентов и данных — настройки плагина;
// пусто — core ищет установленный навык сам (~/.claude/skills/prd или кэш плагина Claude prd-pipeline).
// Прошлые прогоны — <папка PRD>/<Фича>_материалы/run_log.md (настройка «Папка с PRD»).
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import * as core from "./core/core.mjs";
import { draftText, evalText } from "./core/prompts.mjs";
import type { Loaded, Preview, DraftPreview, Run, RunRow } from "./types";

const MATERIALS_SUFFIX = "_материалы";

const any = z.any();
const change = z.object({ kind: z.string() }).passthrough();
const draftId = z.object({ id: z.string() });
export const rpcContract = defineRpcContract({
  load: { input: z.object({}), output: any },
  read_file: { input: z.object({ rel: z.string() }), output: z.object({ text: z.string() }) },
  preview: { input: z.object({ change }), output: any },
  apply: { input: z.object({ change, title: z.string() }), output: any },
  fix_preview: { input: z.object({ mode: z.enum(["render", "adopt"]) }), output: any },
  fix_apply: { input: z.object({ mode: z.enum(["render", "adopt"]) }), output: any },
  acknowledge: { input: z.object({}), output: any },
  restore_preview: { input: z.object({ version: z.string() }), output: any },
  restore_apply: { input: z.object({ version: z.string() }), output: any },
  draft_create: { input: z.object({ request: z.string() }), output: any },
  draft_preview: { input: draftId, output: any },
  draft_accept: { input: draftId, output: any },
  draft_reject: { input: draftId, output: any },
  // Для треда черновика (bb plugin rpc call <id> draft_render --input-file D/rpc.json)
  draft_render: { input: draftId, output: z.object({ changed: z.array(z.string()) }) },
  draft_check: { input: draftId, output: any },
  draft_diff: { input: draftId, output: any },
  eval_start: { input: z.object({ draftId: z.string().optional() }), output: z.object({ threadId: z.string() }) },
  open_folder: { input: z.object({ target: z.enum(["skill", "agents", "data"]) }), output: z.object({ ok: z.boolean() }) },
  paths: { input: z.object({}), output: any },
  copy_to_user: { input: z.object({}), output: any },
});

const read = async (file: string) => (await readFile(file, "utf8")).replace(/^﻿/, "").replace(/\r\n/g, "\n");

// run_log.md formats differ between runs: take every markdown table whose
// header has an «Агент» column, map columns by header name, keep the lines
// with user decisions and limits as notes.
const COLUMNS: [keyof RunRow, RegExp][] = [
  ["step", /волна|шаг/i],
  ["agent", /агент/i],
  ["model", /модель/i],
  ["tokens", /токен/i],
  ["time", /время/i],
  ["status", /статус/i],
  ["file", /файл/i],
];
const cells = (line: string) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
const isSeparator = (line: string) => /^\|[\s:|-]+\|?$/.test(line.trim());
const plain = (s: string) => s.replace(/\*\*/g, "").replace(/`/g, "").trim();

function parseRunLog(text: string): Pick<Run, "mode" | "date" | "rows" | "notes"> {
  const lines = text.split("\n");
  const head = lines.slice(0, 6).join("\n");
  const mode = /\bFull\b/.test(head) ? "Full" : /\bLite\b/.test(head) ? "Lite" : null;
  const date = /\d{4}-\d{2}-\d{2}/.exec(head)?.[0] ?? null;
  const rows: RunRow[] = [];
  const notes: string[] = [];
  let map: Partial<Record<keyof RunRow, number>> | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim().startsWith("|")) {
      if (isSeparator(line)) continue;
      const header = cells(line);
      if (isSeparator(lines[i + 1] ?? "") || header.some((h) => /^агент$/i.test(h))) {
        const next: Partial<Record<keyof RunRow, number>> = {};
        for (const [key, re] of COLUMNS) {
          const idx = header.findIndex((h) => re.test(h));
          if (idx >= 0) next[key] = idx;
        }
        map = next.agent !== undefined ? next : null;
        continue;
      }
      if (!map) continue;
      const c = cells(line);
      const at = (k: keyof RunRow) => (map![k] === undefined ? "" : plain(c[map![k]!] ?? ""));
      rows.push({ step: at("step"), agent: at("agent"), model: at("model"), tokens: at("tokens"), time: at("time"), status: at("status"), file: at("file") });
    } else if (/^(\*\*)?(Решения|Ответы|Лимиты после)/.test(line.trim())) {
      notes.push(plain(line));
    }
  }
  return { mode, date, rows, notes };
}

// Прогоны: <корень>/<Фича>_материалы/run_log.md и на уровень глубже (<корень>/<спринт>/<Фича>_материалы/).
async function collectRuns(root: string): Promise<Run[]> {
  if (!root || !existsSync(root)) return [];
  const rel = (abs: string) => path.relative(root, abs).split(path.sep).join("/");
  const runs: Run[] = [];
  const scan = async (dir: string, sprint: string) => {
    for (const entry of await readdir(dir)) {
      if (!entry.endsWith(MATERIALS_SUFFIX)) continue;
      const log = path.join(dir, entry, "run_log.md");
      if (!existsSync(log)) continue;
      const feature = entry.slice(0, -MATERIALS_SUFFIX.length);
      const prd = path.join(dir, `${feature}.md`);
      const design = path.join(dir, `${feature}.design.html`);
      const parsed = parseRunLog(await read(log));
      runs.push({
        feature,
        sprint,
        ...parsed,
        date: parsed.date ?? (await stat(log)).mtime.toISOString().slice(0, 10),
        logPath: rel(log),
        prdPath: existsSync(prd) ? rel(prd) : null,
        designPath: existsSync(design) ? rel(design) : null,
      });
    }
  };
  await scan(root, ".");
  for (const sub of await readdir(root)) {
    const dir = path.join(root, sub);
    if (sub.startsWith(".") || sub.endsWith(MATERIALS_SUFFIX) || sub === "node_modules") continue;
    if (!(await stat(dir)).isDirectory()) continue;
    await scan(dir, sub);
  }
  return runs.sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
}

const DRAFT_PROMPT = (file: string, id: string, dir: string, request: string) =>
  [`Прочитай и выполни ${file}.`, `Черновик: ${id} (папка ${dir}).`, `Просьба пользователя:`, request].join("\n");
const EVAL_PROMPT = (file: string, draftId?: string, dir?: string) =>
  [`Прочитай и выполни ${file}.`, draftId ? `Цель: черновик ${draftId} (папка ${dir}).` : `Цель: рабочий скилл.`].join("\n");

export default async function plugin(bb: BbPluginApi) {
  // Настройки: bb → Settings → Installed plugins → «Конвейер PRD».
  const settings = bb.settings.define({
    skillDir: {
      type: "string",
      label: "Папка навыка prd",
      description: "Пусто — ~/.claude/skills/prd, иначе кэш плагина Claude prd-pipeline (правки там пропадут при обновлении плагина)",
      default: "",
    },
    agentsDir: { type: "string", label: "Папка агентов prd-*", description: "Пусто — agents/ плагина рядом с навыком или ~/.claude/agents", default: "" },
    dataDir: { type: "string", label: "Папка журнала и версий", description: "Пусто — ~/.config/bb-prd-pipeline", default: "" },
    runsRoot: {
      type: "string",
      label: "Папка с PRD",
      description: "Корень проекта с папками спринтов: вкладка «Прогоны» читает <папка>/<спринт>/<Фича>_материалы/run_log.md. Пусто — вкладка пустая",
      default: "",
    },
    projectId: {
      type: "string",
      label: "Проект bb для тредов",
      description: "id проекта, где запускаются треды «Поменять словами» и эталон. Пусто — личный проект",
      default: "",
    },
    environmentId: { type: "string", label: "Окружение bb", description: "id окружения проекта. Пусто — окружение проекта по умолчанию", default: "" },
  });
  let current = await settings.get();
  const apply = () =>
    core.configure({ skill: current.skillDir || undefined, agents: current.agentsDir || undefined, data: current.dataDir || undefined });
  apply();
  settings.onChange((next) => {
    current = next;
    apply();
  });

  const ctx = () => ({ data: core.DATA, skill: core.LIVE.skill, agents: core.LIVE.agents, pluginId: bb.pluginId });
  const writePrompt = (name: string, text: string) => {
    mkdirSync(core.DATA, { recursive: true });
    const file = path.join(core.DATA, name);
    writeFileSync(file, text, "utf8");
    return file;
  };

  // Треды: проект из настройки или личный проект bb.
  const target = async () => {
    if (current.projectId) {
      const environment = current.environmentId
        ? ({ type: "reuse", environmentId: current.environmentId } as const)
        : ({ type: "project-default" } as const);
      return { projectId: current.projectId, environment };
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const list: any[] = (await bb.sdk.projects.list({ includePersonal: true })) as any[];
    const personal = list.find((p) => p?.isPersonal) ?? list[0];
    if (!personal) throw new Error("Нет проекта bb: укажите «Проект bb для тредов» в настройках плагина");
    return { projectId: String(personal.id), environment: { type: "host", workspace: { type: "personal" } } as const };
  };
  const spawnThread = async (title: string, prompt: string) => {
    const t = await target();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return bb.sdk.threads.spawn({ ...t, providerId: "claude-code", title, prompt } as any);
  };

  const threadStatus = async (threadId: string | undefined): Promise<string | null> => {
    if (!threadId) return null;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const t: any = await bb.sdk.threads.get({ threadId });
      const th = t?.thread ?? t;
      return th?.runtime?.displayStatus ?? th?.status ?? null;
    } catch {
      return null;
    }
  };

  bb.rpc.register(rpcContract, {
    load: async (): Promise<Loaded> => {
      if (!existsSync(path.join(core.LIVE.skill, "settings.json")))
        throw new Error(`Не найден навык prd (${core.LIVE.skill}). Установите плагин Claude prd-pipeline или укажите папку навыка в настройках`);
      const data = core.load();
      for (const d of data.drafts) if (d.status === "work") d.threadStatus = await threadStatus(d.threadId);
      return { ...data, runs: await collectRuns(current.runsRoot), projectId: current.projectId, environmentId: current.environmentId };
    },
    read_file: async ({ rel }) => ({ text: core.readFileText(rel) }),
    preview: async ({ change }): Promise<Preview> => core.previewChange(change),
    apply: async ({ change, title }) => core.applyChange(change, { by: "PO", title }),
    fix_preview: async ({ mode }): Promise<Preview> => core.previewChange(core.fixChange(mode)),
    fix_apply: async ({ mode }) =>
      core.applyChange(core.fixChange(mode), { by: "PO", title: mode === "adopt" ? "Числа взяты из текста" : "Тексты переписаны по настройкам" }),
    acknowledge: async () => core.acknowledgeOutside("чат"),
    restore_preview: async ({ version }): Promise<Preview> => core.previewRestore(version),
    restore_apply: async ({ version }) => core.applyRestore(version, "PO"),
    draft_create: async ({ request }) => {
      const d = core.createDraft(request);
      writeFileSync(path.join(d.dir, "rpc.json"), JSON.stringify({ id: d.id }) + "\n", "utf8");
      const file = writePrompt("DRAFT.md", draftText(ctx()));
      const thread = await spawnThread(`Конвейер PRD: правка — ${request.slice(0, 50)}`, DRAFT_PROMPT(file, d.id, d.dir, request));
      core.setDraftMeta(d.id, { threadId: thread.id });
      bb.log.info(`draft ${d.id}: thread ${thread.id}`);
      return { id: d.id, threadId: thread.id };
    },
    draft_preview: async ({ id }): Promise<DraftPreview> => core.previewDraft(id),
    draft_accept: async ({ id }) => core.acceptDraft(id, "ИИ"),
    draft_reject: async ({ id }) => {
      core.rejectDraft(id);
      return { ok: true };
    },
    draft_render: async ({ id }) => ({ changed: core.renderRoot(core.draftRoot(id)) }),
    draft_check: async ({ id }) => ({ problems: core.check(core.draftRoot(id)) }),
    draft_diff: async ({ id }) => core.previewDraft(id),
    eval_start: async ({ draftId }) => {
      const file = writePrompt("EVAL.md", evalText(ctx()));
      const dir = draftId ? path.join(core.DATA, "drafts", draftId) : undefined;
      const thread = await spawnThread(draftId ? `Конвейер PRD: эталон черновика ${draftId}` : "Конвейер PRD: эталонный прогон", EVAL_PROMPT(file, draftId, dir));
      core.recordEvalRun({ threadId: thread.id, target: draftId ?? "live" });
      if (draftId) core.setDraftMeta(draftId, { evalThreadId: thread.id });
      return { threadId: thread.id };
    },
    open_folder: async ({ target }) => {
      const dir = target === "skill" ? core.LIVE.skill : target === "agents" ? core.LIVE.agents : core.DATA;
      const opener = process.platform === "win32" ? "explorer.exe" : process.platform === "darwin" ? "open" : "xdg-open";
      spawn(opener, [dir], { detached: true, stdio: "ignore", windowsHide: true }).unref();
      return { ok: true };
    },
    paths: async () => ({ ...core.LIVE, data: core.DATA, kind: core.SKILL_KIND, runsRoot: current.runsRoot }),
    // Копия навыка и агентов в ~/.claude для правки, которая переживёт обновление плагина.
    // После копии отключите Claude-плагин prd-pipeline, чтобы не было двух навыков prd (README).
    copy_to_user: async () => {
      const res = core.copyToUser();
      bb.log.info(`prd skill copied to ${core.LIVE.skill}`);
      return res;
    },
  });
  const p = apply();
  bb.log.info(`prd-pipeline loaded: skill ${p.skill} (${p.kind}), agents ${p.agents}, data ${p.data}`);
}
