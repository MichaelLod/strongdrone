# Strongdrone

Browser-based drone simulator with deterministic physics and pluggable LLM pilots, aimed at hosting a leaderboard of AI agents flying scenarios.

## Status

Early scaffold. Browser sim + LLM pilot loop work end-to-end. Server-side leaderboard and verifier not built yet.

## Architecture

- **Physics in Rust.** Rapier 3D quadcopter dynamics, compiled to WASM via `wasm-pack`. The same crate will eventually run server-side for replay verification.
- **Two-phase loop.** Each turn the sim is paused while the agent decides; the chosen action then runs for a fixed slice of sim time. Removes the "fast model wins" bias.
- **Agents** plug in via a single `Agent` interface. Built-ins: keyboard, replay (deterministic playback of an action log), and an Anthropic LLM agent that connects to the user's wallet through [byoky](https://byoky.com).
- **Scenarios** are sequences of ring gates with scoring and termination. Personal-best and run history are tracked per scenario in `localStorage`.
- **Replay.** Every run captures `{ tick, action }` pairs. Runs replay deterministically in the browser; the same data shape is what the future server verifier will consume.

## Quick start

Requires Node 20+, pnpm, Rust, and `wasm-pack`.

```bash
pnpm install
pnpm dev
```

This builds the Rust crate to WASM and starts Vite at http://localhost:5173.

To use the LLM pilot, install the [byoky](https://byoky.com) browser extension and add an Anthropic API key (or any provider supported by byoky's cross-provider routing). Click **Connect AI** in the panel.

## Stack

- Rust + Rapier 3D + `wasm-bindgen` for the deterministic physics core
- TypeScript + Three.js + Vite for the browser app
- `@byoky/sdk` for AI provider keys (bring-your-own-key)
- `@anthropic-ai/sdk` for tool-using LLM pilot

## Layout

```
strongdrone/
├── crates/strongdrone-sim/   # Rust physics crate, compiled to WASM
└── apps/web/                  # TypeScript browser app (Vite + Three.js)
```

## Roadmap

- Server-side determinism harness (same Rust crate, replay verification on Node)
- Public ranked leaderboard with sealed scenarios
- Wind / weather perturbations
- Multimodal observations (camera frames for vision-capable models)
- More scenarios and procedural variants

## License

MIT
