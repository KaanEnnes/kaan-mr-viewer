/**
 * Kaan MR Viewer - Quest 3 passthrough model goruntuleyici.
 *
 * Tarayicida calisir: kurulum, sideload ve developer mode gerektirmez.
 * Gozlukte siteyi ac, "Passthrough'a gir" de, model gercek odanda belirir.
 */
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { ThreeMFLoader } from "three/addons/loaders/3MFLoader.js";
import { STLLoader } from "three/addons/loaders/STLLoader.js";
import { OBJLoader } from "three/addons/loaders/OBJLoader.js";
import { GLTFExporter } from "three/addons/exporters/GLTFExporter.js";
import { unzipSync, strFromU8 } from "three/addons/libs/fflate.module.js";
import { XRHandModelFactory } from "three/addons/webxr/XRHandModelFactory.js";
import * as CANNON from "https://cdn.jsdelivr.net/npm/cannon-es@0.20.0/dist/cannon-es.js";
import {
  INDEX_TIP, THUMB_TIP, jointWorld, palmNormal, VelocityTracker, HandOccluder,
} from "./hands.js";
import { WristMenu, MENU_WIDTH } from "./menu.js";
import { splitDisconnected } from "./split.js";
import { parse3mf, MF_UNITS } from "./threemf.js";
import { SoftOcclusion } from "./occlusion.js";
import { initDesktop } from "./desktop.js";
import { Label, ShadowCatcher, Ruler, TechDetail, Section, SECTION_MODES, WristButton } from "./tools.js";

// --- sabitler ---------------------------------------------------------------

const GHOST_OPACITY = 0.45;
// Teknik detayda secili olmayan parcalar bu kadar saydam: secilen one cikar,
// digerleri yerini belli edecek kadar gorunur.
const ISOLATE_OPACITY = 0.08;
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
// Parcalari ayirinca her parca merkezden uzakligi orani kadar daha acilir.
const EXPLODE_FACTOR = 0.9;
// Bu kadar yakin (gercek boyutta) parcalar birbirine bagli sayilir: print-in-place
// tasarimlarda hareketli parcalar arasinda ~0.3-0.5 mm baski boslugu olur.
const JOINT_GAP = 0.0015;        // metre
// Bundan cok parcali modeller (or. 94 parcali motor) fizikte tek sert govde:
// her parcaya govde + mentese gozlugu bogar, parcalar zaten birbirine gecmis.
const MAX_PHYSICS_PARTS = 40;
// Otomatik kabuk ayirma yalnizca bu kadar az mesh'li modellerde: cok parcali
// modeller zaten parcali, bolunurse vida/somun gibi yuzlerce parca cikiyor.
const SPLIT_MAX_MESHES = 3;
const EXPLODE_SPEED = 3;         // saniyede tamamlanan oran
// Kalici konumlar: model adresi -> { uuid, scale }
const ANCHOR_STORAGE = "kaan-mr-viewer.anchors";
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
  surfaces: new Map(),  // XRPlane/XRMesh -> { body, changed }
  patches: [],          // hit-test'ten ogrenilen yuzey yamalari
  surfaceHintShown: false,
  debugText: "",
  models: [],         // sahnedeki tum modeller; state.model secili olan
  shadow: null,
  ruler: null,
  rulerInput: null,
  section: null,
  sectionMode: "off",
  sectionT: 0.5,
  dimsLabel: null,
  wristButton: null,
  anchorRequest: null,
  menuOpen: false,
  lastTime: 0,
};

const handFactory = new XRHandModelFactory();

// PC goruntuleyicisi (desktop.js); baslangicta kurulur.
let desktop = null;

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
      (m.cloud ? `<span class="badge cloud">${m.format === "gltf" ? "GLB" : m.format.toUpperCase()}</span>` : "") +
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
  showModel(entry);
}

/**
 * Zip'ten modeli cikarir. Sketchfab / Thingiverse paketlerinde model bir
 * klasorde, dokulari yaninda olur. GLB kendi icinde her seyi tasir; ayri
 * dosyali glTF ise dokulariyla yuklenip tek GLB'ye paketlenir (buluta tek
 * dosya gider, gozluk de tek dosya indirir).
 */
async function modelFromZip(zipFile) {
  const files = unzipSync(new Uint8Array(await zipFile.arrayBuffer()));
  const names = Object.keys(files).filter((n) => !n.startsWith("__MACOSX/") && files[n].length);
  const base = zipFile.name.replace(/\.zip$/i, "");
  const largest = (re) => names.filter((n) => re.test(n)).sort((a, b) => files[b].length - files[a].length)[0];

  const glb = largest(/\.glb$/i);
  if (glb) return new File([files[glb]], `${base}.glb`, { type: "model/gltf-binary" });

  const gltf = largest(/\.gltf$/i);
  if (gltf) return new File([await packGltf(files, gltf)], `${base}.glb`, { type: "model/gltf-binary" });

  for (const ext of MODEL_EXTS) {
    const n = largest(new RegExp(`\\.${ext}$`, "i"));
    if (n) return new File([files[n]], `${base}.${ext}`);
  }
  throw new Error("zip icinde model (glb, gltf, 3mf, stl, obj) yok");
}

