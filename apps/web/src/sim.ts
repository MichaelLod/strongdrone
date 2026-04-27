import { Sim as RustSim } from '../wasm/strongdrone_sim';
import type { Action, Agent, AgentContext, Observation } from './types';

export type PilotMode = 'round' | 'live';

export type SimConfig = {
  actionPhaseDuration: number;
  physicsTimestep: number;
  pilotMode?: PilotMode;
};

export type GetContextParts = () => Pick<AgentContext, 'scenarioState' | 'gates'>;

export type DecisionEvent = { tick: number; action: Action };

export function createSim(initialAgent: Agent, getContextParts: GetContextParts, config: SimConfig) {
  const rustSim = new RustSim();
  let stepsPerPhase = Math.max(
    1,
    Math.round(config.actionPhaseDuration / config.physicsTimestep)
  );
  let stepsRemaining = 0;
  let currentAction: Action = { type: 'hover' };
  let deciding = false;
  let pilotMode: PilotMode = config.pilotMode ?? 'round';
  let agent: Agent = initialAgent;
  let onDecision: ((event: DecisionEvent) => void) | null = null;

  async function runDecide() {
    deciding = true;
    try {
      const observation = rustSim.getObservation() as Observation;
      const ctx: AgentContext = { observation, ...getContextParts() };
      const decideAgent = agent;
      const result = decideAgent.decide(ctx);
      const action = result instanceof Promise ? await result : result;
      if (agent !== decideAgent) return;
      const changed = JSON.stringify(action) !== JSON.stringify(currentAction);
      currentAction = action;
      rustSim.setAction(currentAction);
      if (changed) {
        const appliedTick = rustSim.getObservation().tick;
        onDecision?.({ tick: appliedTick, action });
      }
    } finally {
      deciding = false;
    }
  }

  async function stepRound() {
    if (deciding) return;
    if (stepsRemaining <= 0) {
      await runDecide();
      stepsRemaining = stepsPerPhase;
    }
    rustSim.step();
    stepsRemaining--;
  }

  function stepLive() {
    if (!deciding) {
      runDecide().catch((err) => console.error('decide failed:', err));
    }
    rustSim.step();
  }

  return {
    stepRound,
    stepLive,
    getObservation: () => rustSim.getObservation() as Observation,
    getAction: () => currentAction,
    isDeciding: () => deciding,
    reset: () => {
      rustSim.reset();
      stepsRemaining = 0;
      currentAction = { type: 'hover' };
    },
    setAgent: (next: Agent) => {
      agent = next;
      stepsRemaining = 0;
    },
    setActionPhaseDuration: (seconds: number) => {
      stepsPerPhase = Math.max(1, Math.round(seconds / config.physicsTimestep));
    },
    setPilotMode: (mode: PilotMode) => {
      pilotMode = mode;
    },
    getPilotMode: () => pilotMode,
    setOnDecision: (cb: ((event: DecisionEvent) => void) | null) => {
      onDecision = cb;
    },
  };
}
