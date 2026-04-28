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
  destroyState: (DestroyState | null)[];
  particles: Particle[];
  particleGroup: THREE.Group;
  smokeMat: THREE.SpriteMaterial;
  sparkMat: THREE.SpriteMaterial;
  puffTex: THREE.CanvasTexture;
};

type TargetMotion = {
  home: { x: number; y: number; z: number };
  current: { x: number; y: number; z: number };
  wanderTarget: { x: number; y: number; z: number };
  velocity: THREE.Vector3;
  wanderTimer: number;
  yPhase: number;
  /** Latest velocity decision from the optional target AI. When non-null,
   *  motion ignores the wander spring and tracks this vector instead. */
  aiAction: { vx: number; vy: number; vz: number } | null;
};

type DestroyState = {
  velocity: THREE.Vector3;
  angularVel: THREE.Vector3;
  /** Seconds since hit. Used for flash decay + trail spawn timing. */
  age: number;
  trailAccum: number;
  grounded: boolean;
  /** Original emissive properties so the flash can decay back to baseline. */
  emissives: { mat: THREE.MeshStandardMaterial; baseIntensity: number }[];
};

type Particle = {
  sprite: THREE.Sprite;
  velocity: THREE.Vector3;
  life: number;
  maxLife: number;
  scaleStart: number;
  scaleEnd: number;
  alphaStart: number;
  gravity: number;
};

const WANDER_RADIUS = 2.8;
const WANDER_INTERVAL = 3.0;
const FLY_ALT_MIN = 1.6;
const FLY_ALT_MAX = 2.8;
const MAX_SPEED = 1.6;

const GRAVITY = 9.8;
const FLASH_DURATION = 0.35;
const TRAIL_INTERVAL = 0.04;
const GROUND_Y = 0.05;

export function buildGates(scene: THREE.Scene, positions: readonly Vec3[]): GateRefs {
  const groups: THREE.Group[] = [];
  const propellers: THREE.Mesh[][] = [];
  const livePositions: Vec3[] = [];
  const motion: TargetMotion[] = [];
  const destroyState: (DestroyState | null)[] = [];

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
      aiAction: null,
    });
    destroyState.push(null);
  }

  const puffTex = makePuffTexture();
  const smokeMat = new THREE.SpriteMaterial({
    map: puffTex,
    color: 0x2a2826,
    transparent: true,
    depthWrite: false,
    fog: true,
  });
  const sparkMat = new THREE.SpriteMaterial({
    map: puffTex,
    color: 0xffaa30,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: false,
  });
  const particleGroup = new THREE.Group();
  scene.add(particleGroup);

  return {
    groups,
    propellers,
    livePositions,
    motion,
    destroyState,
    particles: [],
    particleGroup,
    smokeMat,
    sparkMat,
    puffTex,
  };
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
  // Particles + their group
  for (const p of gates.particles) gates.particleGroup.remove(p.sprite);
  scene.remove(gates.particleGroup);
  gates.smokeMat.dispose();
  gates.sparkMat.dispose();
  gates.puffTex.dispose();

  gates.groups.length = 0;
  gates.propellers.length = 0;
  gates.livePositions.length = 0;
  gates.motion.length = 0;
  gates.destroyState.length = 0;
  gates.particles.length = 0;
}

