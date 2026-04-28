/**
 * Sky stub for the strongdrone simulator.
 *
 * The visible sky and IBL both come from a PolyHaven HDRI loaded by
 * lighting.ts (scene.background + scene.environment). This module only owns
 * the sun direction the scene relies on for shadow casting and (optionally) a
 * cheap lens flare around the baked sun disc.
 *
 * Why no Preetham Sky / no FBM cloud plane any more:
 *   - Mixing analytic atmosphere + 2D shader clouds + low-poly mountains
 *     produced an "uncanny valley" mid-realism look. Locking everything to
 *     one captured HDRI gives a single fidelity tier.
 *   - Cloud plane edges always smeared at grazing view angles — this kills
 *     that whole class of bug.
 */

import * as THREE from 'three';
import { Lensflare, LensflareElement } from 'three/addons/objects/Lensflare.js';

export type SkyOptions = {
  /** Sun elevation in degrees above horizon. The default 38° matches the
   *  baked sun in `kloofendal_38d_partly_cloudy_puresky` so cast shadows
   *  line up with the visible sun disc. */
  elevation?: number;
  /** Sun azimuth in degrees (0 = +Z, 90 = +X). Approximate to the HDRI sun. */
  azimuth?: number;
  /** Show a Lensflare at the sun direction. Default true. */
  showLensflare?: boolean;
};

export type SkyRefs = {
  sunDirection: THREE.Vector3;
  update: (elapsedSeconds: number) => void;
  updateSun: (elevationDeg: number, azimuthDeg: number) => void;
};

export function createSky(scene: THREE.Scene, options: SkyOptions = {}): SkyRefs {
  const {
    elevation = 38,
    azimuth = 215,
    showLensflare = true,
  } = options;

  const sunDirection = new THREE.Vector3();

  function calcSunDirection(elevDeg: number, azDeg: number): THREE.Vector3 {
    const phi = THREE.MathUtils.degToRad(90 - elevDeg);
    const theta = THREE.MathUtils.degToRad(azDeg);
    return new THREE.Vector3().setFromSphericalCoords(1, phi, theta);
  }

  let lensflare: InstanceType<typeof Lensflare> | null = null;
  let flareLight: THREE.PointLight | null = null;
  if (showLensflare) {
    flareLight = new THREE.PointLight(0xffffff, 0, 0);
    scene.add(flareLight);
    lensflare = new Lensflare();
    lensflare.addElement(new LensflareElement(makeGlareTexture(256), 280, 0));
    lensflare.addElement(new LensflareElement(makeRingTexture(64), 60, 0.45));
    lensflare.addElement(new LensflareElement(makeRingTexture(64), 40, 0.72));
    flareLight.add(lensflare);
  }

  function updateSun(elevationDeg: number, azimuthDeg: number) {
    sunDirection.copy(calcSunDirection(elevationDeg, azimuthDeg));
    if (flareLight) flareLight.position.copy(sunDirection).multiplyScalar(5000);
  }

  updateSun(elevation, azimuth);

  return {
    sunDirection,
    update: () => { /* no-op; clouds + atmosphere are baked into the HDRI */ },
    updateSun,
  };
}

// ---------------------------------------------------------------------------
// Lens-flare helper textures (canvas, no asset files)
// ---------------------------------------------------------------------------

function makeGlareTexture(size: number): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0.0, 'rgba(255, 240, 200, 1.0)');
  grad.addColorStop(0.18, 'rgba(255, 220, 150, 0.7)');
  grad.addColorStop(0.45, 'rgba(255, 180, 80, 0.18)');
  grad.addColorStop(1.0, 'rgba(255, 140, 40, 0.0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeRingTexture(size: number): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const cx = size / 2;
  const r = size * 0.38;
  const ringWidth = size * 0.08;
  const grad = ctx.createRadialGradient(cx, cx, r - ringWidth, cx, cx, r + ringWidth);
  grad.addColorStop(0.0, 'rgba(180, 200, 255, 0.0)');
  grad.addColorStop(0.5, 'rgba(200, 220, 255, 0.45)');
  grad.addColorStop(1.0, 'rgba(180, 200, 255, 0.0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
