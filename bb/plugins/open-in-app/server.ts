// Open In App — opens office and PDF files from the bb side panel in the
// default Windows application of this machine.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

const EXTENSIONS = ["pptx", "ppt", "pdf", "docx", "doc", "xlsx", "xls"];

const sourceSchema = z.object({
  kind: z.enum(["workspace", "host", "thread-storage"]),
  threadId: z.string().nullable(),
  environmentId: z.string().nullable(),
  projectId: z.string().nullable(),
});

export const rpcContract = defineRpcContract({
  open_file: {
    input: z.object({ path: z.string().min(1), source: sourceSchema }),
    output: z.object({ opened: z.string() }),
  },
});

export default async function plugin(bb: BbPluginApi) {
  async function resolve(file: string, source: z.infer<typeof sourceSchema>): Promise<string> {
    if (source.kind === "host") return path.resolve(file);
    if (source.kind === "thread-storage") {
      if (!source.threadId) throw new Error("Нет треда для файла из thread-storage");
      return path.resolve(homedir(), ".bb", "thread-storage", source.threadId, file);
    }
    if (!source.environmentId) throw new Error("Нет окружения для файла");
    const env = await bb.sdk.environments.get({ environmentId: source.environmentId });
    if (!env.path) throw new Error("У окружения нет пути на диске");
    return path.resolve(env.path, file);
  }

  bb.rpc.register(rpcContract, {
    open_file: async ({ path: file, source }) => {
      const full = await resolve(file, source);
      const ext = path.extname(full).slice(1).toLowerCase();
      if (!EXTENSIONS.includes(ext)) throw new Error(`Тип .${ext} не поддерживается`);
      if (!existsSync(full)) throw new Error(`Файл не найден: ${full}`);
      // explorer.exe opens the file with its associated app and handles Cyrillic paths.
      spawn("explorer.exe", [full], { detached: true, stdio: "ignore", windowsHide: true }).unref();
      bb.log.info(`opened ${full}`);
      return { opened: full };
    },
  });
}
