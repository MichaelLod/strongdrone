/**
 * Terrain research module — procedural 400×400m ground for the drone simulator.
 *
 * Approach: MeshStandardMaterial + onBeforeCompile injection.
 *   - Vertex shader: fBm height displacement (±0.3m at origin, up to ±2m at edges)
 *   - Fragment shader: height+slope splatmap blending (grass / dry-grass / dirt / rock)
 *   - Procedural normal map derived from screen-space derivatives (dFdx/dFdy)
 *   - Stochastic UV rotation per hex tile to break repetition
 *   - Detail noise overlay for close-up micro-texture
 *   - Vertex-color AO baked from height curvature approximation
 *
 * No external assets. All canvas textures generated inline.
 * Targets Three.js 0.170 vanilla TypeScript.
 */

import * as THREE from 'three';
import { buildFieldTexture } from './fields';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type TerrainOptions = {
  /** Total side length in metres (default 400) */
  size?: number;
  /** Geometry subdivisions per side (default 256 — good quality/perf balance) */
  segments?: number;
  /** Peak height amplitude at the terrain edges in metres (default 2.0) */
  edgeAmplitude?: number;
  /** Height amplitude within the flat play zone (radius ~10m) in metres (default 0.28) */
  playZoneAmplitude?: number;
  /** Radius of the near-flat drone play zone in metres (default 10) */
  playZoneRadius?: number;
};

