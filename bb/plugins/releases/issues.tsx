// Релизы — «Вне нормы»: кейсы по видам или по эпикам, фильтры, карточка кейса сбоку (скрыть, действия в Jira).
/* eslint-disable @typescript-eslint/no-explicit-any */
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { JiraActions } from "./release";
import { Badge, Card, Chip, Dot, Empty, Field, GROUP_TONE, Key, KnownLine, Num, Pill, SEV_TONE, Seg, Sheet, ddm, inputCls, type Anom, type Rel, type Rpc, type View } from "./ui";

export type IssuesPreset = { grp?: string; owner?: Owner; onlyNew?: boolean; rel?: string; mode?: Mode };
type Owner = "all" | "epic" | "task";
type Mode = "kind" | "epic";
const MODE_KEY = "rel.issuesMode";
const readMode = (): Mode => { try { return localStorage.getItem(MODE_KEY) === "epic" ? "epic" : "kind"; } catch { return "kind"; } };
export const isEpicCase = (a: Anom) => !!(a as any).epicCase;
/** эпик кейса: сам эпик, родитель задачи или пусто */
const epicOf = (a: Anom): string => (isEpicCase(a) ? a.key : a.parent || "");
export function NewPill() {
  return <Pill tone="warn" title="Кейса не было во вчерашнем срезе">новый</Pill>;
}

// ---------- Строка кейса ----------
export function CaseRow({ a, mode, onOpen }: { a: Anom; mode: Mode | "flat"; onOpen: () => void }) {
  return (
    <div role="button" tabIndex={0} data-rel-case={a.id}
      onClick={(e) => { if (!(e.target as HTMLElement).closest("a")) onOpen(); }}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(); } }}
      className="grid cursor-pointer grid-cols-[8px_minmax(0,1fr)_auto_16px] items-start gap-x-2.5 rounded-lg px-3 py-2 outline-none transition-colors hover:bg-state-hover focus-visible:bg-state-hover">
      <Dot tone={SEV_TONE[a.sev] ?? "muted"} className="mt-[6px]" />
      <div className="min-w-0">
        {mode === "epic" ? (
          <div className="flex min-w-0 items-baseline gap-2">
            <span className="shrink-0 text-[13px] font-medium">{a.label}</span>
            {!isEpicCase(a) && a.key && <Key k={a.key} url={a.url} />}
            {!isEpicCase(a) && a.title && <span className="min-w-0 truncate text-[12.5px] text-muted-foreground" title={a.title}>{a.title}</span>}
          </div>
        ) : (
          <div className="flex min-w-0 items-baseline gap-2">
            {a.key && <Key k={a.key} url={a.url} />}
            {a.title && <span className="min-w-0 truncate text-[13px] font-medium" title={a.title}>{a.title}</span>}
            {!a.key && !a.title && <span className="text-[13px] font-medium">{a.vname || a.label}</span>}
          </div>
        )}
        <div className="mt-0.5 text-[12.5px] text-muted-foreground">
          {a.text}
        </div>
        {a.more && <div className="mt-0.5 text-xs text-subtle-foreground">{a.more}</div>}
        {a.known && <KnownLine k={a.known} />}
        {a.ack && <div className="mt-0.5 text-xs text-subtle-foreground">Скрыто {ddm(String(a.ack.at))}{a.ack.note ? `: ${a.ack.note}` : ""}</div>}
      </div>
      <div className="flex shrink-0 items-center gap-2 pt-px text-xs text-subtle-foreground">
        {a.isNew && <NewPill />}
        {a.relName && <span className="tabular-nums">{a.relName}</span>}
        {mode !== "epic" && a.parent && <span className="hidden font-mono @2xl:inline">{a.parent}</span>}
      </div>
      <Icon name="ChevronRight" className="mt-0.5 size-4 text-subtle-foreground" />
    </div>
  );
}