async function packGltf(files, gltfPath) {
  const dir = gltfPath.includes("/") ? gltfPath.slice(0, gltfPath.lastIndexOf("/") + 1) : "";
  const urls = new Map();
  const blobUrl = (path) => {
    if (!files[path]) return null;
    if (!urls.has(path)) urls.set(path, URL.createObjectURL(new Blob([files[path]])));
    return urls.get(path);
  };
  const manager = new THREE.LoadingManager();
  manager.setURLModifier((url) => {
    if (/^(data|blob):/.test(url)) return url;
    const rel = decodeURIComponent(url.replace(/^\.\//, ""));
    return blobUrl(dir + rel) || blobUrl(rel) || url;
  });
  try {
    const loaded = await new GLTFLoader(manager).parseAsync(strFromU8(files[gltfPath]), "");
    return await new GLTFExporter().parseAsync(loaded.scene, { binary: true, animations: loaded.animations });
  } finally {
    for (const u of urls.values()) URL.revokeObjectURL(u);
  }
}

el.file.addEventListener("change", async (e) => {
  let file = e.target.files && e.target.files[0];
  e.target.value = ""; // ayni dosya tekrar secilebilsin
  if (!file) return;
  if (/\.zip$/i.test(file.name)) {
    el.hint.textContent = "Zip aciliyor…";
    try {
      file = await modelFromZip(file);
      el.hint.textContent = `Zip'ten cikarildi: ${file.name} (${formatBytes(file.size)})`;
    } catch (err) {
      el.hint.textContent = "Zip acilamadi: " + err.message;
      return;
    }
  }
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
      showModel(state.selected);
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
  showModel(state.selected);
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
const DEFAULT_SETTINGS = {
  throw: true, push: true, handStyle: "tips", pinch: "normal",
  shadow: true, dims: false, ruler: false, tech: false, depth: false, listMode: "replace",
  pinchPlace: true, farGrab: true,
};

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
  if (key === "farGrab") for (const input of state.inputs) showRay(input);
  if (key === "push" && !value) removeFingerBodies();
  // Cetvel ve teknik detay ayni dokunusu kullanir: biri acilinca digeri kapanir.
  if (key === "ruler" && value) settings.tech = false;
  if (key === "tech" && value) settings.ruler = false;
  if (key === "ruler" || key === "tech") {
    state.ruler?.cancel();
    applyIsolation();
  }
  const onOff = value ? "acik" : "kapali";
  const labels = {
    throw: `Firlatma ${onOff}`,
    push: `Parmakla itme ${onOff}`,
    handStyle: "El gorunumu degisti",
    pinch: "Cimdik hassasiyeti degisti",
    shadow: `Golge ${onOff}`,
    dims: `Olculer ${onOff}`,
    ruler: value ? "Cetvel: iki noktaya cimdik / tetik (olcumler yerinde kalir)" : "Cetvel kapali",
    tech: value ? "Teknik detay: olculerini gormek istedigin parcaya dokun" : "Teknik detay kapali",
    pinchPlace: value ? "Cimdik bakilan yere yerlestirir" : "Cimdikle yerlestirme kapali",
    farGrab: value ? "Uzaktan tutma: isin modeldeyken cimdik" : "Uzaktan tutma kapali",
    depth: value ? "Gercek nesne ortme sonraki giriste acilir" : "Ortme sonraki giriste kapanir",
    listMode: value === "add" ? "Listeden secilen model sahneye eklenir" : "Listeden secilen model degistirilir",
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
  state.sun = sun;

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
  renderer.localClippingEnabled = true; // kesit duzlemi
  // Tuval PC goruntuleyicisinde durur (desktop.js); VR'da gozluk kendi
  // katmanina cizer.
  state.renderer = renderer;
}

function buildWorld() {
  const world = new CANNON.World({ gravity: new CANNON.Vec3(0, -9.82, 0) });
  world.solver.iterations = 14;
  world.allowSleep = true;
  // Yuzlerce sabit yuzey yamasi olabiliyor; varsayilan broadphase tum ciftleri
  // dener, SAP eksen boyunca siralayip yalnizca komsulari.
  world.broadphase = new CANNON.SAPBroadphase(world);

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

/**
 * Sahne, fizik dunyasi ve araclar sayfa acilinca bir kez kurulur: PC
 * goruntuleyicisi ve VR ayni sahneyi kullanir, PC'de acilan model VR'a
 * aynen tasinir.
 */
function initScene() {
  buildRenderer();
  buildScene();
  buildWorld();
  state.shadow = new ShadowCatcher(state.scene, state.renderer, state.sun);
  state.ruler = new Ruler(state.scene);
  state.tech = new TechDetail(state.scene);
  state.section = new Section();
  state.dimsLabel = new Label(0.2);
  state.scene.add(state.dimsLabel.mesh);
  state.wristButton = new WristButton(state.scene);
}

let _showToken = 0;

/** Secilen modeli sahneye koyar (PC'de secince hemen, VR'a girerken gerekirse). */
async function showModel(entry) {
  const token = ++_showToken;
  desktop?.loading(entry);
  try {
    const m = await spawnModel(entry);
    if (token !== _showToken) {
      disposeModel(m);
      return null;
    }
    releaseAll();
    for (const old of state.models) disposeModel(old);
    state.models = [m];
    state.model = null;
    state.scene.add(m.holder);
    setActive(m);
    m.realistic = !state.session;
    setOpacity(state.session ? GHOST_OPACITY : 1);
    desktop?.onModel(m);
    return m;
  } catch (err) {
    if (token === _showToken) desktop?.failed(err);
    throw err;
  }
}

/** Oda yuzeylerini (onceki oturumun masa/yama govdeleri) fizikten siler. */
function resetRoomSurfaces() {
  for (const entry of state.surfaces.values()) removeSurface(entry);
  state.surfaces = new Map();
  for (const patch of state.patches) removeSurface(patch);
  state.patches = [];
}

// --- model yukleme ----------------------------------------------------------

const gltfLoader = new GLTFLoader();
const threeMfLoader = new ThreeMFLoader();

const MODEL_EXTS = ["3mf", "stl", "obj"];

function formatOf(name) {
  const ext = (String(name).match(/\.([a-z0-9]+)(?:$|[?#])/i) || [])[1];
  return ext && MODEL_EXTS.includes(ext.toLowerCase()) ? ext.toLowerCase() : "gltf";
}

function loadGltf(url) {
  return new Promise((resolve, reject) => {
    gltfLoader.load(url, (g) => {
      g.scene.animations = g.animations; // spawnModel animasyonu buradan kurar
      resolve(g.scene);
    }, undefined, (e) => reject(e));
  });
}

/**
 * 3MF: once kendi okuyucumuz (Bambu/Creality/Prusa'nin kullandigi Production
 * eklentisi dahil), bulamazsa three.js'in okuyucusu.
 */
async function load3mf(url) {
  const buffer = await (await fetch(url)).arrayBuffer();
  let parsed = null;
  try {
    parsed = parse3mf(buffer);
  } catch {
    parsed = null;
  }
  if (!parsed) parsed = { group: threeMfLoader.parse(buffer), unitScale: MF_UNITS.millimeter };

  // 3MF Z-yukari ve genelde milimetre; sahne Y-yukari ve metre.
  const wrapper = new THREE.Group();
  parsed.group.rotation.x = -Math.PI / 2;
  parsed.group.scale.setScalar(parsed.unitScale);
  wrapper.add(parsed.group);
  wrapper.updateMatrixWorld(true);
  return wrapper;
}

const stlLoader = new STLLoader();
const objLoader = new OBJLoader();

const printMaterial = () => new THREE.MeshStandardMaterial({ color: 0xb4bcc8, roughness: 0.6, metalness: 0 });

/** STL: tek geometri, Z yukari ve (3B baski dunyasinda hep) milimetre. */
async function loadStl(url) {
  const geometry = await stlLoader.loadAsync(url);
  if (!geometry.attributes.normal) geometry.computeVertexNormals();
  const inner = new THREE.Group();
  inner.add(new THREE.Mesh(geometry, printMaterial()));
  inner.rotation.x = -Math.PI / 2;
  inner.scale.setScalar(0.001);
  const root = new THREE.Group();
  root.add(inner);
  root.userData.unitsKnown = true;
  return root;
}

/**
 * OBJ: Y yukari. Tinkercad ve dilimleyiciler milimetre yazar, Blender metre;
 * 5 birimden buyuk nesne milimetre sayilir (5 m'lik obje nadir, 5 mm'lik de).
 */
async function loadObj(url) {
  const obj = await objLoader.loadAsync(url);
  obj.traverse((o) => {
    if (o.isMesh && (!o.material || Array.isArray(o.material) === false && o.material.type === "MeshPhongMaterial" && !o.material.map)) {
      o.material = printMaterial();
    }
  });
  obj.updateMatrixWorld(true);
  const size = new THREE.Box3().setFromObject(obj).getSize(new THREE.Vector3());
  if (Math.max(size.x, size.y, size.z) > 5) obj.scale.setScalar(0.001);
  const root = new THREE.Group();
  root.add(obj);
  root.userData.unitsKnown = true;
  return root;
}

function loadModel(entry) {
  const format = entry.format || formatOf(entry.url);
  if (format === "3mf") return load3mf(entry.url);
  if (format === "stl") return loadStl(entry.url);
  if (format === "obj") return loadObj(entry.url);
  return loadGltf(entry.url);
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

  // Tek mesh'e gomulmus parcalari (Creality vb. donusturuculer) kabuklarina
  // ayir. Pipeline'in PART_ adli parcalari zaten ayri; onlara dokunulmaz.
  let pipelineParts = false;
  let meshCount = 0;
  root.traverse((o) => {
    if (o.name.startsWith("PART_")) pipelineParts = true;
    if (o.isMesh) meshCount++;
  });
  // Animasyon izleri dugum adina bagli: bolunen mesh izini kaybeder.
  const animated = root.animations && root.animations.length > 0;
  if (!pipelineParts && !animated && meshCount <= SPLIT_MAX_MESHES) splitDisconnected(root);

  // Modelin kendi animasyonu (or. patlatilmis gorunum): basta, duraklatilmis.
  let anim = null;
  if (animated) {
    const clip = root.animations.reduce((a, b) => (b.duration > a.duration ? b : a));
    const mixer = new THREE.AnimationMixer(root);
    const action = mixer.clipAction(clip);
    action.setLoop(THREE.LoopOnce, 1);
    action.clampWhenFinished = true;
    action.play();
    action.paused = true;
    mixer.update(0);
    anim = { mixer, action, duration: clip.duration, playing: false };
  }

  // GLB standardi metre ister ama dilimleyiciler cogu zaman milimetre yazar:
  // 21 cm'lik kalemlik 210 m gelir. 20 m'den buyuk model milimetre sayilir.
  // (3MF kendi birimini tasir, load3mf onu zaten uyguladi.)
  if ((entry.format || formatOf(entry.url)) === "gltf" && !root.userData.unitsKnown) {
    root.updateMatrixWorld(true);
    const raw = new THREE.Box3().setFromObject(root).getSize(new THREE.Vector3());
    if (Math.max(raw.x, raw.y, raw.z) > 20) root.scale.multiplyScalar(0.001);
  }

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
  root.updateMatrixWorld(true);
  root.userData.home = { p: root.position.clone(), q: root.quaternion.clone(), s: root.scale.clone() };

  // Modelin kendi (root) eksenindeki kutusu: olcu etiketi ve kesit bununla.
  const rootInv = root.matrixWorld.clone().invert();
  const localBox = new THREE.Box3().setFromObject(root).applyMatrix4(rootInv);
  computeExplodeOffsets(parts, rootInv, localBox.getCenter(new THREE.Vector3()));

  root.traverse((o) => { if (o.isMesh) o.castShadow = true; });

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
      state.occlusion?.patch(c);
      materials.push(c);
      return c;
    };
    o.material = Array.isArray(o.material) ? o.material.map(cloneMat) : cloneMat(o.material);
  });

  return {
    holder, root, parts, materials, fitScale, longest, localBox,
    bodies: [], opacity: 1, realistic: false, physics: false,
    explode: 0, explodeTarget: 0, anim,
    anchor: null, anchorApplied: false, anchorScale: 1,
    entry,
  };
}

/**
 * Her parca icin "ayrilma" ofsetini hesaplar: parcanin merkezinden modelin
 * merkezine olan vektor, parcanin kendi ebeveyn ekseninde. Ic ice gruplar
 * olabildigi icin root ekseninden ebeveyn eksenine cevriliyor.
 */
function computeExplodeOffsets(parts, rootInv, modelCentre) {
  const toRoot = new THREE.Matrix4();
  const m3 = new THREE.Matrix3();
  for (const part of parts) {
    if (!part.geometry) continue;
    if (!part.geometry.boundingBox) part.geometry.computeBoundingBox();
    const c = part.geometry.boundingBox.getCenter(new THREE.Vector3())
      .applyMatrix4(part.matrixWorld).applyMatrix4(rootInv);
    const d = c.sub(modelCentre);
    toRoot.multiplyMatrices(rootInv, part.parent.matrixWorld).invert();
    m3.setFromMatrix4(toRoot);
    part.userData.explode = d.applyMatrix3(m3).multiplyScalar(EXPLODE_FACTOR);
  }
}

function disposeModel(m) {
  if (!m) return;
  state.ruler?.removeFor(m.holder);
  for (const part of m.parts) state.tech?.remove(part);
  if (state.section?.model === m) state.section.detach();
  removeBodies(m);
  m.holder.removeFromParent();
  m.holder.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
  });
  for (const mat of m.materials) mat.dispose();
}

/**
 * Listeden secilen modeli yukler. "Degistir" modunda secili modelin yerine
 * gecer; "Ekle" modunda sahneye ek model olarak onune konur ve secilir.
 */
async function switchModel(entry) {
  if (state.loading) return;
  state.loading = true;
  const adding = settings.listMode === "add" || !state.model;
  hud(`Yukleniyor: ${entry.name}`, 6000);
  state.menu?.setStatus("Yukleniyor…");
  try {
    const next = await spawnModel(entry);
    const old = state.model;
    releaseAll();
    if (adding) {
      state.models.push(next);
      state.scene.add(next.holder);
      setActive(next);
      setOpacity(GHOST_OPACITY);
      bringToFront();
    } else {
      next.holder.position.copy(old.holder.position);
      next.holder.quaternion.copy(old.holder.quaternion);
      state.models[state.models.indexOf(old)] = next;
      state.scene.add(next.holder);
      state.model = null;           // setActive eskisini dondurmaya calismasin
      disposeModel(old);
      setActive(next);
      setOpacity(GHOST_OPACITY);
    }
    restoreAnchor(next);
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

/**
 * Secili modeli degistirir. Fizik, kesit ve tutma yalnizca secili modelde
 * calisir; secimden cikan model oldugu yerde donar.
 */
function setActive(m) {
  const old = state.model;
  if (old === m) return;
  releaseAll();
  if (old) {
    removeBodies(old);
    old.physics = false;
  }
  state.model = m;
  applySection();
  state.menu?.invalidate();
}

/** Noktaya (tutma margini dahil) en yakin modeli bulur; secili olan onceliklidir. */
function modelAt(point) {
  const box = new THREE.Box3();
  const order = state.model ? [state.model, ...state.models.filter((x) => x !== state.model)] : state.models;
  for (const m of order) {
    box.setFromObject(m.holder).expandByScalar(GRAB_MARGIN);
    if (box.containsPoint(point)) return m;
  }
  return null;
}

function removeActiveModel() {
  const m = state.model;
  if (!m) return;
  if (state.models.length <= 1) {
    hud("Sahnede tek model var; degistirmek icin Liste'yi kullan");
    return;
  }
  releaseAll();
  state.models.splice(state.models.indexOf(m), 1);
  state.model = null;
  disposeModel(m);
  setActive(state.models[state.models.length - 1]);
  hud("Model kaldirildi");
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

  // Cok parcali modelde tek govde: "parca" modelin kendisi (root), kutusu localBox.
  const targets = m.parts.length > MAX_PHYSICS_PARTS
    ? [{ part: m.root, local: m.localBox }]
    : m.parts.filter((p) => p.geometry).map((p) => {
      if (!p.geometry.boundingBox) p.geometry.computeBoundingBox();
      return { part: p, local: p.geometry.boundingBox };
    });

  for (const { part, local } of targets) {
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

    // Grup 2: golge isini (maske 1) model govdelerini gormez, sadece yuzeyleri.
    const body = new CANNON.Body({ mass, shape: new CANNON.Box(half), collisionFilterGroup: 2 });
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
  connectParts(m);
}

/**
 * Birbirine degen parcalari mentese gibi baglar. Temas bolgesi (iki parcanin
 * genisletilmis kutularinin kesisimi) bulunur; bolgenin en uzun yonu mentese
 * ekseni olur ve o eksen uzerindeki iki noktadan noktasal baglanti kurulur:
 * iki noktali baglanti o cizgi etrafinda donmeye izin verir, ayrilmaya degil.
 * Bagli parcalar arasinda carpisma kapali: kutu yaklasiminda ic ice gecerler
 * ve carpisma acik kalirsa birbirlerini iterek firlatirlar.
 */
function connectParts(m) {
  m.constraints = [];
  const n = m.bodies.length;
  if (n < 2) return;
  const tol = Math.max(JOINT_GAP * m.holder.scale.x, 1e-4);
  const boxes = m.bodies.map(({ part }) => new THREE.Box3().setFromObject(part).expandByScalar(tol));
  const inter = new THREE.Box3();
  const size = new THREE.Vector3();
  const centre = new THREE.Vector3();
  const pivot = new THREE.Vector3();
  const world = new CANNON.Vec3();

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (!boxes[i].intersectsBox(boxes[j])) continue;
      inter.copy(boxes[i]).intersect(boxes[j]);
      inter.getSize(size);
      inter.getCenter(centre);
      const axis = size.x >= size.y && size.x >= size.z ? "x" : size.y >= size.z ? "y" : "z";
      const reach = size[axis] * 0.4;
      const A = m.bodies[i].body;
      const B = m.bodies[j].body;
      for (const sign of [-1, 1]) {
        pivot.copy(centre);
        pivot[axis] += sign * reach;
        world.set(pivot.x, pivot.y, pivot.z);
        const joint = new CANNON.PointToPointConstraint(
          A, A.pointToLocalFrame(world), B, B.pointToLocalFrame(world));
        joint.collideConnected = false;
        state.world.addConstraint(joint);
        m.constraints.push(joint);
      }
    }
  }
}

function removeBodies(m = state.model) {
  if (!m) return;
  for (const joint of m.constraints || []) state.world.removeConstraint(joint);
  m.constraints = [];
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
  const see = m.opacity < 0.999;
  for (const mat of m.materials) {
    // Yumusak ortme alfa ile calisir: acikken opak model de karistirilir.
    mat.transparent = see || Boolean(state.occlusion);
    mat.opacity = m.opacity;
    // Yari saydam yuzeyler derinlige yazmamali, yoksa passthrough uzerinde
    // kendi arkasini kesip yanlis siralanir.
    mat.depthWrite = !see;
    mat.needsUpdate = true;
  }
  applyIsolation();
  state.menu?.invalidate();
}

/**
 * Teknik detayda parca secildiyse o modelin diger parcalarini cok saydam
 * yapar; secim yoksa ya da teknik detay kapaliysa modelin kendi saydamligina
 * dondurur.
 */
function applyIsolation() {
  const selected = state.tech ? state.tech.items : new Map();
  for (const m of state.models) {
    const isolating = settings.tech && m.parts.some((p) => selected.has(p));
    for (const part of m.parts) {
      const faded = isolating && !selected.has(part);
      const mats = Array.isArray(part.material) ? part.material : [part.material];
      for (const mat of mats) {
        if (!mat) continue;
        const see = m.opacity < 0.999;
        mat.opacity = faded ? ISOLATE_OPACITY : m.opacity;
        mat.transparent = faded || see || Boolean(state.occlusion);
        mat.depthWrite = !faded && !see;
        mat.needsUpdate = true;
      }
      part.castShadow = !faded;
    }
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
    if (m.explode > 0) setExplode(m, 0, true);
    liftAboveFloor();
    removeBodies();
    buildBodies();
  }
  if (m.physics) {
    const { total, furniture, patches, roomMesh } = surfaceCounts();
    hud(`Fizik acik · ${roomMesh ? "oda agi, " : ""}${furniture} mobilya, ${total - furniture} duzlem, ${patches} yama`, 3000);
  } else {
    rebaseHolder(m);
    hud("Fizik kapali");
  }
  state.menu?.invalidate();
}

/**
 * Modelin tutamagini (olcekleme / dondurme merkezi) parcalarin o anki
 * tabaninin ortasina tasir; parcalar dunyada yerinde kalir. Fizikte parcalar
 * yere duserken tutamak havada kaliyordu; sonra olcekleme o havadaki merkeze
 * gore yapilinca parcalar zeminin altina itiliyordu.
 */
function rebaseHolder(m) {
  if (!m || m.holder.parent !== state.scene) return; // tutulurken dokunma
  m.holder.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(m.root);
  if (box.isEmpty()) return;
  const target = new THREE.Vector3((box.min.x + box.max.x) / 2, box.min.y, (box.min.z + box.max.z) / 2);
  if (target.distanceTo(m.holder.position) < 1e-4) return;
  const children = [...m.holder.children];
  for (const c of children) state.scene.attach(c);
  m.holder.position.copy(target);
  m.holder.updateMatrixWorld(true);
  for (const c of children) m.holder.attach(c);
}

/** Olcegi ayarlar; mevcut fizik govdeleri eski boyutta kaldigi icin yenilenir. */
function setScale(s) {
  const m = state.model;
  if (!m) return;
  rebaseHolder(m);
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
  m.explode = m.explodeTarget = 0;
  restoreHome(m.root);
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

function restoreHome(o) {
  const h = o.userData.home;
  if (!h) return;
  o.position.copy(h.p);
  o.quaternion.copy(h.q);
  o.scale.copy(h.s);
}

// --- animasyon ----------------------------------------------------------------

function toggleAnimation() {
  const m = state.model;
  const a = m && m.anim;
  if (!a) return;
  if (m.physics) togglePhysics();
  if (m.explodeTarget > 0) setExplode(m, 0, true);
  if (!a.playing && a.action.time >= a.duration - 1e-3) seekAnimation(0);
  a.playing = !a.playing;
  a.action.paused = !a.playing;
  state.menu?.invalidate();
  desktop?.refresh();
}

function seekAnimation(t) {
  const m = state.model;
  const a = m && m.anim;
  if (!a) return;
  if (m.physics) togglePhysics();
  a.action.time = THREE.MathUtils.clamp(t, 0, a.duration);
  a.action.paused = !a.playing;
  a.mixer.update(0);
  state.menu?.invalidate();
}

let _animUiAt = 0;

function updateAnimations(dt, time) {
  for (const m of state.models) {
    const a = m.anim;
    if (!a || !a.playing || m.physics) continue;
    a.mixer.update(dt);
    if (a.action.time >= a.duration - 1e-4) {
      a.playing = false;
      a.action.paused = true;
      state.menu?.invalidate();
      desktop?.refresh();
    }
    // Menu/ilerleme cubugu saniyede ~5 kez: her karede canvas cizmek pahali.
    if (time - _animUiAt > 200) {
      _animUiAt = time;
      state.menu?.invalidate();
      desktop?.refreshAnimation();
    }
  }
}

// --- parcalari ayirma --------------------------------------------------------

function toggleExplode() {
  const m = state.model;
  if (!m) return;
  if (m.anim && m.anim.playing) {
    m.anim.playing = false;
    m.anim.action.paused = true;
  }
  if (m.physics) {
    removeBodies();
    m.physics = false;
  }
  setExplode(m, m.explodeTarget > 0 ? 0 : 1);
  hud(m.explodeTarget > 0 ? "Parcalar ayriliyor" : "Parcalar toplaniyor", 900);
  state.menu?.invalidate();
}

function setExplode(m, target, instant = false) {
  m.explodeTarget = target;
  if (instant) {
    m.explode = target;
    applyExplode(m);
  }
}

/** Parcalari ilk yerleri + ayirma ofseti * oran konumuna koyar. */
function applyExplode(m) {
  for (const p of m.parts) {
    const h = p.userData.home;
    if (!h) continue;
    p.position.copy(h.p);
    p.quaternion.copy(h.q);
    p.scale.copy(h.s);
    if (p.userData.explode && m.explode > 0) p.position.addScaledVector(p.userData.explode, m.explode);
  }
}

function updateExplode(dt) {
  for (const m of state.models) {
    if (m.physics || m.explode === m.explodeTarget) continue;
    const step = EXPLODE_SPEED * dt;
    m.explode = m.explode < m.explodeTarget
      ? Math.min(m.explodeTarget, m.explode + step)
      : Math.max(m.explodeTarget, m.explode - step);
    applyExplode(m);
  }
}

// --- kesit ------------------------------------------------------------------

function applySection() {
  state.section?.apply(state.model, state.sectionMode, state.sectionT);
}

function cycleSection() {
  const i = SECTION_MODES.indexOf(state.sectionMode);
  state.sectionMode = SECTION_MODES[(i + 1) % SECTION_MODES.length];
  applySection();
  state.menu?.invalidate();
}

function sectionStep(d) {
  state.sectionT = THREE.MathUtils.clamp(state.sectionT + d, 0.02, 0.98);
  applySection();
  state.menu?.invalidate();
}

// --- kalici konum (WebXR anchors) --------------------------------------------

function loadAnchorMap() {
  try { return JSON.parse(localStorage.getItem(ANCHOR_STORAGE) || "{}"); } catch { return {}; }
}

function saveAnchorMap(map) {
  try { localStorage.setItem(ANCHOR_STORAGE, JSON.stringify(map)); } catch { /* yok say */ }
}

/** Kayit bir sonraki karede yapilir: anchor olusturmak aktif bir XRFrame ister. */
function requestAnchorSave() {
  if (!state.model) return;
  if (typeof XRFrame === "undefined" || !XRFrame.prototype.createAnchor) {
    hud("Bu tarayici kalici konumu desteklemiyor", 3000);
    return;
  }
  state.anchorRequest = state.model;
}

const _anchorPos = new THREE.Vector3();
const _anchorQuat = new THREE.Quaternion();

async function processAnchorRequest(frame) {
  const m = state.anchorRequest;
  state.anchorRequest = null;
  const refSpace = state.renderer.xr.getReferenceSpace();
  m.holder.updateMatrixWorld(true);
  m.holder.matrixWorld.decompose(_anchorPos, _anchorQuat, _v);
  try {
    const anchor = await frame.createAnchor(new XRRigidTransform(
      { x: _anchorPos.x, y: _anchorPos.y, z: _anchorPos.z, w: 1 },
      { x: _anchorQuat.x, y: _anchorQuat.y, z: _anchorQuat.z, w: _anchorQuat.w }), refSpace);
    if (!anchor.requestPersistentHandle) {
      anchor.delete?.();
      hud("Bu tarayici kalici konumu desteklemiyor", 3000);
      return;
    }
    const uuid = await anchor.requestPersistentHandle();
    const map = loadAnchorMap();
    const old = map[m.entry.url];
    if (old && old.uuid !== uuid) state.session?.deletePersistentAnchor?.(old.uuid).catch(() => {});
    map[m.entry.url] = { uuid, scale: m.holder.scale.x };
    saveAnchorMap(map);
    m.anchor = anchor;
    m.anchorApplied = true;
    hud("Konum kaydedildi: bir dahaki giriste burada olacak", 3000);
  } catch (err) {
    hud("Konum kaydedilemedi: " + err.message, 3000);
  }
  state.menu?.invalidate();
}

/** Bu model icin kayitli konum varsa geri yukler (yerlestirme sonraki karede). */
async function restoreAnchor(m) {
  const saved = loadAnchorMap()[m.entry.url];
  if (!saved || !state.session?.restorePersistentAnchor) return;
  try {
    m.anchor = await state.session.restorePersistentAnchor(saved.uuid);
    m.anchorScale = saved.scale || m.holder.scale.x;
    m.anchorApplied = false;
  } catch {
    // Anchor silinmis ya da baska odada: normal yerlestirmeyle devam.
  }
}

function applyAnchors(frame) {
  const refSpace = state.renderer.xr.getReferenceSpace();
  for (const m of state.models) {
    if (!m.anchor || m.anchorApplied) continue;
    const pose = frame.getPose(m.anchor.anchorSpace, refSpace);
    if (!pose) continue;
    const { position: p, orientation: o } = pose.transform;
    m.holder.position.set(p.x, p.y, p.z);
    m.holder.quaternion.set(o.x, o.y, o.z, o.w);
    m.holder.scale.setScalar(m.anchorScale);
    m.anchorApplied = true;
    if (m === state.model) removeBodies();
    hud(`${m.entry.name.replace(/\.(glb|gltf|3mf)$/i, "")} kayitli yerinde`, 2000);
  }
}

function forgetAnchor() {
  const m = state.model;
  if (!m) return;
  const map = loadAnchorMap();
  const saved = map[m.entry.url];
  if (!saved) {
    hud("Bu modelin kayitli konumu yok");
    return;
  }
  state.session?.deletePersistentAnchor?.(saved.uuid).catch(() => {});
  delete map[m.entry.url];
  saveAnchorMap(map);
  m.anchor = null;
  hud("Kayitli konum silindi");
  state.menu?.invalidate();
}

// --- golge ve olcu etiketi ----------------------------------------------------

const _rayFrom = new CANNON.Vec3();
const _rayTo = new CANNON.Vec3();
const _rayResult = new CANNON.RaycastResult();
const _box = new THREE.Box3();

/** Modelin altindaki yuzeyin (masa, yama, zemin) yuksekligi. */
function supportHeightBelow(holder) {
  _box.setFromObject(holder);
  const c = _box.getCenter(_v);
  _rayFrom.set(c.x, _box.min.y + 0.02, c.z);
  _rayTo.set(c.x, -1, c.z);
  _rayResult.reset();
  // Maske 1: sadece sabit yuzeyler; model (2) ve parmak (4) govdeleri degil.
  state.world.raycastClosest(_rayFrom, _rayTo, { collisionFilterMask: 1, skipBackfaces: true }, _rayResult);
  return _rayResult.hasHit ? _rayResult.hitPointWorld.y : 0;
}

function updateShadowAndDims() {
  const m = state.model;
  state.shadow.update(m && m.holder, m ? supportHeightBelow(m.holder) : 0, settings.shadow);

  if (!settings.dims || !m) {
    state.dimsLabel.hide();
    return;
  }
  // Olculer modelin kendi ekseninde, gercek (olcekli) boyutla: dondurunce degismez.
  // localBox root ekseninde; root'un kendi olcegi (milimetre -> metre) de hesaba girer.
  const size = m.localBox.getSize(_v2).multiplyScalar(m.root.scale.x * m.holder.scale.x * 100);
  const f = (v) => (v >= 10 ? v.toFixed(0) : v.toFixed(1));
  state.dimsLabel.set(`${f(size.x)} × ${f(size.z)} × ${f(size.y)} cm`);
  _box.setFromObject(m.holder);
  const top = _box.getCenter(_v);
  top.y = _box.max.y + 0.045;
  state.dimsLabel.place(top, _headPos);
}

// --- cetvel ------------------------------------------------------------------

function rulerPoint(input, out) {
  if (input.isHand) return out.copy(input.tip);
  return input.controller.getWorldPosition(out);
}

function addRulerPoint(input) {
  const p = rulerPoint(input, new THREE.Vector3());
  const owner = modelAt(p);
  const done = state.ruler.addPoint(p, owner ? owner.holder : null);
  state.rulerInput = input;
  if (done) {
    hud(done.holder ? "Olcum modele yapisti (gercek boyut)" : `Olcum ${state.ruler.count} eklendi`, 1800);
  }
}

// --- teknik detay ------------------------------------------------------------------

/** Parcanin ait oldugu modelin gosterim olcegi: dunya metresi / gercek metre. */
function realScaleOf(part) {
  for (const m of state.models) if (m.parts.includes(part)) return m.holder.scale.x;
  return 1;
}

/** Noktayi iceren en kucuk parca (ic ice parcalarda icteki secilsin). */
function partAt(point) {
  const box = new THREE.Box3();
  let best = null;
  let bestVolume = Infinity;
  for (const m of state.models) {
    for (const part of m.parts) {
      box.setFromObject(part).expandByScalar(0.01);
      if (!box.containsPoint(point)) continue;
      const s = box.getSize(_v2);
      const volume = s.x * s.y * s.z;
      if (volume < bestVolume) {
        bestVolume = volume;
        best = part;
      }
    }
  }
  return best;
}

const _techRay = new THREE.Raycaster();

/** Kumanda isinin degdigi parca. */
function partOnRay(input) {
  input.controller.getWorldPosition(_v);
  input.controller.getWorldDirection(_v2).negate();
  _techRay.set(_v, _v2);
  const hits = _techRay.intersectObjects(state.models.map((m) => m.holder), true);
  for (const h of hits) {
    if (!h.object.isMesh || !h.object.visible) continue;
    for (const m of state.models) if (m.parts.includes(h.object)) return h.object;
  }
  return null;
}

function toggleTech(part) {
  if (!part) {
    hud("Parca bulunamadi: parcanin ustune dokun", 1500);
    return;
  }
  hud(state.tech.toggle(part) ? "Parca secildi: digerleri saydam" : "Parca secimi kaldirildi", 1200);
  applyIsolation();
  state.menu?.invalidate();
}

function clearMeasurements() {
  state.ruler.clear();
  state.tech.clear();
  applyIsolation();
  hud("Olcumler silindi", 900);
  state.menu?.invalidate();
  desktop?.refresh();
}

const _rulerPreview = new THREE.Vector3();

function updateRuler() {
  const inp = state.rulerInput;
  const preview = inp && inp.source && inp.tracked ? rulerPoint(inp, _rulerPreview) : null;
  state.ruler.update(settings.ruler, preview, _headPos);
}

// --- menu acma (sol bilek dugmesi / Y) ---------------------------------------

/** Menuyu acar/kapatir; yeri her karede sol bilege gore updateMenuFollow'da. */
function toggleMenu() {
  state.menuOpen = !state.menuOpen;
  if (!state.menuOpen) state.menu.setVisible(false);
}

const _toFingers = new THREE.Vector3();
const _wristPos = new THREE.Vector3();
const _knuckle = new THREE.Vector3();
const _palm = new THREE.Vector3();

/**
 * Acik menu sol bilekte saat gibi durur ve kolla birlikte hareket eder:
 * el takibinde ic on kolun ustunde (bilegin gerisinde), kumandada sol
 * kumandanin ustunde. Sag parmak ya da isin menudeyken panel donar; kol
 * titrese de dokunulan dugme kacmaz. Sol el gorunmuyorsa menu gizlenir.
 */
function updateMenuFollow() {
  const menu = state.menu;
  if (!state.menuOpen) return;
  const left = state.inputs.find((i) => i.source && i.handedness === "left" && i.tracked);
  if (!left) {
    menu.setVisible(false);
    return;
  }
  const wasHidden = !menu.visible;
  menu.setVisible(true);
  const using = state.inputs.some((i) => i.pokingMenu)
    || state.inputs.some((i) => i.source && !i.isHand && menuRayHit(i));
  if (using && !wasHidden) return;

  if (left.isHand) {
    const wrist = jointWorld(left.hand, "wrist", _wristPos);
    const knuckle = wrist && jointWorld(left.hand, "middle-finger-phalanx-proximal", _knuckle);
    const normal = knuckle && palmNormal(left.hand, "left", _palm);
    if (!normal) return;
    _toFingers.subVectors(knuckle, wrist).normalize();
    // Panelin yakin kenari bilek dugmesinin hemen gerisinde kalsin.
    menu.group.position.copy(wrist)
      .addScaledVector(_toFingers, -(0.06 + MENU_WIDTH * 0.6))
      .addScaledVector(normal, 0.04);
  } else {
    left.grip.getWorldPosition(menu.group.position);
    menu.group.position.y += 0.17;
  }
  menu.group.lookAt(_headPos);
}

let _wristShown = false;

/** Sol bilek dugmesi: sol avuc kullaniciya donunce belirir, sag isaret parmagi basar. */
function updateWristButton() {
  const btn = state.wristButton;
  const left = state.inputs.find((i) => i.source && i.isHand && i.handedness === "left" && i.tracked);
  const normal = left && palmNormal(left.hand, "left", _normal);
  const wrist = normal && jointWorld(left.hand, "wrist", _centre);
  const knuckle = wrist && jointWorld(left.hand, "middle-finger-phalanx-proximal", _v2);
  if (!knuckle) {
    btn.mesh.visible = _wristShown = false;
    return;
  }
  const facing = normal.dot(_v.subVectors(_headPos, wrist).normalize());
  if (facing > 0.35) _wristShown = true;
  else if (facing < 0.15) _wristShown = false;
  btn.mesh.visible = _wristShown;
  if (!_wristShown) return;

  // Bilegin ic tarafi, onkola dogru: saat bakar gibi.
  const toFingers = knuckle.sub(wrist).normalize();
  btn.mesh.position.copy(wrist).addScaledVector(toFingers, -0.035).addScaledVector(normal, 0.02);
  btn.mesh.lookAt(_headPos);

  const right = state.inputs.find((i) => i.source && i.isHand && i.handedness === "right" && i.tracked);
  if (right && btn.poke(right.tip)) toggleMenu();
}

/** Kumanda isini menude gezdirir (tum kumandalar). */
function updateMenuHover() {
  const menu = state.menu;
  if (!menu.visible) return;
  let hit = null;
  for (const inp of state.inputs) {
    if (inp.source && !inp.isHand) hit = menuRayHit(inp) || hit;
  }
  if (hit) menu.hoverAt(hit);
  else if (!state.inputs.some((i) => i.pokingMenu)) menu.hoverAt(null);
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
      occluder: new HandOccluder(state.scene),
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
      showRay(input);
      applyHandStyle(input);
    });
    controller.addEventListener("disconnected", () => {
      releaseInput(input);
      input.occluder.update(null, false);
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

/**
 * Kumandada isin hep gorunur; elde yalnizca uzaktan tutma aciksa (Quest'in
 * el isini, bilekten ileri) daha soluk ve kisa.
 */
function showRay(input) {
  input.ray.visible = !input.isHand || settings.farGrab;
  input.ray.scale.z = input.isHand ? 1.5 : 3;
  input.ray.material.opacity = input.isHand ? 0.3 : 0.6;
}

/** Isinin (kumanda ya da el) degdigi model. */
function modelOnRay(input) {
  input.controller.getWorldPosition(_v);
  input.controller.getWorldDirection(_v2).negate();
  _techRay.set(_v, _v2);
  _techRay.far = 8;
  const hits = _techRay.intersectObjects(state.models.map((m) => m.holder), true);
  for (const h of hits) {
    if (!h.object.isMesh || !h.object.visible) continue;
    const m = state.models.find((x) => x.parts.includes(h.object));
    if (m) return m;
  }
  return null;
}

/** Tetik (kumanda) — el takibinde select olayini kendi cimdik mantigimiz karsilar. */
function onSelect(input) {
  if (input.isHand) return;
  const hit = menuRayHit(input);
  if (hit) {
    state.menu.clickAt(hit);
    return;
  }
  if (settings.tech) {
    toggleTech(partOnRay(input));
    return;
  }
  if (settings.ruler) {
    addRulerPoint(input);
    return;
  }
  if (settings.pinchPlace) placeAtReticle();
}

function menuRayHit(input) {
  if (!state.menu?.visible) return null;
  input.controller.getWorldPosition(_v);
  input.controller.getWorldDirection(_v2).negate(); // three'de kumanda -Z'ye bakar
  return state.menu.rayHit(_v, _v2);
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
  input.occluder.update(hand, input.tracked && settings.handStyle !== "mesh");
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

  // Menu acikken iki elin de isaret parmagi dokunabilir.
  input.pokingMenu = state.menu.poke(input.i, index);

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
  if (settings.tech) {
    toggleTech(partAt(input.tip));
    return;
  }
  if (settings.ruler) {
    addRulerPoint(input);
    return;
  }
  const target = modelAt(input.point);
  if (target) {
    if (!state.grab) setActive(target);
    if (target === state.model) grabWith(input);
    return;
  }
  if (state.grab) return;
  const far = settings.farGrab && modelOnRay(input);
  if (far) {
    setActive(far);
    grabWith(input, true);
  } else if (settings.pinchPlace) {
    placeAtReticle();
  }
  // Model bir eldeyken diger elin uzaktaki cimdigi yok sayilir: eskiden
  // iki elle olceklemeyi baslatip modeli bir anda buyutuyordu.
}



/** Kumanda dugmeleri ve cubugu. */
function updateController(input, dt, time) {
  const gp = input.source && input.source.gamepad;
  input.grip.getWorldPosition(input.point);
  input.vel.push(time, input.point);
  input.tracked = true;

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
  const prev = input.prev;

  if (input.handedness === "right") {
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
    // Y: menu. Quest sol kumandanin menu tusunu tarayiciya vermiyor.
    if (b && !prev.b) toggleMenu();
  }

  // Kavrama: kumandanin yanindaki model (yoksa secili olan) kumandaya baglanir.
  if (grip && !prev.grip) {
    const target = modelAt(input.point) || (settings.farGrab && modelOnRay(input));
    if (target && !state.grab) setActive(target);
    grabWith(input);
  }
  if (!grip && prev.grip) releaseInput(input);

  prev.a = a;
  prev.b = b;
  prev.grip = grip;
}

// --- tutma, iki elle olcekleme, firlatma ------------------------------------

function anchorOf(input) {
  return input.isHand ? input.pinchAnchor : input.grip;
}

function grabWith(input, far = false) {
  const m = state.model;
  if (!m) return;
  if (state.grab && state.grab.input !== input && !state.twoHand) {
    startTwoHand(state.grab.input, input);
    return;
  }
  if (state.grab) return;

  rebaseHolder(m);
  state.grab = { input, wasPhysics: m.physics, far };
  // Tutulurken fizik duraklar; birakinca govdeler yeni yerden kurulur.
  m.physics = false;
  // Uzaktan tutmada model elin isinina baglanir: el hareket edince isinla gider.
  (far ? input.controller : anchorOf(input)).attach(m.holder);
  hud(far ? "Uzaktan tutuluyor" : "Tutuluyor", 900);
}

function startTwoHand(a, b) {
  const m = state.model;
  state.scene.attach(m.holder);
  rebaseHolder(m);
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
      collisionFilterGroup: 4,
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

// Bakilan yuzeylerden (hit-test) ogrenilen fizik yamalari. Oda taramasi bos
// olsa bile model yerlestirilebildigi her yuzeyde fizikte de durur.
const PATCH_SIZE = 0.22;        // yamanin kenari, metre
const PATCH_SPACING = 0.12;     // bu mesafeden yakin yeni yama eklenmez
const PATCH_HEIGHT_TOL = 0.025; // ayni yuzey sayilan yukseklik farki
const MAX_PATCHES = 500;

// Oda agindan (global mesh) kurulan yukseklik haritasi: hucre boyu ve
// dikkate alinan en yuksek yuzey (tavan ve raf ustleri disarida kalsin).
const HEIGHTFIELD_CELL = 0.04;   // metre
const HEIGHTFIELD_MAX_Y = 1.9;   // metre
const HEIGHTFIELD_MAX_CELLS = 400; // kenar basina (16 m)

// Tum odayi kaplayan tarama agi tek kutu olunca odanin icini doldurur; atlanir.
const MAX_FURNITURE_SIZE = 3.5;  // metre

/**
 * Quest 3'un oda taramasini fizige sabit kutular olarak ekler; boylece fizik
 * acikken model masanin, koltugun ustunde durur, duvara carpar.
 *
 * - plane-detection: duvar, zemin, tavan, bazen masa ustu. Her duzlemin kendi
 *   uzayinda +Y normaldir, cokgen y=0'dadir; kutu yuzeyin arkasinda durur.
 * - mesh-detection: mobilyalar (masa, koltuk, yatak...) 3B hacim olarak gelir.
 *   Fizik motoru kutu ile ucgen agini carpistiramadigi icin her mobilya kendi
 *   sinir kutusuyla eklenir. Tum odayi kaplayan "global mesh" atlanir.
 */
function updateSurfaces(frame, time) {
  const refSpace = state.renderer.xr.getReferenceSpace();
  const seen = new Set();

  const planes = frame.detectedPlanes;
  if (planes) {
    for (const plane of planes) {
      seen.add(plane);
      syncSurface(frame, refSpace, plane, plane.planeSpace, "duzlem", () => planeBox(plane));
    }
  }
  const meshes = frame.detectedMeshes;
  if (meshes) {
    for (const mesh of meshes) {
      seen.add(mesh);
      if (/global/i.test(mesh.semanticLabel || "")) {
        syncRoomMesh(frame, refSpace, mesh);
        continue;
      }
      syncSurface(frame, refSpace, mesh, mesh.meshSpace, mesh.semanticLabel || "mobilya", () => meshBox(mesh));
    }
  }

  for (const [key, entry] of state.surfaces) {
    if (seen.has(key)) continue;
    removeSurface(entry);
    state.surfaces.delete(key);
  }

  // Oda verisi yoksa model hep yere duser; kullaniciya sebebini soyle.
  if (!state.surfaceHintShown && time - state.sessionStart > 6000) {
    state.surfaceHintShown = true;
    const { furniture, total, roomMesh } = surfaceCounts();
    // Oda taramasi olmasa da bakilan yuzeyler ogreniliyor; kullaniciya
    // fizigin nasil calistigini soyle.
    if (furniture === 0 && !roomMesh) {
      hud(total === 0 && !planes && !meshes
        ? "Fizik icin masaya/yuzeylere bir kez bak: gozluk onlari ogrenir"
        : "Masalara bir kez bak: fizik bakilan yuzeyleri ogrenir", 6000);
    }
  }
}

/**
 * Quest 3'un tum oda tarama agini (global mesh) fizige katar. Fizik motoru
 * kutu ile ucgen agini carpistiramiyor ama yukseklik haritasiyla (heightfield)
 * carpistirabiliyor: yukari/asagi bakan her ucgen 4 cm'lik izgaraya
 * rasterlanir, her hucreye o noktadaki en yuksek yuzey (masa ustu, koltuk
 * oturagi, yatak) yazilir. Duvarlar ve masa alti gibi dikey/ters yuzeyler
 * haritaya girmez; onlar icin duzlemler ve yamalar var.
 */
function syncRoomMesh(frame, refSpace, mesh) {
  const known = state.surfaces.get(mesh);
  if (known && known.changed === mesh.lastChangedTime) return;
  const pose = frame.getPose(mesh.meshSpace, refSpace);
  if (!pose) return;
  if (known) removeSurface(known);
  const entry = { body: null, debug: null, label: "oda agi", changed: mesh.lastChangedTime };
  state.surfaces.set(mesh, entry);
  entry.body = buildHeightfield(mesh.vertices, mesh.indices, pose.transform.matrix);
  if (entry.body) state.world.addBody(entry.body);
}

function buildHeightfield(vertices, indices, matrix) {
  if (!vertices || !indices || indices.length < 3) return null;
  _pm.fromArray(matrix);
  const count = vertices.length / 3;
  const w = new Float32Array(vertices.length);
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < count; i++) {
    _ps.set(vertices[i * 3], vertices[i * 3 + 1], vertices[i * 3 + 2]).applyMatrix4(_pm);
    w[i * 3] = _ps.x; w[i * 3 + 1] = _ps.y; w[i * 3 + 2] = _ps.z;
    minX = Math.min(minX, _ps.x); maxX = Math.max(maxX, _ps.x);
    minZ = Math.min(minZ, _ps.z); maxZ = Math.max(maxZ, _ps.z);
  }
  const es = HEIGHTFIELD_CELL;
  const nx = Math.min(Math.ceil((maxX - minX) / es) + 1, HEIGHTFIELD_MAX_CELLS);
  const nz = Math.min(Math.ceil((maxZ - minZ) / es) + 1, HEIGHTFIELD_MAX_CELLS);
  if (nx < 2 || nz < 2) return null;
  const heights = Array.from({ length: nx }, () => new Array(nz).fill(0));

  // Hucre (i, j) dunyada x = minX + i*es, z = maxZ - j*es (govde -90° donuk).
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t] * 3, b = indices[t + 1] * 3, c = indices[t + 2] * 3;
    const ax = w[a], ay = w[a + 1], az = w[a + 2];
    const bx = w[b], by = w[b + 1], bz = w[b + 2];
    const cx = w[c], cy = w[c + 1], cz = w[c + 2];
    if (ay > HEIGHTFIELD_MAX_Y && by > HEIGHTFIELD_MAX_Y && cy > HEIGHTFIELD_MAX_Y) continue;
    // Yatay yakin ucgenler (normalin dikey bileseni buyuk); sarim yonu belirsiz, mutlak deger.
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    const nX = uy * vz - uz * vy, nY = uz * vx - ux * vz, nZ = ux * vy - uy * vx;
    const len = Math.hypot(nX, nY, nZ);
    if (!len || Math.abs(nY) / len < 0.7) continue;

    const denom = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
    if (Math.abs(denom) < 1e-12) continue;
    const i0 = Math.max(0, Math.floor((Math.min(ax, bx, cx) - minX) / es));
    const i1 = Math.min(nx - 1, Math.ceil((Math.max(ax, bx, cx) - minX) / es));
    const j0 = Math.max(0, Math.floor((maxZ - Math.max(az, bz, cz)) / es));
    const j1 = Math.min(nz - 1, Math.ceil((maxZ - Math.min(az, bz, cz)) / es));
    for (let i = i0; i <= i1; i++) {
      const x = minX + i * es;
      for (let j = j0; j <= j1; j++) {
        const z = maxZ - j * es;
        const l1 = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / denom;
        const l2 = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / denom;
        const l3 = 1 - l1 - l2;
        if (l1 < -0.02 || l2 < -0.02 || l3 < -0.02) continue;
        const y = l1 * ay + l2 * by + l3 * cy;
        if (y <= HEIGHTFIELD_MAX_Y && y > heights[i][j]) heights[i][j] = y;
      }
    }
  }

  const body = new CANNON.Body({
    type: CANNON.Body.STATIC,
    shape: new CANNON.Heightfield(heights, { elementSize: es }),
  });
  body.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
  body.position.set(minX, 0, maxZ);
  body.updateAABB();
  return body;
}

function planeBox(plane) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const pt of plane.polygon) {
    minX = Math.min(minX, pt.x); maxX = Math.max(maxX, pt.x);
    minZ = Math.min(minZ, pt.z); maxZ = Math.max(maxZ, pt.z);
  }
  if (!(maxX > minX && maxZ > minZ)) return null;
  return new THREE.Box3(
    new THREE.Vector3(minX, -SURFACE_THICKNESS, minZ),
    new THREE.Vector3(maxX, 0, maxZ));
}

function meshBox(mesh) {
  const v = mesh.vertices;
  if (!v || v.length < 9) return null;
  const box = new THREE.Box3();
  for (let i = 0; i < v.length; i += 3) box.expandByPoint(_ps.set(v[i], v[i + 1], v[i + 2]));
  const size = box.getSize(_ps);
  if (Math.max(size.x, size.y, size.z) > MAX_FURNITURE_SIZE) return null;
  return box;
}

/** Yuzeyi (yeniden) kurar; sadece taramada degistiyse. */
function syncSurface(frame, refSpace, key, space, label, makeBox) {
  const known = state.surfaces.get(key);
  if (known && known.changed === key.lastChangedTime) return;
  const pose = frame.getPose(space, refSpace);
  if (!pose) return;
  if (known) removeSurface(known);

  const entry = { body: null, debug: null, label, changed: key.lastChangedTime };
  state.surfaces.set(key, entry);
  const box = makeBox();
  if (!box) return;

  const half = box.getSize(new THREE.Vector3()).multiplyScalar(0.5);
  half.max(new THREE.Vector3(0.005, 0.005, 0.005));
  _pm.fromArray(pose.transform.matrix);
  _pm.decompose(_pp, _pq, _ps);
  const centre = box.getCenter(new THREE.Vector3()).applyMatrix4(_pm);

  const body = new CANNON.Body({
    type: CANNON.Body.STATIC,
    shape: new CANNON.Box(new CANNON.Vec3(half.x, half.y, half.z)),
  });
  body.position.set(centre.x, centre.y, centre.z);
  body.quaternion.set(_pq.x, _pq.y, _pq.z, _pq.w);
  // Sabit govdenin sinir kutusu konum degisince kendiliginden yenilenmiyor;
  // yenilenmezse isin testi (golge) ve broadphase govdeyi orijinde sanir.
  body.updateAABB();
  state.world.addBody(body);
  entry.body = body;

  if (DEBUG) {
    // ?debug: gozlugun odadan ne bildigini gor (mobilya turuncu, duzlem mavi).
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(half.x * 2, half.y * 2, half.z * 2)),
      new THREE.LineBasicMaterial({ color: label === "duzlem" ? 0x6ea8fe : 0xf5a524 }));
    edges.position.copy(centre);
    edges.quaternion.copy(_pq);
    state.scene.add(edges);
    entry.debug = edges;
  }
}

function removeSurface(entry) {
  if (entry.body) state.world.removeBody(entry.body);
  if (entry.debug) {
    entry.debug.removeFromParent();
    entry.debug.geometry.dispose();
  }
}

/**
 * Hit-test isabetini fizik yamasi olarak ogrenir. Isabet pozunun Y ekseni
 * yuzey normalidir; yama yuzeyin arkasinda SURFACE_THICKNESS kalinliginda.
 * Yakininda ayni yukseklikte yama varsa eklenmez.
 */
const _hitPos = new THREE.Vector3();
const _hitQuat = new THREE.Quaternion();
const _hitNormal = new THREE.Vector3();

function learnSurface(matrix) {
  _pm.fromArray(matrix);
  _pm.decompose(_hitPos, _hitQuat, _ps);
  _hitNormal.set(0, 1, 0).applyQuaternion(_hitQuat);
  // Egik yuzeyler (yastik, kol) guvenilmez; yatay ve dikey olanlari al.
  const horizontal = _hitNormal.y > 0.85;
  const vertical = Math.abs(_hitNormal.y) < 0.25;
  if (!horizontal && !vertical) return;

  for (const patch of state.patches) {
    if (patch.horizontal !== horizontal) continue;
    const d = patch.pos.distanceTo(_hitPos);
    if (horizontal) {
      const dy = Math.abs(patch.pos.y - _hitPos.y);
      if (dy < PATCH_HEIGHT_TOL && d < PATCH_SPACING) return;
    } else if (d < PATCH_SPACING) {
      return;
    }
  }
  if (state.patches.length >= MAX_PATCHES) {
    const old = state.patches.shift();
    removeSurface(old);
  }

  // Yatay yamada dunya dikeyini kullan: kucuk egim hatasi model kaydirmasin.
  if (horizontal) _hitQuat.identity();
  const centre = new THREE.Vector3(0, -SURFACE_THICKNESS / 2, 0).applyQuaternion(_hitQuat).add(_hitPos);
  const body = new CANNON.Body({
    type: CANNON.Body.STATIC,
    shape: new CANNON.Box(new CANNON.Vec3(PATCH_SIZE / 2, SURFACE_THICKNESS / 2, PATCH_SIZE / 2)),
  });
  body.position.set(centre.x, centre.y, centre.z);
  body.quaternion.set(_hitQuat.x, _hitQuat.y, _hitQuat.z, _hitQuat.w);
  body.updateAABB(); // bkz. syncSurface
  state.world.addBody(body);

  const patch = { body, debug: null, label: "yama", pos: _hitPos.clone(), horizontal };
  if (DEBUG) {
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(PATCH_SIZE, 0.002, PATCH_SIZE)),
      new THREE.LineBasicMaterial({ color: 0x3ddc97, transparent: true, opacity: 0.5 }));
    edges.position.copy(_hitPos);
    edges.quaternion.copy(_hitQuat);
    state.scene.add(edges);
    patch.debug = edges;
  }
  state.patches.push(patch);
}

