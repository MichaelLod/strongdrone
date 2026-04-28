import * as THREE from 'three';

// Low-altitude mist slab. Sits between the camera and distant geometry so
// trees + mountains fade into a soft haze layer above the ground rather than
// popping in/out abruptly. Pairs with scene.fog (linear) — that handles
// long-distance hiding; this layer adds the visible "morning mist" wisps.
//
// Implementation: a single horizontal disc at low altitude, FBM noise alpha,
// distance-faded so the disc edge isn't visible. Cheap (one transparent draw
// over part of the screen).

export type GroundFogRefs = {
  mesh: THREE.Mesh;
  update: (elapsedSeconds: number) => void;
  dispose: () => void;
};

export function buildGroundFog(scene: THREE.Scene): GroundFogRefs {
  const uniforms = {
    uTime: { value: 0 },
    uColor: { value: new THREE.Color(0xc6cdc6) },
    uOpacity: { value: 0.35 },
    uNearFade: { value: 18.0 }, // wisps start at this radius
    uFarFade: { value: 180.0 }, // and fully fade by here (matches scene.fog far)
  };

  const mat = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    vertexShader: /* glsl */ `
      varying vec3 vWorldPos;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorldPos = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform vec3  uColor;
      uniform float uOpacity;
      uniform float uNearFade;
      uniform float uFarFade;
      varying vec3  vWorldPos;

      float hash(vec2 p) {
        p = fract(p * vec2(127.1, 311.7));
        p += dot(p, p + 19.19);
        return fract(p.x * p.y);
      }
      float vnoise(vec2 p) {
        vec2 i = floor(p), f = fract(p);
        vec2 u = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x),
                   mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
      }
      float fbm(vec2 p) {
        float v = 0.0, a = 0.5, f = 1.0;
        for (int i = 0; i < 3; i++) { v += a * vnoise(p * f); f *= 2.05; a *= 0.5; }
        return v;
      }

      void main() {
        vec2 uv = vWorldPos.xz * 0.04 + uTime * 0.008;
        float n = fbm(uv) * 0.7 + 0.3 * fbm(uv * 2.7 - uTime * 0.004);

        // Radial fade: invisible right under the camera (no flat-disc giveaway)
        // and fully transparent past the far ring (so the disc edge is hidden).
        float r = length(vWorldPos.xz - cameraPosition.xz);
        float ringFade =
          smoothstep(0.0, uNearFade, r) *
          (1.0 - smoothstep(uFarFade * 0.7, uFarFade, r));

        float density = uOpacity * n * ringFade;
        if (density < 0.005) discard;
        gl_FragColor = vec4(uColor, density);
      }
    `,
  });

  const geo = new THREE.PlaneGeometry(400, 400, 1, 1);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.rotation.x = -Math.PI / 2;
  // Sit just below the typical camera eye line so wisps overlap distant
  // geometry (tree bases, mountains) without hugging the player drone.
  mesh.position.y = 1.4;
  mesh.renderOrder = 2; // after opaque, after sky-background
  mesh.frustumCulled = false;
  scene.add(mesh);

  return {
    mesh,
    update(t: number) { uniforms.uTime.value = t; },
    dispose() {
      scene.remove(mesh);
      geo.dispose();
      mat.dispose();
    },
  };
}