export function updateGatesMotion(gates: GateRefs, dt: number, isRunning: boolean) {
  // Destruction physics needs a stable timestep so a paused tab doesn't
  // teleport falling drones. 50 ms cap is fine for 60 fps work.
  const step = Math.min(dt, 0.05);

  for (let i = 0; i < gates.groups.length; i++) {
    const group = gates.groups[i];
    const ds = gates.destroyState[i];

    if (ds) {
      updateDestroyedDrone(group, ds, gates, step);
      // Mirror live position so the agent reads the falling/landed coords.
      const live = gates.livePositions[i];
      live.x = group.position.x;
      live.y = group.position.y;
      live.z = group.position.z;
      // Spin props down to a slow idle as the drone tumbles.
      const propRate = ds.grounded ? 0 : 8;
      for (const prop of gates.propellers[i]) prop.rotateY(propRate * step);
      continue;
    }

    const m = gates.motion[i];
    if (isRunning) {
      if (m.aiAction) {
        // AI-controlled: blend velocity smoothly toward the AI's chosen vector
        // so transitions between decisions don't snap. Speed is still capped.
        const blend = 1 - Math.exp(-6.0 * step);
        m.velocity.x += (m.aiAction.vx - m.velocity.x) * blend;
        m.velocity.y += (m.aiAction.vy - m.velocity.y) * blend;
        m.velocity.z += (m.aiAction.vz - m.velocity.z) * blend;
        const sp = m.velocity.length();
        if (sp > MAX_SPEED) m.velocity.multiplyScalar(MAX_SPEED / sp);

        m.current.x += m.velocity.x * step;
        m.current.y += m.velocity.y * step;
        m.current.z += m.velocity.z * step;

        // Soft altitude clamp so a misbehaving model can't ground-crash itself
        // or fly into the cloud layer. The AI is told the limits in its prompt.
        if (m.current.y < 1.0) { m.current.y = 1.0; m.velocity.y = Math.max(0, m.velocity.y); }
        if (m.current.y > 4.0) { m.current.y = 4.0; m.velocity.y = Math.min(0, m.velocity.y); }
        // Soft tether to home (6 m) so it doesn't wander off the play area.
        const dx = m.current.x - m.home.x;
        const dz = m.current.z - m.home.z;
        const dist = Math.sqrt(dx * dx + dz * dz);
        if (dist > 6) {
          const k = 6 / dist;
          m.current.x = m.home.x + dx * k;
          m.current.z = m.home.z + dz * k;
          m.velocity.x *= 0.5;
          m.velocity.z *= 0.5;
        }
      } else {
        m.wanderTimer -= step;
        const ddx = m.wanderTarget.x - m.current.x;
        const ddz = m.wanderTarget.z - m.current.z;
        const distH = Math.sqrt(ddx * ddx + ddz * ddz);
        if (m.wanderTimer <= 0 || distH < 0.4) {
          m.wanderTarget = pickWanderTarget(m.home.x, m.home.y, m.home.z);
          m.wanderTimer = WANDER_INTERVAL * (0.6 + Math.random() * 0.8);
        }

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
      }
    } else {
      m.yPhase += step * 1.2;
      m.current.y = m.home.y + Math.sin(m.yPhase) * 0.06;
    }

    group.position.set(m.current.x, m.current.y, m.current.z);

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
    for (const prop of gates.propellers[i]) prop.rotateY(propRate * step);
  }

  updateParticles(gates, step);
}

export function updateGates(gates: GateRefs, currentIdx: number, _isRunning: boolean) {
  // Don't gate on isRunning — the moment the last target is hit, the scenario
  // flips to 'success' and isRunning goes false. We still want that final hit
  // to fire the destroy animation. `i < currentIdx` is the only condition
  // that matters; reset is handled by scenario.reset() resetting currentGate.
  for (let i = 0; i < gates.groups.length; i++) {
    if (i >= currentIdx || gates.destroyState[i]) continue;
    triggerDestroy(gates, i);
  }
}

// ---------------------------------------------------------------------------
// Destruction sequence
// ---------------------------------------------------------------------------

function triggerDestroy(gates: GateRefs, i: number) {
  const group = gates.groups[i];
  // Initial knockback — small upward + outward push and a tumble impulse so
  // the drone reads as "hit" rather than just dropped.
  const dirX = (Math.random() - 0.5) * 2;
  const dirZ = (Math.random() - 0.5) * 2;
  const velocity = new THREE.Vector3(dirX * 1.5, 1.8 + Math.random() * 1.2, dirZ * 1.5);
  const angularVel = new THREE.Vector3(
    (Math.random() - 0.5) * 6,
    (Math.random() - 0.5) * 4,
    (Math.random() - 0.5) * 6,
  );

  // Capture original emissives so the flash can decay back.
  const emissives: DestroyState['emissives'] = [];
  group.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    const mat = obj.material as THREE.Material | THREE.Material[];
    const list = Array.isArray(mat) ? mat : [mat];
    for (const m of list) {
      if (m instanceof THREE.MeshStandardMaterial) {
        emissives.push({ mat: m, baseIntensity: m.emissiveIntensity });
        m.emissiveIntensity = 4.5;
      }
    }
  });

  gates.destroyState[i] = {
    velocity,
    angularVel,
    age: 0,
    trailAccum: 0,
    grounded: false,
    emissives,
  };

  // Spawn the impact burst — sparks first (additive, bright), then smoke puffs.
  const pos = group.position;
  for (let k = 0; k < 14; k++) spawnSpark(gates, pos);
  for (let k = 0; k < 10; k++) spawnSmoke(gates, pos, /* fresh */ true);
}

