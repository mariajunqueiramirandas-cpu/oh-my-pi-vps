# Changelog

## [Unreleased]

### Added

- Added `omp-hub`, a self-hosted server that runs omp coding sessions in per-session sandboxes on their own branches, with an HTTP and WebSocket API for driving them from a phone.
- Added repository mirroring, configurable sandbox environments (image or inline Dockerfile, limits, network, secrets, setup steps, omp settings), and API-defined environments limited to what cannot widen the sandbox.
- Added a live session event stream, answering agent questions remotely, sandboxed diffs, leased branch publishing, GitHub pull requests, and ntfy push notifications.
- Added device tokens with a pairing QR code, idle auto-stop with resume-on-prompt, and recovery of interrupted sessions after a restart.
- Added a phone-friendly web app served by the hub: sessions, live transcripts, answering the agent's questions, diffs, pushing branches, pull requests, repositories, environments and devices.
- Added a settings page for the default model and thinking effort (from omp's provider catalog), API keys, instructions, always-on rules, rules for specific files, system prompt additions, omp settings and custom providers, applied to every new session.
- Added failed-login throttling behind a reverse proxy (`listen.trustProxy`), a strict content security policy, and sign-in links that open the web app.
- Added subscription sign-in from the phone (Mistral Vibe, Claude Pro/Max, ChatGPT, Copilot and every other omp sign-in), kept in an embedded auth broker that agents use through the hub without ever holding refresh tokens.
- Added toolkit images: omp extension packages an image ships under `/opt/omp/extensions` (MCP servers, skills, rules) and its `PI_CONFIG_FILES` defaults reach every session that uses it.
- Added a reverse-engineering environment image with REA's MCP server and skill, Ghidra 12.2, JADX, Apktool, Binwalk, Unblob, Rizin, WABT, Wakaru, pwntools and TShark, preconfigured and pinned by checksum.
