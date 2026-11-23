// Пункты выбора в панели. Конфиг со всеми фичами (поле tracker) даёт по пункту на релиз: релиз — фильтр.
// Конфиги одного релиза (releases/ГГГГ-ММ-ДД.json) — снимки оценки, релиз и статус в них из файла.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Calc } from "./calc";

export type ReleaseInfo = {
  key: string; file: string; release: string | null; group: "tracker" | "snap"; label: string; name: string;
  v3: boolean; features: number; planned: string | null;
};
type PoolList = { releases: { release: string; estimated: number; with_number: number; unestimated: unknown[] }[]; no_release: string[]; features: number } | null;

const ddmm = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}`;
const plural = (n: number, one: string, few: string, many: string) => {
  const m10 = n % 10, m100 = n % 100;
  return m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
};

export async function listReleases(calc: Calc, dir: string, log: (m: string) => void): Promise<ReleaseInfo[]> {
  const pool: ReleaseInfo[] = [];
  const snaps: ReleaseInfo[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    let cfg: any;
    try {
      cfg = JSON.parse(readFileSync(path.join(dir, file), "utf8"));
    } catch {
      snaps.push({ key: `${file}|`, file, release: null, group: "snap", label: `${file} · не читается`, name: file, v3: false, features: 0, planned: null });
      continue;
    }
    const feats: any[] = cfg.features ?? [];
    const v3 = !!cfg.lines || !!cfg.fin_total || feats.some((f) => (f.components ?? []).some((c: any) => "mechanic" in c || "line" in c));
    const name = cfg.release?.name ?? file;
    if (cfg.tracker) {
      let pl: PoolList = null;
      try {
        pl = (await calc.ask({ config: path.join(dir, file), list: true })) as PoolList;
      } catch (e) {
        log(`список релизов ${file}: ${(e as Error).message}`);
      }
      for (const r of pl?.releases ?? []) {
        const n = r.estimated, u = r.unestimated.length;
        const label = `Релиз ${ddmm(r.release)} · ${n ? `${n} ${plural(n, "фича", "фичи", "фич")}` : "нет оценок"}${u ? `, без оценки ${u}` : ""}`;
        pool.push({ key: `${file}|${r.release}`, file, release: r.release, group: "tracker", label, name, v3, features: n, planned: r.release });
      }
      if (pl?.no_release?.length) pool.push({ key: `${file}|none`, file, release: "none", group: "tracker", label: `Без релиза · ${pl.no_release.length}`, name, v3, features: pl.no_release.length, planned: null });
      pool.push({ key: `${file}|all`, file, release: "all", group: "tracker", label: `Все оценённые фичи · ${feats.length}`, name, v3, features: feats.length, planned: null });
      continue;
    }
    const planned: string | null = cfg.release?.planned ?? (Object.values(cfg.release?.dates ?? {}).sort()[0] as string | undefined) ?? null;
    const m = file.match(/^(\d{4})-(\d{2})-(\d{2})\.json$/);
    const label = m ? `Снимок ${m[3]}.${m[2]} · оценка ${cfg.release?.assessed ? ddmm(cfg.release.assessed) : "—"}` : file.replace(/\.json$/, "");
    snaps.push({ key: `${file}|`, file, release: null, group: "snap", label, name, v3, features: feats.length, planned });
  }
  snaps.sort((x, y) => {
    const dx = /^\d{4}-/.test(x.file), dy = /^\d{4}-/.test(y.file);
    if (dx !== dy) return dx ? -1 : 1;
    return y.file.localeCompare(x.file);
  });
  return [...pool, ...snaps];
}
