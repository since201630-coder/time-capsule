// 시공간박제 웹 뷰어 MVP
// 사용법: viewer/index.html?capsule=<박제 id>   (기본: sample)
//        &base=<capsules 폴더 경로>             (기본: ../capsules)
// 배포본은 index.html에서 window.CAPSULE_CONFIG = { capsule, base }로 기본값을 바꾼다
//        &debug=1                               (좌표 표시, F 비행 모드, C 현재 시점 복사)
import * as THREE from "three";
import { SparkRenderer, SplatMesh } from "@sparkjsdev/spark";
import { WalkControls } from "./controls.js";

// capsule.json에 viewer 필드가 없거나 일부만 있을 때 쓰는 기본값
const VIEWER_DEFAULTS = {
  startPosition: [0, 0, 0], // 시작 지점의 "발" 위치 [x, 바닥 높이, z]
  startLookAt: null, // 없으면 -Z 방향 수평
  eyeHeight: 1.6, // m
  splatRotation: [0, 0, 0], // 도 단위 오일러 XYZ. 뒤집힌 스플랫은 보통 [180, 0, 0]
  splatScale: 1,
  bounds: null, // { min: [x, z], max: [x, z] } 이동 범위 제한
};

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const config = window.CAPSULE_CONFIG || {};
const capsuleId = params.get("capsule") || config.capsule || "sample";
const base = (params.get("base") || config.base || "../capsules").replace(/\/$/, "");
const debug = params.get("debug") === "1";
const capsuleDir = `${base}/${encodeURIComponent(capsuleId)}/`;
const isTouch = matchMedia("(pointer: coarse)").matches;
document.body.classList.toggle("touch", isTouch);

main().catch(showError);

async function main() {
  if (location.protocol === "file:") {
    throw new Error("file:// 로는 열 수 없어요. 로컬 웹서버로 열어 주세요 (viewer/README.md 참고).");
  }

  const res = await fetch(new URL("capsule.json", new URL(capsuleDir, location.href)));
  if (!res.ok) throw new Error(`capsule.json을 찾을 수 없어요 (${res.status}): ${capsuleDir}capsule.json`);
  const capsule = await res.json();
  const view = resolveViewer(capsule.viewer);

  renderMeta(capsule);
  const audio = setupAudio(capsule);

  // --- three.js + Spark ---
  // 8GB 맥 / 모바일 부담을 줄이려고 픽셀 비율 상한을 둔다
  const renderer = new THREE.WebGLRenderer({ antialias: false });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
  renderer.setSize(innerWidth, innerHeight);
  $("app").appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0d0f12);
  const camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.05, 2000);
  scene.add(new SparkRenderer({ renderer }));

  const splatFile = capsule.assets?.splat;
  if (!splatFile) throw new Error("capsule.json의 assets.splat이 비어 있어요.");
  const splatUrl = new URL(splatFile, new URL(capsuleDir, location.href)).href;
  const splat = new SplatMesh({
    url: splatUrl,
    onProgress: (e) => {
      if (e.total) setProgress(e.loaded / e.total, `스플랫 내려받는 중 ${fmtMB(e.loaded)} / ${fmtMB(e.total)}`);
      else setProgress(null, `스플랫 내려받는 중 ${fmtMB(e.loaded)}`);
    },
  });
  const [rx, ry, rz] = view.splatRotation.map(THREE.MathUtils.degToRad);
  splat.rotation.set(rx, ry, rz, "XYZ");
  splat.scale.setScalar(view.splatScale);
  scene.add(splat);

  const feet = new THREE.Vector3(...view.startPosition);
  const lookAt = view.startLookAt
    ? new THREE.Vector3(...view.startLookAt)
    : feet.clone().add(new THREE.Vector3(0, view.eyeHeight, -1));
  const controls = new WalkControls(camera, renderer.domElement, {
    groundY: feet.y,
    eyeHeight: view.eyeHeight,
    bounds: view.bounds,
    joystick: $("joystick"),
  });
  controls.setPose(feet, lookAt);

  addEventListener("resize", () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  });

  const clock = new THREE.Clock();
  renderer.setAnimationLoop(() => {
    const dt = Math.min(clock.getDelta(), 0.1);
    controls.update(dt);
    renderer.render(scene, camera);
    if (debug) updateDebug(camera, controls);
  });

  await splat.initialized;
  setProgress(1, "준비 완료");
  const btn = $("enter-btn");
  btn.disabled = false;
  btn.addEventListener("click", () => {
    $("intro").classList.add("hidden");
    $("panel").classList.remove("hidden");
    if (isTouch) {
      $("joystick").classList.remove("hidden");
      $("panel").classList.add("collapsed"); // 모바일은 화면이 좁으니 접어서 시작
    } else {
      Promise.resolve(renderer.domElement.requestPointerLock?.()).catch(() => {});
    }
    controls.enabled = true;
    audio?.play();
  });

  if (debug) setupDebug(camera, controls, view, splat);
}

