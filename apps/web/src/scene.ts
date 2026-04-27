import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { Vec3 } from './types';

export type SceneRefs = {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  drone: THREE.Group;
  controls: OrbitControls;
  propellers: THREE.Mesh[];
};

export type GateRefs = {
  meshes: THREE.Mesh[];
  groups: THREE.Group[];
};

export function createScene(): SceneRefs {
  const scene = new THREE.Scene();
  const horizonColor = new THREE.Color(0xc8dff2);
  scene.fog = new THREE.Fog(horizonColor, 80, 220);

  const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 800);
  camera.position.set(5, 4, 7);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  document.body.appendChild(renderer.domElement);

  scene.add(buildSkyDome());

  scene.add(new THREE.AmbientLight(0xfff5e1, 0.45));
  scene.add(new THREE.HemisphereLight(0xb8d8f5, 0x4a6028, 0.55));

  const sun = new THREE.DirectionalLight(0xfff2d6, 1.6);
  sun.position.set(20, 30, 12);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -25;
  sun.shadow.camera.right = 25;
  sun.shadow.camera.top = 25;
  sun.shadow.camera.bottom = -25;
  sun.shadow.camera.near = 0.5;
  sun.shadow.camera.far = 100;
  sun.shadow.bias = -0.0004;
  scene.add(sun);

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(400, 400),
    new THREE.MeshStandardMaterial({ map: makeGrassTexture(), roughness: 1.0 })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  scatterTrees(scene);

  const { group: drone, propellers } = buildDroneMesh();
  scene.add(drone);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.enablePan = false;
  controls.minDistance = 1.5;
  controls.maxDistance = 80;
  controls.maxPolarAngle = Math.PI * 0.49;
  controls.target.set(0, 1.5, 0);

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  return { scene, camera, renderer, drone, controls, propellers };
}

function buildSkyDome(): THREE.Mesh {
  const vertexShader = `
    varying vec3 vDir;
    void main() {
      vDir = normalize((modelMatrix * vec4(position, 1.0)).xyz);
      gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0);
    }
  `;
  const fragmentShader = `
    varying vec3 vDir;
    uniform vec3 topColor;
    uniform vec3 horizonColor;
    uniform vec3 groundColor;
    void main() {
      float t = vDir.y;
      vec3 col;
      if (t >= 0.0) {
        col = mix(horizonColor, topColor, smoothstep(0.0, 0.55, t));
      } else {
        col = mix(horizonColor, groundColor, smoothstep(0.0, -0.25, t));
      }
      gl_FragColor = vec4(col, 1.0);
    }
  `;
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      topColor: { value: new THREE.Color(0x3d7cc2) },
      horizonColor: { value: new THREE.Color(0xc8dff2) },
      groundColor: { value: new THREE.Color(0x5a6a72) },
    },
    vertexShader,
    fragmentShader,
    side: THREE.BackSide,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(380, 32, 16), mat);
  mesh.renderOrder = -1;
  return mesh;
}

