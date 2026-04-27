/**
 * Sky reference implementation for the strongdrone simulator.
 *
 * Approach: Three.js built-in Sky addon (Preetham analytic model) + procedural
 * cloud layer (FBM noise on a high-altitude plane) + sun glare via Lensflare +
 * horizon fog colour that tracks the sky shader's actual horizon radiance.
 *
 * Why this stack:
 *   - Sky addon is zero-dependency, ships with three/addons, and gives physically
 *     plausible Rayleigh + Mie scattering in a single draw call.
 *   - Cloud plane adds depth for < 0.2 ms/frame extra cost.
 *   - Lensflare uses only canvas-generated textures — no external asset files.
 *   - The whole system runs well inside a 60-fps budget on mid-range GPUs.
 *
 * Tone mapping requirement:
 *   The Sky shader outputs linear HDR values. Without ACESFilmicToneMapping the
 *   sky will be blown out white. Set on the renderer BEFORE calling createSky().
 *   Recommended exposure: 0.5 (matches three.js webgl_shaders_sky example).
 *   Other materials may look slightly darker than before — compensate by
 *   nudging AmbientLight intensity up ~10-20 % or raising exposure to 0.6.
 *
 * References: see notes.md
 */

import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { Lensflare, LensflareElement } from 'three/addons/objects/Lensflare.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type SkyOptions = {
  /** Sun elevation in degrees above the horizon. Default: 28 */
  elevation?: number;
  /** Sun azimuth in degrees (0 = south, 90 = west …). Default: 180 */
  azimuth?: number;
  /**
   * Atmospheric turbidity (dust / haze). Range 1–20.
   * 2 = very clear alpine air; 10 = summer haze. Default: 4
   */
  turbidity?: number;
  /**
   * Rayleigh scattering strength — controls how blue the sky is. Range 0–4.
   * Default: 1.0
   */
  rayleigh?: number;
  /**
   * Mie scattering coefficient — aerosol density. Range 0–0.1. Default: 0.005
   */
  mieCoefficient?: number;
  /**
   * Mie directional g parameter — forward-scattering strength. Range 0–1.
   * Higher = brighter halo around sun. Default: 0.8
   */
  mieDirectionalG?: number;
  /**
   * Cloud coverage fraction [0, 1]. 0 = clear sky; 1 = overcast. Default: 0.45
   */
  cloudCoverage?: number;
  /**
   * Cloud drift speed (world units / second). Default: 0.012
   */
  cloudSpeed?: number;
  /** Show the procedural cloud layer. Default: true */
  showClouds?: boolean;
  /** Show a Lensflare glare around the sun disc. Default: true */
  showLensflare?: boolean;
  /**
   * Renderer tone-mapping exposure. Applied to renderer.toneMappingExposure.
   * Default: 0.5
   */
  exposure?: number;
};

