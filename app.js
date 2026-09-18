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
import { XRHandModelFactory } from "three/addons/webxr/XRHandModelFactory.js";
import * as CANNON from "https://cdn.jsdelivr.net/npm/cannon-es@0.20.0/dist/cannon-es.js";
import {
  INDEX_TIP, THUMB_TIP, jointWorld, palmNormal, palmCentre, VelocityTracker,
} from "./hands.js";
import { WristMenu } from "./menu.js";

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
// Model ilk acildiginda en uzun kenari bundan buyukse bu boya kucultulur.
const DEFAULT_SIZE = 0.35;       // metre
// Cimdik modelin sinir kutusuna bu kadar yakinsa "tut" sayilir.
const GRAB_MARGIN = 0.06;        // metre
const THROW_MAX_SPEED = 6;       // m/s
const FINGER_RADIUS = 0.01;      // itme kuresi, metre
// Iki elle olceklemede baslangic mesafesi bundan kucuk sayilmaz: eller
// yakinken baslayinca kucuk bir acilma modeli bir anda katlarca buyutuyordu.
const TWO_HAND_MIN_SPAN = 0.15;  // metre
// Iki elle olcek bir karede en fazla bu oranda degisir (izleme sicramalarini yutar).
const TWO_HAND_MAX_STEP = 1.06;
// El bu sureden uzun gorunmezse tuttugu model birakilir.
const HAND_LOST_RELEASE_MS = 300;
// Cimdik bu kadar kare ust uste gorulmeden baslamaz (tek karelik izleme hatasi).
const PINCH_CONFIRM_FRAMES = 2;
// Oda yuzeylerinden (masa, zemin, duvar) kurulan fizik kutularinin kalinligi.
// Ince olursa hizli dusen parca yuzeyin icinden gecebiliyor.
const SURFACE_THICKNESS = 0.05;  // metre
// ?debug ile acilinca gozlukte el/yuzey olcumleri gosterilir.
const DEBUG = new URLSearchParams(location.search).has("debug");

// PC'den yuklenen modellerin durdugu bulut deposu (Cloudflare Worker + R2).
// Boylece PC'de yuklenen model gozlukte de listelenir.
const API = "https://vr-api.kaanai.site";
const KEY_STORAGE = "kaan-mr-viewer.uploadKey";

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
  inputs: [],        // kumanda/el kayitlari, bkz. setUpInputs
  grab: null,        // { input, wasPhysics }
  twoHand: null,
  menu: null,
  toast: null,
  needsPlacement: false,
  loading: false,
  surfaces: new Map(),  // XRPlane -> { body, changed }
  surfaceHintShown: false,
  debugText: "",
  lastTime: 0,
};

const handFactory = new XRHandModelFactory();

const el = {
  xrDot: document.getElementById("xr-dot"),
  xrText: document.getElementById("xr-text"),
  list: document.getElementById("model-list"),
  file: document.getElementById("file-input"),
  refresh: document.getElementById("refresh"),
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
  if (state.session) showToast(text, ms);
  el.hudText.textContent = text;
  el.hud.hidden = false;
  clearTimeout(hud._t);
  hud._t = setTimeout(() => { el.hud.hidden = true; }, ms);
}

// --- katalog ----------------------------------------------------------------

async function loadCatalog() {
  const [local, cloud] = await Promise.all([
    fetchCatalog("models/index.json"),
    fetchCatalog(`${API}/models`),
  ]);
  for (const m of cloud) m.cloud = true;
  // Yeni yuklenenler en ustte.
  state.catalog = [...cloud, ...local];
  renderCatalog();
}

async function fetchCatalog(url) {
  try {
    const res = await fetch(url, { cache: "no-cache" });
    if (!res.ok) throw new Error(res.status);
    const data = await res.json();
    return data.models || [];
  } catch {
    return [];
  }
}

function renderCatalog() {
  el.list.innerHTML = "";
  if (!state.catalog.length) {
    const p = document.createElement("p");
    p.className = "muted";
    p.textContent =
      "Katalogda model yok. Asagidan kendi modelini yukleyebilirsin.";
    el.list.appendChild(p);
    return;
  }

  const canDelete = Boolean(readKey());
  for (const m of state.catalog) {
    const row = document.createElement("div");
    row.className = "model-row";

    const btn = document.createElement("button");
    btn.className = "model";
    btn.type = "button";
    btn.setAttribute("aria-pressed", String(state.selected?.url === m.url));

    const meta = Array.isArray(m.sizeMeters)
      ? m.sizeMeters.map((v) => v.toFixed(2)).join(" x ") + " m"
      : m.cloud ? formatBytes(m.bytes) : "";

    btn.innerHTML =
      `<span class="name">${escapeHtml(m.name)}` +
      (m.articulated ? `<span class="badge">${m.partCount} parca</span>` : "") +
      (m.cloud ? `<span class="badge cloud">${m.format === "3mf" ? "3MF" : "GLB"}</span>` : "") +
      `</span><span class="meta">${meta}</span>`;

    btn.addEventListener("click", () => selectModel(m, btn));
    row.appendChild(btn);

    if (m.cloud && canDelete) {
      const del = document.createElement("button");
      del.className = "model-delete";
      del.type = "button";
      del.title = `"${m.name}" modelini sil`;
      del.setAttribute("aria-label", del.title);
      del.textContent = "Sil";
      del.addEventListener("click", () => deleteModel(m));
      row.appendChild(del);
    }
    el.list.appendChild(row);
  }
}

