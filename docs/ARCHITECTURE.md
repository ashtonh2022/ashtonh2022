# Architecture

Landlord is a TypeScript monorepo (pnpm workspaces). The rules live in one pure package that both the server and the client use, so the same engine can later ship inside a mobile (Capacitor) or desktop (Electron/Tauri, Steam) wrapper without changes.

```
packages/engine     @landlord/engine    pure rules, state machine, bot, hints (no DOM, no deps)
packages/protocol   @landlord/protocol  WebSocket message schemas (zod) and view types
apps/server         @landlord/server    authoritative game server: rooms, seats, timers, bots, static hosting
apps/web            @landlord/web       React + Vite client (PWA-ready), the only UI
docs/               RULES.md is the single source of truth for the rules and is rendered at /rules
e2e/                Playwright end-to-end tests (Chromium)
```

## Engine

`HandState` is the full state of one deal. `applyAction(state, seat, action)` is a pure reducer that returns a new state and a list of `HandEvent`s. `viewHand(state, seat)` produces the `HandView` a seat may see. `findPlays`, `hint`, `analyze` and `beats` are the combination logic. `bot.ts` is a heuristic player used to fill seats and to act for disconnected players. `scoring.ts` settles a finished hand exactly as in RULES.md.

Everything is deterministic: dealing takes a string seed, so a hand can be replayed in a test.

## Server

One Node process. HTTP serves the built web app (SPA fallback) and `/healthz`; `/ws` is the WebSocket endpoint. State is in memory (rooms are short-lived; a `RoomStore` interface keeps the door open for Redis or a database later).

- **Identity**: a player is a `playerId` plus a secret `token`, minted on first `hello` and stored by the client in localStorage. Reconnecting with the same pair re-attaches the player to their seat and room.
- **Rooms**: 6-character codes. A room has a host, seats (people or bots), spectators, `RuleSettings`, a running score, the current `HandState` and a chat log. The host can change rules in the lobby or between hands, add/remove bots, kick, and start hands.
- **Turns and timers**: the server owns one timer per room for the current decision (`deadline` is sent to clients). Bots act after a short delay. On timeout a connected human gets `timeoutAction`; a disconnected human's seat is played by the bot.
- **Broadcast**: after every change the server sends each connection its own `room_state` snapshot (personalised `HandView`). Chat and emotes are separate messages. Clients never need to diff events to stay correct; they may diff snapshots for sounds and animations.
- **Validation**: every inbound message is parsed with the zod schemas in `@landlord/protocol`; every game action goes through the engine, which rejects illegal moves.

## Web client

React + react-router + zustand. `src/net/client.ts` owns the WebSocket (auto-reconnect with backoff, resends `hello`). `src/store.ts` holds the latest `RoomView`, connection state and UI state. Pages: `/` (home: name, create room with options, join by code, link to `/rules`), `/room/:code` (lobby and table), `/rules` (renders `docs/RULES.md`). All user-facing strings live in `src/strings.ts`. Sounds are triggered through `src/audio.ts` from files in `public/audio/` (placeholders shipped).

## Future ports

- **Mobile**: wrap `apps/web` with Capacitor; the client already talks to the server by URL, so only the server URL becomes configurable.
- **Desktop / Steam**: wrap `apps/web` with Electron or Tauri. A local single-player mode can run the server in-process because the engine and the room logic have no Node-specific dependencies beyond `ws`.
