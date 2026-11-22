// Ответы TG — панель bb: упоминания в Telegram, контекст, 3 варианта ответа, правка, отправка или черновик в Telegram,
// профиль тона и метрика «без правок». Данные и логика — core/core.mjs (через server.ts).
// Стиль: токены темы bb (без dark:), статус = точка + текст.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { definePluginApp, useBbNavigate, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

type Rpc = ReturnType<typeof useRpc<typeof rpcContract>>;
type Item = any;
type View = any;
type Ok = { ok: boolean; message?: string };

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const TONE: Record<string, string> = { good: "bg-emerald-500", info: "bg-sky-500", warn: "bg-amber-500", bad: "bg-red-500", purple: "bg-violet-500", muted: "bg-zinc-400" };
const KIND: Record<string, [string, string]> = {
  mention: ["@упоминание", "info"],
  reply: ["ответ на твоё", "purple"],
  name: ["по имени", "muted"],
  private: ["личка", "good"],
};
const VIA: Record<string, string> = { plugin: "из панели", tg_draft: "через черновик в TG", telegram: "сам в Telegram" };
const pct = (x: number | null | undefined) => (x == null ? "—" : `${Math.round(x * 100)}%`);

function when(iso?: string) {
  if (!iso) return "";
  const d = new Date(iso);
  const now = new Date();
  const hm = d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  if (d.toDateString() === now.toDateString()) return hm;
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return `вчера ${hm}`;
  return `${d.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" })} ${hm}`;
}

function Dot({ tone, className }: { tone: string; className?: string }) {
  return <span aria-hidden className={cn("inline-block size-2 shrink-0 rounded-full", TONE[tone] ?? TONE.muted, className)} />;
}
function Badge({ tone, children }: { tone: string; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs text-muted-foreground">
      <Dot tone={tone} />
      {children}
    </span>
  );
}
function Note({ children, tone = "info" }: { children: ReactNode; tone?: "warn" | "info" | "bad" }) {
  return (
    <div className={cn("mb-4 flex items-start gap-2 rounded-lg px-3 py-2 text-[13px]", tone === "info" ? "bg-surface-recessed" : "bg-surface-attention", tone === "bad" && "text-destructive-text")}>
      <Icon name={tone === "info" ? "Info" : "AlertTriangle"} className="mt-0.5 shrink-0" />
      <div className="min-w-0">{children}</div>
    </div>
  );
}
function Section({ title, right, children }: { title: string; right?: ReactNode; children: ReactNode }) {
  return (
    <section className="mb-6">
      <div className="mb-2 flex items-baseline gap-3">
        <h3 className="text-[13px] font-semibold uppercase tracking-wide text-muted-foreground">{title}</h3>
        <div className="ml-auto">{right}</div>
      </div>
      {children}
    </section>
  );
}
function Metric({ label, value, note }: { label: string; value: ReactNode; note?: ReactNode }) {
  return (
    <div className="min-w-0 rounded-lg border border-border-hairline px-3 py-2.5">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-0.5 text-xl font-semibold tabular-nums">{value}</div>
      {note && <div className="mt-0.5 text-xs text-subtle-foreground">{note}</div>}
    </div>
  );
}
function TextArea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      {...props}
      className={cn(
        "w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 text-[13.5px] leading-relaxed placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        props.className,
      )}
    />
  );
}

