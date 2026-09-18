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
