// Демо-данные «Выручки фич»: условный онлайн-сервис курсов, 4 выдуманные фичи.
// Все числа выдуманы для примера и не относятся ни к одному реальному продукту.
// Даты считаются от сегодняшнего дня: ближайшие релизы — среды через 2 недели, месяцы — 3 последних закрытых.

const iso = (d) => d.toISOString().slice(0, 10);
const ym = (d) => d.toISOString().slice(0, 7);
const addDays = (d, n) => new Date(d.getTime() + n * 86400e3);
const addMonths = (d, n) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));

/** Демо-конфиг «все фичи» (releases/features.json). today — Date; currency — валюта из настроек. */
export function demoConfig(today = new Date(), currency = "₽") {
  const t = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  const toWed = (3 - t.getUTCDay() + 7) % 7 || 7;
  const r1 = addDays(t, toWed + 7), r2 = addDays(r1, 14), r3 = addDays(r2, 14), r4 = addDays(r3, 14);
  const m0 = addMonths(t, 0);
  const closed = [-3, -2, -1].map((n) => ym(addMonths(m0, n)));
  const planMonths = [0, 1].map((n) => ym(addMonths(m0, n)));
  const months = (vals) => Object.fromEntries(closed.map((k, i) => [k, vals[i]]));
  const plan = (vals) => Object.fromEntries(planMonths.map((k, i) => [k, vals[i]]));
  const yearEnd = `${r1.getUTCFullYear()}-12-31`;
  const offs = (neg, exp, pos) => ({ neg, exp, pos });

  return {
    release: {
      name: "Демо · условный онлайн-сервис курсов",
      year_end: yearEnd,
      dates: { r1: iso(r1), r2: iso(r2), r3: iso(r3), r4: iso(r4) },
    },
    currency,
    tracker: {
      source: "tracker.json",
      step_days: 14,
      cancelled_statuses: ["Отменено"],
      _note: "Статус и релиз фичи — из файла tracker.json (кнопка «Обновить из трекера»). Файла нет — из полей status и planned фичи",
    },
    out_xlsx: "out/Выручка-фич-{release}.xlsx",
    out_md_table: "out/summary_{release}.md",
    total_note: "ДЕМО: все числа выдуманы для примера.",
    fin_total: {
      spend_lines: [],
      topup_line: null,
      source: "Демо: у сервиса нет внутреннего баланса, все деньги прямые (k = 1)",
    },
    lines: {
      "Подписки": { months: months([2_300_000, 2_420_000, 2_520_000]), plan: plan([2_650_000, 2_700_000]), source: "ДЕМО: выдуманные числа" },
      "Разовые покупки": { months: months([520_000, 600_000, 720_000]), plan: plan([660_000, 700_000]), source: "ДЕМО: выдуманные числа" },
      "Реклама": { months: months([300_000, 320_000, 310_000]), plan: plan([330_000, 340_000]), source: "ДЕМО: выдуманные числа" },
    },
    plan_source: "ДЕМО: план по строкам выдуман. Обновляйте базу и план раз в месяц",
    release_offsets: {
      _note: "Сдвиг срока в релизах от планового: 0 — плановый, 1 — следующий. null — в релизе не считаем. near — до релиза меньше near_days дней",
      near_days: 14,
      near: {
        "Готово к выпуску": offs(0, 0, 0), "Выпущено": offs(0, 0, 0), "Тестирование": offs(1, 0, 0), "Разработка": offs(1, 0, 0),
        "Готово к разработке": offs(2, 1, 0), "Дизайн": offs(3, 2, 1), "Требования": offs(3, 2, 1), "Идея": null, "Отложено": null,
      },
      far: {
        "Готово к выпуску": offs(0, 0, 0), "Выпущено": offs(0, 0, 0), "Тестирование": offs(1, 0, 0), "Разработка": offs(1, 0, 0),
        "Готово к разработке": offs(1, 0, 0), "Дизайн": offs(2, 1, 0), "Требования": offs(2, 1, 0), "Идея": offs(3, 2, 1), "Отложено": null,
      },
      same_as: { "В работе": "Разработка", "К выпуску": "Готово к выпуску" },
      default: offs(2, 1, 0),
    },
    ramps: {
      instant: { "0": 1.0 },
      app: { "0": 0.12, "2": 0.45, "6": 0.72, "13": 0.85, "29": 0.94, "44": 0.96 },
      all_platforms: { "0": 0.3, "2": 0.56, "6": 0.78, "13": 0.88, "29": 0.95, "44": 0.97 },
      cohort90: { "0": 0.68, "30": 0.84, "60": 1.0 },
    },
    groups: {},
    features: [
      {
        key: "DEMO-1",
        name: "Годовой тариф со скидкой 20% (демо)",
        category: "Подписки",
        type: "A",
        status: "Разработка",
        planned: iso(r1),
        main_assumption: "ДЕМО: 8% месячных подписчиков перейдут на годовой тариф",
        breakeven: "ДЕМО: скидка окупается, если на годовой перейдут больше 5% подписчиков",
        measure: {
          metric: "Доля новых подписок на год", unit: "доля", base: 0, better: "higher", neg: 0.03, exp: 0.08, pos: 0.12,
          method: "ДЕМО: до/после по неделям", separable: "да", draft: "демо", facts: [],
        },
        effort: { size: "M", hours: 40, by: "демо", note: "Тариф, оплата, экран выбора тарифа" },
        inputs: [
          { id: "subs", name: "Месячных подписчиков", unit: "чел.", value: 6000, level: "У1", source: "ДЕМО: выдуманное число" },
          { id: "price_m", name: "Цена месячной подписки", unit: currency, value: 420, level: "У1", source: "ДЕМО: прайс" },
          { id: "to_year", name: "Доля, перешедшая на годовой", unit: "доля", neg: 0.03, exp: 0.08, pos: 0.12, level: "У4", source: "ДЕМО: экспертная оценка" },
          { id: "churn_cut", name: "Отток, который годовой тариф сохраняет, в месяц", unit: "доля", neg: 0, exp: 0.05, pos: 0.07, level: "У3", source: "ДЕМО: отток месячных 7%" },
          { id: "disc", name: "Скидка годового тарифа", unit: "доля", value: 0.2, level: "У1", source: "ДЕМО: решение по цене" },
        ],
        components: [
          {
            name: "Сохранённый отток у перешедших на годовой", part: "Удержание", line: "Подписки", mechanic: "цена",
            formula: "subs*to_year*churn_cut*12*price_m",
            formula_text: "подписчики × доля перешедших × сохранённый отток × 12 мес × цена",
            steps: [
              { id: "s_year", name: "Перешли на годовой: подписчики × доля", formula: "subs*to_year", unit: "чел." },
              { id: "s_kept", name: "Не ушли бы в месяц: перешедшие × сохранённый отток", formula: "s_year*churn_cut", unit: "чел." },
              { id: "s_kept_y", name: "Сохранённые за год: в месяц × 12", formula: "s_kept*12", unit: "чел." },
              { id: "s_money", name: "Деньги в месяц: сохранённые × цена", formula: "s_kept_y*price_m", unit: currency },
            ],
            ramp: "all_platforms", ramp_text: "сайт и приложение",
          },
          {
            name: "Скидка тем, кто остался бы и так", part: "Скидка", line: "Подписки", mechanic: "цена",
            formula: "-subs*to_year*price_m*disc",
            formula_text: "−(подписчики × доля перешедших × цена × скидка)",
            steps: [
              { id: "s_year2", name: "Перешли на годовой: подписчики × доля", formula: "subs*to_year", unit: "чел." },
              { id: "s_rev", name: "Платили бы в месяц: перешедшие × цена", formula: "s_year2*price_m", unit: currency },
              { id: "s_disc", name: "Скидка: выручка × доля скидки", formula: "s_rev*disc", unit: currency },
              { id: "s_loss", name: "Потеря: скидка со знаком минус", formula: "-s_disc", unit: currency },
            ],
            ramp: "all_platforms",
          },
        ],
      },
      {
        key: "DEMO-2",
        name: "Напоминание о брошенной корзине (демо)",
        category: "Разовые покупки",
        type: "B",
        status: "Готово к разработке",
        planned: iso(r2),
        main_assumption: "ДЕМО: напоминание возвращает 6% брошенных корзин",
        measure: {
          metric: "Доля оплаченных брошенных корзин", unit: "доля", base: 0.02, better: "higher", neg: 0.04, exp: 0.06, pos: 0.09,
          method: "ДЕМО: тест 50/50", separable: "да", draft: "демо", facts: [],
        },
        effort: { size: "S", hours: 16, by: "демо", note: "Письмо и пуш по событию" },
        inputs: [
          { id: "carts", name: "Брошенных корзин в месяц", unit: "шт.", value: 1500, level: "У1", source: "ДЕМО: выдуманное число" },
          { id: "back", name: "Доля, вернувшаяся после напоминания", unit: "доля", neg: 0, exp: 0.04, pos: 0.07, level: "У3", source: "ДЕМО: аналог из открытых кейсов" },
          { id: "check", name: "Средний чек разовой покупки", unit: currency, value: 900, level: "У1", source: "ДЕМО: выдуманное число" },
        ],
        components: [
          {
            name: "Возврат брошенных корзин", part: "Напоминание", line: "Разовые покупки", mechanic: "коммуникация",
            formula: "carts*back*check",
            formula_text: "брошенные корзины × доля вернувшихся × средний чек",
            steps: [
              { id: "s_back", name: "Вернулись: корзины × доля", formula: "carts*back", unit: "шт." },
              { id: "s_money", name: "Деньги в месяц: вернувшиеся × чек", formula: "s_back*check", unit: currency },
            ],
            ramp: "instant",
          },
        ],
      },
      {
        key: "DEMO-3",
        name: "Платный сертификат по итогам курса (демо)",
        category: "Разовые покупки",
        type: "A",
        status: "Дизайн",
        planned: iso(r3),
        main_assumption: "ДЕМО: сертификат купят 10% закончивших курс",
        measure: {
          metric: "Доля закончивших, купивших сертификат", unit: "доля", base: 0, better: "higher", neg: 0.03, exp: 0.1, pos: 0.15,
          method: "ДЕМО: факт продаж после релиза", separable: "да", draft: "демо", facts: [],
        },
        effort: { size: "L", hours: 80, by: "демо", note: "Шаблон сертификата, оплата, проверка подлинности" },
        inputs: [
          { id: "grads", name: "Закончивших курс в месяц", unit: "чел.", value: 600, level: "У1", source: "ДЕМО: выдуманное число" },
          { id: "buy", name: "Доля купивших сертификат", unit: "доля", neg: 0.0, exp: 0.1, pos: 0.15, level: "У5", source: "ДЕМО: гипотеза без данных" },
          { id: "price_c", name: "Цена сертификата", unit: currency, value: 990, level: "У1", source: "ДЕМО: прайс" },
        ],
        components: [
          {
            name: "Продажа сертификатов", part: "Сертификат", line: "Разовые покупки", mechanic: "новая услуга",
            formula: "grads*buy*price_c",
            formula_text: "закончившие × доля купивших × цена",
            steps: [
              { id: "s_buy", name: "Купят: закончившие × доля", formula: "grads*buy", unit: "чел." },
              { id: "s_money", name: "Деньги в месяц: купившие × цена", formula: "s_buy*price_c", unit: currency },
            ],
            ramp: "cohort90", lag_days: 14, ramp_text: "первые покупки — после окончания текущих потоков",
          },
        ],
      },
      {
        key: "DEMO-4",
        name: "Новый онбординг (демо)",
        category: "Подписки",
        type: "B",
        status: "Требования",
        planned: iso(r4),
        main_assumption: "ДЕМО: онбординг поднимает конверсию пробного периода в оплату на 1%",
        measure: {
          metric: "Конверсия пробного периода в оплату", unit: "доля", base: 0.18, better: "higher", neg: 0.18, exp: 0.182, pos: 0.185,
          method: "ДЕМО: тест 50/50", separable: "да", draft: "демо", facts: [],
        },
        effort: { size: "M", hours: 40, by: "демо", note: "3 экрана и подсказки" },
        inputs: [
          { id: "trials", name: "Пробных периодов в месяц", unit: "шт.", value: 4000, level: "У1", source: "ДЕМО: выдуманное число" },
          { id: "conv", name: "Конверсия пробного в оплату", unit: "доля", value: 0.18, level: "У1", source: "ДЕМО: выдуманное число" },
          { id: "lift", name: "Рост конверсии от онбординга", unit: "доля", neg: 0, exp: 0.01, pos: 0.03, level: "У5", source: "ДЕМО: экспертная оценка" },
          { id: "price_m", name: "Цена месячной подписки", unit: currency, value: 420, level: "У1", source: "ДЕМО: прайс" },
        ],
        components: [
          {
            name: "Больше оплат после пробного периода", part: "Онбординг", line: "Подписки", mechanic: "интерфейс",
            formula: "trials*conv*lift*price_m",
            formula_text: "пробные × конверсия × рост × цена",
            steps: [
              { id: "s_paid", name: "Оплачивают сейчас: пробные × конверсия", formula: "trials*conv", unit: "чел." },
              { id: "s_new", name: "Дополнительно оплатят: оплаты × рост", formula: "s_paid*lift", unit: "чел." },
              { id: "s_money", name: "Деньги в месяц: новые оплаты × цена", formula: "s_new*price_m", unit: currency },
            ],
            ramp: "app", ramp_text: "сначала приложение",
          },
        ],
      },
    ],
  };
}

