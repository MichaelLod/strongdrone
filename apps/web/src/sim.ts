import { Sim as RustSim } from '../wasm/strongdrone_sim';
import type { Action, Agent, AgentContext, Observation } from './types';

export type SimConfig = {
  actionPhaseDuration: number;
  physicsTimestep: number;
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
  let agent: Agent = initialAgent;
  let onDecision: ((event: DecisionEvent) => void) | null = null;

  async function step() {
    if (deciding) return;

    if (stepsRemaining <= 0) {
      deciding = true;
      try {
        const observation = rustSim.getObservation() as Observation;
        const ctx: AgentContext = { observation, ...getContextParts() };
        const decideAgent = agent;
        const result = decideAgent.decide(ctx);
        const action = result instanceof Promise ? await result : result;
        if (agent !== decideAgent) return;
        currentAction = action;
        rustSim.setAction(currentAction);
        onDecision?.({ tick: observation.tick, action: currentAction });
        stepsRemaining = stepsPerPhase;
      } finally {
        deciding = false;
      }
    }

    rustSim.step();
    stepsRemaining--;
  }

  return {
    step,
    getObservation: () => rustSim.getObservation() as Observation,
    getAction: () => currentAction,
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
    setOnDecision: (cb: ((event: DecisionEvent) => void) | null) => {
      onDecision = cb;
    },
  };
}