function formatBytes(n) {
  if (!n) return "";
  return n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB`
    : `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// --- bulut yukleme ----------------------------------------------------------

function readKey() {
  try { return localStorage.getItem(KEY_STORAGE) || ""; } catch { return ""; }
}

function writeKey(key) {
  try {
    if (key) localStorage.setItem(KEY_STORAGE, key);
    else localStorage.removeItem(KEY_STORAGE);
  } catch { /* gizli pencere: her seferinde sorulur */ }
}

/** Yukleme sifresini dondurur; yoksa bir kez sorar ve bu cihazda hatirlar. */
function askKey() {
  let key = readKey();
  if (!key) {
    key = (window.prompt(
      "Yukleme sifresi (bir kez sorulur, bu cihazda hatirlanir).\n" +
      "Bos birakirsan model sadece bu cihazda acilir.") || "").trim();
    if (key) writeKey(key);
  }
  return key;
}

/** Dosyayi buluta yukler; ilerlemeyi gostermek icin XHR kullaniliyor. */
function uploadFile(file, key) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", `${API}/models?name=${encodeURIComponent(file.name)}`);
    xhr.setRequestHeader("Authorization", `Bearer ${key}`);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        el.hint.textContent = `Yukleniyor… %${Math.round((e.loaded / e.total) * 100)}`;
      }
    };
    xhr.onload = () => {
      let body = {};
      try { body = JSON.parse(xhr.responseText); } catch { /* bos */ }
      if (xhr.status === 201) resolve(body);
      else {
        const err = new Error(body.error || `HTTP ${xhr.status}`);
        err.status = xhr.status;
        reject(err);
      }
    };
    xhr.onerror = () => reject(new Error("baglanti hatasi"));
    xhr.send(file);
  });
}

async function deleteModel(m) {
  if (!window.confirm(`"${m.name}" buluttan silinsin mi? Tum cihazlardan kalkar.`)) return;
  try {
    const res = await fetch(`${API}/models/${encodeURIComponent(m.id)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${readKey()}` },
    });
    if (res.status === 401) writeKey("");
    if (!res.ok) throw new Error(res.status === 401 ? "sifre yanlis" : `HTTP ${res.status}`);
    if (state.selected?.url === m.url) {
      state.selected = null;
      el.enter.disabled = true;
      el.hint.textContent = "Once bir model sec.";
    }
  } catch (err) {
    el.hint.textContent = "Silinemedi: " + err.message;
  }
  loadCatalog();
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

el.file.addEventListener("change", async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = ""; // ayni dosya tekrar secilebilsin
  if (!file) return;
  for (const b of el.list.querySelectorAll(".model")) {
    b.setAttribute("aria-pressed", "false");
  }

  const key = askKey();
  if (key) {
    el.enter.disabled = true;
    try {
      const saved = await uploadFile(file, key);
      state.selected = { name: file.name, url: saved.url, format: formatOf(file.name), cloud: true };
      state.localFile = null;
      await loadCatalog();
      el.hint.textContent = `"${file.name}" buluta yuklendi — gozlukte de listede.`;
      el.enter.disabled = false;
      return;
    } catch (err) {
      if (err.status === 401) writeKey("");
      el.hint.textContent = `Buluta yuklenemedi (${err.message}); sadece bu cihazda acilacak.`;
    }
  }

  // Sifre yoksa ya da yukleme basarisizsa: dosya yalnizca bu cihazda okunur.
  state.localFile = URL.createObjectURL(file);
  state.selected = { name: file.name, url: state.localFile, local: true,
                     format: formatOf(file.name) };
  el.enter.disabled = false;
  if (!key) el.hint.textContent = `"${file.name}" secildi (sadece bu cihazda).`;
});

el.refresh.addEventListener("click", loadCatalog);

// Gozluk sekmesi one gelince katalog tazelenir: PC'den yeni yuklenen model
// sayfayi yenilemeden gorunur.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && !state.session) loadCatalog();
});

// --- ayarlar ----------------------------------------------------------------

const SETTINGS_STORAGE = "kaan-mr-viewer.settings";
const DEFAULT_SETTINGS = { throw: true, push: true, handStyle: "tips", pinch: "normal" };

// Cimdik baslangic / bitis mesafeleri (basparmak ucu - isaret parmagi ucu).
// Bitis esigi daha buyuk: parmaklar hafif acilinca tutus hemen kopmasin.
const PINCH_THRESHOLDS = {
  low: [0.014, 0.026],
  normal: [0.02, 0.032],
  high: [0.028, 0.042],
};

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_STORAGE) || "{}");
    return { ...DEFAULT_SETTINGS, ...saved };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings() {
  try { localStorage.setItem(SETTINGS_STORAGE, JSON.stringify(settings)); } catch { /* yok say */ }
}

const settings = loadSettings();

function setSetting(key, value) {
  settings[key] = value;
  saveSettings();
  if (key === "handStyle") for (const input of state.inputs) applyHandStyle(input);
  if (key === "push" && !value) removeFingerBodies();
  const labels = {
    throw: `Firlatma ${value ? "acik" : "kapali"}`,
    push: `Parmakla itme ${value ? "acik" : "kapali"}`,
    handStyle: "El gorunumu degisti",
    pinch: "Cimdik hassasiyeti degisti",
  };
  hud(labels[key] || "Ayar kaydedildi");
  state.menu?.invalidate();
}

// --- sahne ------------------------------------------------------------------

function buildScene() {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(70, 1, 0.01, 40);
  // Kameranin cocuklari (bildirim paneli) cizilsin diye kamera sahnede olmali.
  scene.add(camera);

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
  state.toast = buildToast(camera);
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

/**
 * Gozlukte DOM bildirimi (dom-overlay) Quest'te her zaman gorunmuyor; bu
 * yuzden bildirimler goruntunun altinda kucuk bir panelde de cikiyor.
 */
function buildToast(camera) {
  const canvas = document.createElement("canvas");
  canvas.width = 640;
  canvas.height = 96;
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(0.32, 0.048),
    new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthTest: false, depthWrite: false }),
  );
  mesh.position.set(0, -0.16, -0.7);
  mesh.renderOrder = 11;
  mesh.visible = false;
  camera.add(mesh);
  return { mesh, canvas, texture, timer: 0 };
}

