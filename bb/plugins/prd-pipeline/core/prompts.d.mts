type Ctx = { data: string; skill: string; agents: string; pluginId: string };
export function draftText(ctx: Ctx): string;
export function evalText(ctx: Ctx): string;
