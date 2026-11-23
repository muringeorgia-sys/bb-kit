// Релизы — панель bb. Данные и логика — ./core/core.mjs (через server.ts).
// Структура: Обзор · Релиз · Вне нормы · Бот · Настройки.
//   app.tsx      — шапка, навигация, «Обзор», боковые карточки
//   release.tsx  — экран релиза и карточка эпика
//   issues.tsx   — «Вне нормы» и карточка кейса
//   settings.tsx — «Бот» и «Настройки» (доступы, известные проблемы, Telegram, как считаем)
//   ui.tsx       — общие детали и цвета ролей
// Продукты из настроек плагина: переключатель в шапке (localStorage rel.product); панель добавляет product в каждый вызов RPC.
// Старые адреса вкладок работают: issues, дата релиза, orph, pm, tg, how.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { definePluginApp, useBbNavigate, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { CaseRow, CaseSheet, IssuesTab, isEpicCase, type IssuesPreset } from "./issues";
import { EpicSheet, GOOD, ReleaseTab, relGood, relParts, relWhen, revStat, type RelSub } from "./release";
import { BotTab, SettingsTab, openAsks, type SetSec } from "./settings";
import { Badge, Card, Dot, Empty, GROUP_TONE, Head, Key, LinkBtn, MODE_WORD, PRODUCTS0, Pill, REL_CSS, setProducts0, SLOT_LABEL, StackBar, dt, errText, plural, signed, type Act, type Anom, type Product, type Rel, type Rpc, type View } from "./ui";

const PROD_KEY = "rel.product";
const readProduct = () => { try { return localStorage.getItem(PROD_KEY) || PRODUCTS0[0].id; } catch { return PRODUCTS0[0].id; } };
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SET_IDS = ["settings", "pm", "known", "tg", "how"];
type Section = "home" | "rel" | "issues" | "bot" | "settings";
type SheetState = { t: "epic"; date: string; key: string; keys: string[] } | { t: "case"; id: string; ids: string[] } | null;

// ---------- Подсказка: настройки не заполнены ----------
function SetupHint({ setup }: { setup: { missing: string[]; error: string | null } }) {
  return (
    <Card className="mb-4 p-4">
      <Head>Настройте плагин</Head>
      <p className="max-w-3xl text-[13px] text-muted-foreground">Откройте bb → Settings → Installed plugins → «Релизы» и заполните доступ к вашей Jira, проекты и продукты. Пример продуктов: <span className="font-mono text-xs">{'[{"id":"a","name":"Продукт A"}]'}</span>. После сохранения нажмите «Обновить».</p>
      {setup.error && <p className="mt-2 text-[13px] text-destructive-text">Ошибка в настройках: {setup.error}</p>}
      {setup.missing.length > 0 && <ul className="mt-2 list-disc pl-5 text-[13px]">{setup.missing.map((m) => <li key={m}>{m}</li>)}</ul>}
    </Card>
  );
}

