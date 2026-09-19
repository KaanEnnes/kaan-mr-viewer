/**
 * VR araclari: yazi etiketi, golge, cetvel, kesit duzlemi ve menu dugmesi.
 *
 * Hepsi durumunu kendi tutar; app.js her karede update() cagirir ve sahnedeki
 * modeli / eli parametre olarak verir.
 */
import * as THREE from "three";

const FONT = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";

// --- yazi etiketi -------------------------------------------------------------

/**
 * Kullaniciya donen, canvas'tan cizilmis tek satirlik yazi. onTop: olcu
 * yazilari modelin icinde/arkasinda kalmasin diye derinlik testsiz en uste.
 */
export class Label {
  constructor(widthM = 0.2, onTop = false, pxW = 640, pxH = 110) {
    this.canvas = document.createElement("canvas");
    this.canvas.width = pxW;
    this.canvas.height = pxH;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(widthM, widthM * pxH / pxW),
      new THREE.MeshBasicMaterial({ map: this.texture, transparent: true, depthWrite: false }),
    );
    this.mesh.renderOrder = onTop ? 12 : 8;
    this.mesh.material.depthTest = !onTop;
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

  /** scale: PC'de kamera uzakliga gore buyutur (VR'da 1). */
  place(position, headPos, scale = Label.scale) {
    this.mesh.position.copy(position);
    this.mesh.lookAt(headPos);
    this.mesh.scale.setScalar(scale);
    this.mesh.visible = true;
  }

  hide() { this.mesh.visible = false; }
}
// Tum etiketlerin ortak olcegi; PC goruntuleyicisi her karede ayarlar.
Label.scale = 1;

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

const RULER_COLOR = 0xf5a524;
const _dotGeo = new THREE.SphereGeometry(0.006, 12, 8);
const _rulerMat = new THREE.MeshBasicMaterial({ color: RULER_COLOR, depthTest: false });
const _rulerLineMat = new THREE.LineBasicMaterial({ color: RULER_COLOR, depthTest: false });

function formatLength(m) {
  const cm = m * 100;
  return cm >= 100 ? `${(cm / 100).toFixed(2)} m` : cm >= 10 ? `${cm.toFixed(1)} cm` : `${(cm * 10).toFixed(1)} mm`;
}

/** Tek olcum: iki nokta, cizgi ve etiket. Bir modele yapistirilabilir. */
class Measurement {
  constructor(scene) {
    this.group = new THREE.Group();
    this.dots = [new THREE.Mesh(_dotGeo, _rulerMat), new THREE.Mesh(_dotGeo, _rulerMat)];
    this.line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]), _rulerLineMat);
    for (const o of [...this.dots, this.line]) {
      o.renderOrder = 9;
      this.group.add(o);
    }
    this.label = new Label(0.12, true);
    scene.add(this.group, this.label.mesh);
    this.holder = null; // yapistigi model (tasininca birlikte gider)
    this._a = new THREE.Vector3();
    this._b = new THREE.Vector3();
  }

  /** Uclari dunya noktalarina koyar (grup henuz sahnede, olceksiz). */
  set(a, b) {
    this.dots[0].position.copy(a);
    this.dots[1].position.copy(b);
    const pos = this.line.geometry.attributes.position;
    pos.setXYZ(0, a.x, a.y, a.z);
    pos.setXYZ(1, b.x, b.y, b.z);
    pos.needsUpdate = true;
    this.line.geometry.computeBoundingSphere();
  }

  /** Modele yapistir: attach dunya konumunu korur, model tasininca birlikte gider. */
  stickTo(holder) {
    this.holder = holder;
    holder.attach(this.group);
  }

  update(headPos) {
    const a = this.dots[0].getWorldPosition(this._a);
    const b = this.dots[1].getWorldPosition(this._b);
    // Modele yapisik olcum modelin gercek (1:1) boyutunu gosterir.
    const scale = this.holder ? this.holder.scale.x : 1;
    this.label.set(formatLength(a.distanceTo(b) / scale));
    this.label.place(a.add(b).multiplyScalar(0.5).add(new THREE.Vector3(0, 0.025, 0)), headPos);
  }

  dispose() {
    this.group.removeFromParent();
    this.label.mesh.removeFromParent();
    this.line.geometry.dispose();
  }
}

/**
 * Cetvel: iki noktayla bir olcum; olcumler yerinde kalir, yenileri eklenir.
 * Iki nokta da ayni modelin ustundeyse olcum o modele yapisir.
 */
export class Ruler {
  constructor(scene) {
    this.scene = scene;
    this.done = [];
    this.points = [];
    this.pointHolders = [];
    this.preview = new Measurement(scene);
    this.preview.group.visible = false;
    this.preview.label.hide();
  }

  get count() { return this.done.length; }

