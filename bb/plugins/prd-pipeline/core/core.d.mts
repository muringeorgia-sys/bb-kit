export const DATA: string;
export const LIVE: { skill: string; agents: string; disabled: string };
export const SKILL_KIND: string;
export function configure(opts?: { skill?: string; agents?: string; disabled?: string; data?: string }): {
  skill: string;
  agents: string;
  disabled: string;
  data: string;
  kind: string;
};
export function findSkill(home?: string): { dir: string; kind: string };
export function copyToUser(home?: string): unknown;
export function draftRoot(id: string): { skill: string; agents: string; disabled: string };
export function renderRoot(root: { skill: string; agents: string; disabled: string }): string[];
export function check(root?: unknown): { file: string; line: number; text: string }[];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function load(): any;
export function readFileText(rel: string, root?: unknown): string;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function previewChange(change: unknown, root?: unknown): any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function applyChange(change: unknown, meta?: { by?: string; title?: string; extra?: unknown }): any;
export function fixChange(mode: string, root?: unknown): unknown;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function acknowledgeOutside(by?: string): any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function previewRestore(versionId: string): any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function applyRestore(versionId: string, by?: string): any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createDraft(request: string): any;
export function setDraftMeta(id: string, patch: Record<string, unknown>): void;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function previewDraft(id: string): any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function acceptDraft(id: string, by?: string): any;
export function rejectDraft(id: string): void;
export function recordEvalRun(run: Record<string, unknown>): void;
