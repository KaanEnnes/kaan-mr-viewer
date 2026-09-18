/**
 * Kaan MR Viewer - Quest 3 passthrough model goruntuleyici.
 *
 * Tarayicida calisir: kurulum, sideload ve developer mode gerektirmez.
 * Gozlukte siteyi ac, "Passthrough'a gir" de, model gercek odanda belirir.
 */
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { ThreeMFLoader } from "three/addons/loaders/3MFLoader.js";
import { unzipSync, strFromU8 } from "three/addons/libs/fflate.module.js";
import * as CANNON from "https://cdn.jsdelivr.net/npm/cannon-es@0.20.0/dist/cannon-es.js";

// --- sabitler ---------------------------------------------------------------

const GHOST_OPACITY = 0.45;
// Cubuk ne kadar itilirse itilsin kucuk hareketler yok sayilsin.
const DEADZONE = 0.2;
const ROTATE_SPEED = 1.6;   // radyan/saniye
const SCALE_SPEED = 0.7;    // oran/saniye
const OPACITY_SPEED = 1.2;  // birim/saniye
// Zemin, local-floor referansinda y=0'dir; modeli birkac milimetre ustunde
// birakmazsak fizik acildigi anda zemine gomulmus sayiliyor.
const FLOOR_EPSILON = 0.005;

// --- durum ------------------------------------------------------------------

const state = {
  catalog: [],
  selected: null,
  localFile: null,
  renderer: null,
  scene: null,
  camera: null,
  session: null,
  reticle: null,
  hitTestSource: null,
  viewerSpace: null,
  model: null,       // { root, parts, bodies, opacity, realistic, physics }
  world: null,
  controllers: [],
  held: null,
  lastTime: 0,
};

const el = {
  xrDot: document.getElementById("xr-dot"),
  xrText: document.getElementById("xr-text"),
  list: document.getElementById("model-list"),
  file: document.getElementById("file-input"),
  enter: document.getElementById("enter-ar"),
  hint: document.getElementById("enter-hint"),
  hud: document.getElementById("hud"),
  hudText: document.getElementById("hud-text"),
};

// --- WebXR destegi ----------------------------------------------------------

async function checkSupport() {
  if (!navigator.xr) {
    setStatus("err", "Bu tarayici WebXR desteklemiyor. Quest tarayicisindan ac.");
    return false;
  }
  let supported = false;
  try {
    supported = await navigator.xr.isSessionSupported("immersive-ar");
  } catch {
    supported = false;
  }
  if (!supported) {
    setStatus("warn",
      "Passthrough (immersive-ar) bulunamadi. Sayfayi Quest 3 tarayicisindan ac.");
    return false;
  }
  setStatus("ok", "Passthrough hazir. Bir model sec ve basla.");
  return true;
}

function setStatus(kind, text) {
  el.xrDot.className = "dot " + kind;
  el.xrText.textContent = text;
}

function hud(text, ms = 2000) {
  el.hudText.textContent = text;
  el.hud.hidden = false;
  clearTimeout(hud._t);
  hud._t = setTimeout(() => { el.hud.hidden = true; }, ms);
}

// --- katalog ----------------------------------------------------------------

async function loadCatalog() {
  try {
    const res = await fetch("models/index.json", { cache: "no-cache" });
    if (!res.ok) throw new Error(res.status);
    const data = await res.json();
    state.catalog = data.models || [];
  } catch {
    state.catalog = [];
  }
  renderCatalog();
}

