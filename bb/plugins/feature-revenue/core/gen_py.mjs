// Собирает core/py_scripts.mjs из core/*.py: bb собирает плагин в один файл, поэтому Python-скрипты
// едут строками и плагин сам пишет их в папку данных (py/) при запуске.
// После правки любого .py: node core/gen_py.mjs. Проверка, что файл свежий: node core/gen_py.mjs --check
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const files = ["build.py", "measure_fact.py", "review_mark.py"];
const body = [
  "// Сгенерировано core/gen_py.mjs из core/*.py — руками не править.",
  "export const PY_SCRIPTS = {",
  ...files.map((f) => `  ${JSON.stringify(f)}: ${JSON.stringify(readFileSync(path.join(here, f), "utf8").replace(/\r\n/g, "\n"))},`),
  "};",
  "",
].join("\n");
const out = path.join(here, "py_scripts.mjs");
if (process.argv.includes("--check")) {
  let cur = "";
  try { cur = readFileSync(out, "utf8"); } catch { /* нет файла */ }
  if (cur !== body) { console.error("py_scripts.mjs устарел: запустите node core/gen_py.mjs"); process.exit(1); }
  console.log("py_scripts.mjs свежий");
} else {
  writeFileSync(out, body, "utf8");
  console.log("записан", out);
}