// ---------- Обзор ----------
function RelCard({ v, r, cases, onOpen }: { v: View; r: Rel; cases: number; onOpen: () => void }) {
  const cur = r.slot === "cur";
  const parts = relParts(v, r);
  const rs = revStat(v, r);
  return (
    <button type="button" onClick={onOpen} data-rel-card={r.date}
      className={cn("group flex min-w-0 flex-col rounded-xl border bg-surface-recessed p-4 text-left transition-colors hover:bg-state-hover", cur ? "border-foreground/30" : "border-border-hairline")}>
      <div className="flex w-full items-baseline gap-2">
        <span className="text-[11.5px] font-medium uppercase tracking-wide text-subtle-foreground">{SLOT_LABEL[r.slot] ?? ""} · {MODE_WORD[r.mode]}</span>
        <span className="ml-auto whitespace-nowrap text-xs text-muted-foreground">{relWhen(r)}</span>
      </div>
      <div className="mt-2 flex items-baseline gap-2">
        <span className="text-[15px] font-semibold tabular-nums">{r.name}</span>
        <span className="text-xs text-subtle-foreground">спринт с {r.startLabel}</span>
      </div>
      <div className="mt-2.5 flex items-baseline gap-2">
        <span className={cn("font-semibold leading-none tabular-nums tracking-tight", cur ? "text-[40px]" : "text-[32px]")}>{relGood(r)}</span>
        <span className="text-[13px] text-muted-foreground">из {r.rows.length} {plural(r.rows.length, "эпика", "эпиков", "эпиков")} {GOOD[r.mode]?.[1]}</span>
      </div>
      <StackBar parts={parts} h={cur ? 10 : 8} className="mt-3" />
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-0.5">
        {parts.filter((p) => p.n > 0).map((p) => <Badge key={p.k} tone={p.tone} className="text-xs text-muted-foreground">{p.label} <span className="tabular-nums text-foreground">{p.n}</span></Badge>)}
      </div>
      <div className="mt-auto flex w-full flex-wrap items-baseline gap-x-3 gap-y-0.5 pt-3 text-xs text-subtle-foreground">
        {rs && <span>выручка фич <span className="tabular-nums text-foreground">{signed(rs.total)}</span> тыс./мес{rs.wont > 0 && <span className="text-destructive-text"> · под угрозой {rs.wont}</span>}</span>}
        <span>вне нормы <span className="tabular-nums text-foreground">{cases}</span></span>
        <span className="ml-auto inline-flex items-center text-muted-foreground group-hover:text-foreground">открыть<Icon name="ChevronRight" className="size-3.5" /></span>
      </div>
    </button>
  );
}
function HomeTab({ v, d, openRel, openCase, goIssues, goBot }: { v: View; d: any; openRel: (date: string) => void; openCase: (id: string, ids: string[]) => void; goIssues: (p: IssuesPreset | null) => void; goBot: () => void }) {
  const act: Anom[] = useMemo(() => (v.anomalies as Anom[]).filter((a) => !a.ack), [v]);
  // сначала серьёзные и новые; известные до срока не показываем — ими уже занимаются
  const top = useMemo(() => act.filter((a) => a.known?.state !== "known").slice().sort((a, b) => b.sev - a.sev || Number(b.isNew) - Number(a.isNew) || (a.prio ?? 999) - (b.prio ?? 999) || Number(isEpicCase(b)) - Number(isEpicCase(a))).slice(0, 8), [act]);
  const ids = top.map((a) => a.id);
  const groups = Object.entries(v.meta.groups as Record<string, string>);
  const nNew = act.filter((a) => a.isNew).length, nEpic = act.filter(isEpicCase).length;
  const asks = openAsks(d);
  const p = d?.panel, bot = d?.bot;
  const sum = (k: string) => ((p?.rels ?? []) as any[]).reduce((s, r) => s + (r[k] ?? 0), 0);
  const tg = v.tg;
  return (
    <div className="space-y-6">
      {(v.releases as Rel[]).length === 0 ? <Empty>Релизов нет — проверьте версии продукта в Jira.</Empty> : (
        <div className="grid gap-3 @3xl:grid-cols-3">
          {(v.releases as Rel[]).map((r) => <RelCard key={r.date} v={v} r={r} cases={act.filter((a) => a.rel === r.date).length} onOpen={() => openRel(r.date)} />)}
        </div>
      )}

      <div className="grid gap-x-8 gap-y-6 @4xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0">
          {asks.length > 0 && (
            <div className="mb-5 rounded-xl bg-surface-attention px-4 py-3">
              <div className="flex items-center gap-2 text-[13.5px] font-semibold">
                <Icon name="MessageSquare" className="size-4 text-warning-text" />
                {asks.length} {plural(asks.length, "вопрос", "вопроса", "вопросов")} ПМ {plural(asks.length, "ждёт", "ждут", "ждут")} ответа в боте
                <span className="ml-auto"><LinkBtn onClick={goBot}>Бот</LinkBtn></span>
              </div>
              <ul className="mt-1.5 space-y-0.5 text-[12.5px]">
                {asks.slice(0, 4).map((x: any) => (
                  <li key={x.id} className="flex min-w-0 items-baseline gap-2">
                    {x.key ? <Key k={x.key} url={x.url} /> : null}
                    <span className="min-w-0 truncate">{x.label}</span>
                    <span className="ml-auto shrink-0 text-xs text-subtle-foreground">@{x.by} · {dt(x.at)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <Head n={`${top.length} из ${act.length}`} right={<LinkBtn onClick={() => goIssues(null)}>Все кейсы</LinkBtn>}>Сначала это</Head>
          {top.length === 0 ? <Empty>Кейсов вне нормы нет.</Empty> : (
            <div className="divide-y divide-border-hairline rounded-xl border border-border-hairline px-1 py-1">
              {top.map((a) => <CaseRow key={a.id} a={a} mode="flat" onOpen={() => openCase(a.id, ids)} />)}
            </div>
          )}
          <p className="mt-2 px-1 text-xs text-subtle-foreground">Самые серьёзные кейсы, новые — выше. Известные проблемы со сроком сюда не попадают.</p>
        </div>

        <div className="min-w-0 space-y-5">
          <div>
            <Head n={act.length}>Вне нормы</Head>
            <Card className="p-1">
              {groups.map(([g, title]) => {
                const mine = act.filter((a) => a.group === g), nw = mine.filter((a) => a.isNew).length;
                return (
                  <button key={g} type="button" onClick={() => goIssues({ grp: g })} className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[13px] transition-colors hover:bg-state-hover">
                    <Dot tone={GROUP_TONE[g]} />
                    <span className="min-w-0 flex-1 truncate">{title}</span>
                    {nw > 0 && <Pill tone="warn">+{nw}</Pill>}
                    <span className="w-8 text-right font-semibold tabular-nums">{mine.length}</span>
                    <Icon name="ChevronRight" className="size-3.5 text-subtle-foreground" />
                  </button>
                );
              })}
            </Card>
            <div className="mt-2 flex flex-wrap gap-x-1 gap-y-1 text-[12.5px]">
              <button type="button" onClick={() => goIssues({ onlyNew: true })} className="rounded-md px-2 py-1 text-muted-foreground hover:bg-state-hover hover:text-foreground">Новые со вчера <span className="tabular-nums text-foreground">{nNew}</span></button>
              <button type="button" onClick={() => goIssues({ owner: "epic" })} className="rounded-md px-2 py-1 text-muted-foreground hover:bg-state-hover hover:text-foreground">Эпики <span className="tabular-nums text-foreground">{nEpic}</span></button>
              <button type="button" onClick={() => goIssues({ owner: "task" })} className="rounded-md px-2 py-1 text-muted-foreground hover:bg-state-hover hover:text-foreground">Задачи <span className="tabular-nums text-foreground">{act.length - nEpic}</span></button>
            </div>
          </div>
          <div>
            <Head right={<LinkBtn onClick={goBot}>Открыть</LinkBtn>}>Бот и рассылка</Head>
            <Card className="space-y-2 px-3.5 py-3 text-[12.5px]">
              <div className="flex items-baseline gap-2"><span className="w-[92px] shrink-0 text-subtle-foreground">Бот</span>{!bot ? <span className="text-subtle-foreground">…</span> : bot.running && !bot.error ? <Badge tone="good">слушает</Badge> : <Badge tone="bad">{bot.error ? "ошибка" : "не запущен"}</Badge>}</div>
              <div className="flex items-baseline gap-2"><span className="w-[92px] shrink-0 text-subtle-foreground">Сводка</span><span className="min-w-0">{tg?.lastSent ? `${dt(tg.lastSent.at)}${tg.lastSent.messages != null ? ` · сообщений ${tg.lastSent.messages}` : ""}` : "ещё не уходила"}</span></div>
              {p && <div className="flex items-baseline gap-2"><span className="w-[92px] shrink-0 text-subtle-foreground">У ПМ</span><span className="min-w-0">открыто <b className="tabular-nums">{sum("open")}</b> · ждёт проверки <b className="tabular-nums">{sum("pending")}</b> · не подтвердилось <b className="tabular-nums">{sum("failed")}</b></span></div>}
              {p && <div className="flex items-baseline gap-2"><span className="w-[92px] shrink-0 text-subtle-foreground">Вопросы</span><span className="min-w-0">{asks.length ? <>ждут ответа <b className="tabular-nums">{asks.length}</b></> : "без ответа нет"}</span></div>}
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------- Панель ----------
function ReleasesPanel({ subPath }: PluginNavPanelProps) {
  const rpcRaw = useRpc<typeof rpcContract>();
  const nav = useBbNavigate();
  const [product, setProductState] = useState<string>(readProduct);
  const setProduct = (id: string) => { setProductState(id); try { localStorage.setItem(PROD_KEY, id); } catch { /* нет хранилища */ } };
  // Каждый вызов RPC получает выбранный продукт: вкладки и правки работают по нему.
  const rpc = useMemo(() => ({ ...rpcRaw, call: ((m: any, input: any) => (rpcRaw.call as any)(m, { ...(input ?? {}), product })) as typeof rpcRaw.call }) as Rpc, [rpcRaw, product]);
  const [view, setView] = useState<View | null>(null);
  const [products, setProducts] = useState<Product[]>(PRODUCTS0);
  const [job, setJob] = useState<any>(null);
  const [setup, setSetup] = useState<{ missing: string[]; error: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [pmd, setPmd] = useState<any>(null);
  const [pmErr, setPmErr] = useState<string | null>(null);
  const [sheet, setSheet] = useState<SheetState>(null);
  const [lastRel, setLastRel] = useState<string | null>(null);
  const [relSub, setRelSub] = useState<RelSub>(subPath === "orph" ? "orph" : "epics");
  const [preset, setPreset] = useState<{ p: IssuesPreset | null; n: number }>({ p: null, n: 0 });

  const reload = useCallback(() => {
    rpc.call("load", {}).then((r) => {
      const list = r.products as Product[];
      setProducts0(list); setProducts(list); setSetup(r.setup); setJob(r.job); setError(null);
      // Выбранный продукт пропал из настроек — первый из списка.
      if (list.length && !list.some((p) => p.id === product)) { setProduct(list[0].id); return; }
      setView(r.view);
    }, (e: unknown) => setError(errText(e))).finally(() => setLoading(false));
  }, [rpc]);
  const loadPm = useCallback(() => { rpc.call("pm_load", {}).then((r) => { setPmd(r); setPmErr(null); }, (e: unknown) => setPmErr(errText(e))); }, [rpc]);
  useEffect(() => { reload(); }, [reload]);
  useEffect(() => { setPmd(null); loadPm(); }, [loadPm]);
  useRealtime("job", (p) => {
    const j = p as any;
    setJob(j);
    if (!j.running) { reload(); loadPm(); }
  });
  useRealtime("pm", () => loadPm());
  useEffect(() => {
    if (!job?.running) return;
    const t = setInterval(reload, 4000);
    return () => clearInterval(t);
  }, [job?.running, reload]);
  useEffect(() => { if (!msg) return; const t = setTimeout(() => setMsg(null), 12000); return () => clearTimeout(t); }, [msg]);
  const act: Act = useCallback(async (fn) => {
    try { const r = await fn(); if (!r.ok) setMsg("Ошибка: " + (r.message ?? "")); } catch (e) { setMsg(errText(e)); }
    loadPm();
  }, [loadPm]);

  // ---- адрес вкладки ----
  const sp = subPath ?? "";
  const section: Section = DATE_RE.test(sp) || sp === "rel" || sp === "orph" ? "rel" : sp === "issues" ? "issues" : sp === "bot" ? "bot" : SET_IDS.includes(sp) ? "settings" : "home";
  const go = useCallback((id: string) => nav.toPluginPanel("releases", { subPath: id }), [nav]);
  const rels: Rel[] = view?.releases ?? [];
  const relDate = (DATE_RE.test(sp) && rels.some((r) => r.date === sp) ? sp : lastRel && rels.some((r) => r.date === lastRel) ? lastRel : (rels.find((r) => r.slot === "cur") ?? rels[0])?.date) ?? null;
  const rel = rels.find((r) => r.date === relDate) ?? null;
  useEffect(() => { if (DATE_RE.test(sp)) setLastRel(sp); }, [sp]);
  const setSec: SetSec = sp === "known" || sp === "tg" || sp === "how" ? sp : "pm";
  const prevSection = useRef(section);
  useEffect(() => { if (prevSection.current !== section) { prevSection.current = section; setSheet(null); } }, [section]);
  const openRel = (date: string) => { setRelSub("epics"); go(date); };
  const goIssues = (p: IssuesPreset | null) => { setPreset((x) => ({ p, n: x.n + 1 })); go("issues"); };

  const nIssues = view ? (view.anomalies as Anom[]).filter((a) => !a.ack).length : undefined;
  const nAsks = openAsks(pmd).length;
  const NAV: { id: Section; to: string; label: string; n?: number; alert?: boolean }[] = [
    { id: "home", to: "home", label: "Обзор" },
    { id: "rel", to: relDate ?? "rel", label: "Релиз" },
    { id: "issues", to: "issues", label: "Вне нормы", n: nIssues },
    { id: "bot", to: "bot", label: "Бот", n: nAsks || undefined, alert: nAsks > 0 },
    { id: "settings", to: "pm", label: "Настройки" },
  ];

  // ---- боковая карточка ----
  let sheetEl = null;
  if (view && sheet?.t === "epic") {
    const r = rels.find((x) => x.date === sheet.date);
    const x = r?.rows.find((y: any) => y.key === sheet.key);
    if (r && x) {
      const keys = sheet.keys.filter((k) => r.rows.some((y: any) => y.key === k));
      const i = keys.indexOf(sheet.key);
      const to = (k: string | undefined) => (k ? () => setSheet({ ...sheet, key: k }) : undefined);
      sheetEl = <EpicSheet v={view} r={r} x={x} rpc={rpc} reload={reload} onMsg={setMsg} onClose={() => setSheet(null)} onPrev={to(keys[i - 1])} onNext={to(keys[i + 1])} pos={keys.length > 1 ? `${i + 1} из ${keys.length}` : undefined} />;
    }
  } else if (view && sheet?.t === "case") {
    const all = view.anomalies as Anom[];
    const a = all.find((y) => y.id === sheet.id);
    if (a) {
      const ids = sheet.ids.filter((id) => all.some((y) => y.id === id));
      const i = ids.indexOf(sheet.id);
      const to = (id: string | undefined) => (id ? () => setSheet({ ...sheet, id }) : undefined);
      sheetEl = <CaseSheet v={view} a={a} rpc={rpc} reload={reload} onMsg={setMsg} onClose={() => setSheet(null)} onPrev={to(ids[i - 1])} onNext={to(ids[i + 1])} pos={ids.length > 1 ? `${i + 1} из ${ids.length}` : undefined}
        openEpic={(date, key) => setSheet({ t: "epic", date, key, keys: [key] })} />;
    }
  }
  const prod = products.find((p) => p.id === product);

  return (
    <div className="rl-root relative flex h-full min-h-0 flex-col">
      <style>{REL_CSS}</style>
      <header className="shrink-0 border-b border-border-seam px-5">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 pt-3">
          <h2 className="text-[15px] font-semibold leading-tight tracking-tight">Релизы</h2>
          <div role="radiogroup" aria-label="Продукт" className="flex items-center rounded-lg border border-border-hairline p-0.5">
            {products.map((p) => (
              <button key={p.id} type="button" role="radio" aria-checked={product === p.id} title={`${p.name}: кейсов вне нормы ${p.open ?? "—"}`}
                onClick={() => { if (p.id !== product) { setView(null); setLoading(true); setSheet(null); setProduct(p.id); } }}
                className={cn("rounded-md px-2.5 py-1 text-[13px] transition-colors", product === p.id ? "bg-state-active font-medium text-foreground" : "text-muted-foreground hover:text-foreground")}>
                {p.emoji} {p.short}{p.open != null && <span className="ml-1.5 tabular-nums text-subtle-foreground">{p.open}</span>}
              </button>
            ))}
          </div>
          <div className="ml-auto flex min-w-0 items-center gap-2">
            <p className="min-w-0 truncate text-xs text-muted-foreground">
              {job?.running ? <>Обновляю: {job.log[job.log.length - 1] ?? "старт"}</> : view ? <>Jira · {view.generatedLabel}</> : "…"}
              {!job?.running && job?.error && <span className="text-destructive-text"> · ошибка обновления: {job.error}</span>}
              {!job?.running && job?.telegram && <> · Telegram: {job.telegram}</>}
            </p>
            {view?.stale && !job?.running && <Pill tone="warn" title="Данные собраны не сегодня — нажмите «Обновить»">данные не за сегодня</Pill>}
            <Button variant="ghost" size="sm" disabled={!!job?.running} onClick={() => void rpc.call("refresh", {}).then(setJob)} aria-label="Обновить из Jira">
              <Icon name="RotateCcw" /> {job?.running ? "Обновляю…" : "Обновить"}
            </Button>
            <Button variant="ghost" size="icon" onClick={() => void rpc.call("open_folder", {})} aria-label="Открыть папку данных">
              <Icon name="FolderOpen" />
            </Button>
          </div>
        </div>
        <nav role="tablist" aria-label={`Релизы ${prod?.name ?? ""}`} className="mt-2 flex flex-wrap gap-x-6">
          {NAV.map((t) => (
            <button key={t.id} type="button" role="tab" aria-selected={section === t.id} onClick={() => go(t.to)}
              className={cn("-mb-px inline-flex items-center gap-1.5 border-b-2 pb-2 pt-1.5 text-[13.5px] transition-colors", section === t.id ? "border-foreground font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}>
              {t.label}
              {t.alert ? <Pill tone="warn">{t.n}</Pill> : t.n != null && <span className="tabular-nums text-subtle-foreground">{t.n}</span>}
            </button>
          ))}
        </nav>
      </header>
      <main className="min-h-0 flex-1 overflow-y-auto">
        <div className="@container mx-auto w-full max-w-[1320px] px-5 py-5">
          {error && <p className="mb-4 text-sm text-destructive-text">{error}</p>}
          {setup && (setup.error || setup.missing.length > 0) && <SetupHint setup={setup} />}
          {!view && !error && <p className="text-sm text-muted-foreground">{loading ? "Загружаю…" : job?.running ? "Обновление из Jira, около минуты на продукт…" : "Данных нет — нажмите «Обновить»."}</p>}
          {view && section === "home" && <HomeTab key={product} v={view} d={pmd} openRel={openRel} openCase={(id, ids) => setSheet({ t: "case", id, ids })} goIssues={goIssues} goBot={() => go("bot")} />}
          {view && section === "rel" && (rel
            ? <ReleaseTab key={product + rel.date} v={view} r={rel} rpc={rpc} reload={reload} pick={(d) => go(d)} sub={relSub} setSub={setRelSub} openEpic={(key, keys) => setSheet({ t: "epic", date: rel.date, key, keys })} />
            : <Empty>Релизов нет — проверьте версии продукта в Jira.</Empty>)}
          {view && section === "issues" && <IssuesTab key={product + preset.n} v={view} preset={preset.p} openCase={(id, ids) => setSheet({ t: "case", id, ids })} />}
          {view && (section === "bot" || section === "settings") && pmErr && !pmd && <p className="mb-4 text-sm text-destructive-text">{pmErr}</p>}
          {view && section === "bot" && <BotTab key={product} d={pmd} goSettings={() => go("pm")} />}
          {view && section === "settings" && <SettingsTab key={product} v={view} d={pmd} sec={setSec} setSec={(s) => go(s)} rpc={rpc} act={act} reload={reload} onMsg={setMsg} />}
        </div>
      </main>
      {sheetEl}
      {msg && (
        <div role="status" className="pointer-events-none absolute inset-x-0 bottom-4 z-40 flex justify-center px-4">
          <div className="pointer-events-auto flex max-w-[640px] items-start gap-2 rounded-lg border border-border bg-background px-3 py-2 text-[13px] shadow-[0_8px_30px_rgba(0,0,0,0.35)]">
            <Icon name="Info" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0">{msg}</div>
            <button type="button" aria-label="Закрыть сообщение" onClick={() => setMsg(null)} className="ml-1 shrink-0 rounded px-1 text-[15px] leading-none text-muted-foreground hover:text-foreground">×</button>
          </div>
        </div>
      )}
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "releases",
    title: "Релизы",
    icon: "Rocket",
    path: "releases",
    component: ReleasesPanel,
  });
});