function renderCatalog() {
  el.list.innerHTML = "";
  if (!state.catalog.length) {
    const p = document.createElement("p");
    p.className = "muted";
    p.textContent =
      "Katalogda model yok. Asagidan kendi GLB dosyani yukleyebilirsin.";
    el.list.appendChild(p);
    return;
  }

  for (const m of state.catalog) {
    const btn = document.createElement("button");
    btn.className = "model";
    btn.type = "button";
    btn.setAttribute("aria-pressed", "false");

    const size = Array.isArray(m.sizeMeters)
      ? m.sizeMeters.map((v) => v.toFixed(2)).join(" x ") + " m"
      : "";

    btn.innerHTML =
      `<span class="name">${escapeHtml(m.name)}` +
      (m.articulated ? `<span class="badge">${m.partCount} parca</span>` : "") +
      `</span><span class="meta">${size}</span>`;

    btn.addEventListener("click", () => selectModel(m, btn));
    el.list.appendChild(btn);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function selectModel(entry, btn) {
  state.selected = entry;
  state.localFile = null;
  for (const b of el.list.querySelectorAll(".model")) {
    b.setAttribute("aria-pressed", String(b === btn));
  }
  el.enter.disabled = false;
  el.hint.textContent = `"${entry.name}" secildi.`;
}

el.file.addEventListener("change", (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  // Dosya tarayicida okunur; hicbir sunucuya gitmez.
  state.localFile = URL.createObjectURL(file);
  state.selected = { name: file.name, url: state.localFile, local: true,
                     format: formatOf(file.name) };
  for (const b of el.list.querySelectorAll(".model")) {
    b.setAttribute("aria-pressed", "false");
  }
  el.enter.disabled = false;
  el.hint.textContent = `"${file.name}" secildi.`;
});

// --- sahne ------------------------------------------------------------------

function buildScene() {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(70, 1, 0.01, 40);

  // Passthrough'da gercek isik yok; yumusak bir ortam isigi + yonlu isik
  // modelin hacmini okunur kiliyor.
  scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 2.2));
  const sun = new THREE.DirectionalLight(0xffffff, 1.5);
  sun.position.set(1, 3, 1.5);
  scene.add(sun);

  const reticle = new THREE.Mesh(
    new THREE.RingGeometry(0.05, 0.065, 32).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0x6ea8fe, transparent: true, opacity: 0.9 }),
  );
  reticle.matrixAutoUpdate = false;
  reticle.visible = false;
  scene.add(reticle);

  state.scene = scene;
  state.camera = camera;
  state.reticle = reticle;
}

function buildRenderer() {
  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: true,             // passthrough icin saydam arka plan sart
    powerPreference: "high-performance",
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setClearAlpha(0);
  renderer.xr.enabled = true;
  renderer.xr.setReferenceSpaceType("local-floor");
  document.body.appendChild(renderer.domElement);
  renderer.domElement.style.display = "none";
  state.renderer = renderer;
}

function buildWorld() {
  const world = new CANNON.World({ gravity: new CANNON.Vec3(0, -9.82, 0) });
  world.solver.iterations = 14;
  world.allowSleep = true;

  // Gercek zemin: local-floor referansinda y=0 kullanicinin durdugu zemindir,
  // yani sanal nesneler gercekten odanin zeminine duser.
  const floor = new CANNON.Body({ type: CANNON.Body.STATIC, shape: new CANNON.Plane() });
  floor.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
  world.addBody(floor);

  state.world = world;
}

// --- model yukleme ----------------------------------------------------------

const gltfLoader = new GLTFLoader();
const threeMfLoader = new ThreeMFLoader();

function formatOf(name) {
  return /\.3mf$/i.test(name) ? "3mf" : "gltf";
}

function loadGltf(url) {
  return new Promise((resolve, reject) => {
    gltfLoader.load(url, (g) => resolve(g.scene), undefined, (e) => reject(e));
  });
}

// 3MF'in kendi birim tanimi; varsayilan milimetre (Tinkercad, dilimleyiciler).
const MF_UNITS = {
  micron: 1e-6, millimeter: 1e-3, centimeter: 1e-2,
  inch: 0.0254, foot: 0.3048, meter: 1,
};

function read3mfUnit(buffer) {
  try {
    const files = unzipSync(new Uint8Array(buffer));
    const modelPath = Object.keys(files).find((f) => /^3D\/.*\.model$/i.test(f));
    if (!modelPath) return MF_UNITS.millimeter;
    // Sadece kok <model> etiketine bakmak yeterli.
    const head = strFromU8(files[modelPath].subarray(0, 4096));
    const m = head.match(/<model[^>]*\sunit\s*=\s*"([a-z]+)"/i);
    return (m && MF_UNITS[m[1].toLowerCase()]) || MF_UNITS.millimeter;
  } catch {
    return MF_UNITS.millimeter;
  }
}

