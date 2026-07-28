/**
 * Controls — touch first, keyboard and mouse as a bonus.
 *
 * Most Usion players are on a phone in a WebView, so the primary scheme is a
 * left-thumb stick and right-thumb buttons, with a drag-anywhere-on-the-right
 * look control. Desktop players get WASD + mouse look without a second code
 * path: both feed the same input object the simulation consumes.
 *
 * The same stick drives walking and driving — push forward to accelerate,
 * left/right to steer — so getting into a car never means learning a second
 * control scheme. That is the "one obvious affordance" rule applied to input.
 */
const CSS = `
.uw-controls{position:absolute;inset:0;pointer-events:none;touch-action:none;-webkit-user-select:none;user-select:none}
.uw-stick{position:absolute;width:132px;height:132px;border-radius:50%;border:2px solid rgba(255,255,255,.35);
  background:rgba(0,0,0,.18);pointer-events:none;opacity:0;transition:opacity .12s}
.uw-stick.on{opacity:1}
.uw-knob{position:absolute;left:50%;top:50%;width:56px;height:56px;margin:-28px 0 0 -28px;border-radius:50%;
  background:rgba(255,255,255,.8);box-shadow:0 2px 10px rgba(0,0,0,.35)}
.uw-buttons{position:absolute;right:16px;bottom:22px;display:grid;grid-template-columns:repeat(2,auto);gap:12px;
  pointer-events:auto;justify-items:end}
.uw-btn{width:68px;height:68px;border-radius:50%;border:0;background:rgba(20,22,26,.62);color:#fff;
  font:600 13px/1 system-ui,-apple-system,'Segoe UI',sans-serif;letter-spacing:.02em;
  display:flex;align-items:center;justify-content:center;text-align:center;padding:6px;
  backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);box-shadow:0 4px 14px rgba(0,0,0,.3);
  touch-action:none;cursor:pointer}
.uw-btn:active,.uw-btn.on{background:rgba(255,90,60,.9)}
.uw-btn:focus-visible{outline:3px solid #fff;outline-offset:2px}
.uw-btn.wide{width:96px;border-radius:34px}
.uw-btn[hidden]{display:none}
@media (min-width:900px){.uw-buttons{opacity:.55}}
`;

