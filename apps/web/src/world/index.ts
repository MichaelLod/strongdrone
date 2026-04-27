import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import Stats from 'three/addons/libs/stats.module.js';
import { createSky } from './sky';
import { setupLighting, setupPostProcessing } from './lighting';
import { createTerrain } from './terrain';
import { buildNature } from './nature-loader';
import { buildDroneMesh } from './meshes/drone';

export type { GateRefs } from './gates';
export { buildGates, disposeGates, updateGates } from './gates';

export type SceneRefs = {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  drone: THREE.Group;
  controls: OrbitControls;
  propellers: THREE.Mesh[];
  render: (dt: number) => void;
  updateWorld: (elapsedSeconds: number) => void;
};

export function createScene(): SceneRefs {
  const scene = new THREE.Scene();
  const horizonColor = new THREE.Color(0xc8dff2);
  scene.fog = new THREE.Fog(horizonColor, 80, 260);
  // The PolyHaven HDRI is much brighter than the procedural sky we replaced,
  // so its IBL contribution dominates Fresnel reflections at grazing camera
  // angles (terrain looks bright at horizon, dark top-down). Damp it globally.
  scene.environmentIntensity = 0.45;

  const camera = new THREE.PerspectiveCamera(
    60,
    window.innerWidth / window.innerHeight,
    0.1,
    2000
  );
  camera.position.set(5, 4, 7);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  document.body.appendChild(renderer.domElement);

  const skyRefs = createSky(scene, {
    // Sun positioned behind the default camera (camera looks toward -x,-z).
    // Keeps the visible portion of the sky in the bluer "anti-solar" hemisphere.
    elevation: 30,
    azimuth: 135,
    turbidity: 10,
    rayleigh: 3,
    cloudCoverage: 0.4,
  });

  const lightingRefs = setupLighting(scene, renderer);
  lightingRefs.sun.position.copy(skyRefs.sunDirection).multiplyScalar(60);
  lightingRefs.sun.target.position.set(0, 0, 0);
  lightingRefs.sun.target.updateMatrixWorld();

  createTerrain(scene, {
    size: 400,
    edgeAmplitude: 9.0,        // taller hills at the perimeter
    playZoneAmplitude: 0.4,    // very gentle undulation in the spawn area
    playZoneRadius: 14,
  });

  const natureRefs = buildNature(scene);

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

  const ppRefs = setupPostProcessing(renderer, scene, camera);

  const stats = new Stats();
  stats.dom.style.position = 'fixed';
  stats.dom.style.right = '8px';
  stats.dom.style.bottom = '8px';
  stats.dom.style.left = 'auto';
  stats.dom.style.top = 'auto';
  stats.dom.style.zIndex = '10000';
  document.body.appendChild(stats.dom);
  const baseRender = ppRefs.render;
  const renderWithStats = (dt: number) => {
    baseRender(dt);
    stats.update();
  };

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    ppRefs.resize(window.innerWidth, window.innerHeight);
  });

  function updateWorld(elapsedSeconds: number) {
    skyRefs.update(elapsedSeconds);
    natureRefs.update(elapsedSeconds);
  }

  return {
    scene,
    camera,
    renderer,
    drone,
    controls,
    propellers,
    render: renderWithStats,
    updateWorld,
  };
}
