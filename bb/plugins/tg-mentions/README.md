# Ответы TG — плагин bb

Находит сообщения в Telegram, где вас упомянули, и готовит 3 варианта ответа в вашем тоне. Ответ уходит только по вашей кнопке. Плагин учится на каждом ответе.

## Что делает

| Шаг | Как |
|---|---|
| Поиск | По расписанию (по умолчанию будни 10:00–17:45 каждые 15 минут), при запуске bb и по кнопке «Обновить» |
| Что считается упоминанием | @ник<br>ответ на ваше сообщение<br>имя без @ (настройка в панели)<br>новые сообщения в личке (без ботов) |
| Контекст | ±6 сообщений вокруг (личка ±8) и сообщение, на которое ответили |
| Варианты | Claude CLI (`claude -p`, по умолчанию Sonnet, без инструментов): коротко / по делу / уточнить. Подсказка → новые варианты |
| Ответ | «Отправить» — ответом на сообщение, после подтверждения<br>«Черновик в Telegram» — текст в поле ввода чата, дописать там |
| Обучение | Профиль тона из ваших сообщений (до 300) и пары «вариант → что вы отправили». Ваши правила главнее профиля |
| Метрика | Доля ответов без правок (похожесть ≥ 97 %) по неделям |

## Что нужно

| Что | Зачем |
|---|---|
| bb ≥ 0.46 | Сам плагин |
| Claude Code CLI с входом в аккаунт | Варианты ответа и профиль тона |
| Python ≥ 3.10, `git`, [uv](https://docs.astral.sh/uv/) | Сервер telegram-mcp |
| Ключи Telegram API (api_id, api_hash) | Вход в ваш аккаунт отдельным устройством |

## Установка

1. Плагин:

   ```bash
   bb marketplace add git:github.com/muringeorgia-sys/bb-kit@main --subdirectory bb
   bb plugin install tg-mentions@bb-kit
   ```

2. telegram-mcp ([chigwell/telegram-mcp](https://github.com/chigwell/telegram-mcp), Apache-2.0) в папку по умолчанию:

   ```powershell
   # Windows PowerShell
   git clone https://github.com/chigwell/telegram-mcp.git $HOME\.config\bb-tg-mentions\telegram-mcp
   cd $HOME\.config\bb-tg-mentions\telegram-mcp
   git checkout 6072a24   # проверенная версия
   uv sync
   ```

   ```bash
   # macOS и Linux
   git clone https://github.com/chigwell/telegram-mcp.git ~/.config/bb-tg-mentions/telegram-mcp
   cd ~/.config/bb-tg-mentions/telegram-mcp && git checkout 6072a24 && uv sync
   ```

   Другая папка — укажите её в настройке «Папка telegram-mcp».

3. Ключи Telegram API: [my.telegram.org](https://my.telegram.org) → API development tools → создать приложение → скопировать `api_id` и `api_hash`.

4. Настройки плагина: bb → Settings → Installed plugins → «Ответы TG».

   | Настройка | Что вписать |
   |---|---|
   | Telegram api_id, api_hash | Ключи из шага 3. Хранятся секретом bb, в панель не уходят |
   | Кто вы | Одна строка для модели: имя, роль, где работаете |
   | Имя устройства в Telegram | Как сессия видна в Telegram → Устройства |
   | Папка telegram-mcp | Пусто — папка из шага 2 |
   | Путь к Claude CLI | Пусто — `~/.local/bin/claude` или `claude` из PATH |
   | Расписание поиска (cron) | По умолчанию `*/15 10-17 * * 1-5`. После изменения — `bb plugin reload tg-mentions` |

   То же из терминала: `bb plugin config tg-mentions set about "Анна, менеджер продукта"`.

5. Вход: панель «Ответы TG» → «Показать QR» → Telegram на телефоне → Настройки → Устройства → Подключить устройство. Облачный пароль вводится в панели и не сохраняется.

6. В панели → Настройки: впишите имена, на которые откликаетесь без @ (например «Аня, Анна»).

## Безопасность

- telegram-mcp запускается с инструментами `read-only+reply_to_message,save_draft`. Отправка новых сообщений, удаление и другие действия скрыты.
- Отправка — только кнопкой в панели, с подтверждением. Из CLI отправки нет.
- Сообщения чатов уходят в Claude CLI для подготовки вариантов.
- Отключить: Telegram → Настройки → Устройства → ваше устройство → завершить. Или удалить плагин: `bb plugin remove tg-mentions` (удалит настройки и секреты).

## Данные

Папка `~/.config/bb-tg-mentions/`:

| Файл | Что |
|---|---|
| `mentions.session` | Сессия Telegram. Не передавайте никому |
| `data/state.json` | Карточки, настройки панели, профиль тона |
| `data/samples.json` | Ваши сообщения для профиля тона, до 2000 |
| `data/examples.jsonl` | Пары «вариант → что отправили» |
| `data/journal.jsonl` | Журнал действий |
| `py/` | Скрипты запуска telegram-mcp, плагин пишет их сам |

## Файлы плагина

| Файл | Что |
|---|---|
| `server.ts` | Настройки, RPC панели, расписание |
| `app.tsx` | Панель |
| `core/core.mjs` | Логика: MCP-клиент, поиск, генерация, отправка, обучение, статистика |
| `core/py_scripts.mjs` | Python-скрипты запуска и входа по QR |
| `core/run.mjs` | Проверка без bb: `node core/run.mjs auth \| scan \| list \| gen <key> \| profile \| stats`. Ключи — в переменных `TELEGRAM_API_ID`, `TELEGRAM_API_HASH` |
| `core/test_core.mjs` | Офлайн-тест на фейковом Telegram и модели: `node core/test_core.mjs` → «ошибок 0» |

## Лицензия

MIT. telegram-mcp — сторонний (Apache-2.0), в плагин не копируется.