function surfaceCounts() {
  let total = 0, furniture = 0, roomMesh = false;
  for (const e of state.surfaces.values()) {
    if (!e.body) continue;
    if (e.label === "oda agi") {
      roomMesh = true;
      continue;
    }
    total++;
    if (e.label !== "duzlem") furniture++;
  }
  return { total, furniture, roomMesh, patches: state.patches.length };
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
    tools: () => ({
      exploded: Boolean(state.model && state.model.explodeTarget > 0),
      section: state.sectionMode,
      sectionT: state.sectionT,
      anchorSaved: Boolean(state.model && loadAnchorMap()[state.model.entry.url]),
      modelCount: state.models.length,
      measures: state.ruler.count + state.tech.count,
      anim: state.model && state.model.anim ? {
        playing: state.model.anim.playing,
        progress: state.model.anim.action.time / (state.model.anim.duration || 1),
      } : null,
    }),
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
      clearMeasures: clearMeasurements,
      explode: toggleExplode,
      removeModel: removeActiveModel,
      cycleSection,
      sectionStep,
      saveAnchor: requestAnchorSave,
      animToggle: toggleAnimation,
      animRestart: () => seekAnimation(0),
      forgetAnchor,
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

  try {
    if (!state.model || state.model.entry.url !== entry.url) await showModel(entry);
  } catch (err) {
    el.hint.textContent = "Model yuklenemedi: " + err.message;
    el.enter.disabled = false;
    return;
  }
  const model = state.model;

  let session;
  try {
    const optionalFeatures = [
      "hit-test", "anchors", "plane-detection", "mesh-detection", "hand-tracking", "dom-overlay",
    ];
    const init = { requiredFeatures: ["local-floor"], optionalFeatures,
      domOverlay: { root: document.getElementById("hud") } };
    if (settings.depth) {
      // three.js derinlik dokusunu kendisi derinlik tamponuna yaziyor: gercek
      // nesneler sanal modelin onune gecince onu ortuyor.
      optionalFeatures.push("depth-sensing");
      init.depthSensing = {
        usagePreference: ["gpu-optimized"],
        dataFormatPreference: ["luminance-alpha", "float32"],
      };
    }
    session = await navigator.xr.requestSession("immersive-ar", init);
  } catch (err) {
    el.hint.textContent = "Passthrough baslatilamadi: " + err.message;
    el.enter.disabled = false;
    return;
  }

  state.session = session;
  state.inputs = [];
  state.occlusion = settings.depth ? new SoftOcclusion(state.renderer) : null;
  if (state.occlusion) for (const m of state.models) for (const mat of m.materials) state.occlusion.patch(mat);
  resetRoomSurfaces();
  state.surfaceHintShown = false;
  state.sessionStart = 0;
  state.grab = null;
  state.twoHand = null;
  desktop.suspend();
  Label.scale = 1; // VR'da etiketler gercek boyutta
  state.renderer.setClearColor(0x000000, 0); // passthrough gorunsun
  await state.renderer.xr.setSession(session);

  for (const m of state.models) {
    m.realistic = false;
    state.model = m;
    setOpacity(GHOST_OPACITY);
  }
  state.model = model;
  state.needsPlacement = true;
  state.rulerInput = null;
  state.ruler.clear();
  state.anchorRequest = null;
  state.menuOpen = false;

  buildMenu();
  setUpInputs();
  restoreAnchor(model);

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
  for (const input of state.inputs) {
    input.occluder.dispose();
    input.pinchAnchor.removeFromParent();
    for (const t of input.tips || []) t.removeFromParent();
    removeFingerBody(input);
  }
  state.inputs = [];
  releaseAll();
  state.menu?.group.removeFromParent();
  state.menu = null;
  state.menuOpen = false;
  state.wristButton.mesh.visible = false;
  state.reticle.visible = false;
  state.toast.mesh.visible = false;
  resetRoomSurfaces();
  // Yumusak ortme kapanmali: materyaller yamali kalir, doku yokken ortme
  // acik kalirsa model PC'de gorunmez olur.
  if (state.occlusion) state.occlusion.uniforms.occOn.value = 0;
  state.occlusion = null;
  state.session = null;
  state.hitTestSource = null;
  el.enter.disabled = false;
  el.hint.textContent = "Oturum kapandi. Tekrar girebilirsin.";
  desktop.resume();
  state.renderer.setAnimationLoop(desktop.frame);
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
      ? `%${Math.round(m.fitScale * 100)} boyutta acildi · menu: sol bilek dugmesi / Y`
      : "Cimdik: yerlestir · menu: sol bilek dugmesi / Y", 4000);
  }

  if (frame) {
    if (!state.sessionStart) state.sessionStart = time;
    updateSurfaces(frame, time);
    applyAnchors(frame);
    if (state.anchorRequest) processAnchorRequest(frame);
  }
  state.renderer.xr.getCamera().getWorldPosition(_headPos);

  if (frame && state.hitTestSource) {
    const refSpace = state.renderer.xr.getReferenceSpace();
    const hits = frame.getHitTestResults(state.hitTestSource);
    if (hits.length) {
      const pose = hits[0].getPose(refSpace);
      state.reticle.visible = true;
      state.reticle.matrix.fromArray(pose.transform.matrix);
      learnSurface(pose.transform.matrix);
    } else {
      state.reticle.visible = false;
    }
  }

  for (const input of state.inputs) {
    if (!input.source) continue;
    if (!input.isHand) input.occluder.update(null, false);
    if (input.isHand) updateHand(input, time);
    else updateController(input, dt, time);
  }
  if (state.twoHand) updateTwoHand();
  updateWristButton();
  updateMenuFollow();
  updateMenuHover();
  state.menu.update();
  if (DEBUG && time - (state.lastDebug || 0) > 400) {
    state.lastDebug = time;
    const hands = state.inputs.filter((i) => i.source)
      .map((i) => `${i.handedness[0] || "?"}:${i.isHand ? (i.tracked ? "el" : "el-yok") : "kum"}`).join(" ");
    const { total, furniture, patches } = surfaceCounts();
    showToast(`${hands} · yama ${patches} · mobilya ${furniture}/${total} · ${state.debugText}`, 1000);
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
  updateExplode(dt);
  updateAnimations(dt, time);

  // Model hareket ettikten sonra: kesit duzlemi, golge, olculer, cetvel.
  for (const x of state.models) x.holder.updateMatrixWorld(true);
  state.section.update();
  updateShadowAndDims();
  updateRuler();
  state.tech.update(_headPos, realScaleOf);
  state.occlusion?.update();

  state.renderer.render(state.scene, state.camera);
}

// --- baslangic --------------------------------------------------------------

el.enter.addEventListener("click", enterAR);

initScene();
desktop = initDesktop({
  state, settings, setSetting, hud,
  setHead: (p) => _headPos.copy(p),
  toggleView, setOpacity, setScale, toggleExplode, updateExplode, applySection,
  togglePhysics, liftAboveFloor, buildBodies, removeBodies, syncPartsFromBodies,
  updateShadowAndDims, toggleAnimation, seekAnimation, updateAnimations,
  restoreHome, applyExplode, realScaleOf, clearMeasurements, applyIsolation,
  fitScaleOf: (m) => (m.longest > DEFAULT_SIZE ? DEFAULT_SIZE / m.longest : 1),
});
state.renderer.setAnimationLoop(desktop.frame);
// ?debug: tarayici konsolundan duruma bakabilmek icin.
if (DEBUG) window.__viewer = { state, settings, THREE };

checkSupport();
loadCatalog();