function makeGrassTexture(): THREE.CanvasTexture {
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#4a6f30';
  ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < 4500; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const r = Math.random() * 1.6 + 0.4;
    const hue = 80 + Math.random() * 35;
    const sat = 35 + Math.random() * 30;
    const light = 18 + Math.random() * 28;
    ctx.fillStyle = `hsl(${hue}, ${sat}%, ${light}%)`;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  for (let i = 0; i < 60; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const r = 6 + Math.random() * 12;
    const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, 'rgba(90, 70, 40, 0.18)');
    grad.addColorStop(1, 'rgba(90, 70, 40, 0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(50, 50);
  tex.anisotropy = 8;
  return tex;
}

function scatterTrees(scene: THREE.Scene) {
  const count = 160;
  const trunkGeo = new THREE.CylinderGeometry(0.14, 0.20, 1.6, 6);
  trunkGeo.translate(0, 0.8, 0);
  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x4a3522, roughness: 0.95 });
  const trunkMesh = new THREE.InstancedMesh(trunkGeo, trunkMat, count);
  trunkMesh.castShadow = true;
  trunkMesh.receiveShadow = true;

  const foliageGeo = new THREE.ConeGeometry(1.0, 2.6, 7);
  foliageGeo.translate(0, 2.5, 0);
  const foliageMesh = new THREE.InstancedMesh(
    foliageGeo,
    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9 }),
    count
  );
  foliageMesh.castShadow = true;

  const dummy = new THREE.Object3D();
  const tint = new THREE.Color();
  const minR = 12;
  const maxR = 95;
  for (let i = 0; i < count; i++) {
    const angle = Math.random() * Math.PI * 2;
    const r = minR + Math.pow(Math.random(), 0.6) * (maxR - minR);
    const x = Math.cos(angle) * r;
    const z = Math.sin(angle) * r;
    const scale = 0.7 + Math.random() * 1.1;
    dummy.position.set(x, 0, z);
    dummy.rotation.set(0, Math.random() * Math.PI * 2, 0);
    dummy.scale.setScalar(scale);
    dummy.updateMatrix();
    trunkMesh.setMatrixAt(i, dummy.matrix);
    foliageMesh.setMatrixAt(i, dummy.matrix);
    const greenL = 0.18 + Math.random() * 0.18;
    const greenH = 0.25 + Math.random() * 0.10;
    tint.setHSL(greenH, 0.55, greenL);
    foliageMesh.setColorAt(i, tint);
  }
  trunkMesh.instanceMatrix.needsUpdate = true;
  foliageMesh.instanceMatrix.needsUpdate = true;
  if (foliageMesh.instanceColor) foliageMesh.instanceColor.needsUpdate = true;
  scene.add(trunkMesh);
  scene.add(foliageMesh);
}

export function buildGates(scene: THREE.Scene, positions: readonly Vec3[]): GateRefs {
  const meshes: THREE.Mesh[] = [];
  const groups: THREE.Group[] = [];
  for (const p of positions) {
    const group = buildGroundTargetMesh();
    group.position.set(p.x, 0, p.z);
    group.rotation.y = Math.random() * Math.PI * 2;
    scene.add(group);
    groups.push(group);

    const beacon = new THREE.Mesh(
      new THREE.SphereGeometry(0.07, 14, 12),
      new THREE.MeshStandardMaterial({
        color: 0x9aa0a8,
        emissive: 0x000000,
        roughness: 0.35,
        metalness: 0.2,
      })
    );
    beacon.position.set(p.x, p.y + 0.18, p.z);
    scene.add(beacon);
    meshes.push(beacon);
  }
  return { meshes, groups };
}

export function disposeGates(scene: THREE.Scene, gates: GateRefs) {
  for (const mesh of gates.meshes) {
    scene.remove(mesh);
    mesh.geometry.dispose();
    const mat = mesh.material as THREE.Material | THREE.Material[];
    if (Array.isArray(mat)) {
      for (const m of mat) m.dispose();
    } else {
      mat.dispose();
    }
  }
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
  gates.meshes.length = 0;
  gates.groups.length = 0;
}

export function updateGates(gates: GateRefs, currentIdx: number, isRunning: boolean) {
  for (let i = 0; i < gates.meshes.length; i++) {
    const beacon = gates.meshes[i];
    const mat = beacon.material as THREE.MeshStandardMaterial;
    const group = gates.groups[i];

    if (!isRunning) {
      mat.color.setHex(0x444444);
      mat.emissive.setHex(0x000000);
      beacon.visible = !group.userData.destroyed;
    } else if (i < currentIdx) {
      mat.color.setHex(0x55cc44);
      mat.emissive.setHex(0x114422);
      beacon.visible = false;
      if (!group.userData.destroyed) {
        group.userData.destroyed = true;
        group.rotation.x = (Math.random() > 0.5 ? 1 : -1) * (Math.PI / 3 + Math.random() * 0.3);
        group.rotation.z = (Math.random() - 0.5) * (Math.PI / 3);
        group.position.y = -0.05;
        group.traverse((obj) => {
          if (obj instanceof THREE.Mesh) {
            const m = obj.material as THREE.MeshStandardMaterial;
            if (m.color) m.color.multiplyScalar(0.5);
          }
        });
      }
    } else if (i === currentIdx) {
      mat.color.setHex(0xffd844);
      mat.emissive.setHex(0x553300);
      beacon.visible = true;
    } else {
      mat.color.setHex(0x9aa0a8);
      mat.emissive.setHex(0x000000);
      beacon.visible = true;
    }
  }
}

