import type { Action, Agent, AgentContext } from '../types';
import type { ActionLogEntry } from '../recorder';

export type ReplayAgent = Agent & {
  isExhausted(): boolean;
  progress(): { idx: number; total: number };
};

export function createReplayAgent(log: ActionLogEntry[]): ReplayAgent {
  let idx = 0;
  return {
    decide(ctx: AgentContext): Action {
      if (idx >= log.length) return { type: 'hover' };
      const entry = log[idx];
      idx++;
      if (entry.tick !== ctx.observation.tick) {
        console.warn(
          `replay tick drift @${idx - 1}: log says ${entry.tick}, sim at ${ctx.observation.tick}`
        );
      }
      return entry.action;
    },
    isExhausted: () => idx >= log.length,
    progress: () => ({ idx, total: log.length }),
  };
}
