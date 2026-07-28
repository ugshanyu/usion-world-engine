/**
 * HUD — health, weapon, objective, minimap, scoreboard, overlays.
 *
 * Every string is supplied by the caller (`labels`) and every number is
 * formatted with `Intl`, so the same HUD renders correctly in any language
 * the host app is running in. Layout is a fixed header / fixed footer with
 * the world in between, contrast meets WCAG AA against the sky, and nothing
 * here steals a touch that belongs to the controls.
 */
const CSS = `
.uw-hud{position:absolute;inset:0;pointer-events:none;color:#fff;
  font:500 14px/1.35 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;
  text-shadow:0 1px 3px rgba(0,0,0,.55)}
.uw-top{position:absolute;top:0;left:0;right:0;display:flex;justify-content:space-between;align-items:flex-start;
  gap:10px;padding:10px 12px}
.uw-card{background:rgba(14,16,20,.55);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);
  border-radius:12px;padding:8px 11px;min-width:0}
.uw-obj{font-weight:700;font-size:15px;display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
.uw-obj .uw-timer{font-variant-numeric:tabular-nums;opacity:.9}
.uw-sub{opacity:.8;font-size:12px;margin-top:2px}
.uw-board{list-style:none;margin:6px 0 0;padding:0;font-size:12px;max-width:190px}
.uw-board li{display:flex;justify-content:space-between;gap:10px;padding:1px 0;white-space:nowrap;overflow:hidden}
.uw-board li.me{color:#ffd166;font-weight:700}
.uw-board .nm{overflow:hidden;text-overflow:ellipsis}
.uw-bottom{position:absolute;left:12px;bottom:22px;display:flex;flex-direction:column;gap:8px;align-items:flex-start}
.uw-bar{width:168px;height:9px;border-radius:5px;background:rgba(0,0,0,.45);overflow:hidden}
.uw-bar i{display:block;height:100%;background:#3cd18a;transition:width .12s linear}
.uw-bar.low i{background:#ff5a3c}
.uw-weapon{font-size:13px;letter-spacing:.02em}
.uw-map{position:absolute;right:12px;bottom:110px;width:118px;height:118px;border-radius:12px;
  background:rgba(14,16,20,.5);overflow:hidden}
.uw-map canvas{width:100%;height:100%;display:block}
.uw-toasts{position:absolute;left:50%;top:64px;transform:translateX(-50%);display:flex;flex-direction:column;
  gap:6px;align-items:center;max-width:88vw}
.uw-toast{background:rgba(14,16,20,.62);border-radius:10px;padding:5px 12px;font-size:13px;animation:uwIn .16s ease-out}
@keyframes uwIn{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:none}}
.uw-overlay{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;
  gap:12px;background:rgba(8,10,14,.62);pointer-events:auto;text-align:center;padding:24px}
.uw-overlay[hidden]{display:none}
.uw-overlay h2{margin:0;font-size:22px;font-weight:700}
.uw-overlay p{margin:0;opacity:.85;max-width:32ch}
.uw-overlay button{pointer-events:auto;min-height:48px;padding:0 22px;border:0;border-radius:24px;
  background:#fff;color:#111;font:600 15px system-ui;cursor:pointer}
.uw-overlay button:focus-visible{outline:3px solid #ffd166;outline-offset:2px}
.uw-speed{font-variant-numeric:tabular-nums;font-size:20px;font-weight:700}
`;