async function load3mf(url) {
  const buffer = await (await fetch(url)).arrayBuffer();
  const group = threeMfLoader.parse(buffer);
  // 3MF Z-yukari ve genelde milimetre; sahne Y-yukari ve metre.
  const wrapper = new THREE.Group();
  group.rotation.x = -Math.PI / 2;
  group.scale.setScalar(read3mfUnit(buffer));
  wrapper.add(group);
  wrapper.updateMatrixWorld(true);
  return wrapper;
}

function loadModel(entry) {
  const format = entry.format || formatOf(entry.url);
  return format === "3mf" ? load3mf(entry.url) : loadGltf(entry.url);
}

/**
 * Modeli sahneye kurar.
 *
 * PC pipeline'inin urettigi GLB'lerde her hareketli parca PART_i adiyla ayri
 * bir mesh olarak gelir. Boyle bir isimlendirme yoksa (indirilmis duz bir
 * model) tum model tek parca olarak ele alinir.
 */
async function spawnModel(entry) {
  const root = await loadModel(entry);

  // Collider olarak gomulmus hull'lar cizilmemeli.
  const hulls = [];
  root.traverse((o) => { if (o.name.startsWith("COL_")) hulls.push(o); });
  for (const h of hulls) h.visible = false;

  const parts = [];
  root.traverse((o) => {
    if (o.isMesh && o.name.startsWith("PART_")) parts.push(o);
  });
  if (!parts.length) {
    root.traverse((o) => { if (o.isMesh) parts.push(o); });
  }

  // Modeli kendi tabaninin ortasina hizala: yerlestirme "ayagindan" olsun.
  const box = new THREE.Box3().setFromObject(root);
  const center = box.getCenter(new THREE.Vector3());
  root.position.sub(new THREE.Vector3(center.x, box.min.y, center.z));

  const holder = new THREE.Group();
  holder.add(root);
  state.scene.add(holder);

  const materials = [];
  root.traverse((o) => {
    if (!o.isMesh || !o.material) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      // Materyali klonluyoruz ki ayni modelin ikinci kopyasi etkilenmesin.
      const clone = m.clone();
      clone.userData.baseOpacity = clone.opacity ?? 1;
      materials.push(clone);
    }
    o.material = Array.isArray(o.material) ? materials.slice(-1) : materials[materials.length - 1];
  });

  state.model = {
    holder, root, parts, materials,
    bodies: [], opacity: 1, realistic: false, physics: false,
    entry,
  };

  setOpacity(GHOST_OPACITY);
  return state.model;
}

/** Her parca icin fizik govdesi kurar (sinir kutusu yaklasimi). */
function buildBodies() {
  const m = state.model;
  if (!m || m.bodies.length) return;

  for (const part of m.parts) {
    const box = new THREE.Box3().setFromObject(part);
    const size = box.getSize(new THREE.Vector3());
    const centre = box.getCenter(new THREE.Vector3());
    if (size.x <= 0 || size.y <= 0 || size.z <= 0) continue;

    const shape = new CANNON.Box(
      new CANNON.Vec3(size.x / 2, size.y / 2, size.z / 2));
    // Kutle hacimden: 5 gramlik cita ile 100 gramlik govde dogru oranda
    // davransin diye plastige yakin bir yogunluk kullaniyoruz.
    const mass = Math.max(size.x * size.y * size.z * 400, 0.01);

    const body = new CANNON.Body({ mass, shape });
    body.position.set(centre.x, centre.y, centre.z);
    body.sleepSpeedLimit = 0.08;
    body.linearDamping = 0.02;
    state.world.addBody(body);
    m.bodies.push({ body, part, offset: centre.clone() });
  }
}

// --- gorunum ----------------------------------------------------------------

