// Релизы — экран релиза: итог или прогноз одной строкой, полоса исходов (она же фильтр), эпики по исходам,
// карточка эпика сбоку (ваш итог, ваша причина, действия в Jira, история, задачи).
/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { Badge, Card, Chip, Dot, Empty, Field, Key, MODE_LABEL, MODE_WORD, Note, Num, Progress, Seg, Sheet, SLOT_LABEL, StackBar, errText, inputCls, plural, signed, taskProjects, type Part, type Rel, type Row, type Rpc, type View } from "./ui";

// ---------- Числа релиза (общие с «Обзором») ----------
/** какие исходы считаем хорошими и как назвать их одним словом */
export const GOOD: Record<string, [string[], string]> = {
  fact: [["done"], "сделано"],
  forecast: [["done", "ok"], "успевают"],
  plan: [["done", "n_ready"], "готовы к разработке"],
};
export const relGood = (r: Rel) => (GOOD[r.mode]?.[0] ?? []).reduce((s, k) => s + (r.counts[k] || 0), 0);
export const relParts = (v: View, r: Rel): Part[] => (r.order as string[]).map((k) => ({ k, n: r.counts[k] || 0, tone: v.meta.res[k][1], label: v.meta.res[k][0] }));
export function relWhen(r: Rel): string {
  if (r.mode === "fact") return r.daysLeft >= 0 ? "сегодня" : `прошёл ${-r.daysLeft} ${plural(-r.daysLeft, "день", "дня", "дней")} назад`;
  if (r.mode === "plan" && r.startDaysLeft > 0) return `спринт стартует через ${r.startWorkdaysLeft} раб. дн.`;
  return r.daysLeft <= 0 ? "сегодня" : `через ${r.workdaysLeft} раб. дн.`;
}
/** ожидаемая выручка фич релиза по исходам, тыс./мес; минусовые фичи — отдельно */
export function revStat(v: View, r: Rel): { total: number; parts: Part[]; minus: number; minusN: number; wont: number } | null {
  const rows: Row[] = r.rows;
  if (r.mode !== "forecast" || !rows.some((x) => x.rev != null)) return null;
  const sum = (k: string) => rows.filter((x) => x.res === k && x.rev > 0).reduce((s, x) => s + x.rev, 0);
  const parts = (r.order as string[]).map((k) => ({ k, n: sum(k), tone: v.meta.res[k][1], label: v.meta.res[k][0] }));
  const neg = rows.filter((x) => x.rev < 0);
  return { total: parts.reduce((s, p) => s + p.n, 0), parts, minus: neg.reduce((s, x) => s + x.rev, 0), minusN: neg.length, wont: sum("wont") };
}