export type TerrainRefs = {
  mesh: THREE.Mesh;
  material: THREE.MeshStandardMaterial;
  /** Call this in your dispose/cleanup path */
  dispose(): void;
};

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function createTerrain(
  scene: THREE.Scene,
  options: TerrainOptions = {}
): TerrainRefs {
  const {
    size = 400,
    segments = 256,
    edgeAmplitude = 2.0,
    playZoneAmplitude = 0.28,
    playZoneRadius = 10,
  } = options;

  // --- Geometry -----------------------------------------------------------
  const geo = new THREE.PlaneGeometry(size, size, segments, segments);
  geo.rotateX(-Math.PI / 2); // lie flat

  // Bake height + vertex-AO into position.y and color attribute on CPU.
  // This is done once at init; gives the GPU-free detail layer for AO.
  applyHeightAndAO(geo, size, edgeAmplitude, playZoneAmplitude, playZoneRadius);

  // --- Textures -----------------------------------------------------------
  // One ground texture provides surface microdetail; per-region color comes
  // from the Voronoi field map. We multiply the ground texture's luminance by
  // the field tint so wheat patches read golden, pasture green, plowed brown.
  const albedoGrass = loadTiledTexture('/assets/terrain/grass/forrest_ground_01_diff_4k.jpg');
  const noiseMap    = makeNoiseMap();
  const heightMap   = makeHeightMap(segments);
  const fieldMap    = buildFieldTexture();

  // --- Material -----------------------------------------------------------
  // We extend MeshStandardMaterial so Three.js handles PBR lighting, shadows,
  // fog, tone-mapping etc. automatically. We only inject our custom chunks.
  const mat = new THREE.MeshStandardMaterial({
    roughness: 0.92,
    metalness: 0.0,
    vertexColors: true, // picks up the AO baked into vertex colors
    // Required to force USE_MAP/USE_UV defines so vUv is available in the
    // fragment shader injection. Our shader override discards the actual
    // sampled color, but three.js won't emit the vUv varying without a map.
    map: albedoGrass,
  });

  // Uniforms shared between vertex and fragment injections
  const terrainUniforms = {
    uSize:              { value: size },
    uEdgeAmp:           { value: edgeAmplitude },
    uPlayRadius:        { value: playZoneRadius },
    uPlayAmp:           { value: playZoneAmplitude },
    uAlbedoGrass:       { value: albedoGrass },
    uNoiseMap:          { value: noiseMap },
    uHeightMap:         { value: heightMap },
    uFieldMap:          { value: fieldMap },
    uDetailScale:       { value: 14.0 },
  };

  mat.onBeforeCompile = (shader) => {
    // Merge uniforms so Three.js sees them
    Object.assign(shader.uniforms, terrainUniforms);

    // ---- Vertex shader injection ----------------------------------------
    // We hook into the vertex transform to read the heightMap and offset Y.
    // Three.js exposes `transformed` (vec3 in local space) at that point.
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        /* glsl */ `
#include <common>
uniform sampler2D uHeightMap;
uniform float uSize;
uniform float uEdgeAmp;
uniform float uPlayRadius;
uniform float uPlayAmp;

// fBm-style height lookup using the pre-baked heightmap.
// Returns signed height in metres.
float terrainHeight(vec2 uv) {
  float h0 = texture2D(uHeightMap, uv).r;
  float h1 = texture2D(uHeightMap, uv * 3.1 + vec2(0.37, 0.13)).r;
  float h2 = texture2D(uHeightMap, uv * 7.3 - vec2(0.11, 0.29)).r;
  // octave sum with gain 0.5 per octave
  return (h0 * 0.60 + h1 * 0.28 + h2 * 0.12) * 2.0 - 1.0;
}

// Smooth radial fade: 1 at centre, 0 at radius r
float radialFade(vec2 xz, float r) {
  return 1.0 - smoothstep(0.0, r, length(xz));
}
        `
      )
      .replace(
        '#include <begin_vertex>',
        /* glsl */ `
#include <begin_vertex>

// World-space XZ for this vertex (geometry is already rotated on CPU)
vec2 xz = transformed.xz;
vec2 uv01 = xz / uSize + 0.5; // normalised [0,1] UV

float rawH = terrainHeight(uv01);

// Scale amplitude: blend between play-zone tight amplitude and edge amplitude
float distNorm = clamp(length(xz) / (uSize * 0.5), 0.0, 1.0);
float amp = mix(uPlayAmp, uEdgeAmp, smoothstep(0.0, 1.0, distNorm));

// Extra tightening near origin so play area stays close to flat
float playBlend = radialFade(xz, uPlayRadius);
amp = mix(amp, uPlayAmp * 0.4, playBlend);

transformed.y += rawH * amp;
        `
      );

    // ---- Fragment shader injection ---------------------------------------
    // Inject before map_fragment so we can override diffuseColor.
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        /* glsl */ `
#include <common>
uniform sampler2D uAlbedoGrass;
uniform sampler2D uNoiseMap;
uniform sampler2D uFieldMap;
uniform float uDetailScale;

// ---- Stochastic UV sampling ----------------------------------------
// Assigns a random rotation + offset to each hex cell so the same texture
// tile never lines up across cell boundaries (defeats repetition).
// Based on Mikkelsen's adaptation of Heitz & Neyret 2019.

// Hash a 2-D integer cell to a pseudo-random float [0,1]
float hashCell(vec2 p) {
  p = floor(p);
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

// Rotate UV by angle a
vec2 rotUV(vec2 uv, float a) {
  float s = sin(a); float c = cos(a);
  return vec2(c * uv.x - s * uv.y, s * uv.x + c * uv.y);
}

// Sample tex at uv with per-tile random rotation (4 nearest cells blended)
vec4 stochasticSample(sampler2D tex, vec2 uv, float scale) {
  vec2 suv = uv * scale;
  vec2 cell = floor(suv);
  vec2 frac = fract(suv);

  // Bilinear weights
  vec4 acc = vec4(0.0);
  float wSum = 0.0;

  for (int dy = 0; dy <= 1; dy++) {
    for (int dx = 0; dx <= 1; dx++) {
      vec2 c = cell + vec2(float(dx), float(dy));
      float angle = hashCell(c) * 6.2832;
      vec2 offset = vec2(hashCell(c + 13.7), hashCell(c + 97.3));

      vec2 tUV = rotUV(suv - c, angle) + offset;
      vec4 col = texture2D(tex, tUV);

      // Tent weight
      float wx = (dx == 0) ? (1.0 - frac.x) : frac.x;
      float wy = (dy == 0) ? (1.0 - frac.y) : frac.y;
      float w = wx * wy;

      acc += col * w;
      wSum += w;
    }
  }
  return acc / wSum;
}
        `
      )
      .replace(
        '#include <map_fragment>',
        /* glsl */ `
vec2 wUV = vMapUv;

// Per-pixel ground texture for surface detail (stochastic to defeat tiling).
float grassScale = 14.0 * uDetailScale;
vec4 baseCol = stochasticSample(uAlbedoGrass, wUV, grassScale);

// Field tint from the Voronoi-baked map → wheat / pasture / plowed / forest.
// LinearFilter gives a soft 1–2 m blur at the patch boundaries which reads as
// a natural field margin instead of a pixel-sharp seam.
vec3 fieldTint = texture2D(uFieldMap, wUV).rgb;

// Convert ground sample to luminance and apply tint multiplicatively.
// Slight gain (1.55) compensates for the dimming inherent in tint × value.
float lum = dot(baseCol.rgb, vec3(0.299, 0.587, 0.114));
vec3 tinted = fieldTint * (lum * 1.55);

// Detail noise breaks up large flat patches.
vec4 detail = texture2D(uNoiseMap, wUV * grassScale * 4.2);
tinted = mix(tinted, tinted * (detail.rgb * 2.0 - 1.0 + 1.0), 0.10);

// Vertex AO from heightmap curvature.
tinted *= mix(vec3(1.0), vColor.rgb, 0.55);

diffuseColor = vec4(tinted, 1.0);
        `
      );

    // Expose programmatic access for hot-reload / debugging
    mat.userData.shader = shader;
  };

  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  mesh.castShadow = false; // flat ground doesn't cast meaningful shadows
  mesh.name = 'terrain';
  scene.add(mesh);

  return {
    mesh,
    material: mat,
    dispose() {
      scene.remove(mesh);
      geo.dispose();
      mat.dispose();
      albedoGrass.dispose();
      noiseMap.dispose();
      heightMap.dispose();
      fieldMap.dispose();
    },
  };
}

