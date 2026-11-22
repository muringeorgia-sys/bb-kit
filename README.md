# bb-kit — сборка продакт-менеджера для bb, Claude Code и Codex

Навыки, панели bb и шаблоны правил, которыми я пользуюсь каждый день. Без привязки к аккаунту и без рабочих данных: ставите к себе и настраиваете под себя.

## Что внутри

### Навыки (Claude Code и Codex)

| Плагин | Навык | Что делает | Как вызвать |
|---|---|---|---|
| pm-thinking | `grilling` | Разбирает идею или план вопросами с рекомендуемым ответом, итог — файл решений | «погриль», «проверь мой план» |
| | `bro` | Пересказывает последний ответ простыми словами | «скажи проще», «не понял» |
| | `ketchup` | После долгого прогона: что изменилось и какие решения ждут вас | «что изменилось», «введи в курс» |
| | `recall` | Восстанавливает контекст по теме из логов, документов, памяти и тредов | «где я остановился по …» |
| | `sharpen` | Делает задачу глубже: что сделал бы профи, с каких сырых данных начать | «сделай глубже» |
| | `reflect` | Разбирает тред на уроки и предлагает правки скиллов и правил | «разбери тред», «рефлексия» |
| pm-research | `ajtbd-interview-guide` | Гайд AJTBD-интервью B2C и B2B, скрипты, рекрутинг респондентов | «гайд интервью», «B2B-интервью» |
| | `ux-test` | UX-тест прототипа: сценарий, протокол, сводка проблем, «чинить / стоп» | «UX-тест», «проверь прототип на людях» |
| pm-delivery | `release-check` | Приёмка релиза: критерии приёмки из PRD → чек-лист → таблица расхождений | «проверь релиз» |
| humanizer | `humanizer` | Убирает из текста признаки «написано ИИ» (сторонний, MIT) | «очеловечь текст» |
| caveman | `caveman` | Сжатые ответы без воды (сторонний, ставится из репозитория автора) | `/caveman` |

### Панели bb

| Плагин | Что делает |
|---|---|
| О себе | Паспорт пользователя: кто вы, цели, ограничения, как отвечать. Добавляется в инструкции каждого треда. Пока шаблон не заполнен — ничего не добавляет |
| Агенты | Список субагентов Claude: включить, выключить, редактировать, создать, запустить |
| Open In App | Windows: ссылки на pptx, pdf, docx, xlsx открываются в приложении по умолчанию |
| GenUI | Живые таблицы, графики и формы в ответах агента (сторонний, ставится из репозитория автора) |

### Шаблоны правил

| Файл | Куда положить |
|---|---|
| `rules/CLAUDE.md` | `~/.claude/CLAUDE.md` — общие правила для Claude Code и Codex |
| `rules/bb-AGENTS.md` | `~/.bb/AGENTS.md` — инструкции для всех тредов bb |

## Установка

### Claude Code

```bash
claude plugin marketplace add muringeorgia-sys/bb-kit
claude plugin install pm-thinking@bb-kit
claude plugin install pm-research@bb-kit
claude plugin install pm-delivery@bb-kit
claude plugin install humanizer@bb-kit
claude plugin install caveman@bb-kit
```

То же внутри Claude Code: `/plugin marketplace add muringeorgia-sys/bb-kit`, затем `/plugin`.

### bb

```bash
bb marketplace add git:github.com/muringeorgia-sys/bb-kit@main --subdirectory bb
bb plugin install about-me@bb-kit
bb plugin install agents@bb-kit
bb plugin install genui@bb-kit
bb plugin install open-in-app@bb-kit   # только Windows
```

После установки «О себе»: Settings → Installed plugins → О себе → заполните шаблон.

### Codex

Codex читает навыки из `~/.codex/skills`. Склонируйте репозиторий и сделайте ссылки:

```powershell
# Windows PowerShell
git clone https://github.com/muringeorgia-sys/bb-kit.git $HOME\bb-kit
Get-ChildItem $HOME\bb-kit\plugins\*\skills\* -Directory | ForEach-Object {
  New-Item -ItemType Junction -Force -Path "$HOME\.codex\skills\$($_.Name)" -Target $_.FullName | Out-Null
}
```

```bash
# macOS и Linux
git clone https://github.com/muringeorgia-sys/bb-kit.git ~/bb-kit
mkdir -p ~/.codex/skills
for d in ~/bb-kit/plugins/*/skills/*/; do ln -sfn "$d" ~/.codex/skills/"$(basename "$d")"; done
```

### Правила

1. Скопируйте `rules/CLAUDE.md` в `~/.claude/CLAUDE.md` и поправьте под себя.
2. Чтобы Codex читал те же правила, сделайте жёсткую ссылку:
   - Windows: `New-Item -ItemType HardLink -Path $HOME\.codex\AGENTS.md -Target $HOME\.claude\CLAUDE.md`
   - macOS и Linux: `ln ~/.claude/CLAUDE.md ~/.codex/AGENTS.md`
3. `rules/bb-AGENTS.md` — в `~/.bb/AGENTS.md`.

## Что ещё поставить

| Что | Команда |
|---|---|
| Next Move Theory Ивана Замесина: канон и навыки стратегии, сегментов, ценности | macOS и Linux: `curl -fsSL https://raw.githubusercontent.com/zamesin/Next-Move-Theory-Canon-and-Skills/main/install.sh \| bash`<br>Windows: `irm https://raw.githubusercontent.com/zamesin/Next-Move-Theory-Canon-and-Skills/main/install.ps1 \| iex`<br>Запускать в корне своего проекта |
| bb sidebar — доработанная боковая панель bb | `bb plugin install https://github.com/yusuf8834/bb-sidebar` |
| Agent Plugins — навыки и MCP один раз для всех провайдеров bb | `bb plugin install git:https://github.com/patleeman/bb-plugins.git` |

## Обновление

- Claude Code: `claude plugin marketplace update bb-kit`, затем переустановить нужные плагины.
- bb: `bb marketplace refresh bb-kit`, затем `bb plugin update --all`.
- Codex: `git -C ~/bb-kit pull` — ссылки подхватят изменения.

## Лицензия

MIT — для моих материалов, кроме `plugins/pm-research`: он пересказывает методику Ивана Замесина и поэтому идёт под CC BY-NC-SA 4.0 (некоммерческое использование, с указанием автора). Сторонние материалы сохраняют лицензии авторов: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