export function createHud(root, options = {}) {
  const labels = Object.assign({
    health: 'Health', objective: 'Objective', leaderboard: 'Leaderboard',
    speed: 'km/h', connecting: 'Connecting…', retry: 'Retry',
  }, options.labels || {});
  const locale = options.locale || 'en';
  const numberFmt = new Intl.NumberFormat(locale);

  const style = document.createElement('style');
  style.textContent = CSS;
  root.appendChild(style);

  const hud = document.createElement('div');
  hud.className = 'uw-hud';
  hud.innerHTML = `
    <div class="uw-top">
      <div class="uw-card" role="status" aria-live="polite">
        <div class="uw-obj"><span class="uw-phase"></span><span class="uw-timer"></span></div>
        <div class="uw-sub"></div>
      </div>
      <div class="uw-card">
        <div class="uw-sub uw-boardtitle"></div>
        <ol class="uw-board"></ol>
      </div>
    </div>
    <div class="uw-toasts" role="log" aria-live="polite"></div>
    <div class="uw-bottom">
      <div class="uw-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100"><i style="width:100%"></i></div>
      <div class="uw-weapon"></div>
      <div class="uw-speed" hidden></div>
    </div>
    <div class="uw-map" aria-hidden="true"><canvas width="236" height="236"></canvas></div>
    <div class="uw-overlay" hidden><h2></h2><p></p><button type="button" hidden></button></div>
  `;
  root.appendChild(hud);

  const el = {
    phase: hud.querySelector('.uw-phase'),
    timer: hud.querySelector('.uw-timer'),
    sub: hud.querySelector('.uw-sub'),
    boardTitle: hud.querySelector('.uw-boardtitle'),
    board: hud.querySelector('.uw-board'),
    bar: hud.querySelector('.uw-bar'),
    barFill: hud.querySelector('.uw-bar i'),
    weapon: hud.querySelector('.uw-weapon'),
    speed: hud.querySelector('.uw-speed'),
    toasts: hud.querySelector('.uw-toasts'),
    overlay: hud.querySelector('.uw-overlay'),
    overlayTitle: hud.querySelector('.uw-overlay h2'),
    overlayText: hud.querySelector('.uw-overlay p'),
    overlayBtn: hud.querySelector('.uw-overlay button'),
    map: hud.querySelector('.uw-map canvas'),
  };
  el.boardTitle.textContent = labels.leaderboard;
  const mapCtx = el.map.getContext('2d');
  const toasts = [];

  function setObjective(phaseText, seconds, sub) {
    el.phase.textContent = phaseText || '';
    el.timer.textContent = seconds == null ? '' : formatClock(seconds);
    el.sub.textContent = sub || '';
  }

  function formatClock(seconds) {
    const s = Math.max(0, Math.round(seconds));
    const m = Math.floor(s / 60);
    return m > 0 ? `${m}:${String(s % 60).padStart(2, '0')}` : `${s}`;
  }

  function setHealth(hp, max = 100) {
    const pct = Math.max(0, Math.min(100, (hp / max) * 100));
    el.barFill.style.width = pct + '%';
    el.bar.classList.toggle('low', pct <= 30);
    el.bar.setAttribute('aria-valuenow', String(Math.round(hp)));
    el.bar.setAttribute('aria-label', `${labels.health}: ${Math.round(hp)}`);
  }

  function setWeapon(name, ammo) {
    if (!name) { el.weapon.textContent = ''; return; }
    const label = (labels.weapons && labels.weapons[name]) || name;
    el.weapon.textContent = ammo == null || ammo < 0 ? label : `${label} · ${numberFmt.format(ammo)}`;
  }

  function setSpeed(kmh) {
    if (kmh == null) { el.speed.hidden = true; return; }
    el.speed.hidden = false;
    el.speed.textContent = `${numberFmt.format(Math.round(kmh))} ${labels.speed}`;
  }

  function setBoard(rows, meId) {
    const html = rows.map((r) => (
      `<li class="${r.id === meId ? 'me' : ''}"><span class="nm">${escapeHtml(r.n)}</span>` +
      `<span>${numberFmt.format(r.s)}</span></li>`
    )).join('');
    if (el.board.innerHTML !== html) el.board.innerHTML = html;
  }

  function toast(text) {
    if (!text) return;
    const node = document.createElement('div');
    node.className = 'uw-toast';
    node.textContent = text;
    el.toasts.appendChild(node);
    toasts.push({ node, until: performance.now() + 3200 });
    if (toasts.length > 4) {
      const old = toasts.shift();
      old.node.remove();
    }
  }

  function tickToasts(now) {
    while (toasts.length && toasts[0].until < now) {
      toasts.shift().node.remove();
    }
  }

  function overlay(title, text, buttonLabel, onClick) {
    el.overlay.hidden = false;
    el.overlayTitle.textContent = title || '';
    el.overlayText.textContent = text || '';
    el.overlayBtn.hidden = !buttonLabel;
    el.overlayBtn.textContent = buttonLabel || '';
    el.overlayBtn.onclick = onClick || null;
    if (buttonLabel) el.overlayBtn.focus({ preventScroll: true });
  }

  function hideOverlay() {
    el.overlay.hidden = true;
  }

  /** North-up minimap: world bounds scaled into the little square. */
  function drawMap(view) {
    const b = view.bounds;
    const w = el.map.width;
    const spanX = (b.maxX - b.minX) || 1;
    const spanZ = (b.maxZ - b.minZ) || 1;
    const toX = (x) => ((x - b.minX) / spanX) * w;
    const toY = (z) => w - ((z - b.minZ) / spanZ) * w;
    mapCtx.clearRect(0, 0, w, w);
    mapCtx.fillStyle = 'rgba(255,255,255,.06)';
    mapCtx.fillRect(0, 0, w, w);
    if (view.checkpoints) {
      mapCtx.strokeStyle = 'rgba(255,209,102,.85)';
      mapCtx.lineWidth = 3;
      mapCtx.beginPath();
      view.checkpoints.forEach((cp, i) => {
        const x = toX(cp.x);
        const y = toY(cp.z);
        if (i === 0) mapCtx.moveTo(x, y); else mapCtx.lineTo(x, y);
      });
      mapCtx.closePath();
      mapCtx.stroke();
    }
    for (const e of view.entities) {
      if (e.k !== 'p' && e.k !== 'v') continue;
      mapCtx.fillStyle = e.k === 'v' ? 'rgba(120,190,255,.9)' : 'rgba(255,255,255,.75)';
      mapCtx.beginPath();
      mapCtx.arc(toX(e.wx), toY(e.wz), e.k === 'v' ? 3.5 : 3, 0, Math.PI * 2);
      mapCtx.fill();
    }
    if (view.me) {
      mapCtx.fillStyle = '#ff5a3c';
      mapCtx.beginPath();
      mapCtx.arc(toX(view.me.wx), toY(view.me.wz), 5, 0, Math.PI * 2);
      mapCtx.fill();
    }
  }

  function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  return {
    setObjective, setHealth, setWeapon, setSpeed, setBoard,
    toast, tickToasts, overlay, hideOverlay, drawMap,
    setLabels(next) { Object.assign(labels, next); el.boardTitle.textContent = labels.leaderboard; },
    destroy() { hud.remove(); style.remove(); },
  };
}