// ---------- Действия в Jira (с подтверждением) ----------
export function JiraActions({ rpc, k, isEpic, targets, onMsg, onDone }: { rpc: Rpc; k: string; isEpic: boolean; targets: { date: string; name: string }[]; onMsg: (m: string) => void; onDone?: () => void }) {
  const [tr, setTr] = useState<{ id: string; name: string; to: string }[] | null>(null);
  const [trSel, setTrSel] = useState("");
  const [rel, setRel] = useState("");
  const [kids, setKids] = useState(true);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setTr(null); setTrSel(""); setRel(""); }, [k]);
  const loadTr = () => rpc.call("jira_transitions", { key: k }).then((r) => setTr(r.list ?? []), (e) => onMsg(errText(e)));
  const run = async (fn: () => Promise<{ ok: boolean; message?: string }>) => {
    setBusy(true);
    try {
      const r = await fn();
      onMsg((r.ok ? "Готово: " : "Ошибка: ") + (r.message ?? ""));
      setTrSel(""); setRel("");
      if (r.ok) onDone?.();
    } catch (e) {
      onMsg(errText(e));
    } finally {
      setBusy(false);
    }
  };
  const target = tr?.find((t) => t.id === trSel);
  const row = "flex flex-wrap items-center gap-2";
  return (
    <div className="space-y-2 rounded-lg border border-border-hairline px-3 py-2.5 text-[12.5px]">
      <div className={row}>
        <span className="w-14 shrink-0 text-subtle-foreground">Статус</span>
        {tr == null ? (
          <Button variant="outline" size="sm" onClick={() => void loadTr()}>Сменить статус…</Button>
        ) : (
          <select className={inputCls} value={trSel} aria-label={`Новый статус ${k}`} onChange={(e) => setTrSel(e.target.value)}>
            <option value="">выберите статус…</option>
            {tr.map((t) => <option key={t.id} value={t.id}>{t.to}</option>)}
          </select>
        )}
        {target && (
          <Button size="sm" disabled={busy} onClick={() => void run(() => rpc.call("jira_transition", { key: k, id: target.id }))}>
            Перевести в «{target.to}»
          </Button>
        )}
      </div>
      <div className={row}>
        <span className="w-14 shrink-0 text-subtle-foreground">Релиз</span>
        <select className={inputCls} value={rel} aria-label={`Перенести релиз ${k}`} onChange={(e) => setRel(e.target.value)}>
          <option value="">перенести в…</option>
          {targets.map((t) => <option key={t.date} value={t.date}>{t.name}</option>)}
          <option value="none">без релиза</option>
        </select>
        {isEpic && rel && (
          <label className="inline-flex items-center gap-1 text-muted-foreground">
            <input type="checkbox" checked={kids} onChange={(e) => setKids(e.target.checked)} /> и незакрытые задачи эпика
          </label>
        )}
        {rel && (
          <Button size="sm" disabled={busy} onClick={() => void run(() => rpc.call("jira_set_release", { key: k, date: rel === "none" ? null : rel, withChildren: isEpic && kids }))}>
            Перенести {isEpic && kids ? "эпик и задачи" : k} → {rel === "none" ? "без релиза" : targets.find((t) => t.date === rel)?.name}
          </Button>
        )}
      </div>
      <p className="text-xs text-subtle-foreground">Запись в Jira {k} — только по кнопке. Панель обновится при следующем сборе из Jira.</p>
    </div>
  );
}

// ---------- История, комментарии и задачи эпика ----------
function Details({ d }: { d: any }) {
  return (
    <div className="space-y-5">
      {d.groups.map((g: any) => (
        <Field key={g.title} label={<>{g.title} · {g.total}</>}>
          <ul className="divide-y divide-border-hairline">
            {g.tasks.map((t: any) => (
              <li key={t.key} className={cn("grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 py-1.5 text-[12.5px]", t.other && "opacity-60")}>
                <div className="min-w-0">
                  <Key k={t.key} url={t.url} /> <span>{t.summary}</span>
                  {t.assignee ? <span className="text-subtle-foreground"> · {t.assignee}</span> : null}
                </div>
                <div className="text-right">
                  <div className="whitespace-nowrap">{t.status}</div>
                  <div className="whitespace-nowrap text-xs text-subtle-foreground">
                    {t.statusAt && t.statusAt !== t.status ? `на срезе: ${t.statusAt} · ` : !t.statusAt ? "на срезе ещё нет · " : ""}создана {t.created}{t.after ? <span className="text-warning-text"> · после старта</span> : null}
                  </div>
                </div>
              </li>
            ))}
          </ul>
          {g.total > g.tasks.length && <p className="mt-1 text-xs text-subtle-foreground">и ещё {g.total - g.tasks.length} — в Jira</p>}
        </Field>
      ))}
      {!d.groups.length && <p className="text-[13px] text-muted-foreground">В эпике нет задач разработки, дизайна и QA.</p>}
      <Field label={<>История эпика с {d.since}</>}>
        <ul className="space-y-1 text-[12.5px]">
          {d.hist.length ? d.hist.map((x: any, i: number) => (
            <li key={i} className="flex gap-2">
              <span className="w-[76px] shrink-0 tabular-nums text-subtle-foreground">{x.at}</span>
              <span className={cn("min-w-0", x.after && "font-medium")}>{x.txt} <span className="font-normal text-subtle-foreground">· {x.who}</span></span>
            </li>
          )) : <li className="text-muted-foreground">изменений нет</li>}
        </ul>
        <p className="mt-1.5 text-xs text-subtle-foreground">Жирным — после старта спринта. Создан {d.created}.</p>
      </Field>
      {d.comments.length > 0 && (
        <Field label="Комментарии в Jira">
          {d.comments.map((c: any, i: number) => (
            <div key={i} className="mb-1.5 whitespace-pre-wrap rounded-md bg-surface-recessed px-2.5 py-1.5 text-[12.5px]"><b>{c.t.slice(8, 10)}.{c.t.slice(5, 7)} · {c.who}</b>{"\n"}{c.text}</div>
          ))}
        </Field>
      )}
    </div>
  );
}
function DesignCell({ d, withSrc }: { d: any; withSrc?: boolean }) {
  return (
    <div className="min-w-0 text-xs">
      {d.state === "notready" ? <Badge tone="bad" className="text-xs">не готов</Badge> : d.state === "ready" ? <Badge tone={d.inSprint ? "warn" : "good"} className="text-xs">{d.inSprint ? `появился ${d.at}` : `готов ${d.at}`}</Badge> : <span className="text-subtle-foreground">—</span>}
      {d.last && <div className="text-subtle-foreground">правка {d.last}</div>}
      {withSrc && d.src && <div className="mt-0.5 text-subtle-foreground">{d.src}</div>}
    </div>
  );
}