function setOpacity(value) {
  const m = state.model;
  if (!m) return;
  m.opacity = Math.min(1, Math.max(0, value));
  const transparent = m.opacity < 0.999;
  for (const mat of m.materials) {
    mat.transparent = transparent;
    mat.opacity = m.opacity;
    // Yari saydam yuzeyler derinlige yazmamali, yoksa passthrough uzerinde
    // kendi arkasini kesip yanlis siralanir.
    mat.depthWrite = !transparent;
    mat.needsUpdate = true;
  }
}

function toggleView() {
  const m = state.model;
  if (!m) return;
  m.realistic = !m.realistic;
  setOpacity(m.realistic ? 1 : GHOST_OPACITY);
  hud(m.realistic ? "Gercek gorunum" : "Hayalet gorunum");
}

function togglePhysics() {
  const m = state.model;
  if (!m) return;
  m.physics = !m.physics;
  if (m.physics) {
    buildBodies();
    syncBodiesFromScene();
    for (const b of m.bodies) b.body.wakeUp();
  }
  hud(m.physics ? "Fizik acik" : "Fizik kapali");
}

/** Sahnedeki konumu fizik govdelerine yazar (tasidiktan sonra gerekiyor). */
function syncBodiesFromScene() {
  const m = state.model;
  if (!m) return;
  for (const entry of m.bodies) {
    const world = new THREE.Vector3();
    entry.part.getWorldPosition(world);
    entry.body.position.set(world.x, Math.max(world.y, FLOOR_EPSILON), world.z);
    entry.body.velocity.setZero();
    entry.body.angularVelocity.setZero();
  }
}

// --- kumanda ----------------------------------------------------------------

function setUpControllers() {
  const rayGeo = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1),
  ]);

  for (let i = 0; i < 2; i++) {
    const controller = state.renderer.xr.getController(i);
    const line = new THREE.Line(rayGeo,
      new THREE.LineBasicMaterial({ color: 0x6ea8fe, transparent: true, opacity: 0.6 }));
    line.scale.z = 3;
    controller.add(line);
    state.scene.add(controller);
    state.controllers.push({ controller, prev: {} });
  }
}

function readGamepads(dt) {
  const session = state.session;
  const m = state.model;
  if (!session || !m) return;

  for (const source of session.inputSources) {
    const gp = source.gamepad;
    if (!gp) continue;

    const hand = source.handedness;
    const buttons = gp.buttons || [];
    const axes = gp.axes || [];
    // Quest kumandasinda cubuk 2-3, A/X dugmesi 4, B/Y dugmesi 5,
    // kavrama 1, tetik 0 indeksindedir.
    const stickX = Math.abs(axes[2] || 0) > DEADZONE ? axes[2] : 0;
    const stickY = Math.abs(axes[3] || 0) > DEADZONE ? axes[3] : 0;
    const a = buttons[4] && buttons[4].pressed;
    const b = buttons[5] && buttons[5].pressed;
    const grip = buttons[1] && buttons[1].pressed;

    const store = source.__prev || (source.__prev = {});

    if (hand === "right") {
      if (a && !store.a) toggleView();
      if (b) {
        // B basiliyken cubuk seffaflik ayarina doner.
        if (stickX) setOpacity(m.opacity + stickX * OPACITY_SPEED * dt);
      } else {
        if (stickX) m.holder.rotateY(-stickX * ROTATE_SPEED * dt);
        if (stickY) {
          const f = 1 - stickY * SCALE_SPEED * dt;
          const s = Math.min(10, Math.max(0.1, m.holder.scale.x * f));
          m.holder.scale.setScalar(s);
        }
      }
      store.a = a;
    } else if (hand === "left") {
      if (a && !store.a) togglePhysics();
      store.a = a;
    }

    // Kavrama: model kumandaya baglanir, birakinca sahneye geri doner.
    if (grip && !store.grip) beginHold(source);
    if (!grip && store.grip) endHold();
    store.grip = grip;
  }
}

function beginHold(source) {
  const m = state.model;
  if (!m || state.held) return;
  const idx = [...state.session.inputSources].indexOf(source);
  const c = state.controllers[idx] && state.controllers[idx].controller;
  if (!c) return;

  state.held = { controller: c, wasPhysics: m.physics };
  m.physics = false;
  c.attach(m.holder);
  hud("Tutuluyor");
}

