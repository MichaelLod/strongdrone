import * as THREE from 'three';
import type { Vec3 } from '../types';
import { buildTargetDroneMesh } from './meshes/target-drone';

export type GateRefs = {
  groups: THREE.Group[];
  propellers: THREE.Mesh[][];
  /** Live world positions of each target — mutated by updateGatesMotion every
   *  frame and read by the scenario / agent so the AI chases the moving drone
   *  rather than the original spawn point. */
  livePositions: Vec3[];
  motion: TargetMotion[];
};

type TargetMotion = {
  home: { x: number; y: number; z: number };
  current: { x: number; y: number; z: number };
  wanderTarget: { x: number; y: number; z: number };
  velocity: THREE.Vector3;
  wanderTimer: number;
  yPhase: number;
};

const WANDER_RADIUS = 2.8;
const WANDER_INTERVAL = 3.0;
const FLY_ALT_MIN = 1.6;
const FLY_ALT_MAX = 2.8;
const MAX_SPEED = 1.6;

export function buildGates(scene: THREE.Scene, positions: readonly Vec3[]): GateRefs {
  const groups: THREE.Group[] = [];
  const propellers: THREE.Mesh[][] = [];
  const livePositions: Vec3[] = [];
  const motion: TargetMotion[] = [];

  for (const p of positions) {
    const flyY = FLY_ALT_MIN + Math.random() * (FLY_ALT_MAX - FLY_ALT_MIN);
    const drone = buildTargetDroneMesh();
    drone.group.position.set(p.x, flyY, p.z);
    drone.group.rotation.y = Math.random() * Math.PI * 2;
    scene.add(drone.group);
    groups.push(drone.group);
    propellers.push(drone.propellers);

    const live = { x: p.x, y: flyY, z: p.z };
    livePositions.push(live);

    motion.push({
      home: { x: p.x, y: flyY, z: p.z },
      current: live,
      wanderTarget: pickWanderTarget(p.x, flyY, p.z),
      velocity: new THREE.Vector3(),
      wanderTimer: Math.random() * WANDER_INTERVAL,
      yPhase: Math.random() * Math.PI * 2,
    });
  }

  return { groups, propellers, livePositions, motion };
}

export function disposeGates(scene: THREE.Scene, gates: GateRefs) {
  for (const group of gates.groups) {
    scene.remove(group);
    group.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.geometry.dispose();
        const m = obj.material as THREE.Material | THREE.Material[];
        if (Array.isArray(m)) for (const mm of m) mm.dispose();
        else m.dispose();
      }
    });
  }
  gates.groups.length = 0;
  gates.propellers.length = 0;
  gates.livePositions.length = 0;
  gates.motion.length = 0;
}

export function updateGatesMotion(gates: GateRefs, dt: number, isRunning: boolean) {
  // Clamp dt so a paused tab + tab-resume doesn't teleport every drone.
  const step = Math.min(dt, 0.05);
  for (let i = 0; i < gates.groups.length; i++) {
    const group = gates.groups[i];
    if (group.userData.destroyed) continue;
    const m = gates.motion[i];

    if (isRunning) {
      m.wanderTimer -= step;
      const ddx = m.wanderTarget.x - m.current.x;
      const ddz = m.wanderTarget.z - m.current.z;
      const distH = Math.sqrt(ddx * ddx + ddz * ddz);
      if (m.wanderTimer <= 0 || distH < 0.4) {
        m.wanderTarget = pickWanderTarget(m.home.x, m.home.y, m.home.z);
        m.wanderTimer = WANDER_INTERVAL * (0.6 + Math.random() * 0.8);
      }

      // Steering: spring toward wander target with damping; gives smooth bob.
      const accel = 1.6;
      const damp = Math.exp(-1.4 * step);
      m.velocity.x = m.velocity.x * damp + (m.wanderTarget.x - m.current.x) * accel * step;
      m.velocity.y = m.velocity.y * damp + (m.wanderTarget.y - m.current.y) * accel * step;
      m.velocity.z = m.velocity.z * damp + (m.wanderTarget.z - m.current.z) * accel * step;
      const sp = m.velocity.length();
      if (sp > MAX_SPEED) m.velocity.multiplyScalar(MAX_SPEED / sp);

      m.current.x += m.velocity.x * step;
      m.current.y += m.velocity.y * step;
      m.current.z += m.velocity.z * step;
    } else {
      // Idle hover: subtle vertical bob using yPhase, no horizontal drift.
      m.yPhase += step * 1.2;
      m.current.y = m.home.y + Math.sin(m.yPhase) * 0.06;
    }

    group.position.set(m.current.x, m.current.y, m.current.z);

    // Bank slightly into horizontal motion + face direction of travel.
    const speedH = Math.hypot(m.velocity.x, m.velocity.z);
    if (speedH > 0.05) {
      const heading = Math.atan2(m.velocity.x, m.velocity.z);
      group.rotation.y = heading;
      group.rotation.x = THREE.MathUtils.clamp(-m.velocity.z * 0.18, -0.4, 0.4);
      group.rotation.z = THREE.MathUtils.clamp( m.velocity.x * 0.18, -0.4, 0.4);
    } else {
      group.rotation.x *= 0.9;
      group.rotation.z *= 0.9;
    }

    const propRate = isRunning ? 90 : 30;
    for (const prop of gates.propellers[i]) {
      prop.rotateY(propRate * step);
    }
  }
}

export function updateGates(gates: GateRefs, currentIdx: number, isRunning: boolean) {
  // Drives only the "drone destroyed" visual now that beacons are gone — when
  // the scenario advances past a target, knock the drone out of the sky once.
  if (!isRunning) return;
  for (let i = 0; i < gates.groups.length; i++) {
    const group = gates.groups[i];
    if (i >= currentIdx || group.userData.destroyed) continue;
    group.userData.destroyed = true;
    group.rotation.x = (Math.random() > 0.5 ? 1 : -1) * (Math.PI / 3 + Math.random() * 0.3);
    group.rotation.z = (Math.random() - 0.5) * (Math.PI / 3);
    group.position.y = -0.05;
    const live = gates.livePositions[i];
    live.x = group.position.x;
    live.y = group.position.y;
    live.z = group.position.z;
    group.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        const m = obj.material as THREE.MeshStandardMaterial;
        if (m.color) m.color.multiplyScalar(0.5);
      }
    });
  }
}

function pickWanderTarget(homeX: number, homeY: number, homeZ: number) {
  const angle = Math.random() * Math.PI * 2;
  const r = Math.random() * WANDER_RADIUS;
  return {
    x: homeX + Math.cos(angle) * r,
    y: homeY + (Math.random() - 0.5) * 0.5,
    z: homeZ + Math.sin(angle) * r,
  };
}
