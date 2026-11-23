// Релизы — общие детали интерфейса: цвета ролей, точки, плашки, полосы долей, боковая карточка.
// Стиль: токены темы bb (без dark:). Цвета ролей — переменные --rl-* в REL_CSS: .rl-root светлая, .dark .rl-root тёмная.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useRef, type ReactNode } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

export type View = any;
export type Rel = any;
export type Row = any;
export type Anom = any;
export type Rpc = ReturnType<typeof useRpc<typeof rpcContract>>;
export type Res = { ok: boolean; message?: string };
export type Act = (fn: () => Promise<Res>) => Promise<void>;

export const REL_CSS = `
.rl-root{--rl-good:oklch(55% .14 155);--rl-info:oklch(55% .14 245);--rl-warn:oklch(62% .15 78);--rl-serious:oklch(60% .18 48);--rl-bad:oklch(55% .21 25);--rl-purple:oklch(54% .17 300);--rl-muted:oklch(64% .012 255)}
.dark .rl-root{--rl-good:oklch(76% .16 155);--rl-info:oklch(74% .13 240);--rl-warn:oklch(82% .15 88);--rl-serious:oklch(74% .16 52);--rl-bad:oklch(68% .2 25);--rl-purple:oklch(73% .14 300);--rl-muted:oklch(58% .012 255)}
.rl-root details>summary::-webkit-details-marker{display:none}
`;
const TONES = ["good", "info", "warn", "serious", "bad", "purple", "muted"];
/** цвет роли: успех, инфо, внимание, серьёзно, плохо, перенос, нейтрально */
export const tc = (t: string | undefined | null) => `var(--rl-${t && TONES.includes(t) ? t : "muted"})`;
export const tint = (c: string, p: number) => `color-mix(in oklab, ${c} ${p}%, transparent)`;

export const SEV_TONE = ["muted", "info", "warn", "bad"];
export const GROUP_TONE: Record<string, string> = { tail: "bad", notready: "serious", scope: "warn", stuck: "info" };
export const MODE_LABEL: Record<string, string> = { fact: "итог", forecast: "прогноз", plan: "следующий" };
/** слово рядом с «Прошлый / Текущий / Следующий» */
export const MODE_WORD: Record<string, string> = { fact: "итог", forecast: "прогноз", plan: "готовность" };
export const SLOT_LABEL: Record<string, string> = { prev: "Прошлый", cur: "Текущий", next: "Следующий" };
export type Product = { id: string; name: string; short: string; emoji: string; open?: number | null };
// Продукты из настроек плагина: app.tsx обновляет список после каждой загрузки (setProducts0).
export const PRODUCTS0: Product[] = [{ id: "main", name: "Продукт A", short: "A", emoji: "🚀" }];
export const setProducts0 = (list: Product[]) => { if (list.length) PRODUCTS0.splice(0, PRODUCTS0.length, ...list); };
/** Ключи проектов Jira из настроек (view.jira.projects) для подписей. */
export const projOf = (v: any): { epic: string; dev: string; design: string; qa: string } => ({ epic: "", dev: "", design: "", qa: "", ...(v?.jira?.projects ?? {}) });
export const taskProjects = (v: any) => { const p = projOf(v); return [p.dev, p.design, p.qa].filter(Boolean).join(" / ") || "разработки"; };
export const prodName = (id: string | undefined) => { const p = PRODUCTS0.find((x) => x.id === id) ?? PRODUCTS0[0]; return `${p.emoji} ${p.short}`; };

