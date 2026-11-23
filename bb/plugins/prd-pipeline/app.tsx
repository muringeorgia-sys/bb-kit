// PRD pipeline — sidebar panel that shows and changes the /prd skill:
// chain per mode, agents, parameters, raw texts, AI drafts with journal and
// rollback, past runs. All writes go through core.mjs on the server; every
// save shows «было / стало» first.
// Colors come from bb theme tokens only: in a plugin build `dark:` follows the
// OS color scheme, not bb's light/dark mode, so the panel does not use it.
import { createContext, Fragment, useCallback, useContext, useEffect, useMemo, useState, type DragEvent, type ReactNode } from "react";
import { definePluginApp, useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import type { PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import type {
  AgentInfo,
  ApplyResult,
  Call,
  DiffLine,
  Draft,
  DraftPreview,
  FileDiff,
  Flow,
  Loaded,
  Param,
  ParamOption,
  Preview,
  Role,
  Run,
  Settings,
  Step,
  StepKind,
  Via,
} from "./types";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { cn, formatHomePathForDisplay } from "@/lib/utils";

// ---------- helpers ----------
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : "");
const ruDate = (iso?: string | null) => (iso && /^\d{4}-\d{2}-\d{2}/.test(iso) ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}` : "—");
const ruDateTime = (iso?: string | null) => {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(+d) ? iso : d.toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
};
const plural = (n: number, one: string, few: string, many: string) => {
  const d = n % 10;
  const h = n % 100;
  return d === 1 && h !== 11 ? one : d >= 2 && d <= 4 && (h < 12 || h > 14) ? few : many;
};
const fillPlain = (text: string | undefined, params: Record<string, Param>) =>
  String(text ?? "").replace(/\{\{([\w.]+)(:code)?\}\}/g, (m, k: string) => (params[k] ? String(params[k].value) : m));
const optValue = (o: string | ParamOption) => (typeof o === "string" ? o : o.value);
const optLabel = (o: string | ParamOption) => (typeof o === "string" ? o : o.label);
const uid = () => Math.random().toString(36).slice(2, 8);
const flowTags = (f: Flow) => {
  let n = f.numberFrom ?? 0;
  return f.steps.map((st) => (st.kind === "stop" ? "стоп" : st.kind === "final" ? "итог" : String(n++)));
};
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const fieldCls = "h-8 rounded-md border border-input bg-transparent px-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";
const areaCls = "w-full rounded-md border border-input bg-transparent px-2.5 py-2 text-[13px] leading-relaxed focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

type Rpc = ReturnType<typeof useRpc<typeof rpcContract>>;
type Nav = ReturnType<typeof useBbNavigate>;
type Ctx = {
  data: Loaded;
  settings: Settings;
  params: Record<string, Param>;
  roles: Record<string, Role>;
  agents: Record<string, AgentInfo>;
  rpc: Rpc;
  nav: Nav;
  reload: () => Promise<void>;
  open: (p: string) => void;
  notify: (s: string) => void;
};
const PanelCtx = createContext<Ctx | null>(null);
const usePanel = () => {
  const c = useContext(PanelCtx);
  if (!c) throw new Error("no panel context");
  return c;
};

// ---------- actors ----------
const DOT: Record<string, string> = {
  orchestrator: "bg-subtle-foreground",
  user: "bg-attention",
  "prd-site-researcher": "bg-orange-500",
  "prd-product-analyst": "bg-sky-500",
  "prd-core-pm": "bg-violet-500",
  "prd-core-pm-lite": "bg-violet-500",
  "prd-product-designer": "bg-fuchsia-500",
  "prd-ux-writer": "bg-teal-500",
  reviewer: "bg-rose-500",
  "prd-cleanup": "bg-lime-500",
  "prd-publisher": "bg-emerald-500",
  script: "ring-1 ring-inset ring-subtle-foreground",
};
const VIA_LABEL: Record<Via, { label: string; tip: string }> = {
  Agent: { label: "запуск", tip: "Оркестратор запускает нового агента через Agent" },
  SendMessage: { label: "SendMessage", tip: "Следующий проход того же агента: контекст не перечитывается" },
  AskUserQuestion: { label: "форма вопросов", tip: "Вопросы приходят тебе формой, до 4 за раз, рекомендованный вариант первым" },
  Codex: { label: "Codex", tip: "codex-companion task" },
  bash: { label: "скрипт", tip: "Команда без модели" },
};
const VIAS = Object.keys(VIA_LABEL) as Via[];
const MODELS = [
  { value: "opus", label: "Opus" },
  { value: "sonnet", label: "Sonnet" },
  { value: "haiku", label: "Haiku" },
  { value: "", label: "модель треда" },
];
const EFFORTS = ["low", "medium", "high", "xhigh", "max", ""];

function Actor({ id, className }: { id: string; className?: string }) {
  const { roles } = usePanel();
  return (
    <span className={cn("inline-flex items-center gap-1.5 whitespace-nowrap", className)}>
      <span aria-hidden className={cn("size-2 shrink-0 rounded-full", DOT[id] ?? "bg-subtle-foreground")} />
      {roles[id]?.role ?? id}
    </span>
  );
}

function runtimeOf(id: string, ctx: Ctx): { text: string; warn: string | null } {
  const a = ctx.agents[id];
  if (a) {
    const text = [a.model ? (ctx.settings.modelNames[a.model] ?? cap(a.model)) : "модель треда", a.effort].filter(Boolean).join(" · ");
    return { text, warn: a.state === "disabled" ? "агент выключен" : null };
  }
  if (id.startsWith("prd-")) return { text: "", warn: "нет файла агента" };
  const p = ctx.params;
  const short: Record<string, string> = {
    orchestrator: "основной тред · модель треда",
    reviewer: `Codex · ${p["reviewer.model"]?.value ?? ""} · ${p["reviewer.effort"]?.value ?? ""}`,
    script: "без модели",
  };
  return { text: short[id] ?? "", warn: null };
}

// ---------- small UI ----------
const looksLikeFile = (s: string) => !/\s/.test(s) && /[./]/.test(s);
function Line({ label, items, strong }: { label: string; items?: string[]; strong?: boolean }) {
  const { params } = usePanel();
  if (!items?.length) return null;
  return (
    <p className="mt-1 text-[12.5px] leading-relaxed">
      <span className="mr-1.5 text-subtle-foreground">{label}</span>
      {items.map((raw, i) => {
        const s = fillPlain(raw, params);
        return (
          <Fragment key={raw + i}>
            {i > 0 && <span className="text-subtle-foreground"> · </span>}
            <span className={cn(looksLikeFile(s) && "font-mono text-xs", strong ? "text-foreground" : "text-muted-foreground")}>{s}</span>
          </Fragment>
        );
      })}
    </p>
  );
}

function Banner({ children, tone = "warn" }: { children: ReactNode; tone?: "warn" | "info" }) {
  return (
    <div className={cn("mb-3 flex gap-2 rounded-lg px-3 py-2 text-sm", tone === "warn" ? "bg-surface-attention" : "bg-surface-recessed")}>
      <Icon name={tone === "warn" ? "AlertTriangle" : "Info"} className={cn("mt-0.5 size-4 shrink-0", tone === "warn" ? "text-warning-text" : "text-muted-foreground")} />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

function Segmented<T extends string>({ items, value, onChange, disabled }: { items: { id: T; label: ReactNode }[]; value: T; onChange: (id: T) => void; disabled?: boolean }) {
  return (
    <div role="tablist" className="inline-flex flex-wrap gap-0.5 rounded-lg bg-surface-recessed p-0.5">
      {items.map((it) => (
        <button
          key={it.id}
          type="button"
          role="tab"
          disabled={disabled && value !== it.id}
          aria-selected={value === it.id}
          onClick={() => onChange(it.id)}
          className={cn(
            "rounded-md px-3 py-1 text-sm transition-colors disabled:opacity-50",
            value === it.id ? "bg-background font-medium text-foreground shadow-xs ring-1 ring-border" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}

function useStoredFlag(key: string): [boolean, (v: boolean) => void] {
  const [value, setValue] = useState(() => {
    try {
      return localStorage.getItem(key) === "1";
    } catch {
      return false;
    }
  });
  const set = (v: boolean) => {
    setValue(v);
    try {
      localStorage.setItem(key, v ? "1" : "0");
    } catch {
      // the flag just won't survive a reload
    }
  };
  return [value, set];
}

function StepBadge({ tag, kind }: { tag: string; kind?: StepKind }) {
  return (
    <span
      className={cn(
        "relative inline-flex h-6 min-w-6 shrink-0 items-center justify-center rounded-full px-1.5 text-xs font-semibold tabular-nums",
        kind === "stop" && "bg-attention text-attention-foreground",
        kind === "final" && "bg-foreground text-background",
        kind === "check" && "bg-background text-success ring-1 ring-success",
        !kind && "bg-background text-foreground ring-1 ring-border",
      )}
    >
      {tag}
    </span>
  );
}

// ---------- diff and save ----------
// A run of removed lines followed by a run of added lines: pair them one to one,
// so the changed words inside a long line can be marked.
function pairLines(lines: DiffLine[]) {
  const m = new Map<number, number>();
  let i = 0;
  while (i < lines.length) {
    if (lines[i].t !== "-") {
      i++;
      continue;
    }
    const a = i;
    while (i < lines.length && lines[i].t === "-") i++;
    const b = i;
    while (i < lines.length && lines[i].t === "+") i++;
    for (let k = 0; k < Math.min(b - a, i - b); k++) {
      m.set(a + k, b + k);
      m.set(b + k, a + k);
    }
  }
  return m;
}
function changedPart(x: string, y: string): [string, string, string] {
  let p = 0;
  while (p < x.length && p < y.length && x[p] === y[p]) p++;
  let s = 0;
  while (s < x.length - p && s < y.length - p && x[x.length - 1 - s] === y[y.length - 1 - s]) s++;
  while (p > 0 && !/\s/.test(x[p - 1])) p--;
  while (s > 0 && !/\s/.test(x[x.length - s])) s--;
  return [x.slice(0, p), x.slice(p, x.length - s), x.slice(x.length - s)];
}
function DiffText({ l, other }: { l: DiffLine; other?: DiffLine }) {
  if (!other || l.t === " ") return <>{l.text || " "}</>;
  const [pre, mid, post] = changedPart(l.text, other.text);
  if (pre.length + post.length < 12) return <>{l.text || " "}</>;
  return (
    <>
      {pre}
      <mark className={cn("rounded-sm px-0.5 font-semibold text-foreground", l.t === "+" ? "bg-success/40" : "bg-destructive/40")}>{mid}</mark>
      {post}
    </>
  );
}

function FileDiffView({ f }: { f: FileDiff }) {
  const service = f.rel === "settings.json";
  return (
    <details open={!service} className="group rounded-lg border border-border">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-sm">
        <Icon name="ChevronRight" className="size-3.5 shrink-0 text-subtle-foreground transition-transform group-open:rotate-90" />
        <span className="font-mono text-xs">{f.rel}</span>
        {service && <span className="text-xs text-subtle-foreground">служебный файл настроек</span>}
        {f.isNew && <span className="text-xs text-subtle-foreground">новый файл</span>}
        <span className="ml-auto text-xs tabular-nums text-muted-foreground">{f.onlyMarkers ? "только служебные метки" : `+${f.added} −${f.removed}`}</span>
      </summary>
      <div className="border-t border-border-hairline">
        {f.hunks.map((h, i) => {
          const pairs = pairLines(h.lines);
          return (
            <div key={i} className="border-b border-border-hairline py-1 font-mono text-[12px] leading-relaxed last:border-0">
              {h.lines.map((l, j) => (
                <div
                  key={j}
                  className={cn("flex gap-2 px-3", l.t === "+" && "bg-success/15", l.t === "-" && "bg-destructive/15 text-muted-foreground", l.t === " " && "text-subtle-foreground")}
                >
                  <span className="w-3 shrink-0 select-none">{l.t === " " ? "" : l.t === "+" ? "+" : "−"}</span>
                  <span className="min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere]">
                    <DiffText l={l} other={pairs.has(j) ? h.lines[pairs.get(j)!] : undefined} />
                  </span>
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </details>
  );
}

function DiffView({ preview }: { preview: Preview }) {
  if (!preview.files.length && !preview.moves.length) return <p className="text-sm text-muted-foreground">Изменений нет: всё уже так.</p>;
  return (
    <div className="space-y-2">
      {preview.warnings?.map((w) => (
        <Banner key={w}>{w}</Banner>
      ))}
      {preview.moves.map((m) => (
        <p key={m.name} className="text-sm">
          Агент <span className="font-mono text-xs">{m.name}</span>: {m.disabled ? "выключится" : "включится"}
        </p>
      ))}
      <p className="text-xs text-subtle-foreground">
        {preview.files.length} {plural(preview.files.length, "файл", "файла", "файлов")} · служебные метки скрыты · <span className="bg-destructive/15 px-1">было</span>{" "}
        <span className="bg-success/15 px-1">стало</span>
      </p>
      {preview.files.map((f) => (
        <FileDiffView key={f.rel} f={f} />
      ))}
    </div>
  );
}

function useSaver() {
  const { rpc, reload, notify } = usePanel();
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const show = async (change: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    try {
      setPreview((await rpc.call("preview", { change: change as { kind: string } })) as Preview);
    } catch (e) {
      setPreview(null);
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };
  const save = async (change: Record<string, unknown>, title: string) => {
    setBusy(true);
    setError(null);
    try {
      const r = (await rpc.call("apply", { change: change as { kind: string }, title })) as ApplyResult;
      if (!r.ok) {
        setError(r.message ?? "Не сохранено");
        return false;
      }
      setPreview(null);
      notify(`Сохранено: ${title}${r.warnings?.length ? `. ${r.warnings.join(" ")}` : ""}`);
      await reload();
      return true;
    } catch (e) {
      setError(errText(e));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const reset = () => {
    setPreview(null);
    setError(null);
  };
  return { preview, busy, error, show, save, reset };
}

function SaveBar({
  count,
  text,
  saver,
  change,
  title,
  onCancel,
  onSaved,
}: {
  count: number;
  text: string;
  saver: ReturnType<typeof useSaver>;
  change: Record<string, unknown>;
  title: string;
  onCancel: () => void;
  onSaved: () => void;
}) {
  if (!count) return null;
  return (
    <>
      {(saver.preview || saver.error) && (
        <section className="mt-5 rounded-lg bg-surface-recessed p-3">
          <h4 className="mb-2 text-sm font-semibold">Было / стало</h4>
          {saver.error && <p className="mb-2 text-sm text-destructive-text">{saver.error}</p>}
          {saver.preview && <DiffView preview={saver.preview} />}
        </section>
      )}
      <div className="sticky bottom-0 z-10 -mx-5 mt-4 flex flex-wrap items-center gap-2 border-t border-border bg-background px-5 py-2.5">
        <span className="mr-auto text-sm">{text}</span>
        <Button variant="outline" size="sm" disabled={saver.busy} onClick={() => void saver.show(change)}>
          <Icon name="Eye" /> {saver.preview ? "Обновить «было / стало»" : "Показать «было / стало»"}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={saver.busy}
          onClick={() => {
            saver.reset();
            onCancel();
          }}
        >
          Отменить
        </Button>
        <Button size="sm" disabled={saver.busy} onClick={() => void saver.save(change, title).then((ok) => ok && onSaved())}>
          <Icon name="Check" /> Сохранить
        </Button>
      </div>
    </>
  );
}

// ---------- chain: view ----------
function CallRow({ call, detailed, dim }: { call: Call; detailed: boolean; dim?: boolean }) {
  const ctx = usePanel();
  const rt = runtimeOf(call.actor, ctx);
  const meta = detailed ? [rt.text, call.actor.startsWith("prd-") ? call.actor : ""].filter(Boolean).join(" · ") : "";
  return (
    <div className={cn("min-w-0 rounded-lg px-3 py-2", call.actor === "user" ? "bg-surface-attention" : "bg-surface-recessed", dim && "opacity-50")}>
      <div className="flex items-baseline gap-x-2">
        <Actor id={call.actor} className="text-sm font-medium" />
        {(call.count ?? 1) > 1 && <span className="text-sm tabular-nums">×{call.count}</span>}
        {call.label && <span className="min-w-0 text-sm text-muted-foreground">{fillPlain(call.label, ctx.params)}</span>}
        {call.via && (
          <span title={VIA_LABEL[call.via]?.tip} className="ml-auto shrink-0 pl-2 text-xs text-subtle-foreground">
            {VIA_LABEL[call.via]?.label ?? call.via}
          </span>
        )}
      </div>
      {(meta || rt.warn) && (
        <p className="mt-0.5 text-xs text-subtle-foreground">
          {meta}
          {rt.warn && <span className="ml-2 font-medium text-destructive-text">{rt.warn}</span>}
        </p>
      )}
      {detailed && <Line label="Берёт" items={call.in} />}
      <Line label="Отдаёт" items={call.out} strong />
      {detailed && call.text && <p className="mt-1 text-xs text-subtle-foreground">В SKILL.md: {fillPlain(call.text, ctx.params)}</p>}
    </div>
  );
}

function Timeline({ flow, detailed }: { flow: Flow; detailed: boolean }) {
  const { params } = usePanel();
  const tags = flowTags(flow);
  const conceptOff = params["concept.default"]?.value === "off";
  return (
    <ol className="mt-6">
      {flow.steps.map((s, i) => {
        const dim = conceptOff && s.concept;
        return (
          <li key={s.id} className="relative grid grid-cols-[40px_minmax(0,1fr)] gap-x-3 pb-7 last:pb-0">
            {i < flow.steps.length - 1 && <span aria-hidden className="absolute bottom-0 left-[19.5px] top-7 w-px bg-border" />}
            <div className="flex justify-center">
              <StepBadge tag={tags[i]} kind={s.kind} />
            </div>
            <div className="@container min-w-0">
              <h4 className={cn("text-[15px] font-semibold leading-6 tracking-tight", dim && "text-muted-foreground")}>
                {s.title}
                {dim && <span className="ml-2 text-xs font-normal">пропускается: концепция только по команде</span>}
              </h4>
              <div className="mt-2 space-y-2">
                {s.groups.map((g, gi) => (
                  <div key={gi}>
                    {g.length > 1 && <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-subtle-foreground">Параллельно · {g.length}</p>}
                    <div className={cn("grid gap-1.5", g.length > 1 && "@xl:grid-cols-2 @4xl:grid-cols-3")}>
                      {g.map((c, ci) => (
                        <CallRow key={ci} call={c} detailed={detailed} dim={dim} />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
              {s.note && <p className="mt-2 text-[13px] leading-snug text-muted-foreground">{fillPlain(s.note, params)}</p>}
              {detailed && s.text && <p className="mt-1.5 text-xs text-subtle-foreground">В SKILL.md: {fillPlain(s.text, params)}</p>}
              {detailed && s.handoff && (
                <p className="mt-1.5 text-xs text-subtle-foreground">
                  Дальше: <span className="text-muted-foreground">{s.handoff}</span>
                </p>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function Rules() {
  const { settings, params } = usePanel();
  return (
    <details className="group mt-3">
      <summary className="inline-flex cursor-pointer list-none items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <Icon name="ChevronRight" className="size-3.5 transition-transform group-open:rotate-90" />
        Как агенты общаются
      </summary>
      <dl className="mt-2 grid gap-x-6 gap-y-2 rounded-lg bg-surface-recessed p-3 text-[13px] @3xl:grid-cols-2">
        {settings.rules.map((r) => (
          <div key={r.title}>
            <dt className="font-medium">{r.title}</dt>
            <dd className="text-muted-foreground">{fillPlain(r.text, params)}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

// ---------- chain: edit ----------
type Pos = { si: number; gi: number; ci: number };
const parseList = (s: string) =>
  s
    .split(/[,;\n]/)
    .map((x) => x.trim())
    .filter(Boolean);

function defaultCall(actor: string): Call {
  const via: Via | undefined = actor === "user" ? "AskUserQuestion" : actor === "reviewer" ? "Codex" : actor === "script" ? "bash" : actor === "orchestrator" ? undefined : "Agent";
  const text = actor.startsWith("prd-") ? "`" + actor + "`" : actor === "reviewer" ? "ревью по `review.md`: Codex {{reviewer.model:code}} · {{reviewer.effort:code}}" : "";
  return { actor, via, label: "", in: [], out: [], text };
}

function AddActor({ label, onPick }: { label: string; onPick: (actor: string) => void }) {
  const { settings } = usePanel();
  return (
    <select
      aria-label={label}
      value=""
      onChange={(e) => e.target.value && onPick(e.target.value)}
      className="h-7 rounded-md border border-dashed border-border bg-transparent px-1.5 text-xs text-muted-foreground hover:text-foreground"
    >
      <option value="">{label}</option>
      {settings.roles.map((r) => (
        <option key={r.id} value={r.id}>
          {r.role}
        </option>
      ))}
    </select>
  );
}

function Labeled({ label, children, wide }: { label: string; children: ReactNode; wide?: boolean }) {
  return (
    <label className={cn("flex flex-col gap-1 text-xs text-subtle-foreground", wide && "col-span-full")}>
      {label}
      {children}
    </label>
  );
}

function CallEditor({ call, flow, si, onChange, onMove, onRemove, gen }: { call: Call; flow: Flow; si: number; onChange: (p: Partial<Call>) => void; onMove: (toSi: number) => void; onRemove: () => void; gen: boolean }) {
  const { settings } = usePanel();
  const tags = flowTags(flow);
  return (
    <div className="mt-2 grid grid-cols-1 gap-2.5 rounded-lg bg-surface-recessed p-3 @2xl:grid-cols-3">
      <Labeled label="Участник">
        <select className={fieldCls} value={call.actor} onChange={(e) => onChange({ actor: e.target.value })}>
          {settings.roles.map((r) => (
            <option key={r.id} value={r.id}>
              {r.role}
            </option>
          ))}
        </select>
      </Labeled>
      <Labeled label="Как вызывается">
        <select className={fieldCls} value={call.via ?? ""} onChange={(e) => onChange({ via: (e.target.value || undefined) as Via | undefined })}>
          <option value="">—</option>
          {VIAS.map((v) => (
            <option key={v} value={v}>
              {VIA_LABEL[v].label}
            </option>
          ))}
        </select>
      </Labeled>
      <Labeled label="Экземпляров">
        <Input type="number" min={1} className="h-8 w-24" value={call.count ?? 1} onChange={(e) => onChange({ count: Math.max(1, Number(e.target.value) || 1) })} />
      </Labeled>
      <Labeled label="Пометка на схеме" wide>
        <Input className="h-8" value={call.label ?? ""} onChange={(e) => onChange({ label: e.target.value })} />
      </Labeled>
      <Labeled label="Берёт (через запятую)">
        <Input className="h-8" value={(call.in ?? []).join(", ")} onChange={(e) => onChange({ in: parseList(e.target.value) })} />
      </Labeled>
      <Labeled label="Отдаёт (через запятую)">
        <Input className="h-8" value={(call.out ?? []).join(", ")} onChange={(e) => onChange({ out: parseList(e.target.value) })} />
      </Labeled>
      <Labeled label="Перенести в шаг">
        <select className={fieldCls} value={si} onChange={(e) => onMove(Number(e.target.value))}>
          {flow.steps.map((s, i) => (
            <option key={s.id} value={i}>
              {tags[i]} · {s.title}
            </option>
          ))}
        </select>
      </Labeled>
      <Labeled label={gen ? "Текст задания в SKILL.md (без точки в конце; {{reviewer.model:code}} подставит модель ревьюера)" : "Текст задания — у этого шага только схема"} wide>
        <textarea className={cn(areaCls, "min-h-16 font-mono text-[12.5px]")} disabled={!gen} value={call.text ?? ""} onChange={(e) => onChange({ text: e.target.value })} />
      </Labeled>
      <div className="col-span-full flex justify-end">
        <Button variant="ghost" size="sm" onClick={onRemove}>
          Убрать из шага
        </Button>
      </div>
    </div>
  );
}

function FlowEditor({ flow, onChange }: { flow: Flow; onChange: (f: Flow) => void }) {
  const ctx = usePanel();
  const [drag, setDrag] = useState<Pos | null>(null);
  const [sel, setSel] = useState<Pos | null>(null);
  const [openStep, setOpenStep] = useState<string | null>(null);
  const tags = flowTags(flow);
  const mut = (fn: (f: Flow) => void) => {
    const f = structuredClone(flow);
    fn(f);
    for (const st of f.steps) st.groups = st.groups.filter((g) => g.length);
    onChange(f);
  };
  const move = (from: Pos, toSi: number, toGi: number | "new") => {
    mut((f) => {
      const call = f.steps[from.si].groups[from.gi].splice(from.ci, 1)[0];
      const st = f.steps[toSi];
      if (toGi === "new" || !st.groups[toGi]) st.groups.push([call]);
      else st.groups[toGi].push(call);
    });
    setSel(null);
  };
  const drop = (si: number, gi: number | "new") => ({
    onDragOver: (e: DragEvent) => {
      if (drag) e.preventDefault();
    },
    onDrop: (e: DragEvent) => {
      e.preventDefault();
      if (drag) move(drag, si, gi);
      setDrag(null);
    },
  });
  const updStep = (si: number, p: Partial<Step>) => mut((f) => Object.assign(f.steps[si], p));
  const updCall = (p: Pos, patch: Partial<Call>) => mut((f) => Object.assign(f.steps[p.si].groups[p.gi][p.ci], patch));
  const addStep = (after: number, kind: StepKind) =>
    mut((f) => {
      f.steps.splice(after + 1, 0, { id: uid(), title: kind === "stop" ? "Стоп-точка" : "Новый шаг", kind, gen: f.gen ? true : false, groups: [], text: "" });
    });
  const moveStep = (si: number, d: number) =>
    mut((f) => {
      const j = si + d;
      if (j < 0 || j >= f.steps.length) return;
      [f.steps[si], f.steps[j]] = [f.steps[j], f.steps[si]];
    });
  const gens = !!flow.gen;
  return (
    <div className="mt-4">
      {!gens && (
        <Banner tone="info">
          Цепочка «{flow.label}» описана в SKILL.md текстом («Команды после PRD») и в publish.md. Здесь меняется только схема в панели; текст — во вкладке «Тексты» или словами во вкладке «Правки».
        </Banner>
      )}
      <p className="mb-3 text-[13px] text-muted-foreground">
        Перетаскивай агентов между шагами. Внутри рамки — параллельно, рамки идут по очереди. Клик по агенту — пометка, входы и текст задания. Номера волн пересчитаются сами.
      </p>
      <ol className="space-y-3">
        {flow.steps.map((st, si) => {
          const selHere = sel && sel.si === si ? sel : null;
          const selCall = selHere ? st.groups[selHere.gi]?.[selHere.ci] : null;
          return (
            <li key={st.id} className="@container rounded-lg border border-border p-3">
              <div className="flex flex-wrap items-center gap-2">
                <StepBadge tag={tags[si]} kind={st.kind} />
                <Input aria-label="Название шага" className="h-8 max-w-sm flex-1 text-sm font-semibold" value={st.title} onChange={(e) => updStep(si, { title: e.target.value })} />
                <select aria-label="Тип шага" className={fieldCls} value={st.kind ?? ""} onChange={(e) => updStep(si, { kind: (e.target.value || null) as StepKind })}>
                  <option value="">шаг</option>
                  <option value="stop">стоп-точка</option>
                  <option value="check">проверка</option>
                  <option value="final">итог</option>
                </select>
                {gens && !st.gen && <span className="text-xs text-subtle-foreground">только схема: текст — отдельный раздел SKILL.md</span>}
                <div className="ml-auto flex items-center gap-0.5">
                  <Button variant="ghost" size="sm" onClick={() => setOpenStep(openStep === st.id ? null : st.id)} aria-expanded={openStep === st.id}>
                    Текст шага
                  </Button>
                  <Button variant="ghost" size="sm" disabled={si === 0} onClick={() => moveStep(si, -1)} aria-label="Шаг выше">
                    ↑
                  </Button>
                  <Button variant="ghost" size="sm" disabled={si === flow.steps.length - 1} onClick={() => moveStep(si, 1)} aria-label="Шаг ниже">
                    ↓
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => mut((f) => void f.steps.splice(si, 1))} aria-label="Удалить шаг">
                    ✕
                  </Button>
                </div>
              </div>
              <div className="mt-2 space-y-1">
                {st.groups.map((g, gi) => (
                  <Fragment key={gi}>
                    {gi > 0 && <p className="pl-1 text-[11px] uppercase tracking-wide text-subtle-foreground">затем</p>}
                    <div {...drop(si, gi)} className={cn("flex min-h-10 flex-wrap items-center gap-1.5 rounded-md border border-dashed border-border p-1.5", drag && "bg-state-hover")}>
                      {g.length > 1 && <span className="px-1 text-[11px] text-subtle-foreground">параллельно</span>}
                      {g.map((c, ci) => {
                        const isSel = !!selHere && selHere.gi === gi && selHere.ci === ci;
                        return (
                          <button
                            key={ci}
                            type="button"
                            draggable
                            onDragStart={(e) => {
                              setDrag({ si, gi, ci });
                              e.dataTransfer.effectAllowed = "move";
                              e.dataTransfer.setData("text/plain", c.actor);
                            }}
                            onDragEnd={() => setDrag(null)}
                            onClick={() => setSel(isSel ? null : { si, gi, ci })}
                            className={cn(
                              "inline-flex max-w-full items-center gap-1.5 rounded-md bg-surface-recessed px-2 py-1 text-[13px] hover:bg-state-hover",
                              isSel && "ring-2 ring-foreground",
                              c.actor === "user" && "bg-surface-attention",
                            )}
                          >
                            <span aria-hidden className="cursor-grab text-subtle-foreground">
                              ⋮⋮
                            </span>
                            <Actor id={c.actor} />
                            {(c.count ?? 1) > 1 && <span className="tabular-nums">×{c.count}</span>}
                            {c.label && <span className="max-w-[18rem] truncate text-muted-foreground">{fillPlain(c.label, ctx.params)}</span>}
                          </button>
                        );
                      })}
                      <AddActor label="+ параллельно" onPick={(a) => mut((f) => void f.steps[si].groups[gi].push(defaultCall(a)))} />
                    </div>
                  </Fragment>
                ))}
                <div {...drop(si, "new")} className="flex flex-wrap items-center gap-2 rounded-md border border-dashed border-border-hairline px-2 py-1 text-xs text-subtle-foreground">
                  {st.groups.length ? "Сюда — отдельно, после" : "Сюда — первый участник шага"}
                  <AddActor label={st.groups.length ? "+ затем" : "+ участник"} onPick={(a) => mut((f) => void f.steps[si].groups.push([defaultCall(a)]))} />
                </div>
              </div>
              {selHere && selCall && (
                <CallEditor
                  call={selCall}
                  flow={flow}
                  si={si}
                  gen={gens && !!st.gen}
                  onChange={(p) => updCall(selHere, p)}
                  onMove={(toSi) => move(selHere, toSi, "new")}
                  onRemove={() => {
                    mut((f) => void f.steps[selHere.si].groups[selHere.gi].splice(selHere.ci, 1));
                    setSel(null);
                  }}
                />
              )}
              {openStep === st.id && (
                <div className="mt-2 grid grid-cols-1 gap-2.5 rounded-lg bg-surface-recessed p-3">
                  <Labeled label={gens && st.gen ? "Текст шага в SKILL.md — после текстов агентов (например, «Проверь отчёты…»)" : "Текст шага — у этого шага только схема"}>
                    <textarea className={cn(areaCls, "min-h-20 font-mono text-[12.5px]")} disabled={!(gens && st.gen)} value={st.text ?? ""} onChange={(e) => updStep(si, { text: e.target.value })} />
                  </Labeled>
                  {flow.gen === "list" && st.gen && (
                    <label className="flex items-center gap-2 text-sm">
                      <input type="checkbox" className="size-4" checked={!!st.joinPrev} onChange={(e) => updStep(si, { joinPrev: e.target.checked })} />
                      В SKILL.md продолжает предыдущий пункт, а не новый номер
                    </label>
                  )}
                  {gens && (
                    <label className="flex items-center gap-2 text-sm">
                      <input type="checkbox" className="size-4" checked={!!st.gen} onChange={(e) => updStep(si, { gen: e.target.checked })} />
                      Шаг попадает в SKILL.md
                    </label>
                  )}
                  <Labeled label="Пояснение на схеме">
                    <textarea className={cn(areaCls, "min-h-12")} value={st.note ?? ""} onChange={(e) => updStep(si, { note: e.target.value })} />
                  </Labeled>
                  <Labeled label="Что передаётся дальше">
                    <Input className="h-8" value={st.handoff ?? ""} onChange={(e) => updStep(si, { handoff: e.target.value })} />
                  </Labeled>
                </div>
              )}
              {st.groups.length === 0 && !st.text && <p className="mt-2 text-xs text-warning-text">Пустой шаг: добавь участника или удали шаг.</p>}
              {gens && st.gen && st.groups.length > 0 && !st.text && !st.groups.flat().some((c) => c.text) && (
                <p className="mt-2 text-xs text-warning-text">Нет текста задания: в SKILL.md шаг будет пустым. Добавь текст агенту (клик по нему) или шагу («Текст шага»).</p>
              )}
            </li>
          );
        })}
      </ol>
      <div className="mt-3 flex gap-2">
        <Button variant="outline" size="sm" onClick={() => addStep(flow.steps.length - 2, null)}>
          <Icon name="Plus" /> Шаг перед итогом
        </Button>
        <Button variant="outline" size="sm" onClick={() => addStep(flow.steps.length - 2, "stop")}>
          <Icon name="Plus" /> Стоп-точка
        </Button>
      </div>
    </div>
  );
}

function ChainTab() {
  const ctx = usePanel();
  const { settings, params, data } = ctx;
  const flows = Object.values(settings.flows);
  const [flowId, setFlowId] = useState("full");
  const [edit, setEdit] = useState<Flow | null>(null);
  const [detailed, setDetailed] = useStoredFlag("prd-pipeline:detailed");
  const saver = useSaver();
  const flow = settings.flows[flowId] ?? flows[0];
  const dirty = !!edit && !same(edit, flow);
  const actors = useMemo(() => [...new Set(flow.steps.flatMap((s) => s.groups.flat().map((c) => c.actor)))], [flow]);
  const defMode = params["mode.default"]?.value;
  const startEdit = () => setEdit(structuredClone(flow));
  return (
    <div>
      <div className="flex flex-wrap items-center gap-3">
        <Segmented
          items={flows.map((f) => ({ id: f.id, label: f.id === defMode ? `${f.label} · по умолчанию` : f.label }))}
          value={flow.id}
          disabled={dirty}
          onChange={(id) => {
            setFlowId(id);
            setEdit(null);
            saver.reset();
          }}
        />
        <div className="ml-auto flex items-center gap-1">
          {!edit && (
            <Button variant="outline" size="sm" className="aria-pressed:bg-state-active" aria-pressed={detailed} onClick={() => setDetailed(!detailed)}>
              {detailed && <Icon name="Check" />}
              Подробно
            </Button>
          )}
          <Button
            variant={edit ? "ghost" : "outline"}
            size="sm"
            onClick={() => {
              if (edit) {
                setEdit(null);
                saver.reset();
              } else startEdit();
            }}
          >
            {edit ? "Закрыть правку" : "Править цепочку"}
          </Button>
        </div>
      </div>
      {!edit && (
        <>
          <dl className="mt-4 grid grid-cols-[88px_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-sm">
            <dt className="text-subtle-foreground">Запуск</dt>
            <dd>{fillPlain(flow.trigger, params)}</dd>
            <dt className="text-subtle-foreground">Итог</dt>
            <dd>{fillPlain(flow.result, params)}</dd>
            <dt className="text-subtle-foreground">Участники</dt>
            <dd className="flex flex-wrap gap-x-3 gap-y-1">
              {actors.map((a) => (
                <Actor key={a} id={a} />
              ))}
            </dd>
          </dl>
          <Rules />
          <Timeline flow={flow} detailed={detailed} />
          {data.flowsRendered[flow.id] && (
            <details className="group mt-6">
              <summary className="inline-flex cursor-pointer list-none items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
                <Icon name="ChevronRight" className="size-3.5 transition-transform group-open:rotate-90" />
                Как это записано в SKILL.md
              </summary>
              <pre className="mt-2 whitespace-pre-wrap rounded-lg bg-surface-recessed p-3 font-mono text-[12px] leading-relaxed text-muted-foreground">{data.flowsRendered[flow.id]}</pre>
            </details>
          )}
        </>
      )}
      {edit && (
        <>
          <FlowEditor
            flow={edit}
            onChange={(f) => {
              setEdit(f);
              saver.reset();
            }}
          />
          <SaveBar
            count={dirty ? 1 : 0}
            text={`Цепочка «${flow.label}» изменена${flow.gen ? " · перепишется SKILL.md" : " · только схема"}`}
            saver={saver}
            change={{ kind: "flow", flowId: flow.id, flow: edit }}
            title={`Цепочка ${flow.label}`}
            onCancel={() => setEdit(structuredClone(flow))}
            onSaved={() => setEdit(null)}
          />
        </>
      )}
    </div>
  );
}

// ---------- agents ----------
type AgentPatch = Partial<{ model: string; effort: string; calls: number; minutes: number; enabled: boolean; does: string; writes: string[] }>;
type RolePatch = Partial<Pick<Role, "role" | "does" | "writes" | "runtime" | "fallback">>;

function usageOf(id: string, flows: Flow[]) {
  return flows.map((f) => {
    const tags = flowTags(f);
    return { flow: f, tags: [...new Set(f.steps.map((s, i) => (s.groups.flat().some((c) => c.actor === id) ? tags[i] : null)).filter(Boolean) as string[])] };
  });
}

function AgentsTab() {
  const ctx = usePanel();
  const { settings, agents, data } = ctx;
  const flows = Object.values(settings.flows);
  const [edits, setEdits] = useState<Record<string, AgentPatch>>({});
  const [roleEdits, setRoleEdits] = useState<Record<string, RolePatch>>({});
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const saver = useSaver();
  const count = Object.keys(edits).length + Object.keys(roleEdits).length;
  const baseOf = (a: AgentInfo): Required<Omit<AgentPatch, "does" | "writes">> => ({
    model: a.model,
    effort: a.effort,
    calls: a.calls ?? 0,
    minutes: a.minutes ?? 0,
    enabled: a.state === "active",
  });
  const setA = (name: string, k: keyof AgentPatch, v: AgentPatch[keyof AgentPatch]) => {
    saver.reset();
    setEdits((prev) => {
      const a = agents[name];
      const role = settings.roles.find((r) => r.id === name);
      const base: AgentPatch = { ...baseOf(a), does: role?.does, writes: role?.writes };
      const p: AgentPatch = { ...prev[name], [k]: v };
      for (const key of Object.keys(p) as (keyof AgentPatch)[]) if (same(p[key], base[key])) delete p[key];
      const next = { ...prev };
      if (Object.keys(p).length) next[name] = p;
      else delete next[name];
      return next;
    });
  };
  const setR = (id: string, k: keyof RolePatch, v: string | string[]) => {
    saver.reset();
    setRoleEdits((prev) => {
      const r = settings.roles.find((x) => x.id === id)!;
      const p: RolePatch = { ...prev[id], [k]: v };
      for (const key of Object.keys(p) as (keyof RolePatch)[]) if (same(p[key], r[key])) delete p[key];
      const next = { ...prev };
      if (Object.keys(p).length) next[id] = p;
      else delete next[id];
      return next;
    });
  };
  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const active = data.agents.filter((a) => a.state === "active").length;
  const change = {
    kind: "agents",
    items: Object.entries(edits).map(([name, patch]) => ({ name, patch })),
    roles: Object.entries(roleEdits).map(([id, patch]) => ({ id, patch })),
  };
  return (
    <div>
      <div className="flex items-center gap-3">
        <h3 className="text-[15px] font-semibold tracking-tight">Кто работает в /prd</h3>
        <span className="text-xs text-muted-foreground">
          агенты включены: {active} из {data.agents.length}
        </span>
        <Button variant="ghost" size="sm" className="ml-auto" onClick={() => setOpen(open.size ? new Set() : new Set(settings.roles.map((r) => r.id)))}>
          {open.size ? "Свернуть все" : "Развернуть все"}
        </Button>
      </div>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full min-w-[820px] text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs text-subtle-foreground">
              <th className="py-2 pr-3 font-medium">Участник</th>
              <th className="py-2 pr-2 font-medium">Модель</th>
              <th className="py-2 pr-2 font-medium">Уровень</th>
              <th className="py-2 pr-2 font-medium">Лимит: вызовов · минут</th>
              <th className="py-2 pr-2 font-medium">Вкл</th>
              {flows.map((f) => (
                <th key={f.id} title={f.label} className="py-2 pr-2 font-medium">
                  {f.short}
                </th>
              ))}
              <th className="w-8" />
            </tr>
          </thead>
          <tbody>
            {settings.roles.map((r) => {
              const a = agents[r.id];
              const e = edits[r.id] ?? {};
              const isOpen = open.has(r.id);
              const changed = !!edits[r.id] || !!roleEdits[r.id];
              const u = usageOf(r.id, flows);
              const rt = runtimeOf(r.id, ctx);
              const v = a ? { ...baseOf(a), ...e } : null;
              return (
                <Fragment key={r.id}>
                  <tr className={cn(!isOpen && "border-b border-border-hairline", changed && "bg-state-active")}>
                    <td className="py-1.5 pr-3">
                      <button type="button" className="text-left" onClick={() => toggle(r.id)}>
                        <Actor id={r.id} className="font-medium" />
                      </button>
                      {rt.warn && <span className="ml-2 text-xs font-medium text-destructive-text">{rt.warn}</span>}
                    </td>
                    {v ? (
                      <>
                        <td className="py-1.5 pr-2">
                          <select aria-label={`Модель: ${r.role}`} className={fieldCls} value={v.model} onChange={(ev) => setA(r.id, "model", ev.target.value)}>
                            {MODELS.map((m) => (
                              <option key={m.value} value={m.value}>
                                {m.label}
                              </option>
                            ))}
                            {!MODELS.some((m) => m.value === v.model) && <option value={v.model}>{v.model}</option>}
                          </select>
                        </td>
                        <td className="py-1.5 pr-2">
                          <select aria-label={`Уровень: ${r.role}`} className={fieldCls} value={v.effort} onChange={(ev) => setA(r.id, "effort", ev.target.value)}>
                            {EFFORTS.map((x) => (
                              <option key={x} value={x}>
                                {x || "—"}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td className="py-1.5 pr-2">
                          <span className="inline-flex items-center gap-1">
                            <Input type="number" min={1} aria-label="Вызовов" className="h-8 w-16 text-right tabular-nums" value={v.calls || ""} onChange={(ev) => setA(r.id, "calls", Number(ev.target.value))} />
                            <span className="text-subtle-foreground">·</span>
                            <Input type="number" min={1} aria-label="Минут" className="h-8 w-16 text-right tabular-nums" value={v.minutes || ""} onChange={(ev) => setA(r.id, "minutes", Number(ev.target.value))} />
                          </span>
                        </td>
                        <td className="py-1.5 pr-2">
                          <input type="checkbox" aria-label={`Включён: ${r.role}`} className="size-4" checked={v.enabled} onChange={(ev) => setA(r.id, "enabled", ev.target.checked)} />
                        </td>
                      </>
                    ) : (
                      <td colSpan={4} className="py-1.5 pr-2 text-muted-foreground">
                        {rt.text || "—"}
                      </td>
                    )}
                    {u.map(({ flow, tags }) => (
                      <td key={flow.id} className="py-1.5 pr-2 tabular-nums">
                        {tags.length ? tags.join(", ") : <span className="text-subtle-foreground">—</span>}
                      </td>
                    ))}
                    <td className="py-1.5 pr-1 text-right">
                      <button type="button" aria-expanded={isOpen} aria-label={`${isOpen ? "Свернуть" : "Развернуть"}: ${r.role}`} onClick={() => toggle(r.id)} className="rounded p-0.5 text-subtle-foreground">
                        <Icon name="ChevronDown" className={cn("size-4 transition-transform", isOpen && "rotate-180")} />
                      </button>
                    </td>
                  </tr>
                  {isOpen && (
                    <tr className="border-b border-border-hairline">
                      <td colSpan={flows.length + 6} className="pb-3 pl-3.5 pr-3">
                        <div className="grid max-w-4xl grid-cols-1 gap-2.5 @2xl:grid-cols-2">
                          <Labeled label="Что делает (для панели)" wide>
                            <textarea
                              className={cn(areaCls, "min-h-14")}
                              value={(a ? e.does : roleEdits[r.id]?.does) ?? r.does}
                              onChange={(ev) => (a ? setA(r.id, "does", ev.target.value) : setR(r.id, "does", ev.target.value))}
                            />
                          </Labeled>
                          <Labeled label="Пишет (через запятую)" wide>
                            <Input
                              className="h-8"
                              value={((a ? e.writes : roleEdits[r.id]?.writes) ?? r.writes).join(", ")}
                              onChange={(ev) => (a ? setA(r.id, "writes", parseList(ev.target.value)) : setR(r.id, "writes", parseList(ev.target.value)))}
                            />
                          </Labeled>
                          {!a && r.runtime !== undefined && (
                            <Labeled label="Где работает" wide>
                              <Input className="h-8" value={roleEdits[r.id]?.runtime ?? r.runtime ?? ""} onChange={(ev) => setR(r.id, "runtime", ev.target.value)} />
                            </Labeled>
                          )}
                          {r.fallback && <p className="col-span-full text-[13px] text-muted-foreground">Если недоступен: {r.fallback}</p>}
                          {a && (
                            <p className="col-span-full text-xs leading-relaxed text-subtle-foreground">
                              Инструменты: {a.tools || "все"} · {a.description}
                              <br />
                              <span title={a.file}>
                                {formatHomePathForDisplay(a.file)} · изменён {ruDate(a.updatedAt)}
                              </span>
                            </p>
                          )}
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-xs text-subtle-foreground">
        Модель, уровень, лимит и «вкл» пишутся в шапку файла агента в папке агентов из настроек (выключенный — в agents-disabled рядом), модель — ещё в таблицу routing.md. В колонках режимов — номера шагов
        цепочки.
      </p>
      <SaveBar
        count={count}
        text={`Изменено: ${count} ${plural(count, "участник", "участника", "участников")}`}
        saver={saver}
        change={change}
        title={`Агенты: ${[...Object.keys(edits), ...Object.keys(roleEdits)].join(", ")}`}
        onCancel={() => {
          setEdits({});
          setRoleEdits({});
        }}
        onSaved={() => {
          setEdits({});
          setRoleEdits({});
        }}
      />
    </div>
  );
}

// ---------- params ----------
function ParamField({ k, p, value, onChange }: { k: string; p: Param; value: string | number; onChange: (v: string | number) => void }) {
  const changed = String(value) !== String(p.value);
  const ring = changed && "ring-2 ring-foreground";
  if (p.type === "number")
    return <Input type="number" aria-label={p.label} min={p.min} max={p.max} className={cn("h-8 w-24 text-right tabular-nums", ring)} value={value} onChange={(e) => onChange(e.target.value)} />;
  if (p.type === "text") return <Input aria-label={p.label} className={cn("h-8 w-44", ring)} value={value} onChange={(e) => onChange(e.target.value)} />;
  if (p.type === "select")
    return (
      <select aria-label={p.label} className={cn(fieldCls, ring)} value={String(value)} onChange={(e) => onChange(e.target.value)}>
        {(p.options ?? []).map((o) => (
          <option key={optValue(o)} value={optValue(o)}>
            {optLabel(o)}
          </option>
        ))}
      </select>
    );
  return (
    <span className={cn("inline-flex rounded-lg", ring)} data-key={k}>
      <Segmented items={(p.options ?? []).map((o) => ({ id: optValue(o), label: optLabel(o) }))} value={String(value)} onChange={(v) => onChange(v)} />
    </span>
  );
}

function ParamsTab() {
  const { settings, data } = usePanel();
  const [vals, setVals] = useState<Record<string, string | number>>({});
  const [occ, setOcc] = useState<string | null>(null);
  const saver = useSaver();
  const entries = Object.entries(settings.params);
  const groups = [...new Set(entries.map(([, p]) => p.group))];
  const changedKeys = Object.keys(vals).filter((k) => String(vals[k]) !== String(settings.params[k].value));
  const values = Object.fromEntries(changedKeys.map((k) => [k, settings.params[k].type === "number" ? Number(vals[k]) : vals[k]]));
  return (
    <div>
      <p className="mb-4 text-[13px] text-muted-foreground">Одно поле — все места в скилле. Число меняется сразу во всех файлах, где оно записано, и в скрипте проверки prd_tools.js.</p>
      <div className="grid grid-cols-1 gap-4 @3xl:grid-cols-2">
        {groups.map((g) => (
          <section key={g} className="rounded-lg border border-border p-3">
            <h4 className="mb-1 text-sm font-semibold">{g}</h4>
            {entries
              .filter(([, p]) => p.group === g)
              .map(([k, p]) => {
                const o = data.occurrences[k] ?? [];
                return (
                  <div key={k} className="border-t border-border-hairline py-2 first-of-type:border-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="min-w-0 flex-1 text-sm">{p.label}</span>
                      <ParamField
                        k={k}
                        p={p}
                        value={vals[k] ?? p.value}
                        onChange={(v) => {
                          saver.reset();
                          setVals((prev) => ({ ...prev, [k]: v }));
                        }}
                      />
                      <button type="button" className="w-14 text-right text-xs text-subtle-foreground hover:text-foreground" onClick={() => setOcc(occ === k ? null : k)} aria-expanded={occ === k}>
                        {o.length} {plural(o.length, "место", "места", "мест")}
                      </button>
                    </div>
                    {occ === k && (
                      <ul className="mt-1.5 space-y-0.5 rounded-md bg-surface-recessed px-2.5 py-1.5 font-mono text-[11.5px] text-muted-foreground">
                        {o.map((x, i) => (
                          <li key={i}>
                            {x.file}:{x.line}
                            {x.plain && <span className="ml-2 font-sans text-subtle-foreground">без метки (код или шапка)</span>}
                            {x.slot && <span className="ml-2 font-sans text-subtle-foreground">вариант текста</span>}
                          </li>
                        ))}
                        {!o.length && <li className="font-sans">в текстах не найдено</li>}
                      </ul>
                    )}
                  </div>
                );
              })}
          </section>
        ))}
      </div>
      <SaveBar
        count={changedKeys.length}
        text={`Изменено: ${changedKeys.map((k) => settings.params[k].label).join(", ")}`}
        saver={saver}
        change={{ kind: "params", values }}
        title={`Параметры: ${changedKeys.map((k) => `${settings.params[k].label} → ${vals[k]}`).join("; ")}`}
        onCancel={() => setVals({})}
        onSaved={() => setVals({})}
      />
    </div>
  );
}

// ---------- texts ----------
function fileGroup(rel: string) {
  if (rel.startsWith("agents/")) return "Агенты";
  if (rel.startsWith("references/roles/")) return "Роли агентов";
  if (rel.startsWith("evals/")) return "Эталон";
  if (rel === "settings.json") return "Служебное";
  return "Скилл";
}

function TextsTab() {
  const { data, rpc } = usePanel();
  const [rel, setRel] = useState("SKILL.md");
  const [orig, setOrig] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const saver = useSaver();
  const dirty = orig !== null && text !== orig;
  const fetchFile = useCallback(
    (r: string) =>
      rpc.call("read_file", { rel: r }).then(
        (x) => {
          setOrig(x.text);
          setText(x.text);
          setLoadErr(null);
        },
        (e: unknown) => setLoadErr(errText(e)),
      ),
    [rpc],
  );
  useEffect(() => {
    void fetchFile(rel);
  }, [rel, fetchFile, data.journal[0]?.seq]);
  const groups = ["Скилл", "Роли агентов", "Агенты", "Эталон", "Служебное"];
  return (
    <div className="grid grid-cols-1 gap-4 @3xl:grid-cols-[230px_minmax(0,1fr)]">
      <nav className="space-y-3 text-sm">
        {groups.map((g) => {
          const files = data.files.filter((f) => fileGroup(f.rel) === g);
          if (!files.length) return null;
          return (
            <div key={g}>
              <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-subtle-foreground">{g}</p>
              {files.map((f) => (
                <button
                  key={f.rel}
                  type="button"
                  disabled={dirty && f.rel !== rel}
                  onClick={() => {
                    setRel(f.rel);
                    saver.reset();
                  }}
                  className={cn(
                    "block w-full truncate rounded-md px-2 py-1 text-left font-mono text-xs disabled:opacity-50",
                    f.rel === rel ? "bg-state-active text-foreground" : "text-muted-foreground hover:bg-state-hover hover:text-foreground",
                  )}
                  title={f.rel}
                >
                  {f.rel.replace(/^(references\/roles\/|references\/|agents\/|evals\/)/, "")}
                  {f.disabled && <span className="ml-1 font-sans text-subtle-foreground">выкл</span>}
                </button>
              ))}
            </div>
          );
        })}
        {dirty && <p className="text-xs text-warning-text">Есть несохранённые правки: сохрани или отмени, чтобы открыть другой файл.</p>}
      </nav>
      <div className="min-w-0">
        <div className="mb-2 flex flex-wrap items-baseline gap-2">
          <h3 className="font-mono text-sm font-medium">{rel}</h3>
          <span className="text-xs text-subtle-foreground">
            {rel === "settings.json"
              ? "служебный файл: правка JSON целиком, после сохранения тексты перепишутся"
              : "числа в <!--p:…--> и блоки <!--gen:…--> меняются во вкладках «Параметры» и «Цепочка»"}
          </span>
        </div>
        {loadErr && <p className="mb-2 text-sm text-destructive-text">{loadErr}</p>}
        <textarea
          aria-label={`Текст ${rel}`}
          spellCheck={false}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            saver.reset();
          }}
          className="h-[62vh] w-full resize-y rounded-md border border-input bg-transparent p-3 font-mono text-[12.5px] leading-relaxed focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        />
        <SaveBar
          count={dirty ? 1 : 0}
          text={`${rel} изменён`}
          saver={saver}
          change={{ kind: "text", rel, content: text }}
          title={`Текст: ${rel}`}
          onCancel={() => setText(orig ?? "")}
          onSaved={() => void fetchFile(rel)}
        />
      </div>
    </div>
  );
}

// ---------- changes: drafts, journal, versions ----------
const DRAFT_STATUS: Record<Draft["status"], { label: string; tone: string }> = {
  work: { label: "ИИ правит черновик", tone: "bg-attention" },
  ready: { label: "готов, ждёт решения", tone: "bg-success" },
  failed: { label: "не получилось", tone: "bg-destructive" },
  accepted: { label: "принят", tone: "bg-subtle-foreground" },
  rejected: { label: "отклонён", tone: "bg-subtle-foreground" },
};

function DraftCard({ d }: { d: Draft }) {
  const { rpc, reload, nav, notify } = usePanel();
  const [p, setP] = useState<DraftPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const st = DRAFT_STATUS[d.status];
  const stalled = d.status === "work" && d.threadStatus && /idle|done|complete|stopped|error/i.test(d.threadStatus);
  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
      if (ok) notify(ok);
      await reload();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };
  const open = d.status === "work" || d.status === "ready" || d.status === "failed";
  return (
    <div className={cn("rounded-lg border p-3", d.status === "ready" ? "border-foreground" : "border-border")}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1.5 text-xs">
          <span aria-hidden className={cn("size-2 rounded-full", st.tone)} />
          {st.label}
        </span>
        <span className="text-xs text-subtle-foreground">
          {ruDateTime(d.ts)} · {d.id}
        </span>
        {stalled && <span className="text-xs text-warning-text">тред остановился без итога — открой тред</span>}
      </div>
      <p className="mt-1.5 text-sm font-medium">{d.result?.title || d.request}</p>
      {d.result?.title && <p className="text-xs text-muted-foreground">Просьба: {d.request}</p>}
      {d.result?.summary && <p className="mt-1 whitespace-pre-line text-[13px] text-muted-foreground">{d.result.summary}</p>}
      {!!d.result?.risks?.length && <p className="mt-1 text-[13px] text-warning-text">Риски: {d.result.risks.join("; ")}</p>}
      {err && <p className="mt-1.5 text-sm text-destructive-text">{err}</p>}
      <div className="mt-2 flex flex-wrap gap-1.5">
        {d.status === "ready" && (
          <Button size="sm" disabled={busy} onClick={() => void run(() => rpc.call("draft_accept", { id: d.id }), "Черновик принят: скилл изменён")}>
            <Icon name="Check" /> Принять
          </Button>
        )}
        {open && (
          <Button variant="outline" size="sm" disabled={busy} onClick={() => void run(() => rpc.call("draft_reject", { id: d.id }), "Черновик отклонён")}>
            Отклонить
          </Button>
        )}
        {(d.status === "ready" || d.status === "work") && (
          <Button variant="outline" size="sm" disabled={busy} onClick={() => void run(async () => setP((await rpc.call("draft_preview", { id: d.id })) as DraftPreview))}>
            <Icon name="Eye" /> {p ? "Обновить изменения" : "Показать изменения"}
          </Button>
        )}
        {d.status === "ready" && (
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const r = await rpc.call("eval_start", { draftId: d.id });
                nav.toThread(r.threadId);
              }, "Запущен эталонный прогон черновика")
            }
          >
            Проверить эталоном
          </Button>
        )}
        {d.threadId && (
          <Button variant="ghost" size="sm" onClick={() => nav.toThread(d.threadId!)}>
            <Icon name="MessageSquare" /> Тред
          </Button>
        )}
        {d.evalThreadId && (
          <Button variant="ghost" size="sm" onClick={() => nav.toThread(d.evalThreadId!)}>
            Тред эталона
          </Button>
        )}
      </div>
      {d.eval && (
        <details className="group mt-2">
          <summary className="inline-flex cursor-pointer list-none items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
            <Icon name="ChevronRight" className="size-3.5 transition-transform group-open:rotate-90" />
            Итог эталона черновика
          </summary>
          <pre className="mt-1 whitespace-pre-wrap rounded-md bg-surface-recessed p-2 font-mono text-[12px]">{d.eval}</pre>
        </details>
      )}
      {p && (
        <div className="mt-3">
          {p.problems.length > 0 && (
            <Banner>
              Ошибки меток в черновике ({p.problems.length}): {p.problems.slice(0, 3).map((x) => `${x.file} — ${x.text}`).join("; ")}. Принять нельзя, пока ИИ их не исправит.
            </Banner>
          )}
          <DiffView preview={p} />
        </div>
      )}
    </div>
  );
}

function ChangesTab() {
  const { data, rpc, reload, nav, notify } = usePanel();
  const [req, setReq] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [rp, setRp] = useState<{ version: string; title: string; p: Preview } | null>(null);
  const [showDone, setShowDone] = useState(false);
  const versionTitle = (id: string) => data.versions.find((v) => v.id === id)?.title ?? id;
  const askRestore = async (version: string, title: string) => {
    setBusy(true);
    setErr(null);
    try {
      setRp({ version, title, p: (await rpc.call("restore_preview", { version })) as Preview });
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };
  const drafts = data.drafts.filter((d) => showDone || d.status === "work" || d.status === "ready" || d.status === "failed");
  const closed = data.drafts.length - data.drafts.filter((d) => d.status === "work" || d.status === "ready" || d.status === "failed").length;
  return (
    <div className="space-y-6">
      <section>
        <h3 className="mb-2 text-[15px] font-semibold tracking-tight">Поменять словами</h3>
        <div className="flex flex-col gap-2 @2xl:flex-row @2xl:items-start">
          <textarea
            aria-label="Что поменять в скилле"
            value={req}
            onChange={(e) => setReq(e.target.value)}
            placeholder="Что поменять в скилле, своими словами. Например: «В Lite не спрашивай концепцию, если правка точечная»"
            className={cn(areaCls, "min-h-20 flex-1")}
          />
          <Button
            disabled={busy || req.trim().length < 5}
            onClick={async () => {
              setBusy(true);
              setErr(null);
              try {
                const r = await rpc.call("draft_create", { request: req.trim() });
                setReq("");
                notify("Тред ИИ запущен: он правит копию скилла. Рабочий скилл не изменится, пока не нажмёшь «Принять».");
                await reload();
                void r;
              } catch (e) {
                setErr(errText(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            Отдать ИИ
          </Button>
        </div>
        <p className="mt-1 text-xs text-subtle-foreground">Тред bb правит копию скилла и проверяет метки. Здесь появится «было / стало» и кнопки «Принять» или «Отклонить». Эталон — по кнопке.</p>
        {err && <p className="mt-2 text-sm text-destructive-text">{err}</p>}
        <div className="mt-3 space-y-2">
          {drafts.map((d) => (
            <DraftCard key={d.id} d={d} />
          ))}
          {!drafts.length && <p className="text-sm text-muted-foreground">Открытых черновиков нет.</p>}
          {closed > 0 && (
            <Button variant="ghost" size="sm" onClick={() => setShowDone(!showDone)}>
              {showDone ? "Скрыть закрытые" : `Показать закрытые (${closed})`}
            </Button>
          )}
        </div>
      </section>

      {rp && (
        <section className="rounded-lg bg-surface-recessed p-3">
          <h4 className="text-sm font-semibold">Вернуть скилл к версии {rp.version.slice(0, 5)}</h4>
          <p className="mb-2 text-xs text-muted-foreground">
            {rp.title}. Файлы версии заменят текущие; файлы, которых в версии не было, останутся. Перед возвратом текущее состояние тоже сохранится версией.
          </p>
          <DiffView preview={rp.p} />
          <div className="mt-3 flex gap-2">
            <Button
              size="sm"
              disabled={busy || (!rp.p.files.length && !rp.p.moves.length)}
              onClick={async () => {
                setBusy(true);
                try {
                  await rpc.call("restore_apply", { version: rp.version });
                  notify(`Скилл возвращён к версии ${rp.version.slice(0, 5)}`);
                  setRp(null);
                  await reload();
                } catch (e) {
                  setErr(errText(e));
                } finally {
                  setBusy(false);
                }
              }}
            >
              Вернуть
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setRp(null)}>
              Отмена
            </Button>
          </div>
        </section>
      )}

      <section>
        <h3 className="mb-2 text-[15px] font-semibold tracking-tight">Журнал</h3>
        {data.journal.length ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-[13px]">
              <thead>
                <tr className="border-b border-border text-left text-xs text-subtle-foreground">
                  <th className="py-1.5 pr-3 font-medium">Когда</th>
                  <th className="py-1.5 pr-3 font-medium">Кто</th>
                  <th className="py-1.5 pr-3 font-medium">Что</th>
                  <th className="py-1.5 pr-3 font-medium">Файлы</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.journal.map((e) => (
                  <tr key={e.seq} className="border-b border-border-hairline align-top last:border-0">
                    <td className="whitespace-nowrap py-1.5 pr-3 tabular-nums text-muted-foreground">{ruDateTime(e.ts)}</td>
                    <td className="py-1.5 pr-3">{e.by}</td>
                    <td className="py-1.5 pr-3">{e.title}</td>
                    <td className="py-1.5 pr-3 text-muted-foreground" title={e.files.join("\n")}>
                      {e.files.length}
                    </td>
                    <td className="py-1.5 text-right">
                      {e.prev && (
                        <Button variant="ghost" size="sm" disabled={busy} onClick={() => void askRestore(e.prev!, `Как было до правки «${e.title}»: ${versionTitle(e.prev!)}`)}>
                          Вернуть как было до неё
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Записей нет.</p>
        )}
      </section>

      <details className="group">
        <summary className="inline-flex cursor-pointer list-none items-center gap-1 text-[15px] font-semibold tracking-tight">
          <Icon name="ChevronRight" className="size-4 transition-transform group-open:rotate-90" />
          Версии ({data.versions.length})
        </summary>
        <ul className="mt-2 divide-y divide-border-hairline text-[13px]">
          {data.versions.map((v) => (
            <li key={v.id} className="flex items-center gap-3 py-1.5">
              <span className="w-12 font-mono text-xs">{v.id.slice(0, 5)}</span>
              <span className="w-24 tabular-nums text-muted-foreground">{ruDateTime(v.ts)}</span>
              <span className="w-12 text-muted-foreground">{v.by}</span>
              <span className="min-w-0 flex-1">{v.title}</span>
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => void askRestore(v.id, v.title)}>
                Вернуть к этой
              </Button>
            </li>
          ))}
        </ul>
        <p className="mt-1 text-xs text-subtle-foreground">
          Копии скилла и агентов prd-* лежат в {formatHomePathForDisplay(data.paths.data)}\versions.
          <button type="button" className="ml-2 underline" onClick={() => void rpc.call("open_folder", { target: "data" })}>
            Открыть папку
          </button>
        </p>
      </details>
      {void nav}
    </div>
  );
}

// ---------- runs ----------
type Tone = "ok" | "warn" | "bad" | "none";
const toneOf = (status: string): Tone =>
  /блокер|ошибк|упал|не ответил/i.test(status) ? "bad" : /частично/i.test(status) ? "warn" : /^готово|^\d+ замечан/i.test(status) ? "ok" : "none";
const TONE_DOT: Record<Tone, string> = { ok: "bg-success", warn: "bg-warning", bad: "bg-destructive", none: "bg-subtle-foreground" };

function Status({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span className="inline-flex items-start gap-1.5">
      <span aria-hidden className={cn("mt-[calc(0.5lh_-_3px)] size-1.5 shrink-0 rounded-full", TONE_DOT[tone])} />
      {children}
    </span>
  );
}

function RunTable({ run }: { run: Run }) {
  return (
    <div className="mb-3 ml-8 mr-2 overflow-x-auto">
      <table className="w-full min-w-[640px] text-[13px]">
        <thead>
          <tr className="border-b border-border text-left text-xs text-subtle-foreground">
            {["Волна", "Агент", "Модель · уровень", "Время", "Токены", "Статус", "Файл"].map((h) => (
              <th key={h} className="py-1.5 pr-3 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {run.rows.map((r, i) => (
            <tr key={i} className="border-b border-border-hairline align-top last:border-0">
              <td className="py-1.5 pr-3 tabular-nums text-muted-foreground">{r.step}</td>
              <td className="py-1.5 pr-3 font-medium">{r.agent}</td>
              <td className="py-1.5 pr-3 text-muted-foreground">{r.model}</td>
              <td className="whitespace-nowrap py-1.5 pr-3 tabular-nums">{r.time}</td>
              <td className="whitespace-nowrap py-1.5 pr-3 tabular-nums text-muted-foreground">{r.tokens}</td>
              <td className="py-1.5 pr-3">{r.status && <Status tone={toneOf(r.status)}>{r.status}</Status>}</td>
              <td className="py-1.5 font-mono text-xs text-muted-foreground [overflow-wrap:anywhere]">{r.file}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {run.notes.length > 0 && (
        <ul className="mt-2 list-disc space-y-0.5 pl-5 text-[13px] text-muted-foreground">
          {run.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function RunRowView({ run }: { run: Run }) {
  const { open } = usePanel();
  const counts = run.rows.reduce<Record<Tone, number>>((acc, r) => ({ ...acc, [toneOf(r.status)]: acc[toneOf(r.status)] + 1 }), { ok: 0, warn: 0, bad: 0, none: 0 });
  const n = run.rows.length;
  return (
    <details className="group">
      <summary className="flex cursor-pointer list-none items-center gap-3 rounded-md px-2 py-2.5 hover:bg-state-hover">
        <Icon name="ChevronRight" className="size-4 shrink-0 text-subtle-foreground transition-transform group-open:rotate-90" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{run.feature.replace(/[-_]+/g, " ")}</div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
            <span className="tabular-nums">{[run.sprint.slice(0, 3), run.mode, ruDate(run.date)].filter(Boolean).join(" · ")}</span>
            {n ? (
              <>
                <span className="tabular-nums">
                  {n} {plural(n, "шаг", "шага", "шагов")}
                </span>
                <Status tone="ok">готово {counts.ok}</Status>
                {counts.warn > 0 && <Status tone="warn">частично {counts.warn}</Status>}
                {counts.bad > 0 && <Status tone="bad">блокер {counts.bad}</Status>}
              </>
            ) : (
              <span className="text-subtle-foreground">таблицы агентов нет</span>
            )}
          </div>
        </div>
        <span className="flex shrink-0 gap-0.5" onClick={(e) => e.preventDefault()}>
          {[
            { label: "Журнал", path: run.logPath, aria: "Открыть run_log.md" },
            { label: "PRD", path: run.prdPath, aria: "Открыть PRD" },
            { label: "Дизайн", path: run.designPath, aria: "Открыть дизайн сайта" },
          ].map((l) => (
            <Button key={l.label} variant="ghost" size="sm" disabled={!l.path} onClick={() => l.path && open(l.path)} aria-label={l.path ? l.aria : `${l.label}: файла нет`}>
              {l.label}
            </Button>
          ))}
        </span>
      </summary>
      {n > 0 && <RunTable run={run} />}
    </details>
  );
}

function RunsTab() {
  const { data } = usePanel();
  if (!data.runs.length) return <p className="text-sm text-muted-foreground">В папке с PRD (настройка плагина) нет файлов run_log.md.</p>;
  return (
    <div>
      <p className="mb-2 text-xs text-subtle-foreground">Журналы run_log.md из папок спринтов. Пишет оркестратор; формат менялся, поэтому у ранних прогонов колонки могут быть пустыми.</p>
      <div className="divide-y divide-border-hairline">
        {data.runs.map((r) => (
          <RunRowView key={r.logPath} run={r} />
        ))}
      </div>
    </div>
  );
}

// ---------- banners: problems and outside edits ----------
function HealthBanners() {
  const { data, rpc, reload, notify } = usePanel();
  const [p, setP] = useState<{ mode: "render" | "adopt"; preview: Preview } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const hasValue = data.problems.some((x) => x.kind === "value");
  const ask = async (mode: "render" | "adopt") => {
    setBusy(true);
    setErr(null);
    try {
      setP({ mode, preview: (await rpc.call("fix_preview", { mode })) as Preview });
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      {data.problems.length > 0 && (
        <Banner>
          <p className="font-medium">
            Тексты скилла расходятся с настройками: {data.problems.length} {plural(data.problems.length, "место", "места", "мест")}
          </p>
          <ul className="mt-1 list-disc pl-5 text-[13px]">
            {data.problems.slice(0, 5).map((x, i) => (
              <li key={i}>
                <span className="font-mono text-xs">
                  {x.file}
                  {x.line ? `:${x.line}` : ""}
                </span>{" "}
                — {x.text}
              </li>
            ))}
          </ul>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <Button variant="outline" size="sm" disabled={busy} onClick={() => void ask("render")}>
              Переписать тексты по настройкам
            </Button>
            {hasValue && (
              <Button variant="outline" size="sm" disabled={busy} onClick={() => void ask("adopt")}>
                Взять числа из текста
              </Button>
            )}
          </div>
          {err && <p className="mt-1 text-sm text-destructive-text">{err}</p>}
          {p && (
            <div className="mt-3">
              <DiffView preview={p.preview} />
              <div className="mt-2 flex gap-2">
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await rpc.call("fix_apply", { mode: p.mode });
                      notify(p.mode === "adopt" ? "Числа взяты из текста" : "Тексты переписаны по настройкам");
                      setP(null);
                      await reload();
                    } catch (e) {
                      setErr(errText(e));
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  Сохранить
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setP(null)}>
                  Отмена
                </Button>
              </div>
            </div>
          )}
        </Banner>
      )}
      {data.outside.length > 0 && (
        <Banner tone="info">
          <p>
            Скилл правили не через панель (в чате или руками):{" "}
            <span className="font-mono text-xs">{data.outside.map((o) => `${o.rel}${o.kind === "new" ? " (новый)" : o.kind === "deleted" ? " (удалён)" : ""}`).join(", ")}</span>. Запиши это в журнал, чтобы можно было
            вернуться к прошлой версии.
          </p>
          <Button
            variant="outline"
            size="sm"
            className="mt-2"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await rpc.call("acknowledge", {});
                notify("Правка вне панели записана в журнал");
                await reload();
              } finally {
                setBusy(false);
              }
            }}
          >
            Записать в журнал
          </Button>
        </Banner>
      )}
    </>
  );
}

// ---------- panel ----------
const TABS = [
  { id: "chain", label: "Цепочка" },
  { id: "agents", label: "Агенты" },
  { id: "params", label: "Параметры" },
  { id: "texts", label: "Тексты" },
  { id: "changes", label: "Правки" },
  { id: "runs", label: "Прогоны" },
] as const;
type TabId = (typeof TABS)[number]["id"];

function PipelinePanel({ subPath }: PluginNavPanelProps) {
  const rpc = useRpc<typeof rpcContract>();
  const nav = useBbNavigate();
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const tab: TabId = (TABS.find((t) => t.id === subPath)?.id ?? "chain") as TabId;

  const reload = useCallback(async () => {
    setBusy(true);
    try {
      setData((await rpc.call("load", {})) as Loaded);
      setError(null);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }, [rpc]);
  useEffect(() => {
    void reload();
  }, [reload]);
  // While an AI draft or an eval run is in progress, re-read every 20 s.
  const waiting = !!data && (data.drafts.some((d) => d.status === "work") || data.eval.runs.some((r) => Date.now() - +new Date(r.ts) < 2 * 3600e3));
  useEffect(() => {
    if (!waiting) return;
    const t = setInterval(() => void reload(), 20000);
    return () => clearInterval(t);
  }, [waiting, reload]);

  const ctx = useMemo<Ctx | null>(() => {
    if (!data) return null;
    return {
      data,
      settings: data.settings,
      params: data.settings.params,
      roles: Object.fromEntries(data.settings.roles.map((r) => [r.id, r])),
      agents: Object.fromEntries(data.agents.map((a) => [a.name, a])),
      rpc,
      nav,
      reload,
      open: (p: string) => {
        const ok = nav.experimental_openFilePreview({ target: { kind: "workspace", environmentId: data.environmentId, path: p }, location: null });
        if (!ok) setNote(`Не удалось открыть ${p}`);
      },
      notify: setNote,
    };
  }, [data, rpc, nav, reload]);

  const ev = data?.eval;
  const lastJournal = data?.journal[0];
  const readyDrafts = data?.drafts.filter((d) => d.status === "ready").length ?? 0;
  const startEval = async () => {
    try {
      const r = await rpc.call("eval_start", {});
      setNote("Запущен эталонный прогон рабочего скилла (1 кейс, ~5 минут). Итог появится в шапке.");
      nav.toThread(r.threadId);
      await reload();
    } catch (e) {
      setNote(errText(e));
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="shrink-0 border-b border-border-seam px-5">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 pt-3">
          <div className="min-w-0">
            <h2 className="text-[15px] font-semibold leading-tight tracking-tight">Конвейер PRD</h2>
            <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
              <span>скилл /prd</span>
              {lastJournal && (
                <span>
                  · изменён {ruDateTime(lastJournal.ts)} ({lastJournal.by})
                </span>
              )}
              {ev && (
                <span className={cn("rounded-full px-2 py-0.5", ev.after > 0 ? "bg-surface-attention text-warning-text" : "bg-surface-recessed")}>
                  {ev.last ? `эталон ${ruDate(ev.last.date)}: судья ${ev.last.judge}` : "эталона не было"}
                  {ev.after > 0 && ` · после него ${ev.after} ${plural(ev.after, "правка", "правки", "правок")}`}
                </span>
              )}
            </p>
          </div>
          <div className="ml-auto flex items-center gap-1">
            <Button variant="outline" size="sm" disabled={!data} onClick={() => void startEval()} aria-label="Запустить эталонный прогон рабочего скилла">
              Проверить эталоном
            </Button>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => void reload()} aria-label="Перечитать скилл, агентов и журналы">
              <Icon name="RotateCcw" /> Перечитать
            </Button>
            <Button variant="ghost" size="icon" onClick={() => void rpc.call("open_folder", { target: "skill" })} aria-label="Открыть папку скилла prd">
              <Icon name="FolderOpen" />
            </Button>
            <Button
              size="sm"
              disabled={!data}
              onClick={() => data && nav.toCompose({ ...(data.projectId ? { projectId: data.projectId } : {}), ...(data.environmentId ? { environmentId: data.environmentId } : {}), initialPrompt: "/prd ", focusPrompt: true })}
              aria-label="Новый тред с /prd"
            >
              <Icon name="Plus" /> Новый PRD
            </Button>
          </div>
        </div>
        <nav role="tablist" className="mt-1.5 flex flex-wrap gap-x-5">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => nav.toPluginPanel("prd-pipeline", { subPath: t.id })}
              className={cn(
                "-mb-px border-b-2 pb-2 pt-1.5 text-sm transition-colors",
                tab === t.id ? "border-foreground font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {t.label}
              {t.id === "runs" && data ? <span className="ml-1.5 tabular-nums text-subtle-foreground">{data.runs.length}</span> : null}
              {t.id === "changes" && readyDrafts > 0 ? <span className="ml-1.5 rounded-full bg-foreground px-1.5 text-[11px] tabular-nums text-background">{readyDrafts}</span> : null}
            </button>
          ))}
        </nav>
      </header>
      <main className="min-h-0 flex-1 overflow-y-auto">
        <div className="@container mx-auto w-full max-w-[1120px] px-5 pt-5">
          {note && (
            <Banner tone="info">
              <div className="flex items-start gap-2">
                <span className="flex-1">{note}</span>
                <button type="button" className="text-xs text-subtle-foreground hover:text-foreground" onClick={() => setNote(null)}>
                  Скрыть
                </button>
              </div>
            </Banner>
          )}
          {error && <p className="mb-4 text-sm text-destructive-text">{error}</p>}
          {!data && !error && <p className="text-sm text-muted-foreground">Загрузка…</p>}
          {ctx && (
            <PanelCtx.Provider value={ctx}>
              <HealthBanners />
              <div className="pb-6">
                {tab === "chain" && <ChainTab />}
                {tab === "agents" && <AgentsTab />}
                {tab === "params" && <ParamsTab />}
                {tab === "texts" && <TextsTab />}
                {tab === "changes" && <ChangesTab />}
                {tab === "runs" && <RunsTab />}
              </div>
            </PanelCtx.Provider>
          )}
        </div>
      </main>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "prd-pipeline",
    title: "Конвейер PRD",
    icon: "Workflow",
    path: "prd-pipeline",
    component: PipelinePanel,
  });
});