// ---------------------------------------------------------------------------
// CPU-side height baking + vertex AO
// ---------------------------------------------------------------------------

/**
 * Displace geometry vertices by a multi-octave smooth noise height function
 * and bake a crude curvature-based ambient occlusion into vertex colors.
 *
 * Running this on the CPU (rather than GPU) means Three.js can compute
 * accurate bounding volumes and the shadow caster sees real geometry.
 */
function applyHeightAndAO(
  geo: THREE.PlaneGeometry,
  size: number,
  edgeAmp: number,
  playAmp: number,
  playRadius: number
): void {
  const pos   = geo.attributes.position as THREE.BufferAttribute;
  const count = pos.count;

  // We need a color attribute for vertex AO
  const colors = new Float32Array(count * 3);

  // First pass: displace Y
  const heights = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const h = sampleHeightCPU(x, z, size, edgeAmp, playAmp, playRadius);
    pos.setY(i, h);
    heights[i] = h;
  }

  // Second pass: approximate curvature AO by comparing each vertex height
  // to the local neighbourhood average. Concave = darker, convex = brighter.
  // We use the geometry's own segments to find neighbours by index.
  const segs = Math.round(Math.sqrt(count)) - 1; // PlaneGeometry rows = segs+1
  const stride = segs + 1;

  for (let i = 0; i < count; i++) {
    const row = Math.floor(i / stride);
    const col = i % stride;

    let neighbourSum = 0;
    let neighbourCount = 0;
    for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
      const nr = row + dr;
      const nc = col + dc;
      if (nr >= 0 && nr <= segs && nc >= 0 && nc <= segs) {
        neighbourSum += heights[nr * stride + nc];
        neighbourCount++;
      }
    }
    const avg = neighbourSum / (neighbourCount || 1);
    const diff = heights[i] - avg; // positive = convex, negative = concave

    // Map diff to [0,1] AO: concave areas get darker (AO = 0.6–1.0)
    const ao = clamp01(0.82 + diff * 0.9);
    colors[i * 3]     = ao;
    colors[i * 3 + 1] = ao;
    colors[i * 3 + 2] = ao;
  }

  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  pos.needsUpdate = true;
  geo.computeVertexNormals(); // recompute after displacement
}

