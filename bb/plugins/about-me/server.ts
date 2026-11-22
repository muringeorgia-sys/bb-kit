// О себе — паспорт пользователя из настроек плагина добавляется в инструкции
// каждого треда bb во всех проектах.
import type { BbPluginApi } from "@get-bb/plugin-sdk";

const DEFAULT_ABOUT = `# Паспорт пользователя

## Кто я
<Роль, компания или сфера, в чём силён, чего не любишь делать.>

## Мои цели
<Главные цели на год: 1–3 пункта.>

## Как я работаю
<Где и когда работаешь, на каком устройстве.>

## Мои ограничения
- <Время, доступы, кто согласует решения.>

## Мои приоритеты
1. <Самое важное.>
2. <Второе по важности.>

## Как мне отвечать
- <Длина ответов, формат: списки, таблицы, файлы.>

## Чего избегать
- <Темы и вопросы, которые не нужны.>`;

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    about: {
      type: "string",
      label: "О себе",
      description:
        "Текст добавляется в инструкции каждого нового треда во всех проектах. Пустое поле ничего не добавляет. Лимит 4096 символов.",
      experimental_multiline: true,
      default: DEFAULT_ABOUT,
    },
  });

  // contributeInstructions синхронный, поэтому держим текущее значение в памяти.
  let about = (await settings.get()).about.trim();
  settings.onChange((next) => {
    about = next.about.trim();
  });

  // Пока шаблон не заполнен (остались <подсказки>), в инструкции ничего не уходит.
  bb.agents.contributeInstructions(() => (about && !/<[^>\n]+>/.test(about) ? about : null));
}
