export declare const DEFAULT_DATA_DIR: string;
export type DataPaths = {
  dir: string; releases: string; demo: boolean; build: string; measureFact: string; reviewMark: string;
  method: string; iceDir: string; reviewsDir: string;
};
export declare function ensureData(dataDir: string, opts?: { currency?: string; today?: Date }): DataPaths;
export type Python = { cmd: string; pre: string[]; version: string };
export declare function findPython(setting?: string): Python;
export type IceFields = { impact: string; confidence: string; effort: string; ice: string };
export declare function parseIceFields(s: string | undefined): IceFields | null;
export type TrackerCall = (method: string, path: string, body?: unknown) => Promise<any>;
export declare function trackerClient(o: { url?: string; email?: string; token?: string }): TrackerCall | null;
export declare function refreshTracker(call: TrackerCall, jql: string, file: string, opts?: { maxIssues?: number }): Promise<{ epics: number; versions: number }>;
export declare function openPath(target: string): { cmd: string; args: string[] };
export declare function existsSync(p: string): boolean;