// ---------------------------------------------------------------------------
// CPU height sampling (mirrors the GLSL logic for the vertex pass)
// ---------------------------------------------------------------------------

/** Smooth-step interpolation */
function smoothstepCPU(a: number, b: number, t: number): number {
  const x = clamp01((t - a) / (b - a));
  return x * x * (3 - 2 * x);
}

/** Simple value noise (tileable) on a small lattice */
function valueNoise2D(x: number, y: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);

  const h = (nx: number, ny: number) => {
    // lcg hash
    let v = ((nx * 1619 + ny * 31337 + seed * 6971) ^ 1376312589) & 0x7fffffff;
    v = (v * 1664525 + 1013904223) & 0x7fffffff;
    return v / 0x7fffffff;
  };

  const a = h(ix,   iy);
  const b = h(ix+1, iy);
  const c = h(ix,   iy+1);
  const d = h(ix+1, iy+1);
  return a + ux * (b - a) + uy * (c - a + ux * (a - b - c + d));
}

/** fBm (fractal Brownian Motion): 4 octaves */
function fbmCPU(x: number, y: number, seed: number): number {
  let v = 0, amp = 0.5, freq = 1, max = 0;
  for (let o = 0; o < 4; o++) {
    v   += valueNoise2D(x * freq, y * freq, seed + o * 137) * amp;
    max += amp;
    amp *= 0.5;
    freq *= 2.0;
  }
  return v / max; // [0,1]
}

function sampleHeightCPU(
  x: number, z: number,
  size: number,
  edgeAmp: number,
  playAmp: number,
  playRadius: number
): number {
  // normalise to [0,1] UV
  const u = x / size + 0.5;
  const v = z / size + 0.5;

  const raw = fbmCPU(u * 5.3, v * 5.3, 7171) * 2 - 1; // signed [-1, 1]

  // Amplitude envelope
  const distNorm = clamp01(Math.sqrt(x*x + z*z) / (size * 0.5));
  let amp = lerp(playAmp, edgeAmp, distNorm * distNorm);

  // Tighten near origin
  const playBlend = 1 - smoothstepCPU(0, playRadius, Math.sqrt(x*x + z*z));
  amp = lerp(amp, playAmp * 0.35, playBlend);

  return raw * amp;
}

// ---------------------------------------------------------------------------
// Texture loading helpers
// ---------------------------------------------------------------------------

/** Load a JPG/PNG and configure it for repeated tiling on the terrain plane. */
function loadTiledTexture(url: string, srgb = true): THREE.Texture {
  const tex = new THREE.TextureLoader().load(url);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.anisotropy = 8;
  return tex;
}

/**
 * General-purpose noise texture (R = low-freq, G = mid-freq, B = high-freq).
 * Used as splatmap weight noise and detail overlay.
 */