function showToast(text, ms) {
  const t = state.toast;
  if (!t) return;
  const ctx = t.canvas.getContext("2d");
  ctx.clearRect(0, 0, 640, 96);
  ctx.fillStyle = "rgba(13, 17, 27, 0.88)";
  ctx.beginPath();
  ctx.roundRect(4, 4, 632, 88, 44);
  ctx.fill();
  ctx.fillStyle = "#e8ecf4";
  ctx.font = "600 34px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, 320, 50, 590);
  t.texture.needsUpdate = true;
  t.mesh.visible = true;
  clearTimeout(t.timer);
  t.timer = setTimeout(() => { t.mesh.visible = false; }, ms);
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
 * model) her mesh ayri parca sayilir.
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
    root.traverse((o) => { if (o.isMesh && o.visible) parts.push(o); });
  }
  for (const p of parts) {
    p.userData.home = { p: p.position.clone(), q: p.quaternion.clone(), s: p.scale.clone() };
  }

  // Modeli kendi tabaninin ortasina hizala: yerlestirme "ayagindan" olsun.
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root);
  const center = box.getCenter(new THREE.Vector3());
  root.position.sub(new THREE.Vector3(center.x, box.min.y, center.z));

  const holder = new THREE.Group();
  holder.add(root);

  // Indirilen modeller cogu zaman ev boyutunda ya da birimsiz geliyor;
  // varsayilan olarak en uzun kenar DEFAULT_SIZE'a sigdirilir. Menudeki
  // "1:1" gercek boyuta doner.
  const size = box.getSize(new THREE.Vector3());
  const longest = Math.max(size.x, size.y, size.z);
  const fitScale = longest > DEFAULT_SIZE ? DEFAULT_SIZE / longest : 1;
  holder.scale.setScalar(fitScale);

  const materials = [];
  root.traverse((o) => {
    if (!o.isMesh || !o.material) return;
    const cloneMat = (mat) => {
      // Materyali klonluyoruz ki ayni modelin ikinci kopyasi etkilenmesin.
      const c = mat.clone();
      materials.push(c);
      return c;
    };
    o.material = Array.isArray(o.material) ? o.material.map(cloneMat) : cloneMat(o.material);
  });

  return {
    holder, root, parts, materials, fitScale, longest,
    bodies: [], opacity: 1, realistic: false, physics: false,
    entry,
  };
}

function disposeModel(m) {
  if (!m) return;
  removeBodies(m);
  m.holder.removeFromParent();
  m.holder.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
  });
  for (const mat of m.materials) mat.dispose();
}

/** Oturum icinde modeli degistirir; yeni model eskisinin yerinde belirir. */
async function switchModel(entry) {
  if (state.loading) return;
  state.loading = true;
  hud(`Yukleniyor: ${entry.name}`, 6000);
  state.menu?.setStatus("Yukleniyor…");
  try {
    const next = await spawnModel(entry);
    const old = state.model;
    releaseAll();
    if (old) {
      next.holder.position.copy(old.holder.position);
      next.holder.quaternion.copy(old.holder.quaternion);
    }
    disposeModel(old);
    state.model = next;
    state.scene.add(next.holder);
    setOpacity(GHOST_OPACITY);
    if (!old) state.needsPlacement = true;
    hud(`${entry.name}${next.fitScale < 1 ? ` · %${Math.round(next.fitScale * 100)} boyut` : ""}`);
    state.menu?.setStatus("");
  } catch (err) {
    hud("Model yuklenemedi: " + err.message, 4000);
    state.menu?.setStatus("Yuklenemedi: " + err.message);
  } finally {
    state.loading = false;
    state.menu?.invalidate();
  }
}

// --- fizik ------------------------------------------------------------------

const _m4 = new THREE.Matrix4();
const _m4b = new THREE.Matrix4();
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q = new THREE.Quaternion();

/**
 * Her parca icin bir kutu govde kurar. Govde parcanin kendi sinir kutusunun
 * ortasinda ve parcayla ayni yonde durur; kutle merkezi de orasi olur (parca
 * orijini geometrinin disinda olabiliyor, oraya koyunca model sallaniyordu).
 * Parca <-> govde arasindaki sabit ofset "centre" ile tutulur; boylece fizik
 * acilinca parcalar yerinden sicramaz.
 */
function buildBodies() {
  const m = state.model;
  if (!m || m.bodies.length) return;
  m.holder.updateMatrixWorld(true);

  for (const part of m.parts) {
    if (!part.geometry) continue;
    if (!part.geometry.boundingBox) part.geometry.computeBoundingBox();
    const local = part.geometry.boundingBox;
    const ws = part.getWorldScale(new THREE.Vector3());
    const size = local.getSize(new THREE.Vector3()).multiply(ws);
    const centre = local.getCenter(new THREE.Vector3()).multiply(ws);
    if (size.x <= 0 || size.y <= 0 || size.z <= 0) continue;

    // Ince parcalar (cita, kagit) icin en az 4 mm kalinlik: yoksa zeminden gecer.
    const half = new CANNON.Vec3(
      Math.max(size.x, 0.004) / 2, Math.max(size.y, 0.004) / 2, Math.max(size.z, 0.004) / 2);
    // Kutle hacimden: 5 gramlik cita ile 100 gramlik govde dogru oranda
    // davransin diye plastige yakin bir yogunluk.
    const mass = Math.max(size.x * size.y * size.z * 400, 0.01);

    const body = new CANNON.Body({ mass, shape: new CANNON.Box(half) });
    part.getWorldQuaternion(_q);
    part.getWorldPosition(_v).add(_v2.copy(centre).applyQuaternion(_q));
    body.position.set(_v.x, _v.y, _v.z);
    body.quaternion.set(_q.x, _q.y, _q.z, _q.w);
    body.sleepSpeedLimit = 0.08;
    body.linearDamping = 0.02;
    body.angularDamping = 0.05;
    state.world.addBody(body);
    m.bodies.push({ body, part, scale: ws, centre });
  }
}

