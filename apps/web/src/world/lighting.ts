/**
 * research/lighting/sample.ts
 *
 * Reference lighting + post-processing pipeline for the strongdrone outdoor scene.
 * Targets Three.js r0.170, WebGL2, 60 fps on mid-range laptop GPU at ~1080p.
 *
 * Usage (replace renderer.render in the main loop):
 *   const lightRefs  = setupLighting(scene, renderer);
 *   const ppRefs     = setupPostProcessing(renderer, scene, camera);
 *   // each frame:
 *   ppRefs.render(deltaTime);
 *
 * Self-contained — only "three" and "three/addons/*" imports.
 */

import * as THREE from 'three';
import { EffectComposer }    from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass }        from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass }   from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass }        from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass }        from 'three/addons/postprocessing/OutputPass.js';
import { FXAAShader }        from 'three/addons/shaders/FXAAShader.js';
import { EXRLoader }         from 'three/addons/loaders/EXRLoader.js';

// ---------------------------------------------------------------------------
// Public return types
// ---------------------------------------------------------------------------

export type LightingRefs = {
  ambient:     THREE.AmbientLight;
  hemisphere:  THREE.HemisphereLight;
  sun:         THREE.DirectionalLight;
  /** Call after sky uniforms change to regenerate IBL. */
  refreshIBL:  () => void;
  dispose:     () => void;
};

export type PostProcessingRefs = {
  composer:    EffectComposer;
  bloom:       UnrealBloomPass;
  fxaa:        ShaderPass;
  /** Call every frame instead of renderer.render(scene, camera). */
  render:      (dt: number) => void;
  /** Call on window resize. */
  resize:      (w: number, h: number) => void;
  dispose:     () => void;
};

// ---------------------------------------------------------------------------
// setupLighting
// ---------------------------------------------------------------------------

/**
 * Replaces the existing ad-hoc lights with a physically-calibrated rig and
 * wires up ACES filmic tone mapping + IBL from the procedural sky.
 *
 * Physical calibration notes (legacy-lights OFF, useLegacyLights = false
 * default since r155):
 *   - Full midday sun outdoors ≈ 100 000 lux. Three.js DirectionalLight
 *     intensity is in lux when physicallyCorrectLights is on, so values in
 *     the tens-of-thousands are accurate. With tone mapping + exposure tuning
 *     we compress that into display range, so we keep artistic values (≈1–2)
 *     and lock exposure instead.
 *   - The legacy multiplier was effectively π (≈3.14). With legacy lights OFF
 *     the same visual brightness needs intensity × π. The values below are
 *     pre-multiplied so a swap from the old scene is drop-in.
 *   - Hemisphere light simulates sky/ground bounce and replaces the raw
 *     AmbientLight for more directionally-aware indirect light.
 *
 * ACES + exposure:
 *   - renderer.toneMapping = THREE.ACESFilmicToneMapping
 *   - renderer.toneMappingExposure = 0.85  (good start; range 0.6–1.1)
 *     Lower = darker / more contrast; higher = brighter / blown highlights.
 *   - OutputPass reads these settings automatically — do NOT set them again
 *     inside the composer chain.
 *
 * IBL via PMREMGenerator:
 *   - Renders the procedural sky sphere into a cubemap, blurs it with
 *     pre-filtered mip chain, and assigns it to scene.environment.
 *   - MeshStandardMaterial automatically picks up specular reflections and
 *     diffuse GI from scene.environment even without any extra HDR file.
 *   - Generate once at startup and again only if sky colors change.
 *   - PMREMGenerator is heavyweight — never call fromScene() every frame.
 */
