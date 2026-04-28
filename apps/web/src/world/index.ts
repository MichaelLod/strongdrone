import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import Stats from 'three/addons/libs/stats.module.js';
import { createSky } from './sky';
import { setupLighting, setupPostProcessing } from './lighting';
import { createTerrain } from './terrain';
import { buildNature } from './nature-loader';
import { buildGroundFog } from './ground-fog';
import { buildBirds } from './birds';
import { buildDroneMesh } from './meshes/drone';

export type { GateRefs } from './gates';
export { buildGates, disposeGates, updateGates, updateGatesMotion } from './gates';

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
  // Soft warm-grey horizon haze — matches the HDRI's distant tone and hides
  // mountain LOD pops. Will be reinforced by a height-based ground fog later.
  const horizonColor = new THREE.Color(0xb6bfb8);
  scene.fog = new THREE.Fog(horizonColor, 90, 320);
  scene.environmentIntensity = 0.55;

  const camera = new THREE.PerspectiveCamera(
    60,
    window.innerWidth / window.innerHeight,
    0.1,
    3000
  );
  camera.position.set(5, 4, 7);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  document.body.appendChild(renderer.domElement);

  // Sun direction matches the visible sun baked into the HDRI so cast shadows
  // line up with the captured lighting.
  const skyRefs = createSky(scene, {
    elevation: 38,
    azimuth: 215,
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
  const groundFog = buildGroundFog(scene);
  const birds = buildBirds(scene);

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
    groundFog.update(elapsedSeconds);
    birds.update(elapsedSeconds);
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
