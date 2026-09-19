/**
 * Birlikte kullanim: ayni odadaki gozlukler (ve PC'ler) sahneyi paylasir,
 * birbirinin basini ve ellerini gorur.
 *
 * Sunucu (vr-api.kaanai.site/rooms/:kod/ws) mesajlari yalnizca iletir.
 *
 * Koordinatlar: her gozlugun "local-floor" uzayi kendi baslangic noktasina
 * gore; iki gozluk ayni gercek odada ayni yeri gostersin diye ortak bir uzay
 * (S) tanimlanir. Hizalama: iki kisi de ayni iki gercek noktaya (or. masanin
 * sol ve sag on kosesi) ayni sirayla dokunur; 1. nokta orijin, 1->2 yonu
 * ortak uzayin +Z ekseni olur. Tum konumlar S'de gonderilir, alinca yerel
 * uzaya cevrilir. Hizalanmamis gozlukte S = yerel uzay.
 *
 * Esitleme: 10 Hz'de her modelin durumu (konum, boyut, gorunum, ayrilma,
 * fizik) bir "iz" olarak hesaplanir; degisenler gonderilir. Karsidan gelen
 * durum uygulaninca iz de ona esitlenir, boylece ayni degisiklik geri
 * gonderilmez (yanki olmaz). Modeli o an tutan kisinin konumu kazanir;
 * fizigi o an hesaplayan tek kisidir, digerleri sonucu uygular.
 */
import * as THREE from "three";
import { Label } from "./tools.js";

const WS_BASE = "wss://vr-api.kaanai.site/rooms";
const NAME_STORAGE = "kaan-mr-viewer.name";
const STATE_INTERVAL = 100;     // ms, model durumu
const POSE_INTERVAL = 66;       // ms, bas/el (15 Hz)
const SCENE_INTERVAL = 2000;    // ms, sunucuda saklanan tam sahne
const ECHO_GUARD = 400;         // ms, karsidan gelen durumu geri gondermeme suresi
const PEER_COLORS = [0xf5a524, 0x3ddc97, 0xf4696b, 0xb28cff, 0x4cc9f0];

const JOINTS = [
  "wrist",
  "thumb-metacarpal", "thumb-phalanx-proximal", "thumb-phalanx-distal", "thumb-tip",
  ...["index", "middle", "ring", "pinky"].flatMap((f) => [
    `${f}-finger-metacarpal`, `${f}-finger-phalanx-proximal`,
    `${f}-finger-phalanx-intermediate`, `${f}-finger-phalanx-distal`, `${f}-finger-tip`,
  ]),
];

const r3 = (v) => Math.round(v * 1000) / 1000;