// ---------- вход по QR ----------
function Connect({ v, rpc, compact }: { v: View; rpc: Rpc; compact?: boolean }) {
  const lg = v.login ?? {};
  const [pw, setPw] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const run = (p: Promise<Ok>) => p.then((r) => setErr(r.ok ? null : r.message ?? "ошибка"), (e) => setErr(errText(e)));
  const active = ["starting", "qr", "2fa"].includes(lg.state);
  return (
    <div className={cn("rounded-xl border border-border-hairline p-5", compact ? "" : "mx-auto mt-6 max-w-[560px]")}>
      <h3 className="text-[15px] font-semibold">Подключить Telegram</h3>
      <p className="mt-1 text-[13px] text-muted-foreground">
        Сначала: установите telegram-mcp и заполните api_id и api_hash в настройках плагина (bb → Настройки → Плагины → «Ответы TG»), шаги — в README. Плагин подключается отдельным устройством (имя — в настройках). Читает чаты, отправляет только по твоей кнопке. Отключить можно в Telegram: Настройки → Устройства.
      </p>
      {v.auth?.error && !active && <p className="mt-2 text-[13px] text-warning-text">{v.auth.error}</p>}
      {lg.state === "qr" && lg.qr && (
        <div className="mt-4 flex flex-wrap items-center gap-5">
          <img src={lg.qr} alt="QR для входа в Telegram" className="size-[220px] rounded-md bg-white p-2" />
          <ol className="min-w-[200px] flex-1 list-decimal space-y-1 pl-5 text-[13px]">
            <li>Открой Telegram на телефоне</li>
            <li>Настройки → Устройства → Подключить устройство</li>
            <li>Наведи камеру на QR</li>
            <li className="text-muted-foreground">QR обновляется каждые 30 секунд</li>
          </ol>
        </div>
      )}
      {lg.state === "starting" && <p className="mt-4 text-[13px] text-muted-foreground">Готовлю QR…</p>}
      {lg.state === "2fa" && (
        <form
          className="mt-4 flex max-w-[380px] gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (pw) run(rpc.call("login_password", { password: pw }));
            setPw("");
          }}
        >
          <Input type="password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="Облачный пароль Telegram" aria-label="Облачный пароль Telegram" autoFocus />
          <Button type="submit" disabled={!pw}>
            Войти
          </Button>
        </form>
      )}
      {lg.state === "ok" && <p className="mt-4 text-[13px]">Подключено. Ищу упоминания…</p>}
      {(lg.error || err) && <p className="mt-3 text-[13px] text-destructive-text">{lg.error || err}</p>}
      <div className="mt-4 flex gap-2">
        {!active && lg.state !== "ok" && <Button onClick={() => run(rpc.call("login_start", {}))}>{lg.state === "fail" ? "Попробовать снова" : "Показать QR"}</Button>}
        {active && (
          <Button variant="ghost" onClick={() => run(rpc.call("login_cancel", {}))}>
            Отмена
          </Button>
        )}
      </div>
    </div>
  );
}

// ---------- список ----------
function Row({ it, on, onClick }: { it: Item; on: boolean; onClick: () => void }) {
  const [label, tone] = KIND[it.kind] ?? ["", "muted"];
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={on}
      className={cn("block w-full rounded-lg px-3 py-2.5 text-left transition-colors", on ? "bg-state-active" : "hover:bg-state-hover")}
    >
      <div className="flex min-w-0 items-baseline gap-2">
        <span className="truncate text-[13.5px] font-medium">{it.sender}</span>
        <span className="ml-auto shrink-0 text-xs tabular-nums text-subtle-foreground">{when(it.date)}</span>
      </div>
      <div className="truncate text-xs text-muted-foreground">{it.chatType === "private" ? "личные сообщения" : it.chatTitle}</div>
      <div className="mt-1 line-clamp-2 text-[13px] text-foreground/90">{it.text}</div>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
        <Badge tone={tone}>{label}</Badge>
        {it.generating && <Badge tone="warn">готовлю варианты…</Badge>}
        {!it.generating && it.gen?.error && !it.gen?.variants?.length && <Badge tone="bad">нет вариантов</Badge>}
        {it.status === "tg_draft" && <Badge tone="info">черновик в TG</Badge>}
      </div>
    </button>
  );
}

function groupInbox(items: Item[]) {
  const need: Item[] = [];
  const maybe: Item[] = [];
  const skip: Item[] = [];
  for (const it of items) {
    if (it.wroteAfter) maybe.push(it);
    else if (it.gen && it.gen.needsReply === false) skip.push(it);
    else need.push(it);
  }
  return [
    { id: "need", title: "Нужен ответ", list: need },
    { id: "maybe", title: "Ты уже писал после", list: maybe },
    { id: "skip", title: "Можно не отвечать", list: skip },
  ].filter((g) => g.list.length);
}

// ---------- карточка ----------
function Context({ it }: { it: Item }) {
  const rows: any[] = it.context ?? [];
  const hasReplied = it.replied && rows.some((r) => r.text === it.replied.text);
  return (
    <div className="space-y-1.5 rounded-lg bg-surface-recessed px-3 py-2.5">
      {it.replied && !hasReplied && (
        <div className="border-l-2 border-border pl-2 text-xs text-muted-foreground">
          <span className="font-medium">{it.replied.out ? "Ты" : it.replied.sender}:</span> {it.replied.text}
        </div>
      )}
      {rows.length === 0 && <div className="text-[13px]">{it.text}</div>}
      {rows.map((r) => (
        <div key={r.id} className={cn("rounded-md px-2 py-1 text-[13px] leading-relaxed", r.target && "bg-surface-attention")}>
          <span className="mr-1.5 text-xs tabular-nums text-subtle-foreground">{when(r.date)}</span>
          <span className={cn("font-medium", r.out && "text-muted-foreground")}>{r.out ? "Ты" : r.sender}:</span>{" "}
          <span className="whitespace-pre-wrap">{r.target && it.chatType === "private" ? it.text : r.text}</span>
        </div>
      ))}
    </div>
  );
}