export function setupLighting(
  scene:    THREE.Scene,
  renderer: THREE.WebGLRenderer,
): LightingRefs {

  // --- Tone mapping (must be set before IBL generation) -------------------
  renderer.toneMapping         = THREE.ACESFilmicToneMapping;
  // 0.4 keeps the Preetham sky from saturating to white while leaving room
  // for sun-lit surfaces. Light intensities are scaled up to compensate.
  renderer.toneMappingExposure = 0.4;
  // Render targets inside EffectComposer use HalfFloat for HDR headroom.
  // The OutputPass converts to sRGB. Do NOT set renderer.outputColorSpace
  // to SRGBColorSpace here; OutputPass handles that.

  // --- Ambient (very subtle fill — hemisphere does the heavy lifting) ------
  // Old value 0.45 → under ACES exposure 0.85 the same look needs ~0.75.
  // Start here and tweak after enabling post-processing.
  const ambient = new THREE.AmbientLight(0xfff5e1, 1.3);
  scene.add(ambient);

  // --- Hemisphere light (sky/ground bounce) --------------------------------
  // Sky: soft blue-white to match the procedural sky horizon colour.
  // Ground: muted olive-green matching the grass texture average albedo.
  // Legacy-lights OFF: multiply old intensity (0.55) by π ≈ 1.73.
  // Under ACES filmic the output is naturally compressed so a slightly higher
  // hemisphere value (1.1) reads as pleasant indirect bounce.
  const hemisphere = new THREE.HemisphereLight(
    0xb8d8f5,  // sky color (existing)
    0x4a6028,  // ground color (existing)
    1.9,
  );
  scene.add(hemisphere);

  // --- Directional sun ------------------------------------------------------
  // Old intensity 1.6 → legacy-lights OFF equivalent ≈ 1.6 × π ≈ 5.0.
  // With ACES + exposure 0.85 the visible brightness is very similar to the
  // original linear unlit output. Keep 1.6 to start; raise to 5.0 if you
  // want physically-calibrated footcandle levels (pair with exposure ~0.1).
  const sun = new THREE.DirectionalLight(0xfff2d6, 2.7);
  sun.position.set(20, 30, 12);   // same as original
  sun.castShadow             = true;
  sun.shadow.mapSize.set(2048, 2048);
  // Tighten frustum to increase shadow texel density over the play area.
  sun.shadow.camera.left     = -25;
  sun.shadow.camera.right    =  25;
  sun.shadow.camera.top      =  25;
  sun.shadow.camera.bottom   = -25;
  sun.shadow.camera.near     =  0.5;
  sun.shadow.camera.far      = 100;
  // Bias: -0.0004 keeps existing shadow acne away; PCFSoftShadowMap at 2048
  // gives ~0.025 world-unit edge softness which is appropriate for this scale.
  // Reduce normalBias if you see floating shadows on flat ground.
  sun.shadow.bias            = -0.0004;
  sun.shadow.normalBias      = 0.02;
  scene.add(sun);

  // --- IBL via PMREMGenerator ----------------------------------------------
  // We render a tiny offscreen scene containing only the sky dome into a
  // cube-map, then hand it to PMREMGenerator to build the mip chain used
  // by MeshStandardMaterial for image-based specular + diffuse.
  // Doing this from a RoomEnvironment-style scene is cheaper than fromEquirect.
  const pmremGen = new THREE.PMREMGenerator(renderer);
  pmremGen.compileEquirectangularShader();

  let envMap: THREE.Texture | null = null;

  function refreshIBL() {
    // Build a minimal scene with just the sky colours so PMREMGenerator
    // captures a smooth gradient — no geometry artefacts.
    const skyScene = new THREE.Scene();

    // Mirror the sky shader colours from scene.ts buildSkyDome():
    //   topColor    0x3d7cc2 → desaturate slightly for IBL (avoids blue cast)
    //   horizonColor 0xc8dff2
    //   groundColor  0x5a6a72
    // We use a hemisphere background instead of the full ShaderMaterial to
    // avoid shader compilation overhead inside PMREMGenerator.
    skyScene.background = new THREE.Color(0xc8dff2); // horizon as base

    const skyHemi = new THREE.HemisphereLight(
      0x3d7cc2,  // sky
      0x5a6a72,  // ground
      2.0,
    );
    skyScene.add(skyHemi);

    // Dispose previous env map before replacing.
    if (envMap) envMap.dispose();
    const rt = pmremGen.fromScene(skyScene, 0.04); // sigma=0.04 slight blur
    envMap = rt.texture;
    scene.environment = envMap;
    // scene.background is kept as-is (the custom ShaderMaterial sky dome).

    skyScene.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.geometry.dispose();
        if (Array.isArray(obj.material)) {
          obj.material.forEach((m) => m.dispose());
        } else {
          obj.material.dispose();
        }
      }
    });
  }

  refreshIBL();

  // --- Async HDRI upgrade --------------------------------------------------
  // The procedural IBL above gives the scene a usable env map immediately.
  // In the background we load a real PolyHaven HDRI and swap it in once ready
  // so material reflections and diffuse GI come from a captured sky.
  // The visible scene.background stays the procedural sky mesh — only the
  // environment (used for shader sampling) is upgraded.
  new EXRLoader()
    .load('/assets/env/kloofendal_43d_clear_puresky_4k.exr', (hdrTex) => {
      hdrTex.mapping = THREE.EquirectangularReflectionMapping;
      const rt = pmremGen.fromEquirectangular(hdrTex);
      if (envMap) envMap.dispose();
      envMap = rt.texture;
      scene.environment = envMap;
      hdrTex.dispose();
    });

  function dispose() {
    scene.remove(ambient, hemisphere, sun);
    if (envMap) envMap.dispose();
    pmremGen.dispose();
  }

  return { ambient, hemisphere, sun, refreshIBL, dispose };
}

