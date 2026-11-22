// Python-скрипты для telegram-mcp. Хранятся строками: bb собирает плагин в один файл,
// поэтому ядро само записывает их в папку данных перед запуском (см. ensurePyScripts в core.mjs).
// Ключи Telegram API приходят в переменных окружения TELEGRAM_API_ID / TELEGRAM_API_HASH
// из секретов плагина. Скрипты их не выводят и не сохраняют.

export const LAUNCH_PY = String.raw`"""Запуск telegram-mcp для плагина bb «Ответы TG».

Своя сессия (отдельное устройство в Telegram): не мешает другим подключениям telegram-mcp.
Инструменты: только чтение + ответ на сообщение и черновик. Отправка — только по кнопке в панели.
Аргументы: <папка telegram-mcp> <путь к сессии без .session>. Имя устройства — env TG_DEVICE_NAME.
"""
import os
import sys
from pathlib import Path

MCP_DIR = Path(sys.argv[1])
SESSION = Path(sys.argv[2])

if not os.getenv("TELEGRAM_API_ID") or not os.getenv("TELEGRAM_API_HASH"):
    raise SystemExit("NO_CREDENTIALS")
if not SESSION.with_suffix(".session").is_file():
    raise SystemExit("NO_SESSION")

for key in tuple(os.environ):
    if key.startswith(("TELEGRAM_SESSION_STRING", "TELEGRAM_SESSION_NAME")):
        del os.environ[key]
os.environ.update(
    TELEGRAM_SESSION_NAME=str(SESSION),
    TELEGRAM_EXPOSED_TOOLS="read-only+reply_to_message,save_draft",
    TELEGRAM_SESSION_LOCK="exclusive",
    TELEGRAM_TRANSCRIBE="off",
    TELEGRAM_DEVICE_MODEL=os.getenv("TG_DEVICE_NAME") or "TG-ответы (bb)",
    TELEGRAM_SYSTEM_VERSION="Windows",
    TELEGRAM_APP_VERSION="2.0.1",
)
if str(MCP_DIR) not in sys.path:
    sys.path.insert(0, str(MCP_DIR))
os.chdir(SESSION.parent)

from main import main  # noqa: E402

main()
`;

export const LOGIN_PY = String.raw`"""Вход в Telegram для плагина «Ответы TG» по QR.

Аргумент: <путь к сессии без .session>. Имя устройства — env TG_DEVICE_NAME.
Протокол stdout (по строке):
  AUTH_OK                      — сессия авторизована
  QR <data:image/png;base64,…> — показать QR; действует ~30 секунд, потом приходит новый
  NEED_2FA                     — ждём облачный пароль одной строкой в stdin (не сохраняется)
  BAD_2FA                      — пароль неверный, ждём снова
  FAIL <причина>
Ключи, пароль и строку сессии не выводит.
"""
import asyncio
import base64
import io
import os
import sys

import qrcode
from telethon import TelegramClient
from telethon.errors import PasswordHashInvalidError, SessionPasswordNeededError

SESSION = sys.argv[1]


def say(text):
    print(text, flush=True)


async def read_line():
    loop = asyncio.get_running_loop()
    return (await loop.run_in_executor(None, sys.stdin.readline)).rstrip("\r\n")


async def two_factor(client):
    for _ in range(3):
        say("NEED_2FA")
        password = await asyncio.wait_for(read_line(), 300)
        try:
            await client.sign_in(password=password)
            return True
        except PasswordHashInvalidError:
            say("BAD_2FA")
    return False


async def login():
    if not os.getenv("TELEGRAM_API_ID") or not os.getenv("TELEGRAM_API_HASH"):
        say("FAIL нет ключей Telegram API: заполните api_id и api_hash в настройках плагина")
        return
    client = TelegramClient(
        SESSION,
        int(os.environ["TELEGRAM_API_ID"]),
        os.environ["TELEGRAM_API_HASH"],
        device_model=os.getenv("TG_DEVICE_NAME") or "TG-ответы (bb)",
        system_version="Windows",
        app_version="2.0.1",
    )
    await client.connect()
    try:
        if await client.is_user_authorized():
            say("AUTH_OK")
            return
        for _ in range(10):
            qr = await client.qr_login()
            buffer = io.BytesIO()
            qrcode.make(qr.url).save(buffer, format="PNG")
            say("QR data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode("ascii"))
            try:
                await qr.wait(timeout=30)
            except asyncio.TimeoutError:
                continue
            except SessionPasswordNeededError:
                if not await two_factor(client):
                    say("FAIL неверный облачный пароль")
                    return
            if await client.is_user_authorized():
                say("AUTH_OK")
                return
        say("FAIL QR истёк, начните вход заново")
    finally:
        await client.disconnect()


if __name__ == "__main__":
    try:
        asyncio.run(login())
    except Exception as exc:  # текст исключения может содержать данные аккаунта
        say(f"FAIL {type(exc).__name__}")
`;