function endHold() {
  const m = state.model;
  if (!m || !state.held) return;
  state.scene.attach(m.holder);
  m.physics = state.held.wasPhysics;
  if (m.physics) syncBodiesFromScene();
  state.held = null;
}

function placeAtReticle() {
  const m = state.model;
  if (!m || !state.reticle.visible) {
    hud("Once bir yuzeye bak");
    return;
  }
  const p = new THREE.Vector3().setFromMatrixPosition(state.reticle.matrix);
  m.holder.position.copy(p);
  if (m.physics) syncBodiesFromScene();
  hud("Yerlestirildi");
}

// --- oturum -----------------------------------------------------------------

async function enterAR() {
  const entry = state.selected;
  if (!entry) return;

  el.enter.disabled = true;
  el.hint.textContent = "Model yukleniyor…";

  try {
    buildScene();
    buildWorld();
    await spawnModel(entry);
  } catch (err) {
    el.hint.textContent = "Model yuklenemedi: " + err.message;
    el.enter.disabled = false;
    return;
  }

  let session;
  try {
    session = await navigator.xr.requestSession("immersive-ar", {
      requiredFeatures: ["local-floor"],
      optionalFeatures: ["hit-test", "anchors", "plane-detection", "dom-overlay"],
      domOverlay: { root: document.getElementById("hud") },
    });
  } catch (err) {
    el.hint.textContent = "Passthrough baslatilamadi: " + err.message;
    el.enter.disabled = false;
    return;
  }

  state.session = session;
  state.renderer.domElement.style.display = "";
  await state.renderer.xr.setSession(session);

  setUpControllers();

  for (const { controller } of state.controllers) {
    controller.addEventListener("selectstart", placeAtReticle);
  }

  try {
    state.viewerSpace = await session.requestReferenceSpace("viewer");
    state.hitTestSource = await session.requestHitTestSource({ space: state.viewerSpace });
  } catch {
    state.hitTestSource = null; // hit-test yoksa yerlestirme onde sabit olur
  }

  session.addEventListener("end", onSessionEnd);
  state.renderer.setAnimationLoop(onFrame);
  hud("Tetik: yerlestir • A: gorunum • X: fizik", 5000);
}

function onSessionEnd() {
  state.renderer.setAnimationLoop(null);
  state.renderer.domElement.style.display = "none";
  state.session = null;
  state.hitTestSource = null;
  el.enter.disabled = false;
  el.hint.textContent = "Oturum kapandi. Tekrar girebilirsin.";
}

function onFrame(time, frame) {
  const dt = state.lastTime ? Math.min((time - state.lastTime) / 1000, 0.05) : 0;
  state.lastTime = time;

  if (frame && state.hitTestSource) {
    const refSpace = state.renderer.xr.getReferenceSpace();
    const hits = frame.getHitTestResults(state.hitTestSource);
    if (hits.length) {
      const pose = hits[0].getPose(refSpace);
      state.reticle.visible = true;
      state.reticle.matrix.fromArray(pose.transform.matrix);
    } else {
      state.reticle.visible = false;
    }
  }

  readGamepads(dt);

  const m = state.model;
  if (m && m.physics && dt > 0) {
    state.world.step(1 / 90, dt, 3);
    for (const entry of m.bodies) {
      const p = entry.body.position;
      entry.part.parent.worldToLocal(entry.part.position.set(p.x, p.y, p.z));
      entry.part.quaternion.set(
        entry.body.quaternion.x, entry.body.quaternion.y,
        entry.body.quaternion.z, entry.body.quaternion.w);
    }
  }

  state.renderer.render(state.scene, state.camera);
}

// --- baslangic --------------------------------------------------------------

el.enter.addEventListener("click", enterAR);

buildRenderer();
window.addEventListener("resize", () => {
  if (!state.renderer) return;
  state.renderer.setSize(window.innerWidth, window.innerHeight);
});

checkSupport();
loadCatalog();
