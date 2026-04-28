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
  /** Wire a callback that returns the *live* (possibly moving) target positions.
   *  Once set, getGatePositions and the distance check both read from it,
   *  so the AI chases the actual target rather than its spawn point. */
  setLivePositions(fn: () => readonly Vec3[]): void;
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
    id: 'recon-line',
    name: 'Recon Line',
    description: '3 ground drones along a road',
    gates: [
      { x: 8, y: 0.4, z: 0 },
      { x: 12, y: 0.4, z: 3 },
      { x: 16, y: 0.4, z: -2 },
    ],
    gateRadius: 1.0,
    maxSimTime: 30,
  },
  {
    id: 'forward-patrol',
    name: 'Forward Patrol',
    description: '4 ground drones in a wide arc',
    gates: [
      { x: 5, y: 0.4, z: 5 },
      { x: 10, y: 0.4, z: 8 },
      { x: 15, y: 0.4, z: 5 },
      { x: 12, y: 0.4, z: 0 },
    ],
    gateRadius: 1.0,
    maxSimTime: 40,
  },
  {
    id: 'dispersed',
    name: 'Dispersed Hides',
    description: '5 scattered ground drones',
    gates: [
      { x: 6, y: 0.4, z: 4 },
      { x: 12, y: 0.4, z: -3 },
      { x: 8, y: 0.4, z: -7 },
      { x: 16, y: 0.4, z: 6 },
      { x: 4, y: 0.4, z: 9 },
    ],
    gateRadius: 1.0,
    maxSimTime: 55,
  },
  {
    id: 'kill-box',
    name: 'Kill Box',
    description: '6 ground drones, tight cluster',
    gates: [
      { x: 9, y: 0.4, z: 0 },
      { x: 11, y: 0.4, z: 2 },
      { x: 13, y: 0.4, z: -1 },
      { x: 10, y: 0.4, z: -3 },
      { x: 8, y: 0.4, z: 3 },
      { x: 14, y: 0.4, z: 2 },
    ],
    gateRadius: 1.0,
    maxSimTime: 50,
  },
];

export function getScenarioById(id: string): ScenarioDefinition {
  return SCENARIOS.find((s) => s.id === id) ?? SCENARIOS[0];
}

/** Procedurally generate a scenario with `count` hostile drones placed in a
 *  randomized forward arc. Each call re-rolls the layout so two runs at the
 *  same count are different — keeps repeat play interesting. */
export function createCustomScenarioDef(count: number): ScenarioDefinition {
  const n = Math.max(1, Math.min(12, Math.round(count)));
  const baseAngle = Math.random() * Math.PI * 2;
  const gates: Vec3[] = [];
  // Spread targets in an arc; spacing widens with count to avoid overlap.
  const arcSpan = Math.min(Math.PI * 1.4, n * (Math.PI / 5));
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0 : (i / (n - 1)) - 0.5; // -0.5..0.5
    const angle = baseAngle + t * arcSpan + (Math.random() - 0.5) * 0.25;
    const dist = 7 + Math.random() * 11;
    gates.push({
      x: Math.cos(angle) * dist,
      y: 0.4,
      z: Math.sin(angle) * dist,
    });
  }
  return {
    id: `custom-${n}`,
    name: `Custom — ${n} drone${n === 1 ? '' : 's'}`,
    description: `${n} hostile drone${n === 1 ? '' : 's'}`,
    gates,
    gateRadius: 1.0,
    maxSimTime: 12 + n * 8,
  };
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
  let livePositionsFn: (() => readonly Vec3[]) | null = null;
  const positions = (): readonly Vec3[] => livePositionsFn ? livePositionsFn() : cfg.gates;

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

    const target = positions()[state.currentGate];
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
    getGatePositions: () => positions(),
    setLivePositions: (fn) => { livePositionsFn = fn; },
    getDefinition: () => def,
  };
}
