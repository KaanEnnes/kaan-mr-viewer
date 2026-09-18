/**
 * El takibi yardimcilari: eklem konumlari, avuc yonu ve hiz olcumu.
 *
 * three.js, oturumda "hand-tracking" acikken renderer.xr.getHand(i) grubunun
 * joints sozlugunu her karede doldurur; izlenemeyen eklemin visible'i false olur.
 */
import * as THREE from "three";

export const INDEX_TIP = "index-finger-tip";
export const THUMB_TIP = "thumb-tip";

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _w = new THREE.Vector3();

/** Eklemin dunya konumu; eklem o karede izlenmiyorsa null. */
export function jointWorld(hand, name, out) {
  const j = hand.joints[name];
  if (!j || !j.visible) return null;
  return j.getWorldPosition(out);
}

/**
 * Avucun baktigi yon (birim vektor). Bilek ile isaret ve serce parmak
 * bogumlarinin (phalanx-proximal) olusturdugu duzlemin normali; sag ve sol
 * elde capraz carpim sirasi ters.
 *
 * "metacarpal" eklemleri kullanilmamali: WebXR'da avucun dibinde, bilege
 * neredeyse yapisik dururlar; aradaki vektorler milimetrik kalir ve normal
 * gurultuden ibaret olur.
 */
export function palmNormal(hand, handedness, out) {
  if (!jointWorld(hand, "wrist", _w)
    || !jointWorld(hand, "index-finger-phalanx-proximal", _a)
    || !jointWorld(hand, "pinky-finger-phalanx-proximal", _b)) return null;
  _a.sub(_w);
  _b.sub(_w);
  return handedness === "left"
    ? out.crossVectors(_b, _a).normalize()
    : out.crossVectors(_a, _b).normalize();
}

/** Avuc merkezi: bilek ile orta parmak bogumunun ortasi. */
export function palmCentre(hand, out) {
  if (!jointWorld(hand, "wrist", _w)
    || !jointWorld(hand, "middle-finger-phalanx-proximal", _a)) return null;
  return out.addVectors(_w, _a).multiplyScalar(0.5);
}

/**
 * Son ~120 ms'deki konumlardan hiz hesaplar. Tek karelik fark firlatmada
 * cok gurultulu; kisa bir pencerenin ortalamasi el titremesini yutuyor.
 */
export class VelocityTracker {
  constructor(windowMs = 120) {
    this.windowMs = windowMs;
    this.samples = [];
  }

  push(time, p) {
    this.samples.push({ t: time, p: p.clone() });
    while (this.samples.length > 2 && time - this.samples[0].t > this.windowMs) {
      this.samples.shift();
    }
  }

  clear() { this.samples.length = 0; }

  velocity(out) {
    out.set(0, 0, 0);
    const n = this.samples.length;
    if (n < 2) return out;
    const first = this.samples[0];
    const last = this.samples[n - 1];
    const dt = (last.t - first.t) / 1000;
    if (dt <= 0) return out;
    return out.subVectors(last.p, first.p).divideScalar(dt);
  }
}

// Gercek elin sanal sahnedeki "golgesi": eklemler arasi kapsuller yalnizca
// derinlik yazar, renk yazmaz. Passthrough'da gorunen el boylece menunun ve
// modelin onune gecince onlari gercekten ortuyor; yoksa sanal icerik hep elin
// ustune ciziliyordu.
const FINGERS = [
  ["thumb-metacarpal", "thumb-phalanx-proximal", "thumb-phalanx-distal", "thumb-tip"],
  ...["index", "middle", "ring", "pinky"].map((f) => [
    `${f}-finger-metacarpal`, `${f}-finger-phalanx-proximal`,
    `${f}-finger-phalanx-intermediate`, `${f}-finger-phalanx-distal`, `${f}-finger-tip`,
  ]),
];

const SEGMENTS = [];
for (const chain of FINGERS) {
  SEGMENTS.push(["wrist", chain[0]]);
  for (let i = 0; i < chain.length - 1; i++) SEGMENTS.push([chain[i], chain[i + 1]]);
}
// Avuc ici bosluklarini doldurmak icin bilekten bogumlara ve bogumlar arasi.
for (const f of ["index", "middle", "ring", "pinky"]) {
  SEGMENTS.push(["wrist", `${f}-finger-phalanx-proximal`]);
}
SEGMENTS.push(
  ["index-finger-phalanx-proximal", "middle-finger-phalanx-proximal"],
  ["middle-finger-phalanx-proximal", "ring-finger-phalanx-proximal"],
  ["ring-finger-phalanx-proximal", "pinky-finger-phalanx-proximal"],
  ["thumb-phalanx-proximal", "index-finger-phalanx-proximal"],
);

// Deri eklem yaricapindan biraz kalin; ortme kenarda bosluk birakmasin.
const SKIN = 1.25;
const DEFAULT_RADIUS = 0.009;

export class HandOccluder {
  constructor(scene) {
    this.material = new THREE.MeshBasicMaterial({ colorWrite: false });
    const cyl = new THREE.CylinderGeometry(1, 1, 1, 10, 1, true);
    const sph = new THREE.SphereGeometry(1, 10, 8);
    this.group = new THREE.Group();
    this.segments = SEGMENTS.map(([a, b]) => {
      const mesh = new THREE.Mesh(cyl, this.material);
      mesh.renderOrder = -1;
      this.group.add(mesh);
      return { a, b, mesh };
    });
    const names = new Set(SEGMENTS.flat());
    this.joints = [...names].map((name) => {
      const mesh = new THREE.Mesh(sph, this.material);
      mesh.renderOrder = -1;
      this.group.add(mesh);
      return { name, mesh };
    });
    scene.add(this.group);
    this._p = new THREE.Vector3();
    this._q = new THREE.Vector3();
    this._up = new THREE.Vector3(0, 1, 0);
  }

  /** Eli izlenmiyorsa gizler; izleniyorsa kapsulleri eklemlere oturtur. */
  update(hand, tracked) {
    this.group.visible = tracked;
    if (!tracked) return;
    const radius = (name) => (hand.joints[name]?.jointRadius || DEFAULT_RADIUS) * SKIN;

    for (const j of this.joints) {
      const p = jointWorld(hand, j.name, this._p);
      j.mesh.visible = Boolean(p);
      if (!p) continue;
      j.mesh.position.copy(p);
      j.mesh.scale.setScalar(radius(j.name));
    }
    for (const s of this.segments) {
      const a = jointWorld(hand, s.a, this._p);
      const b = a && jointWorld(hand, s.b, this._q);
      s.mesh.visible = Boolean(b);
      if (!b) continue;
      const len = a.distanceTo(b);
      const r = Math.min(radius(s.a), radius(s.b));
      s.mesh.position.addVectors(a, b).multiplyScalar(0.5);
      s.mesh.quaternion.setFromUnitVectors(this._up, b.sub(a).divideScalar(len || 1));
      s.mesh.scale.set(r, len, r);
    }
  }

  dispose() {
    this.group.removeFromParent();
  }
}