function buildGroundTargetMesh(): THREE.Group {
  const g = new THREE.Group();
  const bodyMat = new THREE.MeshStandardMaterial({
    color: 0x2a2e26,
    roughness: 0.7,
    metalness: 0.3,
  });
  const motorMat = new THREE.MeshStandardMaterial({
    color: 0x5a5a5e,
    roughness: 0.4,
    metalness: 0.7,
  });
  const propMat = new THREE.MeshStandardMaterial({ color: 0x1a1a1c, roughness: 0.7 });

  const plate = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.024, 0.12), bodyMat);
  plate.position.y = 0.012;
  plate.receiveShadow = true;
  g.add(plate);

  for (const angle of [Math.PI / 4, -Math.PI / 4]) {
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.014, 0.024), bodyMat);
    arm.rotation.y = angle;
    arm.position.y = 0.014;
    g.add(arm);
  }

  for (const [mx, mz] of [
    [0.12, 0.12],
    [0.12, -0.12],
    [-0.12, 0.12],
    [-0.12, -0.12],
  ]) {
    const motor = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.026, 0.022, 12), motorMat);
    motor.position.set(mx, 0.035, mz);
    g.add(motor);
    const prop = new THREE.Mesh(new THREE.CylinderGeometry(0.085, 0.085, 0.003, 14), propMat);
    prop.position.set(mx, 0.048, mz);
    g.add(prop);
  }

  const antenna = new THREE.Mesh(
    new THREE.CylinderGeometry(0.0025, 0.0025, 0.085, 6),
    new THREE.MeshStandardMaterial({ color: 0x3a2820, roughness: 0.8 })
  );
  antenna.position.set(-0.075, 0.067, 0);
  g.add(antenna);

  return g;
}