export function initMulti(api) {
  const { state } = api;

  const m = {
    ws: null,
    code: "",
    myId: "",
    peers: new Map(),       // id -> { name, avatar }
    status: "kapali",       // kapali | baglaniyor | bagli
    calibrated: false,
    calibrating: null,      // { points: [] }
    toShared: new THREE.Matrix4(),
    fromShared: new THREE.Matrix4(),
    lastSent: new Map(),    // uid -> iz (string)
    lastStructure: "",
    lastSection: "",
    lastState: 0,
    lastPose: 0,
    lastScene: 0,
    sceneDirty: false,
    pending: new Set(),     // yuklenmekte olan uzak model uid'leri
    warnedLocal: false,
    retries: 0,
  };

  const markers = new THREE.Group();
  state.scene.add(markers);

  // --- durum / arayuz -------------------------------------------------------

  const listeners = new Set();
  const changed = () => { for (const fn of listeners) fn(); };

  function getName() {
    try { return localStorage.getItem(NAME_STORAGE) || ""; } catch { return ""; }
  }
  function setName(n) {
    try { localStorage.setItem(NAME_STORAGE, n); } catch { /* yok say */ }
  }

  function info() {
    return {
      status: m.status,
      code: m.code,
      peers: [...m.peers.values()].map((p) => p.name),
      calibrated: m.calibrated,
      calibrating: m.calibrating ? m.calibrating.points.length + 1 : 0,
    };
  }

  // --- baglanti ---------------------------------------------------------------

  function create(name) {
    connect(String(1000 + Math.floor(Math.random() * 9000)), name);
  }

  function connect(code, name = getName()) {
    leave(true);
    if (!/^\d{4,6}$/.test(code)) {
      api.hud("Oda kodu 4 haneli olmali");
      return;
    }
    if (name) setName(name);
    m.code = code;
    m.status = "baglaniyor";
    m.retries = 0;
    open(name || "Misafir");
    changed();
  }

  function open(name) {
    const ws = new WebSocket(`${WS_BASE}/${m.code}/ws?name=${encodeURIComponent(name)}`);
    m.ws = ws;
    ws.onmessage = (e) => {
      try {
        handle(JSON.parse(e.data));
      } catch (err) {
        console.warn("oda mesaji islenemedi", err);
      }
    };
    ws.onclose = () => {
      if (m.ws !== ws) return; // bilerek kapatildi
      if (m.status === "bagli" && m.retries < 3) {
        m.retries++;
        m.status = "baglaniyor";
        changed();
        setTimeout(() => { if (m.ws === ws) open(name); }, 1000 * m.retries);
        return;
      }
      api.hud("Oda baglantisi koptu", 2500);
      leave(true);
    };
  }

  function leave(silent = false) {
    const ws = m.ws;
    m.ws = null;
    if (ws) ws.close();
    for (const p of m.peers.values()) p.avatar.dispose();
    m.peers.clear();
    const had = m.status !== "kapali";
    m.status = "kapali";
    m.code = "";
    m.lastSent.clear();
    m.lastStructure = "";
    for (const model of state.models) model.synced = false;
    if (had && !silent) api.hud("Odadan ayrildin");
    changed();
  }

  function send(msg) {
    if (m.ws && m.ws.readyState === WebSocket.OPEN) m.ws.send(JSON.stringify(msg));
  }

  // --- gelen mesajlar ----------------------------------------------------------

  function handle(msg) {
    if (msg.t === "welcome") {
      m.myId = msg.id;
      m.status = "bagli";
      m.retries = 0;
      for (const p of msg.peers) addPeer(p.id, p.name);
      if (msg.scene && msg.scene.models && msg.scene.models.length) {
        applyScene(msg.scene, true);
        api.hud(`Oda ${m.code}: sahne alindi`, 2500);
      } else {
        m.sceneDirty = true; // bos oda: bizim sahnemiz odanin sahnesi olur
        api.hud(`Oda ${m.code} acildi`, 2500);
      }
      changed();
    } else if (msg.t === "join") {
      addPeer(msg.id, msg.name);
      api.hud(`${msg.name} katildi${state.session && !m.calibrated ? " · Hizala" : ""}`, 3000);
      m.sceneDirty = true;
      changed();
    } else if (msg.t === "leave") {
      const p = m.peers.get(msg.id);
      if (p) {
        p.avatar.dispose();
        m.peers.delete(msg.id);
        api.hud(`${p.name} ayrildi`, 2500);
        changed();
      }
    } else if (msg.t === "p") {
      m.peers.get(msg.from)?.avatar.update(msg, m.fromShared);
    } else if (msg.t === "scene") {
      applyScene(msg.scene, false);
    } else if (msg.t === "state") {
      if (msg.sec) applySection(msg.sec);
      for (const st of msg.models || []) {
        const model = state.models.find((x) => x.uid === st.uid);
        if (model) applyModelState(model, st);
      }
    }
  }

  function addPeer(id, name) {
    if (m.peers.has(id)) return;
    const color = PEER_COLORS[m.peers.size % PEER_COLORS.length];
    m.peers.set(id, { name, avatar: new Avatar(state.scene, name, color) });
  }

  // --- sahne -> mesaj ------------------------------------------------------------

  const _pos = new THREE.Vector3();
  const _quat = new THREE.Quaternion();
  const _scl = new THREE.Vector3();
  const _mat = new THREE.Matrix4();

  function shareable(model) {
    return !String(model.entry.url).startsWith("blob:");
  }

  /** Modelin paylasilan durumu. withPose: konum da (PC'deki kisi konum yollamaz). */
  function modelState(model, withPose) {
    const st = {
      uid: model.uid,
      op: r3(model.opacity),
      real: model.realistic,
      ex: model.explodeTarget,
      phys: model.physics,
    };
    if (withPose) {
      model.holder.updateMatrixWorld(true);
      _mat.multiplyMatrices(m.toShared, model.holder.matrixWorld).decompose(_pos, _quat, _scl);
      st.p = [r3(_pos.x), r3(_pos.y), r3(_pos.z)];
      st.q = [r3(_quat.x), r3(_quat.y), r3(_quat.z), r3(_quat.w)];
      st.s = r3(_scl.x);
      // Fizigi biz hesapliyorsak parcalarin (ve root'un) yerel pozlari da.
      if (model.physics) {
        st.parts = [model.root, ...model.parts].map((o) => [
          r3(o.position.x), r3(o.position.y), r3(o.position.z),
          r3(o.quaternion.x), r3(o.quaternion.y), r3(o.quaternion.z), r3(o.quaternion.w),
        ]);
      }
    }
    return st;
  }

  function entryOf(model) {
    const e = model.entry;
    return { name: e.name, url: e.url, format: e.format || null, cloud: Boolean(e.cloud) };
  }

  function sceneMessage(withPose) {
    return {
      models: state.models.filter(shareable).map((model) => ({
        ...modelState(model, withPose), entry: entryOf(model),
      })),
      sec: [state.sectionMode, r3(state.sectionT)],
    };
  }

  const fingerprint = (st) => JSON.stringify({ ...st, uid: undefined });

  function tick(now) {
    if (m.status !== "bagli") return;
    const withPose = Boolean(state.session);

    // Paylasilamayan (yerel dosyadan acilmis) modeli bir kez uyar.
    if (!m.warnedLocal && state.models.some((x) => !shareable(x))) {
      m.warnedLocal = true;
      api.hud("Yerel dosya odada paylasilamaz: once buluta yukle", 4000);
    }

    const structure = state.models.filter(shareable).map((x) => `${x.uid}:${x.entry.url}`).join("|");
    if (structure !== m.lastStructure) {
      m.lastStructure = structure;
      const scene = sceneMessage(withPose);
      for (const st of scene.models) m.lastSent.set(st.uid, fingerprint({ ...st, entry: undefined }));
      for (const x of state.models) x.synced = true;
      send({ t: "scene", scene });
      m.lastScene = now;
      m.sceneDirty = false;
      return;
    }

    if (now - m.lastState >= STATE_INTERVAL) {
      m.lastState = now;
      const changedModels = [];
      for (const model of state.models) {
        if (!shareable(model)) continue;
        const held = model.holder.parent !== state.scene;
        if (!held && model.remoteAt && now - model.remoteAt < ECHO_GUARD) continue;
        const st = modelState(model, withPose);
        const fp = fingerprint(st);
        if (m.lastSent.get(model.uid) === fp) continue;
        m.lastSent.set(model.uid, fp);
        changedModels.push(st);
      }
      const sec = `${state.sectionMode}:${r3(state.sectionT)}`;
      const secChanged = sec !== m.lastSection;
      m.lastSection = sec;
      if (changedModels.length || secChanged) {
        send({ t: "state", models: changedModels, sec: secChanged ? [state.sectionMode, r3(state.sectionT)] : undefined });
        m.sceneDirty = true;
      }
    }

    // Sunucudaki tam sahne ara ara tazelenir (sonradan katilan icin).
    if (m.sceneDirty && now - m.lastScene >= SCENE_INTERVAL) {
      m.lastScene = now;
      m.sceneDirty = false;
      send({ t: "scene", scene: sceneMessage(withPose) });
    }

    if (withPose && now - m.lastPose >= POSE_INTERVAL) {
      m.lastPose = now;
      sendPose();
    }
  }

  function sendPose() {
    const cam = state.renderer.xr.getCamera();
    cam.updateMatrixWorld(true);
    _mat.multiplyMatrices(m.toShared, cam.matrixWorld).decompose(_pos, _quat, _scl);
    const msg = { t: "p", h: [r3(_pos.x), r3(_pos.y), r3(_pos.z), r3(_quat.x), r3(_quat.y), r3(_quat.z), r3(_quat.w)], hands: [] };
    for (const input of state.inputs) {
      if (!input.source || !input.tracked) continue;
      if (input.isHand) {
        const pts = [];
        for (const name of JOINTS) {
          const j = input.hand.joints[name];
          if (!j || !j.visible) { pts.length = 0; break; }
          j.getWorldPosition(_pos).applyMatrix4(m.toShared);
          pts.push(r3(_pos.x), r3(_pos.y), r3(_pos.z));
        }
        if (pts.length) msg.hands.push({ j: pts });
      } else {
        input.grip.updateMatrixWorld(true);
        _mat.multiplyMatrices(m.toShared, input.grip.matrixWorld).decompose(_pos, _quat, _scl);
        msg.hands.push({ g: [r3(_pos.x), r3(_pos.y), r3(_pos.z), r3(_quat.x), r3(_quat.y), r3(_quat.z), r3(_quat.w)] });
      }
    }
    send(msg);
  }

  // --- mesaj -> sahne ------------------------------------------------------------

  /**
   * Odanin sahnesini uygular. replace: odaya yeni katildik, bizdeki modeller
   * odadakilerle degisir. Degilse yalnizca daha once esitlenmis (synced)
   * modeller silinir: bizim yeni ekledigimiz henuz gonderilmemis olabilir.
   */
  async function applyScene(scene, replace) {
    if (scene.sec) applySection(scene.sec);
    const remote = new Map(scene.models.map((st) => [st.uid, st]));
    for (const model of [...state.models]) {
      if (remote.has(model.uid)) continue;
      if (replace || model.synced) api.removeModel(model);
    }
    for (const st of scene.models) {
      const local = state.models.find((x) => x.uid === st.uid);
      if (local) {
        applyModelState(local, st);
        continue;
      }
      if (m.pending.has(st.uid)) continue;
      m.pending.add(st.uid);
      try {
        const model = await api.addRemoteModel(st.entry, st.uid);
        model.synced = true;
        applyModelState(model, st);
      } catch (err) {
        console.warn("odadaki model yuklenemedi", err);
        api.hud(`Odadaki model yuklenemedi: ${st.entry && st.entry.name}`, 3000);
      } finally {
        m.pending.delete(st.uid);
      }
    }
    m.lastStructure = state.models.filter(shareable).map((x) => `${x.uid}:${x.entry.url}`).join("|");
  }

  function applySection(sec) {
    const [mode, t] = sec;
    if (mode === state.sectionMode && Math.abs(t - state.sectionT) < 1e-3) return;
    state.sectionMode = mode;
    state.sectionT = t;
    m.lastSection = `${mode}:${r3(t)}`;
    api.applySection();
    api.refreshUi();
  }

  function applyModelState(model, st) {
    model.synced = true;
    model.remoteAt = performance.now();
    const held = model.holder.parent !== state.scene;

    if (st.p && !held && state.session) {
      _mat.compose(
        _pos.set(st.p[0], st.p[1], st.p[2]),
        _quat.set(st.q[0], st.q[1], st.q[2], st.q[3]),
        _scl.setScalar(st.s)).premultiply(m.fromShared);
      _mat.decompose(model.holder.position, model.holder.quaternion, model.holder.scale);
    }
    if (st.op !== undefined && (Math.abs(st.op - model.opacity) > 1e-3 || st.real !== model.realistic)) {
      api.setModelLook(model, st.op, st.real);
    }
    if (st.ex !== undefined && st.ex !== model.explodeTarget) api.setExplode(model, st.ex);

    // Fizik: karsi taraf hesapliyorsa biz birakiriz ve sonucunu uygulariz.
    if (st.phys) {
      if (model.physics) {
        model.physics = false;
        api.removeBodies(model);
      }
      model.remotePhysics = true;
      if (st.parts && st.parts.length === model.parts.length + 1 && !held) {
        [model.root, ...model.parts].forEach((o, i) => {
          const a = st.parts[i];
          o.position.set(a[0], a[1], a[2]);
          o.quaternion.set(a[3], a[4], a[5], a[6]);
        });
      }
    } else {
      model.remotePhysics = false;
    }
    // Bu durum artik "gonderilmis" sayilir: yanki olmasin.
    m.lastSent.set(model.uid, fingerprint(modelState(model, Boolean(state.session))));
    api.refreshUi();
  }

  // --- hizalama ------------------------------------------------------------------

  function startCalibration() {
    if (!state.session) {
      api.hud("Hizalama gozlukte yapilir");
      return;
    }
    m.calibrating = { points: [] };
    markers.clear();
    api.hud("1/2: Masanin SOL on kosesine isaret parmagini degdir, cimdik yap (kumandada tetik)", 8000);
    changed();
  }

  function capturePoint(p) {
    if (!m.calibrating) return false;
    const pts = m.calibrating.points;
    pts.push(p.clone());
    const dot = new THREE.Mesh(new THREE.SphereGeometry(0.008, 12, 8),
      new THREE.MeshBasicMaterial({ color: 0x3ddc97, depthTest: false }));
    dot.position.copy(p);
    dot.renderOrder = 12;
    markers.add(dot);
    if (pts.length === 1) {
      api.hud("2/2: Ayni masanin SAG on kosesine dokun, cimdik yap", 8000);
      changed();
      return true;
    }
    const [a, b] = pts;
    const dir = new THREE.Vector3(b.x - a.x, 0, b.z - a.z);
    if (dir.length() < 0.1) {
      m.calibrating.points = [];
      markers.clear();
      api.hud("Noktalar cok yakin (en az 10 cm): bastan, 1. noktaya dokun", 5000);
      changed();
      return true;
    }
    // Ortak uzay: orijin 1. nokta (zeminde), +Z = 1 -> 2 yonu.
    const yaw = Math.atan2(dir.x, dir.z);
    m.fromShared.compose(new THREE.Vector3(a.x, 0, a.z),
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw), new THREE.Vector3(1, 1, 1));
    m.toShared.copy(m.fromShared).invert();
    m.calibrated = true;
    m.calibrating = null;
    setTimeout(() => markers.clear(), 3000);
    // Hizalanan taraf odanin sahnesini yeniden ister gibi: son durumu uygula.
    m.lastSent.clear();
    api.hud(m.peers.size ? "Hizalandi: modeller ikinizde ayni yerde" : "Hizalandi", 3000);
    changed();
    return true;
  }

  function resetCalibration() {
    m.calibrated = false;
    m.calibrating = null;
    m.toShared.identity();
    m.fromShared.identity();
    markers.clear();
    changed();
  }

  return {
    get active() { return m.status === "bagli"; },
    get calibrating() { return Boolean(m.calibrating); },
    info,
    getName,
    create,
    connect,
    leave: () => leave(false),
    startCalibration,
    capturePoint,
    onChange: (fn) => listeners.add(fn),
    update(now) {
      tick(now);
      for (const p of m.peers.values()) p.avatar.face(state.session ? api.headPos() : state.camera.position);
    },
    sessionStarted() {
      // Her oturumda local-floor baslangici degisir: hizalama yeniden gerekir.
      resetCalibration();
      m.lastSent.clear();
      if (m.status === "bagli") api.hud(`Oda ${m.code} · menu > Oda > Hizala`, 4000);
    },
    sessionEnded() {
      resetCalibration();
      for (const p of m.peers.values()) p.avatar.hide();
    },
  };
}