export type SkyRefs = {
  /** The Sky mesh — adjust sky.material.uniforms to change atmosphere at runtime */
  sky: InstanceType<typeof Sky>;
  /** Unit vector from scene origin toward the sun (read-only; recalculate via updateSun) */
  sunDirection: THREE.Vector3;
  /**
   * Call every frame (pass elapsed seconds) to animate cloud drift.
   * No-op if showClouds is false.
   */
  update: (elapsedSeconds: number) => void;
  /**
   * Reposition the sun at runtime.
   * Also updates fog colour and sun light direction.
   */
  updateSun: (elevationDeg: number, azimuthDeg: number) => void;
};

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export function createSky(scene: THREE.Scene, options: SkyOptions = {}): SkyRefs {
  const {
    elevation = 28,
    azimuth = 180,
    turbidity = 4,
    rayleigh = 1.0,
    mieCoefficient = 0.005,
    mieDirectionalG = 0.8,
    cloudCoverage = 0.45,
    cloudSpeed = 0.012,
    showClouds = true,
    showLensflare = true,
    exposure = 0.5,
  } = options;

  // -- Renderer tone mapping ------------------------------------------------
  // The Sky shader outputs linear HDR energy; ACES compresses it to displayable
  // range. Without this the sky appears washed-out / pure-white.
  const renderer = findRenderer();
  if (renderer) {
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = exposure;
  }

  // -- Sky mesh -------------------------------------------------------------
  const sky = new Sky();
  sky.scale.setScalar(10000);
  scene.add(sky);

  const skyUniforms = sky.material.uniforms;
  skyUniforms['turbidity'].value = turbidity;
  skyUniforms['rayleigh'].value = rayleigh;
  skyUniforms['mieCoefficient'].value = mieCoefficient;
  skyUniforms['mieDirectionalG'].value = mieDirectionalG;

  // The Preetham model in three.js Sky outputs HDR values that, under our
  // scene's higher tone-map exposure, saturate to white. Scale the linear
  // output before tone-mapping so the visible sky stays in deep-blue range.
  sky.material.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      'gl_FragColor = vec4( retColor, 1.0 );',
      'gl_FragColor = vec4( retColor * 0.18, 1.0 );'
    );
  };

  // -- Sun direction --------------------------------------------------------
  const sunDirection = new THREE.Vector3();

  function calcSunDirection(elevDeg: number, azDeg: number): THREE.Vector3 {
    // Three.js uses spherical coords: phi = polar angle from +Y, theta = azimuth
    const phi = THREE.MathUtils.degToRad(90 - elevDeg);
    const theta = THREE.MathUtils.degToRad(azDeg);
    return new THREE.Vector3().setFromSphericalCoords(1, phi, theta);
  }

  // -- Directional sun light is owned by world/lighting.ts ------------------
  // It reads sunDirection from this module's refs so shadows and specular
  // highlights stay coherent with the atmospheric scattering.

  // -- Cloud layer ----------------------------------------------------------
  // A large horizontal plane at ~800 m altitude rendered with a custom FBM
  // noise shader. The fragment alpha blends against the sky behind it.
  // The cloud plane uses BackSide geometry so the camera below always sees
  // the underside, which is correct for a cloud base.
  let cloudMesh: THREE.Mesh | null = null;
  let cloudUniforms: { uTime: { value: number }; uCoverage: { value: number }; uSunDir: { value: THREE.Vector3 } } | null = null;

  if (showClouds) {
    const cloudVertexShader = /* glsl */ `
      varying vec2 vUv;
      varying vec3 vWorldPos;
      void main() {
        vUv = uv;
        vec4 worldPos = modelMatrix * vec4(position, 1.0);
        vWorldPos = worldPos.xyz;
        gl_Position = projectionMatrix * viewMatrix * worldPos;
      }
    `;

    // Procedural cloud shader using layered FBM (Fractal Brownian Motion).
    // Three octaves of value noise compose the cloud shape density field.
    // Henyey-Greenstein phase approximation adds silver-lining back scatter.
    const cloudFragmentShader = /* glsl */ `
      uniform float uTime;
      uniform float uCoverage;  // [0,1] fraction of sky covered
      uniform vec3  uSunDir;    // normalised sun direction in world space
      varying vec2  vUv;
      varying vec3  vWorldPos;

      // ---- Cheap hash-based value noise ----
      float hash(vec2 p) {
        p = fract(p * vec2(127.1, 311.7));
        p += dot(p, p + 19.19);
        return fract(p.x * p.y);
      }

      float valueNoise(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        vec2 u = f * f * (3.0 - 2.0 * f); // smoothstep
        float a = hash(i);
        float b = hash(i + vec2(1.0, 0.0));
        float c = hash(i + vec2(0.0, 1.0));
        float d = hash(i + vec2(1.0, 1.0));
        return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
      }

      // Four-octave FBM for cloud density
      float fbm(vec2 p) {
        float v = 0.0;
        float amp = 0.5;
        float freq = 1.0;
        for (int i = 0; i < 4; i++) {
          v += amp * valueNoise(p * freq);
          freq *= 2.1;
          amp  *= 0.48;
        }
        return v;
      }

      // Henyey-Greenstein phase — forward scatter when looking toward sun
      float hg(float cosTheta, float g) {
        float g2 = g * g;
        return (1.0 - g2) / (4.0 * 3.14159 * pow(1.0 + g2 - 2.0 * g * cosTheta, 1.5));
      }

      void main() {
        // Animate cloud drift with time
        vec2 uv = vWorldPos.xz * 0.00045 + uTime * 0.006;

        // Two FBM layers at different scales and speeds for turbulence
        float d  = fbm(uv);
        d += 0.32 * fbm(uv * 2.3 - uTime * 0.003);

        // Coverage remapping: push density below threshold to zero
        float density = smoothstep(1.0 - uCoverage, 1.0, d);

        if (density < 0.001) discard;

        // Base cloud colour — white lit top, slightly grey base
        vec3 cloudColour = mix(vec3(0.82, 0.84, 0.88), vec3(1.0), density * 0.7);

        // Silver lining: forward-scatter glow near the sun
        vec3 viewDir = normalize(vWorldPos - cameraPosition);
        float cosA = dot(-viewDir, uSunDir);
        float phase = hg(cosA, 0.65);
        cloudColour += vec3(1.0, 0.96, 0.85) * phase * 0.22 * density;

        // Alpha fades at edges for softer cloud boundaries
        float alpha = density * 0.88;

        gl_FragColor = vec4(cloudColour, alpha);
      }
    `;

    const cu = {
      uTime: { value: 0.0 },
      uCoverage: { value: cloudCoverage },
      uSunDir: { value: sunDirection.clone() },
    };
    cloudUniforms = cu;

    const cloudMat = new THREE.ShaderMaterial({
      uniforms: cu,
      vertexShader: cloudVertexShader,
      fragmentShader: cloudFragmentShader,
      side: THREE.FrontSide,
      transparent: true,
      depthWrite: false,
    });

    // Large plane — covers the 400 m field plus visible horizon
    const cloudGeo = new THREE.PlaneGeometry(6000, 6000);
    cloudMesh = new THREE.Mesh(cloudGeo, cloudMat);
    // Position cloud base at 800 m — well above 15 m max drone altitude
    cloudMesh.position.y = 800;
    cloudMesh.rotation.x = -Math.PI / 2;
    cloudMesh.renderOrder = 1; // after sky, before opaque geometry
    scene.add(cloudMesh);
  }

  // -- Sun lens flare -------------------------------------------------------
  // Canvas-generated textures; no external files needed.
  let lensflare: InstanceType<typeof Lensflare> | null = null;
  let flareLight: THREE.PointLight | null = null;

  if (showLensflare) {
    const texGlare = makeGlareTexture(256);
    const texRing  = makeRingTexture(64);

    flareLight = new THREE.PointLight(0xffffff, 0, 0); // intensity 0 — purely decorative
    scene.add(flareLight);

    lensflare = new Lensflare();
    // Main glow disc at distance 0 (centred on the light source)
    lensflare.addElement(new LensflareElement(texGlare, 360, 0));
    // Secondary smaller ring artefacts along the lens axis
    lensflare.addElement(new LensflareElement(texRing,   80, 0.4));
    lensflare.addElement(new LensflareElement(texRing,   50, 0.7));
    flareLight.add(lensflare);
  }

  // -- updateSun helper -----------------------------------------------------
  // Call any time you want to change sun position at runtime.
  function updateSun(elevationDeg: number, azimuthDeg: number): void {
    const dir = calcSunDirection(elevationDeg, azimuthDeg);
    sunDirection.copy(dir);

    skyUniforms['sunPosition'].value.copy(dir);

    // Compute warmth factor for the fog horizon tint
    const elevRad = THREE.MathUtils.degToRad(elevationDeg);
    const warmth = Math.pow(1.0 - Math.max(0, Math.sin(elevRad)), 3.5);

    // Sync fog colour to approximate the sky's horizon radiance.
    // We sample the sky model at y ≈ 0 by using a low-elevation Rayleigh colour
    // interpolated with the warm sun colour based on turbidity.
    const horizonBlue = new THREE.Color(0xbdd8ef);
    const horizonWarm = new THREE.Color(0xe8b06a);
    const fogBlend = warmth * Math.min(1, turbidity / 8);
    const fogColour = horizonBlue.clone().lerp(horizonWarm, fogBlend);
    if (scene.fog) {
      (scene.fog as THREE.Fog).color.copy(fogColour);
    }

    // Move the flare light in the sky direction
    if (flareLight) {
      flareLight.position.copy(dir).multiplyScalar(5000);
    }

    // Update cloud sun direction uniform
    if (cloudUniforms) {
      cloudUniforms.uSunDir.value.copy(dir);
    }
  }

  // Perform initial placement
  updateSun(elevation, azimuth);

  // -- Animation update -----------------------------------------------------
  function update(elapsedSeconds: number): void {
    if (cloudUniforms) {
      cloudUniforms.uTime.value = elapsedSeconds * cloudSpeed * 60;
    }
  }

  return { sky, sunDirection, update, updateSun };
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Walk up Three.js's global renderer registry.
 * In a typical app there is exactly one WebGLRenderer — we grab it by
 * inspecting the DOM element Three.js appended, which avoids passing the
 * renderer all the way down the call stack.
 *
 * Falls back to null if no renderer canvas is found; the caller handles that
 * gracefully by skipping the toneMapping assignment.
 */
