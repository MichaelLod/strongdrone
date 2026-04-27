import type { Action, Agent, AgentContext } from '../types';
import type { ActionLogEntry } from '../recorder';

export type ReplayAgent = Agent & {
  isExhausted(): boolean;
  progress(): { idx: number; total: number };
};

export function createReplayAgent(log: ActionLogEntry[]): ReplayAgent {
  let idx = 0;
  let lastAction: Action = { type: 'hover' };
  return {
    decide(ctx: AgentContext): Action {
      while (idx < log.length && log[idx].tick <= ctx.observation.tick) {
        lastAction = log[idx].action;
        idx++;
      }
      return lastAction;
    },
    isExhausted: () => idx >= log.length,
    progress: () => ({ idx, total: log.length }),
  };
}
