import type { Observation, Vec3 } from './types';

export type ScenarioStatus = 'running' | 'success' | 'crashed' | 'timeout';

export type ScenarioState = {
  status: ScenarioStatus;
  currentGate: number;
  totalGates: number;
  elapsedSimTime: number;
  score: number | null;
  distanceToGate: number;
};

export type Scenario = {
  reset(): void;
  update(obs: Observation, physicsTimestep: number): ScenarioState;
  getState(): ScenarioState;
  getGatePositions(): readonly Vec3[];
  getDefinition(): ScenarioDefinition;
};

export type ScenarioDefinition = {
  id: string;
  name: string;
  description: string;
  gates: Vec3[];
  gateRadius?: number;
  maxSimTime?: number;
};

export type WaypointScenarioConfig = {
  gates: Vec3[];
  gateRadius: number;
  maxSimTime: number;
  groundCrashY: number;
};

export const SCENARIOS: ScenarioDefinition[] = [
  {
    id: 'slalom',
    name: 'Slalom',
    description: '3 gates, gentle s-curve',
    gates: [
      { x: 5, y: 2.0, z: 0 },
      { x: 10, y: 3.0, z: 4 },
      { x: 15, y: 2.0, z: -2 },
    ],
    maxSimTime: 30,
  },
  {
    id: 'climb',
    name: 'Climb',
    description: '4 gates spiralling upward',
    gates: [
      { x: 3, y: 2, z: 0 },
      { x: 5, y: 4, z: 4 },
      { x: 1, y: 6, z: 5 },
      { x: -3, y: 8, z: 2 },
    ],
    maxSimTime: 30,
  },
  {
    id: 'tight',
    name: 'Tight Zigzag',
    description: '5 gates, sharp lateral cuts',
    gates: [
      { x: 4, y: 2, z: 3 },
      { x: 8, y: 2, z: -3 },
      { x: 12, y: 2, z: 3 },
      { x: 16, y: 2, z: -3 },
      { x: 20, y: 2, z: 0 },
    ],
    maxSimTime: 45,
  },
  {
    id: 'marathon',
    name: 'Marathon',
    description: '8 gates, full-arena loop',
    gates: [
      { x: 5, y: 2, z: 0 },
      { x: 10, y: 3, z: 5 },
      { x: 5, y: 4, z: 10 },
      { x: -5, y: 5, z: 8 },
      { x: -10, y: 4, z: 0 },
      { x: -5, y: 3, z: -8 },
      { x: 5, y: 4, z: -5 },
      { x: 10, y: 2, z: 0 },
    ],
    maxSimTime: 90,
  },
];

export function getScenarioById(id: string): ScenarioDefinition {
  return SCENARIOS.find((s) => s.id === id) ?? SCENARIOS[0];
}

export function createWaypointScenario(def: ScenarioDefinition): Scenario {
  const cfg: WaypointScenarioConfig = {
    gates: def.gates,
    gateRadius: def.gateRadius ?? 0.8,
    maxSimTime: def.maxSimTime ?? 30,
    groundCrashY: 0.15,
  };

  const initial = (): ScenarioState => ({
    status: 'running',
    currentGate: 0,
    totalGates: cfg.gates.length,
    elapsedSimTime: 0,
    score: null,
    distanceToGate: 0,
  });

  let state = initial();
  let startTick: number | null = null;
  let lastTick = -1;

  function reset() {
    state = initial();
    startTick = null;
    lastTick = -1;
  }

  function update(obs: Observation, physicsTimestep: number): ScenarioState {
    if (state.status !== 'running') return state;
    if (obs.tick === lastTick) return state;
    if (startTick === null) startTick = obs.tick;
    lastTick = obs.tick;
    state.elapsedSimTime = (obs.tick - startTick) * physicsTimestep;

    if (obs.position.y < cfg.groundCrashY) {
      state.status = 'crashed';
      return state;
    }

    if (state.elapsedSimTime > cfg.maxSimTime) {
      state.status = 'timeout';
      return state;
    }

    const target = cfg.gates[state.currentGate];
    const dx = target.x - obs.position.x;
    const dy = target.y - obs.position.y;
    const dz = target.z - obs.position.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    state.distanceToGate = dist;

    if (dist <= cfg.gateRadius) {
      state.currentGate++;
      if (state.currentGate >= cfg.gates.length) {
        state.status = 'success';
        state.score = state.elapsedSimTime;
      }
    }

    return state;
  }

  return {
    reset,
    update,
    getState: () => state,
    getGatePositions: () => cfg.gates,
    getDefinition: () => def,
  };
}
