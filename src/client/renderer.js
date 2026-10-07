/**
 * Renderer — draws the world with Babylon.js.
 *
 * Babylon is a *renderer* here, not a physics engine: the authoritative
 * simulation is the engine core, shared with the server. Running Havok on top
 * would give two solvers that disagree, and disagreement is exactly what
 * makes multiplayer feel broken.
 *
 * Static geometry is generated from the world manifest and merged per colour,
 * so a city of several hundred buildings costs a handful of draw calls. Only
 * the things that move — players, vehicles, bullets, hazards — are updated
 * per frame, and only the ones near the camera.
 */
const MAX_RENDERED_PLAYERS = 48;
const MAX_RENDERED_VEHICLES = 32;

function color3(hex) {
  return BABYLON.Color3.FromHexString(hex);
}

/** A wedge (ramp) mesh: the box top slopes up along local +Z. */
function createRampMesh(name, w, h, d, scene) {
  const mesh = new BABYLON.Mesh(name, scene);
  const hx = w / 2;
  const hy = h / 2;
  const hz = d / 2;
  const positions = [
    // bottom
    -hx, -hy, -hz, hx, -hy, -hz, hx, -hy, hz, -hx, -hy, hz,
    // slope (from the low edge at -Z up to the high edge at +Z)
    -hx, -hy, -hz, hx, -hy, -hz, hx, hy, hz, -hx, hy, hz,
    // back wall
    -hx, -hy, hz, hx, -hy, hz, hx, hy, hz, -hx, hy, hz,
    // sides
    -hx, -hy, -hz, -hx, -hy, hz, -hx, hy, hz,
    hx, -hy, -hz, hx, -hy, hz, hx, hy, hz,
  ];
  const indices = [
    0, 2, 1, 0, 3, 2,          // bottom
    4, 5, 6, 4, 6, 7,          // slope
    8, 10, 9, 8, 11, 10,       // back
    12, 13, 14,                // left
    15, 17, 16,                // right
  ];
  const data = new BABYLON.VertexData();
  data.positions = positions;
  data.indices = indices;
  const normals = [];
  BABYLON.VertexData.ComputeNormals(positions, indices, normals);
  data.normals = normals;
  data.applyToMesh(mesh);
  return mesh;
}

