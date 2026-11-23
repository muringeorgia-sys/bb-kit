// ICE в эпике трекера: Impact и Confidence — из расчёта, Effort — часы (ИИ или разработчики), ICE = I × C ÷ E.
import type { IceFields, TrackerCall } from "./core/core.mjs";

export type IceVals = { impact: number | null; confidence: number | null; effort: number | null; ice: number | null };

export async function readIce(call: TrackerCall, fields: IceFields, keys: string[]): Promise<Record<string, IceVals & { summary: string }>> {
  const out: Record<string, IceVals & { summary: string }> = {};
  for (let i = 0; i < keys.length; i += 50) {
    const part = keys.slice(i, i + 50);
    const r = await call("POST", "/rest/api/3/search/jql", {
      jql: `key in (${part.join(",")})`, maxResults: 100, fields: ["summary", fields.impact, fields.confidence, fields.effort, fields.ice],
    });
    for (const it of r?.issues ?? []) {
      const f = it.fields ?? {};
      const num = (v: unknown) => (typeof v === "number" ? v : null);
      out[it.key] = { summary: f.summary ?? "", impact: num(f[fields.impact]), confidence: num(f[fields.confidence]), effort: num(f[fields.effort]), ice: num(f[fields.ice]) };
    }
  }
  return out;
}

export const iceOf = (impact: number | null, conf: number | null, effort: number | null): number | null => {
  if (impact == null || !effort) return null;
  if (impact === 0) return 0;
  if (conf == null) return null;
  return Math.round((impact * conf) / 100 / effort);
};

/** Что писать в эпик: Impact и Confidence — из расчёта; Effort — только в пустое поле; ICE — по Effort, который будет в трекере. */
export function icePlan(calc: any, cur: IceVals | undefined) {
  const effortUse = cur?.effort ?? calc?.effort_hours ?? null;
  const target: IceVals = { impact: calc?.impact ?? null, confidence: calc?.confidence ?? null, effort: effortUse, ice: iceOf(calc?.impact ?? null, calc?.confidence ?? null, effortUse) };
  const write: Partial<IceVals> = {};
  if (target.impact != null && target.impact !== cur?.impact) write.impact = target.impact;
  if (target.confidence != null && target.confidence !== cur?.confidence) write.confidence = target.confidence;
  if (cur?.effort == null && calc?.effort_hours) write.effort = calc.effort_hours;
  if (target.ice != null && target.ice !== cur?.ice) write.ice = target.ice;
  return { target, write, effortFrom: cur?.effort != null ? "трекер" : calc?.effort_hours ? "ИИ" : null };
}