// ---------- Карточка эпика ----------
export function EpicSheet({ v, r, x, rpc, reload, onMsg, onClose, onPrev, onNext, pos }: { v: View; r: Rel; x: Row; rpc: Rpc; reload: () => void; onMsg: (m: string) => void; onClose: () => void; onPrev?: () => void; onNext?: () => void; pos?: string }) {
  const RES = v.meta.res as Record<string, [string, string]>;
  const fact = r.mode === "fact", plan = r.mode === "plan";
  const [note, setNote] = useState<string>(x.note ?? "");
  const [saved, setSaved] = useState(false);
  useEffect(() => { setNote(x.note ?? ""); setSaved(false); }, [x.key, r.date]); // eslint-disable-line react-hooks/exhaustive-deps
  const over = async (res: string | null) => { await rpc.call("set_override", { date: r.date, key: x.key, res }); reload(); };
  const saveNote = async () => {
    if (note === (x.note ?? "")) return;
    await rpc.call("set_note", { date: r.date, key: x.key, text: note });
    setSaved(true);
    reload();
  };
  return (
    <Sheet onClose={onClose} onPrev={onPrev} onNext={onNext} pos={pos} scrollKey={r.date + x.key}
      head={<><Key k={x.key} url={x.url} /><span className="truncate text-xs text-muted-foreground">{x.status}</span></>}>
      <h2 className="text-[18px] font-semibold leading-snug tracking-tight">{x.summary}</h2>
      <div className="mt-1 flex flex-wrap gap-x-2 text-xs text-subtle-foreground">
        <span>Релиз {r.name} · {MODE_LABEL[r.mode]}</span>
        <span>· сейчас в Jira: {x.versions.length ? x.versions.join(", ") : "без релиза"}</span>
        {x.origin === "added" && <span className="text-warning-text">· добавлен {x.addedAt}, после старта спринта</span>}
      </div>

      <div className="mt-4 grid grid-cols-2 gap-x-6 gap-y-4 @xl:grid-cols-4">
        <Field label={fact ? "Итог" : plan ? "Стадия" : "Прогноз"}>
          <Badge tone={RES[x.res][1]} className="text-[13px] font-medium">{RES[x.res][0]}</Badge>
          {x.over && <div className="mt-0.5 text-xs text-subtle-foreground">вручную · авто: {RES[x.resAuto][0]}</div>}
        </Field>
        <Field label="Разработка">
          <Progress g={x.g} legend />
          {x.move && <div className="mt-1 text-xs text-subtle-foreground">на {x.move.at}, момент переноса</div>}
          {fact && !x.move && x.gNow.done !== x.g.done && <div className="mt-1 text-xs text-subtle-foreground">сейчас {x.gNow.done} из {x.gNow.total}</div>}
        </Field>
        <Field label="Дизайн"><DesignCell d={x.d} withSrc /></Field>
        {!fact && !plan && (
          <Field label="Выручка, тыс./мес">
            <span className={cn("text-[15px] font-semibold tabular-nums", x.rev == null && "font-normal text-subtle-foreground")} style={x.rev < 0 ? { color: "var(--rl-bad)" } : undefined}>{x.rev == null ? "нет оценки" : signed(x.rev)}</span>
          </Field>
        )}
      </div>

      <Field label="Причины из Jira" className="mt-5">
        {x.reasons.length ? (
          <ul className="space-y-1 text-[13px]">
            {x.reasons.map((y: any, i: number) => <li key={i} className={cn("flex gap-2", y.c === "move" && "font-medium")}><span className="mt-[7px] size-1 shrink-0 rounded-full bg-foreground/40" />{y.t}</li>)}
          </ul>
        ) : <p className="text-[13px] text-subtle-foreground">Причин нет.</p>}
      </Field>

      <Card className="mt-5 p-3">
        <Field label={<>Ваш итог <span className="font-normal normal-case tracking-normal">— заменит автоматический в панели и сводке</span></>}>
          <div className="flex flex-wrap gap-1">
            <Chip on={!x.over} onClick={() => void over(null)}>Авто · {RES[x.resAuto][0]}</Chip>
            {(r.order as string[]).map((k) => <Chip key={k} on={x.over === k} onClick={() => void over(k)}><Dot tone={RES[k][1]} />{RES[k][0]}</Chip>)}
          </div>
        </Field>
        <Field className="mt-3" label={<>Ваша причина {saved && <span className="font-normal normal-case tracking-normal text-muted-foreground">· сохранено</span>}</>}>
          <textarea className={cn(inputCls, "h-20 w-full resize-y bg-background")} placeholder="Причина со слов команды" aria-label={`Ваша причина: ${x.key}`}
            value={note} onChange={(e) => { setNote(e.target.value); setSaved(false); }} onBlur={() => void saveNote()} />
        </Field>
      </Card>

      <Field label="Действия в Jira" className="mt-5">
        <JiraActions rpc={rpc} k={x.key} isEpic targets={v.moveTargets} onMsg={onMsg} />
      </Field>

      <div className="mt-5"><Details d={x.details} /></div>
    </Sheet>
  );
}