/** capsule.viewer를 기본값과 합치고 잘못된 값은 기본값으로 */
function resolveViewer(v = {}) {
  const vec = (a, n) => Array.isArray(a) && a.length === n && a.every(Number.isFinite);
  const num = (x) => typeof x === "number" && Number.isFinite(x);
  const out = { ...VIEWER_DEFAULTS };
  if (vec(v.startPosition, 3)) out.startPosition = v.startPosition;
  if (vec(v.startLookAt, 3)) out.startLookAt = v.startLookAt;
  if (num(v.eyeHeight) && v.eyeHeight > 0) out.eyeHeight = v.eyeHeight;
  if (vec(v.splatRotation, 3)) out.splatRotation = v.splatRotation;
  if (num(v.splatScale) && v.splatScale > 0) out.splatScale = v.splatScale;
  if (v.bounds && vec(v.bounds.min, 2) && vec(v.bounds.max, 2)) out.bounds = v.bounds;
  return out;
}

// ---------- 메타데이터 / 날씨 ----------
const NONE = "기록 없음";
const has = (x) => x !== null && x !== undefined && x !== "";

function renderMeta(c) {
  const title = c.title || c.id || "이름 없는 박제";
  document.title = `${title} · 시공간박제`;
  $("intro-title").textContent = title;
  $("m-title").textContent = title;

  const time = fmtRange(c.capturedAt?.start, c.capturedAt?.end);
  $("intro-time").textContent = time;
  $("m-time").textContent = time;

  const loc = c.location || {};
  const place = [loc.name, loc.address].filter(has).join(" · ");
  $("m-place").textContent = (place || NONE) + (has(loc.lengthMeters) ? ` (거리 ${loc.lengthMeters}m)` : "");

  const coord = $("m-coord");
  if (Number.isFinite(loc.lat) && Number.isFinite(loc.lng)) {
    const a = document.createElement("a");
    a.href = `https://www.openstreetmap.org/?mlat=${loc.lat}&mlon=${loc.lng}#map=18/${loc.lat}/${loc.lng}`;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = `${loc.lat.toFixed(5)}, ${loc.lng.toFixed(5)}`;
    coord.replaceChildren(a);
  } else {
    coord.textContent = NONE;
  }

  const w = c.weather || {};
  $("w-temp").textContent = Number.isFinite(w.temperatureC) ? `${w.temperatureC}°` : "–";
  $("w-cond").textContent = has(w.condition) ? w.condition : `하늘 상태 ${NONE}`;
  $("w-detail").textContent = [
    `습도 ${Number.isFinite(w.humidityPercent) ? w.humidityPercent + "%" : NONE}`,
    `바람 ${Number.isFinite(w.windMs) ? w.windMs + "m/s" : NONE}`,
  ].join(" · ");
  $("w-source").textContent = has(w.source) ? `출처: ${w.source}` : "";

  $("panel-toggle").addEventListener("click", () => $("panel").classList.toggle("collapsed"));
}

