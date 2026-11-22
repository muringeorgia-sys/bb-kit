// Agents — lists Claude Code subagents from ~/.claude/agents and lets the user
// edit, create, disable and delete them. Disabled agents move to
// ~/.claude/agents-disabled, deleted ones to ~/.claude/agents-trash.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

const ROOT = path.join(homedir(), ".claude");
const ACTIVE_DIR = path.join(ROOT, "agents");
const DISABLED_DIR = path.join(ROOT, "agents-disabled");
const TRASH_DIR = path.join(ROOT, "agents-trash");
const KNOWN_KEYS = ["name", "description", "model", "effort", "tools", "omitClaudeMd"];
const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

const agentSchema = z.object({
  file: z.string(),
  enabled: z.boolean(),
  name: z.string(),
  description: z.string(),
  model: z.string(),
  effort: z.string(),
  tools: z.string(),
  omitClaudeMd: z.boolean(),
  extra: z.string(),
  body: z.string(),
  updatedAt: z.string(),
});
export type Agent = z.infer<typeof agentSchema>;

const draftSchema = agentSchema.omit({ file: true, enabled: true, updatedAt: true });
const refSchema = z.object({ file: z.string().min(1), enabled: z.boolean() });

export const rpcContract = defineRpcContract({
  list: { input: z.object({}), output: z.object({ agents: z.array(agentSchema), dir: z.string() }) },
  save: {
    input: z.object({ original: refSchema.nullable(), draft: draftSchema }),
    output: z.object({ file: z.string(), enabled: z.boolean() }),
  },
  set_enabled: { input: refSchema, output: z.object({ ok: z.boolean() }) },
  remove: { input: refSchema, output: z.object({ trashed: z.string() }) },
  open_folder: { input: z.object({}), output: z.object({ ok: z.boolean() }) },
});

function unquote(value: string): string {
  const v = value.trim();
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    return v.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replace(/''/g, "'");
  return v;
}

function quoteIfNeeded(value: string): string {
  const v = value.replace(/\r?\n/g, " ").trim();
  if (v === "" || /: |#|^[\-?:,\[\]{}&*!|>'"%@`]/.test(v)) {
    return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return v;
}

function parse(text: string, file: string, enabled: boolean, updatedAt: string): Agent {
  const src = text.replace(/\r\n/g, "\n");
  const fields: Record<string, string> = {};
  const extra: string[] = [];
  let body = src;
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(src);
  if (m) {
    body = src.slice(m[0].length);
    for (const line of m[1].split("\n")) {
      const kv = /^([A-Za-z_][\w-]*):\s?(.*)$/.exec(line);
      if (kv && KNOWN_KEYS.includes(kv[1])) fields[kv[1]] = unquote(kv[2]);
      else if (line.trim()) extra.push(line);
    }
  }
  return {
    file,
    enabled,
    name: fields.name ?? path.basename(file, ".md"),
    description: fields.description ?? "",
    model: fields.model ?? "",
    effort: fields.effort ?? "",
    tools: fields.tools ?? "",
    omitClaudeMd: fields.omitClaudeMd === "true",
    extra: extra.join("\n"),
    body: body.replace(/^\n+/, ""),
    updatedAt,
  };
}

function serialize(d: z.infer<typeof draftSchema>): string {
  const lines = [`name: ${d.name}`, `description: ${quoteIfNeeded(d.description)}`];
  if (d.model) lines.push(`model: ${d.model}`);
  if (d.effort) lines.push(`effort: ${d.effort}`);
  if (d.tools.trim()) lines.push(`tools: ${d.tools.replace(/\s*\n\s*/g, ", ").trim()}`);
  if (d.omitClaudeMd) lines.push("omitClaudeMd: true");
  if (d.extra.trim()) lines.push(d.extra.trim());
  return `---\n${lines.join("\n")}\n---\n\n${d.body.replace(/\r\n/g, "\n").trim()}\n`;
}

const dirOf = (enabled: boolean) => (enabled ? ACTIVE_DIR : DISABLED_DIR);

function safeFile(file: string): string {
  if (file !== path.basename(file) || !file.endsWith(".md")) throw new Error(`Некорректное имя файла: ${file}`);
  return file;
}

async function readDir(dir: string, enabled: boolean): Promise<Agent[]> {
  if (!existsSync(dir)) return [];
  const files = (await readdir(dir)).filter((f) => f.endsWith(".md"));
  return Promise.all(
    files.map(async (f) => {
      const full = path.join(dir, f);
      const [text, info] = await Promise.all([readFile(full, "utf8"), stat(full)]);
      return parse(text, f, enabled, info.mtime.toISOString());
    }),
  );
}

export default async function plugin(bb: BbPluginApi) {
  bb.rpc.register(rpcContract, {
    list: async () => {
      const agents = [...(await readDir(ACTIVE_DIR, true)), ...(await readDir(DISABLED_DIR, false))];
      agents.sort((a, b) => a.name.localeCompare(b.name));
      return { agents, dir: ACTIVE_DIR };
    },

    save: async ({ original, draft }) => {
      if (!NAME_RE.test(draft.name)) throw new Error("Имя: только латиница в нижнем регистре, цифры и дефис");
      if (!draft.description.trim()) throw new Error("Заполни описание: по нему Claude решает, когда звать агента");
      const enabled = original?.enabled ?? true;
      const file = `${draft.name}.md`;
      const target = path.join(dirOf(enabled), file);
      const renamed = !original || original.file !== file;
      if (renamed && (existsSync(path.join(ACTIVE_DIR, file)) || existsSync(path.join(DISABLED_DIR, file)))) {
        throw new Error(`Агент ${draft.name} уже есть`);
      }
      await mkdir(dirOf(enabled), { recursive: true });
      await writeFile(target, serialize(draft), "utf8");
      if (original && renamed) await unlink(path.join(dirOf(original.enabled), safeFile(original.file)));
      bb.log.info(`saved ${target}`);
      return { file, enabled };
    },

    set_enabled: async ({ file, enabled }) => {
      safeFile(file);
      const from = path.join(dirOf(!enabled), file);
      const to = path.join(dirOf(enabled), file);
      if (!existsSync(from)) throw new Error(`Файл не найден: ${from}`);
      if (existsSync(to)) throw new Error(`Уже существует: ${to}`);
      await mkdir(dirOf(enabled), { recursive: true });
      await rename(from, to);
      bb.log.info(`${enabled ? "enabled" : "disabled"} ${file}`);
      return { ok: true };
    },

    remove: async ({ file, enabled }) => {
      safeFile(file);
      const from = path.join(dirOf(enabled), file);
      if (!existsSync(from)) throw new Error(`Файл не найден: ${from}`);
      await mkdir(TRASH_DIR, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const to = path.join(TRASH_DIR, `${path.basename(file, ".md")}.${stamp}.md`);
      await rename(from, to);
      bb.log.info(`trashed ${from} -> ${to}`);
      return { trashed: to };
    },

    open_folder: async () => {
      await mkdir(ACTIVE_DIR, { recursive: true });
      spawn("explorer.exe", [ROOT], { detached: true, stdio: "ignore", windowsHide: true }).unref();
      return { ok: true };
    },
  });
}