// ---------- Строка эпика ----------
const COLS = "@3xl:grid-cols-[minmax(0,1.7fr)_108px_118px_52px_minmax(0,1fr)_16px]";
function EpicRow({ x, r, showRev, onOpen }: { x: Row; r: Rel; showRev: boolean; onOpen: () => void }) {
  const first = x.reasons[0];
  const moved = x.versions.join(", ") !== r.name;
  return (
    <div role="button" tabIndex={0} data-rel-row={x.key}
      onClick={(e) => { if (!(e.target as HTMLElement).closest("a")) onOpen(); }}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(); } }}
      className={cn("grid cursor-pointer grid-cols-[minmax(0,1fr)_16px] items-center gap-x-4 gap-y-1.5 rounded-lg px-3 py-2 outline-none transition-colors hover:bg-state-hover focus-visible:bg-state-hover", COLS)}>
      <div className="min-w-0">
        <div className="flex min-w-0 items-baseline gap-2">
          <Key k={x.key} url={x.url} />
          <span className="min-w-0 truncate text-[13px] font-medium" title={x.summary}>{x.summary}</span>
        </div>
        <div className="mt-0.5 flex min-w-0 flex-wrap items-baseline gap-x-2 text-xs text-subtle-foreground">
          <span>{x.status}</span>
          {x.origin === "added" && <span className="text-warning-text">добавлен {x.addedAt}</span>}
          {moved && <span>сейчас: {x.versions.length ? x.versions.join(", ") : "без релиза"}</span>}
          {x.over && <span title="Итог поставлен вручную">итог вручную</span>}
        </div>
        {x.note && <div className="mt-0.5 truncate text-xs text-muted-foreground" title={x.note}>Ваша причина: {x.note}</div>}
      </div>
      <Icon name="ChevronRight" className="size-4 text-subtle-foreground @3xl:order-last" />
      <div className="col-span-2 flex min-w-0 flex-wrap items-center gap-x-5 gap-y-1 @3xl:contents">
        <div className="w-[108px] @3xl:w-auto"><Progress g={x.g} /></div>
        <div className={cn("min-w-0", x.d.state !== "notready" && x.d.state !== "ready" && "hidden @3xl:block")}><DesignCell d={x.d} /></div>
        {showRev ? (
          <div className={cn("text-[13px] tabular-nums @3xl:text-right", x.rev == null && "hidden text-subtle-foreground @3xl:block")} style={x.rev < 0 ? { color: "var(--rl-bad)" } : undefined}>
            <span className="text-xs text-subtle-foreground @3xl:hidden">выручка </span>{x.rev == null ? "—" : signed(x.rev)}
          </div>
        ) : <span className="hidden @3xl:block" />}
        <div className="flex min-w-0 basis-full items-baseline gap-1.5 text-[12.5px] text-muted-foreground @3xl:basis-auto">
          <span className="min-w-0 truncate" title={x.reasons.map((y: any) => y.t).join("\n")}>{first ? first.t : "—"}</span>
          {x.reasons.length > 1 && <span className="shrink-0 text-xs tabular-nums text-subtle-foreground">+{x.reasons.length - 1}</span>}
        </div>
      </div>
    </div>
  );
}

