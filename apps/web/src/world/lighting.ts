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
import { RGBELoader }        from 'three/addons/loaders/RGBELoader.js';

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
  // HDRI background is naturally calibrated (no analytic-sky dimming) so the
  // exposure can sit closer to neutral without blowing the sky to white.
  renderer.toneMappingExposure = 0.85;

  // --- Ambient (subtle fill — HDRI env map carries indirect now) -----------
  const ambient = new THREE.AmbientLight(0xfff5e1, 0.55);
  scene.add(ambient);

  // --- Hemisphere light (mostly redundant with HDRI but adds a touch of
  // ground bounce that the env map underweights) ----------------------------
  const hemisphere = new THREE.HemisphereLight(
    0xb8d8f5,
    0x5a6228,
    0.7,
  );
  scene.add(hemisphere);

  // --- Directional sun ------------------------------------------------------
  // Lower intensity now that HDRI does most of the work; keep it for crisp
  // shadow casting only.
  const sun = new THREE.DirectionalLight(0xfff2d6, 1.6);
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
  // PolyHaven HDRI drives BOTH lighting AND visible sky. PMREM-blurred copy
  // goes to scene.environment (specular reflections + diffuse IBL); the raw
  // equirect goes to scene.background so the captured sky + clouds + sun disc
  // are visible directly. This replaces the Preetham sky shader and the FBM
  // cloud plane in one step — the sky now matches the lighting it casts.
  new RGBELoader()
    .load('/assets/env/kloofendal_38d_partly_cloudy_puresky_2k.hdr', (hdrTex) => {
      hdrTex.mapping = THREE.EquirectangularReflectionMapping;
      const rt = pmremGen.fromEquirectangular(hdrTex);
      if (envMap) envMap.dispose();
      envMap = rt.texture;
      scene.environment = envMap;
      // Keep the equirect texture alive — it's now scene.background.
      scene.background = hdrTex;
      scene.backgroundIntensity = 1.0;
      scene.backgroundBlurriness = 0.0;
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

  // Pass 2: Bloom (emissive highlights + sky overbright). Threshold raised
  // for the new HDRI exposure (0.85) — previously 0.85 caught too much.
  const bloom = new UnrealBloomPass(res, 0.28, 0.55, 1.05);
  composer.addPass(bloom);

  // Pass 3: Stylized color grade + vignette + edge atmospheric tint.
  // Pulls the scene toward a cohesive "stylized realism" palette and frames
  // the view by softly darkening corners with a slight cool cast, the way
  // a real lens does. Single shader pass — almost free.
  const colorGrade = new ShaderPass({
    uniforms: {
      tDiffuse: { value: null },
      uSaturation: { value: 0.92 },
      uContrast: { value: 1.04 },
      uLift: { value: 0.025 },
      uTint: { value: new THREE.Color(1.03, 1.0, 0.94) },
      uVignetteStrength: { value: 0.55 },
      uVignetteRadius: { value: 0.95 },
      uEdgeHaze: { value: new THREE.Color(0.90, 0.94, 0.98) },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D tDiffuse;
      uniform float uSaturation;
      uniform float uContrast;
      uniform float uLift;
      uniform vec3  uTint;
      uniform float uVignetteStrength;
      uniform float uVignetteRadius;
      uniform vec3  uEdgeHaze;
      varying vec2  vUv;
      void main() {
        vec4 c = texture2D(tDiffuse, vUv);
        // Lift shadows softly — pushes deep blacks into a foggy mid-grey
        c.rgb = c.rgb + uLift * (1.0 - smoothstep(0.0, 0.25, c.rgb));
        // Saturation against luminance
        float lum = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
        c.rgb = mix(vec3(lum), c.rgb, uSaturation);
        // Contrast around mid-grey
        c.rgb = (c.rgb - 0.5) * uContrast + 0.5;
        // Warm tint
        c.rgb *= uTint;
        // Vignette — radial darkening with subtle cool-haze tint at edges so
        // corners look like atmospheric perspective rather than a black mask.
        vec2 d = vUv - 0.5;
        float r = length(d) * 1.4142;
        float v = smoothstep(uVignetteRadius * 0.5, uVignetteRadius, r);
        c.rgb = mix(c.rgb, c.rgb * uEdgeHaze * (1.0 - uVignetteStrength * 0.55), v);
        gl_FragColor = c;
      }
    `,
  });
  composer.addPass(colorGrade);

  // Pass 4: FXAA
  const fxaa = new ShaderPass(FXAAShader);
  const pixelRatio = renderer.getPixelRatio();
  fxaa.material.uniforms['resolution'].value.set(
    1 / (window.innerWidth  * pixelRatio),
    1 / (window.innerHeight * pixelRatio),
  );
  composer.addPass(fxaa);

  // Pass 5: OutputPass (tone mapping + sRGB) — MUST be last.
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