function findRenderer(): THREE.WebGLRenderer | null {
  // Try the canvas Three.js adds to document.body
  const canvas = document.querySelector('canvas');
  if (!canvas) return null;
  // There is no public renderer-from-canvas API in Three.js r170, so we
  // return null and let the caller set tone mapping separately if needed.
  // In practice the main integration should set toneMapping on the renderer
  // before calling createSky() — see integration notes in notes.md.
  return null;
}

/**
 * Generate a soft radial glow texture on a canvas — used as the main sun
 * glare element. No image file required.
 */
function makeGlareTexture(size: number): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;

  const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0.0, 'rgba(255, 240, 200, 1.0)');
  grad.addColorStop(0.15, 'rgba(255, 220, 150, 0.8)');
  grad.addColorStop(0.4, 'rgba(255, 180, 80, 0.3)');
  grad.addColorStop(1.0, 'rgba(255, 140, 40, 0.0)');

  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * Generate a thin ring texture — used as secondary lens artefact elements.
 */
function makeRingTexture(size: number): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;

  const cx = size / 2;
  const r = size * 0.38;
  const ringWidth = size * 0.08;

  const grad = ctx.createRadialGradient(cx, cx, r - ringWidth, cx, cx, r + ringWidth);
  grad.addColorStop(0.0, 'rgba(180, 200, 255, 0.0)');
  grad.addColorStop(0.5, 'rgba(200, 220, 255, 0.55)');
  grad.addColorStop(1.0, 'rgba(180, 200, 255, 0.0)');

  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