function removeBodies(m = state.model) {
  if (!m) return;
  for (const { body } of m.bodies) state.world.removeBody(body);
  m.bodies = [];
}

/** Govdelerin konumunu parcalara yazar (parca orijini = govde - donuk ofset). */
function syncPartsFromBodies() {
  const m = state.model;
  for (const { body, part, scale, centre } of m.bodies) {
    _q.set(body.quaternion.x, body.quaternion.y, body.quaternion.z, body.quaternion.w);
    _v.set(body.position.x, body.position.y, body.position.z)
      .sub(_v2.copy(centre).applyQuaternion(_q));
    _m4.compose(_v, _q, scale);
    _m4b.copy(part.parent.matrixWorld).invert();
    _m4.premultiply(_m4b);
    _m4.decompose(part.position, part.quaternion, part.scale);
  }
}

/** Model zeminin altina girmisse yukari kaldirir (fizik acilinca gomulmesin). */
function liftAboveFloor() {
  const m = state.model;
  if (!m) return;
  const box = new THREE.Box3().setFromObject(m.holder);
  if (box.min.y < FLOOR_EPSILON) m.holder.position.y += FLOOR_EPSILON - box.min.y;
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
  state.menu?.invalidate();
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
    liftAboveFloor();
    removeBodies();
    buildBodies();
  }
  hud(m.physics ? "Fizik acik" : "Fizik kapali");
  state.menu?.invalidate();
}

/** Olcegi ayarlar; mevcut fizik govdeleri eski boyutta kaldigi icin yenilenir. */
function setScale(s) {
  const m = state.model;
  if (!m) return;
  m.holder.scale.setScalar(Math.min(10, Math.max(0.01, s)));
  if (m.bodies.length) removeBodies();
  state.menu?.invalidate();
}

/**
 * Modeli kullanicinin onune, goz hizasinin biraz altina getirir; dik durur,
 * yuzu kullaniciya doner. Fizikle dagilmis parcalar toparlanir.
 */
function bringToFront() {
  const m = state.model;
  if (!m) return;
  releaseAll();
  removeBodies();
  m.physics = false;
  for (const p of m.parts) {
    const h = p.userData.home;
    if (!h) continue;
    p.position.copy(h.p);
    p.quaternion.copy(h.q);
    p.scale.copy(h.s);
  }

  const cam = state.renderer.xr.getCamera();
  cam.getWorldPosition(_v);
  cam.getWorldDirection(_v2);
  _v2.y = 0;
  if (_v2.lengthSq() < 1e-4) _v2.set(0, 0, -1);
  _v2.normalize();

  m.holder.rotation.set(0, Math.atan2(-_v2.x, -_v2.z), 0);
  m.holder.position.set(_v.x + _v2.x * 0.6, 0, _v.z + _v2.z * 0.6);
  m.holder.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(m.holder);
  const height = box.max.y - box.min.y;
  const bottom = Math.max(_v.y - 0.3 - height / 2, 0.02);
  m.holder.position.y = bottom - box.min.y;
  state.menu?.invalidate();
}

// --- girisler (kumanda + el) ------------------------------------------------

/**
 * Her giris kaynagi icin bir kayit. three.js kumanda i ile el i'yi ayni
 * XRInputSource'a baglar; kaynak el mi kumanda mi "connected" olayinda belli olur.
 */
function setUpInputs() {
  const rayGeo = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1),
  ]);

  for (let i = 0; i < 2; i++) {
    const controller = state.renderer.xr.getController(i);
    const grip = state.renderer.xr.getControllerGrip(i);
    const hand = state.renderer.xr.getHand(i);
    const ray = new THREE.Line(rayGeo,
      new THREE.LineBasicMaterial({ color: 0x6ea8fe, transparent: true, opacity: 0.6 }));
    ray.scale.z = 3;
    controller.add(ray);
    state.scene.add(controller, grip, hand);

    // Elde tutma noktasi: basparmak ile isaret parmaginin ortasi, bilegin yonu.
    const pinchAnchor = new THREE.Object3D();
    state.scene.add(pinchAnchor);

    const handModel = handFactory.createHandModel(hand, "mesh");
    handModel.visible = false;
    hand.add(handModel);

    const input = {
      i, controller, grip, hand, ray, pinchAnchor,
      source: null, handedness: "", isHand: false,
      handModel, tips: null,
      pinching: false, tracked: false,
      point: new THREE.Vector3(),
      tip: new THREE.Vector3(), prevTip: new THREE.Vector3(), hasPrevTip: false,
      vel: new VelocityTracker(),
      fingerBody: null,
      prev: {},
      pokingMenu: false,
    };

    controller.addEventListener("connected", (e) => {
      input.source = e.data;
      input.handedness = e.data.handedness;
      input.isHand = Boolean(e.data.hand);
      input.pinching = false;
      input.prev = {};
      input.vel.clear();
      ray.visible = !input.isHand;
      applyHandStyle(input);
    });
    controller.addEventListener("disconnected", () => {
      releaseInput(input);
      input.source = null;
      input.isHand = false;
      input.handedness = "";
      removeFingerBody(input);
    });
    controller.addEventListener("selectstart", () => onSelect(input));

    state.inputs.push(input);
  }
}

function applyHandStyle(input) {
  input.handModel.visible = input.isHand && settings.handStyle === "mesh";
  if (input.tips) {
    for (const t of input.tips) t.removeFromParent();
    input.tips = null;
  }
  if (!input.isHand || settings.handStyle !== "tips") return;

  // Gercek el passthrough'da zaten gorunuyor; sadece cimdik noktasini
  // gosteren iki kucuk isaret yeterli.
  const geo = new THREE.SphereGeometry(0.006, 12, 8);
  input.tips = [0, 1].map(() => {
    const s = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      color: 0x6ea8fe, transparent: true, opacity: 0.85, depthTest: false,
    }));
    s.renderOrder = 9;
    state.scene.add(s);
    return s;
  });
}

