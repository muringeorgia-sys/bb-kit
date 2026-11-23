// ИИ в панели «Выручка фич»:
// - «Оценить новые» / «Переоценить все» — тред ИИ в bb на выбранный релиз, ИИ пишет фичи в releases/features.json;
// - «Ревью» — вы идёте по фичам релиза: «Далее» без правок = принято, с правками входов или комментарием —
//   задача в один тред ИИ на релиз (bb ставит сообщения в очередь), ИИ вносит правки в features.json.
// Состояние: <папка данных>/reviews/<релиз>.json (ревью) и ai_runs.json (запуски оценки).
// ИИ отмечает готовность фичи скриптом py/review_mark.py — так панель узнаёт, что можно смотреть снова.
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { DataPaths } from "./core/core.mjs";

export type AiSettings = {
  productName: string; revenueLines: string; currency: string; aiProjectId: string; aiEnvironmentId: string; python: string;
};
export type AiDeps = {
  paths: () => DataPaths;
  settings: () => AiSettings;
  /** build.py {list: true}: релизы, оценённые фичи и эпики без оценки */
  pool: (file: string) => Promise<any>;
  /** расчёт релиза, как у вкладки «Релиз» */
  data: (file: string, release: string | null) => Promise<any>;
};

type Edit = { id: string; name: string; unit: string; from: number; to: number };
type RvItem = {
  status: "accepted" | "sent" | "done" | "question";
  at: string;
  round: number;
  comment?: string;
  edits?: Edit[];
  before?: number | null;
  after?: number | null;
  ai_note?: string;
  ai_at?: string;
  history?: Omit<RvItem, "history">[];
};
type RvFile = { release: string; file: string; started: string; threadId: string | null; items: Record<string, RvItem> };
type Run = { threadId: string; mode: "new" | "all"; startedAt: string; keys: string[] };

const relSchema = z.string().regex(/^(\d{4}-\d{2}-\d{2}|all|none)$/);
const fileSchema = z.string().regex(/^[\w.\-]+\.json$/);
const editSchema = z.object({ id: z.string(), name: z.string(), unit: z.string(), from: z.number(), to: z.number() });

export const aiContract = {
  ai_state: {
    input: z.object({ file: fileSchema, release: relSchema }),
    output: z.object({ run: z.unknown(), runStatus: z.string().nullable(), review: z.unknown(), reviewStatus: z.string().nullable(), cfgMtime: z.number() }),
  },
  ai_estimate: {
    input: z.object({ file: fileSchema, release: relSchema, mode: z.enum(["new", "all"]) }),
    output: z.object({ threadId: z.string(), reused: z.boolean(), count: z.number() }),
  },
  review_submit: {
    input: z.object({
      file: fileSchema, release: relSchema, key: z.string().regex(/^[A-Z][A-Z0-9]*-\d+$/), name: z.string(),
      comment: z.string().max(4000), edits: z.array(editSchema), before: z.number().nullable(), after: z.number().nullable(),
    }),
    output: z.object({ status: z.string(), threadId: z.string().nullable(), round: z.number() }),
  },
  review_reset: { input: z.object({ release: relSchema }), output: z.object({ ok: z.boolean() }) },
};

