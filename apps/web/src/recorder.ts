import type { Action } from './types';
import type { ScenarioStatus } from './scenario';
import type { PilotMode } from './sim';

export type ActionLogEntry = { tick: number; action: Action };

export type RunRecord = {
  version: 1 | 2 | 3;
  scenarioId: string;
  seed: number;
  actionLog: ActionLogEntry[];
  status: ScenarioStatus;
  score: number | null;
  durationSimTime: number;
  startedAt: number;
  agentMode: 'keyboard' | 'llm';
  pilotMode?: PilotMode;
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

function pbKey(scenarioId: string, pilotMode: PilotMode): string {
  return `${PB_KEY_PREFIX}${pilotMode}:${scenarioId}`;
}

export function getPersonalBest(scenarioId: string, pilotMode: PilotMode): number | null {
  const raw = localStorage.getItem(pbKey(scenarioId, pilotMode));
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

export function maybeUpdatePB(
  scenarioId: string,
  pilotMode: PilotMode,
  score: number
): { isNewBest: boolean; previousBest: number | null } {
  const previousBest = getPersonalBest(scenarioId, pilotMode);
  if (previousBest === null || score < previousBest) {
    try {
      localStorage.setItem(pbKey(scenarioId, pilotMode), String(score));
    } catch {}
    return { isNewBest: true, previousBest };
  }
  return { isNewBest: false, previousBest };
}
