/**
 * VR araclari: yazi etiketi, golge, cetvel, kesit duzlemi ve menu dugmesi.
 *
 * Hepsi durumunu kendi tutar; app.js her karede update() cagirir ve sahnedeki
 * modeli / eli parametre olarak verir.
 */
import * as THREE from "three";

const FONT = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";

// --- yazi etiketi -------------------------------------------------------------

/** Kullaniciya donen, canvas'tan cizilmis tek satirlik yazi. */
export class Label {
  constructor(widthM = 0.2, pxW = 640, pxH = 110) {
    this.canvas = document.createElement("canvas");
    this.canvas.width = pxW;
    this.canvas.height = pxH;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(widthM, widthM * pxH / pxW),
      new THREE.MeshBasicMaterial({ map: this.texture, transparent: true, depthWrite: false }),
    );
    this.mesh.renderOrder = 8;
    this.mesh.visible = false;
    this.text = null;
  }

  set(text) {
    if (text === this.text) return;
    this.text = text;
    const { canvas } = this;
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.font = `700 46px ${FONT}`;
    const w = Math.min(canvas.width - 8, ctx.measureText(text).width + 56);
    const x = (canvas.width - w) / 2;
    ctx.fillStyle = "rgba(13, 17, 27, 0.86)";
    ctx.beginPath();
    ctx.roundRect(x, 6, w, canvas.height - 12, (canvas.height - 12) / 2);
    ctx.fill();
    ctx.fillStyle = "#e8ecf4";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, canvas.width / 2, canvas.height / 2 + 2, canvas.width - 40);
    this.texture.needsUpdate = true;
  }

  place(position, headPos) {
    this.mesh.position.copy(position);
    this.mesh.lookAt(headPos);
    this.mesh.visible = true;
  }

  hide() { this.mesh.visible = false; }
}

// --- golge ------------------------------------------------------------------

/**
 * Modelin altindaki gercek yuzeye (masa, zemin) dusen golge. Gorunmez bir
 * "golge yakalayici" duzlem yalnizca golgeyi cizer; passthrough oldugu gibi
 * kalir. Isik ve golge kamerasi her karede modelin etrafina oturtulur, boylece
 * kucuk bir golge haritasi yeterli.
 */
export class ShadowCatcher {
  constructor(scene, renderer, light) {
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.light = light;
    light.castShadow = true;
    light.shadow.mapSize.set(1024, 1024);
    light.shadow.bias = -0.0005;
    light.shadow.normalBias = 0.01;
    scene.add(light.target);
    this.offset = light.position.clone().normalize();

    this.catcher = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
      new THREE.ShadowMaterial({ opacity: 0.38, depthWrite: false }),
    );
    this.catcher.receiveShadow = true;
    this.catcher.renderOrder = 1;
    scene.add(this.catcher);
    this._box = new THREE.Box3();
    this._c = new THREE.Vector3();
    this._s = new THREE.Vector3();
  }

  /** supportY: modelin altindaki yuzeyin yuksekligi (fizik isiniyla bulunur). */
  update(holder, supportY, enabled) {
    this.catcher.visible = enabled && Boolean(holder);
    this.light.castShadow = this.catcher.visible;
    if (!this.catcher.visible) return;

    const box = this._box.setFromObject(holder);
    const c = box.getCenter(this._c);
    const size = box.getSize(this._s);
    const radius = Math.max(size.x, size.y, size.z) * 0.75 + 0.05;

    // Yakalayici modelin izdusumunden biraz genis: masa kenarindan havaya
    // tasan golge kucuk kalsin.
    const span = THREE.MathUtils.clamp(Math.max(size.x, size.z) * 2.2, 0.25, 3);
    this.catcher.position.set(c.x, supportY + 0.002, c.z);
    this.catcher.scale.set(span, 1, span);

    this.light.target.position.copy(c);
    this.light.position.copy(c).addScaledVector(this.offset, radius * 4);
    const cam = this.light.shadow.camera;
    cam.left = cam.bottom = -radius * 1.6;
    cam.right = cam.top = radius * 1.6;
    cam.near = 0.01;
    cam.far = radius * 8;
    cam.updateProjectionMatrix();
  }
}

// --- cetvel -------------------------------------------------------------------

/**
 * Iki nokta arasi olcum. Ilk nokta konunca ikinci nokta eli izler (canli
 * olcum); ikinci nokta konunca sabitlenir. Ucuncu nokta yeni olcum baslatir.
 */