const dmy = (iso: string) => (/^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}` : iso === "all" ? "все релизы" : "без релиза");
const tsd = (v: number | null | undefined) => (v == null ? "—" : `${Math.round(v / 1000).toLocaleString("ru-RU")} тыс.`);
const fmtV = (v: number, unit: string) => {
  if (unit === "доля") return `${+(v * 100).toFixed(2)}%`;
  return `${+v.toFixed(4)}${unit ? " " + unit : ""}`;
};
// ответ ИИ в чат короткий: панель — главный экран, тред — журнал
const BUSY = (s: string | null) => !!s && !["idle", "error", "gone", "failed", "stopped", "completed"].includes(s);

function estimatePrompt(s: AiSettings, P: DataPaths, mode: "new" | "all", release: string, unest: { key: string; summary: string; status: string }[], est: { key: string; name: string; status: string }[]) {
  const d = dmy(release);
  const cfg = path.join(P.releases, "features.json");
  const L: string[] = [];
  L.push(mode === "new"
    ? `Оцени выручку новых фич релиза ${d} (продукт: ${s.productName}) для панели bb «Выручка фич». Запуск — кнопка «Оценить новые».`
    : `Переоцени фичи релиза ${d} (продукт: ${s.productName}) для панели bb «Выручка фич». Запуск — кнопка «Переоценить все».`);
  if (unest.length) {
    L.push("", `Эпики релиза без оценки — оценить (${unest.length}):`);
    for (const u of unest) L.push(`- ${u.key} — ${u.summary} (${u.status})`);
  }
  if (est.length) {
    L.push("", `Уже оценённые фичи релиза — переоценить (${est.length}):`);
    for (const f of est) L.push(`- ${f.key} — ${f.name} (${f.status})`);
    L.push("Переоценка: сверь каждый вход с текущими требованиями, задачами и данными. Есть новые данные или решение изменилось — обнови входы, прошлую оценку запиши в `prev_estimate` {value, date}, причину — в `prev_reason`. Новых данных нет — фичу не трогай и в итоге напиши «без изменений».");
  }
  L.push(
    "",
    "Как:",
    `1. Правила и поля конфига — \`${P.method}\`. Пример всех полей — фичи в \`${cfg}\`.`,
    `2. Строки выручки (поле \`line\` компонента): ${s.revenueLines || "как в поле lines конфига"}. Валюта: ${s.currency}.`,
    "3. Источники по каждому эпику: эпик и его задачи, требования (PRD), ваши данные о выручке и воронке. Нет данных — так и пиши в `source` входа, уровень У4–У5. Цифры не выдумывай.",
    `4. Пиши только в \`${cfg}\`. У фичи: входы с вилкой, уровнем и источником; компоненты с \`line\`, \`money\`, \`mechanic\`; \`steps\` у каждого компонента (одна операция на шаг); \`main_assumption\`; \`measure\` (черновик, \`draft\`); \`effort\` (S/M/L/XL, \`by: "ИИ"\`). Типы C и D — 0, если цепочка до денег не подтверждена данными.`,
    `5. Проверка: \`${s.python} "${P.build}" "${cfg}" --release ${release} --out-dir "${path.join(P.dir, "out", "ai")}"\`. Сработавшие проверки по своим фичам исправь. Панель подхватит файл сама.`,
    "6. В трекер ничего не пиши: ICE записывается кнопкой на вкладке «В трекере».",
    "",
    `Итог в чат — таблица «фича | ожидаемый, тыс. ${s.currency}/мес | уверенность | главный вход | чего не хватило», без пересказа.`,
  );
  return L.join("\n");
}

function reviewIntro(s: AiSettings, P: DataPaths, release: string) {
  const cfg = path.join(P.releases, "features.json");
  return [
    `Ты дорабатываешь оценки фич по ревью в панели bb «Выручка фич» (продукт: ${s.productName}), релиз ${dmy(release)}. Задачи приходят сообщениями, по одной фиче.`,
    `Правила и поля — \`${P.method}\`, конфиг — \`${cfg}\`.`,
    "",
    "На каждую задачу:",
    "1. Правка входа — новое ожидаемое значение. Запиши его в ожидаемый сценарий входа (или `value` у входа без вилки); вилку neg/pos сдвинь так, чтобы ожидаемый остался внутри; в `source` допиши «ревью ДД.ММ». Уровень без данных не повышай.",
    "2. Комментарий выполни по методике. Противоречит методике или нет данных — не выдумывай, задай вопрос (шаг 4, статус question).",
    `3. Проверка: \`${s.python} "${P.build}" "${cfg}" --release ${release} --out-dir "${path.join(P.dir, "out", "ai")}"\`. Сработавшие проверки по этой фиче исправь.`,
    `4. Отметь итог (без этого панель считает, что ты ещё работаешь): \`${s.python} "${P.reviewMark}" --release ${release} --key КЛЮЧ --status done --note "что поменял; итог было → стало, тыс. ${s.currency}/мес"\`. Вопрос — \`--status question --note "вопрос"\`.`,
    "",
    "Ответ в чат — 1–2 строки на задачу. Трекер не трогай.",
  ].join("\n");
}