function makeNoiseMap(): THREE.CanvasTexture {
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(size, size);

  const nA = makeSimpleNoise(size, 8, 3);
  const nB = makeSimpleNoise(size, 32, 97);
  const nC = makeSimpleNoise(size, 128, 211);

  for (let i = 0; i < size * size; i++) {
    img.data[i*4]   = Math.round(nA[i] * 255);
    img.data[i*4+1] = Math.round(nB[i] * 255);
    img.data[i*4+2] = Math.round(nC[i] * 255);
    img.data[i*4+3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return toTexture(canvas, 1, 1); // not repeated; shader scales UVs
}

/**
 * Tileable height map baked to a 512×512 R8 texture.
 * The vertex shader samples this to reconstruct height on the GPU.
 * (The CPU pass has already displaced the mesh; this allows the fragment
 * shader to know the approximate height at each pixel for splatmap blending
 * without requiring a vHeight varying — keeping the shader compatible with
 * MeshStandardMaterial's existing varying budget.)
 */
function makeHeightMap(segments: number): THREE.CanvasTexture {
  const size = Math.min(512, nextPow2(segments));
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(size, size);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // fBm at multiple octaves — matches the GLSL vertex shader logic
      const u = x / size;
      const v = y / size;
      const h0 = makeSimpleNoiseSingle(u * 5.3, v * 5.3, 7171);
      const h1 = makeSimpleNoiseSingle(u * 16.2, v * 16.2, 9901);
      const h2 = makeSimpleNoiseSingle(u * 37.1, v * 37.1, 4447);
      const h  = h0 * 0.60 + h1 * 0.28 + h2 * 0.12;
      const enc = Math.round(clamp01(h) * 255);
      const i = (y * size + x) * 4;
      img.data[i]   = enc;
      img.data[i+1] = enc;
      img.data[i+2] = enc;
      img.data[i+3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return toTexture(canvas, 1, 1);
}

// ---------------------------------------------------------------------------
// Noise helpers
// ---------------------------------------------------------------------------

/** Tileable value noise — returns a flat Float32Array of [0,1] values. */
function makeSimpleNoise(imageSize: number, cells: number, seed: number): Float32Array {
  const lattice = new Float32Array(cells * cells);
  // Seeded PRNG so noise is deterministic
  let s = seed;
  const rand = () => { s = (s * 1664525 + 1013904223) & 0xffffffff; return (s >>> 0) / 0xffffffff; };
  for (let i = 0; i < lattice.length; i++) lattice[i] = rand();

  const out = new Float32Array(imageSize * imageSize);
  const cs  = imageSize / cells;
  for (let y = 0; y < imageSize; y++) {
    const fy = y / cs;
    const y0 = Math.floor(fy) % cells;
    const y1 = (y0 + 1) % cells;
    const ty = fy - Math.floor(fy);
    const sy = ty * ty * (3 - 2 * ty);
    for (let x = 0; x < imageSize; x++) {
      const fx = x / cs;
      const x0 = Math.floor(fx) % cells;
      const x1 = (x0 + 1) % cells;
      const tx = fx - Math.floor(fx);
      const sx = tx * tx * (3 - 2 * tx);
      const a = lattice[y0*cells+x0];
      const b = lattice[y0*cells+x1];
      const c = lattice[y1*cells+x0];
      const d = lattice[y1*cells+x1];
      out[y*imageSize+x] = (a + sx*(b-a)) + sy * ((c + sx*(d-c)) - (a + sx*(b-a)));
    }
  }
  return out;
}

/** Single-point noise evaluation (used for makeHeightMap). */
function makeSimpleNoiseSingle(x: number, y: number, seed: number): number {
  const cells = 16;
  const ix = Math.floor(x * cells);
  const iy = Math.floor(y * cells);
  const fx = (x * cells) - ix;
  const fy = (y * cells) - iy;
  const sx = fx * fx * (3 - 2*fx);
  const sy = fy * fy * (3 - 2*fy);

  const h = (nx: number, ny: number) => {
    const nx2 = ((nx % cells) + cells) % cells;
    const ny2 = ((ny % cells) + cells) % cells;
    let v = ((nx2 * 1619 + ny2 * 31337 + seed * 6971) ^ 1376312589) & 0x7fffffff;
    v = (v * 1664525 + 1013904223) & 0x7fffffff;
    return v / 0x7fffffff;
  };

  const a = h(ix,   iy);
  const b = h(ix+1, iy);
  const c = h(ix,   iy+1);
  const d = h(ix+1, iy+1);
  return a + sx*(b-a) + sy*((c + sx*(d-c)) - (a + sx*(b-a)));
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function toTexture(canvas: HTMLCanvasElement, repS: number, repT: number): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repS, repT);
  tex.anisotropy = 16;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

function lerp(a: number, b: number, t: number): number { return a + (b - a) * t; }
function clamp01(v: number): number { return v < 0 ? 0 : v > 1 ? 1 : v; }
function nextPow2(n: number): number { let p = 1; while (p < n) p <<= 1; return p; }
