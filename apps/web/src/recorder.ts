import type { Action } from './types';
import type { ScenarioStatus } from './scenario';

export type ActionLogEntry = { tick: number; action: Action };

export type RunRecord = {
  version: 1 | 2;
  scenarioId: string;
  seed: number;
  actionLog: ActionLogEntry[];
  status: ScenarioStatus;
  score: number | null;
  durationSimTime: number;
  startedAt: number;
  agentMode: 'keyboard' | 'llm';
  actionPhaseDuration?: number;
  physicsTimestep?: number;
  model?: string;
};

const RUNS_KEY = 'strongdrone:runs';
const PB_KEY_PREFIX = 'strongdrone:pb:';
const MAX_RUNS = 100;

export function loadRuns(): RunRecord[] {
  try {
    const raw = localStorage.getItem(RUNS_KEY);
    return raw ? (JSON.parse(raw) as RunRecord[]) : [];
  } catch {
    return [];
  }
}

export function saveRun(run: RunRecord): void {
  const all = loadRuns();
  all.unshift(run);
  if (all.length > MAX_RUNS) all.length = MAX_RUNS;
  try {
    localStorage.setItem(RUNS_KEY, JSON.stringify(all));
  } catch (err) {
    console.warn('Failed to save run:', err);
  }
}

export function getPersonalBest(scenarioId: string): number | null {
  const raw = localStorage.getItem(PB_KEY_PREFIX + scenarioId);
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

export function maybeUpdatePB(
  scenarioId: string,
  score: number
): { isNewBest: boolean; previousBest: number | null } {
  const previousBest = getPersonalBest(scenarioId);
  if (previousBest === null || score < previousBest) {
    try {
      localStorage.setItem(PB_KEY_PREFIX + scenarioId, String(score));
    } catch {}
    return { isNewBest: true, previousBest };
  }
  return { isNewBest: false, previousBest };
}
