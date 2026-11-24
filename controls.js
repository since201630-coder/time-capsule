// 걷기 컨트롤: 눈높이 고정, 수평 이동만. 데스크톱(WASD+마우스)과 모바일(조이스틱+드래그) 지원.
import * as THREE from "three";

const WALK_SPEED = 1.4; // m/s, 보통 걸음
const RUN_SPEED = 3.5; // Shift
const MOUSE_SENS = 0.0022; // rad / px
const TOUCH_SENS = 0.005;
const PITCH_LIMIT = THREE.MathUtils.degToRad(85);

export class WalkControls {
  /**
   * @param {THREE.Camera} camera
   * @param {HTMLElement} canvas
   * @param {object} opts
   * @param {number} opts.groundY 발이 닿는 높이 (startPosition[1])
   * @param {number} opts.eyeHeight 눈높이 (m)
   * @param {{min:number[], max:number[]}|null} opts.bounds 이동 범위 [x, z]
   * @param {HTMLElement} opts.joystick 모바일 조이스틱 요소
   */
  constructor(camera, canvas, { groundY, eyeHeight, bounds, joystick }) {
    this.camera = camera;
    this.canvas = canvas;
    this.groundY = groundY;
    this.eyeHeight = eyeHeight;
    this.bounds = bounds;
    this.joystick = joystick;
    this.knob = joystick.querySelector(".knob");

    this.yaw = 0;
    this.pitch = 0;
    this.enabled = false;
    this.fly = false; // 디버그 전용
    this.keys = new Set();
    this.stick = { x: 0, y: 0 }; // -1..1
    this.lookPointer = null;
    this.stickPointer = null;

    this.#bindKeyboardMouse();
    this.#bindTouch();
  }

  /** 발 위치와 바라볼 지점으로 초기 자세를 잡는다 */
  setPose(feet, lookAt) {
    this.camera.position.set(feet.x, feet.y + this.eyeHeight, feet.z);
    const dir = new THREE.Vector3().subVectors(lookAt, this.camera.position);
    if (dir.lengthSq() < 1e-8) dir.set(0, 0, -1);
    dir.normalize();
    this.yaw = Math.atan2(-dir.x, -dir.z);
    this.pitch = THREE.MathUtils.clamp(Math.asin(dir.y), -PITCH_LIMIT, PITCH_LIMIT);
    this.#applyRotation();
  }

  #applyRotation() {
    this.camera.quaternion.setFromEuler(new THREE.Euler(this.pitch, this.yaw, 0, "YXZ"));
  }

  #look(dx, dy, sens) {
    this.yaw -= dx * sens;
    this.pitch = THREE.MathUtils.clamp(this.pitch - dy * sens, -PITCH_LIMIT, PITCH_LIMIT);
    this.#applyRotation();
  }

  #bindKeyboardMouse() {
    // e.code를 써서 한글 자판 상태에서도 WASD가 동작하게 한다
    window.addEventListener("keydown", (e) => {
      if (e.target instanceof HTMLInputElement) return;
      this.keys.add(e.code);
    });
    window.addEventListener("keyup", (e) => this.keys.delete(e.code));
    window.addEventListener("blur", () => this.keys.clear());

    this.canvas.addEventListener("click", () => {
      if (this.enabled && !this.isTouch && document.pointerLockElement !== this.canvas) {
        Promise.resolve(this.canvas.requestPointerLock?.()).catch(() => {});
      }
    });
    document.addEventListener("mousemove", (e) => {
      if (this.enabled && document.pointerLockElement === this.canvas) {
        this.#look(e.movementX, e.movementY, MOUSE_SENS);
      }
    });
  }

  #bindTouch() {
    this.isTouch = matchMedia("(pointer: coarse)").matches;

    // 화면 드래그로 둘러보기 (조이스틱 이외 영역)
    this.canvas.addEventListener("pointerdown", (e) => {
      if (!this.enabled || e.pointerType === "mouse" || this.lookPointer !== null) return;
      this.lookPointer = e.pointerId;
      this.lastLook = { x: e.clientX, y: e.clientY };
      this.canvas.setPointerCapture(e.pointerId);
    });
    this.canvas.addEventListener("pointermove", (e) => {
      if (e.pointerId !== this.lookPointer) return;
      this.#look(e.clientX - this.lastLook.x, e.clientY - this.lastLook.y, TOUCH_SENS);
      this.lastLook = { x: e.clientX, y: e.clientY };
    });
    const endLook = (e) => {
      if (e.pointerId === this.lookPointer) this.lookPointer = null;
    };
    this.canvas.addEventListener("pointerup", endLook);
    this.canvas.addEventListener("pointercancel", endLook);

    // 조이스틱으로 이동
    const js = this.joystick;
    const updateStick = (e) => {
      const r = js.getBoundingClientRect();
      const radius = r.width / 2;
      let x = (e.clientX - (r.left + radius)) / radius;
      let y = (e.clientY - (r.top + radius)) / radius;
      const len = Math.hypot(x, y);
      if (len > 1) { x /= len; y /= len; }
      this.stick = { x, y };
      this.knob.style.transform = `translate(${x * radius * 0.6}px, ${y * radius * 0.6}px)`;
    };
    js.addEventListener("pointerdown", (e) => {
      if (!this.enabled) return;
      this.stickPointer = e.pointerId;
      js.setPointerCapture(e.pointerId);
      updateStick(e);
    });
    js.addEventListener("pointermove", (e) => {
      if (e.pointerId === this.stickPointer) updateStick(e);
    });
    const endStick = (e) => {
      if (e.pointerId !== this.stickPointer) return;
      this.stickPointer = null;
      this.stick = { x: 0, y: 0 };
      this.knob.style.transform = "";
    };
    js.addEventListener("pointerup", endStick);
    js.addEventListener("pointercancel", endStick);
  }

  update(dt) {
    if (!this.enabled) return;
    const k = this.keys;
    let forward = 0;
    let strafe = 0;
    if (k.has("KeyW") || k.has("ArrowUp")) forward += 1;
    if (k.has("KeyS") || k.has("ArrowDown")) forward -= 1;
    if (k.has("KeyD") || k.has("ArrowRight")) strafe += 1;
    if (k.has("KeyA") || k.has("ArrowLeft")) strafe -= 1;
    forward -= this.stick.y;
    strafe += this.stick.x;

    const run = k.has("ShiftLeft") || k.has("ShiftRight") || Math.hypot(this.stick.x, this.stick.y) > 0.95;
    const speed = run ? RUN_SPEED : WALK_SPEED;
    const mag = Math.hypot(forward, strafe);
    if (mag > 1) { forward /= mag; strafe /= mag; }

    // 시선의 수평 성분만 사용 → 위를 보며 걸어도 떠오르지 않는다
    const sin = Math.sin(this.yaw);
    const cos = Math.cos(this.yaw);
    const pos = this.camera.position;
    pos.x += (-sin * forward + cos * strafe) * speed * dt;
    pos.z += (-cos * forward - sin * strafe) * speed * dt;

    if (this.fly) {
      if (k.has("KeyE")) pos.y += speed * dt;
      if (k.has("KeyQ")) pos.y -= speed * dt;
    } else {
      pos.y = this.groundY + this.eyeHeight;
    }

    if (this.bounds && !this.fly) {
      pos.x = THREE.MathUtils.clamp(pos.x, this.bounds.min[0], this.bounds.max[0]);
      pos.z = THREE.MathUtils.clamp(pos.z, this.bounds.min[1], this.bounds.max[1]);
    }
  }
}