export const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
export const ddm = (d: string | undefined | null) => (d ? `${d.slice(8, 10)}.${d.slice(5, 7)}` : "");
export const dt = (s: string | null | undefined) => (s ? new Date(s).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—");
export const plural = (n: number, one: string, few: string, many: string) => {
  const a = Math.abs(n) % 100, b = a % 10;
  return a > 10 && a < 20 ? many : b === 1 ? one : b >= 2 && b <= 4 ? few : many;
};
export const signed = (n: number) => (n > 0 ? "+" : n < 0 ? "−" : "") + Math.abs(Math.round(n)).toLocaleString("ru-RU");
export const inputCls = "rounded-md border border-border bg-transparent px-2 py-1 text-[13px] text-foreground outline-none placeholder:text-subtle-foreground focus:border-foreground/40";

// ---------- Мелкие детали ----------
export function Dot({ tone, className }: { tone: string; className?: string }) {
  return <span aria-hidden className={cn("inline-block size-2 shrink-0 rounded-full", className)} style={{ background: tc(tone) }} />;
}
/** статус: точка и текст обычным цветом */
export function Badge({ tone, children, className }: { tone: string; children: ReactNode; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 whitespace-nowrap text-[12.5px]", className)}>
      <Dot tone={tone} />
      {children}
    </span>
  );
}
/** короткая метка на подложке: «новый», «критично» */
export function Pill({ tone, children, title }: { tone: string; children: ReactNode; title?: string }) {
  return (
    <span title={title} className="inline-flex shrink-0 items-center whitespace-nowrap rounded px-1.5 py-px text-[11px] font-medium leading-[16px]" style={{ background: tint(tc(tone), 18), color: tc(tone) }}>
      {children}
    </span>
  );
}
export function Key({ k, url }: { k: string; url: string }) {
  return (
    <a href={url} target="_blank" rel="noreferrer" title="Открыть в Jira" className="shrink-0 whitespace-nowrap font-mono text-[12px] font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
      {k}
    </a>
  );
}
export function Chip({ on, onClick, children, title }: { on?: boolean; onClick: () => void; children: ReactNode; title?: string }) {
  return (
    <button type="button" title={title} aria-pressed={!!on} onClick={onClick}
      className={cn("inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 py-1 text-[12.5px] transition-colors", on ? "bg-state-active font-medium text-foreground" : "text-muted-foreground hover:bg-state-hover hover:text-foreground")}>
      {children}
    </button>
  );
}
export const Num = ({ children }: { children: ReactNode }) => <span className="tabular-nums text-subtle-foreground">{children}</span>;
/** переключатель из нескольких вариантов в одной рамке */
export function Seg<T extends string>({ value, onChange, options, label, size = "md" }: { value: T; onChange: (v: T) => void; options: { id: T; label: ReactNode; title?: string }[]; label: string; size?: "sm" | "md" }) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex max-w-full flex-wrap items-center rounded-lg border border-border-hairline p-0.5">
      {options.map((o) => (
        <button key={o.id} type="button" role="radio" aria-checked={value === o.id} title={o.title} onClick={() => onChange(o.id)}
          className={cn("inline-flex items-center gap-1.5 whitespace-nowrap rounded-md transition-colors", size === "sm" ? "px-2 py-0.5 text-[12px]" : "px-2.5 py-1 text-[13px]", value === o.id ? "bg-state-active font-medium text-foreground" : "text-muted-foreground hover:text-foreground")}>
          {o.label}
        </button>
      ))}
    </div>
  );
}
export function Note({ children, tone = "warn" }: { children: ReactNode; tone?: "warn" | "info" }) {
  return (
    <div className={cn("mb-4 flex gap-2 rounded-lg px-3 py-2 text-[13px]", tone === "warn" ? "bg-surface-attention" : "bg-surface-recessed")}>
      <Icon name={tone === "warn" ? "AlertTriangle" : "Info"} className={cn("mt-0.5 size-4 shrink-0", tone === "warn" ? "text-warning-text" : "text-muted-foreground")} />
      <div className="min-w-0">{children}</div>
    </div>
  );
}
export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("rounded-xl border border-border-hairline bg-surface-recessed", className)}>{children}</div>;
}
/** заголовок блока: название, счётчик, действие справа */
export function Head({ children, n, right, className }: { children: ReactNode; n?: ReactNode; right?: ReactNode; className?: string }) {
  return (
    <div className={cn("mb-2 flex min-w-0 items-baseline gap-2", className)}>
      <h3 className="text-[14px] font-semibold tracking-tight">{children}</h3>
      {n != null && <span className="text-[13px] tabular-nums text-subtle-foreground">{n}</span>}
      {right && <div className="ml-auto flex shrink-0 items-center gap-1 text-[12.5px] text-muted-foreground">{right}</div>}
    </div>
  );
}
export function LinkBtn({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} className="inline-flex items-center gap-0.5 whitespace-nowrap rounded px-1 text-[12.5px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
      {children}
      <Icon name="ChevronRight" className="size-3.5" />
    </button>
  );
}
export function Empty({ children }: { children: ReactNode }) {
  return <p className="rounded-lg border border-dashed border-border-hairline px-3 py-5 text-center text-[13px] text-muted-foreground">{children}</p>;
}
/** длинное пояснение: свёрнуто, пока не нужно */
export function Hint({ title = "Как это работает", children }: { title?: string; children: ReactNode }) {
  return (
    <details className="group mb-3 text-[12.5px]">
      <summary className="inline-flex cursor-pointer list-none items-center gap-1 text-muted-foreground hover:text-foreground">
        <Icon name="ChevronRight" className="size-3.5 transition-transform group-open:rotate-90" />
        {title}
      </summary>
      <div className="mt-1.5 max-w-3xl rounded-lg bg-surface-recessed px-3 py-2 leading-relaxed text-muted-foreground">{children}</div>
    </details>
  );
}