// ---------- Карточка кейса ----------
export function CaseSheet({ v, a, rpc, reload, onMsg, onClose, onPrev, onNext, pos, openEpic }: { v: View; a: Anom; rpc: Rpc; reload: () => void; onMsg: (m: string) => void; onClose: () => void; onPrev?: () => void; onNext?: () => void; pos?: string; openEpic: (date: string, key: string) => void }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const ack = async (n: string | null) => {
    setBusy(true);
    try { await rpc.call("set_ack", { id: a.id, note: n }); setNote(""); reload(); } finally { setBusy(false); }
  };
  const ek = epicOf(a);
  // эпик кейса в одном из трёх релизов панели: сначала в релизе кейса
  const rels: Rel[] = v.releases;
  const home = ek ? (rels.find((r) => r.date === a.rel && r.rows.some((x: any) => x.key === ek)) ?? rels.find((r) => r.rows.some((x: any) => x.key === ek))) : null;
  const epicRow = home?.rows.find((x: any) => x.key === ek);
  return (
    <Sheet onClose={onClose} onPrev={onPrev} onNext={onNext} pos={pos} scrollKey={a.id}
      head={<><Badge tone={GROUP_TONE[a.group]} className="text-xs text-muted-foreground">{(v.meta.groups as any)[a.group]}</Badge>{a.isNew && <NewPill />}</>}>
      <div className="flex items-center gap-2 text-[13px] font-medium"><Dot tone={SEV_TONE[a.sev] ?? "muted"} />{a.label}</div>
      <h2 className="mt-1.5 text-[18px] font-semibold leading-snug tracking-tight">{a.title || a.vname || a.label}</h2>
      <div className="mt-1 flex flex-wrap items-baseline gap-x-2 text-xs text-subtle-foreground">
        {a.key && <Key k={a.key} url={a.url} />}
        {a.relName && <span>· релиз {a.relName}</span>}
        {a.parent && <span>· эпик {a.parent}</span>}
        {a.priority && <span>· приоритет {a.priority}</span>}
      </div>

      <Field label="Что не так" className="mt-5">
        <p className="text-[14px] leading-relaxed">{a.text}</p>
        {a.more && <p className="mt-1 text-[12.5px] text-muted-foreground">{a.more}</p>}
        {(a.vers ?? []).length > 0 && (
          <div className="mt-2 flex flex-wrap gap-2">
            {a.vers.map((x: any) => <a key={x.p} href={x.url} target="_blank" rel="noreferrer" className="rounded-md border border-border-hairline px-2 py-1 text-[12.5px] text-muted-foreground hover:bg-state-hover hover:text-foreground">Версия в {x.p} ↗</a>)}
          </div>
        )}
      </Field>

      {a.known && <Field label="Известная проблема" className="mt-5"><KnownLine k={a.known} full /></Field>}

      {epicRow && home && (
        <button type="button" onClick={() => openEpic(home.date, ek)} className="mt-5 flex w-full items-center gap-3 rounded-lg border border-border-hairline px-3 py-2.5 text-left transition-colors hover:bg-state-hover">
          <div className="min-w-0 flex-1">
            <div className="text-[11.5px] font-medium uppercase tracking-wide text-subtle-foreground">Эпик в релизе {home.name}</div>
            <div className="mt-0.5 flex min-w-0 items-baseline gap-2"><span className="shrink-0 font-mono text-[12px] text-muted-foreground">{ek}</span><span className="truncate text-[13px] font-medium">{epicRow.summary}</span></div>
          </div>
          <Badge tone={v.meta.res[epicRow.res][1]} className="text-xs">{v.meta.res[epicRow.res][0]}</Badge>
          <Icon name="ChevronRight" className="size-4 shrink-0 text-subtle-foreground" />
        </button>
      )}

      <Card className="mt-5 p-3">
        {a.ack ? (
          <div className="flex flex-wrap items-center gap-3 text-[13px]">
            <span className="min-w-0 flex-1 text-muted-foreground">Кейс скрыт {ddm(String(a.ack.at))}{a.ack.note ? `: ${a.ack.note}` : ""}</span>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void ack(null)}>Вернуть в список</Button>
          </div>
        ) : (
          <Field label={<>Это норма? <span className="font-normal normal-case tracking-normal">— скройте кейс</span></>}>
            <div className="flex flex-wrap items-center gap-2">
              <input className={cn(inputCls, "min-w-[220px] flex-1 bg-background")} placeholder="Почему это норма (необязательно)" aria-label="Почему это норма" value={note} onChange={(e) => setNote(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") void ack(note); }} />
              <Button size="sm" variant="outline" disabled={busy} onClick={() => void ack(note)}>Скрыть кейс</Button>
            </div>
            <p className="mt-1.5 text-xs text-subtle-foreground">Кейс уйдёт из панели и Telegram, пока не исчезнет сам. Вернуть — фильтр «Скрытые».</p>
          </Field>
        )}
      </Card>

      {a.key && (
        <Field label="Действия в Jira" className="mt-5">
          <JiraActions rpc={rpc} k={a.key} isEpic={isEpicCase(a)} targets={v.moveTargets} onMsg={onMsg} />
        </Field>
      )}
    </Sheet>
  );
}

// ---------- Вкладка ----------
const CAP = 8;
type Sec = { id: string; tone: string; title: string; sub?: string; url?: string; keyText?: string; items: Anom[] };
export function IssuesTab({ v, preset, openCase }: { v: View; preset: IssuesPreset | null; openCase: (id: string, ids: string[]) => void }) {
  const [grp, setGrp] = useState<string>(preset?.grp ?? "all");
  const [owner, setOwner] = useState<Owner>(preset?.owner ?? "all");
  const [rel, setRel] = useState<string>(preset?.rel ?? "all");
  const [onlyNew, setOnlyNew] = useState(!!preset?.onlyNew);
  const [showAck, setShowAck] = useState(false);
  const [q, setQ] = useState("");
  const [mode, setModeState] = useState<Mode>(preset?.mode ?? readMode());
  const [openSec, setOpenSec] = useState<Record<string, boolean>>({});
  const [full, setFull] = useState<Record<string, boolean>>({});
  const setMode = (m: Mode) => { setModeState(m); setOpenSec({}); try { localStorage.setItem(MODE_KEY, m); } catch { /* нет хранилища */ } };

  const all: Anom[] = v.anomalies;
  const act = useMemo(() => all.filter((a) => !a.ack), [all]);
  const hidden = useMemo(() => all.filter((a) => a.ack), [all]);
  const groups = Object.entries(v.meta.groups as Record<string, string>);
  const codes = v.meta.codes as Record<string, { group: string; label: string }>;
  // фильтры, кроме группы: плитки групп считают по ним же
  const base = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (showAck ? hidden : act).filter((a) =>
      (owner === "all" || (owner === "epic" ? isEpicCase(a) : !isEpicCase(a))) &&
      (rel === "all" || a.rel === rel) &&
      (!onlyNew || a.isNew) &&
      (!s || `${a.key} ${a.title} ${a.text} ${a.parent ?? ""} ${a.label}`.toLowerCase().includes(s)));
  }, [act, hidden, showAck, owner, rel, onlyNew, q]);
  const list = useMemo(() => base.filter((a) => grp === "all" || a.group === grp), [base, grp]);
  const rels = useMemo(() => {
    const m = new Map<string, { name: string; n: number }>();
    for (const a of act) if (a.rel) m.set(a.rel, { name: a.relName, n: (m.get(a.rel)?.n ?? 0) + 1 });
    return [...m.entries()].sort((a, b) => b[0].localeCompare(a[0]));
  }, [act]);
  const epicTitle = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of v.releases as Rel[]) {
      for (const x of r.rows) m.set(x.key, x.summary);
      for (const t of r.orph ?? []) { m.set(t.key, t.summary); if (t.parent && t.parentSummary) m.set(t.parent, t.parentSummary); }
    }
    for (const a of all) if (isEpicCase(a) && a.title) m.set(a.key, a.title);
    return m;
  }, [v, all]);

  const secs: Sec[] = useMemo(() => {
    const m = new Map<string, Anom[]>();
    const keyOf = (a: Anom) => (mode === "kind" ? a.code : epicOf(a) || (a.key ? "—" : "ver"));
    for (const a of list) (m.get(keyOf(a)) ?? m.set(keyOf(a), []).get(keyOf(a))!).push(a);
    const out: Sec[] = [...m.entries()].map(([id, items]) => {
      if (mode === "kind") return { id, items, tone: GROUP_TONE[items[0].group], title: items[0].label, sub: (v.meta.groups as any)[items[0].group] };
      const sev = Math.max(...items.map((a) => a.sev));
      if (id === "ver") return { id, items, tone: SEV_TONE[sev], title: "Версии Jira" };
      if (id === "—") return { id, items, tone: SEV_TONE[sev], title: "Задачи без эпика" };
      const any = items.find((a) => a.url);
      return { id, items, tone: SEV_TONE[sev], title: epicTitle.get(id) ?? "название — в Jira", keyText: id, url: any ? String(any.url).replace(/browse\/.*$/, "browse/" + id) : undefined };
    });
    if (mode === "epic") {
      const rank = (s: Sec) => (s.id === "ver" || s.id === "—" ? 1 : 0);
      out.sort((a, b) => rank(a) - rank(b) || Math.max(...b.items.map((x) => x.sev)) - Math.max(...a.items.map((x) => x.sev)) || b.items.length - a.items.length);
    }
    return out;
  }, [list, mode, v, epicTitle]);
  const ids = useMemo(() => secs.flatMap((s) => s.items.map((a) => a.id)), [secs]);
  const autoOpen = list.length <= 24 || !!q.trim();
  const isOpen = (s: Sec, i: number) => openSec[s.id] ?? (autoOpen || i === 0);
  const allOpen = secs.every((s, i) => isOpen(s, i));
  const toggleAll = () => setOpenSec(Object.fromEntries(secs.map((s) => [s.id, !allOpen])));
  const filtered = grp !== "all" || owner !== "all" || rel !== "all" || onlyNew || !!q.trim();
  const reset = () => { setGrp("all"); setOwner("all"); setRel("all"); setOnlyNew(false); setQ(""); };
  const nNew = act.filter((a) => a.isNew).length;

  return (
    <div>
      <div className="mb-4 grid grid-cols-2 gap-2 @3xl:grid-cols-4">
        {groups.map(([g, title]) => {
          const mine = base.filter((a) => a.group === g);
          const nw = mine.filter((a) => a.isNew).length;
          const top = Object.entries(mine.reduce((m: Record<string, number>, a) => { m[a.code] = (m[a.code] ?? 0) + 1; return m; }, {})).sort((a, b) => b[1] - a[1]).slice(0, 2);
          return (
            <button key={g} type="button" aria-pressed={grp === g} onClick={() => setGrp(grp === g ? "all" : g)}
              className={cn("rounded-xl border px-3.5 py-3 text-left transition-colors", grp === g ? "border-foreground/30 bg-state-active" : "border-border-hairline bg-surface-recessed hover:bg-state-hover")}>
              <div className="flex items-center gap-2 text-[12.5px] text-muted-foreground"><Dot tone={GROUP_TONE[g]} /><span className="truncate">{title}</span></div>
              <div className="mt-1 flex items-baseline gap-2">
                <span className="text-[26px] font-semibold leading-none tabular-nums tracking-tight">{mine.length}</span>
                {nw > 0 && <Pill tone="warn">+{nw} новых</Pill>}
              </div>
              <div className="mt-1.5 truncate text-xs text-subtle-foreground">{top.length ? top.map(([c, n]) => `${codes[c]?.label ?? c} ${n}`).join(" · ") : "кейсов нет"}</div>
            </button>
          );
        })}
      </div>

      <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-2">
        <Seg label="Как сгруппировать" value={mode} onChange={setMode} options={[{ id: "kind", label: "По видам" }, { id: "epic", label: "По эпикам" }]} />
        <Seg label="Чьи кейсы" value={owner} onChange={setOwner} options={[
          { id: "all", label: "Все" },
          { id: "epic", label: "Эпики", title: "Кейсы эпиков PRODUCT — зона продакта" },
          { id: "task", label: "Задачи", title: "Кейсы задач разработки, дизайна, QA и версий — зона ПМ" },
        ]} />
        <input type="search" placeholder="Поиск: ключ, название, текст" aria-label="Поиск кейса" className={cn(inputCls, "ml-auto w-60 max-w-full")} value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="mb-3 flex flex-wrap items-center gap-x-1 gap-y-0.5">
        <Chip on={rel === "all"} onClick={() => setRel("all")}>Все релизы</Chip>
        {rels.map(([d, x]) => <Chip key={d} on={rel === d} onClick={() => setRel(rel === d ? "all" : d)}>{x.name} <Num>{x.n}</Num></Chip>)}
        <span className="mx-1 h-4 w-px bg-border" />
        <Chip on={onlyNew} onClick={() => setOnlyNew(!onlyNew)} title={v.prevSnapDate ? `Кейса не было в срезе ${ddm(v.prevSnapDate)}` : "«Новые» появятся со второго дня"}>Только новые <Num>{nNew}</Num></Chip>
        <Chip on={showAck} onClick={() => setShowAck(!showAck)}>Скрытые вами <Num>{hidden.length}</Num></Chip>
        {secs.length > 1 && <button type="button" onClick={toggleAll} className="ml-auto rounded px-1.5 text-[12.5px] text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-foreground">{allOpen ? "Свернуть все" : "Развернуть все"}</button>}
      </div>

      {!list.length && <Empty>{showAck ? "Скрытых кейсов нет." : "Кейсов нет."}{filtered && <> <button type="button" className="underline underline-offset-2 hover:text-foreground" onClick={reset}>Сбросить фильтры</button></>}</Empty>}
      <div className={cn("divide-y divide-border-hairline overflow-hidden rounded-xl border border-border-hairline", !secs.length && "hidden")}>
        {secs.map((s, i) => {
          const open = isOpen(s, i);
          const nw = s.items.filter((a) => a.isNew).length;
          const relNames = [...new Set(s.items.map((a) => a.relName).filter(Boolean))];
          const cut = s.items.length > CAP + 2 && !full[s.id] && !q.trim();
          return (
            <section key={s.id}>
              <div role="button" tabIndex={0} aria-expanded={open} data-rel-sec={s.id}
                onClick={(e) => { if (!(e.target as HTMLElement).closest("a")) setOpenSec((p) => ({ ...p, [s.id]: !open })); }}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpenSec((p) => ({ ...p, [s.id]: !open })); } }}
                className={cn("flex cursor-pointer items-center gap-2.5 px-3 outline-none transition-colors hover:bg-state-hover focus-visible:bg-state-hover", mode === "kind" ? "py-2.5" : "py-2", open && "bg-surface-recessed")}>
                <Icon name="ChevronRight" className={cn("size-4 shrink-0 text-subtle-foreground transition-transform", open && "rotate-90")} />
                <Dot tone={s.tone} />
                {s.keyText && (s.url ? <Key k={s.keyText} url={s.url} /> : <span className="font-mono text-[12px] text-muted-foreground">{s.keyText}</span>)}
                <span className="min-w-0 truncate text-[13.5px] font-semibold" title={s.title}>{s.title}</span>
                <span className="shrink-0 text-[13px] tabular-nums text-subtle-foreground">{s.items.length}</span>
                {nw > 0 && <Pill tone="warn">+{nw}</Pill>}
                <span className="ml-auto shrink-0 text-xs text-subtle-foreground">{mode === "kind" ? s.sub : relNames.join(" · ")}</span>
              </div>
              {open && (
                <div className="divide-y divide-border-hairline border-t border-border-hairline py-1 pl-6 pr-1">
                  {(cut ? s.items.slice(0, CAP) : s.items).map((a) => <CaseRow key={a.id} a={a} mode={mode} onOpen={() => openCase(a.id, ids)} />)}
                  {cut && <button type="button" onClick={() => setFull((p) => ({ ...p, [s.id]: true }))} className="w-full px-3 py-2 text-left text-[12.5px] text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-foreground">Показать все {s.items.length}</button>}
                </div>
              )}
            </section>
          );
        })}
      </div>
      <p className="mt-3 px-1 text-xs text-subtle-foreground">
        {filtered ? <>Показано {list.length} из {(showAck ? hidden : act).length}. <button type="button" className="underline underline-offset-2 hover:text-foreground" onClick={reset}>Сбросить фильтры</button> · </> : null}
        {v.prevSnapDate ? `«Новый» — кейса не было в срезе ${ddm(v.prevSnapDate)}.` : "«Новые» появятся со второго дня."}
      </p>
    </div>
  );
}
