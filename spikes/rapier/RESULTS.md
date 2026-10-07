# Rapier spike — results (2026-10-07)

Question: can Rapier (`@dimforge/rapier3d-deterministic-compat` 0.21.0) be the
physics core of the Usion universe engine — running the same simulation on the
server (authority) and on phones (prediction)?

**Answer: yes.** Same results on every engine and CPU tested, fast enough on
server and phone, and it runs inside the platform's room sandbox with three
small shims. One platform change is needed (bundle size cap).

## Test scene (`scene.mjs`, shared by every host)

A Blender-scale map (one 128×128 trimesh = 32k triangles + a city of boxes),
players on Rapier's character controller (capsules, autostep, snap to ground,
jumps), cars with ray-cast wheels and suspension (Sketchbook's car model), and
towers of loose boxes (stacking/tumbling). Inputs are scripted from integer
hashes of (entity, tick); no `Math.random`, `Date`, `sin`/`cos`.

| Profile | Map | Players | Cars | Boxes | Other | Step |
|---|---|---|---|---|---|---|
| `server` | 128² trimesh + city | 200 | 50 | 100 | — | 1/30 s |
| `client` | same | 1 | 1 | 20 | 30 remote-player proxies | 1/60 s |
| `det` | 48² trimesh + city | 40 | 10 | 40 | — | 1/30 s |

## Results

### Same result everywhere (hash of every body's position + rotation)

| Host | `det` 300 ticks | `server` 600 ticks | `client` 600 ticks |
|---|---|---|---|
| Node 26, Apple ARM | `84164aac` | `3314de0c` | `0dcfc544` |
| Node 22, **Intel x86** (Rosetta) | `84164aac` | `3314de0c` | `0dcfc544` |
| Chromium (Android's engine) | `84164aac` | — | `0dcfc544` |
| **WebKit 26.5 (iPhone's engine)** | `84164aac` | — | `0dcfc544` |
| isolated-vm sandbox (rooms-runtime) | `84164aac` | `3314de0c` | — |

Also identical: two runs in one process, and **snapshot → restore mid-run →
continue** (with and without cars). Rapier's snapshot does not include our
controllers; recreating the character and vehicle controllers from handles
after restore was enough to stay identical.

### Speed

| What | Result |
|---|---|
| Server: 200 players + 50 cars + 100 boxes, per 30 Hz tick | **3.7 ms** avg, 4.2 ms p95 (budget 33 ms; rooms-runtime prod budget 50 ms). First tick ~37 ms (warm-up). |
| Same inside isolated-vm sandbox | 3.7 ms per tick (no slowdown) |
| Phone prediction step (`client`), desktop Chromium | 0.07 ms |
| Same at 4× / 6× CPU slowdown (low-end phone) | 0.25 / **0.36 ms** avg, 0.8 / 1.3 ms p95 (budget 16 ms) |
| WebKit | 0.07 ms (timer resolution 1 ms) |
| Rapier start-up in the browser | 40 ms (24 ms WebKit; 104 ms at 6× slowdown) |
| New room sandbox incl. Rapier init | **~50 ms** |
| Full-world snapshot (client scene) | 3.3 MB, take 1.1 ms, restore 0.9 ms |

### Size

| File | Raw | gzip | brotli |
|---|---|---|---|
| WebAssembly (`rapier_wasm3d_bg.wasm`) — phones download this | 3.1 MB | 1.17 MB | **0.86 MB** |
| `-compat` single JS file (wasm inlined as base64) | 4.3 MB | 1.66 MB | — |

For comparison, Sketchbook's current bundle is 2.1 MB.

### Inside the rooms-runtime sandbox (isolated-vm 6, 128 MB, JS intrinsics only)

Works, after three shims in the sandbox bootstrap:

1. **`TextDecoder` is missing** — the bundle creates one at load and fails
   without it. A ~10-line UTF-8 decoder is enough.
2. **Async WebAssembly compilation never completes** inside isolated-vm
   (polled sync: stays pending forever; `eval({promise:true})`: hangs at 0% CPU,
   even its timeout never fires). Fix: replace `WebAssembly.instantiate` with
   a synchronous compile returning an already-resolved promise; init then
   finishes in the microtask drain of the same `evalSync`.
3. **`performance` is missing** — Rapier's step timers call
   `performance.now()`, and without it the first `world.step()` traps
   (`RuntimeError: unreachable`). `{ now: () => Date.now() }` is enough (used
   for profiling counters only; results stay identical).

Blocker for hosted mode as-is: **the 4.3 MB bundle is far over the 512 KB
`server_bundle_url` cap.** The runtime should provide Rapier itself (like the
blessed Phaser/Babylon vendor builds), so game bundles stay small.

Isolate heap stayed small (≈9 MB heap + 9.5 MB external with a live 200-player
world). Whether isolated-vm's 128 MB `memoryLimit` counts WebAssembly memory
was NOT verified — check before relying on it.

## What this does not prove yet

- Real devices. WebKit/Chromium ran on a Mac; run `page.html` on a real
  iPhone and a low-end Android and compare the two hashes.
- Linux server hardware (the prod host is ARM Graviton; Railway is x86 Linux).
- Full-world snapshots are 3.3 MB because they include the static map, so
  rollback must NOT snapshot the whole world on phones: predict only your own
  character/vehicle (reset it and replay inputs) and keep everything else
  server-driven.
- Long runs (hours) and very large maps.

## Re-run

```bash
cd spikes/rapier && npm install
node node-bench.mjs                    # speed, repeatability, snapshot/restore
node sanity.mjs                        # things actually move; nothing falls through
python3 -m http.server 4199 --bind 127.0.0.1 &   # then:
node browser-bench.cjs                 # Chromium 1x/4x/6x + WebKit (needs: npx playwright install webkit)
cd sandbox && npm install isolated-vm@6 && node ivm-test.cjs && node ivm-boot.cjs
```
(`browser-bench.cjs` loads Playwright from `~/usion-sketchbook/node_modules`.)