// ---------- Полоса долей ----------
export type Part = { k: string; n: number; tone: string; label: string };
export function StackBar({ parts, h = 8, active, onPick, className }: { parts: Part[]; h?: number; active?: string; onPick?: (k: string) => void; className?: string }) {
  const total = parts.reduce((s, p) => s + p.n, 0);
  if (!total) return <div className={cn("w-full rounded-full bg-state-hover", className)} style={{ height: h }} />;
  return (
    <div className={cn("flex w-full gap-px overflow-hidden rounded-full", className)} style={{ height: h }} role="img" aria-label={parts.filter((p) => p.n).map((p) => `${p.label} ${p.n}`).join(", ")}>
      {parts.filter((p) => p.n > 0).map((p) => {
        const st = { flexGrow: p.n, flexBasis: 0, minWidth: 3, background: tc(p.tone), opacity: active && active !== "all" && active !== p.k ? 0.28 : 1 };
        return onPick
          ? <button key={p.k} type="button" title={`${p.label}: ${p.n}`} aria-label={`${p.label}: ${p.n}`} onClick={() => onPick(p.k)} className="h-full transition-opacity hover:opacity-100" style={st} />
          : <span key={p.k} title={`${p.label}: ${p.n}`} className="h-full" style={st} />;
      })}
    </div>
  );
}
/** прогресс задач эпика: готово · тест · в работе · возврат · пауза · не начато */
const G_SEG: [string, string, string][] = [["done", "good", "готово"], ["test", "info", "в тесте"], ["work", "warn", "в работе"], ["kick", "bad", "возврат"], ["hold", "serious", "пауза"], ["todo", "muted", "не начато"]];
export function Progress({ g, legend }: { g: any; legend?: boolean }) {
  if (!g.total) return <span className="text-xs text-subtle-foreground">нет задач</span>;
  const parts = G_SEG.map(([k, tone, label]) => ({ k, tone, label, n: g[k] || 0 }));
  return (
    <div className="min-w-0">
      <div className="whitespace-nowrap text-xs tabular-nums"><span className="font-medium">{g.done}</span> <span className="text-subtle-foreground">из {g.total}{g.test ? ` · тест ${g.test}` : ""}</span></div>
      <StackBar parts={parts} h={5} className="mt-1" />
      {legend && (
        <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5">
          {parts.filter((p) => p.n).map((p) => <Badge key={p.k} tone={p.tone} className="text-xs">{p.label} {p.n}</Badge>)}
        </div>
      )}
    </div>
  );
}