/** Tetik (kumanda) — el takibinde select olayini kendi cimdik mantigimiz karsilar. */
function onSelect(input) {
  if (input.isHand) return;
  const hit = menuRayHit(input);
  if (hit) {
    state.menu.clickAt(hit);
    return;
  }
  placeAtReticle();
}

function menuRayHit(input) {
  if (!state.menu?.visible || isMenuOwner(input)) return null;
  input.controller.getWorldPosition(_v);
  input.controller.getWorldDirection(_v2).negate(); // three'de kumanda -Z'ye bakar
  return state.menu.rayHit(_v, _v2);
}

function isMenuOwner(input) {
  return input.handedness === "right";
}

function nearModel(point) {
  const m = state.model;
  if (!m) return false;
  const box = new THREE.Box3().setFromObject(m.holder).expandByScalar(GRAB_MARGIN);
  return box.containsPoint(point);
}

const _tipA = new THREE.Vector3();
const _tipB = new THREE.Vector3();
const _headPos = new THREE.Vector3();
const _normal = new THREE.Vector3();
const _centre = new THREE.Vector3();

/** El kaynagini gunceller: cimdik, tutma noktasi, parmak ucu, menu. */
function updateHand(input, time) {
  const hand = input.hand;
  const thumb = jointWorld(hand, THUMB_TIP, _tipA);
  const index = jointWorld(hand, INDEX_TIP, _tipB);
  const wasTracked = input.tracked;
  input.tracked = Boolean(thumb && index);
  if (input.tips) for (const t of input.tips) t.visible = input.tracked;
  if (!input.tracked) {
    // Kayip kisa surerse tutus devam eder (eski noktada donar); uzarsa
    // birakilir. Yoksa el geri geldiginde model yeni konuma sicriyordu.
    if (wasTracked) input.lostAt = time;
    if (input.pinching && time - input.lostAt > HAND_LOST_RELEASE_MS) {
      input.pinching = false;
      releaseInput(input);
    }
    input.hasPrevTip = false;
    input.pinchFrames = 0;
    return;
  }
  // Izleme yeni dondu: eski hiz ornekleri firlatmayi bozmasin.
  if (!wasTracked) input.vel.clear();

  input.prevTip.copy(input.tip);
  input.tip.copy(index);
  input.point.addVectors(thumb, index).multiplyScalar(0.5);
  input.vel.push(time, input.point);

  const wrist = hand.joints.wrist;
  input.pinchAnchor.position.copy(input.point);
  if (wrist && wrist.visible) wrist.getWorldQuaternion(input.pinchAnchor.quaternion);

  // Menu: menu sahibi olmayan elin isaret parmagi dokunur.
  input.pokingMenu = !isMenuOwner(input) && state.menu.poke(input.i, index);

  const [startDist, endDist] = PINCH_THRESHOLDS[settings.pinch] || PINCH_THRESHOLDS.normal;
  const dist = thumb.distanceTo(index);
  if (input.tips) {
    input.tips[0].position.copy(thumb);
    input.tips[1].position.copy(index);
    const color = input.pinching ? 0x3ddc97 : 0x6ea8fe;
    for (const t of input.tips) t.material.color.setHex(color);
  }

  input.pinchFrames = dist < startDist && !input.pokingMenu ? (input.pinchFrames || 0) + 1 : 0;
  if (!input.pinching && input.pinchFrames >= PINCH_CONFIRM_FRAMES) {
    input.pinching = true;
    onPinchStart(input);
  } else if (input.pinching && dist > endDist) {
    input.pinching = false;
    releaseInput(input);
  }

  updateFingerBody(input, time);
  input.hasPrevTip = true;
}

function onPinchStart(input) {
  const near = nearModel(input.point);
  if (near) {
    grabWith(input);
  } else if (!state.grab) {
    placeAtReticle();
  }
  // Model bir eldeyken diger elin uzaktaki cimdigi yok sayilir: eskiden
  // iki elle olceklemeyi baslatip modeli bir anda buyutuyordu.
}

/** Sag avuc kullaniciya donunce menu acilir, avucun ustunde durur. */
function updateMenuPlacement() {
  const menu = state.menu;
  const owner = state.inputs.find((inp) => isMenuOwner(inp) && inp.source);
  const cam = state.renderer.xr.getCamera();
  cam.getWorldPosition(_headPos);

  if (!owner) {
    menu.setVisible(false);
    return;
  }

  if (owner.isHand) {
    const normal = owner.tracked && palmNormal(owner.hand, "right", _normal);
    const centre = normal && palmCentre(owner.hand, _centre);
    if (!normal || !centre) {
      menu.setVisible(false);
      return;
    }
    const facing = normal.dot(_v.subVectors(_headPos, centre).normalize());
    const someonePoking = state.inputs.some((inp) => inp.pokingMenu);
    // Avuc yuze donukse ya da yukari bakiyorsa acilir. Acma/kapama esikleri
    // farkli: sinirda titreyip yanip sonmesin.
    const open = facing > 0.4 || normal.y > 0.75;
    const closed = facing < 0.1 && normal.y < 0.5;
    if (open) menu.setVisible(true);
    else if (closed && !someonePoking) menu.setVisible(false);
    if (DEBUG) state.debugText = `avuc→yuz ${facing.toFixed(2)} yukari ${normal.y.toFixed(2)}`;
    if (!menu.visible) return;
    // Paneli avucun ustune kaldir ve yuzunu kullaniciya cevir. Dokunurken
    // yerinde tutuluyor, yoksa parmak iterken panel kacar.
    if (!someonePoking) {
      menu.group.position.copy(centre).addScaledVector(normal, 0.03);
      menu.group.position.y += 0.19;
      menu.group.lookAt(_headPos);
    }
  } else {
    // Kumanda: sag cubuga basinca ac/kapa; panel kumandanin ustunde durur.
    if (!menu.visible) return;
    owner.grip.getWorldPosition(_centre);
    menu.group.position.copy(_centre);
    menu.group.position.y += 0.2;
    menu.group.lookAt(_headPos);
  }
}

