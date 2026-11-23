// Релизы — режим проджект-менеджеров в Telegram-боте плагина (токен бота — в настройках плагина).
// ПМ (логин Telegram в notes.cfg.pms, добавляет PO в панели «Релизы») пишет боту /start и получает меню:
//   «Полный отчёт» — проблемы задач разработки (проект dev) и их эпиков по выбранному релизу, с решением;
//   «Решать по шагам» — по одной проблеме: задача, что не так, как решить, кнопки Решено / Пропустить / Стоп.
// «Решено» пишется в журнал (pm-log.jsonl) и в заявки (pm-claims.json). После следующего обновления из Jira
// заявка проверяется: проблемы нет — «подтверждено», осталась — «не решено» (ПМ получает итог проверки).
// Режим продакта: логины в notes.cfg.pos (вкладка «Доступы» панели, отдельно от ПМ). Меню продакта:
//   «Ждут моего решения» — вопросы ПМ (кнопка «Нужно решение продакта»): карточка уходит всем продактам, засчитывается первый ответ;
//   «Мои эпики» — проблемы эпиков (проект epic) по релизам: отчёт и шаги;
//   «Готовность релиза» — эпики следующего релиза, не готовые к разработке (требования, QA-анализ, дизайн, задачи разработки).
// Бот в Jira ничего не пишет — только напоминает и проверяет после обновления.
// После «Решено» ПМ может оставить комментарий (необязательно). Проблема в Jira осталась, а комментарий есть —
// ИИ (Claude Haiku через CLI) решает, объясняет ли он особый случай. Да — кейс «принят» и скрыт на 7 дней;
// через 7 дней проблема осталась — кейс возвращается первым и показывает прошлый комментарий ПМ.
// Несколько продуктов (настройка «Продукты»). У логина ПМ и продакта — список продуктов (вкладка «Доступы»).
// Один продукт — меню сразу по нему; несколько — бот сначала спрашивает продукт. Вопрос ПМ уходит продактам его продукта.
// В 10:00 каждый ПМ и продакт с чатом получает по сообщению на каждый свой продукт (morning).
// «Только Jira»: особый случай ПМ описывает комментарием в задаче Jira — причина и срок «до 26.11»,
// или ставит метку (тест-на-проде — 7 дней после релиза, ios-позже — до следующего релиза). core.view считает a.known:
// known — скрыта до срока; long — срок дальше 14 дней, вопрос продакту; overdue — срок прошёл; nodate — срока нет.
// Кнопки ПМ: «✅ Исправил в Jira» (без комментария в боте), «📝 Написал в Jira» (проверка через 3 минуты, бот запоминает имя ПМ в Jira).
// Комментарии в боте и проверка ИИ больше не используются для новых отметок.
// Модуль получает core.mjs параметром; плагин пересоздаёт его после смены настроек.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";