// ---------- Известная проблема (вариант B): причина и срок из Jira ----------
// known — до срока не дёргаем; long — ждёт продакта; overdue — срок прошёл; nodate — без срока.
export const KNOWN_UI: Record<string, [string, string]> = { known: ["известная до", "info"], long: ["ждёт продакта: срок", "warn"], overdue: ["срок прошёл", "bad"], nodate: ["комментарий без срока", "warn"] };
export const knownSrc = (k: any) => (k.src === "label" ? `метка «${k.label}»${k.onParent ? ` в ${k.key}` : ""}` : k.src === "bot" ? `срок в боте, @${k.login}` : `${k.who}${k.onParent ? ` в ${k.key}` : ""}: «${k.text}»`);
export function KnownLine({ k, full }: { k: any; full?: boolean }) {
  const [label, tone] = KNOWN_UI[k.state] ?? ["известная", "muted"];
  const src = knownSrc(k);
  return (
    <div className={cn("flex min-w-0 gap-2 text-xs", full ? "flex-col" : "mt-0.5 items-baseline")}>
      <Badge tone={tone} className="text-xs">💬 {label}{k.until ? " " + ddm(k.until) : ""}</Badge>
      <span className={cn("min-w-0 text-subtle-foreground", !full && "truncate")} title={src}>{src}</span>
    </div>
  );
}

// ---------- Боковая карточка поверх панели ----------
export function Sheet({ head, foot, onClose, onPrev, onNext, pos, scrollKey, children }: { head: ReactNode; foot?: ReactNode; onClose: () => void; onPrev?: () => void; onNext?: () => void; pos?: string; scrollKey?: string; children: ReactNode }) {
  const fn = useRef({ onClose, onPrev, onNext });
  fn.current = { onClose, onPrev, onNext };
  useEffect(() => {
    const f = (e: KeyboardEvent) => {
      if (e.key === "Escape") return fn.current.onClose();
      const t = e.target as HTMLElement | null;
      if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
      if (e.key === "ArrowLeft") fn.current.onPrev?.();
      if (e.key === "ArrowRight") fn.current.onNext?.();
    };
    window.addEventListener("keydown", f);
    return () => window.removeEventListener("keydown", f);
  }, []);
  const navBtn = "flex size-7 items-center justify-center rounded-md border border-border-hairline text-muted-foreground hover:bg-state-hover hover:text-foreground disabled:opacity-35 disabled:hover:bg-transparent";
  return (
    <div className="absolute inset-0 z-30 flex justify-end">
      <button type="button" aria-label="Закрыть" onClick={onClose} className="absolute inset-0 cursor-default bg-black/55" />
      <div role="dialog" aria-modal className="relative flex h-full w-[min(760px,100%)] flex-col border-l border-border bg-background shadow-[-24px_0_60px_rgba(0,0,0,0.45)]">
        <div className="flex shrink-0 items-center gap-2 border-b border-border-seam px-5 py-2.5">
          <div className="flex min-w-0 flex-1 items-center gap-2">{head}</div>
          {(onPrev || onNext) && (
            <div className="flex shrink-0 items-center gap-1">
              {pos && <span className="mr-1 text-xs tabular-nums text-subtle-foreground">{pos}</span>}
              <button type="button" aria-label="Предыдущий" title="Предыдущий (←)" disabled={!onPrev} onClick={onPrev} className={navBtn}><Icon name="ChevronLeft" className="size-4" /></button>
              <button type="button" aria-label="Следующий" title="Следующий (→)" disabled={!onNext} onClick={onNext} className={navBtn}><Icon name="ChevronRight" className="size-4" /></button>
            </div>
          )}
          <button type="button" onClick={onClose} aria-label="Закрыть" title="Закрыть (Esc)" className={cn(navBtn, "text-[17px] leading-none")}>×</button>
        </div>
        <div key={scrollKey} className="min-h-0 flex-1 overflow-y-auto"><div className="@container px-5 py-4">{children}</div></div>
        {foot && <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-border-seam bg-surface-recessed px-5 py-2.5">{foot}</div>}
      </div>
    </div>
  );
}
/** подпись и значение в карточке */
export function Field({ label, children, className }: { label: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cn("min-w-0", className)}>
      <div className="mb-1 text-[11.5px] font-medium uppercase tracking-wide text-subtle-foreground">{label}</div>
      {children}
    </div>
  );
}