function reviewTask(release: string, key: string, name: string, round: number, comment: string, edits: Edit[], before: number | null, after: number | null) {
  const L = [`Ревью · релиз ${dmy(release)} · ${key} «${name}» · раунд ${round}`];
  L.push(`Итог фичи в месяц по конфигу: ${tsd(before)}${edits.length && after != null && after !== before ? `; с правками в панели: ${tsd(after)}` : ""}.`);
  if (edits.length) {
    L.push("Правки входов (ожидаемый сценарий):");
    for (const e of edits) L.push(`- \`${e.id}\` «${e.name}»: ${fmtV(e.from, e.unit)} → ${fmtV(e.to, e.unit)}`);
  }
  if (comment.trim()) L.push(`Комментарий: «${comment.trim()}»`);
  L.push(`Готово — \`review_mark.py --release ${release} --key ${key} --status done|question --note "…"\`.`);
  return L.join("\n");
}


export function aiHandlers(bb: BbPluginApi, deps: AiDeps) {
  const dirOf = () => deps.paths().reviewsDir;
  const runsFile = path.join(dirOf(), "ai_runs.json");
  const rvFile = (release: string) => path.join(dirOf(), `${release}.json`);
  const readJson = <T,>(p: string, def: T): T => { try { return JSON.parse(readFileSync(p, "utf8")) as T; } catch { return def; } };
  const writeJson = (p: string, v: unknown) => {
    mkdirSync(dirOf(), { recursive: true });
    const tmp = `${p}.tmp`;
    writeFileSync(tmp, JSON.stringify(v, null, 1), "utf8");
    try { renameSync(tmp, p); } catch { writeFileSync(p, JSON.stringify(v, null, 1), "utf8"); }
  };
  const readRv = (release: string, file: string): RvFile => readJson<RvFile>(rvFile(release), { release, file, started: new Date().toISOString(), threadId: null, items: {} });
  const sdk = () => (bb as any).sdk;
  const cfgS = () => deps.settings();
  const threadStatus = async (id: string | null | undefined): Promise<string | null> => {
    if (!id) return null;
    try {
      const t: any = await sdk().threads.get({ threadId: id });
      const th = t?.thread ?? t;
      if (!th || th.archivedAt || th.deletedAt) return "gone";
      return th.runtime?.displayStatus ?? th.status ?? null;
    } catch {
      return "gone";
    }
  };
  const spawn = async (title: string, prompt: string): Promise<string> => {
    const t = await sdk().threads.spawn({
      ...(cfgS().aiProjectId ? { projectId: cfgS().aiProjectId } : {}),
      environment: cfgS().aiEnvironmentId
        ? { type: "reuse", environmentId: cfgS().aiEnvironmentId }
        : { type: "host", workspace: { type: "unmanaged", path: deps.paths().dir } },
      providerId: "claude-code",
      title,
      prompt,
    });
    return t.id as string;
  };
  const cfgMtime = (file: string) => { try { return statSync(path.join(deps.paths().releases, file)).mtimeMs; } catch { return 0; } };
  const needPool = (file: string) => {
    const cfg = readJson<any>(path.join(deps.paths().releases, file), {});
    if (!cfg.tracker) throw new Error("ИИ работает только с конфигом всех фич (features.json): снимки не меняем");
  };

  return {
    ai_state: async ({ file, release }: { file: string; release: string }) => {
      const run = readJson<Record<string, Run>>(runsFile, {})[release] ?? null;
      const review = existsSync(rvFile(release)) ? readRv(release, file) : null;
      return {
        run,
        runStatus: await threadStatus(run?.threadId),
        review,
        reviewStatus: await threadStatus(review?.threadId),
        cfgMtime: cfgMtime(file),
      };
    },

    ai_estimate: async ({ file, release, mode }: { file: string; release: string; mode: "new" | "all" }) => {
      needPool(file);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(release)) throw new Error("Выберите конкретный релиз: «все» и «без релиза» ИИ не оценивает");
      const runs = readJson<Record<string, Run>>(runsFile, {});
      const cur = runs[release];
      if (cur && BUSY(await threadStatus(cur.threadId))) return { threadId: cur.threadId, reused: true, count: cur.keys.length };
      const pl = await deps.pool(file);
      const unest: { key: string; summary: string; status: string }[] = (pl?.releases ?? []).find((r: any) => r.release === release)?.unestimated ?? [];
      let est: { key: string; name: string; status: string }[] = [];
      if (mode === "all") {
        const d = await deps.data(file, release);
        est = (d?._explain ?? []).map((f: any) => ({ key: f.key, name: f.name, status: f.status }));
      }
      if (!unest.length && !est.length) throw new Error(mode === "new" ? "Все эпики релиза уже оценены" : "В релизе нет эпиков");
      const title = `Выручка фич: ${mode === "new" ? "оценка новых" : "переоценка"} · релиз ${dmy(release).slice(0, 5)}`;
      const threadId = await spawn(title, estimatePrompt(cfgS(), deps.paths(), mode, release, unest, est));
      const keys = [...unest.map((u) => u.key), ...est.map((f) => f.key)];
      runs[release] = { threadId, mode, startedAt: new Date().toISOString(), keys };
      writeJson(runsFile, runs);
      bb.log.info(`ai_estimate ${mode} ${release}: ${keys.length} фич, тред ${threadId}`);
      return { threadId, reused: false, count: keys.length };
    },

    review_submit: async (a: { file: string; release: string; key: string; name: string; comment: string; edits: Edit[]; before: number | null; after: number | null }) => {
      needPool(a.file);
      const rv = readRv(a.release, a.file);
      const prev = rv.items[a.key];
      const now = new Date().toISOString();
      const hist = prev ? [...(prev.history ?? []), (({ history, ...x }) => x)(prev)] : [];
      // без правок и комментария — принято
      if (!a.comment.trim() && !a.edits.length) {
        rv.items[a.key] = { status: "accepted", at: now, round: prev?.round ?? 0, before: a.before, history: hist.length ? hist : undefined };
        writeJson(rvFile(a.release), rv);
        return { status: "accepted", threadId: rv.threadId, round: prev?.round ?? 0 };
      }
      const round = (prev?.round ?? 0) + 1;
      const task = reviewTask(a.release, a.key, a.name, round, a.comment, a.edits, a.before, a.after);
      let threadId = rv.threadId;
      const st = await threadStatus(threadId);
      if (threadId && st && st !== "gone" && st !== "error" && st !== "failed") {
        await sdk().threads.send({ threadId, input: [{ type: "text", text: task, mentions: [] }] });
      } else {
        threadId = await spawn(`Выручка фич: ревью · релиз ${dmy(a.release).slice(0, 5)}`, `${reviewIntro(cfgS(), deps.paths(), a.release)}\n\n---\n\n${task}`);
      }
      rv.threadId = threadId;
      rv.items[a.key] = { status: "sent", at: now, round, comment: a.comment.trim() || undefined, edits: a.edits.length ? a.edits : undefined, before: a.before, after: a.after, history: hist.length ? hist : undefined };
      writeJson(rvFile(a.release), rv);
      bb.log.info(`review ${a.release} ${a.key}: раунд ${round}, тред ${threadId}`);
      return { status: "sent", threadId, round };
    },

    // начать ревью релиза заново: прошлый файл остаётся рядом с датой
    review_reset: async ({ release }: { release: string }) => {
      const p = rvFile(release);
      if (existsSync(p)) {
        const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
        try { renameSync(p, p.replace(/\.json$/, `.${stamp}.json`)); } catch { /* файл занят — оставляем */ }
      }
      return { ok: true };
    },
  };
}