function buildDroneMesh(): { group: THREE.Group; propellers: THREE.Mesh[] } {
  const group = new THREE.Group();

  const carbonMat = new THREE.MeshStandardMaterial({
    color: 0x16161a,
    roughness: 0.35,
    metalness: 0.55,
  });
  const accentMat = new THREE.MeshStandardMaterial({
    color: 0xff5544,
    roughness: 0.45,
    metalness: 0.2,
  });
  const metalMat = new THREE.MeshStandardMaterial({
    color: 0xb8bcc4,
    roughness: 0.3,
    metalness: 0.85,
  });

  const bottomPlate = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.012, 0.14), carbonMat);
  bottomPlate.castShadow = true;
  group.add(bottomPlate);

  const topPlate = new THREE.Mesh(new THREE.BoxGeometry(0.20, 0.012, 0.12), carbonMat);
  topPlate.position.y = 0.075;
  topPlate.castShadow = true;
  group.add(topPlate);

  for (const [sx, sz] of [
    [0.085, 0.045],
    [-0.085, 0.045],
    [0.085, -0.045],
    [-0.085, -0.045],
  ]) {
    const standoff = new THREE.Mesh(
      new THREE.CylinderGeometry(0.0045, 0.0045, 0.075, 8),
      metalMat
    );
    standoff.position.set(sx, 0.038, sz);
    group.add(standoff);
  }

  const battery = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.038, 0.06), accentMat);
  battery.position.y = 0.035;
  battery.castShadow = true;
  group.add(battery);

  const stack = new THREE.Mesh(
    new THREE.BoxGeometry(0.07, 0.018, 0.07),
    new THREE.MeshStandardMaterial({ color: 0x0c2240, roughness: 0.5, metalness: 0.3 })
  );
  stack.position.y = 0.025;
  group.add(stack);

  const camHousing = new THREE.Mesh(
    new THREE.BoxGeometry(0.045, 0.045, 0.04),
    new THREE.MeshStandardMaterial({ color: 0x0a0a0c, roughness: 0.45, metalness: 0.3 })
  );
  camHousing.position.set(0.105, 0.085, 0);
  camHousing.rotation.z = -Math.PI / 9;
  camHousing.castShadow = true;
  group.add(camHousing);

  const camLens = new THREE.Mesh(
    new THREE.CylinderGeometry(0.014, 0.014, 0.012, 16),
    new THREE.MeshStandardMaterial({
      color: 0x0a0a18,
      emissive: 0x224488,
      emissiveIntensity: 0.4,
      roughness: 0.15,
      metalness: 0.5,
    })
  );
  camLens.position.set(0.128, 0.092, 0);
  camLens.rotation.z = Math.PI / 2 - Math.PI / 9;
  group.add(camLens);

  const antenna = new THREE.Mesh(
    new THREE.CylinderGeometry(0.0028, 0.0028, 0.07, 6),
    new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.7 })
  );
  antenna.position.set(-0.10, 0.115, 0);
  group.add(antenna);
  const antennaTip = new THREE.Mesh(
    new THREE.SphereGeometry(0.008, 8, 8),
    new THREE.MeshStandardMaterial({
      color: 0xff3322,
      emissive: 0xff2211,
      emissiveIntensity: 0.5,
    })
  );
  antennaTip.position.set(-0.10, 0.155, 0);
  group.add(antennaTip);

  const armLength = 0.55;
  for (const angle of [Math.PI / 4, -Math.PI / 4]) {
    const arm = new THREE.Mesh(
      new THREE.BoxGeometry(armLength, 0.022, 0.034),
      carbonMat
    );
    arm.rotation.y = angle;
    arm.castShadow = true;
    group.add(arm);
  }

  const motorPositions: [number, number, number, number][] = [
    [0.194, 0.011, 0.194, 1],
    [0.194, 0.011, -0.194, -1],
    [-0.194, 0.011, 0.194, -1],
    [-0.194, 0.011, -0.194, 1],
  ];

  const propellers: THREE.Mesh[] = [];
  const bladeMat = new THREE.MeshStandardMaterial({
    color: 0xe8e8ee,
    roughness: 0.55,
    metalness: 0.05,
  });
  const bellMat = new THREE.MeshStandardMaterial({
    color: 0xff5544,
    roughness: 0.35,
    metalness: 0.6,
  });

  for (const [mx, my, mz, spin] of motorPositions) {
    const housing = new THREE.Mesh(
      new THREE.CylinderGeometry(0.026, 0.030, 0.024, 18),
      metalMat
    );
    housing.position.set(mx, my + 0.012, mz);
    housing.castShadow = true;
    group.add(housing);

    const bell = new THREE.Mesh(
      new THREE.CylinderGeometry(0.022, 0.024, 0.012, 18),
      bellMat
    );
    bell.position.set(mx, my + 0.030, mz);
    group.add(bell);

    const hub = new THREE.Mesh(
      new THREE.CylinderGeometry(0.008, 0.008, 0.010, 12),
      metalMat
    );
    hub.position.set(mx, my + 0.041, mz);
    group.add(hub);

    const blade = new THREE.Mesh(new THREE.BoxGeometry(0.21, 0.0035, 0.020), bladeMat);
    blade.position.set(mx, my + 0.045, mz);
    blade.castShadow = true;
    blade.userData.spin = spin;
    group.add(blade);
    propellers.push(blade);
  }

  const skidMat = new THREE.MeshStandardMaterial({ color: 0x2a2a30, roughness: 0.7 });
  for (const xOff of [0.08, -0.08]) {
    const rail = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.04, 0.22), skidMat);
    rail.position.set(xOff, -0.034, 0);
    rail.castShadow = true;
    group.add(rail);
    for (const zOff of [0.10, -0.10]) {
      const pad = new THREE.Mesh(new THREE.BoxGeometry(0.020, 0.012, 0.034), skidMat);
      pad.position.set(xOff, -0.060, zOff);
      pad.castShadow = true;
      group.add(pad);
    }
  }

  return { group, propellers };
}
