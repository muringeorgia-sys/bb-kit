// Калькулятор: один процесс Python (build.py --serve) на всё время работы панели, запросы и ответы — строками JSON.
// Процесс перезапускается сам, если build.py в папке данных изменился.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { statSync } from "node:fs";
import path from "node:path";
import { findPython, type DataPaths, type Python } from "./core/core.mjs";

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };

export class Calc {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private mtime = 0;
  private buf = "";
  private err: string[] = [];
  private seq = 0;
  private pending = new Map<number, Pending>();
  private py: Python | null = null;

  constructor(private log: (m: string) => void, private paths: () => DataPaths, private pySetting: () => string) {}

  resetPython() {
    this.py = null;
    this.stop("настройки изменены");
  }

  private ensure() {
    const build = this.paths().build;
    const m = statSync(build).mtimeMs;
    if (this.proc && this.proc.exitCode === null && this.mtime === m) return;
    this.stop("калькулятор перезапущен");
    if (!this.py) this.py = findPython(this.pySetting());
    this.mtime = m;
    this.buf = "";
    this.err = [];
    const p = spawn(this.py.cmd, [...this.py.pre, build, "--serve"], {
      cwd: path.dirname(build),
      env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
      windowsHide: true,
    });
    p.stdout.setEncoding("utf8");
    p.stderr.setEncoding("utf8");
    p.stdout.on("data", (chunk: string) => {
      this.buf += chunk;
      let i: number;
      while ((i = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, i).trim();
        this.buf = this.buf.slice(i + 1);
        if (!line) continue;
        try {
          const r = JSON.parse(line) as { id: number; ok: boolean; data?: unknown; error?: string };
          const w = this.pending.get(r.id);
          if (!w) continue;
          this.pending.delete(r.id);
          clearTimeout(w.timer);
          if (r.ok) w.resolve(r.data);
          else w.reject(new Error(r.error ?? "ошибка калькулятора"));
        } catch {
          this.log(`не разобран ответ калькулятора: ${line.slice(0, 200)}`);
        }
      }
    });
    p.stderr.on("data", (chunk: string) => {
      this.err.push(chunk);
      if (this.err.length > 40) this.err.shift();
    });
    p.on("exit", (code) => {
      const tail = this.err.join("").trim().split("\n").slice(-4).join(" ");
      if (this.proc === p) this.proc = null;
      for (const [id, w] of this.pending) {
        clearTimeout(w.timer);
        w.reject(new Error(`калькулятор остановился (код ${code})${tail ? ": " + tail : ""}`));
        this.pending.delete(id);
      }
    });
    p.on("error", (e) => this.log(`не запустился Python: ${e.message}`));
    this.proc = p;
  }

  ask(req: Record<string, unknown>, timeoutMs = 60_000): Promise<unknown> {
    try {
      this.ensure();
    } catch (e) {
      return Promise.reject(e);
    }
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("калькулятор не ответил за 60 с"));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.proc!.stdin.write(JSON.stringify({ id, ...req }) + "\n");
    });
  }

  stop(reason = "панель закрыта") {
    if (!this.proc) return;
    for (const [id, w] of this.pending) {
      clearTimeout(w.timer);
      w.reject(new Error(reason));
      this.pending.delete(id);
    }
    try {
      this.proc.stdin.end();
      this.proc.kill();
    } catch {
      /* процесс уже завершился */
    }
    this.proc = null;
  }
}