export function createControls(root, options = {}) {
  const labels = options.labels || {};
  const style = document.createElement('style');
  style.textContent = CSS;
  root.appendChild(style);

  const layer = document.createElement('div');
  layer.className = 'uw-controls';
  root.appendChild(layer);

  const stick = document.createElement('div');
  stick.className = 'uw-stick';
  const knob = document.createElement('div');
  knob.className = 'uw-knob';
  stick.appendChild(knob);
  layer.appendChild(stick);

  const buttons = document.createElement('div');
  buttons.className = 'uw-buttons';
  layer.appendChild(buttons);

  const input = {
    mx: 0, mz: 0, aim: 0,
    jump: false, sprint: false, dive: false,
    throttle: 0, steer: 0, handbrake: false,
    fire: false, use: false,
    aimX: 0, aimY: 0, aimZ: 1,
    weapon: null,
  };
  const look = { yaw: options.yaw || 0, pitch: 0.28 };
  let driving = false;

  function makeButton(key, label, aria, opts = {}) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'uw-btn' + (opts.wide ? ' wide' : '');
    btn.textContent = label;
    btn.setAttribute('aria-label', aria || label);
    btn.dataset.key = key;
    const set = (on) => {
      if (opts.toggle) {
        if (!on) return;
        input[key] = !input[key];
        btn.classList.toggle('on', input[key]);
        btn.setAttribute('aria-pressed', input[key] ? 'true' : 'false');
        return;
      }
      input[key] = on;
      btn.classList.toggle('on', on);
    };
    btn.addEventListener('pointerdown', (ev) => { ev.preventDefault(); btn.setPointerCapture?.(ev.pointerId); set(true); });
    btn.addEventListener('pointerup', () => set(false));
    btn.addEventListener('pointercancel', () => set(false));
    btn.addEventListener('lostpointercapture', () => set(false));
    btn.addEventListener('keydown', (ev) => { if (ev.key === ' ' || ev.key === 'Enter') { ev.preventDefault(); set(true); } });
    btn.addEventListener('keyup', (ev) => { if (ev.key === ' ' || ev.key === 'Enter') set(false); });
    if (opts.toggle) btn.setAttribute('aria-pressed', 'false');
    buttons.appendChild(btn);
    return btn;
  }

  const btnFire = makeButton('fire', labels.fire || 'Fire', labels.fireAria || 'Fire weapon');
  const btnUse = makeButton('use', labels.use || 'Enter', labels.useAria || 'Enter or leave vehicle');
  const btnJump = makeButton('jump', labels.jump || 'Jump', labels.jumpAria || 'Jump');
  const btnDive = makeButton('dive', labels.dive || 'Dive', labels.diveAria || 'Dive');
  const btnBrake = makeButton('handbrake', labels.drift || 'Drift', labels.driftAria || 'Handbrake drift');
  btnBrake.hidden = true;

  /** Swap the button set when the player gets in or out of a car. */
  function setDriving(on) {
    if (driving === on) return;
    driving = on;
    btnJump.hidden = on;
    btnDive.hidden = on;
    btnBrake.hidden = !on;
    btnUse.textContent = on ? (labels.exit || 'Exit') : (labels.use || 'Enter');
    btnUse.setAttribute('aria-label', on ? (labels.exitAria || 'Leave vehicle') : (labels.useAria || 'Enter vehicle'));
    input.jump = false;
    input.dive = false;
    input.handbrake = false;
  }

  // ---- virtual stick ------------------------------------------------------
  const RADIUS = 58;
  let stickPointer = null;
  let stickOX = 0;
  let stickOZ = 0;
  let lookPointer = null;
  let lookX = 0;
  let lookY = 0;

  function onPointerDown(ev) {
    if (ev.target.closest && ev.target.closest('.uw-btn')) return;
    const rect = root.getBoundingClientRect();
    const x = ev.clientX - rect.left;
    const y = ev.clientY - rect.top;
    if (x < rect.width * 0.5 && stickPointer === null) {
      stickPointer = ev.pointerId;
      stickOX = x;
      stickOZ = y;
      stick.style.left = (x - 66) + 'px';
      stick.style.top = (y - 66) + 'px';
      stick.classList.add('on');
      knob.style.transform = 'translate(0px, 0px)';
    } else if (lookPointer === null) {
      lookPointer = ev.pointerId;
      lookX = x;
      lookY = y;
    }
  }

  function onPointerMove(ev) {
    const rect = root.getBoundingClientRect();
    const x = ev.clientX - rect.left;
    const y = ev.clientY - rect.top;
    if (ev.pointerId === stickPointer) {
      let dx = x - stickOX;
      let dy = y - stickOZ;
      const len = Math.hypot(dx, dy);
      if (len > RADIUS) { dx = (dx / len) * RADIUS; dy = (dy / len) * RADIUS; }
      knob.style.transform = `translate(${dx}px, ${dy}px)`;
      input.mx = dx / RADIUS;
      input.mz = -dy / RADIUS;
    } else if (ev.pointerId === lookPointer) {
      look.yaw += (x - lookX) * 0.006;
      look.pitch = Math.max(-0.35, Math.min(1.15, look.pitch + (y - lookY) * 0.004));
      lookX = x;
      lookY = y;
    }
  }

  function onPointerUp(ev) {
    if (ev.pointerId === stickPointer) {
      stickPointer = null;
      stick.classList.remove('on');
      input.mx = 0;
      input.mz = 0;
    } else if (ev.pointerId === lookPointer) {
      lookPointer = null;
    }
  }

  root.addEventListener('pointerdown', onPointerDown);
  root.addEventListener('pointermove', onPointerMove);
  root.addEventListener('pointerup', onPointerUp);
  root.addEventListener('pointercancel', onPointerUp);
  root.addEventListener('contextmenu', (ev) => ev.preventDefault());

  // ---- keyboard / mouse ---------------------------------------------------
  const keys = Object.create(null);
  function onKey(down) {
    return (ev) => {
      const k = ev.key.length === 1 ? ev.key.toLowerCase() : ev.key;
      if (['w', 'a', 's', 'd', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
        ' ', 'Shift', 'Control', 'f', 'e', 'q'].indexOf(k) === -1) return;
      keys[k] = down;
      if (k === 'f' || k === 'e') input.use = down;
      if (k === ' ') input.jump = down;
      if (k === 'Shift') input.sprint = down;
      if (k === 'Control' || k === 'q') { input.dive = down; input.handbrake = down; }
      ev.preventDefault();
    };
  }
  window.addEventListener('keydown', onKey(true));
  window.addEventListener('keyup', onKey(false));
  root.addEventListener('mousedown', (ev) => { if (ev.button === 0 && !ev.target.closest('.uw-btn')) input.fire = true; });
  window.addEventListener('mouseup', () => { input.fire = false; });

  /** Fold keyboard state into the stick vector and derive driving inputs. */
  function sample() {
    if (stickPointer === null) {
      const kx = (keys.d || keys.ArrowRight ? 1 : 0) - (keys.a || keys.ArrowLeft ? 1 : 0);
      const kz = (keys.w || keys.ArrowUp ? 1 : 0) - (keys.s || keys.ArrowDown ? 1 : 0);
      input.mx = kx;
      input.mz = kz;
    }
    if (driving) {
      input.throttle = input.mz;
      input.steer = input.mx;
    } else {
      input.throttle = 0;
      input.steer = 0;
    }
    input.aim = look.yaw;
    // Aim ray from the camera yaw/pitch — the server re-normalises it anyway.
    const cp = Math.cos(-look.pitch + 0.28);
    input.aimX = Math.sin(look.yaw) * cp;
    input.aimY = Math.sin(-look.pitch + 0.28);
    input.aimZ = Math.cos(look.yaw) * cp;
    return input;
  }

  return {
    input,
    look,
    sample,
    setDriving,
    setLabels(next) {
      Object.assign(labels, next);
      btnFire.textContent = labels.fire || 'Fire';
      btnJump.textContent = labels.jump || 'Jump';
      btnDive.textContent = labels.dive || 'Dive';
      btnBrake.textContent = labels.drift || 'Drift';
      btnUse.textContent = driving ? (labels.exit || 'Exit') : (labels.use || 'Enter');
    },
    destroy() {
      root.removeEventListener('pointerdown', onPointerDown);
      root.removeEventListener('pointermove', onPointerMove);
      root.removeEventListener('pointerup', onPointerUp);
      root.removeEventListener('pointercancel', onPointerUp);
      layer.remove();
      style.remove();
    },
  };
}