  /** Nokta ekler; ikinci noktada olcumu tamamlayip dondurur. */
  addPoint(p, holder = null) {
    this.points.push(p.clone());
    this.pointHolders.push(holder);
    if (this.points.length < 2) return null;
    const m = new Measurement(this.scene);
    m.set(this.points[0], this.points[1]);
    const [h0, h1] = this.pointHolders;
    if (h0 && h0 === h1) m.stickTo(h0);
    this.done.push(m);
    this.points = [];
    this.pointHolders = [];
    return m;
  }

  clear() {
    for (const m of this.done) m.dispose();
    this.done = [];
    this.cancel();
  }

  /** Yarim kalan olcumu (tek nokta) iptal eder; bitmis olcumler kalir. */
  cancel() {
    this.points = [];
    this.pointHolders = [];
  }

  /** Kaldirilan modele yapisik olcumleri siler. */
  removeFor(holder) {
    this.done = this.done.filter((m) => {
      if (m.holder !== holder) return true;
      m.dispose();
      return false;
    });
  }

  /** enabled: cetvel araci acik mi (canli onizleme icin); olcumler her zaman gorunur. */
  update(enabled, preview, headPos) {
    for (const m of this.done) m.update(headPos);
    const live = enabled && this.points.length === 1 && preview;
    this.preview.group.visible = Boolean(live);
    if (!live) {
      this.preview.label.hide();
      return;
    }
    this.preview.set(this.points[0], preview);
    this.preview.update(headPos);
  }
}

// --- teknik detay ------------------------------------------------------------------

const TECH_COLOR = 0x6ea8fe;
const _techLineMat = new THREE.LineBasicMaterial({ color: TECH_COLOR, depthTest: false, transparent: true, opacity: 0.9 });

/**
 * Teknik detay: secilen parcanin kendi eksenindeki kutusu ve uc kenarinin
 * gercek olculeri. Kutu parcanin cocugu (parca ayrilinca / model tasininca
 * birlikte gider); etiketler sahnede, her karede kutunun kenarina oturur.
 */
export class TechDetail {
  constructor(scene) {
    this.scene = scene;
    this.items = new Map(); // parca -> { box, labels, local }
    this._p = [new THREE.Vector3(), new THREE.Vector3()];
    this._c = new THREE.Vector3();
    this._out = new THREE.Vector3();
  }

  get count() { return this.items.size; }

  toggle(part) {
    if (this.items.has(part)) {
      this.remove(part);
      return false;
    }
    if (!part.geometry) return false;
    if (!part.geometry.boundingBox) part.geometry.computeBoundingBox();
    const local = part.geometry.boundingBox.clone();
    const size = local.getSize(new THREE.Vector3());
    const box = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(size.x, size.y, size.z)), _techLineMat);
    box.position.copy(local.getCenter(new THREE.Vector3()));
    box.renderOrder = 9;
    part.add(box);
    const labels = [new Label(0.1, true), new Label(0.1, true), new Label(0.1, true)];
    for (const l of labels) this.scene.add(l.mesh);
    this.items.set(part, { box, labels, local });
    return true;
  }

  remove(part) {
    const it = this.items.get(part);
    if (!it) return;
    it.box.removeFromParent();
    it.box.geometry.dispose();
    for (const l of it.labels) l.mesh.removeFromParent();
    this.items.delete(part);
  }

  clear() {
    for (const part of [...this.items.keys()]) this.remove(part);
  }

  /** realScale(part): dunya metresini gercek metreye ceviren bolen (modelin gosterim olcegi). */
  update(headPos, realScale) {
    for (const [part, it] of this.items) {
      if (!part.parent) {
        this.remove(part);
        continue;
      }
      const { min, max } = it.local;
      // On-alt kenarlar: genislik (x), derinlik (z), yukseklik (y).
      const edges = [
        [[min.x, min.y, max.z], [max.x, min.y, max.z]],
        [[max.x, min.y, min.z], [max.x, min.y, max.z]],
        [[max.x, min.y, max.z], [max.x, max.y, max.z]],
      ];
      const div = realScale(part) || 1;
      const centre = it.local.getCenter(this._c).applyMatrix4(part.matrixWorld);
      edges.forEach(([a, b], i) => {
        const pa = this._p[0].set(...a).applyMatrix4(part.matrixWorld);
        const pb = this._p[1].set(...b).applyMatrix4(part.matrixWorld);
        const len = pa.distanceTo(pb) / div;
        it.labels[i].set(formatLength(len));
        // Yazi kenarin tam ustune degil, kutunun disina dogru biraz kaysin.
        const mid = pa.add(pb).multiplyScalar(0.5);
        const out = this._out.subVectors(mid, centre);
        if (out.lengthSq() > 1e-10) mid.addScaledVector(out.normalize(), 0.018);
        it.labels[i].place(mid, headPos);
      });
    }
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