/** Kumanda dugmeleri ve cubugu. */
function updateController(input, dt, time) {
  const gp = input.source && input.source.gamepad;
  input.grip.getWorldPosition(input.point);
  input.vel.push(time, input.point);
  input.tracked = true;

  // Menu hover: kumanda isi paneli gosteriyorsa
  const hit = menuRayHit(input);
  if (hit) state.menu.hoverAt(hit);
  else if (!isMenuOwner(input) && state.menu.visible && !state.inputs.some((i) => i.pokingMenu)) {
    state.menu.hoverAt(null);
  }

  if (!gp) return;
  const m = state.model;
  const buttons = gp.buttons || [];
  const axes = gp.axes || [];
  // Quest kumandasinda cubuk 2-3, A/X dugmesi 4, B/Y dugmesi 5,
  // cubuk tiklama 3, kavrama 1, tetik 0 indeksindedir.
  const stickX = Math.abs(axes[2] || 0) > DEADZONE ? axes[2] : 0;
  const stickY = Math.abs(axes[3] || 0) > DEADZONE ? axes[3] : 0;
  const a = buttons[4] && buttons[4].pressed;
  const b = buttons[5] && buttons[5].pressed;
  const grip = buttons[1] && buttons[1].pressed;
  const stickClick = buttons[3] && buttons[3].pressed;
  const prev = input.prev;

  if (input.handedness === "right") {
    if (stickClick && !prev.stickClick) {
      state.menu.setVisible(!state.menu.visible);
      if (state.menu.visible) hud("Menu: sol kumandanin isi + tetik");
    }
    if (m) {
      if (a && !prev.a) toggleView();
      if (b) {
        // B basiliyken cubuk seffaflik ayarina doner.
        if (stickX) setOpacity(m.opacity + stickX * OPACITY_SPEED * dt);
      } else {
        if (stickX) m.holder.rotateY(-stickX * ROTATE_SPEED * dt);
        if (stickY) setScale(m.holder.scale.x * (1 - stickY * SCALE_SPEED * dt));
      }
    }
  } else if (input.handedness === "left") {
    if (a && !prev.a) togglePhysics();
  }

  // Kavrama: model kumandaya baglanir, birakinca sahneye geri doner.
  if (grip && !prev.grip) grabWith(input);
  if (!grip && prev.grip) releaseInput(input);

  prev.a = a;
  prev.grip = grip;
  prev.stickClick = stickClick;
}

// --- tutma, iki elle olcekleme, firlatma ------------------------------------

function anchorOf(input) {
  return input.isHand ? input.pinchAnchor : input.grip;
}

function grabWith(input) {
  const m = state.model;
  if (!m) return;
  if (state.grab && state.grab.input !== input && !state.twoHand) {
    startTwoHand(state.grab.input, input);
    return;
  }
  if (state.grab) return;

  state.grab = { input, wasPhysics: m.physics };
  // Tutulurken fizik duraklar; birakinca govdeler yeni yerden kurulur.
  m.physics = false;
  anchorOf(input).attach(m.holder);
  hud("Tutuluyor", 900);
}

function startTwoHand(a, b) {
  const m = state.model;
  state.scene.attach(m.holder);
  const mid = new THREE.Vector3().addVectors(a.point, b.point).multiplyScalar(0.5);
  state.twoHand = {
    a, b,
    d0: Math.max(a.point.distanceTo(b.point), TWO_HAND_MIN_SPAN),
    angle0: yaw(a.point, b.point),
    scale0: m.holder.scale.x,
    quat0: m.holder.quaternion.clone(),
    offset0: m.holder.position.clone().sub(mid),
  };
  hud("Iki elle: ac/kapa = boyut, cevir = dondur", 1500);
}

function yaw(a, b) {
  return Math.atan2(b.x - a.x, b.z - a.z);
}

const _mid = new THREE.Vector3();
const _dq = new THREE.Quaternion();
const _up = new THREE.Vector3(0, 1, 0);

function updateTwoHand() {
  const t = state.twoHand;
  const m = state.model;
  if (!t || !m) return;
  // Ellerden biri o karede izlenmiyorsa noktasi eskidir: model yerinde kalir.
  if (!t.a.tracked || !t.b.tracked) return;
  _mid.addVectors(t.a.point, t.b.point).multiplyScalar(0.5);
  const span = Math.max(t.a.point.distanceTo(t.b.point), TWO_HAND_MIN_SPAN);
  const target = Math.min(10, Math.max(0.01, t.scale0 * span / t.d0));
  const cur = m.holder.scale.x;
  const s = Math.min(cur * TWO_HAND_MAX_STEP, Math.max(cur / TWO_HAND_MAX_STEP, target));
  const k = s / t.scale0;
  _dq.setFromAxisAngle(_up, yaw(t.a.point, t.b.point) - t.angle0);

  m.holder.scale.setScalar(s);
  m.holder.quaternion.copy(_dq).multiply(t.quat0);
  m.holder.position.copy(t.offset0).applyQuaternion(_dq).multiplyScalar(k).add(_mid);
  state.menu?.invalidate();
}

