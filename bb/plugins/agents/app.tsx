// Agents — sidebar panel and homepage widget for Claude Code subagents:
// list, enable/disable, edit, create, delete, and start a thread with one.
import { useCallback, useEffect, useMemo, useState } from "react";
import { definePluginApp, useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import type { PluginHomepageSectionProps, PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import type { Agent, rpcContract } from "./server";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

const PANEL_PATH = "agents";
const MODELS = [
  { value: "", label: "Как у родителя" },
  { value: "haiku", label: "Haiku" },
  { value: "sonnet", label: "Sonnet" },
  { value: "opus", label: "Opus" },
  { value: "fable", label: "Fable" },
];
const EFFORTS = ["", "low", "medium", "high", "xhigh", "max"];
const FIELD =
  "w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

type Draft = Omit<Agent, "file" | "enabled" | "updatedAt">;
const EMPTY: Draft = {
  name: "",
  description: "",
  model: "sonnet",
  effort: "medium",
  tools: "Read, Write, Edit, Glob, Grep",
  omitClaudeMd: false,
  extra: "",
  body: "Ты — ...\n\n## Задача\n\n## Правила\n",
};

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function useAgents() {
  const rpc = useRpc<typeof rpcContract>();
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(
    () =>
      rpc.call("list", {}).then(
        (r) => {
          setAgents(r.agents);
          setError(null);
        },
        (e: unknown) => setError(errText(e)),
      ),
    [rpc],
  );
  useEffect(() => {
    void reload();
  }, [reload]);
  return { rpc, agents, error, reload };
}

function ModelBadge({ agent }: { agent: Pick<Agent, "model" | "effort"> }) {
  return (
    <span className="shrink-0 rounded bg-secondary px-1.5 py-0.5 text-[11px] text-secondary-foreground">
      {agent.model || "inherit"}
      {agent.effort ? ` · ${agent.effort}` : ""}
    </span>
  );
}

function Toggle({ on, onChange, disabled }: { on: boolean; onChange: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      title={on ? "Включён — выключить" : "Выключен — включить"}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onChange();
      }}
      className={cn(
        "relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:opacity-50",
        on ? "bg-foreground" : "bg-muted-foreground/30",
      )}
    >
      <span
        className={cn(
          "absolute top-0.5 size-4 rounded-full bg-background transition-all",
          on ? "left-[18px]" : "left-0.5",
        )}
      />
    </button>
  );
}

function Label({ children, hint }: { children: string; hint?: string }) {
  return (
    <div className="mb-1 flex items-baseline gap-2">
      <span className="text-xs font-medium">{children}</span>
      {hint ? <span className="text-[11px] text-muted-foreground">{hint}</span> : null}
    </div>
  );
}

