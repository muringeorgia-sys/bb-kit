// Проверка ядра «Ответы TG» без bb.
//   node run.mjs auth            — проверить вход (get_me)
//   node run.mjs scan            — найти упоминания (без генерации)
//   node run.mjs list            — открытые карточки
//   node run.mjs gen <key>       — 3 варианта для карточки
//   node run.mjs profile         — пересобрать профиль тона
//   node run.mjs stats           — статистика обучения
// Отправку и черновик из CLI не делаем: только кнопкой в панели.
import { createCore } from "./core.mjs";

const [cmd, arg] = process.argv.slice(2);
const core = createCore({ log: (m) => console.error(`· ${m}`) });
const out = (x) => console.log(typeof x === "string" ? x : JSON.stringify(x, null, 1));
try {
  if (cmd === "auth") out({ ok: await core.checkAuth(), auth: core.view().auth });
  else if (cmd === "scan") {
    const j = await core.scan("cli", { generate: false });
    out({ found: j.found, error: j.error });
  } else if (cmd === "list") {
    for (const it of core.view().items.filter((i) => ["new", "tg_draft"].includes(i.status)))
      out(`${it.key} | ${it.kind} | ${it.chatTitle} | ${it.sender}: ${it.text.replace(/\s+/g, " ").slice(0, 90)}${it.gen?.variants?.length ? " | вариантов " + it.gen.variants.length : ""}`);
  } else if (cmd === "gen") out(await core.generate(arg));
  else if (cmd === "profile") {
    await core.buildProfile("cli");
    out(core.view().profile.auto);
  } else if (cmd === "stats") out(core.view().stats);
  else out("команды: auth | scan | list | gen <key> | profile | stats");
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
} finally {
  core.dispose();
}