function releaseInput(input) {
  const m = state.model;
  if (!m) return;

  if (state.twoHand && (state.twoHand.a === input || state.twoHand.b === input)) {
    // Bir el birakti: digeri tutmaya devam eder.
    const other = state.twoHand.a === input ? state.twoHand.b : state.twoHand.a;
    state.twoHand = null;
    if (m.bodies.length) removeBodies();
    const stillHolding = other.isHand ? other.pinching : Boolean(other.prev.grip);
    if (stillHolding) {
      state.grab.input = other;
      anchorOf(other).attach(m.holder);
    } else {
      dropHeld(input);
    }
    return;
  }

  if (state.grab && state.grab.input === input) dropHeld(input);
}

/** Tutulan modeli birakir; fizik aciksa el hiziyla firlatir. */
function dropHeld(input) {
  const m = state.model;
  const grab = state.grab;
  state.grab = null;
  state.scene.attach(m.holder);
  m.physics = grab.wasPhysics;
  removeBodies();
  if (!m.physics) return;

  liftAboveFloor();
  buildBodies();
  if (settings.throw) {
    const v = input.vel.velocity(_v);
    const speed = v.length();
    // Yavas birakis firlatma sayilmaz: model avuctan "dusurulur".
    if (speed > 0.35) {
      v.multiplyScalar(Math.min(1, THROW_MAX_SPEED / speed));
      for (const { body } of m.bodies) {
        body.velocity.set(v.x, v.y, v.z);
        body.wakeUp();
      }
      hud("Firlatildi", 800);
    }
  }
}

function releaseAll() {
  const m = state.model;
  state.twoHand = null;
  if (state.grab && m) {
    state.scene.attach(m.holder);
    m.physics = state.grab.wasPhysics;
    removeBodies();
  }
  state.grab = null;
}

// --- parmakla itme ----------------------------------------------------------

/**
 * Isaret parmagi ucu kinematik bir kure: fizik acik modele dokununca iter.
 * Hizini her karede parmak hareketinden veriyoruz; cannon kinematik govdenin
 * carpisma tepkisini bu hizdan hesapliyor.
 */
function updateFingerBody(input, time) {
  const m = state.model;
  const active = settings.push && m && m.physics && !state.grab && !input.pinching;
  if (!active) {
    removeFingerBody(input);
    return;
  }
  if (!input.fingerBody) {
    input.fingerBody = new CANNON.Body({
      type: CANNON.Body.KINEMATIC,
      shape: new CANNON.Sphere(FINGER_RADIUS),
    });
    input.fingerBody.position.set(input.tip.x, input.tip.y, input.tip.z);
    state.world.addBody(input.fingerBody);
    input.lastTipTime = time;
    return;
  }
  const dt = (time - input.lastTipTime) / 1000;
  input.lastTipTime = time;
  const body = input.fingerBody;
  if (input.hasPrevTip && dt > 0) {
    body.velocity.set(
      (input.tip.x - input.prevTip.x) / dt,
      (input.tip.y - input.prevTip.y) / dt,
      (input.tip.z - input.prevTip.z) / dt);
  } else {
    body.velocity.setZero();
  }
  body.position.set(input.tip.x, input.tip.y, input.tip.z);
}

function removeFingerBody(input) {
  if (!input.fingerBody) return;
  state.world.removeBody(input.fingerBody);
  input.fingerBody = null;
}

function removeFingerBodies() {
  for (const input of state.inputs) removeFingerBody(input);
}

// --- yerlestirme ------------------------------------------------------------

function placeAtReticle() {
  const m = state.model;
  if (!m || !state.reticle.visible) {
    hud("Once bir yuzeye bak");
    return;
  }
  releaseAll();
  const p = new THREE.Vector3().setFromMatrixPosition(state.reticle.matrix);
  m.holder.position.copy(p);
  removeBodies();
  hud("Yerlestirildi", 900);
}

// --- oda yuzeyleri (masa, zemin, duvar) --------------------------------------

const _pm = new THREE.Matrix4();
const _pp = new THREE.Vector3();
const _pq = new THREE.Quaternion();
const _ps = new THREE.Vector3();

/**
 * Quest 3'un oda taramasindaki duzlemleri fizige sabit kutu olarak ekler;
 * boylece fizik acikken model masanin ustunde durur, duvara carpar.
 *
 * WebXR'da her duzlemin kendi uzayinda +Y normaldir ve cokgen y=0'dadir.
 * Kutu cokgenin sinir dikdortgeni kadar genis ve yuzeyin arkasinda
 * (-Y yonunde) SURFACE_THICKNESS kalinliginda.
 */
function updateSurfaces(frame, time) {
  const planes = frame.detectedPlanes;
  if (!planes) return;
  const refSpace = state.renderer.xr.getReferenceSpace();

  for (const plane of planes) {
    const known = state.surfaces.get(plane);
    if (known && known.changed === plane.lastChangedTime) continue;
    const pose = frame.getPose(plane.planeSpace, refSpace);
    if (!pose) continue;
    if (known) state.world.removeBody(known.body);

    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const pt of plane.polygon) {
      minX = Math.min(minX, pt.x); maxX = Math.max(maxX, pt.x);
      minZ = Math.min(minZ, pt.z); maxZ = Math.max(maxZ, pt.z);
    }
    if (!(maxX > minX && maxZ > minZ)) continue;

    _pm.fromArray(pose.transform.matrix);
    _pm.decompose(_pp, _pq, _ps);
    _ps.set((minX + maxX) / 2, -SURFACE_THICKNESS / 2, (minZ + maxZ) / 2).applyMatrix4(_pm);

    const body = new CANNON.Body({
      type: CANNON.Body.STATIC,
      shape: new CANNON.Box(new CANNON.Vec3(
        (maxX - minX) / 2, SURFACE_THICKNESS / 2, (maxZ - minZ) / 2)),
    });
    body.position.set(_ps.x, _ps.y, _ps.z);
    body.quaternion.set(_pq.x, _pq.y, _pq.z, _pq.w);
    state.world.addBody(body);
    state.surfaces.set(plane, { body, changed: plane.lastChangedTime });
  }

  for (const [plane, { body }] of state.surfaces) {
    if (!planes.has(plane)) {
      state.world.removeBody(body);
      state.surfaces.delete(plane);
    }
  }

  // Masa/duvar yoksa model hep yere duser; kullaniciya sebebini soyle.
  if (!state.surfaceHintShown && time - state.sessionStart > 6000) {
    state.surfaceHintShown = true;
    if (state.surfaces.size === 0) {
      hud("Oda taramasi yok: Quest Ayarlar > Fiziksel alan > Alan kurulumu", 7000);
    }
  }
}