// --- avatar ------------------------------------------------------------------------

const _av = new THREE.Vector3();
const _aq = new THREE.Quaternion();
const _as = new THREE.Vector3();
const _am = new THREE.Matrix4();

/** Karsi tarafin basi (gozluk sekli + isim) ve elleri (eklem noktalari). */
class Avatar {
  constructor(scene, name, color) {
    this.group = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.4, transparent: true, opacity: 0.85 });
    this.head = new THREE.Group();
    const visor = new THREE.Mesh(new THREE.BoxGeometry(0.19, 0.1, 0.1), mat);
    const strap = new THREE.Mesh(new THREE.TorusGeometry(0.095, 0.012, 8, 24), mat);
    strap.rotation.x = Math.PI / 2;
    strap.position.z = 0.06;
    visor.position.z = -0.02;
    this.head.add(visor, strap);
    this.label = new Label(0.18);
    this.label.set(name);
    this.group.add(this.head, this.label.mesh);

    const jointGeo = new THREE.SphereGeometry(0.007, 8, 6);
    this.hands = [0, 1].map(() => {
      const g = new THREE.Group();
      g.userData.joints = Array.from({ length: 25 }, () => {
        const s = new THREE.Mesh(jointGeo, mat);
        g.add(s);
        return s;
      });
      g.userData.controller = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.04, 0.12), mat);
      g.add(g.userData.controller);
      g.visible = false;
      this.group.add(g);
      return g;
    });
    this.group.visible = false;
    scene.add(this.group);
  }

  update(msg, fromShared) {
    this.group.visible = true;
    const h = msg.h;
    _am.compose(_av.set(h[0], h[1], h[2]), _aq.set(h[3], h[4], h[5], h[6]), _as.set(1, 1, 1))
      .premultiply(fromShared);
    _am.decompose(this.head.position, this.head.quaternion, _as);
    this.label.mesh.position.copy(this.head.position).add(_av.set(0, 0.17, 0));
    this.label.mesh.visible = true;

    this.hands.forEach((g, i) => {
      const hand = msg.hands && msg.hands[i];
      g.visible = Boolean(hand);
      if (!hand) return;
      const { joints, controller } = g.userData;
      if (hand.j) {
        controller.visible = false;
        joints.forEach((s, k) => {
          s.visible = true;
          s.position.set(hand.j[k * 3], hand.j[k * 3 + 1], hand.j[k * 3 + 2]).applyMatrix4(fromShared);
        });
      } else if (hand.g) {
        for (const s of joints) s.visible = false;
        controller.visible = true;
        const a = hand.g;
        _am.compose(_av.set(a[0], a[1], a[2]), _aq.set(a[3], a[4], a[5], a[6]), _as.set(1, 1, 1))
          .premultiply(fromShared);
        _am.decompose(controller.position, controller.quaternion, _as);
      }
    });
  }

  face(headPos) {
    if (this.label.mesh.visible) this.label.mesh.lookAt(headPos);
  }

  hide() { this.group.visible = false; }

  dispose() { this.group.removeFromParent(); }
}
