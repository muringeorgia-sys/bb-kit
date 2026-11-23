// Типы для server.ts: ядро написано на JS, server.ts приводит модуль к своему типу Core.
export const OUT_DIR: string;
export const SITE: string;
export const PRODUCTS: { id: string; name: string; short: string; emoji: string }[];
export function configure(o: Record<string, unknown>): string[];
export function missing(): string[];
export function iso(t: number): string;
export function view(data: unknown, notes?: unknown, now?: number, io?: unknown): unknown;
export function loadData(pid?: string): unknown;
