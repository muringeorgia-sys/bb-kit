// Релизы — «Бот» (что происходит в Telegram: вопросы продактам, что видят ПМ, журнал «Решено»)
// и «Настройки» (доступы, известные проблемы, рассылка, как считаем).
/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Badge, Card, Chip, Dot, Empty, GROUP_TONE, Head, Hint, Key, Num, PRODUCTS0, dt, errText, inputCls, prodName, projOf, type Act, type Rpc, type View } from "./ui";

const ANS_LABEL: Record<string, string> = { ok: "успеваем", mv: "переносим", no: "отменяем", talk: "обсудить" };
const askAnswer = (x: any) => (x.answer?.opt === "mv" ? `переносим в ${x.nx}` : ANS_LABEL[x.answer?.opt] ?? "");
const CLAIM: Record<string, [string, string]> = { linked: ["нашёл комментарий в Jira", "info"], known: ["срок в боте", "info"], pending: ["ждёт проверки", "warn"], confirmed: ["подтверждено", "good"], failed: ["не решено", "bad"], accepted: ["скрыто по комментарию", "info"], reopened: ["вернулось через неделю", "bad"] };
export const openAsks = (d: any): any[] => ((d?.panel?.asks ?? []) as any[]).filter((x) => x.status !== "answered");
function BotStatus({ bot }: { bot: any }) {
  return bot.running && !bot.error ? <Badge tone="good">слушает · {dt(bot.lastOk)}</Badge> : <Badge tone="bad">{bot.error ? `ошибка: ${bot.error}` : "не запущен"}</Badge>;
}
function Stat({ label, value, tone, note }: { label: string; value: ReactNode; tone?: string; note?: ReactNode }) {
  return (
    <Card className="px-3.5 py-3">
      <div className="flex items-center gap-2 text-[12.5px] text-muted-foreground">{tone && <Dot tone={tone} />}<span className="truncate">{label}</span></div>
      <div className="mt-1 text-[24px] font-semibold leading-none tabular-nums tracking-tight">{value}</div>
      {note && <div className="mt-1.5 truncate text-xs text-subtle-foreground">{note}</div>}
    </Card>
  );
}
const th = "py-1.5 pr-3 font-normal";

