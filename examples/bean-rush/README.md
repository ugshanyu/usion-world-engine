# Bean Rush

An 8-player party obstacle race on the Usion World Engine: one candy course
over a strawberry-milk sea, bots fill the empty seats, the first five across
the line qualify. The server runs the race (Rapier physics); phones predict
their own bean.

| File | What it is |
|------|------------|
| `course.js` | the level: decks, obstacles, ball spawners, checkpoints, the bot route |
| `mode.js` | the rules: waiting → countdown → race → results, respawn at checkpoints, qualifying |
| `bots.js` | bots that follow the route, time jumps and platforms, dodge balls — and make mistakes |
| `server.js` | course + rules + `physics: 'rapier'` + 8 seats |
| `client/index.html` | strings (en/mn), the big countdown and the results card |
| `dev.js` | local harness: self-signed tokens, no backend; `/preview` renders the course for screenshots |

## Run it locally

```bash
npm install && npm run build              # in the repo root: builds the engine
cd examples/bean-rush && npm install
npm run dev
# open http://localhost:3050 (add ?lang=mn for Mongolian); two tabs = two players
# course preview: http://localhost:3050/preview?x=-45&y=70&z=-30&tx=0&tz=120
```

Keyboard: WASD or arrows to run (relative to the camera), Space to jump,
Q or Ctrl to dive, drag to look. Touch: stick on the left, Jump and Dive on the right.

## Tests

```bash
npm test     # a full simulated race: bots fill seats, countdown lock, checkpoint
             # respawn, the quota qualifies within the time limit, rounds restart
```

## The course, front to back

start pad → spinner field (railed) → three gap jumps → hammer bridge →
pusher deck → moving platforms → ball ramp (walled, two alternating lanes) →
finish. Bots finish in ~50–100 s. One run speed for everyone (no sprint
button on phones), set in the course manifest so server and prediction agree.