export function createPm(core) {
  const { OUT_DIR, readJson, writeJson, loadNotes, saveNotes, loadData, view, tg, env, h, dd, fdt, isMash, GROUPS, CODES, READY_GAP, prioRank } = core;
  // Продукты из настроек (core.configure); снимок на время жизни модуля.
  const PRODUCTS = core.PRODUCTS;
  const DEV = () => core.projects().dev;
  const PIDS = PRODUCTS.map((x) => x.id);
  const prodById = (id) => PRODUCTS.find((x) => x.id === id) || PRODUCTS[0];
  const idProd = core.idProd || (() => PRODUCTS[0].id);
  const idPre = core.idPre || (() => "");
  const loginProducts = core.loginProducts || (() => [PRODUCTS[0].id]);
  const prodTag = (pid) => { const x = prodById(pid); return `${x.emoji} ${x.short}`; };
  const LOG = path.join(OUT_DIR, "pm-log.jsonl");
  const CLAIMS = path.join(OUT_DIR, "pm-claims.json");
  const STATE = path.join(OUT_DIR, "pm-state.json");
  const ASKS = path.join(OUT_DIR, "pm-asks.json");
  const BTN_REPORT = "📋 Полный отчёт", BTN_STEPS = "🛠 Решать по шагам";
  const BTN_KNOWN = "💬 Известные";
  const BTN_ASKS = "🧭 Ждут моего решения", BTN_MINE = "🗂 Мои эпики", BTN_READY = "🚦 Готовность релиза";
  const INFO = new Set(["moved_out", "added_late", "scope_growth"]); // факты истории: в отчёте «к сведению», в шагах нет
  const EMO = { tail: "🔴", notready: "🟠", scope: "🟡", stuck: "🔵" };

  const log = (rec) => { fs.mkdirSync(OUT_DIR, { recursive: true }); fs.appendFileSync(LOG, JSON.stringify({ t: new Date().toISOString(), ...rec }) + "\n", "utf8"); };
  const loadState = () => { const s = readJson(STATE, {}) || {}; s.offset ||= 0; s.sessions ||= {}; s.chats ||= {}; s.denied ||= []; s.locks ||= {}; s.skipped ||= {}; return s; };
  // ---------- бронь: карточка, показанная ПМ, закреплена за ним, пока он не ответит (или 20 минут тишины) ----------
  const LOCK_MS = 20 * 60e3;
  const lockOf = (st, id) => { const l = st.locks[id]; return l && Date.now() - Date.parse(l.at) < LOCK_MS ? l : null; };
  const lockedByOther = (st, id, user) => { const l = lockOf(st, id); return l && l.by !== user ? l : null; };
  const releaseLocks = (st, user) => { for (const [id, l] of Object.entries(st.locks)) if (l.by === user || Date.now() - Date.parse(l.at) >= LOCK_MS) delete st.locks[id];
    for (const [id, x] of Object.entries(st.skipped)) if (Date.now() - Date.parse(x.at) > 7 * 86400e3) delete st.skipped[id]; };
  const hm = (iso) => fdt(Date.parse(iso)).slice(6);
  const saveState = (s) => writeJson(STATE, s);
  const loadClaims = () => readJson(CLAIMS, {}) || {};
  const saveClaims = (c) => writeJson(CLAIMS, c);
  // Тишина: «принято по комментарию» — кейс не показываем 7 дней. waiting — кейс сейчас не выводим ПМ.
  const QUIET_MS = 7 * 86400e3, COMMENT_WAIT_MS = 15 * 60e3;
  const quiet = (c) => !!c && c.status === "accepted" && Date.now() < Date.parse(c.until);
  const waiting = (c) => !!c && (c.status === "pending" || quiet(c));
  const back = (c) => !!c && (c.status === "failed" || c.status === "reopened");
  // Известные (core.view → a.known). Скрыты от ПМ: known (до срока) и long (ждёт продакта). Первыми: overdue и nodate.
  const kn = (p) => p?.known?.state || null;
  const isKnown = (p) => kn(p) === "known";
  const hidden = (p) => waiting(p.claim) || kn(p) === "known" || kn(p) === "long";
  const firstUp = (p) => back(p.claim) || kn(p) === "overdue" || kn(p) === "nodate";
  const maxDays = () => (core.knownCfg ? core.knownCfg(loadNotes()).maxDays : 14);
  const kSrc = (k) => (k.src === "label" ? `метка «${k.label}»${k.onParent ? ` в ${k.key}` : ""}` : k.src === "bot" ? `срок в боте (@${k.login})${k.text ? `: ${q(k.text)}` : ""}` : `${k.who}${k.onParent ? ` в ${k.key}` : ""}: ${q(k.text)}`);
  const knownLine = (k) => !k ? "" : k.state === "known" ? `💬 известная до ${dd(k.until)} · ${kSrc(k)}`
    : k.state === "long" ? `⏳ срок ${dd(k.until)} — больше ${maxDays()} дней, ждёт решения продакта · ${kSrc(k)}`
    : k.state === "overdue" ? `⏰ срок ${dd(k.until)} прошёл, проблема осталась · ${kSrc(k)}`
    : k.state === "nodate" ? `❗ в Jira комментарий без срока (${k.who}, ${fdt(Date.parse(k.at))}) — допишите в нём «до ДД.ММ»` : "";
  const q = (t) => `«${cut(String(t).replace(/\s+/g, " ").trim(), 300)}»`;
  // ---------- вопросы ПМ к PO (pm-asks.json, ключ — id кейса) ----------
  const loadAsks = () => readJson(ASKS, {}) || {};
  const saveAsks = (a) => writeJson(ASKS, a);
  const liveAsk = (x) => (x && x.status !== "gone" ? x : null);
  const isSummaryChat = (chatId) => chatId != null && chatId === loadNotes().cfg.tg.chatId;
  // Отключённый логин (x.off) остаётся в списке «Доступов» с продуктами и именем в Jira, но доступа к боту у него нет.
  const poLogins = () => loadNotes().cfg.pos.filter((p) => !p.off).map((p) => p.login);
  const offLogin = (user) => !!user && ["pms", "pos"].some((k) => loadNotes().cfg[k].some((p) => p.login === user && p.off));
  // Продукты логина в роли: kind = "pms" | "pos". Нет логина в списке — [].
  const prodsOf = (kind, user) => { const x = loadNotes().cfg[kind].find((p) => p.login === user && !p.off); return x ? loginProducts(x).filter((id) => PIDS.includes(id)) : []; };
  const pmProds = (user) => prodsOf("pms", user), poProds = (user) => prodsOf("pos", user);
  const isPoUser = (user) => !!user && poLogins().includes(user);
  const ANS = { ok: "успеваем", mv: "переносим", no: "отменяем", talk: "обсудить" };
  const ansLabel = (x) => (x.answer?.opt === "mv" ? `переносим в ${x.nx}` : ANS[x.answer?.opt] || "");
  // «Успеваем» — PO принял риск: карточка уходит из шагов ПМ. Остальные ответы возвращают её ПМ первой.
  const askBlocks = (x) => !!x && ((x.status === "open" && !x.auto) || (x.status === "answered" && x.answer?.opt === "ok"));
  const askFirst = (x) => !!x && x.status === "answered" && x.answer?.opt !== "ok";
  const askLine = (x) => !x ? "" : x.status === "open" ? `🧭 ждёт решения продакта с ${fdt(Date.parse(x.at))} (спросил @${x.by})` : x.status === "answered" ? `🧭 @${x.answer.by} ${fdt(Date.parse(x.answer.at))}: ${ansLabel(x)}` : "";
  const normLogin = (s) => String(s || "").trim().replace(/^@/, "").toLowerCase();
  const pmLogins = () => loadNotes().cfg.pms.filter((p) => !p.off).map((p) => p.login);
  const cut = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + "…" : s || "");
  // Текст кейса без повтора названия («Дизайн не готов: …»); короткий остаток (только исполнитель) — оставляем полный текст.
  const bare = (p) => { const r = p.text.startsWith(p.label) ? p.text.slice(p.label.length).replace(/^[:,·\s]+/, "") : ""; return r.length > 25 ? r : p.text; };
  const shortRel = (d) => dd(d) + (d.slice(0, 4) !== String(new Date().getFullYear()) ? "." + d.slice(2, 4) : "");

  // ---------- проблемы для ПМ: задачи разработки и эпики, где есть задачи разработки ----------
  function nextAfter(v, date) {
    const from = date > v.today ? date : v.today;
    return v.moveTargets.find((t) => t.date > from) || v.moveTargets.find((t) => t.date >= from) || null;
  }
  function solution(a, v) {
    const nx = nextAfter(v, a.rel), nxName = nx ? nx.name : "следующий релиз";
    switch (a.code) {
      case "ver_unreleased": return `Закройте или перенесите незакрытые задачи релиза ${a.relName}, затем выпустите версию «${prodById(a.product || idProd(a.id)).name} ${a.relName}» в ${a.vers?.length ? a.vers.map((x) => x.p).join(", ") : DEV()} (Releases → Release).`;
      case "tail_epic": return `Релиз прошёл — нужен конечный статус. Выпущено → эпик в «Выпущено», задачи разработки в Done. Не выпущено → перенесите эпик и незакрытые задачи в ${nxName}. Не нужно → «Отменено».`;
      case "tail_task": return `Релиз прошёл — нужен конечный статус. Выпущена → Done. Не выпущена → перенесите в ${nxName}. Не нужна → отмените.`;
      case "status_lag": return "Все задачи разработки готовы. Переведите эпик в «Готово к выпуску», после релиза — в «Выпущено».";
      case "epic_task_later": return a.rel < v.today
        ? `Релиз эпика ${a.relName} уже прошёл. Выберите одно: 1) фича ещё не вышла — перенесите эпик в ${shortRel(a.laterRel)}; 2) первая версия вышла — перенесите задачу в эпик второй версии с релизом ${shortRel(a.laterRel)}, эпик закройте.`
        : `Выберите одно: 1) фича выходит целиком позже — перенесите эпик в ${shortRel(a.laterRel)}; 2) задача успевает — верните её в ${a.relName}; 3) это вторая версия фичи — перенесите задачу в эпик второй версии с релизом ${shortRel(a.laterRel)}.`;
      case "ver_mismatch": return `Поставьте задачам релиз эпика ${a.relName}. Если задача не для этого релиза — перенесите её в другой эпик.`;
      case "phase_early": return `Эпик ещё до разработки. Уточните у PO срок готовности; не успевает — перенесите эпик и задачи в ${nxName}.`;
      case "design_notready": return `Уточните у дизайнера срок; не успевает к релизу — перенесите эпик и задачи в ${nxName}.`;
      case "no_req": return "Попросите PO заполнить в эпике поле «Ссылка на требования».";
      case "no_tasks": return "Заведите под эпиком задачи разработки или верните эпик на оценку.";
      case "no_assignee": return "Назначьте исполнителя.";
      case "hold": return `Выясните причину паузы. Можно продолжить — верните в работу. Не успевает — перенесите в ${nxName}. Не нужна — отмените.`;
      case "kick": return "Проверьте, что разработчик взял доработку и успевает к релизу; не успевает — перенесите в следующий релиз.";
      case "no_move": return "Уточните у исполнителя, что с задачей, и обновите статус в Jira.";
      case "orphan": return "Задача в релизе, а эпик — нет. Перенесите задачу в релиз эпика, или эпик в этот релиз, или задачу в нужный эпик.";
      case "moved_out": return "Проверьте, что вместе с эпиком перенесены все его задачи разработки.";
      case "added_late": return "Подтвердите с PO, что эпик успевает в релиз; не успевает — перенесите.";
      case "scope_growth": return "Проверьте, что новые задачи успевают; лишние — в следующий релиз.";
      default: return "";
    }
  }
  // Порядок для ПМ (решение PO 17.11): сначала все эпики, потом задачи разработки, в конце версии релиза;
  // внутри — по приоритету Jira (Highest → Lowest). Самый низкий эпик идёт раньше любой задачи. Подписи не выводим.
  const kindOf = (a, mashEpics) => (mashEpics.has(a.key) ? 0 : a.key.startsWith(DEV() + "-") ? 1 : 2);
  const byPriority = (a, b) => a.kind - b.kind || (a.prio ?? 999) - (b.prio ?? 999) || b.sev - a.sev || a.rel.localeCompare(b.rel) || a.key.localeCompare(b.key, "en", { numeric: true });
  function problems(v, data) {
    if (!v || !data) return [];
    const P = core.prodOf ? core.prodOf(data) : undefined;
    const mashEpics = new Set(data.epics.filter((e) => e.tasks.some((t) => isMash(t, P))).map((e) => e.key));
    const claims = loadClaims(), asks = loadAsks();
    return v.anomalies
      .filter((a) => !a.ack && (a.key.startsWith(DEV() + "-") || mashEpics.has(a.key) || (a.code === "ver_unreleased" && (!!DEV() && a.text.includes(DEV())))))
      .map((a) => ({ ...a, kind: kindOf(a, mashEpics), info: INFO.has(a.code), solution: solution(a, v), claim: claims[a.id] || null, ask: liveAsk(asks[a.id]) }))
      .sort(byPriority);
  }
  // PO: все кейсы эпиков, не скрытые в панели. Порядок — по приоритету Jira.
  function poProblems(v, data) {
    if (!v || !data) return [];
    const epics = new Set(data.epics.map((e) => e.key));
    const claims = loadClaims(), asks = loadAsks();
    return v.anomalies
      .filter((a) => !a.ack && epics.has(a.key))
      .map((a) => ({ ...a, kind: 0, info: INFO.has(a.code), claim: claims[a.id] || null, ask: liveAsk(asks[a.id]) }))
      .sort(byPriority);
  }
  // PO: эпики следующего релиза, не готовые к разработке (решение 17.11: требования, QA-анализ, дизайн или «не нужен», задачи разработки).
  const STAGE = { n_req: "требования", n_qa: "QA-анализ", n_design: "дизайн", n_notask: "нет задач разработки" };
  const STAGE_TEXT = { n_req: "Требования не готовы", n_qa: "QA-анализ не готов", n_design: "Дизайн не готов", n_notask: "Нет задач разработки" };
  const GAP_CODES = new Set(["req", "qa", "design", "notask"]);
  const nextRel = (v) => v?.releases.find((r) => r.mode === "plan") || null;
  function readyItems(v, data) {
    const r = nextRel(v);
    if (!r || !data) return [];
    const claims = loadClaims(), ep = new Map(data.epics.map((e) => [e.key, e]));
    return r.rows.filter((x) => READY_GAP.includes(x.res)).map((x) => {
      const id = `${idPre(v.product)}ready:${x.key}:${r.date}`, pr = ep.get(x.key)?.priority || "";
      let gaps = [...new Set((x.reasons || []).filter((z) => GAP_CODES.has(z.c)).map((z) => z.t))];
      if (!gaps.length) gaps = [STAGE_TEXT[x.res]];
      return { id, product: v.product || PRODUCTS[0].id, code: "ready", stage: x.res, key: x.key, url: x.url, title: x.summary, rel: r.date, relName: r.name, label: `Не готов к разработке: ${STAGE[x.res]}`, text: gaps.join("; "), gaps, priority: pr, prio: prioRank(pr, data.priorities || []), sev: 0, kind: 0, info: false, claim: claims[id] || null };
    }).sort((a, b) => (a.prio ?? 999) - (b.prio ?? 999) || READY_GAP.indexOf(a.stage) - READY_GAP.indexOf(b.stage) || a.key.localeCompare(b.key, "en", { numeric: true }));
  }
  const listFor = (role, v, data) => (role === "po" ? poProblems(v, data) : role === "ready" ? readyItems(v, data) : problems(v, data));
  const relList = (list) => [...new Set(list.map((p) => p.rel))].sort();
  const relLabel = (v, date) => { const r = v.releases.find((x) => x.date === date); return shortRel(date) + (r ? ` · ${{ fact: "итог", forecast: "текущий", plan: "следующий" }[r.mode]}` : date < v.today ? " · прошёл" : ""); };
  const claimLine = (c) => !c ? "" : c.status === "pending" ? `⏳ отмечено решённой ${fdt(Date.parse(c.at))} (@${c.by}), ждёт проверки${c.comment ? `: ${q(c.comment)}` : ""}`
    : c.status === "failed" ? `❗ отмечали решённой ${fdt(Date.parse(c.at))} (@${c.by}), но в Jira проблема осталась${c.comment ? `. Комментарий: ${q(c.comment)}${c.verdict?.why ? ` — не принят: ${c.verdict.why}` : ""}` : ""}`
    : c.status === "reopened" ? `↩️ @${c.by} ${fdt(Date.parse(c.at))} отметил решённой: ${q(c.comment)}. Прошла неделя — проблема осталась`
    : quiet(c) ? `💬 отмечено решённой ${fdt(Date.parse(c.at))} (@${c.by}): ${q(c.comment)}. Скрыто до ${fdt(Date.parse(c.until)).slice(0, 5)}` : "";

  // ---------- тексты ----------
  // Подробности под коротким названием: детали кейса без повтора названия, срок релиза, список задач.
  function problemText(p, v) {
    let d = p.text.startsWith(p.label) ? p.text.slice(p.label.length).replace(/^[:,·\s]+/, "") : p.text;
    if (/^(на паузе|возврат)/i.test(p.label) && d && !/\s(в|с|по)\s/.test(d)) d = "Исполнитель: " + d;
    const r = v.releases.find((x) => x.date === p.rel);
    const when = !p.rel || /прош[её]л/.test(d) ? "" : p.rel < v.today ? `Релиз ${p.relName} уже прошёл.` : r && r.mode !== "fact" ? `До релиза ${p.relName} ${r.workdaysLeft} раб. дн.` : `Релиз ${p.relName}.`;
    const dot = (x) => x.replace(/[.\s]*$/, ".");
    return [d ? dot(d.charAt(0).toUpperCase() + d.slice(1)) : "", when, p.more ? dot(p.more) : ""].filter(Boolean).join(" ");
  }
  function itemText(p, i, v, st) {
    const L = [`${i}. ${p.key ? `<a href="${p.url}">${p.key}</a> ${h(cut(p.title, 70))}` : p.code === "ver_unreleased" ? subject(p) : h(cut(p.title, 70))}`, `   ❗ <b>${h(p.label)}</b>`, `   ${h(problemText(p, v))}`];
    const c = claimLine(p.claim);
    if (c) L.push(`   ${c}`);
    if (p.known) L.push(`   ${h(knownLine(p.known))}`);
    const al = askLine(p.ask);
    if (al) L.push(`   ${h(al)}`);
    const l = st && p.claim?.status !== "pending" ? lockOf(st, p.id) : null;
    if (l) L.push(`   🔒 разбирает @${h(l.by)} с ${hm(l.at)}`);
    return L.join("\n");
  }
  function reportMessages(v, data, date, role = "pm") {
    const st = loadState();
    const list = listFor(role, v, data).filter((p) => p.rel === date);
    const shh = (p) => quiet(p.claim) || (!waiting(p.claim) && hidden(p));
    const hush = list.filter(shh), fix = list.filter((p) => !p.info && !shh(p)), info = list.filter((p) => p.info && !shh(p));
    const head = `<b>${prodTag(v.product)} · релиз ${relLabel(v, date)} — проблемы ${role === "po" ? "эпиков" : "задач разработки"}: ${fix.length}</b>\nJira на ${v.generatedLabel}${v.stale ? " (не сегодня)" : ""}`;
    const parts = [head];
    if (!list.length) parts.push("Проблем нет.");
    let n = 0;
    for (const [g, title] of Object.entries(GROUPS)) {
      const gl = fix.filter((p) => p.group === g);
      if (!gl.length) continue;
      parts.push(`\n${EMO[g]} <b>${title} — ${gl.length}</b>`);
      for (const p of gl) parts.push(itemText(p, ++n, v, st));
    }
    if (info.length) {
      parts.push(`\nℹ️ <b>К сведению — ${info.length}</b>`);
      for (const p of info) parts.push(itemText(p, ++n, v, st));
    }
    if (hush.length) {
      parts.push(`\n💬 <b>Известные — ${hush.length}</b> · причина и срок в Jira, делать ничего не нужно`);
      for (const p of hush) parts.push(`• ${p.key ? `<a href="${p.url}">${p.key}</a> ` : ""}${h(p.label)} · ${quiet(p.claim) ? `@${h(p.claim.by)}: ${h(q(p.claim.comment))} · до ${fdt(Date.parse(p.claim.until)).slice(0, 5)}` : h(knownLine(p.known))}`);
    }
    if (fix.length && role === "pm") parts.push(`\nРешать по одной — кнопка «${BTN_STEPS}».`);
    return chunks(parts);
  }
  const chunks = (parts) => {
    const msgs = []; let cur = "";
    for (const part of parts) {
      if (cur && cur.length + part.length + 2 > 3900) { msgs.push(cur); cur = ""; }
      cur += (cur ? "\n" : "") + part;
    }
    if (cur) msgs.push(cur);
    return msgs;
  };
  // PO: готовность следующего релиза одним сообщением (или несколькими, если длинно).
  function readyReport(v, data) {
    const r = nextRel(v);
    if (!r) return ["Следующего релиза в данных нет."];
    const list = readyItems(v, data);
    const when = r.startDaysLeft > 0 ? `через ${r.startWorkdaysLeft} раб. дн.` : r.startDaysLeft === 0 ? "сегодня" : "уже идёт";
    const parts = [`🚦 <b>${prodTag(v.product)} · Готовность ${r.name}</b> · старт спринта ${r.startLabel} (${when})\nJira на ${v.generatedLabel}${v.stale ? " (не сегодня)" : ""}`,
      `\nНе готовы к разработке: <b>${list.length} из ${r.rows.length}</b>`];
    for (const g of READY_GAP) {
      const gl = list.filter((p) => p.stage === g);
      if (!gl.length) continue;
      parts.push(`\n<b>${STAGE_TEXT[g]} — ${gl.length}</b>`);
      for (const p of gl) parts.push(`• ${p.claim?.status === "pending" ? "⏳ " : p.claim?.status === "failed" ? "❗ " : ""}<a href="${p.url}">${p.key}</a> ${h(cut(p.title, 55))}`);
    }
    if (list.length) parts.push(`\nНе успевает к старту — перенесите эпик в Jira сами: бот только напоминает.`);
    return chunks(parts);
  }
  function readyCard(p, i, total, v) {
    const r = nextRel(v), nx = nextAfter(v, p.rel);
    const when = !r ? "" : r.startDaysLeft > 0 ? `, через ${r.startWorkdaysLeft} раб. дн.` : r.startDaysLeft === 0 ? ", сегодня" : ", уже идёт";
    const L = [`<b>${prodTag(v.product)} · Готовность ${p.relName} · шаг ${i + 1} из ${total}</b>${r ? ` · старт спринта ${r.startLabel}${when}` : ""}`, ""];
    L.push(`<b>Эпик:</b> <a href="${p.url}">${p.key}</a> ${h(cut(p.title, 90))}`);
    L.push("", "<b>Не хватает:</b>", ...p.gaps.map((g) => `• ${h(g)}`));
    if (p.claim?.status === "failed") L.push("", `❗ отмечали готовым ${fdt(Date.parse(p.claim.at))}, но в Jira эпик ещё не готов`);
    L.push("", `Сделали в Jira — «Готово», проверю после обновления. Не успевает — перенесите эпик в ${nx ? nx.name : "следующий релиз"} в Jira.`);
    return L.join("\n");
  }
  // Что за объект: задача/эпик со ссылкой или версия релиза по проектам (у кейса версии нет ключа).
  const subject = (p, n = 90) => p.key ? `<b>Задача:</b> <a href="${p.url}">${p.key}</a> ${h(cut(String(p.title || "").trim(), n))}`
    : p.vers?.length ? `<b>Версия:</b> ${h(p.vname || p.relName)} · ${p.vers.map((x) => `<a href="${x.url}">${x.p}</a>`).join(", ")}`
    : p.code === "ver_unreleased" ? `<b>Версия:</b> ${h(p.relName)}` : "<b>Задача:</b> —";
  function cardText(p, i, total, v, st, user) {
    const L = [`<b>Шаг ${i + 1} из ${total}</b> · ${prodTag(v.product)} · релиз ${relLabel(v, p.rel)}`, ""];
    L.push(subject(p));
    L.push("", `<b>Проблема:</b> ${h(p.label)}`, h(problemText(p, v)));
    if (p.solution) L.push("", `<b>Как решить:</b> ${h(p.solution)}`);
    // История: только последняя отметка «Решено» (pm-claims.json хранит одну, последнюю). Пропуски не показываем.
    const c = p.claim;
    if (c && back(c)) L.push("", h(claimLine(c)));
    else if (c && c.status !== "pending") L.push("", `↩️ отмечали решённой ${fdt(Date.parse(c.at))} (@${h(c.by)})${c.comment ? `: ${h(q(c.comment))}` : ""}, проблема появилась снова`);
    if (p.known && kn(p) !== "known") L.push("", h(knownLine(p.known)));
    if (p.ask?.status === "answered") L.push("", `🧭 <b>Решение @${h(p.ask.answer.by)}</b> ${fdt(Date.parse(p.ask.answer.at))}: ${h(ansLabel(p.ask))}${p.ask.answer.opt === "talk" ? ` — напишите @${h(p.ask.answer.by)}` : ""}`);
    return L.join("\n");
  }

  // ---------- Telegram ----------
  const send = (chat_id, text, extra = {}) => tg("sendMessage", { chat_id, text, parse_mode: "HTML", disable_web_page_preview: true, ...extra });
  // Нет ни одной роли — убираем старую клавиатуру (доступ забрали).
  const menuFor = (pmRole, poRole) => (!pmRole && !poRole ? { remove_keyboard: true } : { keyboard: [...(poRole ? [[{ text: BTN_ASKS }], [{ text: BTN_MINE }, { text: BTN_READY }]] : []), ...(pmRole ? [[{ text: BTN_REPORT }, { text: BTN_STEPS }]] : []), [{ text: BTN_KNOWN }, { text: BTN_EDU_MENU }]], resize_keyboard: true, is_persistent: true });
  const menuOf = (chatId, user) => menuFor(!!user && pmLogins().includes(user), isPoUser(user));
  const fresh = (pid = PRODUCTS[0].id) => { const data = loadData(pid); return { data, v: view(data, undefined, undefined, { claims: loadClaims(), asks: loadAsks() }) }; };
  // Выбор продукта: один — сразу дальше, несколько — кнопки «🏠 Продукт B · N». act: rep | st | mine | ready.
  const ACT_Q = { rep: "Отчёт по какому продукту?", st: "Какой продукт разбираем?", mine: "Эпики какого продукта?", ready: "Готовность какого продукта?" };

  // Свободно для ПМ: не «ждёт проверки» и не забронировано другим.
  const isFree = (p, st, user) => !p.info && !hidden(p) && !askBlocks(p.ask) && !lockedByOther(st, p.id, user);
  function releaseButtons(v, list, prefix, withAll, st, user) {
    const isRep = prefix === "rep" || prefix === "prep";
    const rels = relList(list.filter((p) => isRep || !p.info));
    const rows = rels.map((d) => {
      const n = list.filter((p) => p.rel === d && (isRep ? !p.info && !quiet(p.claim) && !hidden(p) : isFree(p, st, user))).length;
      return [{ text: `${relLabel(v, d)} · ${n}`, callback_data: `${prefix}:${d}:${v.product || PRODUCTS[0].id}` }];
    });
    if (withAll && rels.length > 1) rows.unshift([{ text: `Все релизы · ${list.filter((p) => isFree(p, st, user)).length}`, callback_data: `${prefix}:all:${v.product || PRODUCTS[0].id}` }]);
    return { inline_keyboard: rows };
  }
  function queueFor(list, rel) {
    const rank = (p) => (firstUp(p) || askFirst(p.ask) ? 0 : 1);
    return list
      .filter((p) => !p.info && (rel === "all" || p.rel === rel) && !hidden(p) && !askBlocks(p.ask))
      .sort((a, b) => rank(a) - rank(b) || byPriority(a, b))
      .map((p) => p.id);
  }
  // Следующая карточка: пропускаем ушедшие после обновления, отмеченные другими и забронированные другими.
  // Забронированные откладываем в конец очереди и проверяем ещё раз (один круг).
  async function showStep(chatId, st, user) {
    const s = st.sessions[chatId], role = s.role || "pm";
    s.deferred ||= [];
    const { data, v } = fresh(s.prod);
    const byId = new Map(listFor(role, v, data).map((p) => [p.id, p]));
    releaseLocks(st, user);
    for (;;) {
      while (s.i < s.queue.length) {
        const id = s.queue[s.i], p = byId.get(id);
        if (!p || hidden(p) || (role === "pm" && askBlocks(p.ask))) { s.i++; continue; }
        if (role === "pm" && lockedByOther(st, id, user)) { if (!s.round2) s.deferred.push(id); else s.busy = (s.busy || 0) + 1; s.i++; continue; }
        break;
      }
      if (s.i < s.queue.length || s.round2 || !s.deferred.length) break;
      s.queue.push(...s.deferred); s.deferred = []; s.round2 = true;
    }
    if (s.i >= s.queue.length) {
      delete st.sessions[chatId];
      saveState(st);
      log({ action: "steps_end", login: user, role, resolved: s.ok, skipped: s.skip, asked: s.asked || 0, busy: s.busy || 0 });
      return send(chatId, `Готово. ${role === "ready" ? "Отмечено готовыми" : "Отмечено"}: ${s.ok}, пропущено: ${s.skip}${s.asked ? `, спросили продактов: ${s.asked}` : ""}.${s.busy ? `\nЕщё ${s.busy} разбирают другие ПМ.` : ""}${s.ok ? "\nПроверю в Jira после обновления (через 3 минуты после последней отметки или в 10:00) и пришлю итог." : ""}`, { reply_markup: menuOf(chatId, user) });
    }
    const p = byId.get(s.queue[s.i]);
    if (role === "pm") st.locks[p.id] = { by: user, chatId, key: p.key, label: p.label, at: new Date().toISOString() };
    const n = s.nonce;
    saveState(st);
    const ok = { text: role === "ready" ? "✅ Готово" : "✅ Исправил в Jira", callback_data: `ok:${n}:${s.i}` }, sk = { text: "⏭ Пропустить", callback_data: `sk:${n}:${s.i}` };
    const stop = { text: "⏹ Стоп", callback_data: `stop:${n}` }, open = p.url ? [{ text: "🔗 Открыть в Jira", url: p.url }] : [];
    // ПМ: особый случай — комментарий в задаче (у версии нет комментариев — срок кнопкой в боте).
    const special = p.key ? { text: "📝 Написал в Jira", callback_data: `wj:${n}:${s.i}` } : { text: "📅 Известная до…", callback_data: `kd:${n}:${s.i}` };
    const kb = role === "pm" ? [[ok, special], [sk, { text: "❓ Решение продакта", callback_data: `ask:${n}:${s.i}` }], [...open, stop]]
      : role === "po" ? [[ok, sk], [...open, stop]] : [[ok, sk], [stop]];
    return send(chatId, role === "ready" ? readyCard(p, s.i, s.queue.length, v) : cardText(p, s.i, s.queue.length, v, st, user), { reply_markup: { inline_keyboard: kb } });
  }

  // ---------- обучение по роли (кнопка в приветствии и /help): страницы листаются в одном сообщении ----------
  const EDU = {
    pm: { title: "Обучение ПМ", pages: [
      ["Что делает бот",
        "Следит, чтобы задачи в Jira совпадали с планом релизов.",
        "<b>Как работает</b>\n1. Каждый будний день в 10:00 бот читает Jira.\n2. Находит проблемы в задачах разработки и их эпиках.\n3. Присылает их вам с подсказкой, что сделать.",
        "<b>Какие бывают проблемы</b>\n• Релиз прошёл, а задача не закрыта\n• Задача не успевает к релизу\n• У эпика и задачи разные релизы\n• Задача давно не двигается",
        `<b>Продукты</b>\nБот следит за продуктами: ${PRODUCTS.map((p) => p.short).join(", ")}. Если вы ведёте несколько продуктов, после кнопки меню бот спросит продукт.`,
        "<b>Важно</b>\nБот сам в Jira ничего не меняет. Исправляете вы, бот потом проверяет."],
      [BTN_REPORT,
        "<b>Что это</b>\nВсе проблемы одного релиза одним сообщением.",
        "<b>Когда нажимать</b>\nЧтобы оценить объём работы или переслать список команде.",
        "<b>Что делать</b>\n1. Нажмите кнопку внизу экрана.\n2. Выберите релиз.\n3. Получите список: задача → что не так → как исправить."],
      [BTN_STEPS,
        "<b>Что это</b>\nПроблемы по одной карточке. Удобно разбирать подряд.",
        "<b>Кнопки на карточке</b>\n✅ Исправил в Jira — исправили, бот проверит\n📝 Написал в Jira — так и должно быть: причина и срок в комментарии задачи\n⏭ Пропустить — вернётесь позже\n❓ Решение продакта — решать не вам\n🔗 Открыть в Jira · ⏹ Стоп",
        "<b>Если ПМ несколько</b>\nКарточка, которую вы открыли, 20 минут закреплена за вами. Другие ПМ её не получат."],
      ["Что происходит после «Исправил в Jira»",
        "1. Карточка получает статус ⏳ «ждёт проверки».\n2. Через 3 минуты после вашей последней отметки бот заново читает Jira.\n3. Итог приходит сообщением:",
        "• Проблемы нет — ✅ подтверждено.\n• Проблема осталась — ❗ карточка вернётся первой в шагах."],
      ["Особый случай: пишите в Jira",
        "Например, релиз прошёл, а QA тестирует задачу прямо на проде. Проблема остаётся в отчёте, но дёргать вас и продакта до срока не нужно.",
        "<b>Что делать</b>\n1. В задаче Jira напишите комментарий: причина и срок. Например: «Тестируем на проде, до 26.11».\n2. На карточке нажмите «📝 Написал в Jira».\n3. Бот найдёт комментарий и покажет «💬 известная до 26.11».",
        "<b>Несколько задач с одной причиной</b>\nНапишите один комментарий в родительской задаче или эпике — он действует на все их задачи.",
        "<b>Повторяющиеся случаи — метка</b>\n• тест-на-проде — 7 дней после релиза\n• ios-позже — до следующего релиза",
        "<b>Сроки</b>\nСрок до 14 дней ставите сами. Дальше — бот спросит продакта. Срок прошёл, а проблема осталась — карточка вернётся первой.",
        "<b>Где смотреть</b>\nКнопка «💬 Известные» — все такие проблемы со сроками."],
      ["Если решать не вам",
        "<b>Что делать</b>\nНа карточке нажмите «❓ Решение продакта». Вопрос уйдёт продактам этого продукта.",
        "<b>Что придёт в ответ</b>\n• Успеваем — делать ничего не нужно, карточка пропадёт\n• Переносим — перенесите в Jira, затем «Решено»\n• Отменяем — отмените в Jira, затем «Решено»\n• Обсудим — напишите продакту",
        "Карточка с ответом встанет первой в «Решать по шагам»."],
    ] },
    po: { title: "Обучение продакта", pages: [
      ["Что делает бот",
        "Напоминает о решениях, которые ждут вас, и о том, что мешает релизу.",
        "<b>Как работает</b>\nКаждый будний день в 10:00 бот читает Jira и собирает 3 списка:\n1. Вопросы ПМ, где нужно ваше решение.\n2. Проблемы ваших эпиков.\n3. Эпики следующего релиза, не готовые к разработке.",
        "<b>Продукты</b>\nВ 10:00 приходит сводка по каждому вашему продукту отдельным сообщением. Если продуктов несколько, после кнопки меню бот спросит продукт.",
        "<b>Важно</b>\nБот сам в Jira ничего не меняет. Решаете и исправляете вы."],
      [BTN_ASKS,
        "<b>Что это</b>\nВопросы от ПМ: задача не успевает или нужен выбор.",
        "<b>Кнопки на карточке</b>\n✅ Успеваем — оставляем как есть, риск на вас\n➡️ Переносим — в следующий релиз\n✖️ Отменяем — задача не нужна\n💬 Обсудим — ПМ напишет вам",
        "<b>Если продактов несколько</b>\nВопрос приходит всем продактам продукта, засчитывается первый ответ. ПМ получает его сразу."],
      [BTN_MINE,
        "<b>Что это</b>\nПроблемы ваших эпиков по релизам.",
        "<b>Что делать</b>\n1. Выберите релиз — придёт список.\n2. Нажмите «🛠 По шагам» под списком.\n3. Исправьте в Jira и нажмите ✅ Решено. Не сейчас — ⏭ Пропустить."],
      [BTN_READY,
        "<b>Что это</b>\nЭпики следующего релиза, которые нельзя отдать в разработку.",
        "<b>Чего может не хватать</b>\n• Требований\n• QA-анализа\n• Дизайна\n• Задач для разработки",
        `<b>Когда смотреть</b>\nЗа ${core.READY_WARN_DAYS ?? 7} дней до старта спринта бот сам напомнит в ежедневной сводке.`,
        "<b>Не успеваете</b>\nПеренесите эпик в Jira сами."],
      ["Известные проблемы",
        "ПМ пишет причину и срок комментарием в задаче Jira или ставит метку тест-на-проде / ios-позже. До срока такие проблемы вас не дёргают: в сводке 10:00 одна строка «💬 Известные».",
        "<b>Бот спросит вас сам</b>\n⏳ ПМ поставил срок дальше 14 дней.\n⏰ Срок прошёл, а проблема осталась.\nВопрос придёт в «🧭 Ждут моего решения».",
        "<b>Где смотреть</b>\nКнопка «💬 Известные»."],
      ["Что происходит после «Решено» и «Готово»",
        "1. Карточка получает статус ⏳ «ждёт проверки».\n2. Бот заново читает Jira.\n3. Итог:",
        "• Проблемы нет — ✅ подтверждено.\n• Проблема осталась — ❗ карточка вернётся первой."],
    ] },
  };
  const BTN_EDU = "🎓 Обучение по моей роли", BTN_EDU_MENU = "🎓 Обучение";
  const eduRoles = (isPm, isPo) => [...(isPm ? ["pm"] : []), ...(isPo ? ["po"] : [])];
  // Обучение идёт по всем ролям логина подряд: ПМ, затем продакт. Ключ — роли через «+» (pm, po, pm+po).
  const eduKey = (roles) => roles.join("+");
  const eduPick = (roles) => eduPage(eduKey(roles), 0);
  function eduPage(key, i) {
    const roles = String(key).split("+").filter((r) => EDU[r]);
    const pages = roles.flatMap((r) => EDU[r].pages.map((pg, k) => ({ r, pg, k, n: EDU[r].pages.length })));
    const n = pages.length;
    i = Math.max(0, Math.min(n - 1, i));
    const nav = [...(i > 0 ? [{ text: "◀️ Назад", callback_data: `edu:${key}:${i - 1}` }] : []),
      i < n - 1 ? { text: pages[i + 1].r !== pages[i].r ? "Дальше — роль продакта ▶️" : "Далее ▶️", callback_data: `edu:${key}:${i + 1}` } : { text: "✅ Понятно", callback_data: "edu:done" }];
    const { r, pg, k } = pages[i], [head, ...body] = pg;
    const title = roles.length > 1 ? `🎓 Обучение · ${r === "pm" ? "ПМ" : "продакт"} · шаг ${i + 1} из ${n}` : `🎓 ${EDU[r].title} · шаг ${i + 1} из ${n}`;
    const intro = roles.length > 1 && k === 0 ? (r === roles[0] ? "У вас две роли — ПМ и продакт. Сначала про ПМ, потом про продакта.\n\n" : "<b>Теперь роль продакта.</b>\n\n") : "";
    return { text: `${title}\n\n${intro}<b>${head}</b>\n\n${body.join("\n\n")}`, reply_markup: { inline_keyboard: [nav] } };
  }

  // ---------- вопросы ПМ → PO ----------
  function askCardText(x, v) {
    if (x.auto) return [x.auto === "long" ? `⏳ <b>Срок дальше ${maxDays()} дней</b> · нужно ваше решение` : `⏰ <b>Срок прошёл, проблема осталась</b> · нужно ваше решение`, `${prodTag(x.prod || idProd(x.id))} · релиз ${relLabel(v, x.rel)}`, "",
      subject(x), "", `<b>Проблема:</b> ${h(x.label)}`, h(problemText(x, v)), "", `<b>В Jira:</b> ${h(x.kline || "")}`, "",
      x.auto === "long" ? "✅ Успеваем — согласиться со сроком. Остальные ответы вернут карточку ПМ первой." : "✅ Успеваем — оставить как есть. Остальные ответы вернут карточку ПМ первой."].join("\n");
    return [`❓ <b>Нужно ваше решение</b> · спросил @${h(x.by)} ${fdt(Date.parse(x.at))}`, `${prodTag(x.prod || idProd(x.id))} · релиз ${relLabel(v, x.rel)}`, "",
      subject(x),
      "", `<b>Проблема:</b> ${h(x.label)}`, h(problemText(x, v))].join("\n");
  }
  const askKb = (x) => ({ inline_keyboard: [
    [{ text: "✅ Успеваем", callback_data: `po:${x.n}:ok` }, { text: `➡️ Переносим в ${x.nx}`, callback_data: `po:${x.n}:mv` }],
    [{ text: "✖️ Отменяем", callback_data: `po:${x.n}:no` }, { text: "💬 Обсудим", callback_data: `po:${x.n}:talk` }]] });
  function pmAnswerText(x) {
    const todo = { ok: "Карточка убрана из ваших шагов.", mv: `Перенесите эпик и незакрытые задачи в ${x.nx} в Jira, затем «Решено» в шагах — карточка будет первой.`,
      no: "Переведите в «Отменено» в Jira, затем «Решено» в шагах — карточка будет первой.", talk: `Напишите @${h(x.answer.by)}. Карточка будет первой в ваших шагах.` }[x.answer.opt];
    return [`🧭 <b>Ответ @${h(x.answer.by)}</b> по ${x.key ? `<a href="${x.url}">${x.key}</a> ` : ""}${h(cut(x.title, 70))}`, `Проблема: ${h(x.label)}`, `Решение: <b>${h(ansLabel(x))}</b>`, todo].join("\n");
  }
  function openAsks(v) {
    const present = new Set((v?.anomalies || []).map((a) => a.id));
    return Object.values(loadAsks()).filter((x) => x.status === "open" && present.has(x.id)).sort((a, b) => a.at.localeCompare(b.at));
  }
  async function sendAsks(chatId, user) {
    const all = [];
    for (const pid of poProds(user)) { const { v } = fresh(pid); if (v) for (const x of openAsks(v)) all.push({ x, v }); }
    all.sort((a, b) => a.x.at.localeCompare(b.x.at));
    if (!all.length) return send(chatId, "Вопросов от ПМ нет 👍", { reply_markup: menuOf(chatId, user) });
    await send(chatId, `Ждут вашего решения: ${all.length}${all.length > 10 ? ". Показываю первые 10" : ""}.`, { reply_markup: menuOf(chatId, user) });
    for (const { x, v } of all.slice(0, 10)) await send(chatId, askCardText(x, v), { reply_markup: askKb(x) });
  }

  function claim(p, user, opts = {}) {
    const c = loadClaims();
    const prev = c[p.id];
    c[p.id] = { id: p.id, key: p.key, url: p.url, code: p.code, label: p.label, rel: p.rel, title: p.title, text: p.text, solution: p.solution || "", vers: p.vers, vname: p.vname, by: user, at: new Date().toISOString(), status: opts.until ? "known" : "pending", kind: opts.kind || null, until: opts.until || null, reason: opts.reason || null, tries: (prev?.tries || 0) + 1, checkedAt: null,
      comment: null, awaitComment: !!opts.askComment, verdict: null, prev: prev ? { at: prev.at, by: prev.by, status: prev.status, comment: prev.comment || null } : null };
    saveClaims(c);
    log({ action: opts.kind === "jira" ? "wrote_jira" : opts.until ? "known_bot" : "resolved", login: user, id: p.id, key: p.key, code: p.code, rel: p.rel, text: p.text, until: opts.until || undefined });
  }
  // Комментарий к последней отметке «Решено» (текст или null — «Без комментария»).
  function setComment(id, text, user) {
    const c = loadClaims(), x = c[id];
    if (!x) return;
    x.awaitComment = false;
    if (text) { x.comment = String(text).slice(0, 1000); x.commentAt = new Date().toISOString(); }
    saveClaims(c);
    log({ action: text ? "comment" : "no_comment", login: user, id, key: x.key, code: x.code, comment: text || undefined });
  }
  // Ждём комментарий: карточка следующего шага покажется после ответа.
  async function finishComment(chatId, st, s, who, text) {
    const w = s.wait;
    delete s.wait;
    setComment(w.id, text, who);
    if (w.mid) await tg("editMessageReplyMarkup", { chat_id: chatId, message_id: w.mid, reply_markup: { inline_keyboard: [[{ text: text ? "💬 Комментарий сохранён" : "➡️ Без комментария", callback_data: "noop" }]] } }).catch(() => {});
    s.i++;
    return showStep(chatId, st, who);
  }

  // ---------- «💬 Известные»: проблемы с причиной и сроком из Jira (свои продукты, все ПМ — для прозрачности) ----------
  async function sendKnown(chatId, user, st) {
    const prods = [...new Set([...pmProds(user), ...poProds(user)])];
    const G = [["overdue", "⏰ Срок прошёл"], ["nodate", "❗ Нет срока в комментарии"], ["long", "⏳ Ждут решения продакта"], ["known", "💬 Известные"]];
    const parts = [];
    for (const pid of prods) {
      const { data, v } = fresh(pid);
      if (!v) continue;
      const seen = new Set(), list = [...problems(v, data), ...poProblems(v, data)].filter((p) => p.known && !seen.has(p.id) && seen.add(p.id));
      if (!list.length) continue;
      parts.push(`<b>${prodTag(pid)} · известные — ${list.length}</b>`);
      for (const [g, title] of G) {
        const gl = list.filter((p) => kn(p) === g).sort((a, b) => String(a.known.until || "").localeCompare(String(b.known.until || "")));
        if (!gl.length) continue;
        parts.push(`\n${title} — ${gl.length}`);
        for (const p of gl) parts.push(`• ${p.key ? `<a href="${p.url}">${p.key}</a> ` : ""}${h(p.label)} · ${relLabel(v, p.rel)}\n   ${h(knownLine(p.known))}`);
      }
      parts.push("");
    }
    log({ action: "known_menu", login: user });
    if (!parts.length) return send(chatId, "Известных проблем нет.\nОсобый случай: напишите в задаче Jira причину и срок «до ДД.ММ» и нажмите на карточке «📝 Написал в Jira». Повторяющиеся случаи — метка тест-на-проде или ios-позже.", { reply_markup: menuOf(chatId, user) });
    const msgs = chunks(parts);
    for (let i = 0; i < msgs.length; i++) await send(chatId, msgs[i], i === msgs.length - 1 ? { reply_markup: menuOf(chatId, user) } : {});
  }

  // ---------- проверка комментария ИИ ----------
  // Claude Haiku через CLI из окружения пользователя: без проекта, хуков, MCP и инструментов. Можно подменить core.judge (тесты).
  const CLAUDE = env("CLAUDE_BIN") || [path.join(os.homedir(), ".local", "bin", "claude.exe"), path.join(os.homedir(), ".local", "bin", "claude")].find((f) => fs.existsSync(f)) || "claude";
  function judgeAi(x) {
    const prompt = [
      "ПМ отметил проблему в Jira решённой и оставил комментарий. После обновления из Jira проблема осталась.",
      "Реши: комментарий конкретно и логично объясняет, почему проблема в Jira ожидаема ещё примерно неделю (особый случай)?",
      "Пример «да»: «фичу выпустили, но её надо тестировать прямо на проде, поэтому задача ещё в работе».",
      "«Нет»: отговорка без причины («ок», «решено», «позже», «сделаем»), комментарий не про эту проблему, или он прямо говорит, что ничего не сделано.",
      "", `Задача: ${x.key || "—"} ${x.title || ""}`, `Проблема: ${x.label}. ${x.text || ""}`, `Как бот предлагал решить: ${x.solution || "—"}`, `Комментарий ПМ: ${x.comment}`,
      "", 'Ответ — только JSON: {"ok": true|false, "why": "причина по-русски, до 120 знаков"}',
    ].join("\n");
    return new Promise((resolve, reject) => {
      const ch = execFile(CLAUDE, ["-p", "--model", "haiku", "--setting-sources", "", "--strict-mcp-config", "--no-session-persistence", "--tools", "", "--system-prompt", "Ты проверяешь комментарии менеджеров. Отвечай только JSON без markdown."],
        { cwd: os.tmpdir(), timeout: 120e3, windowsHide: true, maxBuffer: 1 << 20 }, (err, out) => {
          if (err) return reject(err);
          const m = String(out).match(/\{[\s\S]*\}/);
          try { const j = JSON.parse(m ? m[0] : ""); resolve({ ok: !!j.ok, why: cut(String(j.why || ""), 160), by: "ИИ" }); } catch { reject(new Error("ИИ вернул не JSON: " + cut(String(out), 120))); }
        });
      ch.stdin.end(prompt);
    });
  }
  // ИИ недоступен — запасное правило: принимаем комментарий от 15 знаков.
  async function judge(x) {
    try { return await (core.judge || judgeAi)(x); }
    catch (e) {
      log({ action: "judge_error", id: x.id, error: String(e?.message || e).slice(0, 300) });
      const ok = String(x.comment).trim().length >= 15;
      return { ok, why: ok ? "ИИ недоступен, принято по правилу: комментарий подробный" : "ИИ недоступен, комментарий слишком короткий", by: "правило" };
    }
  }

  async function onMessage(m, onClaim) {
    const chatId = m.chat.id, user = normLogin(m.from?.username), text = (m.text || "").trim();
    const st = loadState();
    const isPm = !!user && pmLogins().includes(user);
    const isPo = m.chat.type === "private" && isPoUser(user);
    if (!isPm && !isPo) {
      if (m.chat.type === "private") {
        st.lastOther = { chat: m.chat, at: new Date().toISOString() };
        const noKb = { reply_markup: { remove_keyboard: true } };
        if (isSummaryChat(chatId)) await send(chatId, "Это чат ежедневной сводки. Меню ПМ и продакта — для логинов из вкладки «Доступы» панели «Релизы».", noKb);
        else if (offLogin(user)) {
          log({ action: "denied_off", login: user });
          await send(chatId, `Доступ к боту для @${h(user)} отключён. Вернуть его может PO во вкладке «Доступы» панели «Релизы».`, noKb);
        } else {
          st.denied = [{ login: user || null, name: [m.from?.first_name, m.from?.last_name].filter(Boolean).join(" "), at: new Date().toISOString() }, ...st.denied.filter((d) => d.login !== user)].slice(0, 20);
          log({ action: "denied", login: user || null });
          await send(chatId, user ? `Нет доступа для @${h(user)}. Попросите PO добавить ваш логин во вкладку «Доступы» панели «Релизы» и напишите /start ещё раз.` : "В Telegram не задано имя пользователя (username). Задайте его в настройках Telegram и напишите /start ещё раз.", noKb);
        }
      }
      saveState(st);
      return;
    }
    const who = user || "po";
    st.chats[who] = { chatId, name: [m.from?.first_name, m.from?.last_name].filter(Boolean).join(" "), lastAt: new Date().toISOString() };
    saveState(st);
    const menu = menuOf(chatId, user);
    const myProds = [...new Set([...(isPm ? pmProds(user) : []), ...(isPo ? poProds(user) : [])])];
    const views = Object.fromEntries(myProds.map((pid) => [pid, fresh(pid)]).filter(([, x]) => x.v));
    if (!Object.keys(views).length) return send(chatId, myProds.length ? "Данных ещё нет — PO должен обновить панель «Релизы»." : "Вам ещё не назначен продукт. Попросите PO отметить продукт во вкладке «Доступы» панели «Релизы».", { reply_markup: menu });
    const sw = st.sessions[chatId];
    if (sw?.wait) {
      const MENU = [BTN_REPORT, BTN_STEPS, BTN_ASKS, BTN_MINE, BTN_READY, BTN_KNOWN, BTN_EDU_MENU];
      if (text && !text.startsWith("/") && !MENU.includes(text)) {
        onClaim?.(); // проверка — через 3 минуты после комментария
        return finishComment(chatId, st, sw, who, text);
      }
      // Нажали меню или команду — комментария нет, разбор закончен.
      setComment(sw.wait.id, null, who);
      if (sw.wait.mid) await tg("editMessageReplyMarkup", { chat_id: chatId, message_id: sw.wait.mid, reply_markup: { inline_keyboard: [[{ text: "➡️ Без комментария", callback_data: "noop" }]] } }).catch(() => {});
      delete st.sessions[chatId];
      releaseLocks(st, who);
      saveState(st);
    }
    if ((isPm || isPo) && (text === BTN_KNOWN || /^\/known/.test(text))) return sendKnown(chatId, who, st);
    if (/^\/help/.test(text) || text === BTN_EDU_MENU) {
      log({ action: "edu_open", login: who, from: text === BTN_EDU_MENU ? "menu" : "help" });
      const e = eduPick(eduRoles(isPm, isPo));
      return send(chatId, e.text, { reply_markup: e.reply_markup });
    }
    if (isPo && (text === BTN_ASKS || /^\/asks/.test(text))) {
      log({ action: "po_asks", login: who });
      return sendAsks(chatId, user);
    }
    if (isPo && (text === BTN_MINE || /^\/mine/.test(text))) {
      log({ action: "po_mine", login: who });
      return pickProduct(chatId, user, "mine", poProds(user), st);
    }
    if (isPo && (text === BTN_READY || /^\/ready/.test(text))) {
      log({ action: "po_ready", login: who });
      return pickProduct(chatId, user, "ready", poProds(user), st);
    }
    if (!isPm && (text === BTN_REPORT || text === BTN_STEPS)) return send(chatId, "Меню ПМ — для логинов из списка ПМ во вкладке «Доступы». Ваше меню обновлено.", { reply_markup: menu });
    if (!isPo && (text === BTN_ASKS || text === BTN_MINE || text === BTN_READY)) return send(chatId, "Меню продакта — для логинов из списка продактов во вкладке «Доступы». Ваше меню обновлено.", { reply_markup: menu });
    if (text === BTN_REPORT || /^\/report/.test(text)) {
      log({ action: "report_menu", login: user });
      return pickProduct(chatId, user, "rep", pmProds(user), st);
    }
    if (text === BTN_STEPS || /^\/steps/.test(text)) return pickProduct(chatId, user, "st", pmProds(user), st);
    log({ action: "start", login: who, pm: isPm, po: isPo });
    const gen = Object.values(views)[0].v.generatedLabel;
    const L = [`Привет${st.chats[who].name ? ", " + h(st.chats[who].name) : ""}! Jira на ${gen}.`];
    if (isPo) {
      const pp = poProds(user).filter((pid) => views[pid]);
      L.push("", `<b>Продакт</b> · ${pp.map(prodTag).join(", ") || "продукт не назначен"}`);
      for (const pid of pp) {
        const { data, v } = views[pid];
        const pl = poProblems(v, data).filter((p) => !p.info), rl = readyItems(v, data), nx = nextRel(v);
        L.push(`${pp.length > 1 ? prodTag(pid) + ": " : ""}ждут решения ${openAsks(v).length} · проблемы эпиков ${pl.filter((p) => !hidden(p)).length}${nx ? ` · не готовы в ${nx.name}: ${rl.length} из ${nx.rows.length}` : ""}`);
      }
      L.push(`${BTN_ASKS} — вопросы ПМ, ответ кнопкой.`, `${BTN_MINE} — проблемы эпиков по релизам.`, `${BTN_READY} — что не готово к старту спринта.`);
    }
    if (isPm) {
      const pp = pmProds(user).filter((pid) => views[pid]);
      L.push("", `<b>ПМ</b> · ${pp.map(prodTag).join(", ") || "продукт не назначен"} · задачи разработки и их эпики:`);
      for (const pid of pp) {
        const { data, v } = views[pid];
        const open = problems(v, data).filter((p) => !p.info);
        const pend = open.filter((p) => p.claim?.status === "pending").length, failed = open.filter((p) => firstUp(p)).length, hush = open.filter((p) => !waiting(p.claim) && hidden(p) || quiet(p.claim)).length;
        L.push(`${pp.length > 1 ? prodTag(pid) + ": " : ""}открыто ${open.length - pend - hush}${pend ? `, ждут проверки ${pend}` : ""}${failed ? `, первыми в шагах ${failed}` : ""}${hush ? `, известные ${hush}` : ""}`);
      }
      L.push(`${BTN_REPORT} — все проблемы релиза одним сообщением.`,
        `${BTN_STEPS} — по одной: что не так. Исправили в Jira — «✅ Исправил в Jira». Так и должно быть — напишите в задаче причину и срок «до ДД.ММ» и нажмите «📝 Написал в Jira». Решение не за вами — «❓ Решение продакта».`,
        `${BTN_KNOWN} — проблемы с причиной и сроком из Jira.`);
    }
    await send(chatId, L.join("\n"), { reply_markup: menu });
    // Кнопка обучения — отдельным сообщением: у приветствия уже клавиатура меню, а у сообщения она одна.
    return send(chatId, `Впервые здесь? Нажмите кнопку — бот за минуту покажет, как с ним работать${isPm && isPo ? " (обе ваши роли подряд)" : ""}.\nПовторить позже — кнопка «${BTN_EDU_MENU}» внизу экрана.`, { reply_markup: { inline_keyboard: [[{ text: BTN_EDU, callback_data: "edu:start" }]] } });
  }

  // Действие меню по одному продукту (после выбора или сразу, если продукт один).
  async function runAct(chatId, user, act, pid, st) {
    const menu = menuOf(chatId, user);
    const { data, v } = fresh(pid);
    if (!v) return send(chatId, `Данных по ${prodById(pid).name} ещё нет — PO должен обновить панель «Релизы».`, { reply_markup: menu });
    if (act === "rep") return send(chatId, `${prodTag(pid)} · отчёт по какому релизу?`, { reply_markup: releaseButtons(v, problems(v, data), "rep", false, st, user) });
    if (act === "st") {
      const list = problems(v, data);
      if (!list.filter((p) => isFree(p, st, user)).length) return send(chatId, `${prodTag(pid)} · нерешённых проблем нет 👍`, { reply_markup: menu });
      return send(chatId, `${prodTag(pid)} · какой релиз разбираем?`, { reply_markup: releaseButtons(v, list, "st", true, st, user) });
    }
    if (act === "mine") {
      const pl = poProblems(v, data);
      if (!pl.length) return send(chatId, `${prodTag(pid)} · проблем эпиков нет 👍`, { reply_markup: menu });
      return send(chatId, `${prodTag(pid)} · эпики какого релиза?`, { reply_markup: releaseButtons(v, pl, "prep", false, st, user) });
    }
    if (act === "ready") {
      const msgs = readyReport(v, data), q = queueFor(readyItems(v, data), "all");
      for (let i = 0; i < msgs.length; i++) await send(chatId, msgs[i], i === msgs.length - 1 && q.length ? { reply_markup: { inline_keyboard: [[{ text: `🛠 По шагам · ${q.length}`, callback_data: `rdy:go:${pid}` }]] } } : {});
    }
  }
  async function pickProduct(chatId, user, act, prods, st) {
    if (!prods.length) return send(chatId, "Вам ещё не назначен продукт. Попросите PO отметить продукт во вкладке «Доступы» панели «Релизы».", { reply_markup: menuOf(chatId, user) });
    if (prods.length === 1) return runAct(chatId, user, act, prods[0], st);
    const rows = [];
    for (const pid of prods) {
      const { data, v } = fresh(pid);
      if (!v) { rows.push([{ text: `${prodTag(pid)} · нет данных`, callback_data: `pp:${act}:${pid}` }]); continue; }
      const n = act === "mine" ? poProblems(v, data).filter((p) => !p.info && !hidden(p)).length
        : act === "ready" ? readyItems(v, data).length
        : problems(v, data).filter((p) => (act === "st" ? isFree(p, st, user) : !p.info && !quiet(p.claim) && !hidden(p))).length;
      rows.push([{ text: `${prodTag(pid)} · ${n}`, callback_data: `pp:${act}:${pid}` }]);
    }
    return send(chatId, ACT_Q[act], { reply_markup: { inline_keyboard: rows } });
  }

  async function onCallback(q, onClaim) {
    const chatId = q.message?.chat.id, user = normLogin(q.from?.username), d = q.data || "";
    const answer = (text) => tg("answerCallbackQuery", { callback_query_id: q.id, ...(text ? { text } : {}) }).catch(() => {});
    const isPm = !!user && pmLogins().includes(user), isPo = q.message?.chat.type === "private" && isPoUser(user);
    if (!chatId || (!isPm && !isPo)) return answer("Нет доступа");
    const who = user || "po";
    const st = loadState();
    const [cmd, a, b, c3] = d.split(":");
    // Продукт в кнопках релиза — третьим полем; старые кнопки без него — основной продукт.
    const pidArg = PIDS.includes(b) ? b : PIDS.includes(c3) ? c3 : PRODUCTS[0].id;
    if (cmd === "noop") return answer();
    const markMsg = (label) => tg("editMessageReplyMarkup", { chat_id: chatId, message_id: q.message.message_id, reply_markup: { inline_keyboard: [[{ text: label, callback_data: "noop" }]] } }).catch(() => {});
    const poOnly = new Set(["po", "prep", "pst", "rdy"]), pmOnly = new Set(["rep", "st", "ask", "wj", "kd", "kd2"]);
    if ((poOnly.has(cmd) && !isPo) || (pmOnly.has(cmd) && !isPm)) return answer("Нет доступа");
    // Продукт должен быть у логина в нужной роли.
    const mayProd = (role, pid) => (role === "po" ? poProds(user) : pmProds(user)).includes(pid);
    if (cmd === "pp") {
      const role = a === "mine" || a === "ready" ? "po" : "pm";
      if ((role === "po" && !isPo) || (role === "pm" && !isPm) || !mayProd(role, b)) return answer("Нет доступа к продукту");
      await answer(prodTag(b));
      await markMsg(`✔️ ${prodTag(b)}`);
      return runAct(chatId, user, a, b, st);
    }
    if (["rep", "st"].includes(cmd) && !mayProd("pm", pidArg)) return answer("Нет доступа к продукту");
    if (["prep", "pst", "rdy"].includes(cmd) && !mayProd("po", pidArg)) return answer("Нет доступа к продукту");
    if (cmd === "edu") {
      const roles = eduRoles(isPm, isPo);
      const edit = (e) => tg("editMessageText", { chat_id: chatId, message_id: q.message.message_id, text: e.text, parse_mode: "HTML", disable_web_page_preview: true, reply_markup: e.reply_markup }).catch(() => send(chatId, e.text, { reply_markup: e.reply_markup }));
      if (a === "done") {
        await answer("Готово");
        log({ action: "edu_done", login: who });
        return edit({ text: `🎓 Обучение пройдено. Меню — внизу экрана. Повторить — кнопка «${BTN_EDU_MENU}» или /help.`, reply_markup: { inline_keyboard: [] } });
      }
      if (a === "start") { await answer(); log({ action: "edu_open", login: who, from: "button" }); return edit(eduPick(roles)); }
      if (!String(a).split("+").every((r) => roles.includes(r))) return answer("Обучение по ролям обновилось — нажмите «🎓 Обучение» ещё раз");
      await answer();
      return edit(eduPage(a, Number(b) || 0));
    }
    if (cmd === "po") {
      const asks = loadAsks(), x = Object.values(asks).find((z) => String(z.n) === a);
      if (!x) { await answer("Вопрос не найден"); return markMsg("—"); }
      if (x.status !== "open") { await answer("Уже ответили"); return markMsg(x.status === "answered" ? `✅ Ответил @${x.answer.by}: ${ansLabel(x)}` : "☑️ Вопрос закрыт"); }
      if (!ANS[b]) return answer();
      const { v } = fresh(x.prod || idProd(x.id));
      if (!v?.anomalies.some((z) => z.id === x.id)) {
        x.status = "gone"; x.goneAt = new Date().toISOString(); saveAsks(asks);
        await answer("Проблемы уже нет");
        return markMsg("☑️ Проблемы уже нет — решили в Jira");
      }
      x.status = "answered"; x.answer = { opt: b, by: who, at: new Date().toISOString() };
      saveAsks(asks);
      log({ action: "po_answer", login: who, id: x.id, key: x.key, code: x.code, answer: b, pm: x.by });
      await answer("Ответ отправлен ПМ");
      await markMsg(`✅ Ответ: ${ansLabel(x)}`);
      // Карточки у других продактов: вместо кнопок — кто и что ответил.
      for (const c of x.cards || []) if (c.chatId !== chatId && c.mid) await tg("editMessageReplyMarkup", { chat_id: c.chatId, message_id: c.mid, reply_markup: { inline_keyboard: [[{ text: `✅ Ответил @${who}: ${ansLabel(x)}`, callback_data: "noop" }]] } }).catch(() => {});
      if (x.byChat) await send(x.byChat, pmAnswerText(x), { reply_markup: menuOf(x.byChat, x.by) }).catch((e) => log({ action: "po_answer_send_error", id: x.id, error: String(e?.message || e) }));
      return;
    }
    if (cmd === "prep") {
      await answer();
      const { data, v } = fresh(pidArg);
      log({ action: "po_report", login: who, rel: a, product: pidArg });
      const msgs = reportMessages(v, data, a, "po"), qn = queueFor(poProblems(v, data), a).length;
      for (let i = 0; i < msgs.length; i++) await send(chatId, msgs[i], i === msgs.length - 1 && qn ? { reply_markup: { inline_keyboard: [[{ text: `🛠 По шагам · ${qn}`, callback_data: `pst:${a}:${pidArg}` }]] } } : {});
      return;
    }
    if (cmd === "pst" || cmd === "rdy") {
      await answer();
      const role = cmd === "pst" ? "po" : "ready", rel = cmd === "pst" ? a : "all";
      const { data, v } = fresh(pidArg);
      const queue = queueFor(listFor(role, v, data), rel);
      if (!queue.length) return send(chatId, "Нерешённого нет 👍", { reply_markup: menuOf(chatId, user) });
      st.sessions[chatId] = { role, rel, prod: pidArg, queue, i: 0, ok: 0, skip: 0, asked: 0, nonce: Math.random().toString(36).slice(2, 8), user: who };
      log({ action: "steps_start", login: who, role, rel, product: pidArg, total: queue.length });
      return showStep(chatId, st, who);
    }
    if (cmd === "rep") {
      await answer();
      const { data, v } = fresh(pidArg);
      log({ action: "report", login: user, rel: a, product: pidArg });
      for (const t of reportMessages(v, data, a)) await send(chatId, t);
      return;
    }
    if (cmd === "st") {
      await answer();
      const { data, v } = fresh(pidArg);
      const queue = queueFor(problems(v, data), a);
      if (!queue.length) return send(chatId, "В этом релизе нерешённых проблем нет 👍", { reply_markup: menuOf(chatId, user) });
      st.sessions[chatId] = { role: "pm", rel: a, prod: pidArg, queue, i: 0, ok: 0, skip: 0, asked: 0, nonce: Math.random().toString(36).slice(2, 8), user };
      log({ action: "steps_start", login: user, rel: a, product: pidArg, total: queue.length });
      return showStep(chatId, st, user);
    }
    const s = st.sessions[chatId];
    if (!s || s.nonce !== a) { await answer("Эта карточка устарела"); return tg("editMessageReplyMarkup", { chat_id: chatId, message_id: q.message.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => {}); }
    // Карточку не переписываем (ссылки бы пропали): вместо кнопок — одна строка-итог.
    const mark = markMsg, role = s.role || "pm";
    if (cmd === "stop") {
      if (s.wait) { setComment(s.wait.id, null, who); delete s.wait; }
      await answer("Остановлено");
      await mark("⏹ Остановлено");
      delete st.sessions[chatId];
      releaseLocks(st, who);
      saveState(st);
      log({ action: "steps_stop", login: who, role, resolved: s.ok, skipped: s.skip, asked: s.asked || 0 });
      if (s.ok) onClaim?.();
      return send(chatId, `Остановлено. ${role === "ready" ? "Отмечено готовыми" : "Отмечено"}: ${s.ok}, пропущено: ${s.skip}${s.asked ? `, спросили продактов: ${s.asked}` : ""}.${s.ok ? "\nПроверю в Jira после обновления и пришлю итог." : ""}`, { reply_markup: menuOf(chatId, user) });
    }
    if (cmd === "nc") {
      if (!s.wait || Number(b) !== s.wait.i) return answer("Уже обработано");
      await answer("Без комментария");
      return finishComment(chatId, st, s, who, null);
    }
    if (s.wait) return answer("Сначала комментарий или «Без комментария»");
    if (Number(b) !== s.i) return answer("Эта карточка уже обработана");
    const id = s.queue[s.i], n0 = s.nonce;
    if (cmd === "ask") {
      const { data, v } = fresh(s.prod);
      const p = problems(v, data).find((x) => x.id === id);
      const asks = loadAsks(), cur = asks[id];
      if (cur?.status === "open") { await answer(`Уже спросил @${cur.by}`); await mark(`🧭 Уже спросил @${cur.by}`); }
      else if (p) {
        st.askSeq = (st.askSeq || 0) + 1;
        const nx = nextAfter(v, p.rel);
        const x = { n: st.askSeq, id, prod: s.prod || PRODUCTS[0].id, code: p.code, key: p.key, url: p.url, title: p.title, label: p.label, text: p.text, more: p.more || "", vers: p.vers, vname: p.vname, rel: p.rel, relName: p.relName,
          nx: nx ? nx.name : "следующий релиз", by: who, byChat: chatId, at: new Date().toISOString(), status: "open", answer: null };
        asks[id] = x;
        saveAsks(asks);
        log({ action: "ask", login: who, id, key: p.key, code: p.code, rel: p.rel });
        // Продактам этого продукта, кто уже писал боту; засчитывается первый ответ.
        const targets = poLogins().filter((l) => poProds(l).includes(x.prod)).map((l) => ({ login: l, chatId: st.chats[l]?.chatId })).filter((t) => t.chatId);
        x.cards = [];
        for (const t of targets) {
          try { const r = await send(t.chatId, askCardText(x, v), { reply_markup: askKb(x) }); x.cards.push({ login: t.login, chatId: t.chatId, mid: r?.message_id || null }); }
          catch (e) { log({ action: "ask_send_error", id, to: t.login, error: String(e?.message || e) }); }
        }
        saveAsks(asks);
        s.asked = (s.asked || 0) + 1;
        await answer(targets.length ? "Отправил продактам" : "Продакты ещё не писали боту");
        await mark(targets.length ? `🧭 Спросил ${targets.map((t) => "@" + t.login).join(", ")} — ответ пришлю` : "🧭 Вопрос сохранён — продакт увидит его в «Ждут моего решения»");
      } else { await answer("Проблемы уже нет"); await mark("☑️ Проблемы уже нет"); }
      delete st.locks[id];
      s.i++;
      return showStep(chatId, st, who);
    }
    if (cmd === "ok") {
      const { data, v } = fresh(s.prod);
      const p = listFor(role, v, data).find((x) => x.id === id);
      // Двое нажали «Решено» по одной проблеме: засчитываем первому.
      if (p?.claim?.status === "pending" && p.claim.by !== user) {
        await answer(`Уже отметил @${p.claim.by}`);
        await mark(`☑️ Уже отметил @${p.claim.by}`);
      } else {
        const askC = false; // 19.11 вариант B: комментарий — в Jira, не в боте
        if (p) claim(p, who, { askComment: askC });
        s.ok++;
        await answer(role === "ready" ? "Отмечено: готово" : "Отмечено: исправлено");
        await mark(role === "ready" ? "✅ Отмечено: готово — проверю в Jira" : "✅ Исправлено — проверю в Jira");
        onClaim?.();
        if (askC) {
          delete st.locks[id];
          s.wait = { id, i: s.i, mid: null };
          saveState(st);
          const r = await send(chatId, "💬 <b>Комментарий — по желанию.</b>\nЕсли случай особый, напишите одним сообщением, почему в Jira всё ещё так. Например: «фичу выпустили, тестируем прямо на проде, поэтому задача в работе».\nС комментарием, который объясняет случай, скрою карточку на 7 дней.",
            { reply_markup: { inline_keyboard: [[{ text: "➡️ Без комментария", callback_data: `nc:${s.nonce}:${s.i}` }, { text: "⏹ Стоп", callback_data: `stop:${s.nonce}` }]] } });
          const st2 = loadState(), s2 = st2.sessions[chatId];
          if (s2?.wait && s2.nonce === s.nonce) { s2.wait.mid = r?.message_id || null; saveState(st2); }
          return;
        }
      }
      delete st.locks[id];
    } else if (cmd === "wj") {
      const { data, v } = fresh(s.prod);
      const p = problems(v, data).find((x) => x.id === id);
      if (!p) { await answer("Проблемы уже нет"); await mark("☑️ Проблемы уже нет"); }
      else {
        claim(p, who, { kind: "jira" });
        s.ok++;
        await answer("Проверю комментарий в Jira");
        await mark("📝 Проверю комментарий в Jira через 3 минуты");
        onClaim?.();
      }
      delete st.locks[id];
    } else if (cmd === "kd") {
      const { v } = fresh(s.prod);
      const nx = v.moveTargets.find((t) => t.date > v.today);
      const opts = [...(nx ? [{ text: `До ${nx.name} · релиз`, callback_data: `kd2:${n0}:${s.i}:r` }] : []), { text: "+7 дней", callback_data: `kd2:${n0}:${s.i}:7` }, { text: `+${maxDays()} дней`, callback_data: `kd2:${n0}:${s.i}:${maxDays()}` }];
      await answer();
      return send(chatId, "📅 <b>До какой даты так будет?</b>\nПосле даты проверю Jira: версия не выпущена — карточка вернётся к вам первой.", { reply_markup: { inline_keyboard: [opts] } });
    } else if (cmd === "kd2") {
      const { data, v } = fresh(s.prod);
      const p = problems(v, data).find((x) => x.id === id);
      const nx = v.moveTargets.find((t) => t.date > v.today);
      const add = (d, k) => new Date(Date.parse(d + "T00:00:00Z") + k * 86400e3).toISOString().slice(0, 10);
      const until = c3 === "r" && nx ? nx.date : add(v.today, Math.min(Number(c3) || 7, maxDays()));
      if (p) claim(p, who, { kind: "bot", until, reason: "срок кнопкой в боте" });
      s.ok++;
      await answer(`Известная до ${dd(until)}`);
      await mark(`📅 Известная до ${dd(until)}`);
      delete st.locks[id];
    } else if (cmd === "sk") {
      s.skip++;
      delete st.locks[id];
      if (role === "pm") st.skipped[id] = { by: who, at: new Date().toISOString() };
      log({ action: "skip", login: who, role, id });
      await answer("Пропущено");
      await mark("⏭ Пропущено");
    } else return answer();
    s.i++;
    return showStep(chatId, st, who);
  }

  // Один цикл long polling. signal — чтобы плагин мог остановить ожидание при выгрузке.
  async function pollOnce(signal, onClaim, onError = () => {}) {
    const tok = env("TELEGRAM_BOT_TOKEN");
    if (!tok) throw new Error("Нет TELEGRAM_BOT_TOKEN");
    const st = loadState();
    const r = await fetch(`https://api.telegram.org/bot${tok}/getUpdates`, {
      method: "POST", headers: { "Content-Type": "application/json" }, signal,
      body: JSON.stringify({ offset: st.offset, timeout: 25, allowed_updates: ["message", "callback_query"] }),
    });
    const j = await r.json();
    if (!j.ok) throw new Error(`Telegram getUpdates: ${j.description || r.status}`);
    for (const u of j.result) {
      const s2 = loadState(); s2.offset = u.update_id + 1; saveState(s2); // сдвигаем до обработки: сбой не зацикливает
      try {
        if (u.message) await onMessage(u.message, onClaim);
        else if (u.callback_query) await onCallback(u.callback_query, onClaim);
      } catch (e) { onError(e); }
    }
    return j.result.length;
  }

  // Бот сам спрашивает продакта: срок дальше лимита (long) или срок прошёл (overdue). Вопрос закрывается, когда состояние ушло.
  async function autoAsks(views, notify) {
    const asks = loadAsks(), st = loadState(), loginOf = (k) => k?.login || null;
    let made = 0, closed = 0;
    const cur = new Map();
    for (const { data, v } of Object.values(views)) for (const p of [...problems(v, data), ...poProblems(v, data)]) if (p.known) cur.set(p.id, { p, v });
    for (const x of Object.values(asks)) if (x.auto && x.status === "open" && kn(cur.get(x.id)?.p) !== x.auto) { x.status = "gone"; x.goneAt = new Date().toISOString(); closed++; }
    for (const { p, v } of cur.values()) {
      const state = kn(p);
      if (state !== "long" && state !== "overdue") continue;
      const prev = asks[p.id];
      if (prev && prev.status !== "gone" && (prev.auto === state || !prev.auto)) continue;
      st.askSeq = (st.askSeq || 0) + 1;
      const nx = nextAfter(v, p.rel), pmLogin = loginOf(p.known);
      const x = { n: st.askSeq, id: p.id, prod: v.product || PRODUCTS[0].id, code: p.code, key: p.key, url: p.url, title: p.title, label: p.label, text: p.text, more: p.more || "", vers: p.vers, vname: p.vname, rel: p.rel, relName: p.relName,
        nx: nx ? nx.name : "следующий релиз", by: pmLogin || "бот", byChat: pmLogin ? st.chats[pmLogin]?.chatId || null : null, at: new Date().toISOString(), status: "open", answer: null,
        auto: state, until: p.known.until, kline: knownLine(p.known), cards: [] };
      asks[p.id] = x;
      made++;
      log({ action: "auto_ask", id: p.id, key: p.key, code: p.code, state, until: p.known.until });
      if (!notify) continue;
      for (const l of poLogins().filter((l) => poProds(l).includes(x.prod))) {
        const chat = st.chats[l]?.chatId;
        if (!chat) continue;
        try { const r = await send(chat, askCardText(x, v), { reply_markup: askKb(x) }); x.cards.push({ login: l, chatId: chat, mid: r?.message_id || null }); }
        catch (e) { log({ action: "ask_send_error", id: p.id, to: l, error: String(e?.message || e) }); }
      }
    }
    if (made || closed) { saveAsks(asks); saveState(st); }
    return { made, closed };
  }

  // ---------- проверка заявок после обновления из Jira ----------
  async function verify({ notify = true } = {}) {
    // Все продукты: id кейсов неосновных продуктов с префиксом, поэтому общий набор «есть сейчас».
    const views = Object.fromEntries(PIDS.map((pid) => [pid, fresh(pid)]).filter(([, x]) => x.v));
    if (!Object.keys(views).length) return { checked: 0 };
    const present = new Set(); // скрытые PO тоже считаем «есть»
    for (const { v } of Object.values(views)) for (const a of v.anomalies) present.add(a.id);
    const genOf = (id) => views[idProd(id)]?.data.generated ?? null;
    // Вопросы к PO по исчезнувшим кейсам закрываем (только для продуктов, по которым есть данные).
    const asks = loadAsks();
    let asksClosed = 0;
    for (const x of Object.values(asks)) if (x.status !== "gone" && genOf(x.id) != null && !present.has(x.id)) { x.status = "gone"; x.goneAt = new Date(genOf(x.id)).toISOString(); asksClosed++; }
    if (asksClosed) saveAsks(asks);
    for (const { data, v } of Object.values(views)) for (const p of readyItems(v, data)) present.add(p.id); // «Готово» по эпику подтверждено, когда эпик готов к разработке или ушёл из релиза
    const c = loadClaims(), byUser = {};
    const bucket = (u) => (byUser[u] ||= { ok: [], bad: [], hush: [], back: [], linked: [] });
    const anomOf = new Map(), learned = [];
    for (const { v: vv } of Object.values(views)) for (const a of vv.anomalies) anomOf.set(a.id, a);
    let checked = 0;
    const lastGen = Math.max(...Object.values(views).map((x) => x.data.generated));
    const v = { generatedLabel: fdt(lastGen) };
    for (const x of Object.values(c)) {
      const gen = genOf(x.id);
      if (gen == null) continue; // нет данных продукта — не проверяем
      const genIso = new Date(gen).toISOString();
      // Неделя тишины прошла: проблема осталась — вернуть с комментарием, нет — подтверждено.
      if (x.status === "accepted" && Date.parse(x.until) <= Date.now()) {
        x.status = present.has(x.id) ? "reopened" : "confirmed";
        x.checkedAt = genIso;
        checked++;
        if (x.status === "reopened") bucket(x.by).back.push(x); else bucket(x.by).ok.push(x);
        log({ action: "verify", login: x.by, id: x.id, key: x.key, code: x.code, result: x.status });
        continue;
      }
      // Срок кнопкой (версия): проблема ушла — подтверждено. Срок прошёл — core покажет кейс как просроченный.
      if (x.status === "known") {
        if (!present.has(x.id)) { x.status = "confirmed"; x.checkedAt = genIso; checked++; bucket(x.by).ok.push(x); log({ action: "verify", login: x.by, id: x.id, key: x.key, code: x.code, result: "confirmed" }); }
        continue;
      }
      if (x.status !== "pending" || Date.parse(x.at) >= gen) continue;
      if (x.kind === "jira") {
        const a = anomOf.get(x.id);
        if (!a) x.status = "confirmed";
        else if (a.known && a.known.state !== "nodate") {
          x.status = "linked"; x.known = { state: a.known.state, until: a.known.until, who: a.known.who || "", src: a.known.src };
          // Комментарий найден по нажатию: запоминаем имя ПМ в Jira — дальше бот увидит его комментарии сам.
          if (a.known.viaBot && a.known.who) learned.push(learnJira(x.by, a.known.who));
        } else { x.status = "failed"; x.reason = a.known?.state === "nodate" ? "nodate" : "nocomment"; }
        x.checkedAt = genIso;
        checked++;
        bucket(x.by)[x.status === "confirmed" ? "ok" : x.status === "linked" ? "linked" : "bad"].push(x);
        log({ action: "verify", login: x.by, id: x.id, key: x.key, code: x.code, result: x.status, reason: x.reason || undefined, known: x.known || undefined });
        continue;
      }
      if (x.awaitComment && Date.now() - Date.parse(x.at) < COMMENT_WAIT_MS) continue; // ПМ ещё пишет комментарий
      if (!present.has(x.id)) x.status = "confirmed";
      else if (x.comment) {
        x.verdict = await judge(x);
        x.status = x.verdict.ok ? "accepted" : "failed";
        if (x.verdict.ok) x.until = new Date(Date.now() + QUIET_MS).toISOString();
      } else x.status = "failed";
      x.awaitComment = false;
      x.checkedAt = genIso;
      checked++;
      bucket(x.by)[x.status === "confirmed" ? "ok" : x.status === "accepted" ? "hush" : "bad"].push(x);
      log({ action: "verify", login: x.by, id: x.id, key: x.key, code: x.code, result: x.status, verdict: x.verdict || undefined });
    }
    if (checked) saveClaims(c);
    const aa = await autoAsks(views, notify);
    if (notify && checked) {
      const st = loadState();
      for (const [user, r] of Object.entries(byUser)) {
        const chatId = st.chats[user]?.chatId;
        if (!chatId) continue;
        const L = [`<b>Проверка в Jira на ${v.generatedLabel}</b>`, `✅ Подтверждено: ${r.ok.length}`];
        const allX = [...r.ok, ...r.bad, ...r.hush, ...r.back, ...r.linked];
        const multi = new Set(allX.map((x) => idProd(x.id))).size > 1 || allX.some((x) => idProd(x.id) !== PRODUCTS[0].id);
        const ln = (x) => `• ${multi ? prodById(idProd(x.id)).emoji + " " : ""}${x.key ? `<a href="${x.url}">${x.key}</a> ` : ""}${h(x.label)}`;
        if (r.hush.length) {
          L.push(`💬 Принято по комментарию: ${r.hush.length} — скрою на 7 дней`);
          for (const x of r.hush.slice(0, 15)) L.push(ln(x));
        }
        if (r.linked.length) {
          L.push(`💬 Нашёл комментарий в Jira: ${r.linked.length}`);
          for (const x of r.linked.slice(0, 15)) L.push(ln(x) + (x.known.state === "long" ? `\n   ⏳ срок ${dd(x.known.until)} дальше ${maxDays()} дней — спросил продакта` : x.known.state === "overdue" ? `\n   ⏰ срок ${dd(x.known.until)} уже прошёл — поставьте новый в комментарии` : `\n   известная до ${dd(x.known.until)}, до этой даты не покажу`));
        }
        if (r.bad.length) {
          L.push(`❗ Не решено: ${r.bad.length}`);
          for (const x of r.bad.slice(0, 15)) L.push(ln(x) + (x.reason === "nodate" ? "\n   В комментарии нет срока — допишите «до ДД.ММ» и снова «📝 Написал в Jira»"
            : x.reason === "nocomment" ? `\n   Не нашёл комментарий после ${fdt(Date.parse(x.at)).slice(6)} — напишите в задаче причину и срок и снова «📝 Написал в Jira»`
            : x.comment && x.verdict ? `\n   Комментарий не принят: ${h(x.verdict.why)}` : ""));
        }
        if (r.back.length) {
          L.push(`↩️ Прошла неделя, проблема осталась: ${r.back.length}`);
          for (const x of r.back.slice(0, 15)) L.push(ln(x) + `\n   Ваш комментарий: ${h(q(x.comment))}`);
        }
        const me = learned.find((z) => z && z.login === user);
        if (me) L.push("", `Запомнил: в Jira вы — «${h(me.name)}». Дальше увижу ваши комментарии сам, кнопку можно не жать.`);
        if (r.bad.length || r.back.length) L.push("", "Они будут первыми в шагах.");
        await send(chatId, L.join("\n"), { reply_markup: menuOf(chatId, user) }).catch(() => {});
      }
    }
    return { checked, asksClosed, autoAsks: aa, learned: learned.filter(Boolean), byUser: Object.fromEntries(Object.entries(byUser).map(([u, r]) => [u, { ok: r.ok.length, bad: r.bad.length, hush: r.hush.length, back: r.back.length, linked: r.linked.length }])) };
  }

  // ---------- для панели ----------
  // Доступы: kind = "pms" (проджект-менеджеры) или "pos" (продакты). Один логин может быть в обоих списках.
  // products — продукты логина в этой роли; не передали — основной продукт. Логин уже есть — продукты не меняются (для этого setProducts).
  function addLogin(kind, login, products) {
    const l = normLogin(login);
    if (!/^[a-z0-9_]{4,32}$/.test(l)) throw new Error("Логин Telegram: 4–32 символа, латиница, цифры и _");
    const prods = (Array.isArray(products) ? products : [PRODUCTS[0].id]).filter((x) => PIDS.includes(x));
    const n = loadNotes();
    const ex = n.cfg[kind].find((p) => p.login === l);
    if (!ex) n.cfg[kind].push({ login: l, addedAt: new Date().toISOString(), products: prods.length ? prods : [PRODUCTS[0].id] });
    else if (ex.off) delete ex.off; // «Дать доступ» отключённому — вернуть как было
    saveNotes(n);
    log({ action: `${kind === "pos" ? "po" : "pm"}_add`, login: l, products: prods });
    return { ok: true };
  }
  function setProducts(kind, login, products) {
    const l = normLogin(login), n = loadNotes();
    const x = n.cfg[kind].find((p) => p.login === l);
    if (!x) throw new Error(`Нет логина @${l}`);
    x.products = PIDS.filter((id) => (products || []).includes(id));
    saveNotes(n);
    log({ action: `${kind === "pos" ? "po" : "pm"}_products`, login: l, products: x.products });
    return { ok: true };
  }
  function removeLogin(kind, login) {
    const l = normLogin(login), n = loadNotes();
    n.cfg[kind] = n.cfg[kind].filter((p) => p.login !== l);
    saveNotes(n);
    log({ action: `${kind === "pos" ? "po" : "pm"}_remove`, login: l });
    return { ok: true };
  }
  // Имя ПМ или продакта в Jira (как автор комментария). Пусто — снять. Пишется в обе роли логина.
  function setJira(login, name) {
    const l = normLogin(login), n = loadNotes(), v = String(name || "").trim().slice(0, 80);
    let found = false;
    for (const kind of ["pms", "pos"]) for (const x of n.cfg[kind]) if (x.login === l) { found = true; if (v) x.jira = v; else delete x.jira; }
    if (!found) throw new Error(`Нет логина @${l}`);
    saveNotes(n);
    log({ action: "jira_name", login: l, name: v || null });
    return { ok: true };
  }
  // Бот сам запоминает имя, если у логина его ещё нет.
  function learnJira(login, name) {
    const n = loadNotes();
    const xs = ["pms", "pos"].flatMap((k) => n.cfg[k].filter((x) => x.login === login));
    if (!xs.length || xs.some((x) => x.jira)) return null;
    setJira(login, name);
    return { login, name };
  }
  // Метки и лимит (вкладка «Доступы» панели): labels [{label, mode: "days" | "next", days}], maxDays.
  function setKnownCfg(cfg) {
    const labels = (cfg?.labels || []).map((x) => ({ label: String(x.label || "").trim().toLowerCase().replace(/\s+/g, "-"), mode: x.mode === "next" ? "next" : "days", days: Math.max(1, Math.min(60, Math.round(Number(x.days) || 7))) }))
      .filter((x) => x.label).map((x) => (x.mode === "next" ? { label: x.label, mode: "next" } : x));
    const maxDays = Math.max(1, Math.min(60, Math.round(Number(cfg?.maxDays) || 14)));
    const n = loadNotes();
    n.cfg.known = { maxDays, labels };
    saveNotes(n);
    log({ action: "known_cfg", maxDays, labels: labels.map((x) => x.label) });
    return { ok: true };
  }
  // Отключить или вернуть доступ, не удаляя логин: продукты, имя в Jira и чат сохраняются.
  // Вернули — человек получает сообщение с меню (если уже писал боту). Отключили — без сообщения: меню уберётся при следующем обращении.
  async function setOff(kind, login, off) {
    const l = normLogin(login), n = loadNotes();
    const x = n.cfg[kind].find((p) => p.login === l);
    if (!x) throw new Error(`Нет логина @${l}`);
    if (off) x.off = { at: new Date().toISOString() }; else delete x.off;
    saveNotes(n);
    const st = loadState();
    if (off) { for (const [cid, ss] of Object.entries(st.sessions)) if (ss.user === l) delete st.sessions[cid]; releaseLocks(st, l); saveState(st); }
    log({ action: `${kind === "pos" ? "po" : "pm"}_${off ? "off" : "on"}`, login: l });
    const chatId = st.chats[l]?.chatId;
    if (!off && chatId) await send(chatId, `Доступ вернули: ${kind === "pos" ? "продакт" : "ПМ"}. Меню — внизу экрана, обучение — «${BTN_EDU_MENU}».`, { reply_markup: menuOf(chatId, l) }).catch((e) => log({ action: "access_on_send_error", login: l, error: String(e?.message || e) }));
    return { ok: true };
  }
  const addPm = (l, prods) => addLogin("pms", l, prods), removePm = (l) => removeLogin("pms", l);
  const addPo = (l, prods) => addLogin("pos", l, prods), removePo = (l) => removeLogin("pos", l);

  // ---------- утренняя сводка: каждому ПМ и продакту с чатом — по сообщению на каждый его продукт ----------
  // Чат сводки (кнопка «Найти чат»), если он не принадлежит логину из «Доступов», получает все продукты, как раньше.
  async function morning(by = "расписание", { dry = false } = {}) {
    const n = loadNotes(), st = loadState();
    const views = Object.fromEntries(PIDS.map((pid) => [pid, fresh(pid).v]).filter(([, v]) => v));
    const to = new Map(); // chatId → { login, prods: Map(pid → { po, pm }) }
    const add = (chatId, login, pid, role) => {
      if (!chatId || !views[pid]) return;
      const r = to.get(chatId) || { login, prods: new Map() };
      const x = r.prods.get(pid) || { po: false, pm: false };
      x[role] = true; r.prods.set(pid, x); to.set(chatId, r);
    };
    for (const kind of ["pos", "pms"]) for (const x of n.cfg[kind].filter((y) => !y.off)) for (const pid of loginProducts(x)) add(st.chats[x.login]?.chatId, x.login, pid, kind === "pos" ? "po" : "pm");
    if (n.cfg.tg.chatId && !to.has(n.cfg.tg.chatId)) for (const pid of Object.keys(views)) add(n.cfg.tg.chatId, null, pid, "po");
    const out = [];
    for (const [chatId, r] of to) {
      for (const pid of PIDS) {
        const x = r.prods.get(pid);
        if (!x) continue;
        const summary = chatId === n.cfg.tg.chatId;
        const footer = summary ? "Подробно — панель «Релизы» в bb." : x.pm ? `Подробно — «${BTN_REPORT}» в меню бота.` : `Подробно — «${BTN_MINE}» в меню бота.`;
        const text = core.telegramText(views[pid], 5, { po: x.po, footer });
        out.push({ chatId, login: r.login, product: pid, chars: text.length, text });
        if (!dry) await send(chatId, text, r.login ? { reply_markup: menuOf(chatId, r.login) } : {}).catch((e) => { out[out.length - 1].error = String(e?.message || e); });
      }
    }
    if (!dry) {
      const n2 = loadNotes();
      n2.cfg.tg.lastSent = { at: new Date().toISOString(), by, date: Object.values(views)[0]?.today || null, messages: out.filter((x) => !x.error).length };
      saveNotes(n2);
      log({ action: "morning", by, sent: out.filter((x) => !x.error).map((x) => `${x.login || "сводка"}:${x.product}`), errors: out.filter((x) => x.error).length });
    }
    return { sent: out.filter((x) => !x.error).length, errors: out.filter((x) => x.error).map((x) => `${x.login || "сводка"} ${x.product}: ${x.error}`), list: out.map(({ text, ...x }) => (dry ? { ...x, text } : x)) };
  }

  function panel(pid = PRODUCTS[0].id) {
    const { data, v } = fresh(pid);
    const st = loadState(), n = loadNotes();
    const list = problems(v, data);
    const rels = relList(list).map((d) => {
      const l = list.filter((p) => p.rel === d && !p.info);
      return { date: d, label: v ? relLabel(v, d) : d, known: l.filter((p) => !waiting(p.claim) && hidden(p)).length, open: l.filter((p) => !hidden(p) && (!p.claim || ["confirmed", "failed", "reopened", "linked"].includes(p.claim.status) || (p.claim.status === "accepted" && !quiet(p.claim)))).length, pending: l.filter((p) => p.claim?.status === "pending").length, failed: l.filter((p) => back(p.claim)).length, quiet: l.filter((p) => quiet(p.claim)).length };
    });
    const claims = Object.values(loadClaims()).filter((c) => idProd(c.id) === pid).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 300);
    return {
      product: pid, products: PRODUCTS,
      pms: n.cfg.pms.map((p) => ({ ...p, products: loginProducts(p), chat: st.chats[p.login] || null, lock: Object.values(st.locks).find((l) => l.by === p.login && Date.now() - Date.parse(l.at) < LOCK_MS) || null })),
      pos: n.cfg.pos.map((p) => ({ ...p, products: loginProducts(p), chat: st.chats[p.login] || null, open: (v ? openAsks(v) : []).length })),
      denied: st.denied.filter((d) => !n.cfg.pms.some((p) => p.login === d.login) && !n.cfg.pos.some((p) => p.login === d.login)).slice(0, 10),
      rels, claims,
      asks: Object.values(loadAsks()).filter((x) => x.status !== "gone" && idProd(x.id) === pid).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 50),
      totals: { open: list.filter((p) => !p.info && !hidden(p)).length, pending: claims.filter((c) => c.status === "pending").length, known: list.filter((p) => !p.info && p.known).length },
      known: core.knownCfg ? core.knownCfg(n) : null,
    };
  }

  return { problems, poProblems, readyItems, readyReport, reportMessages, pollOnce, verify, morning, addPm, removePm, addPo, removePo, setProducts, setJira, setKnownCfg, setOff, panel, solution };
}