// ---------- Бот ----------
export function BotTab({ d, goSettings }: { d: any; goSettings: () => void }) {
  const [filter, setFilter] = useState<string>("all");
  if (!d) return <p className="text-sm text-muted-foreground">…</p>;
  const p = d.panel, bot = d.bot;
  const all = p.claims as any[];
  const claims = all.filter((c) => filter === "all" || c.status === filter);
  const cnt = (s: string) => all.filter((c) => c.status === s).length;
  const asks = (p.asks ?? []) as any[];
  const waiting = asks.filter((x) => x.status !== "answered").length;
  const sum = (k: string) => (p.rels as any[]).reduce((s, r) => s + (r[k] ?? 0), 0);
  const pmOn = (p.pms as any[]).filter((m) => !m.off && m.chat).length, poOn = ((p.pos ?? []) as any[]).filter((m) => !m.off && m.chat).length;
  return (
    <div className="space-y-7 text-[13px]">
      <div>
        <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="text-muted-foreground">Бот · {prodName(p.product)}</span>
          <BotStatus bot={bot} />
          <span className="text-subtle-foreground">· в боте: ПМ {pmOn}, продактов {poOn}</span>
          <button type="button" onClick={goSettings} className="ml-auto rounded px-1 text-[12.5px] text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-foreground">Доступы и настройки</button>
        </div>
        <div className="grid grid-cols-2 gap-2 @3xl:grid-cols-4">
          <Stat label="Вопросы продактам ждут ответа" value={waiting} tone={waiting ? "warn" : "muted"} note={`всего вопросов ${asks.length}`} />
          <Stat label="Открыто у ПМ" value={sum("open")} tone="info" note="проблемы задач разработки и их эпиков" />
          <Stat label="«Решено» ждёт проверки" value={sum("pending")} tone={sum("pending") ? "warn" : "muted"} note="проверка — при обновлении из Jira" />
          <Stat label="Не подтвердилось" value={sum("failed")} tone={sum("failed") ? "bad" : "muted"} note={`известные проблемы: ${sum("known") + sum("quiet")}`} />
        </div>
      </div>

      <section>
        <Head n={asks.length}>Вопросы продактам</Head>
        <Hint>ПМ жмёт «Решение продакта» — карточка уходит продактам этого продукта. Бот спрашивает сам, если срок особого случая дальше лимита или прошёл. «Успеваем» убирает карточку из шагов ПМ, остальные ответы ставят её первой. Вопрос закрывается сам, когда проблема исчезла в Jira.</Hint>
        {asks.length === 0 ? <Empty>Вопросов нет.</Empty> : (
          <div className="overflow-x-auto">
            <table className="w-full text-[12.5px]">
              <thead><tr className="border-b border-border-seam text-left text-xs text-subtle-foreground"><th className={th}>Когда</th><th className={th}>ПМ</th><th className={th}>Задача</th><th className={th}>Проблема</th><th className="py-1.5 font-normal">Ответ</th></tr></thead>
              <tbody>
                {asks.map((x: any) => (
                  <tr key={x.id} className="border-b border-border-hairline align-top">
                    <td className="whitespace-nowrap py-1.5 pr-3 tabular-nums text-muted-foreground">{dt(x.at)}</td>
                    <td className="py-1.5 pr-3 font-mono text-[12px]">@{x.by}</td>
                    <td className="py-1.5 pr-3">{x.key ? <Key k={x.key} url={x.url} /> : "—"}</td>
                    <td className="py-1.5 pr-3">{x.label}</td>
                    <td className="py-1.5">{x.status === "answered" ? <Badge tone="good" className="whitespace-normal">@{x.answer.by}: {askAnswer(x)} · {dt(x.answer.at)}</Badge> : <Badge tone="warn">ждёт ответа</Badge>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section>
        <Head>Что видят ПМ сейчас</Head>
        {p.rels.length === 0 ? <Empty>Проблем по задачам разработки нет.</Empty> : (
          <div className="overflow-x-auto">
            <table className="w-full max-w-2xl text-[12.5px]">
              <thead><tr className="border-b border-border-seam text-left text-xs text-subtle-foreground"><th className={th}>Релиз</th><th className={cn(th, "text-right")}>Открыто</th><th className={cn(th, "text-right")}>Ждут проверки</th><th className={cn(th, "text-right")}>Не подтвердились</th><th className="py-1.5 text-right font-normal">Известные</th></tr></thead>
              <tbody>
                {p.rels.map((r: any) => (
                  <tr key={r.date} className="border-b border-border-hairline">
                    <td className="py-1.5 pr-3">{r.label}</td>
                    <td className="py-1.5 pr-3 text-right font-medium tabular-nums">{r.open}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">{r.pending}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">{r.failed}</td>
                    <td className="py-1.5 text-right tabular-nums">{(r.known ?? 0) + (r.quiet ?? 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section>
        <Head n={all.length}>Журнал «Решено»</Head>
        <Hint>После каждого обновления из Jira заявка проверяется: проблемы нет — подтверждено, осталась — не решено (кто отметил, получает итог в Telegram). Особый случай ПМ описывает в задаче Jira и жмёт «Написал в Jira»: бот находит комментарий со сроком и считает проблему известной до срока. Старые комментарии в боте (до 19.11) работают до своего срока. Обновление — будни 10:00 и через 3 минуты после последней отметки.</Hint>
        <div className="mb-2 flex flex-wrap gap-x-1 gap-y-0.5">
          <Chip on={filter === "all"} onClick={() => setFilter("all")}>Все <Num>{all.length}</Num></Chip>
          {Object.entries(CLAIM).filter(([k]) => cnt(k) > 0 || filter === k).map(([k, [label, tone]]) => <Chip key={k} on={filter === k} onClick={() => setFilter(filter === k ? "all" : k)}><Dot tone={tone} />{label} <Num>{cnt(k)}</Num></Chip>)}
        </div>
        {claims.length === 0 ? <Empty>Записей нет.</Empty> : (
          <div className="overflow-x-auto">
            <table className="w-full text-[12.5px]">
              <thead><tr className="border-b border-border-seam text-left text-xs text-subtle-foreground"><th className={th}>Когда</th><th className={th}>Кто</th><th className={th}>Задача</th><th className={th}>Проблема</th><th className={th}>Релиз</th><th className="py-1.5 font-normal">Проверка</th></tr></thead>
              <tbody>
                {claims.map((c: any) => (
                  <tr key={c.id} className="border-b border-border-hairline align-top">
                    <td className="whitespace-nowrap py-1.5 pr-3 tabular-nums text-muted-foreground">{dt(c.at)}</td>
                    <td className="py-1.5 pr-3 font-mono text-[12px]">@{c.by}</td>
                    <td className="py-1.5 pr-3">{c.key ? <Key k={c.key} url={c.url} /> : "—"}</td>
                    <td className="py-1.5 pr-3"><div>{c.label}</div><div className="text-muted-foreground">{c.text}</div>{c.comment && <div className="mt-0.5">💬 «{c.comment}»</div>}{c.verdict?.why && <div className="text-subtle-foreground">{c.verdict.by}: {c.verdict.why}</div>}</td>
                    <td className="whitespace-nowrap py-1.5 pr-3 tabular-nums">{c.rel ? c.rel.slice(8, 10) + "." + c.rel.slice(5, 7) : ""}</td>
                    <td className="whitespace-nowrap py-1.5"><Badge tone={CLAIM[c.status]?.[1] ?? "muted"}>{CLAIM[c.status]?.[0] ?? c.status}{c.status === "accepted" && c.until ? ` до ${dt(c.until).slice(0, 5)}` : c.checkedAt ? ` · ${dt(c.checkedAt)}` : ""}</Badge>{c.tries > 1 && <div className="text-subtle-foreground">попытка {c.tries}</div>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

// ---------- Доступы ----------
type AddKind = "pm_add" | "po_add";
// Продукты логина: чипы-переключатели. Пусто — человек в боте, но без продукта (бот попросит PO отметить продукт).
function ProdChips({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  return (
    <div className="flex flex-wrap gap-1" role="group" aria-label="Продукты">
      {PRODUCTS0.map((p) => {
        const on = value.includes(p.id);
        return (
          <button key={p.id} type="button" aria-pressed={on} onClick={() => onChange(on ? value.filter((x) => x !== p.id) : PRODUCTS0.map((x) => x.id).filter((x) => x === p.id || value.includes(x)))}
            className={cn("whitespace-nowrap rounded-md border px-1.5 py-0.5 text-[12px] transition-colors", on ? "border-foreground/40 bg-state-active font-medium text-foreground" : "border-dashed border-border text-subtle-foreground hover:text-foreground")}>
            {on ? "✓ " : ""}{p.emoji} {p.short}
          </button>
        );
      })}
    </div>
  );
}
// Имя в Jira — как автор комментария. По нему бот находит причину и срок особого случая. Сохраняется при выходе из поля или Enter.
function JiraName({ value, onSave, login }: { value: string; login: string; onSave: (v: string) => void }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  const save = () => { if (v.trim() !== value) onSave(v.trim()); };
  return (
    <input className={cn(inputCls, "w-full max-w-[230px] bg-background py-0.5 text-[12px]")} placeholder="имя в Jira — бот запомнит сам" title="Имя автора комментариев в Jira. Пусто — бот запомнит после «📝 Написал в Jira»" value={v} aria-label={`Имя в Jira: @${login}`}
      onChange={(e) => setV(e.target.value)} onBlur={save} onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
  );
}
function AccessList({ title, hint, list, kind, onAct, rpc, lockOf }: { title: string; hint: string; list: any[]; kind: AddKind; rpc: Rpc; onAct: Act; lockOf?: (m: any) => ReactNode }) {
  const [login, setLogin] = useState("");
  const remove = kind === "pm_add" ? "pm_remove" : "po_remove";
  const listKind = kind === "pm_add" ? "pms" : "pos";
  const nOff = list.filter((m: any) => m.off).length;
  return (
    <Card className="min-w-0 p-4">
      <Head n={<>{list.length - nOff}{nOff > 0 && <span> · отключено {nOff}</span>}</>}>{title}</Head>
      <p className="mb-3 text-[12.5px] text-muted-foreground">{hint}</p>
      <form className="mb-3 flex gap-2" onSubmit={(e) => { e.preventDefault(); if (login.trim()) void onAct(() => rpc.call(kind, { login })).then(() => setLogin("")); }}>
        <input className={cn(inputCls, "w-48 bg-background")} placeholder="@логин" value={login} onChange={(e) => setLogin(e.target.value)} aria-label={`Логин Telegram: ${title}`} />
        <Button size="sm" type="submit" disabled={!login.trim()}>Дать доступ</Button>
      </form>
      {list.length === 0 ? <p className="text-muted-foreground">Пока никого.</p> : (
        <ul className="divide-y divide-border-hairline">
          {list.map((m: any) => (
            <li key={m.login} className={cn("py-2.5", m.off && "opacity-60")}>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="font-mono text-[12.5px] font-medium">@{m.login}</span>
                {m.off ? <Badge tone="bad">доступ отключён · {dt(m.off.at).slice(0, 5)}</Badge> : m.chat ? <Badge tone="good">в боте · был {dt(m.chat.lastAt)}</Badge> : <Badge tone="muted">ещё не писал боту</Badge>}
                <div className="ml-auto flex gap-1">
                  {m.off ? (
                    <>
                      <Button size="sm" variant="outline" onClick={() => void onAct(() => rpc.call("access_off", { kind: listKind, login: m.login, off: false }))}>Вернуть доступ</Button>
                      <span title="Удалить логин из списка насовсем: продукты и имя в Jira пропадут"><Button size="sm" variant="ghost" onClick={() => void onAct(() => rpc.call(remove, { login: m.login }))}>Удалить</Button></span>
                    </>
                  ) : (
                    <span title="Логин, продукты и имя в Jira останутся — вернуть можно одной кнопкой"><Button size="sm" variant="ghost" onClick={() => void onAct(() => rpc.call("access_off", { kind: listKind, login: m.login, off: true }))}>Забрать доступ</Button></span>
                  )}
                </div>
              </div>
              {lockOf?.(m)}
              <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1.5">
                <ProdChips value={m.products ?? [PRODUCTS0[0].id]} onChange={(products) => void onAct(() => rpc.call("access_products", { kind: listKind, login: m.login, products }))} />
                <JiraName login={m.login} value={m.jira ?? ""} onSave={(name) => void onAct(() => rpc.call("access_jira", { login: m.login, name }))} />
              </div>
              {(m.products ?? [PRODUCTS0[0].id]).length === 0 && <div className="mt-1 text-xs text-warning-text">нет продукта — меню бота пустое</div>}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
function AccessSec({ d, rpc, act }: { d: any; rpc: Rpc; act: Act }) {
  if (!d) return <p className="text-sm text-muted-foreground">…</p>;
  const p = d.panel, bot = d.bot;
  return (
    <div className="text-[13px]">
      <Head right={<BotStatus bot={bot} />}>Доступы к Telegram-боту</Head>
      <p className="mb-2 max-w-3xl text-muted-foreground">Впишите логин Telegram и отметьте продукты кнопками в строке. Бот отвечает, пока открыт bb.</p>
      <Hint title="Подробнее о доступах">Впишите логин Telegram — доступ выдаётся к продукту, выбранному в шапке. Продукты у логина отмечайте кнопками в строке: один продукт — бот сразу показывает его, несколько — сначала спрашивает продукт. В 10:00 каждый получает сводку по каждому своему продукту. Один логин может быть в обоих списках. Забрали доступ — меню исчезнет при следующем сообщении боту. Бот отвечает, пока открыт bb.</Hint>
      <div className="grid gap-4 @4xl:grid-cols-2">
        <AccessList title="Проджект-менеджеры" kind="pm_add" rpc={rpc} onAct={act} list={p.pms}
          hint="«Полный отчёт» и «Решать по шагам»: проблемы задач разработки и их эпиков. На карточке — «Исправил в Jira», «Написал в Jira» (особый случай), «Решение продакта»."
          lockOf={(m) => m.lock ? <div className="mt-1 text-xs text-muted-foreground">разбирает <span className="font-mono text-foreground">{m.lock.key || "—"}</span> · {m.lock.label} · с {dt(m.lock.at).slice(-5)}</div> : null} />
        <AccessList title="Продакты" kind="po_add" rpc={rpc} onAct={act} list={p.pos ?? []}
          hint="«Ждут моего решения», «Мои эпики», «Готовность релиза». Вопрос ПМ приходит продактам его продукта, засчитывается первый ответ." />
      </div>
      {p.denied.length > 0 && (
        <Card className="mt-4 p-4">
          <Head n={p.denied.length}>Писали боту без доступа</Head>
          <ul className="divide-y divide-border-hairline">
            {p.denied.map((x: any) => (
              <li key={(x.login || x.name) + x.at} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-1.5">
                <span className="font-mono text-[12.5px]">{x.login ? "@" + x.login : x.name || "без логина"}</span>
                <span className="text-xs text-subtle-foreground">{dt(x.at)}</span>
                {x.login && (
                  <span className="ml-auto flex gap-1">
                    <Button size="sm" variant="ghost" onClick={() => void act(() => rpc.call("pm_add", { login: x.login }))}>Дать: ПМ</Button>
                    <Button size="sm" variant="ghost" onClick={() => void act(() => rpc.call("po_add", { login: x.login }))}>Дать: продакт</Button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

// ---------- Известные проблемы: метки Jira для повторяющихся случаев и самый длинный срок, который ПМ ставит сам ----------
type KLabel = { label: string; mode: "days" | "next"; days?: number };
function KnownSec({ cfg, rpc, onAct }: { cfg: { maxDays: number; labels: KLabel[] } | null; rpc: Rpc; onAct: Act }) {
  const [max, setMax] = useState(String(cfg?.maxDays ?? 14));
  const [labels, setLabels] = useState<KLabel[]>(cfg?.labels ?? []);
  useEffect(() => { setMax(String(cfg?.maxDays ?? 14)); setLabels(cfg?.labels ?? []); }, [cfg]);
  const maxN = Number(max), maxOk = Number.isInteger(maxN) && maxN >= 1 && maxN <= 60;
  const daysOk = labels.every((l) => l.mode === "next" || (Number.isInteger(Number(l.days)) && Number(l.days) >= 1 && Number(l.days) <= 60));
  const dirty = JSON.stringify({ m: maxN, labels }) !== JSON.stringify({ m: cfg?.maxDays, labels: cfg?.labels });
  const upd = (i: number, x: Partial<KLabel>) => setLabels(labels.map((l, j) => (j === i ? { ...l, ...x } : l)));
  return (
    <div className="text-[13px]">
      <Head>Известные проблемы</Head>
      <p className="mb-4 max-w-3xl text-muted-foreground">Особый случай ПМ описывает в задаче Jira: причина и срок «до ДД.ММ» комментарием или метка. До срока проблема остаётся в отчёте, но в шагах ПМ и в алертах продакта её нет. Комментарий в родителе или эпике действует на все хвосты его задач. Срок прошёл — карточка первой у ПМ и вопрос продакту.</p>
      <Card className="max-w-3xl p-4">
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <label htmlFor="known-max">Самый длинный срок, который ПМ ставит сам</label>
          <input id="known-max" type="number" min={1} max={60} className={cn(inputCls, "w-20 bg-background", !maxOk && "border-red-500")} value={max} onChange={(e) => setMax(e.target.value)} />
          <span className="text-subtle-foreground">дней · дальше — вопрос продакту</span>
        </div>
        <table className="mb-2 text-[12.5px]">
          <thead><tr className="text-left text-xs text-subtle-foreground"><th className="pb-1 pr-3 font-normal">Метка в Jira</th><th className="pb-1 pr-3 font-normal">Норма после релиза</th><th /></tr></thead>
          <tbody>
            {labels.map((l, i) => (
              <tr key={i}>
                <td className="py-1 pr-3"><input className={cn(inputCls, "w-44 bg-background font-mono")} value={l.label} aria-label="Метка в Jira" onChange={(e) => upd(i, { label: e.target.value })} /></td>
                <td className="py-1 pr-3">
                  <select className={cn(inputCls, "mr-2 bg-background")} value={l.mode} aria-label="Норма" onChange={(e) => upd(i, { mode: e.target.value as KLabel["mode"], days: e.target.value === "days" ? l.days ?? 7 : undefined })}>
                    <option value="days">дней после релиза</option>
                    <option value="next">до следующего релиза</option>
                  </select>
                  {l.mode === "days" && <input type="number" min={1} max={60} className={cn(inputCls, "w-16 bg-background")} value={l.days ?? 7} aria-label="Дней после релиза" onChange={(e) => upd(i, { days: Number(e.target.value) })} />}
                </td>
                <td className="py-1"><Button size="sm" variant="ghost" onClick={() => setLabels(labels.filter((_, j) => j !== i))}>Убрать</Button></td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="ghost" onClick={() => setLabels([...labels, { label: "", mode: "days", days: 7 }])}>+ метка</Button>
          <Button size="sm" disabled={!dirty || !maxOk || !daysOk} onClick={() => void onAct(() => rpc.call("known_cfg", { maxDays: maxN, labels: labels.map((l) => (l.mode === "next" ? { label: l.label, mode: "next" as const } : { label: l.label, mode: "days" as const, days: Number(l.days) || 7 })) }))}>Сохранить</Button>
          {!maxOk && <span className="text-warning-text">срок — целое число от 1 до 60</span>}
          {maxOk && !daysOk && <span className="text-warning-text">дни у метки — от 1 до 60</span>}
        </div>
      </Card>
    </div>
  );
}

// ---------- Telegram: рассылка, импорт правок, где лежит ----------
function TelegramSec({ v, rpc, reload, onMsg }: { v: View; rpc: Rpc; reload: () => void; onMsg: (m: string) => void }) {
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [plan, setPlan] = useState<{ login: string | null; product: string; chars: number }[] | null>(null);
  useEffect(() => { rpc.call("telegram_plan", {}).then((r) => setPlan(r.list), () => setPlan(null)); }, [rpc]);
  const planBy = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const x of plan ?? []) { const k = x.login ? "@" + x.login : "чат сводки"; m.set(k, [...(m.get(k) ?? []), x.product]); }
    return [...m.entries()];
  }, [plan]);
  const run = async (fn: () => Promise<{ ok: boolean; message?: string }>) => {
    setBusy(true);
    try { const r = await fn(); onMsg((r.ok ? "" : "Ошибка: ") + (r.message ?? "Готово")); reload(); } catch (e) { onMsg(errText(e)); } finally { setBusy(false); }
  };
  const tg = v.tg;
  const dtc = "text-subtle-foreground", ddc = "min-w-0";
  return (
    <div className="max-w-3xl space-y-5 text-[13px]">
      <div>
        <Head>Рассылка в Telegram</Head>
        <Card className="p-4">
          <dl className="grid grid-cols-[150px_minmax(0,1fr)] gap-x-3 gap-y-2">
            <dt className={dtc}>Бот</dt><dd className={ddc}>Telegram-бот · токен {tg.tokenSet ? "сохранён" : <span className="text-destructive-text">не задан (настройки плагина → «Токен Telegram-бота»)</span>}</dd>
            <dt className={dtc}>Чат</dt><dd className={ddc}>{tg.chatId ? tg.chatTitle : <span className="text-warning-text">не выбран — напишите боту /start и нажмите «Найти чат»</span>}</dd>
            <dt className={dtc}>Расписание</dt><dd className={ddc}>будни 10:00: обновить из Jira все продукты и разослать сводки — каждому ПМ и продакту по сообщению на каждый его продукт (раздел «Доступы»). Если bb был закрыт — при запуске, до 18:00</dd>
            <dt className={dtc}>Последняя отправка</dt><dd className={ddc}>{tg.lastSent ? `${dt(tg.lastSent.at)} · ${tg.lastSent.by}${tg.lastSent.messages != null ? ` · сообщений: ${tg.lastSent.messages}` : ""}` : "—"}</dd>
            <dt className={dtc}>Кто получит в 10:00</dt>
            <dd className={ddc}>{plan == null ? "…" : planBy.length === 0 ? <span className="text-warning-text">никто: ни один логин из «Доступов» ещё не писал боту</span> : (
              <ul className="space-y-0.5">{planBy.map(([who, ps]) => <li key={who}><span className="font-mono text-[12.5px]">{who}</span> — {ps.map(prodName).join(", ")}</li>)}</ul>
            )}</dd>
          </dl>
          <div className="mt-4 flex flex-wrap gap-2 border-t border-border-hairline pt-3">
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(() => rpc.call("telegram_detect", {}))}>Найти чат</Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void rpc.call("telegram_preview", {}).then((r) => setPreview(r.text))}>Показать текст · {v.productShort ?? ""}</Button>
            <Button size="sm" variant="outline" disabled={busy || !tg.chatId} onClick={() => void run(() => rpc.call("telegram_send", {}))}>Отправить мне · {v.productShort ?? ""}</Button>
            <Button size="sm" disabled={busy || !planBy.length} onClick={() => void run(() => rpc.call("telegram_send", { all: true }))}>Разослать всем сейчас</Button>
          </div>
        </Card>
        {preview && <pre className="mt-3 max-h-[480px] overflow-auto whitespace-pre-wrap rounded-lg bg-surface-recessed p-3 text-[12.5px]">{preview.replace(/<a href="[^"]*">/g, "").replace(/<\/?[abi]>/g, "")}</pre>}
      </div>
      <div>
        <Head right={<Button size="sm" variant="ghost" onClick={() => void rpc.call("open_folder", {})}>Открыть папку</Button>}>Где лежит</Head>
        <ul className="list-disc space-y-0.5 pl-5 text-muted-foreground">
          <li>Данные, ваши правки, журнал записи в Jira и отправок: <span className="font-mono text-xs">{v.outDir}</span></li>
          <li>Логика: <span className="font-mono text-xs">core/core.mjs</span> в папке плагина, запуск без bb — <span className="font-mono text-xs">node core/run.mjs refresh | telegram</span></li>
        </ul>
      </div>
    </div>
  );
}

// ---------- Как считаем ----------
function HowSec({ v }: { v: View }) {
  const codes = Object.entries(v.meta.codes as Record<string, { group: string; label: string }>);
  return (
    <div className="max-w-3xl space-y-5 text-[13px] leading-relaxed">
      <section>
        <Head>Релизы</Head>
        <ul className="list-disc space-y-1 pl-5">
          <li>Продукты — из настроек плагина, в одних проектах Jira. Продукт задаёт версия «{v.productName ?? "<продукт>"} ДД/ММ/ГГГГ» в проектах {[projOf(v).epic, projOf(v).dev, projOf(v).design, projOf(v).qa].filter(Boolean).join(", ") || "из настроек"} и поле эпика «Продукт». Эпик с версиями двух продуктов виден в обоих. Задача разработки относится к продукту, если у неё нет релиза или есть релиз этого продукта.</li>
          <li>Прошлый релиз — последний до сегодня, текущий — ближайший, следующий — за ним. Календарь спринтов общий для всех продуктов.</li>
          <li>Ваши правки (итог, причина, скрытые кейсы, даты спринта) — свои у каждого продукта.</li>
          <li>Старт спринта — день после прошлого релиза. Меняется на экране релиза: «Спринт … изменить».</li>
          <li>План — релиз стоял в эпике в конце первого дня спринта; добавлен — позже; снят до старта — «Сняли до старта» на экране релиза.</li>
          <li>Итог прошлого: «Сделано» — эпик в «Готово к выпуску» / «Выпущено» или все задачи разработки готовы; «Разработано, не протестировано» — все задачи в тесте или готовы.</li>
          <li>Прогноз текущего — баллы: дизайн не готов +3, требования или QA-анализ не готовы +3, нет задач разработки +2, ни одна не начата +2, часть не начата +1, On Hold +1, Kickback +1, дизайн появился в спринте +1. 3+ — не успеет, 2 — высокий риск, 1 — под риском, 0 — успевает.</li>
          <li>Следующий — стадия эпика: требования, QA-анализ, дизайн, готов к разработке.</li>
          <li>Выручка фич — ожидаемая, тыс./мес, если в папке данных есть rev.json (rev-&lt;id&gt;.json для других продуктов): {"{"}"КЛЮЧ-ЭПИКА": число{"}"}. «Под угрозой» — выручка эпиков с прогнозом «Не успеет».</li>
        </ul>
      </section>
      <section>
        <Head>Кейсы вне нормы</Head>
        <table className="w-full text-[12.5px]">
          <tbody>
            {Object.entries(v.meta.groups as Record<string, string>).map(([g, title]) => (
              <tr key={g} className="border-b border-border-hairline align-top">
                <td className="w-[190px] py-1.5 pr-3 font-medium"><Badge tone={GROUP_TONE[g]}>{title}</Badge></td>
                <td className="py-1.5">{codes.filter(([, c]) => c.group === g).map(([, c]) => c.label).join(" · ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-muted-foreground">
          <li>Хвосты — все прошедшие версии; остальное — текущий релиз. Следующий проверяется за {v.meta.designWarnDays} дней до старта его спринта.</li>
          <li>Нет движения — задача разработки в работе или тесте без смены статуса {v.meta.stuckDays}+ рабочих дня.</li>
          <li>«Скрыть» убирает кейс из панели и Telegram, пока он не исчезнет сам. «Новый» — кейса не было во вчерашнем срезе.</li>
          <li>Фикс багов и техдолг не проверяются на требования и дизайн.</li>
          <li>Релиз прошёл — у задачи должен быть конечный статус: Done, перенос в другой релиз или «Отменено». «Ready to release» после даты релиза — хвост.</li>
          <li>Релиз задачи позже релиза эпика (эпик 11.11, задача 25.11) — ошибка: перенести эпик, вернуть задачу или перенести её в эпик второй версии. Задача раньше эпика — норма.</li>
        </ul>
      </section>
    </div>
  );
}

// ---------- Настройки ----------
export type SetSec = "pm" | "known" | "tg" | "how";
export const SET_SECS: { id: SetSec; label: string }[] = [{ id: "pm", label: "Доступы" }, { id: "known", label: "Известные проблемы" }, { id: "tg", label: "Telegram" }, { id: "how", label: "Как считаем" }];
export function SettingsTab({ v, d, sec, setSec, rpc, act, reload, onMsg }: { v: View; d: any; sec: SetSec; setSec: (s: SetSec) => void; rpc: Rpc; act: Act; reload: () => void; onMsg: (m: string) => void }) {
  return (
    <div className="grid gap-x-8 gap-y-4 @4xl:grid-cols-[180px_minmax(0,1fr)]">
      <nav aria-label="Разделы настроек" className="flex flex-wrap gap-1 @4xl:flex-col @4xl:flex-nowrap">
        {SET_SECS.map((s) => (
          <button key={s.id} type="button" aria-current={sec === s.id ? "page" : undefined} onClick={() => setSec(s.id)}
            className={cn("rounded-md px-2.5 py-1.5 text-left text-[13px] transition-colors", sec === s.id ? "bg-state-active font-medium text-foreground" : "text-muted-foreground hover:bg-state-hover hover:text-foreground")}>
            {s.label}
          </button>
        ))}
      </nav>
      <div className="min-w-0">
        {sec === "pm" && <AccessSec d={d} rpc={rpc} act={act} />}
        {sec === "known" && (d ? <KnownSec cfg={d.panel.known ?? null} rpc={rpc} onAct={act} /> : <p className="text-sm text-muted-foreground">…</p>)}
        {sec === "tg" && <TelegramSec v={v} rpc={rpc} reload={reload} onMsg={onMsg} />}
        {sec === "how" && <HowSec v={v} />}
      </div>
    </div>
  );
}
