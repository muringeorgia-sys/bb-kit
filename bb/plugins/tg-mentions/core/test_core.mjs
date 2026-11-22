// Офлайн-тест ядра «Ответы TG»: фейковый Telegram и фейковая модель, данные во временной папке.
// node test_core.mjs → «проверок N, ошибок 0». Реальный Telegram и Claude не вызываются.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tgm-unit-"));
process.env.TG_MENTIONS_DATA = dir;
const { createCore, similarity } = await import(`./core.mjs?t=${Date.now()}`);

let fails = 0;
let n = 0;
const ok = (cond, name) => {
  n++;
  if (!cond) {
    fails++;
    console.log(`✗ ${name}`);
  }
};

const ME = { id: 1, name: "Anna", username: "AnnaTest" };
const G = -1001234567890; // супергруппа
const P = 555; // личка
const now = Date.now();
const t = (min) => new Date(now - min * 60e3).toISOString();
let groupMsgs = [];
let privMsgs = [];
let chats = [];
const sent = [];
const drafts = [];
const client = {
  async call(name, a) {
    if (name === "get_me") return JSON.stringify(ME);
    if (name === "list_chats") return JSON.stringify({ results: chats });
    if (name === "list_messages") return JSON.stringify({ results: (a.chat_id === G ? groupMsgs : privMsgs).slice(0, a.limit) });
    if (name === "get_message_context") {
      const list = a.chat_id === G ? groupMsgs : privMsgs;
      const m = list.find((x) => x.id === a.message_id);
      const replied = m?.reply_to ? list.find((x) => x.id === m.reply_to) : null;
      return JSON.stringify({ results: [{ ...m, is_target: true, replied_message: replied }] });
    }
    if (name === "reply_to_message") {
      sent.push(a);
      return `Replied to message ${a.message_id} in chat ${a.chat_id}.`;
    }
    if (name === "save_draft") {
      drafts.push(a);
      return `Draft saved to chat ${a.chat_id}. Open the chat in Telegram to see and send it.`;
    }
    throw new Error(`unexpected ${name}`);
  },
  stop() {},
};
let llmCalls = 0;
const llm = async ({ schema, prompt }) => {
  llmCalls++;
  if (schema) return { needs_reply: !/спасибо/i.test(prompt.split("<сообщение_для_ответа>")[1] || ""), summary: "тест", variants: [{ label: "Коротко", text: "Да" }, { label: "По делу", text: "Да, сделаем в понедельник" }, { label: "Уточнить", text: "А что именно нужно?" }] };
  return "## Общее\nкоротко";
};

// --- 1. поиск ---
chats = [
  { chat_id: G, title: "Команда", type: "Supergroup", unread: 5, unread_mentions: 1 },
  { chat_id: P, name: "Аня", type: "User", username: "anya", unread: 2 },
  { chat_id: 777, name: "Some Bot", type: "User", username: "some_bot", unread: 3 },
];
groupMsgs = [
  { id: 106, sender: "Петя", sender_id: 3, date: t(5), text: "Аня, глянь пожалуйста" },
  { id: 105, sender: "Вася", sender_id: 2, date: t(10), text: "это про тебя?", reply_to: 50 },
  { id: 104, sender: "Вася", sender_id: 2, date: t(20), text: "@AnnaTest когда релиз?" },
  { id: 103, sender: "Вася", sender_id: 2, date: t(30), text: "согласен", reply_to: 101 },
  { id: 102, sender: "Петя", sender_id: 3, date: t(40), text: "@AnnaTestX не ты" },
  { id: 101, sender: "Anna", sender_id: 1, out: true, date: t(50), text: "Предлагаю перенести на среду" },
  { id: 50, sender: "Вася", sender_id: 2, date: t(60 * 24 * 10), text: "старое" },
];
privMsgs = [
  { id: 12, sender: "Аня", date: t(3), text: "и ещё вопрос" },
  { id: 11, sender: "Аня", date: t(4), text: "привет, есть минута?" },
  { id: 10, sender: "Anna", out: true, date: t(100), text: "Ок" },
];
const core = createCore({ client, llm });
core.setCfg({ names: ["Аня"] });
await core.scan("тест", { generate: false });
let v = core.view();
const keyOf = (c, id) => `${c}:${id}`;
const item = (c, id) => v.items.find((i) => i.key === keyOf(c, id));
ok(item(G, 104)?.kind === "mention", "@ник → mention");
ok(item(G, 103)?.kind === "reply", "ответ на моё → reply");
ok(item(G, 106)?.kind === "name", "имя без @ → name");
ok(!item(G, 102), "@AnnaTestX не считается упоминанием");
ok(!item(G, 105), "ответ на чужое старое сообщение не берём");
ok(item(P, 12)?.kind === "private" && item(P, 12).text.includes("привет, есть минута?") && item(P, 12).text.includes("и ещё вопрос"), "личка: два непрочитанных в одной карточке");
ok(!v.items.some((i) => i.chatId === "777"), "боты пропущены");
ok(item(G, 104)?.link === "https://t.me/c/1234567890/104", "ссылка на сообщение");
ok(v.profile.samples === 2, "мои сообщения (группа + личка) сохранены как образцы");

