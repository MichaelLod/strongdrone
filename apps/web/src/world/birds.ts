import * as THREE from 'three';

// A small flock of birds drifting overhead in slow circular paths. Sprite
// billboards (always face camera) with a procedurally drawn silhouette and a
// vertical-scale flap so they read as "M-shaped" outlines from distance.
//
// Cheap by construction: one canvas-generated texture, ~6 sprites, no
// shadows/lights/depth-write. Adds a lot of life for almost zero frame cost.

export type BirdsRefs = {
  group: THREE.Group;
  update: (elapsedSeconds: number) => void;
  dispose: () => void;
};

type Bird = {
  sprite: THREE.Sprite;
  centerX: number;
  centerZ: number;
  radius: number;
  altitude: number;
  angularSpeed: number;
  phase: number;
  flapPhase: number;
  baseScaleX: number;
  baseScaleY: number;
};

export function buildBirds(scene: THREE.Scene, count = 7): BirdsRefs {
  const tex = makeBirdTexture(64);

  const group = new THREE.Group();
  const birds: Bird[] = [];
  for (let i = 0; i < count; i++) {
    const mat = new THREE.SpriteMaterial({
      map: tex,
      color: 0x202428,
      transparent: true,
      depthWrite: false,
      fog: true,
    });
    const sprite = new THREE.Sprite(mat);
    const sx = 2.0 + Math.random() * 1.4;
    const sy = sx * 0.45;
    sprite.scale.set(sx, sy, 1);
    group.add(sprite);
    birds.push({
      sprite,
      centerX: (Math.random() - 0.5) * 80,
      centerZ: (Math.random() - 0.5) * 80,
      radius: 25 + Math.random() * 60,
      altitude: 22 + Math.random() * 30,
      angularSpeed: (0.05 + Math.random() * 0.06) * (Math.random() < 0.5 ? -1 : 1),
      phase: Math.random() * Math.PI * 2,
      flapPhase: Math.random() * Math.PI * 2,
      baseScaleX: sx,
      baseScaleY: sy,
    });
  }
  scene.add(group);

  return {
    group,
    update(t: number) {
      for (const b of birds) {
        const a = b.phase + t * b.angularSpeed;
        b.sprite.position.set(
          b.centerX + Math.cos(a) * b.radius,
          b.altitude + Math.sin(a * 0.3) * 2.5,
          b.centerZ + Math.sin(a) * b.radius,
        );
        // Wing flap: vertical scale modulation so the silhouette appears to
        // open and close. Distant birds read as flickering specks — perfect.
        const flap = 0.55 + 0.45 * Math.abs(Math.sin(t * 5.5 + b.flapPhase));
        b.sprite.scale.set(b.baseScaleX, b.baseScaleY * flap, 1);
      }
    },
    dispose() {
      scene.remove(group);
      tex.dispose();
      for (const b of birds) {
        b.sprite.material.dispose();
      }
    },
  };
}

function makeBirdTexture(s: number): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = s;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, s, s);

  ctx.strokeStyle = 'rgba(0,0,0,0.92)';
  ctx.fillStyle = 'rgba(0,0,0,0.92)';
  ctx.lineWidth = s * 0.07;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // Stylised "M" gull silhouette — both wings curved upward into a V at the
  // shoulder, slight droop at the tips. Reads cleanly at 16-32 px on screen.
  const cx = s * 0.5;
  const cy = s * 0.55;
  ctx.beginPath();
  ctx.moveTo(cx - s * 0.40, cy + s * 0.06);
  ctx.quadraticCurveTo(cx - s * 0.22, cy - s * 0.18, cx - s * 0.06, cy);
  ctx.quadraticCurveTo(cx,             cy + s * 0.04, cx + s * 0.06, cy);
  ctx.quadraticCurveTo(cx + s * 0.22, cy - s * 0.18, cx + s * 0.40, cy + s * 0.06);
  ctx.stroke();

  // Small body dot at the centre.
  ctx.beginPath();
  ctx.arc(cx, cy, s * 0.045, 0, Math.PI * 2);
  ctx.fill();

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearMipMapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  return tex;
}