// --- menu baglantisi --------------------------------------------------------

function buildMenu() {
  const menu = new WristMenu({
    model: () => {
      const m = state.model;
      if (!m) return null;
      return {
        name: m.entry.name.replace(/\.(glb|gltf|3mf)$/i, ""),
        realistic: m.realistic, opacity: m.opacity,
        scale: m.holder.scale.x, physics: m.physics,
      };
    },
    catalog: () => state.catalog,
    currentUrl: () => state.model?.entry.url,
    settings: () => settings,
    actions: {
      toggleView,
      opacity: (d) => {
        const m = state.model;
        if (!m) return;
        m.realistic = false;
        setOpacity(m.opacity + d);
      },
      scale: (f) => state.model && setScale(state.model.holder.scale.x * f),
      realSize: () => { setScale(1); hud("Gercek boyut (1:1)"); },
      fit: () => {
        const m = state.model;
        if (!m) return;
        setScale(m.longest > DEFAULT_SIZE ? DEFAULT_SIZE / m.longest : 1);
        hud("35 cm'ye sigdirildi");
      },
      physics: togglePhysics,
      bringFront: bringToFront,
      exit: () => state.session?.end(),
      load: (entry) => switchModel(entry),
      refresh: async () => {
        menu.setStatus("Liste yenileniyor…");
        await loadCatalog();
        menu.setStatus("");
      },
      setSetting,
    },
  });
  state.scene.add(menu.group);
  state.menu = menu;
}

// --- oturum -----------------------------------------------------------------

async function enterAR() {
  const entry = state.selected;
  if (!entry) return;

  el.enter.disabled = true;
  el.hint.textContent = "Model yukleniyor…";

  let model;
  try {
    buildScene();
    buildWorld();
    model = await spawnModel(entry);
  } catch (err) {
    el.hint.textContent = "Model yuklenemedi: " + err.message;
    el.enter.disabled = false;
    return;
  }

  let session;
  try {
    session = await navigator.xr.requestSession("immersive-ar", {
      requiredFeatures: ["local-floor"],
      optionalFeatures: ["hit-test", "anchors", "plane-detection", "hand-tracking", "dom-overlay"],
      domOverlay: { root: document.getElementById("hud") },
    });
  } catch (err) {
    el.hint.textContent = "Passthrough baslatilamadi: " + err.message;
    el.enter.disabled = false;
    return;
  }

  state.session = session;
  state.inputs = [];
  state.surfaces = new Map();
  state.surfaceHintShown = false;
  state.sessionStart = 0;
  state.grab = null;
  state.twoHand = null;
  state.renderer.domElement.style.display = "";
  await state.renderer.xr.setSession(session);

  state.model = model;
  state.scene.add(model.holder);
  setOpacity(GHOST_OPACITY);
  state.needsPlacement = true;

  buildMenu();
  setUpInputs();

  try {
    state.viewerSpace = await session.requestReferenceSpace("viewer");
    state.hitTestSource = await session.requestHitTestSource({ space: state.viewerSpace });
  } catch {
    state.hitTestSource = null; // hit-test yoksa "onume getir" ile calisilir
  }

  session.addEventListener("end", onSessionEnd);
  state.lastTime = 0;
  state.renderer.setAnimationLoop(onFrame);
}

function onSessionEnd() {
  state.renderer.setAnimationLoop(null);
  state.renderer.domElement.style.display = "none";
  disposeModel(state.model);
  state.model = null;
  state.session = null;
  state.hitTestSource = null;
  state.menu = null;
  state.toast = null;
  el.enter.disabled = false;
  el.hint.textContent = "Oturum kapandi. Tekrar girebilirsin.";
  loadCatalog();
}

function onFrame(time, frame) {
  const dt = state.lastTime ? Math.min((time - state.lastTime) / 1000, 0.05) : 0;
  state.lastTime = time;

  if (state.needsPlacement && state.model) {
    state.needsPlacement = false;
    bringToFront();
    const m = state.model;
    hud(m.fitScale < 1
      ? `%${Math.round(m.fitScale * 100)} boyutta acildi · menu: sag avuc`
      : "Cimdik: yerlestir · menu: sag avucunu cevir", 4000);
  }

  if (frame) {
    if (!state.sessionStart) state.sessionStart = time;
    updateSurfaces(frame, time);
  }

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

  for (const input of state.inputs) {
    if (!input.source) continue;
    if (input.isHand) updateHand(input, time);
    else updateController(input, dt, time);
  }
  if (state.twoHand) updateTwoHand();
  updateMenuPlacement();
  state.menu.update();
  if (DEBUG && time - (state.lastDebug || 0) > 400) {
    state.lastDebug = time;
    const hands = state.inputs.filter((i) => i.source)
      .map((i) => `${i.handedness[0] || "?"}:${i.isHand ? (i.tracked ? "el" : "el-yok") : "kum"}`).join(" ");
    showToast(`${hands} · yuzey ${state.surfaces.size} · ${state.debugText}`, 1000);
  }

  const m = state.model;
  if (m && m.physics && dt > 0) {
    if (!m.bodies.length) {
      liftAboveFloor();
      buildBodies();
    }
    state.world.step(1 / 90, dt, 3);
    syncPartsFromBodies();
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