// ---------- Задачи вне эпиков и снятые до старта ----------
const G_LAB: Record<string, [string, string]> = { done: ["готово", "good"], test: ["в тесте", "info"], work: ["в работе", "warn"], hold: ["пауза", "serious"], kick: ["возврат", "bad"], todo: ["не начата", "muted"] };
function OrphList({ r, v }: { r: Rel; v: View }) {
  return (
    <div>
      <p className="mb-3 max-w-3xl text-[13px] text-muted-foreground">Задачи {taskProjects(v)} с релизом {r.name}, у которых эпик не в релизе или эпика нет: техдолг, баги, доработки.</p>
      {!r.orph.length ? <Empty>Нет задач</Empty> : (
        <div className="overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead className="text-left text-xs text-subtle-foreground"><tr className="border-b border-border-seam"><th className="py-1.5 pl-3 font-normal">Задача</th><th className="font-normal">Родитель</th><th className="font-normal">Откуда</th><th className="font-normal">На срезе</th><th className="pr-3 font-normal">Сейчас</th></tr></thead>
            <tbody>
              {r.orph.map((t: any) => (
                <tr key={t.key} className="border-b border-border-hairline align-top hover:bg-state-hover">
                  <td className="py-1.5 pl-3 pr-3"><Key k={t.key} url={t.url} /> <span className="text-xs text-subtle-foreground">{t.type}</span><div>{t.summary}</div>{t.assignee && <div className="text-xs text-subtle-foreground">{t.assignee}</div>}</td>
                  <td className="py-1.5 pr-3 text-xs">{t.parent ? <>{t.parent} <span className="text-subtle-foreground">{t.parentSummary.slice(0, 50)}</span></> : "—"}</td>
                  <td className="whitespace-nowrap py-1.5 pr-3 text-xs">{t.added ? <span className="text-warning-text">добавлена {t.added}</span> : "план"}{t.moved ? " · перенесена" : ""}</td>
                  <td className="py-1.5 pr-3">{t.statusAt ? <Badge tone={G_LAB[t.g]?.[1] ?? "muted"}>{G_LAB[t.g]?.[0] ?? t.statusAt}</Badge> : "—"}</td>
                  <td className="whitespace-nowrap py-1.5 pr-3 text-xs">{t.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
function PreList({ r }: { r: Rel }) {
  return (
    <div>
      <p className="mb-3 max-w-3xl text-[13px] text-muted-foreground">Эпики, которые сняли с {r.name} ещё до старта спринта. В итог и прогноз не входят.</p>
      {!r.pre.length ? <Empty>Нет эпиков</Empty> : (
        <div className="overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead className="text-left text-xs text-subtle-foreground"><tr className="border-b border-border-seam"><th className="py-1.5 pl-3 font-normal">Эпик</th><th className="font-normal">Когда</th><th className="font-normal">Кто</th><th className="font-normal">Куда</th><th className="pr-3 font-normal">Статус</th></tr></thead>
            <tbody>
              {r.pre.map((p: any) => (
                <tr key={p.key} className="border-b border-border-hairline align-top hover:bg-state-hover">
                  <td className="py-1.5 pl-3 pr-3"><Key k={p.key} url={p.url} /> {p.summary}</td>
                  <td className="whitespace-nowrap py-1.5 pr-3">{p.at}</td>
                  <td className="whitespace-nowrap py-1.5 pr-3 text-muted-foreground">{p.who}</td>
                  <td className="whitespace-nowrap py-1.5 pr-3">{p.to.length ? p.to.join(", ") : "без релиза"}</td>
                  <td className="whitespace-nowrap py-1.5 pr-3 text-xs">{p.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---------- Экран релиза ----------
export type RelSub = "epics" | "orph" | "pre";
export function ReleaseTab({ v, r, rpc, reload, pick, sub, setSub, openEpic }: { v: View; r: Rel; rpc: Rpc; reload: () => void; pick: (date: string) => void; sub: RelSub; setSub: (s: RelSub) => void; openEpic: (key: string, keys: string[]) => void }) {
  const [f, setF] = useState("all");
  const [o, setO] = useState("all");
  const [rc, setRc] = useState("");
  const [q, setQ] = useState("");
  const [dates, setDates] = useState(false);
  const [why, setWhy] = useState(false);
  const RES = v.meta.res as Record<string, [string, string]>;
  const fact = r.mode === "fact", plan = r.mode === "plan";
  const rows: Row[] = r.rows;
  const nd = rows.filter((x) => x.res !== "done");
  const rcount = Object.entries(v.meta.rc as Record<string, string>).map(([c, l]) => [c, l, nd.filter((x) => x.codes.includes(c)).length] as [string, string, number]).filter((x) => x[2]).sort((a, b) => b[2] - a[2]);
  const mx = Math.max(1, ...rcount.map((x) => x[2]));
  const dsprint = (x: Row) => x.d.inSprint || x.d.state === "notready";
  const list = useMemo(() => {
    let l = rows.filter((x) => (!rc || (x.codes.includes(rc) && x.res !== "done")) && (f === "all" || x.res === f) && (o === "all" || (o === "dsprint" ? dsprint(x) : x.origin === o)));
    if (q) { const s = q.toLowerCase(); l = l.filter((x) => (x.key + " " + x.summary).toLowerCase().includes(s)); }
    return l;
  }, [rows, rc, f, o, q]);
  const groups = useMemo(() => {
    const m = new Map<string, Row[]>();
    for (const x of list) (m.get(x.res) ?? m.set(x.res, []).get(x.res)!).push(x);
    return [...m.entries()];
  }, [list]);
  const keys = list.map((x) => x.key);
  const save = async (start: string | null, cutoff: string | null) => { await rpc.call("set_dates", { date: r.date, start, cutoff }); reload(); };
  const notReleased = Object.entries(r.released).filter(([, ok]) => !ok).map(([p]) => p);
  const parts = relParts(v, r);
  const rs = revStat(v, r);
  const showRev = !fact && !plan;
  const filtered = f !== "all" || o !== "all" || !!rc || !!q;
  const reset = () => { setF("all"); setO("all"); setRc(""); setQ(""); };
  const nDsprint = rows.filter(dsprint).length;

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Seg label="Релиз" value={r.date} onChange={pick} options={(v.releases as Rel[]).map((x) => ({ id: x.date as string, label: <>{x.name} <span className="text-subtle-foreground">· {MODE_LABEL[x.mode]}</span></> }))} />
        <span className="text-[13px] text-muted-foreground">Релиз {r.name} — {relWhen(r)}</span>
      </div>
      {fact && notReleased.length > 0 && <Note>Версия {r.name} не выпущена в Jira: {notReleased.join(", ")}.</Note>}

      <Card className="mb-4 p-4">
        <div className="grid gap-x-10 gap-y-4 @3xl:grid-cols-[minmax(250px,auto)_minmax(0,1fr)]">
          <div className="min-w-0">
            <div className="text-[11.5px] font-medium uppercase tracking-wide text-subtle-foreground">{SLOT_LABEL[r.slot] ?? ""} релиз · {MODE_WORD[r.mode]}</div>
            <div className="mt-1.5 flex items-baseline gap-2">
              <span className="text-[36px] font-semibold leading-none tabular-nums tracking-tight">{relGood(r)}</span>
              <span className="text-[14px] text-muted-foreground">из {rows.length} {plural(rows.length, "эпика", "эпиков", "эпиков")} {GOOD[r.mode]?.[1]}</span>
            </div>
            <div className="mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] text-muted-foreground">
              <span>Спринт {r.startLabel} – {r.name}{fact ? ` · итог на конец дня ${r.cutoff.slice(8, 10)}.${r.cutoff.slice(5, 7)}` : ""}</span>
              <button type="button" aria-expanded={dates} onClick={() => setDates(!dates)} className="rounded px-1 underline decoration-dotted underline-offset-2 hover:text-foreground">{dates ? "скрыть" : "изменить"}</button>
            </div>
            {dates && (
              <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2 text-[12.5px] text-muted-foreground">
                <label className="inline-flex items-center gap-1.5">Старт спринта <input type="date" className={inputCls} value={r.start} onChange={(e) => void save(e.target.value, fact ? r.cutoff : null)} /></label>
                {fact && <label className="inline-flex items-center gap-1.5">Итог на конец дня <input type="date" className={inputCls} value={r.cutoff} onChange={(e) => void save(r.start, e.target.value)} /></label>}
              </div>
            )}
          </div>
          <div className="min-w-0">
            <StackBar parts={parts} h={12} active={f} onPick={(k) => { setF(f === k ? "all" : k); setSub("epics"); }} />
            <div className="mt-2 flex flex-wrap gap-x-1 gap-y-0.5">
              <Chip on={f === "all"} onClick={() => setF("all")}>Все <Num>{rows.length}</Num></Chip>
              {parts.filter((p) => p.n > 0).map((p) => (
                <Chip key={p.k} on={f === p.k} onClick={() => { setF(f === p.k ? "all" : p.k); setSub("epics"); }}><Dot tone={p.tone} />{p.label} <Num>{p.n}</Num></Chip>
              ))}
            </div>
            {rs && (
              <div className="mt-3 border-t border-border-hairline pt-3">
                <div className="mb-1.5 flex flex-wrap items-baseline gap-x-2 text-[12.5px]">
                  <span className="text-muted-foreground">Выручка фич релиза</span>
                  <span className="font-semibold tabular-nums">{signed(rs.total)} тыс./мес</span>
                  {rs.wont > 0 && <span className="text-destructive-text">· под угрозой {rs.wont}</span>}
                  {rs.minusN > 0 && <span className="text-subtle-foreground">· ещё {rs.minusN} {plural(rs.minusN, "фича", "фичи", "фич")} с минусом: {signed(rs.minus)}</span>}
                </div>
                <StackBar parts={rs.parts} h={6} />
                <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5">
                  {rs.parts.filter((p) => p.n > 0).map((p) => <Badge key={p.k} tone={p.tone} className="text-xs">{p.label} <span className="tabular-nums text-subtle-foreground">{signed(p.n)}</span></Badge>)}
                </div>
              </div>
            )}
          </div>
        </div>
      </Card>

      <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2">
        <Seg label="Что показать" value={sub} onChange={setSub} options={[
          { id: "epics", label: <>Эпики <Num>{rows.length}</Num></> },
          { id: "orph", label: <>Задачи вне эпиков <Num>{r.orph.length}</Num></> },
          { id: "pre", label: <>Сняли до старта <Num>{r.pre.length}</Num></> },
        ]} />
        {sub === "epics" && <input type="search" placeholder="Поиск по названию или ключу" aria-label="Поиск эпика" className={cn(inputCls, "ml-auto w-60 max-w-full")} value={q} onChange={(e) => setQ(e.target.value)} />}
      </div>

      {sub === "orph" && <OrphList r={r} v={v} />}
      {sub === "pre" && <PreList r={r} />}
      {sub === "epics" && (
        <div>
          <div className="mb-2 flex flex-wrap items-center gap-x-1 gap-y-0.5">
            <Chip on={o === "all"} onClick={() => setO("all")}>План и добавленные</Chip>
            <Chip on={o === "plan"} onClick={() => setO(o === "plan" ? "all" : "plan")}>План <Num>{r.plan}</Num></Chip>
            <Chip on={o === "added"} onClick={() => setO(o === "added" ? "all" : "added")}>Добавили после старта <Num>{r.added}</Num></Chip>
            <Chip on={o === "dsprint"} onClick={() => setO(o === "dsprint" ? "all" : "dsprint")}>Дизайн в спринте / не готов <Num>{nDsprint}</Num></Chip>
            {rcount.length > 0 && (
              <button type="button" aria-expanded={why} onClick={() => setWhy(!why)} className={cn("ml-auto inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-[12.5px] transition-colors hover:bg-state-hover", rc || why ? "text-foreground" : "text-muted-foreground")}>
                <Icon name="ChevronRight" className={cn("size-3.5 transition-transform", why && "rotate-90")} />
                {rc ? <>Причина: {(v.meta.rc as any)[rc]}</> : <>Причины у {fact ? "несделанных" : "неготовых"} <Num>{nd.length}</Num></>}
              </button>
            )}
          </div>
          {why && rcount.length > 0 && (
            <Card className="mb-3 p-3">
              <div className="grid gap-x-8 gap-y-0.5 @3xl:grid-cols-2">
                {rcount.map(([c, l, n]) => (
                  <button key={c} type="button" aria-pressed={rc === c} onClick={() => setRc(rc === c ? "" : c)} className={cn("grid w-full grid-cols-[minmax(0,1fr)_90px_28px] items-center gap-2 rounded px-1.5 py-1 text-left text-[12.5px] hover:bg-state-hover", rc === c && "bg-state-active font-medium")}>
                    <span className="truncate">{l}</span>
                    <span className="h-1.5 overflow-hidden rounded-full bg-state-hover"><span className="block h-full rounded-full bg-foreground/45" style={{ width: `${(n / mx) * 100}%` }} /></span>
                    <span className="text-right tabular-nums text-subtle-foreground">{n}</span>
                  </button>
                ))}
              </div>
              <p className="mt-2 text-xs text-subtle-foreground">Нажмите причину — останутся эпики с ней. У одного эпика может быть несколько причин.</p>
            </Card>
          )}

          <div className={cn("hidden items-center gap-x-4 border-b border-border-seam px-3 pb-1.5 text-xs text-subtle-foreground @3xl:grid", COLS)}>
            <span>Эпик</span><span>Разработка</span><span>Дизайн</span><span className="text-right">{showRev ? "Выручка" : ""}</span><span>Причины из Jira</span><span />
          </div>
          {!list.length && <div className="mt-3"><Empty>Нет эпиков под фильтр. <button type="button" className="underline underline-offset-2 hover:text-foreground" onClick={reset}>Сбросить</button></Empty></div>}
          {groups.map(([res, items]) => {
            const rev = showRev ? items.reduce((s, x) => s + Math.max(0, x.rev || 0), 0) : 0;
            return (
              <section key={res} className="mt-3">
                <h4 className="flex items-center gap-2 px-3 pb-1 text-[13px] font-semibold">
                  <Dot tone={RES[res][1]} />
                  {RES[res][0]}
                  <span className="font-normal tabular-nums text-subtle-foreground">{items.length}</span>
                  {rev > 0 && <span className="ml-auto text-xs font-normal tabular-nums text-subtle-foreground">выручка {signed(rev)} тыс./мес</span>}
                </h4>
                <div className="divide-y divide-border-hairline">
                  {items.map((x) => <EpicRow key={x.key} x={x} r={r} showRev={showRev} onOpen={() => openEpic(x.key, keys)} />)}
                </div>
              </section>
            );
          })}
          {filtered && list.length > 0 && <p className="mt-3 px-3 text-xs text-subtle-foreground">Показано {list.length} из {rows.length}. <button type="button" className="underline underline-offset-2 hover:text-foreground" onClick={reset}>Сбросить фильтры</button></p>}
        </div>
      )}
    </div>
  );
}
