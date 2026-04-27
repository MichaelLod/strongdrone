import type { ScenarioState } from './scenario';

export type Vec3 = { x: number; y: number; z: number };
export type Quat = { x: number; y: number; z: number; w: number };

export type Observation = {
  tick: number;
  position: Vec3;
  velocity: Vec3;
  orientation: Quat;
  angular_velocity: Vec3;
};

export type Action =
  | { type: 'velocity'; v: Vec3 }
  | { type: 'goto'; target: Vec3 }
  | { type: 'hover' }
  | { type: 'land' };

export type AgentContext = {
  observation: Observation;
  scenarioState: ScenarioState;
  gates: readonly Vec3[];
};

export type Agent = {
  decide(ctx: AgentContext): Action | Promise<Action>;
};
