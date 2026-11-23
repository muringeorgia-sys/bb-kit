# Конвейер PRD

Панель в сайдбаре bb: просмотр и правка навыка `/prd` (плагин Claude Code `prd-pipeline`) с журналом, версиями и откатом. Подробно - `README.md`.

Файлы: `server.ts` (RPC и настройки), `app.tsx` (UI), `types.ts`, `core/core.mjs` (чтение, запись, метки, версии, черновики), `core/prompts.mjs` (инструкции тредов правки и эталона), `core/test_core.mjs` (проверки).

После правки UI: `bb plugin build .`, затем `bb plugin reload prd-pipeline`. После правки `core.mjs`: `node core/test_core.mjs`.

Цвета - только токены темы bb, без `dark:`: в сборке плагина `dark:` следует теме Windows, а не режиму bb.