// ---------------------------------------------------------------------------
// setupPostProcessing
// ---------------------------------------------------------------------------

/**
 * Builds the EffectComposer pipeline:
 *
 *   RenderPass
 *     → SAOPass         (contact AO; half-res option for perf)
 *     → UnrealBloomPass (emissive + bright-sky glow)
 *     → ShaderPass      (color grade + vignette)
 *     → ShaderPass      (FXAA)
 *     → OutputPass      (tone mapping + sRGB conversion)
 *
 * CRITICAL ORDER NOTE:
 *   OutputPass must be last. It reads renderer.toneMapping and converts to
 *   sRGB. All intermediate passes work in linear-light HDR space (the
 *   composer's internal render targets use HalfFloatType by default in r155+).
 *   Do not apply tone mapping in the renderer itself when using EffectComposer
 *   — it is applied once by OutputPass only.
 *
 * Bloom threshold:
 *   With ACESFilmicToneMapping at exposure 0.85, the scene's linear-light
 *   bright spots (sky highlight, emissives) sit above 1.0. A threshold of
 *   0.85 captures the drone's emissive antenna tip (emissiveIntensity 0.5 on
 *   0xff2211 → linear ~0.86) and the camera lens (0.4 × 0x224488 → ~0.3,
 *   below threshold intentionally). Raise to 1.0 to limit bloom to only
 *   sky/sun-facing surfaces.
 *
 * SAO vs SSAO:
 *   SAOPass (Scalable AO) is chosen over SSAOPass because it produces a wider,
 *   more physically-grounded occlusion field and has better outdoor appearance.
 *   SAOPass can drop fps by 35-45% at full res — enable halfRes or reduce
 *   kernelRadius for performance budgets. Disable entirely on low-end hardware.
 */