function Editor({
  agent,
  onSaved,
  onDeleted,
  onToggle,
}: {
  agent: Agent | null;
  onSaved: (file: string) => void;
  onDeleted: () => void;
  onToggle: (a: Agent) => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const nav = useBbNavigate();
  const initial: Draft = useMemo(() => {
    if (!agent) return EMPTY;
    const { file: _f, enabled: _e, updatedAt: _u, ...rest } = agent;
    return rest;
  }, [agent]);
  const [draft, setDraft] = useState<Draft>(initial);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => {
    setDraft(initial);
    setMsg(null);
  }, [initial]);

  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => ({ ...d, [key]: value }));

  const save = () => {
    setBusy(true);
    rpc
      .call("save", { original: agent ? { file: agent.file, enabled: agent.enabled } : null, draft })
      .then(
        (r) => {
          setMsg({ ok: true, text: "Сохранено" });
          onSaved(r.file);
        },
        (e: unknown) => setMsg({ ok: false, text: errText(e) }),
      )
      .finally(() => setBusy(false));
  };

  const remove = () => {
    if (!agent || !window.confirm(`Удалить агента ${agent.name}? Файл уйдёт в ~/.claude/agents-trash`)) return;
    setBusy(true);
    rpc
      .call("remove", { file: agent.file, enabled: agent.enabled })
      .then(onDeleted, (e: unknown) => setMsg({ ok: false, text: errText(e) }))
      .finally(() => setBusy(false));
  };

  const run = () =>
    nav.toCompose({
      initialPrompt: `Запусти субагента ${draft.name}: `,
      focusPrompt: true,
    });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-5 py-3">
        <div className="mr-auto min-w-0">
          <div className="truncate text-base font-semibold">{agent ? agent.name : "Новый агент"}</div>
          {agent ? (
            <div className="text-[11px] text-muted-foreground">
              {agent.enabled ? "Включён" : "Выключен"} · изменён {new Date(agent.updatedAt).toLocaleString("ru-RU")}
            </div>
          ) : null}
        </div>
        {agent ? (
          <>
            <Button variant="outline" size="sm" onClick={run} disabled={!agent.enabled} aria-label="Новый тред с этим агентом">
              <Icon name="Play" className="size-3.5" />
              Запустить
            </Button>
            <Button variant="outline" size="sm" onClick={() => onToggle(agent)} disabled={busy}>
              <Icon name={agent.enabled ? "PowerOff" : "Power"} className="size-3.5" />
              {agent.enabled ? "Выключить" : "Включить"}
            </Button>
            <Button variant="ghost" size="sm" onClick={remove} disabled={busy} className="text-destructive">
              <Icon name="Trash2" className="size-3.5" />
              Удалить
            </Button>
          </>
        ) : null}
        <Button size="sm" onClick={save} disabled={busy || !dirty}>
          <Icon name="Save" className="size-3.5" />
          {agent ? "Сохранить" : "Создать"}
        </Button>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
        {msg ? (
          <p role={msg.ok ? "status" : "alert"} className={cn("text-xs", msg.ok ? "text-muted-foreground" : "text-destructive")}>
            {msg.text}
          </p>
        ) : null}
        <div className="grid gap-4 md:grid-cols-[1fr_160px_140px]">
          <div>
            <Label hint="латиница, дефис">Имя</Label>
            <Input value={draft.name} onChange={(e) => set("name", e.target.value)} placeholder="my-agent" />
          </div>
          <div>
            <Label>Модель</Label>
            <select className={FIELD} value={draft.model} onChange={(e) => set("model", e.target.value)}>
              {MODELS.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
              {MODELS.some((m) => m.value === draft.model) ? null : <option value={draft.model}>{draft.model}</option>}
            </select>
          </div>
          <div>
            <Label>Усилие</Label>
            <select className={FIELD} value={draft.effort} onChange={(e) => set("effort", e.target.value)}>
              {EFFORTS.map((v) => (
                <option key={v} value={v}>
                  {v || "по умолчанию"}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div>
          <Label hint="по нему Claude решает, когда звать агента">Описание</Label>
          <textarea className={FIELD} rows={3} value={draft.description} onChange={(e) => set("description", e.target.value)} />
        </div>
        <div>
          <Label hint="через запятую; пусто = все инструменты">Инструменты</Label>
          <textarea className={cn(FIELD, "font-mono text-xs")} rows={2} value={draft.tools} onChange={(e) => set("tools", e.target.value)} />
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={draft.omitClaudeMd} onChange={(e) => set("omitClaudeMd", e.target.checked)} />
          Не подгружать CLAUDE.md (экономит токены)
        </label>
        <div>
          <Label hint="системный промпт агента, Markdown">Инструкция</Label>
          <textarea
            className={cn(FIELD, "min-h-[320px] font-mono text-xs leading-relaxed")}
            value={draft.body}
            onChange={(e) => set("body", e.target.value)}
          />
        </div>
        {draft.extra ? (
          <div>
            <Label hint="прочие поля frontmatter, сохраняются как есть">Доп. поля</Label>
            <textarea className={cn(FIELD, "font-mono text-xs")} rows={2} value={draft.extra} onChange={(e) => set("extra", e.target.value)} />
          </div>
        ) : null}
      </div>
    </div>
  );
}

function AgentsPanel({ subPath }: PluginNavPanelProps) {
  const { rpc, agents, error, reload } = useAgents();
  const nav = useBbNavigate();
  const [query, setQuery] = useState("");
  const [toggleErr, setToggleErr] = useState<string | null>(null);
  const selected = subPath === "new" ? null : agents?.find((a) => a.file === subPath) ?? null;
  const select = (sub: string) => nav.toPluginPanel(PANEL_PATH, { subPath: sub });

  useEffect(() => {
    if (agents?.length && subPath !== "new" && !agents.some((a) => a.file === subPath)) {
      nav.toPluginPanel(PANEL_PATH, { subPath: agents[0].file, replace: true });
    }
  }, [agents, subPath, nav]);

  const toggle = (a: Agent) =>
    rpc.call("set_enabled", { file: a.file, enabled: !a.enabled }).then(
      () => {
        setToggleErr(null);
        void reload();
      },
      (e: unknown) => setToggleErr(errText(e)),
    );

  const shown = (agents ?? []).filter((a) =>
    `${a.name} ${a.description}`.toLowerCase().includes(query.trim().toLowerCase()),
  );
  const activeCount = agents?.filter((a) => a.enabled).length ?? 0;

  return (
    <div className="flex h-full min-h-0 flex-col md:flex-row">
      <aside className="flex max-h-[45%] min-h-0 flex-col border-b border-border md:max-h-none md:w-80 md:border-b-0 md:border-r">
        <div className="space-y-2 p-3">
          <div className="flex items-center gap-2">
            <div className="mr-auto text-sm font-semibold">
              Агенты{agents ? <span className="ml-1 font-normal text-muted-foreground">{activeCount}/{agents.length}</span> : null}
            </div>
            <Button variant="ghost" size="icon" className="size-8" aria-label="Обновить" onClick={() => void reload()}>
              <Icon name="RefreshCw" className="size-4" />
            </Button>
            <Button variant="ghost" size="icon" className="size-8" aria-label="Открыть папку" onClick={() => void rpc.call("open_folder", {})}>
              <Icon name="FolderOpen" className="size-4" />
            </Button>
            <Button size="sm" onClick={() => select("new")}>
              <Icon name="Plus" className="size-3.5" />
              Новый
            </Button>
          </div>
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Поиск" />
          {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
          {toggleErr ? <p role="alert" className="text-xs text-destructive">{toggleErr}</p> : null}
        </div>
        <ul className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          {agents === null && !error ? <li className="px-2 text-xs text-muted-foreground">Загрузка…</li> : null}
          {agents?.length === 0 ? <li className="px-2 text-xs text-muted-foreground">Агентов нет. Нажми «Новый».</li> : null}
          {shown.map((a) => (
            <li key={a.file}>
              <div
                role="button"
                tabIndex={0}
                onClick={() => select(a.file)}
                onKeyDown={(e) => (e.key === "Enter" ? select(a.file) : null)}
                className={cn(
                  "flex cursor-pointer gap-2 rounded-md px-2 py-2 hover:bg-state-hover",
                  selected?.file === a.file && "bg-state-active",
                  !a.enabled && "opacity-60",
                )}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate text-sm font-medium">{a.name}</span>
                    <ModelBadge agent={a} />
                  </div>
                  <div className="line-clamp-2 text-[11px] text-muted-foreground">{a.description}</div>
                </div>
                <Toggle on={a.enabled} onChange={() => void toggle(a)} />
              </div>
            </li>
          ))}
        </ul>
      </aside>
      {agents && (selected || subPath === "new") ? (
        <Editor
          key={selected?.file ?? "new"}
          agent={selected}
          onSaved={(file) => void reload().then(() => select(file))}
          onDeleted={() => void reload().then(() => select(""))}
          onToggle={(a) => void toggle(a)}
        />
      ) : (
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">Выбери агента слева</div>
      )}
    </div>
  );
}

function AgentsWidget(_props: PluginHomepageSectionProps) {
  const { rpc, agents, error, reload } = useAgents();
  const nav = useBbNavigate();
  if (error) return <p className="text-xs text-destructive">{error}</p>;
  if (!agents) return <p className="text-xs text-muted-foreground">Загрузка…</p>;
  return (
    <div className="space-y-1">
      {agents.map((a) => (
        <div key={a.file} className={cn("flex items-center gap-2 rounded-md px-2 py-1 hover:bg-state-hover", !a.enabled && "opacity-60")}>
          <button
            type="button"
            className="flex min-w-0 flex-1 items-center gap-2 text-left"
            onClick={() => nav.toPluginPanel(PANEL_PATH, { subPath: a.file })}
          >
            <span className="truncate text-sm">{a.name}</span>
            <ModelBadge agent={a} />
          </button>
          <Toggle
            on={a.enabled}
            onChange={() => void rpc.call("set_enabled", { file: a.file, enabled: !a.enabled }).then(reload)}
          />
        </div>
      ))}
      <Button variant="link" size="sm" className="px-2" onClick={() => nav.toPluginPanel(PANEL_PATH)}>
        Управлять агентами →
      </Button>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "agents",
    title: "Агенты",
    icon: "Bot",
    path: PANEL_PATH,
    component: AgentsPanel,
  });
  app.slots.homepageSection({
    id: "agents-widget",
    title: "Мои агенты",
    component: AgentsWidget,
  });
});