function updateDestroyedDrone(
  group: THREE.Group,
  ds: DestroyState,
  gates: GateRefs,
  step: number,
) {
  ds.age += step;

  // Decay the hit flash back to baseline emissive over FLASH_DURATION.
  const flash = Math.max(0, 1 - ds.age / FLASH_DURATION);
  for (const e of ds.emissives) {
    e.mat.emissiveIntensity = e.baseIntensity + (4.5 - e.baseIntensity) * flash;
  }

  if (!ds.grounded) {
    // Gravity-driven fall + tumble.
    ds.velocity.y -= GRAVITY * step;
    // Mild air drag on horizontal so it doesn't fly away.
    ds.velocity.x *= 0.985;
    ds.velocity.z *= 0.985;

    group.position.x += ds.velocity.x * step;
    group.position.y += ds.velocity.y * step;
    group.position.z += ds.velocity.z * step;

    group.rotation.x += ds.angularVel.x * step;
    group.rotation.y += ds.angularVel.y * step;
    group.rotation.z += ds.angularVel.z * step;

    // Smoke trail — emit while falling.
    ds.trailAccum += step;
    while (ds.trailAccum >= TRAIL_INTERVAL) {
      ds.trailAccum -= TRAIL_INTERVAL;
      spawnSmoke(gates, group.position, false);
    }

    if (group.position.y <= GROUND_Y) {
      group.position.y = GROUND_Y;
      ds.grounded = true;
      // Settle with a final tilt so it looks like wreckage on the ground.
      const tiltX = (Math.random() > 0.5 ? 1 : -1) * (Math.PI / 3 + Math.random() * 0.25);
      const tiltZ = (Math.random() - 0.5) * (Math.PI / 3);
      group.rotation.set(tiltX, group.rotation.y, tiltZ);
      // Impact dust ring + a few last sparks.
      for (let k = 0; k < 10; k++) spawnDust(gates, group.position);
      for (let k = 0; k < 6; k++) spawnSpark(gates, group.position);
      // Dim the wreckage colour permanently.
      group.traverse((obj) => {
        if (obj instanceof THREE.Mesh) {
          const m = obj.material as THREE.MeshStandardMaterial;
          if (m.color) m.color.multiplyScalar(0.55);
        }
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Particle pool — tiny, allocates a Sprite per particle. Counts are small
// (≤ ~150 alive at the worst moment) so this stays under any GPU budget.
// ---------------------------------------------------------------------------

function spawnSmoke(gates: GateRefs, pos: THREE.Vector3, fresh: boolean) {
  const sprite = new THREE.Sprite(gates.smokeMat.clone());
  sprite.material.opacity = 0.7;
  const jitter = fresh ? 0.4 : 0.15;
  sprite.position.set(
    pos.x + (Math.random() - 0.5) * jitter,
    pos.y + (Math.random() - 0.5) * jitter,
    pos.z + (Math.random() - 0.5) * jitter,
  );
  const startScale = fresh ? 0.45 : 0.25;
  sprite.scale.setScalar(startScale);
  gates.particleGroup.add(sprite);

  const upBias = fresh ? 0.8 : 0.3;
  gates.particles.push({
    sprite,
    velocity: new THREE.Vector3(
      (Math.random() - 0.5) * 1.0,
      upBias + Math.random() * 0.6,
      (Math.random() - 0.5) * 1.0,
    ),
    life: 1.6 + Math.random() * 0.8,
    maxLife: 1.6 + Math.random() * 0.8,
    scaleStart: startScale,
    scaleEnd: startScale * (fresh ? 4.5 : 3.0),
    alphaStart: fresh ? 0.85 : 0.55,
    gravity: -1.0, // negative gravity = rises (smoke floats up)
  });
}

function spawnSpark(gates: GateRefs, pos: THREE.Vector3) {
  const sprite = new THREE.Sprite(gates.sparkMat.clone());
  sprite.material.opacity = 1.0;
  sprite.position.copy(pos);
  const startScale = 0.10 + Math.random() * 0.08;
  sprite.scale.setScalar(startScale);
  gates.particleGroup.add(sprite);

  gates.particles.push({
    sprite,
    velocity: new THREE.Vector3(
      (Math.random() - 0.5) * 6,
      Math.random() * 4 + 1,
      (Math.random() - 0.5) * 6,
    ),
    life: 0.4 + Math.random() * 0.3,
    maxLife: 0.4 + Math.random() * 0.3,
    scaleStart: startScale,
    scaleEnd: startScale * 0.5,
    alphaStart: 1.0,
    gravity: GRAVITY * 0.6,
  });
}

function spawnDust(gates: GateRefs, pos: THREE.Vector3) {
  const sprite = new THREE.Sprite(gates.smokeMat.clone());
  sprite.material.color = new THREE.Color(0x8a7a60);
  sprite.material.opacity = 0.6;
  const angle = Math.random() * Math.PI * 2;
  const r = 0.15 + Math.random() * 0.4;
  sprite.position.set(pos.x + Math.cos(angle) * r, pos.y + 0.05, pos.z + Math.sin(angle) * r);
  const startScale = 0.4 + Math.random() * 0.3;
  sprite.scale.setScalar(startScale);
  gates.particleGroup.add(sprite);

  gates.particles.push({
    sprite,
    velocity: new THREE.Vector3(
      Math.cos(angle) * (1.5 + Math.random()),
      0.3 + Math.random() * 0.5,
      Math.sin(angle) * (1.5 + Math.random()),
    ),
    life: 1.0 + Math.random() * 0.6,
    maxLife: 1.0 + Math.random() * 0.6,
    scaleStart: startScale,
    scaleEnd: startScale * 2.5,
    alphaStart: 0.6,
    gravity: -0.4,
  });
}

function updateParticles(gates: GateRefs, step: number) {
  for (let i = gates.particles.length - 1; i >= 0; i--) {
    const p = gates.particles[i];
    p.life -= step;
    if (p.life <= 0) {
      gates.particleGroup.remove(p.sprite);
      p.sprite.material.dispose();
      gates.particles.splice(i, 1);
      continue;
    }

    p.velocity.x *= 0.96;
    p.velocity.y -= p.gravity * step;
    p.velocity.z *= 0.96;
    p.sprite.position.x += p.velocity.x * step;
    p.sprite.position.y += p.velocity.y * step;
    p.sprite.position.z += p.velocity.z * step;

    const t = 1 - p.life / p.maxLife; // 0..1
    const scale = p.scaleStart + (p.scaleEnd - p.scaleStart) * t;
    p.sprite.scale.setScalar(scale);
    // Smooth alpha curve: ramp up briefly then ease out.
    const fadeIn = Math.min(1, t * 6);
    const fadeOut = 1 - Math.pow(t, 2.0);
    p.sprite.material.opacity = p.alphaStart * fadeIn * fadeOut;
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

// ---------------------------------------------------------------------------
// Particle texture — soft radial puff, used by smoke / spark / dust with
// different SpriteMaterial colours and blend modes.
// ---------------------------------------------------------------------------
function makePuffTexture(): THREE.CanvasTexture {
  const s = 64;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0.0, 'rgba(255,255,255,1.0)');
  g.addColorStop(0.45, 'rgba(255,255,255,0.55)');
  g.addColorStop(1.0, 'rgba(255,255,255,0.0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  return tex;
}