export function createRenderer(canvas, manifest, options = {}) {
  const engine = new BABYLON.Engine(canvas, true, {
    adaptToDeviceRatio: true,
    preserveDrawingBuffer: false,
    stencil: false,
    powerPreference: 'high-performance',
  });
  engine.setHardwareScalingLevel(options.hardwareScaling || 1);

  const scene = new BABYLON.Scene(engine);
  const theme = manifest.theme;
  const sky = color3(theme.sky);
  scene.clearColor = new BABYLON.Color4(sky.r, sky.g, sky.b, 1);
  scene.ambientColor = new BABYLON.Color3(0.35, 0.36, 0.4);
  scene.fogMode = BABYLON.Scene.FOGMODE_EXP2;
  scene.fogColor = color3(theme.fog);
  scene.fogDensity = options.fogDensity ?? 0.0022;
  scene.collisionsEnabled = false;
  scene.autoClearDepthAndStencil = false;

  const camera = new BABYLON.UniversalCamera('cam', new BABYLON.Vector3(0, 12, -20), scene);
  camera.minZ = 0.25;
  camera.maxZ = options.viewDistance ?? 900;
  camera.fov = 0.95;
  scene.activeCamera = camera;

  const sun = new BABYLON.DirectionalLight('sun', new BABYLON.Vector3(-0.45, -1, 0.4), scene);
  sun.intensity = 1.15;
  const sky1 = new BABYLON.HemisphericLight('sky', new BABYLON.Vector3(0, 1, 0), scene);
  sky1.intensity = 0.55;
  sky1.diffuse = color3(theme.fog);
  sky1.groundColor = color3(theme.ground);

  const materials = new Map();
  function material(hex, opts = {}) {
    const key = hex + (opts.emissive ? '|e' : '') + (opts.alpha ? '|a' + opts.alpha : '');
    let mat = materials.get(key);
    if (mat) return mat;
    mat = new BABYLON.StandardMaterial('m' + materials.size, scene);
    mat.diffuseColor = color3(hex);
    mat.specularColor = new BABYLON.Color3(0.05, 0.05, 0.06);
    if (opts.emissive) mat.emissiveColor = color3(hex).scale(0.5);
    if (opts.alpha) mat.alpha = opts.alpha;
    mat.freeze();
    materials.set(key, mat);
    return mat;
  }

  // ---- static world -------------------------------------------------------
  // A world with no ground (`groundY: null`, e.g. an obstacle course in the
  // sky) gets a sea far below instead: falling should look like falling.
  const voidWorld = manifest.groundY === null;
  const ground = BABYLON.MeshBuilder.CreateGround('ground', {
    width: (manifest.bounds.maxX - manifest.bounds.minX) + 400,
    height: (manifest.bounds.maxZ - manifest.bounds.minZ) + 400,
  }, scene);
  ground.position.set(
    (manifest.bounds.maxX + manifest.bounds.minX) / 2,
    voidWorld ? (manifest.killY ?? -25) + 4 : (manifest.groundY ?? 0),
    (manifest.bounds.maxZ + manifest.bounds.minZ) / 2,
  );
  ground.material = material(voidWorld ? theme.water : theme.ground, voidWorld ? { emissive: true } : {});
  ground.freezeWorldMatrix();

  buildStatics();

  function buildStatics() {
    const byColor = new Map();
    for (const solid of manifest.solids) {
      const kind = solid.kind || 'box';
      const hex = solid.color
        || (solid.tag === 'road' ? theme.road
          : solid.tag === 'pavement' ? '#8d8f8a'
            : solid.tag === 'plaza' ? '#b9b2a4'
              : solid.tag === 'course' ? '#5d7fa8'
                : solid.tag === 'ramp' ? theme.accent
                  : theme.buildings[0]);
      const mesh = kind === 'ramp'
        ? createRampMesh('s', solid.hx * 2, solid.hy * 2, solid.hz * 2, scene)
        : BABYLON.MeshBuilder.CreateBox('s', {
          width: solid.hx * 2, height: solid.hy * 2, depth: solid.hz * 2,
        }, scene);
      mesh.position.set(solid.x, solid.y, solid.z);
      mesh.rotation.y = solid.ry || 0;
      let bucket = byColor.get(hex);
      if (!bucket) byColor.set(hex, (bucket = []));
      bucket.push(mesh);
    }
    for (const [hex, meshes] of byColor) {
      // One merged mesh per colour: hundreds of buildings, a few draw calls.
      const merged = meshes.length > 1
        ? BABYLON.Mesh.MergeMeshes(meshes, true, true, undefined, false, false)
        : meshes[0];
      if (!merged) continue;
      merged.material = material(hex);
      merged.isPickable = false;
      merged.freezeWorldMatrix();
      merged.alwaysSelectAsActiveMesh = false;
    }

    // Mesh geometry (e.g. exported from Blender): one Babylon mesh each.
    for (const m of manifest.meshes || []) {
      const mesh = new BABYLON.Mesh('mesh', scene);
      const data = new BABYLON.VertexData();
      data.positions = m.vertices;
      data.indices = m.indices;
      const normals = [];
      BABYLON.VertexData.ComputeNormals(m.vertices, m.indices, normals);
      data.normals = normals;
      data.applyToMesh(mesh);
      mesh.material = material(m.color || theme.buildings[0]);
      mesh.material.backFaceCulling = false;
      mesh.isPickable = false;
      mesh.freezeWorldMatrix();
    }

    // Props are decoration only — the server does not know they exist.
    // Shape props (`box` / `sphere` / `cylinder` with a colour) are merged per
    // colour like solids, so a course full of candy costs a few draw calls.
    const props = [];
    const shapesByColor = new Map();
    for (const prop of manifest.props || []) {
      if (prop.kind === 'box' || prop.kind === 'sphere' || prop.kind === 'cylinder') {
        const mesh = prop.kind === 'box'
          ? BABYLON.MeshBuilder.CreateBox('pb', { width: prop.w || 1, height: prop.h || 1, depth: prop.d || 1 }, scene)
          : prop.kind === 'sphere'
            ? BABYLON.MeshBuilder.CreateSphere('ps', { diameter: prop.d || 1, segments: 10 }, scene)
            : BABYLON.MeshBuilder.CreateCylinder('pc', { height: prop.h || 1, diameter: prop.d || 0.3, tessellation: 12 }, scene);
        mesh.position.set(prop.x, prop.y || 0, prop.z);
        mesh.rotation.set(prop.rx || 0, prop.ry || 0, prop.rz || 0);
        const hex = prop.color || theme.accent;
        let bucket = shapesByColor.get(hex);
        if (!bucket) shapesByColor.set(hex, (bucket = []));
        bucket.push(mesh);
        continue;
      }
      let mesh;
      if (prop.kind === 'tree') {
        mesh = BABYLON.MeshBuilder.CreateCylinder('p', { height: 5, diameterTop: 3.4, diameterBottom: 0.5, tessellation: 6 }, scene);
        mesh.position.set(prop.x, (prop.y || 0) + 2.5, prop.z);
      } else {
        mesh = BABYLON.MeshBuilder.CreateCylinder('p', { height: 5.5, diameter: 0.22, tessellation: 5 }, scene);
        mesh.position.set(prop.x, (prop.y || 0) + 2.75, prop.z);
      }
      mesh.rotation.y = prop.ry || 0;
      props.push({ mesh, kind: prop.kind });
    }
    for (const [hex, meshes] of shapesByColor) {
      const merged = meshes.length > 1
        ? BABYLON.Mesh.MergeMeshes(meshes, true, true, undefined, false, false)
        : meshes[0];
      if (!merged) continue;
      merged.material = material(hex);
      merged.isPickable = false;
      merged.freezeWorldMatrix();
    }
    const trees = props.filter(p => p.kind === 'tree').map(p => p.mesh);
    const lamps = props.filter(p => p.kind !== 'tree').map(p => p.mesh);
    for (const [list, hex] of [[trees, '#4e6b45'], [lamps, '#4a4d52']]) {
      if (!list.length) continue;
      const merged = list.length > 1
        ? BABYLON.Mesh.MergeMeshes(list, true, true, undefined, false, false)
        : list[0];
      if (!merged) continue;
      merged.material = material(hex);
      merged.isPickable = false;
      merged.freezeWorldMatrix();
    }
  }

  // ---- hazards ------------------------------------------------------------
  const moverMeshes = new Map();
  for (const spec of manifest.movers || []) {
    const mesh = BABYLON.MeshBuilder.CreateBox('mv', {
      width: spec.w || 1, height: spec.h || 1, depth: spec.d || 1,
    }, scene);
    mesh.material = material(spec.color || (spec.kind === 'platform' || spec.kind === 'conveyor' ? '#6d7a8c' : theme.accent), { emissive: true });
    mesh.isPickable = false;
    moverMeshes.set(spec.id, mesh);
  }

  // ---- checkpoint gates ---------------------------------------------------
  const gateMeshes = [];
  for (const cp of manifest.checkpoints || []) {
    const gate = BABYLON.MeshBuilder.CreateTorus('cp', {
      diameter: (cp.radius || 9) * 1.6, thickness: 0.7, tessellation: 16,
    }, scene);
    gate.position.set(cp.x, (cp.y || 0) + 5, cp.z);
    gate.rotation.x = Math.PI / 2;
    gate.rotation.y = cp.ry || 0;
    gate.material = material(cp.start ? '#ffd166' : theme.accent, { emissive: true, alpha: 0.75 });
    gate.isPickable = false;
    gate.setEnabled(false);
    gateMeshes.push({ cp, mesh: gate });
  }

  // ---- entity pools -------------------------------------------------------
  // Avatars: the default humanoid, or `avatar: 'bean'` — a round jelly-bean
  // body with big eyes (party games). Both expose root + tinted parts.
  const bean = options.avatar === 'bean';
  const playerPool = createPool(() => {
    const root = new BABYLON.TransformNode('pl', scene);
    if (bean) {
      const body = BABYLON.MeshBuilder.CreateCapsule('b', { height: 1.8, radius: 0.55, tessellation: 14, subdivisions: 4 }, scene);
      body.position.y = 0.9;
      body.parent = root;
      const eyes = [];
      for (const side of [-1, 1]) {
        const eye = BABYLON.MeshBuilder.CreateSphere('e', { diameter: 0.34, segments: 8 }, scene);
        eye.position.set(side * 0.2, 1.38, 0.43);
        eye.parent = root;
        const pupil = BABYLON.MeshBuilder.CreateSphere('pu', { diameter: 0.16, segments: 6 }, scene);
        pupil.position.set(side * 0.2, 1.38, 0.59);
        pupil.parent = root;
        eye.material = material('#ffffff', { emissive: true });
        pupil.material = material('#1c1f24');
        eyes.push(eye, pupil);
      }
      return { root, body, head: null, nose: null, eyes };
    }
    const body = BABYLON.MeshBuilder.CreateCapsule('b', { height: 1.7, radius: 0.4 }, scene);
    body.position.y = 0.85;
    body.parent = root;
    const head = BABYLON.MeshBuilder.CreateSphere('h', { diameter: 0.52, segments: 6 }, scene);
    head.position.y = 1.62;
    head.parent = root;
    const nose = BABYLON.MeshBuilder.CreateBox('n', { width: 0.16, height: 0.16, depth: 0.36 }, scene);
    nose.position.set(0, 1.6, 0.3);
    nose.parent = root;
    return { root, body, head, nose };
  });

  const rollerPool = createPool(() => {
    const mesh = BABYLON.MeshBuilder.CreateSphere('ro', { diameter: 2, segments: 14 }, scene);
    return { root: mesh };
  });

  const vehiclePool = createPool(() => {
    const root = new BABYLON.TransformNode('vh', scene);
    const body = BABYLON.MeshBuilder.CreateBox('vb', { width: 1.9, height: 0.9, depth: 4.4 }, scene);
    body.position.y = 0.75;
    body.parent = root;
    const cabin = BABYLON.MeshBuilder.CreateBox('vc', { width: 1.6, height: 0.7, depth: 2.1 }, scene);
    cabin.position.set(0, 1.45, -0.15);
    cabin.parent = root;
    const wheels = [];
    for (let i = 0; i < 4; i++) {
      const wheel = BABYLON.MeshBuilder.CreateCylinder('vw', { height: 0.3, diameter: 0.72, tessellation: 10 }, scene);
      wheel.rotation.z = Math.PI / 2;
      wheel.parent = root;
      wheels.push(wheel);
    }
    return { root, body, cabin, wheels };
  });

  const bulletPool = createPool(() => {
    const mesh = BABYLON.MeshBuilder.CreateSphere('bu', { diameter: 0.45, segments: 4 }, scene);
    mesh.material = material('#ffcc33', { emissive: true });
    return { root: mesh };
  });

  const pickupPool = createPool(() => {
    const mesh = BABYLON.MeshBuilder.CreateBox('pk', { size: 0.75 }, scene);
    return { root: mesh };
  });

  // Tracer lines for hitscan shots — a pooled ribbon of short-lived lines.
  const tracers = [];

  function createPool(factory) {
    const items = [];
    let used = 0;
    return {
      begin() { used = 0; },
      take() {
        let item = items[used];
        if (!item) { item = factory(); items.push(item); }
        used += 1;
        setEnabled(item, true);
        return item;
      },
      end() {
        for (let i = used; i < items.length; i++) setEnabled(items[i], false);
      },
    };
  }

  function setEnabled(item, on) {
    // Babylon walks the ancestor chain, so disabling the root hides children.
    item.root.setEnabled(on);
  }

  const teamColors = options.playerColors || ['#ff5a3c', '#3ca0ff', '#3cd18a', '#ffd166', '#c084fc', '#f472b6'];
  function colorForId(id) {
    let h = 0;
    for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
    return teamColors[h % teamColors.length];
  }

  /**
   * Draw one frame.
   * @param {object} view  {entities, meId, cameraTarget, movers, time}
   */
  function render(view) {
    playerPool.begin();
    vehiclePool.begin();
    bulletPool.begin();
    pickupPool.begin();
    rollerPool.begin();

    const camX = camera.position.x;
    const camZ = camera.position.z;
    const list = view.entities;
    let playersDrawn = 0;
    let vehiclesDrawn = 0;

    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      const dx = e.wx - camX;
      const dz = e.wz - camZ;
      if (dx * dx + dz * dz > camera.maxZ * camera.maxZ) continue;

      if (e.k === 'p') {
        if (e.v || e.id === view.hideId) continue;      // riders are drawn with the car
        if (playersDrawn++ > MAX_RENDERED_PLAYERS) continue;
        const item = playerPool.take();
        item.root.position.set(e.wx, e.wy, e.wz);
        item.root.rotation.y = e.a;
        const dead = e.d || e.hp <= 0;
        const tint = dead ? '#555a60' : (e.tm ? teamColors[e.tm.charCodeAt(0) % teamColors.length] : colorForId(e.id));
        const mat = material(tint);
        item.body.material = mat;
        if (item.head) item.head.material = mat;
        if (item.nose) item.nose.material = material('#1c1f24');
        item.root.rotation.x = e.s === 'dive' || e.s === 'stun' ? 1.15 : 0;
        item.root.position.y = e.wy + (e.s === 'dive' || e.s === 'stun' ? 0.35 : 0);
      } else if (e.k === 'v') {
        if (vehiclesDrawn++ > MAX_RENDERED_VEHICLES) continue;
        const item = vehiclePool.take();
        item.root.position.set(e.wx, e.wy, e.wz);
        item.root.rotation.set(e.p || 0, e.a, e.r || 0);
        const spec = VEHICLE_SCALE[e.t] || VEHICLE_SCALE.sedan;
        item.root.scaling.set(spec.sx, spec.sy, spec.sz);
        const wrecked = e.hp <= 0;
        item.body.material = material(wrecked ? '#3a3d42' : (e.vc || vehicleColor(e.id)));
        item.cabin.material = material('#20242b', { alpha: 0.85 });
        const spin = (view.time * (e.sp || 0)) % (Math.PI * 2);
        for (let w = 0; w < 4; w++) {
          const wheel = item.wheels[w];
          wheel.position.set(w % 2 === 0 ? -0.95 : 0.95, 0.36, w < 2 ? 1.35 : -1.35);
          wheel.rotation.x = spin;
          wheel.material = material('#191b1f');
        }
      } else if (e.k === 'o') {
        // Rolling ball (server physics): spin it by how far it has travelled.
        const item = rollerPool.take();
        const r = e.r || 1;
        item.root.position.set(e.wx, e.wy, e.wz);
        item.root.scaling.setAll(r);
        item.root.rotation.x = (e.wz || 0) / r;
        item.root.rotation.z = -(e.wx || 0) / r;
        item.root.material = material(options.rollerColor || theme.accent);
      } else if (e.k === 'b') {
        const item = bulletPool.take();
        item.root.position.set(e.wx, e.wy, e.wz);
      } else if (e.k === 'k') {
        const item = pickupPool.take();
        item.root.position.set(e.wx, e.wy + 0.9 + Math.sin(view.time * 2.5) * 0.15, e.wz);
        item.root.rotation.y = view.time;
        item.root.material = material(
          e.t === 'health' ? '#3cd18a' : e.t === 'boost' ? '#ffd166' : theme.accent,
          { emissive: true },
        );
      }
    }

    playerPool.end();
    vehiclePool.end();
    bulletPool.end();
    pickupPool.end();
    rollerPool.end();

    // Hazards: recomputed from world time, never received over the network.
    if (view.movers) {
      for (const m of view.movers) {
        const mesh = moverMeshes.get(m.id);
        if (!mesh) continue;
        mesh.position.set(m.solid.x, m.solid.y, m.solid.z);
        mesh.rotation.y = m.solid.ry;
      }
    }

    if (view.gates) {
      for (const g of gateMeshes) g.mesh.setEnabled(view.gates.has(g.cp.id));
    }

    for (let i = tracers.length - 1; i >= 0; i--) {
      const tr = tracers[i];
      tr.life -= view.dt;
      if (tr.life <= 0) {
        tr.mesh.dispose();
        tracers.splice(i, 1);
      } else {
        tr.mesh.visibility = Math.max(0, tr.life / tr.max);
      }
    }

    scene.render();
  }

  const VEHICLE_SCALE = {
    sedan: { sx: 1, sy: 1, sz: 1 },
    sport: { sx: 0.96, sy: 0.85, sz: 0.96 },
    truck: { sx: 1.32, sy: 1.7, sz: 1.45 },
    kart: { sx: 0.78, sy: 0.7, sz: 0.62 },
  };

  function vehicleColor(id) {
    return colorForId(id);
  }

  /** Draw a short-lived tracer for a hitscan shot. */
  function addTracer(x1, y1, z1, x2, y2, z2, life = 0.08) {
    const mesh = BABYLON.MeshBuilder.CreateLines('tr', {
      points: [new BABYLON.Vector3(x1, y1, z1), new BABYLON.Vector3(x2, y2, z2)],
    }, scene);
    mesh.color = color3('#ffe08a');
    mesh.isPickable = false;
    tracers.push({ mesh, life, max: life });
    if (tracers.length > 40) {
      const old = tracers.shift();
      old.mesh.dispose();
    }
  }

  function resize() {
    engine.resize();
  }

  function dispose() {
    scene.dispose();
    engine.dispose();
  }

  return { engine, scene, camera, render, resize, dispose, addTracer, material };
}