function Detail({ it, rpc, onMsg, onNext, chats }: { it: Item; rpc: Rpc; onMsg: (m: string) => void; onNext: () => void; chats: any[] }) {
  const variants: any[] = it.gen?.variants ?? [];
  const initIdx = it.draft ? it.draft.fromIdx : variants.length > 1 ? 1 : variants.length ? 0 : -1;
  const [idx, setIdx] = useState<number>(initIdx);
  const [text, setText] = useState<string>(it.draft?.text ?? (initIdx >= 0 ? variants[initIdx]?.text ?? "" : ""));
  const [hint, setHint] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const touched = useRef(false);
  const genAt = it.gen?.at;

  // новые варианты пришли — подставить, если текст ещё не трогали
  useEffect(() => {
    if (touched.current || it.draft) return;
    const i = variants.length > 1 ? 1 : variants.length ? 0 : -1;
    setIdx(i);
    setText(i >= 0 ? variants[i].text : "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [genAt]);

  const act = async (name: string, p: () => Promise<Ok>, after?: () => void) => {
    setBusy(name);
    setErr(null);
    try {
      const r = await p();
      if (!r.ok) setErr(r.message ?? "ошибка");
      else {
        if (r.message) onMsg(r.message);
        after?.();
      }
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(null);
      setConfirm(false);
    }
  };
  const pick = (i: number) => {
    setIdx(i);
    setText(variants[i].text);
    touched.current = false;
  };
  const edited = idx >= 0 && variants[idx] && text.trim() !== variants[idx].text.trim();
  const [label, tone] = KIND[it.kind] ?? ["", "muted"];
  const closed = !["new", "tg_draft"].includes(it.status);
  void chats;

  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 className="text-[15px] font-semibold">{it.sender}</h3>
        <span className="text-[13px] text-muted-foreground">{it.chatType === "private" ? "личные сообщения" : it.chatTitle}</span>
        <span className="text-xs tabular-nums text-subtle-foreground">{when(it.date)}</span>
        <Badge tone={tone}>{label}</Badge>
        {it.link && (
          <a href={it.link} target="_blank" rel="noreferrer" className="ml-auto text-[13px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
            Открыть в Telegram
          </a>
        )}
      </div>
      {it.gen?.summary && <p className="mt-1.5 text-[13px]"><span className="text-muted-foreground">Что хотят:</span> {it.gen.summary}</p>}

      <div className="mt-3">
        <Context it={it} />
      </div>

      {it.wroteAfter && !closed && (
        <Note tone="warn">
          После этого ты писал в чат ({when(it.wroteAfter.date)}): «{it.wroteAfter.text.slice(0, 220)}». Если это ответ — нажми «Уже ответил», плагин запомнит его как пример.
        </Note>
      )}
      {it.gen?.needsReply === false && !closed && <p className="mt-3 text-[13px] text-muted-foreground">Похоже, ответ не нужен. Варианты всё равно есть.</p>}

      {closed ? (
        <div className="mt-4">
          {it.final ? (
            <>
              <div className="text-xs text-muted-foreground">
                Ответ {VIA[it.final.via] ?? ""} · {when(it.final.at)}
                {it.final.sim != null && <> · совпадение с вариантом {pct(it.final.sim)}</>}
                {it.final.label && <> · {it.final.label}</>}
              </div>
              <div className="mt-1 whitespace-pre-wrap rounded-lg border border-border-hairline px-3 py-2 text-[13.5px]">{it.final.text}</div>
            </>
          ) : (
            <p className="text-[13px] text-muted-foreground">Скрыто{it.doneManually ? " как «уже ответил»" : ""}.</p>
          )}
          {it.status === "dismissed" && (
            <Button variant="outline" size="sm" className="mt-3" onClick={() => void act("restore", () => rpc.call("restore", { key: it.key }))}>
              Вернуть во входящие
            </Button>
          )}
        </div>
      ) : (
        <>
          <div className="mt-4">
            <div className="mb-2 flex items-baseline gap-3">
              <h4 className="text-[13px] font-semibold uppercase tracking-wide text-muted-foreground">Варианты</h4>
              {it.generating && <span className="text-xs text-muted-foreground">готовлю…</span>}
              {it.gen?.error && <span className="text-xs text-destructive-text">{it.gen.error}</span>}
            </div>
            {!variants.length && !it.generating && (
              <Button variant="outline" size="sm" onClick={() => void act("gen", () => rpc.call("generate", { key: it.key }))}>
                Подготовить варианты
              </Button>
            )}
            <div className="grid gap-2 @[720px]:grid-cols-3">
              {variants.map((vr, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => pick(i)}
                  className={cn(
                    "rounded-lg border px-3 py-2 text-left transition-colors",
                    idx === i ? "border-foreground bg-state-active" : "border-border-hairline hover:bg-state-hover",
                  )}
                >
                  <div className="text-xs font-medium text-muted-foreground">{vr.label}</div>
                  <div className="mt-1 whitespace-pre-wrap text-[13px] leading-relaxed">{vr.text}</div>
                </button>
              ))}
            </div>
            <form
              className="mt-2 flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                touched.current = false;
                void act("gen", () => rpc.call("generate", { key: it.key, hint: hint.trim() || undefined }), () => setHint(""));
              }}
            >
              <Input value={hint} onChange={(e) => setHint(e.target.value)} placeholder="Подсказка: «откажи мягко», «скажи, что в понедельник»…" aria-label="Подсказка для новых вариантов" />
              <Button type="submit" variant="outline" disabled={it.generating || busy === "gen"}>
                <Icon name="RotateCcw" /> {hint.trim() ? "По подсказке" : "Ещё варианты"}
              </Button>
            </form>
          </div>

          <div className="mt-4">
            <div className="mb-2 flex items-baseline gap-3">
              <h4 className="text-[13px] font-semibold uppercase tracking-wide text-muted-foreground">Ответ</h4>
              <span className="text-xs text-subtle-foreground">
                {idx >= 0 && variants[idx] ? `из «${variants[idx].label}»${edited ? " · изменён" : ""}` : "свой текст"} · {text.length} зн.
              </span>
            </div>
            <TextArea
              rows={Math.min(10, Math.max(3, text.split("\n").length + 1))}
              value={text}
              onChange={(e) => {
                touched.current = true;
                setText(e.target.value);
                if (!variants.length) setIdx(-1);
              }}
              placeholder="Выбери вариант или напиши свой ответ"
              aria-label="Текст ответа"
            />
            {err && <p className="mt-2 text-[13px] text-destructive-text">{err}</p>}
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {confirm ? (
                <>
                  <span className="text-[13px]">Отправить в «{it.chatType === "private" ? it.sender : it.chatTitle}»?</span>
                  <Button disabled={!!busy} onClick={() => void act("send", () => rpc.call("send", { key: it.key, text, fromIdx: idx }), onNext)}>
                    {busy === "send" ? "Отправляю…" : "Да, отправить"}
                  </Button>
                  <Button variant="ghost" onClick={() => setConfirm(false)}>
                    Отмена
                  </Button>
                </>
              ) : (
                <>
                  <Button disabled={!text.trim() || !!busy} onClick={() => setConfirm(true)}>
                    <Icon name="Check" /> Отправить
                  </Button>
                  <Button variant="outline" disabled={!text.trim() || !!busy} onClick={() => void act("draft", () => rpc.call("draft", { key: it.key, text, fromIdx: idx }))}>
                    {busy === "draft" ? "Кладу…" : it.status === "tg_draft" ? "Обновить черновик в TG" : "Черновик в Telegram"}
                  </Button>
                  <span className="mx-1 h-5 w-px bg-border-hairline" />
                  <Button variant="ghost" size="sm" disabled={!!busy} onClick={() => void act("done", () => rpc.call("done", { key: it.key }), onNext)}>
                    Уже ответил
                  </Button>
                  <Button variant="ghost" size="sm" disabled={!!busy} onClick={() => void act("dismiss", () => rpc.call("dismiss", { key: it.key }), onNext)}>
                    Скрыть
                  </Button>
                  {it.chatType === "group" && (
                    <Button variant="ghost" size="sm" disabled={!!busy} onClick={() => void act("ignore", () => rpc.call("ignore_chat", { chatId: it.chatId, on: true }), onNext)}>
                      Не следить за чатом
                    </Button>
                  )}
                </>
              )}
            </div>
            {it.status === "tg_draft" && (
              <p className="mt-2 text-xs text-muted-foreground">
                Черновик лежит в чате Telegram. Допиши и отправь там — плагин найдёт твой ответ и учтёт правки.
              </p>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function Inbox({ items, rpc, onMsg, chats, grouped, empty }: { items: Item[]; rpc: Rpc; onMsg: (m: string) => void; chats: any[]; grouped?: boolean; empty: string }) {
  const [sel, setSel] = useState<string | null>(null);
  const groups = useMemo(() => (grouped ? groupInbox(items) : [{ id: "all", title: "", list: items }]), [items, grouped]);
  const flat = useMemo(() => groups.flatMap((g) => g.list), [groups]);
  const cur = flat.find((i) => i.key === sel) ?? flat[0] ?? null;
  const next = useCallback(() => {
    const i = flat.findIndex((x) => x.key === cur?.key);
    setSel(flat[i + 1]?.key ?? flat[i - 1]?.key ?? null);
  }, [flat, cur]);
  if (!items.length) return <p className="py-10 text-center text-sm text-muted-foreground">{empty}</p>;
  return (
    <div className="flex min-h-0 flex-col gap-5 @[900px]:flex-row">
      <div className="shrink-0 @[900px]:w-[340px]">
        {groups.map((g) => (
          <div key={g.id} className="mb-3">
            {g.title && (
              <div className="mb-1 px-3 text-xs font-medium text-muted-foreground">
                {g.title} <span className="tabular-nums text-subtle-foreground">{g.list.length}</span>
              </div>
            )}
            <div className="space-y-0.5">
              {g.list.map((it) => (
                <Row key={it.key} it={it} on={cur?.key === it.key} onClick={() => setSel(it.key)} />
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="min-w-0 flex-1 self-start @[900px]:sticky @[900px]:top-0 @[900px]:max-h-[calc(100vh-140px)] @[900px]:overflow-y-auto @[900px]:border-l @[900px]:border-border-seam @[900px]:pl-5">
        {cur && <Detail key={cur.key + ":" + cur.status} it={cur} rpc={rpc} onMsg={onMsg} onNext={next} chats={chats} />}
      </div>
    </div>
  );
}

// ---------- тон и обучение ----------
function ToneTab({ v, rpc, onMsg }: { v: View; rpc: Rpc; onMsg: (m: string) => void }) {
  const p = v.profile ?? {};
  const s = v.stats ?? {};
  const [manual, setManual] = useState<string>(p.manual ?? "");
  const [err, setErr] = useState<string | null>(null);
  const left = Math.max(0, (v.cfg?.rebuildEvery ?? 10) - (p.newExamples ?? 0));
  const maxN = Math.max(1, ...((s.weeks ?? []) as any[]).map((w) => w.n));
  const labels = Object.entries((s.byLabel ?? {}) as Record<string, number>).sort((a, b) => b[1] - a[1]);
  const run = (p2: Promise<Ok>) => p2.then((r) => (r.ok ? (r.message && onMsg(r.message), setErr(null)) : setErr(r.message ?? "ошибка")), (e) => setErr(errText(e)));
  return (
    <div>
      <Section title="Как растёт качество">
        <div className="grid grid-cols-2 gap-2 @[720px]:grid-cols-4">
          <Metric label="Отправлено без правок" value={s.rated ? pct(s.same / s.rated) : "—"} note={s.rated ? `${s.same} из ${s.rated} ответов` : "появится после первых ответов"} />
          <Metric label="Похожесть на вариант" value={pct(s.avgSim)} note="100% — отправил как есть" />
          <Metric label="Ответов через плагин" value={(s.plugin ?? 0) + (s.tgDraft ?? 0)} note={`из панели ${s.plugin ?? 0} · через черновик ${s.tgDraft ?? 0}`} />
          <Metric label="Сам в Telegram" value={s.telegram ?? 0} note={s.tgDirectSim != null ? `близость к лучшему варианту ${pct(s.tgDirectSim)}` : "сравниваю с вариантами"} />
        </div>
        {!!s.weeks?.length && (
          <div className="mt-4">
            <div className="mb-1 text-xs text-muted-foreground">Доля «без правок» по неделям</div>
            <div className="flex h-28 items-end gap-2">
              {s.weeks.map((w: any) => (
                <div key={w.week} className="flex min-w-0 flex-1 flex-col items-center gap-1">
                  <div className="text-[11px] tabular-nums text-muted-foreground">{pct(w.same / w.n)}</div>
                  <div className="flex w-full max-w-[44px] flex-col justify-end rounded-sm bg-surface-recessed" style={{ height: `${20 + (w.n / maxN) * 60}px` }}>
                    <div className="rounded-sm bg-emerald-500" style={{ height: `${(w.same / w.n) * 100}%` }} />
                  </div>
                  <div className="text-[11px] tabular-nums text-subtle-foreground">{w.week.slice(8, 10)}.{w.week.slice(5, 7)}</div>
                </div>
              ))}
            </div>
            <div className="mt-1 text-xs text-subtle-foreground">Высота столбца — число ответов за неделю, зелёное — без правок.</div>
          </div>
        )}
        {!!labels.length && (
          <div className="mt-3 text-[13px] text-muted-foreground">
            Чаще выбираешь: {labels.map(([l, n]) => `${l} — ${n}`).join(" · ")}
          </div>
        )}
      </Section>

      <Section title="Твои правила" right={<span className="text-xs text-subtle-foreground">главнее профиля</span>}>
        <TextArea rows={4} value={manual} onChange={(e) => setManual(e.target.value)} placeholder={"Например:\n— подрядчикам и внешним — на «вы»\n— без «коллеги» и восклицательных знаков"} aria-label="Твои правила для ответов" />
        <Button size="sm" variant="outline" className="mt-2" disabled={manual === (p.manual ?? "")} onClick={() => run(rpc.call("set_manual", { text: manual }))}>
          Сохранить правила
        </Button>
      </Section>

      <Section
        title="Профиль тона"
        right={
          <Button size="sm" variant="ghost" disabled={p.busy} onClick={() => run(rpc.call("build_profile", {}))}>
            <Icon name="RotateCcw" /> {p.busy ? "Собираю… ~1 мин" : "Пересобрать сейчас"}
          </Button>
        }
      >
        <p className="mb-2 text-xs text-muted-foreground">
          {p.version ? `Версия ${p.version} · ${when(p.builtAt)} · по ${p.samplesAtBuild ?? "?"} твоим сообщениям${p.editsAtBuild ? ` и ${p.editsAtBuild} правкам` : ""}` : "Ещё не собран"} · собрано
          сообщений: {p.samples ?? 0} · пересоберётся сам через {left} {left === 1 ? "ответ" : "ответов"}
        </p>
        {(err || p.error) && <p className="mb-2 text-[13px] text-destructive-text">{err || p.error}</p>}
        {p.auto ? (
          <div className="max-h-[420px] overflow-y-auto whitespace-pre-wrap rounded-lg bg-surface-recessed px-4 py-3 text-[13px] leading-relaxed">{p.auto}</div>
        ) : (
          <p className="text-[13px] text-muted-foreground">Профиль соберётся после первого поиска, когда наберётся 30 твоих сообщений.</p>
        )}
      </Section>

      {!!s.lastEdits?.length && (
        <Section title="Что ты правишь">
          <div className="space-y-2">
            {s.lastEdits.map((e: any, i: number) => (
              <div key={i} className="grid gap-2 rounded-lg border border-border-hairline px-3 py-2 @[720px]:grid-cols-2">
                <div>
                  <div className="text-xs text-muted-foreground">
                    Было · {e.chat} · {when(e.at)}
                  </div>
                  <div className="mt-0.5 whitespace-pre-wrap text-[13px] text-muted-foreground line-through decoration-border">{e.suggested}</div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">
                    Отправил · {VIA[e.source] ?? e.source} · {pct(e.sim)}
                  </div>
                  <div className="mt-0.5 whitespace-pre-wrap text-[13px]">{e.final}</div>
                </div>
              </div>
            ))}
          </div>
        </Section>
      )}
    </div>
  );
}

// ---------- настройки ----------
function SettingsTab({ v, rpc, onMsg }: { v: View; rpc: Rpc; onMsg: (m: string) => void }) {
  const c = v.cfg ?? {};
  const [names, setNames] = useState<string>((c.names ?? []).join(", "));
  const [err, setErr] = useState<string | null>(null);
  const set = (patch: any) => rpc.call("set_cfg", patch).then((r) => (r.ok ? (setErr(null), onMsg("Сохранено")) : setErr(r.message ?? "ошибка")), (e) => setErr(errText(e)));
  const ignored: string[] = c.ignoreChats ?? [];
  const title = (id: string) => (v.chats ?? []).find((x: any) => x.id === id)?.title ?? id;
  const rowCls = "flex flex-wrap items-center gap-3 border-b border-border-seam py-3";
  return (
    <div className="max-w-[760px]">
      {err && <Note tone="bad">{err}</Note>}
      <Section title="Что искать">
        <div className={rowCls}>
          <div className="min-w-[220px] flex-1">
            <div className="text-[13.5px]">Глубина поиска</div>
            <div className="text-xs text-muted-foreground">Упоминания не старше N дней</div>
          </div>
          <div className="flex items-center gap-1">
            <Button size="sm" variant="outline" aria-label="Меньше" onClick={() => set({ lookbackDays: (c.lookbackDays ?? 3) - 1 })}>
              −
            </Button>
            <span className="w-16 text-center text-[13.5px] tabular-nums">{c.lookbackDays} дн.</span>
            <Button size="sm" variant="outline" aria-label="Больше" onClick={() => set({ lookbackDays: (c.lookbackDays ?? 3) + 1 })}>
              +
            </Button>
          </div>
        </div>
        <div className={rowCls}>
          <div className="min-w-[220px] flex-1">
            <div className="text-[13.5px]">Имена без @</div>
            <div className="text-xs text-muted-foreground">Через запятую. Бейдж «по имени». Пусто — не искать</div>
          </div>
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void set({ names: names.split(",") });
            }}
          >
            <Input value={names} onChange={(e) => setNames(e.target.value)} className="w-56" aria-label="Имена без @" />
            <Button size="sm" type="submit" variant="outline">
              Сохранить
            </Button>
          </form>
        </div>
        <label className={cn(rowCls, "cursor-pointer")}>
          <div className="min-w-[220px] flex-1">
            <div className="text-[13.5px]">Новые сообщения в личке</div>
            <div className="text-xs text-muted-foreground">Непрочитанные в личных чатах, без ботов</div>
          </div>
          <input type="checkbox" className="size-4 accent-current" checked={!!c.privateChats} onChange={(e) => void set({ privateChats: e.target.checked })} />
        </label>
      </Section>
      <Section title="Варианты и обучение">
        <label className={cn(rowCls, "cursor-pointer")}>
          <div className="min-w-[220px] flex-1">
            <div className="text-[13.5px]">Готовить варианты сразу</div>
            <div className="text-xs text-muted-foreground">После каждого поиска, ~4 с на упоминание</div>
          </div>
          <input type="checkbox" className="size-4 accent-current" checked={!!c.autoGenerate} onChange={(e) => void set({ autoGenerate: e.target.checked })} />
        </label>
        <div className={rowCls}>
          <div className="min-w-[220px] flex-1">
            <div className="text-[13.5px]">Модель</div>
            <div className="text-xs text-muted-foreground">Claude через локальный CLI</div>
          </div>
          <select value={c.model} onChange={(e) => void set({ model: e.target.value })} className="h-8 rounded-md border border-input bg-transparent px-2 text-[13px]" aria-label="Модель">
            <option value="sonnet">Sonnet — быстро</option>
            <option value="opus">Opus — точнее, медленнее</option>
            <option value="haiku">Haiku — быстрее всех</option>
          </select>
        </div>
        <div className={rowCls}>
          <div className="min-w-[220px] flex-1">
            <div className="text-[13.5px]">Пересобирать профиль тона</div>
            <div className="text-xs text-muted-foreground">После N новых ответов</div>
          </div>
          <div className="flex items-center gap-1">
            <Button size="sm" variant="outline" aria-label="Меньше" onClick={() => set({ rebuildEvery: (c.rebuildEvery ?? 10) - 1 })}>
              −
            </Button>
            <span className="w-16 text-center text-[13.5px] tabular-nums">{c.rebuildEvery}</span>
            <Button size="sm" variant="outline" aria-label="Больше" onClick={() => set({ rebuildEvery: (c.rebuildEvery ?? 10) + 1 })}>
              +
            </Button>
          </div>
        </div>
      </Section>
      <Section title="Не следить за чатами">
        {!ignored.length && <p className="text-[13px] text-muted-foreground">Пусто. Добавить — кнопка «Не следить за чатом» в карточке.</p>}
        {ignored.map((id) => (
          <div key={id} className={rowCls}>
            <span className="flex-1 text-[13.5px]">{title(id)}</span>
            <Button size="sm" variant="ghost" onClick={() => void rpc.call("ignore_chat", { chatId: id, on: false })}>
              Вернуть
            </Button>
          </div>
        ))}
      </Section>
      <Section title="Telegram">
        <div className={rowCls}>
          <span className="flex-1 text-[13.5px]">
            {v.auth?.state === "ok" ? <>Подключено: {v.auth.me?.name}{v.auth.me?.username ? ` (@${v.auth.me.username})` : ""}</> : "Не подключено"}
          </span>
          <Button size="sm" variant="ghost" onClick={() => void rpc.call("open_data", {})}>
            <Icon name="FolderOpen" /> Папка данных
          </Button>
        </div>
        {v.auth?.state !== "ok" && <Connect v={v} rpc={rpc} compact />}
      </Section>
    </div>
  );
}

// ---------- панель ----------
function Panel({ subPath }: PluginNavPanelProps) {
  const rpc = useRpc<typeof rpcContract>();
  const nav = useBbNavigate();
  const [v, setV] = useState<View | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const reload = useCallback(() => {
    rpc.call("load", {}).then((r) => {
      setV(r.view);
      setError(null);
    }, (e: unknown) => setError(errText(e)));
  }, [rpc]);
  useEffect(() => {
    reload();
  }, [reload]);
  useRealtime("tg", () => reload());
  useEffect(() => {
    if (!msg) return;
    const t = setTimeout(() => setMsg(null), 8000);
    return () => clearTimeout(t);
  }, [msg]);

  const items: Item[] = v?.items ?? [];
  const inbox = items.filter((i) => i.status === "new");
  const drafts = items.filter((i) => i.status === "tg_draft");
  const done = items.filter((i) => i.status === "sent");
  const hidden = items.filter((i) => i.status === "dismissed");
  const tabs = [
    { id: "inbox", label: "Ответить", n: inbox.length },
    { id: "drafts", label: "Черновики в TG", n: drafts.length },
    { id: "done", label: "Отвечено", n: done.length },
    { id: "hidden", label: "Скрыто", n: hidden.length },
    { id: "tone", label: "Тон и обучение" },
    { id: "settings", label: "Настройки" },
  ];
  const tab = tabs.find((t) => t.id === subPath)?.id ?? "inbox";
  const job = v?.job;
  const ls = v?.lastScan;
  const needAuth = v && v.auth?.state !== "ok" && v.auth?.state !== "unknown";

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="shrink-0 border-b border-border-seam px-5">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 pt-3">
          <div className="min-w-0">
            <h2 className="text-[15px] font-semibold leading-tight tracking-tight">Ответы TG</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {job?.running ? (
                <>Ищу упоминания: {job.log?.[job.log.length - 1] ?? "старт"}</>
              ) : ls ? (
                <>
                  Проверено {when(ls.at)}
                  {ls.error ? <span className="text-destructive-text"> · ошибка: {ls.error}</span> : <> · новых {ls.found}</>} · по будням 10–18 каждые 15 минут
                </>
              ) : (
                "Ещё не проверял"
              )}
            </p>
          </div>
          <div className="ml-auto flex items-center gap-1">
            <Button variant="ghost" size="sm" disabled={!!job?.running || !!needAuth} onClick={() => void rpc.call("refresh", {}).then(reload)} aria-label="Найти упоминания сейчас">
              <Icon name="RotateCcw" /> {job?.running ? "Ищу…" : "Обновить"}
            </Button>
          </div>
        </div>
        <nav role="tablist" className="mt-1.5 flex flex-wrap gap-x-5">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => nav.toPluginPanel("tg-mentions", { subPath: t.id })}
              className={cn("-mb-px border-b-2 pb-2 pt-1.5 text-sm transition-colors", tab === t.id ? "border-foreground font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}
            >
              {t.label}
              {t.n != null && t.n > 0 && <span className="ml-1.5 tabular-nums text-subtle-foreground">{t.n}</span>}
            </button>
          ))}
        </nav>
      </header>
      <main className="min-h-0 flex-1 overflow-y-auto">
        <div className="@container mx-auto w-full max-w-[1280px] px-5 py-5">
          {msg && <Note>{msg}</Note>}
          {error && <Note tone="bad">{error}</Note>}
          {!v && !error && <p className="text-sm text-muted-foreground">Загружаю…</p>}
          {v && needAuth && tab !== "settings" && <Connect v={v} rpc={rpc} />}
          {v && !needAuth && tab === "inbox" && <Inbox items={inbox} rpc={rpc} onMsg={setMsg} chats={v.chats} grouped empty={job?.running ? "Ищу упоминания…" : "Новых упоминаний нет."} />}
          {v && !needAuth && tab === "drafts" && <Inbox items={drafts} rpc={rpc} onMsg={setMsg} chats={v.chats} empty="Черновиков в Telegram нет." />}
          {v && tab === "done" && <Inbox items={done} rpc={rpc} onMsg={setMsg} chats={v.chats} empty="Пока нет отвеченных." />}
          {v && tab === "hidden" && <Inbox items={hidden} rpc={rpc} onMsg={setMsg} chats={v.chats} empty="Скрытых нет." />}
          {v && tab === "tone" && <ToneTab v={v} rpc={rpc} onMsg={setMsg} />}
          {v && tab === "settings" && <SettingsTab v={v} rpc={rpc} onMsg={setMsg} />}
        </div>
      </main>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "tg-mentions",
    title: "Ответы TG",
    icon: "MessageSquare",
    path: "tg-mentions",
    component: Panel,
  });
});
