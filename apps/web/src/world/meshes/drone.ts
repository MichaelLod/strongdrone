import * as THREE from 'three';

// Strongdrone player vehicle. Aimed at "near-future recon FPV": real
// quadcopter silhouette, but with ducted prop guards, glowing underside LEDs,
// a forward sensor eye and a tail antenna so it reads as recognisably ours
// against the rural backdrop. Cyan + amber accents instead of red because the
// targets glow red — keeps the colour grammar of "us vs them" obvious.

export function buildDroneMesh(): { group: THREE.Group; propellers: THREE.Mesh[] } {
  const group = new THREE.Group();

  const carbon = new THREE.MeshStandardMaterial({
    color: 0x111418,
    roughness: 0.4,
    metalness: 0.65,
  });
  const metal = new THREE.MeshStandardMaterial({
    color: 0xb0b6c0,
    roughness: 0.3,
    metalness: 0.85,
  });
  const accent = new THREE.MeshStandardMaterial({
    color: 0x1a2a40,
    roughness: 0.4,
    metalness: 0.6,
    emissive: 0x00b6ff,
    emissiveIntensity: 1.4,
  });
  const amber = new THREE.MeshStandardMaterial({
    color: 0x2a1808,
    roughness: 0.4,
    metalness: 0.4,
    emissive: 0xff8a1f,
    emissiveIntensity: 1.6,
  });
  const lensMat = new THREE.MeshStandardMaterial({
    color: 0x070a14,
    roughness: 0.1,
    metalness: 0.6,
    emissive: 0x00d8ff,
    emissiveIntensity: 1.8,
  });

  // ---- Hull ---------------------------------------------------------------
  // A curved capsule body (cylinder + hemisphere caps) reads more "designed"
  // than the previous box stack. Length runs along X (forward axis).
  const hullCore = new THREE.Mesh(
    new THREE.CylinderGeometry(0.045, 0.05, 0.18, 16, 1, false),
    carbon
  );
  hullCore.rotation.z = Math.PI / 2;
  hullCore.castShadow = true;
  group.add(hullCore);

  const noseCap = new THREE.Mesh(new THREE.SphereGeometry(0.05, 16, 12), carbon);
  noseCap.position.x = 0.09;
  noseCap.scale.set(0.9, 0.85, 0.85);
  group.add(noseCap);

  const tailCap = new THREE.Mesh(new THREE.SphereGeometry(0.05, 16, 12), carbon);
  tailCap.position.x = -0.09;
  tailCap.scale.set(0.85, 0.85, 0.85);
  group.add(tailCap);

  // Topside flight controller "stack" panel
  const stack = new THREE.Mesh(
    new THREE.BoxGeometry(0.10, 0.014, 0.06),
    new THREE.MeshStandardMaterial({
      color: 0x0e1a30,
      roughness: 0.5,
      metalness: 0.3,
      emissive: 0x002844,
      emissiveIntensity: 0.6,
    })
  );
  stack.position.set(-0.005, 0.052, 0);
  group.add(stack);

  // Glowing belly LED strip (along X under the hull)
  const ledStrip = new THREE.Mesh(
    new THREE.BoxGeometry(0.14, 0.005, 0.018),
    accent
  );
  ledStrip.position.set(0, -0.052, 0);
  group.add(ledStrip);

  // ---- Forward sensor eye -------------------------------------------------
  // Replaces the old separate cam housing + lens — a single recessed glowing
  // sphere reads better as "the front" of the drone.
  const eyeRecess = new THREE.Mesh(
    new THREE.CylinderGeometry(0.026, 0.030, 0.018, 18),
    metal
  );
  eyeRecess.rotation.z = Math.PI / 2;
  eyeRecess.position.set(0.13, 0.0, 0);
  group.add(eyeRecess);

  const eye = new THREE.Mesh(new THREE.SphereGeometry(0.022, 14, 12), lensMat);
  eye.position.set(0.142, 0, 0);
  eye.scale.set(0.7, 1, 1);
  group.add(eye);

  // ---- Tail antenna with amber tip ----------------------------------------
  const antenna = new THREE.Mesh(
    new THREE.CylinderGeometry(0.0025, 0.0025, 0.08, 6),
    new THREE.MeshStandardMaterial({ color: 0x222226, roughness: 0.7 })
  );
  antenna.position.set(-0.13, 0.075, 0);
  group.add(antenna);

  const antennaTip = new THREE.Mesh(new THREE.SphereGeometry(0.009, 10, 8), amber);
  antennaTip.position.set(-0.13, 0.12, 0);
  group.add(antennaTip);

  // ---- Arms + ducted-fan motor pods ---------------------------------------
  const armLen = 0.50;
  const armMat = carbon;
  for (const angle of [Math.PI / 4, -Math.PI / 4]) {
    const arm = new THREE.Mesh(
      new THREE.BoxGeometry(armLen, 0.020, 0.030),
      armMat
    );
    arm.rotation.y = angle;
    arm.position.y = -0.005;
    arm.castShadow = true;
    group.add(arm);
  }

  const motorPositions: [number, number][] = [
    [ 0.176,  0.176],
    [ 0.176, -0.176],
    [-0.176,  0.176],
    [-0.176, -0.176],
  ];

  const propellers: THREE.Mesh[] = [];
  const guardMat = new THREE.MeshStandardMaterial({
    color: 0x14181c,
    roughness: 0.4,
    metalness: 0.6,
  });
  const guardTrim = accent;
  const bladeMat = new THREE.MeshStandardMaterial({
    color: 0xd8dde6,
    roughness: 0.5,
    metalness: 0.05,
    transparent: true,
    opacity: 0.85,
  });

  for (const [mx, mz] of motorPositions) {
    // Ducted fan housing — wide low torus around the prop
    const guard = new THREE.Mesh(
      new THREE.TorusGeometry(0.062, 0.011, 12, 26),
      guardMat
    );
    guard.position.set(mx, 0.018, mz);
    guard.rotation.x = Math.PI / 2;
    guard.castShadow = true;
    group.add(guard);

    // Glowing accent ring inside the duct
    const trim = new THREE.Mesh(
      new THREE.TorusGeometry(0.054, 0.0025, 6, 28),
      guardTrim
    );
    trim.position.set(mx, 0.022, mz);
    trim.rotation.x = Math.PI / 2;
    group.add(trim);

    // Motor stator
    const motor = new THREE.Mesh(
      new THREE.CylinderGeometry(0.020, 0.024, 0.020, 16),
      metal
    );
    motor.position.set(mx, 0.022, mz);
    motor.castShadow = true;
    group.add(motor);

    // Propeller blades — single twisted plate so spin reads from above
    const blade = new THREE.Mesh(
      new THREE.BoxGeometry(0.105, 0.003, 0.018),
      bladeMat
    );
    blade.position.set(mx, 0.034, mz);
    group.add(blade);
    propellers.push(blade);
  }

  // ---- Skid landing gear (slim) ------------------------------------------
  const skidMat = new THREE.MeshStandardMaterial({ color: 0x222226, roughness: 0.6 });
  for (const xOff of [0.07, -0.07]) {
    const rail = new THREE.Mesh(new THREE.BoxGeometry(0.010, 0.030, 0.20), skidMat);
    rail.position.set(xOff, -0.075, 0);
    rail.castShadow = true;
    group.add(rail);
    for (const zOff of [0.085, -0.085]) {
      const pad = new THREE.Mesh(new THREE.BoxGeometry(0.018, 0.008, 0.026), skidMat);
      pad.position.set(xOff, -0.094, zOff);
      group.add(pad);
    }
  }

  return { group, propellers };
}
