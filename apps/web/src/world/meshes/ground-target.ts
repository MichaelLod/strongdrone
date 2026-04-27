import * as THREE from 'three';

// Ground recon target. Reads as a hostile-looking sensor/comms array sitting
// on the ground: concrete pad → tripod struts → top platform → angled dish
// + antenna mast with red beacon. Designed so a drone pilot can spot it from
// distance and approach for a "scan" pass.

export function buildGroundTargetMesh(): THREE.Group {
  const g = new THREE.Group();

  const concrete = new THREE.MeshStandardMaterial({
    color: 0x6c6962,
    roughness: 0.92,
    metalness: 0.0,
  });
  const metal = new THREE.MeshStandardMaterial({
    color: 0x444a52,
    roughness: 0.45,
    metalness: 0.85,
  });
  const dark = new THREE.MeshStandardMaterial({
    color: 0x1c2026,
    roughness: 0.55,
    metalness: 0.7,
  });
  const warning = new THREE.MeshStandardMaterial({
    color: 0xb8860b,
    roughness: 0.6,
    metalness: 0.3,
  });
  const redLED = new THREE.MeshStandardMaterial({
    color: 0x1a0606,
    roughness: 0.3,
    metalness: 0.4,
    emissive: 0xff2218,
    emissiveIntensity: 1.6,
  });

  // ---- Concrete base pad --------------------------------------------------
  const pad = new THREE.Mesh(
    new THREE.CylinderGeometry(0.65, 0.7, 0.18, 22),
    concrete
  );
  pad.position.y = 0.09;
  pad.castShadow = true;
  pad.receiveShadow = true;
  g.add(pad);

  // Yellow / black warning stripe band
  const band = new THREE.Mesh(
    new THREE.CylinderGeometry(0.71, 0.71, 0.04, 22),
    warning
  );
  band.position.y = 0.155;
  g.add(band);

  // ---- Tripod struts ------------------------------------------------------
  const TRIPOD_HEIGHT = 1.4;
  const TRIPOD_BASE_R = 0.45;
  const TRIPOD_TOP_R = 0.10;
  for (let i = 0; i < 3; i++) {
    const angle = (i / 3) * Math.PI * 2;
    const baseX = Math.cos(angle) * TRIPOD_BASE_R;
    const baseZ = Math.sin(angle) * TRIPOD_BASE_R;
    const topX = Math.cos(angle) * TRIPOD_TOP_R;
    const topZ = Math.sin(angle) * TRIPOD_TOP_R;
    const dx = topX - baseX;
    const dz = topZ - baseZ;
    const dy = TRIPOD_HEIGHT;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);

    const strut = new THREE.Mesh(
      new THREE.CylinderGeometry(0.03, 0.035, len, 8),
      metal
    );
    strut.position.set(baseX + dx / 2, 0.18 + dy / 2, baseZ + dz / 2);
    const dir = new THREE.Vector3(dx, dy, dz).normalize();
    const up = new THREE.Vector3(0, 1, 0);
    strut.quaternion.setFromUnitVectors(up, dir);
    strut.castShadow = true;
    g.add(strut);
  }

  // ---- Top hub + sensor array --------------------------------------------
  const hubY = 0.18 + TRIPOD_HEIGHT;
  const hub = new THREE.Mesh(
    new THREE.CylinderGeometry(0.16, 0.18, 0.10, 14),
    dark
  );
  hub.position.y = hubY;
  hub.castShadow = true;
  g.add(hub);

  // Side LED ring on hub
  const hubLed = new THREE.Mesh(
    new THREE.TorusGeometry(0.175, 0.008, 6, 28),
    redLED
  );
  hubLed.rotation.x = Math.PI / 2;
  hubLed.position.y = hubY;
  g.add(hubLed);

  // Dish arm — angled bar holding the dish
  const dishArm = new THREE.Mesh(
    new THREE.BoxGeometry(0.34, 0.025, 0.025),
    metal
  );
  dishArm.position.set(0, hubY + 0.12, 0);
  dishArm.castShadow = true;
  g.add(dishArm);

  // Dish (open truncated cone)
  const dish = new THREE.Mesh(
    new THREE.CylinderGeometry(0.20, 0.06, 0.04, 18, 1, true),
    metal
  );
  dish.position.set(0.18, hubY + 0.20, 0);
  dish.rotation.z = -Math.PI / 3;
  dish.castShadow = true;
  g.add(dish);

  // Dish rim
  const dishRim = new THREE.Mesh(
    new THREE.TorusGeometry(0.20, 0.008, 6, 24),
    dark
  );
  dishRim.position.set(0.18, hubY + 0.18, 0);
  dishRim.rotation.x = Math.PI / 2;
  dishRim.rotation.z = -Math.PI / 3;
  g.add(dishRim);

  // Counterweight at the back of the dish arm
  const counterweight = new THREE.Mesh(
    new THREE.BoxGeometry(0.06, 0.06, 0.05),
    dark
  );
  counterweight.position.set(-0.16, hubY + 0.07, 0);
  g.add(counterweight);

  // ---- Antenna mast with red beacon --------------------------------------
  const mastH = 0.85;
  const mast = new THREE.Mesh(
    new THREE.CylinderGeometry(0.012, 0.018, mastH, 8),
    dark
  );
  mast.position.set(-0.05, hubY + 0.05 + mastH / 2, 0.12);
  mast.castShadow = true;
  g.add(mast);

  const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.04, 12, 10), redLED);
  beacon.position.set(-0.05, hubY + 0.05 + mastH + 0.02, 0.12);
  g.add(beacon);

  return g;
}