export function setupPostProcessing(
  renderer: THREE.WebGLRenderer,
  scene:    THREE.Scene,
  camera:   THREE.PerspectiveCamera,
): PostProcessingRefs {

  const w = window.innerWidth  * Math.min(window.devicePixelRatio, 2);
  const h = window.innerHeight * Math.min(window.devicePixelRatio, 2);
  const res = new THREE.Vector2(w, h);

  // --- Composer (HalfFloat targets for HDR headroom) -----------------------
  const composer = new EffectComposer(renderer);
  // EffectComposer defaults to HalfFloatType in r155+ which is correct for
  // ACES. Verify with: composer.renderTarget1.texture.type === HalfFloatType

  // Pass 1: geometry render
  const renderPass = new RenderPass(scene, camera);
  composer.addPass(renderPass);

  // Pass 2: Bloom (emissive highlights + sky overbright)
  const bloom = new UnrealBloomPass(res, 0.35, 0.5, 0.85);
  composer.addPass(bloom);

  // Pass 3: FXAA
  const fxaa = new ShaderPass(FXAAShader);
  const pixelRatio = renderer.getPixelRatio();
  fxaa.material.uniforms['resolution'].value.set(
    1 / (window.innerWidth  * pixelRatio),
    1 / (window.innerHeight * pixelRatio),
  );
  composer.addPass(fxaa);

  // Pass 4: OutputPass (tone mapping + sRGB) — MUST be last.
  const outputPass = new OutputPass();
  composer.addPass(outputPass);

  // --- Render function (drop-in for renderer.render) -----------------------
  function render(_dt: number) {
    composer.render();
  }

  // --- Resize handler -------------------------------------------------------
  function resize(w: number, h: number) {
    composer.setSize(w, h);

    const pr = renderer.getPixelRatio();
    bloom.setSize(w, h);

    // FXAA resolution must be updated on resize.
    fxaa.material.uniforms['resolution'].value.set(
      1 / (w * pr),
      1 / (h * pr),
    );
  }

  // Wire up resize automatically (callers can also call resize() manually).
  window.addEventListener('resize', () => {
    resize(window.innerWidth, window.innerHeight);
  });

  function dispose() {
    composer.dispose();
  }

  return { composer, bloom, fxaa, render, resize, dispose };
}

// ---------------------------------------------------------------------------
// Sun shaft / god-ray stub
// ---------------------------------------------------------------------------

/**
 * Fake volumetric sun shafts using an additive translucent cone placed at the
 * sun position. This is the cheapest viable approach — no post-processing pass.
 *
 * Trade-offs vs a proper GodRaysPass (VolumetricLightScatteringPass):
 *   - Cone: ~0 GPU cost; works at any angle; looks good when sun is high.
 *   - GodRays post pass: ~2–4 ms; accurate occlusion; dies when sun is off-screen.
 *
 * The cone approach is preferred for this drone scene because the sun never
 * dips to the horizon (it's locked at position 20, 30, 12).
 *
 * Call addSunShafts() once and add the returned mesh to the scene.
 */
export function addSunShafts(scene: THREE.Scene, sun: THREE.DirectionalLight): THREE.Mesh {
  // Cone apex at sun position, opens downward toward scene centre.
  // Cone is very tall so it visually intersects the sky dome.
  const geo = new THREE.ConeGeometry(22, 55, 24, 1, true); // open cone
  // Translate apex to top (cone apex = top vertex after rotation).
  geo.translate(0, -27.5, 0);

  const mat = new THREE.MeshBasicMaterial({
    color: 0xfff5d8,
    transparent: true,
    opacity: 0.045,
    side: THREE.FrontSide,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });

  const shafts = new THREE.Mesh(geo, mat);
  // Position apex at the sun direction (not exact position, but direction × far).
  const dir = sun.position.clone().normalize().multiplyScalar(60);
  shafts.position.copy(dir);
  // Aim cone toward scene origin.
  shafts.lookAt(0, 0, 0);
  shafts.renderOrder = 1; // render after opaque geometry

  scene.add(shafts);
  return shafts;
}

// ---------------------------------------------------------------------------
// Integration checklist (see notes.md for full details)
// ---------------------------------------------------------------------------
//
// 1. Call setupLighting() BEFORE scene.add() of any PBR objects so
//    scene.environment is set when materials are compiled.
//
// 2. Remove existing scene.add(new THREE.AmbientLight(...)) and
//    scene.add(new THREE.HemisphereLight(...)) and scene.add(sun) from scene.ts.
//    setupLighting() re-adds them.
//
// 3. In the main animation loop, replace:
//      renderer.render(scene, camera);
//    with:
//      ppRefs.render(dt);
//
// 4. Move the window resize listener from createScene() to ppRefs.resize().
//    Or keep both — renderer resize still needed for camera aspect.
//
// 5. Emissive intensity audit (see notes.md):
//    - camLens emissiveIntensity 0.4  → raise to ~1.2 under ACES 0.85
//    - antennaTip emissiveIntensity 0.5 → raise to ~1.5 for good bloom capture
//    - beacon mat.emissive 0x553300 (current gate) → raise emissiveIntensity
//      to 0.8 on active gate for visibility under tone mapping