// --- 2. генерация ---
await core.generate(keyOf(G, 104));
v = core.view();
ok(item(G, 104).gen?.variants?.length === 3 && item(G, 104).gen.needsReply === true, "3 варианта");

// --- 3. отправка из панели с правкой ---
const r = await core.send(keyOf(G, 104), "Да, в понедельник", 1);
v = core.view();
ok(sent.length === 1 && sent[0].message_id === 104 && sent[0].chat_id === G, "reply_to_message вызван с нужным сообщением");
ok(item(G, 104).status === "sent" && item(G, 104).final.via === "plugin", "карточка закрыта как отправленная");
ok(r.sim != null && r.sim < 0.97 && r.sim > 0.5, `похожесть посчитана (${r.sim})`);
let s = v.stats;
ok(s.plugin === 1 && s.rated === 1 && s.same === 0, "статистика: 1 ответ с правкой");

// --- 4. черновик в Telegram → ответ найден при следующем поиске ---
await core.draft(keyOf(G, 103), "Да, давай в среду", 0);
v = core.view();
ok(drafts.length === 1 && drafts[0].reply_to_msg_id === 103, "save_draft с reply_to");
ok(item(G, 103).status === "tg_draft", "статус «черновик в TG»");
groupMsgs = [{ id: 107, sender: "Anna", sender_id: 1, out: true, date: t(1), text: "Да, давай в среду", reply_to: 103 }, ...groupMsgs];
chats[0].unread = 0;
chats[0].unread_mentions = 0;
await core.scan("тест", { generate: false });
v = core.view();
ok(item(G, 103).status === "sent" && item(G, 103).final.via === "tg_draft" && item(G, 103).final.sim === 1, "ответ из черновика найден, без правок");

// --- 5. «ты уже писал после» и «Уже ответил» ---
ok(item(G, 106)?.wroteAfter?.id === 107, "отмечено: писал в чат после упоминания");
core.done(keyOf(G, 106));
v = core.view();
ok(item(G, 106).status === "sent" && item(G, 106).final.via === "telegram", "«Уже ответил» берёт твоё сообщение как ответ");

// --- 6. сам ответил в личке без плагина ---
await core.generate(keyOf(P, 12));
privMsgs = [{ id: 13, sender: "Anna", out: true, date: t(1), text: "Да, давай" }, ...privMsgs];
chats[1].unread = 0;
await core.scan("тест", { generate: false });
v = core.view();
ok(item(P, 12).status === "sent" && item(P, 12).final.via === "telegram" && item(P, 12).final.label?.includes("ближайший"), "ответ в Telegram сравнён с ближайшим вариантом");

// --- 7. обучение: профиль пересобирается после N ответов ---
s = core.view().stats;
ok(s.total === 4 && s.tgDraft === 1 && s.telegram === 2, `примеры записаны (${s.total})`);
ok(s.weeks.length === 1 && s.weeks[0].n === 2, "неделя в графике");
core.setCfg({ rebuildEvery: 3 });
const calls0 = llmCalls;
// образцов для профиля мало (<10) — сборка должна честно отказать
await core.buildProfile("тест").catch(() => {});
ok(core.view().profile.error?.includes("Мало"), "профиль: честная ошибка при малом числе сообщений");
ok(llmCalls === calls0, "при ошибке модель не вызывалась");

// --- 8. скрыть, вернуть, игнор чата ---
groupMsgs = [{ id: 108, sender: "Петя", date: t(0.5), text: "@AnnaTest ещё вопрос" }, ...groupMsgs];
chats[0].unread = 1;
await core.scan("тест", { generate: false });
v = core.view();
ok(item(G, 108)?.status === "new", "новое упоминание найдено");
core.dismiss(keyOf(G, 108));
ok(core.view().items.find((i) => i.key === keyOf(G, 108)).status === "dismissed", "скрыто");
core.restore(keyOf(G, 108));
core.ignoreChat(String(G), true);
v = core.view();
ok(item(G, 108).status === "dismissed" && v.cfg.ignoreChats.includes(String(G)), "чат в игноре, карточки скрыты");

// --- 9. похожесть ---
ok(similarity("Да,  сделаем", "Да, сделаем") === 1 && similarity("", "x") === 0, "similarity");

// --- 10. отправка: пустой текст и повтор ---
let err = null;
try {
  await core.send(keyOf(G, 104), "ещё раз", 0);
} catch (e) {
  err = e.message;
}
ok(err === "Уже отвечено", "повторная отправка запрещена");

core.dispose();
fs.rmSync(dir, { recursive: true, force: true });
console.log(`проверок ${n}, ошибок ${fails}`);
process.exitCode = fails ? 1 : 0;