/** "2026-11-18T13:00:00+09:00" → 촬영지 현지 시각 그대로 표시 (브라우저 시간대로 바꾸지 않음) */
function fmtRange(start, end) {
  const parse = (s) => {
    const m = typeof s === "string" && s.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
    return m ? { date: `${m[1]}년 ${+m[2]}월 ${+m[3]}일`, time: `${m[4]}:${m[5]}` } : null;
  };
  const a = parse(start);
  const b = parse(end);
  if (!a) return NONE;
  if (!b) return `${a.date} ${a.time}`;
  return a.date === b.date ? `${a.date} ${a.time}–${b.time}` : `${a.date} ${a.time} – ${b.date} ${b.time}`;
}

// ---------- 오디오 ----------
function setupAudio(c) {
  const btn = $("audio-btn");
  const vol = $("volume");
  if (!c.assets?.audio) {
    btn.disabled = true;
    vol.disabled = true;
    $("audio-note").textContent = "녹음된 소리가 없어요.";
    return null;
  }
  const audio = new Audio(new URL(c.assets.audio, new URL(capsuleDir, location.href)).href);
  audio.loop = true;
  audio.preload = "auto";
  audio.volume = Number(vol.value);
  const sync = () => (btn.textContent = audio.paused ? "▶" : "❚❚");
  audio.addEventListener("play", sync);
  audio.addEventListener("pause", sync);
  audio.addEventListener("error", () => {
    $("audio-note").textContent = `소리 파일을 열 수 없어요: ${c.assets.audio}`;
    btn.disabled = true;
  });
  btn.addEventListener("click", () => (audio.paused ? audio.play() : audio.pause()));
  // iOS Safari는 audio.volume을 무시한다 (기기 볼륨 버튼으로만 조절)
  vol.addEventListener("input", () => (audio.volume = Number(vol.value)));
  return {
    play: () => audio.play().catch(() => ($("audio-note").textContent = "▶ 버튼을 눌러 소리를 켜 주세요.")),
  };
}

// ---------- 진행률 / 오류 ----------
function setProgress(ratio, text) {
  if (ratio !== null) $("progress-bar").style.width = `${Math.round(ratio * 100)}%`;
  $("progress-text").textContent = text;
}
const fmtMB = (b) => `${(b / 1048576).toFixed(1)}MB`;

function showError(err) {
  console.error(err);
  $("intro").classList.add("hidden");
  $("error").classList.remove("hidden");
  $("error-text").textContent = err?.message || String(err);
}

// ---------- 디버그 (?debug=1): viewer 값 잡을 때 사용 ----------
function setupDebug(camera, controls, view, splat) {
  $("debug").classList.remove("hidden");
  // 개발자 콘솔에서 시점·회전 조정용: __viewer.controls.setPose({x,y,z}, {x,y,z}), __viewer.splat.rotation
  window.__viewer = { camera, controls, view, splat, THREE };
  addEventListener("keydown", (e) => {
    if (e.code === "KeyF") controls.fly = !controls.fly;
    if (e.code === "KeyC") {
      const p = camera.position;
      const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
      const r = (x) => Math.round(x * 100) / 100;
      const feetY = controls.fly ? p.y - controls.eyeHeight : controls.groundY;
      const json = {
        startPosition: [r(p.x), r(feetY), r(p.z)],
        startLookAt: [r(p.x + dir.x * 10), r(p.y + dir.y * 10), r(p.z + dir.z * 10)],
        eyeHeight: view.eyeHeight,
        splatRotation: view.splatRotation,
        splatScale: view.splatScale,
        ...(view.bounds ? { bounds: view.bounds } : {}),
      };
      const text = JSON.stringify(json);
      navigator.clipboard?.writeText(text).catch(() => {});
      console.log('"viewer":', text);
    }
  });
}

function updateDebug(camera, controls) {
  const p = camera.position;
  $("debug").textContent =
    `pos  ${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)}\n` +
    `yaw  ${THREE.MathUtils.radToDeg(controls.yaw).toFixed(0)}°  pitch ${THREE.MathUtils.radToDeg(controls.pitch).toFixed(0)}°\n` +
    `mode ${controls.fly ? "비행(F) Q/E 상하" : "걷기"}\n` +
    `C: 현재 시점을 viewer JSON으로 복사`;
}