export class Ruler {
  constructor(scene) {
    this.group = new THREE.Group();
    this.group.visible = false;
    const dotGeo = new THREE.SphereGeometry(0.006, 12, 8);
    const dotMat = new THREE.MeshBasicMaterial({ color: 0xf5a524, depthTest: false });
    this.dots = [new THREE.Mesh(dotGeo, dotMat), new THREE.Mesh(dotGeo, dotMat)];
    this.line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
      new THREE.LineBasicMaterial({ color: 0xf5a524, depthTest: false }),
    );
    for (const o of [...this.dots, this.line]) {
      o.renderOrder = 9;
      this.group.add(o);
    }
    this.label = new Label(0.13);
    this.group.add(this.label.mesh);
    scene.add(this.group);
    this.points = [];
    this._mid = new THREE.Vector3();
  }

  addPoint(p) {
    if (this.points.length >= 2) this.points = [];
    this.points.push(p.clone());
  }

  clear() { this.points = []; }

  update(enabled, preview, headPos) {
    this.group.visible = enabled && this.points.length > 0;
    if (!this.group.visible) return;
    const a = this.points[0];
    const b = this.points[1] || preview;
    this.dots[0].position.copy(a);
    this.dots[1].visible = Boolean(b);
    if (!b) {
      this.line.visible = false;
      this.label.hide();
      return;
    }
    this.dots[1].position.copy(b);
    const pos = this.line.geometry.attributes.position;
    pos.setXYZ(0, a.x, a.y, a.z);
    pos.setXYZ(1, b.x, b.y, b.z);
    pos.needsUpdate = true;
    this.line.geometry.computeBoundingSphere();
    this.line.visible = true;
    const cm = a.distanceTo(b) * 100;
    this.label.set(cm >= 100 ? `${(cm / 100).toFixed(2)} m` : `${cm.toFixed(1)} cm`);
    this.label.place(this._mid.addVectors(a, b).multiplyScalar(0.5).add(new THREE.Vector3(0, 0.03, 0)), headPos);
  }
}

// --- kesit duzlemi --------------------------------------------------------------

export const SECTION_MODES = ["off", "y", "x", "z"];

/**
 * Modeli bir duzlemle keser (three.js yerel kirpma). Duzlem modelin kendi
 * ekseninde tanimli; model tasinip dondurulunce kesit de onunla gider.
 * Kesilen tarafin ici gorunsun diye kesit acikken materyaller cift yuzlu.
 */
export class Section {
  constructor() {
    this.plane = new THREE.Plane();
    this.local = new THREE.Plane();
    this.outline = new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(-0.5, 0, -0.5), new THREE.Vector3(0.5, 0, -0.5),
        new THREE.Vector3(0.5, 0, 0.5), new THREE.Vector3(-0.5, 0, 0.5),
      ]),
      new THREE.LineBasicMaterial({ color: 0xf4696b, depthTest: false }),
    );
    this.outline.renderOrder = 9;
    this.model = null;
  }

  /** Kesiti bir modele uygular ya da (mode "off") kaldirir. */
  apply(model, mode, t) {
    if (this.model && this.model !== model) this.detach();
    if (!model || mode === "off") {
      this.detach();
      return;
    }
    this.model = model;
    const box = model.localBox;
    const axis = mode;
    const min = box.min[axis];
    const max = box.max[axis];
    const cut = min + (max - min) * t;

    // Duzlemin arkasi (eksenin buyuk tarafi) kirpilir.
    const n = new THREE.Vector3(axis === "x" ? -1 : 0, axis === "y" ? -1 : 0, axis === "z" ? -1 : 0);
    this.local.set(n, cut);

    for (const mat of model.materials) {
      mat.clippingPlanes = [this.plane];
      if (mat.userData.side === undefined) mat.userData.side = mat.side;
      mat.side = THREE.DoubleSide;
      mat.needsUpdate = true;
    }

    // Kesit cercevesi: model kutusunun kesilen yuzu kadar.
    const size = box.getSize(new THREE.Vector3());
    const centre = box.getCenter(new THREE.Vector3());
    this.outline.position.copy(centre);
    this.outline.position[axis] = cut;
    this.outline.rotation.set(0, 0, 0);
    if (axis === "y") this.outline.scale.set(size.x, 1, size.z);
    if (axis === "x") { this.outline.rotation.z = Math.PI / 2; this.outline.scale.set(size.y, 1, size.z); }
    if (axis === "z") { this.outline.rotation.x = Math.PI / 2; this.outline.scale.set(size.x, 1, size.y); }
    if (this.outline.parent !== model.root) model.root.add(this.outline);
  }

  detach() {
    const model = this.model;
    this.model = null;
    this.outline.removeFromParent();
    if (!model) return;
    for (const mat of model.materials) {
      mat.clippingPlanes = null;
      if (mat.userData.side !== undefined) mat.side = mat.userData.side;
      mat.needsUpdate = true;
    }
  }

  /** Model hareket ettikce dunya duzlemini yeniler. */
  update() {
    if (!this.model) return;
    this.plane.copy(this.local).applyMatrix4(this.model.root.matrixWorld);
  }
}

// --- bilek dugmesi --------------------------------------------------------------

/**
 * Sol bilekte, avuc kullaniciya donunce beliren yuvarlak menu dugmesi.
 * Diger elin isaret parmagiyla dokununca basilir.
 */
export class WristButton {
  constructor(scene) {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 128;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "rgba(13, 17, 27, 0.9)";
    ctx.beginPath();
    ctx.arc(64, 64, 60, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#6ea8fe";
    ctx.lineWidth = 6;
    ctx.stroke();
    ctx.fillStyle = "#e8ecf4";
    for (const y of [42, 60, 78]) ctx.fillRect(38, y, 52, 8);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    this.mesh = new THREE.Mesh(
      new THREE.CircleGeometry(0.02, 32),
      new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false }),
    );
    this.mesh.renderOrder = 9;
    this.mesh.visible = false;
    scene.add(this.mesh);
    this.armed = true;
  }

  /** Dokunma olursa true doner. */
  poke(tip) {
    if (!this.mesh.visible || !tip) return false;
    const d = tip.distanceTo(this.mesh.position);
    if (d > 0.045) this.armed = true;
    if (this.armed && d < 0.022) {
      this.armed = false;
      return true;
    }
    return false;
  }
}
