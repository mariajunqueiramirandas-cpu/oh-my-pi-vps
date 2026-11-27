# omp-hub

Run omp coding agents on your own server and drive them from your phone's browser. Each session gets its own sandbox (a container) and its own branch on a repository you choose. From the web app you follow the agent live, answer its questions, review the diff, push the branch or open a pull request, and set the model, keys, instructions and rules every agent starts with.

```
phone browser ──HTTPS──▶ Caddy (your domain, automatic certificates)
                            │ 127.0.0.1:7480
                            ▼
                      omp-hub (Bun + Hono, SQLite, web app)
                       ├─ repositories   bare mirrors, fetched for every new session
                       ├─ settings       model, keys, instructions, rules → every agent
                       ├─ sessions       one checkout + one sandbox each, live event stream
                       └─ outward        git push with the server's credentials, GitHub PRs, ntfy
                            │ omp --mode rpc over stdio
                            ▼
                      ┌─────────────────────────────┐
                      │ container: /work /home/agent │  cap-drop ALL, no-new-privileges, limits
                      └─────────────────────────────┘
```

## Deploy on a VPS with your own domain

You need a VPS with Docker, a domain whose DNS you control, and about 2 GB RAM per concurrent session.

**1. Point the domain at the server.** Create an `A` record (and `AAAA` if you have IPv6) for, say, `hub.example.com`.

**2. Firewall.** Only SSH and HTTP(S) should be reachable. The hub itself listens on localhost.

```sh
ufw allow OpenSSH && ufw allow 80,443/tcp && ufw enable
```

**3. Install Bun and the hub.**

```sh
curl -fsSL https://bun.sh/install | bash
git clone <your fork> /opt/oh-my-pi && cd /opt/oh-my-pi && bun install
bun run pi:image          # the agent image (builds omp's native parts; takes a while once)
```

**4. Configure.** Copy the example and set your domain:

```sh
mkdir -p ~/.omp-hub && cp packages/hub/hub.example.yaml ~/.omp-hub/hub.yaml
```

```yaml
listen: { host: 127.0.0.1, port: 7480, trustProxy: true }
publicUrl: https://hub.example.com
```

`trustProxy` makes the hub read the client address from Caddy's `X-Forwarded-For`, so failed-login throttling applies to real clients instead of to Caddy.

**5. HTTPS with Caddy.** Caddy gets and renews Let's Encrypt certificates for the domain by itself and passes WebSockets through.

```caddyfile
# /etc/caddy/Caddyfile
hub.example.com {
	encode zstd gzip
	reverse_proxy 127.0.0.1:7480
}
```

**6. Run it as a service.**

```ini
# /etc/systemd/system/omp-hub.service
[Unit]
After=network-online.target docker.service

[Service]
User=omp
WorkingDirectory=/opt/oh-my-pi
ExecStart=/home/omp/.bun/bin/bun packages/hub/src/cli.ts serve
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

The `omp` user needs to be in the `docker` group and needs git credentials (an SSH key or credential helper) for private repositories. Pushes from the phone use those same credentials.

**7. Pair your phone.** On the server:

```sh
sudo -u omp bun /opt/oh-my-pi/packages/hub/src/cli.ts pair --name phone
```

It prints a QR code. Scan it: the link opens the web app and signs this phone in (the token travels in the URL fragment, which is never sent to the server). Then use your browser's **Add to Home screen** for an app-like icon. To add a laptop later, open **Settings → Devices** on the phone.

### Things to know

- **Model credentials.** Agents need at least one way to reach a model: a subscription under **Settings → Subscriptions** or a key under **Settings → API keys**. Without either, omp refuses to start (`No default model selected`).
- **Sandboxes can reach your server's open ports.** Containers on Docker's default network can connect to services the host binds to `0.0.0.0` (a database, another app). Bind internal services to `127.0.0.1`, or put them on their own Docker networks.
- **Restarting the hub** stops running agents. Their transcripts stay on disk and each session continues on its next message.

## The web app

| Screen | What you do there |
| --- | --- |
| Sessions | See what each agent is doing. A session that needs your answer is highlighted and sorted first. |
| A session | Read the conversation, answer the agent's questions, send messages (after the current step or as an interruption), stop it, view the diff, push the branch, open a pull request, run a command. |
| Repositories | Add repositories by clone URL; the hub mirrors them. |
| Settings | Default model and thinking effort, API keys, instructions, always-on rules, rules for specific files, advanced omp settings and custom providers, environments, devices. |

### Subscriptions (Mistral Vibe, Claude Pro/Max, ChatGPT, Copilot, …)

**Settings → Subscriptions → Sign in to a subscription** lists every sign-in omp supports. Pick one and follow the steps on the phone:

- **Mistral Vibe** opens Mistral's console. Approve access there and come back; the hub finishes on its own (it polls, like the Vibe CLI) and stores the key Mistral issues for your plan.
- **Device-code sign-ins** (Copilot, ChatGPT headless, Factory) show a page to open and a code to enter.
- **Browser sign-ins** (Claude Pro/Max, ChatGPT) redirect your phone to a `localhost` address on the server, which will not load. Copy that address from the browser and paste it into the hub; it contains the code that completes the sign-in.

Then pick a model from that provider under **Model**, or let omp choose.

How it works: the hub embeds omp's auth broker (the same vault and background refresher as `omp auth-broker serve`) over its own credential database in `~/.omp-hub/credentials/`. Agents connect to it as ordinary broker clients through the hub, at `<publicUrl>/sandbox-broker`, with a token issued for their session and revoked when it stops. They can read access tokens and keys and ask for refreshes; they cannot add, change or disable credentials, and refresh tokens never leave the hub. This matters because OAuth refresh tokens rotate: copies in several sandboxes would sign each other out.

Agents must be able to reach the hub at `publicUrl` (the default) or at `subscriptions.sandboxUrl`. With Caddy and your domain this works out of the box; on a server without a public name, set `sandboxUrl` to an address containers can reach, such as `http://172.17.0.1:7480` with the hub listening on that interface.

### Settings, and where they land in omp

Settings apply when a session starts. Running sessions keep what they started with; **Restart idle sessions now** stops idle ones so their next message picks up the new settings.

| Setting | In the agent's sandbox |
| --- | --- |
| Model, thinking effort | `modelRoles.default`, `defaultThinkingLevel` in a `--config` overlay |
| Subscriptions | The hub's auth broker (`OMP_AUTH_BROKER_URL` / `OMP_AUTH_BROKER_TOKEN` point the agent at it) |
| API keys | Environment variables (the provider list shows which variable each provider reads) |
| Instructions | `~/.omp/agent/AGENTS.md` |
| Always-on rules | `~/.omp/agent/RULES.md` (kept in view on every request, subagents included) |
| Rules for specific files | `~/.omp/agent/rules/<name>.md` with `description`, `globs`, `alwaysApply` |
| System prompt addition | `~/.omp/agent/APPEND_SYSTEM.md` |
| omp settings | Any `config.yml` setting, merged into the overlay |
| Custom providers | `~/.omp/agent/models.yml` |

The hub writes these files to a directory of its own, mounted read-only into the sandbox. A small launch script inside the sandbox copies them into place before starting omp, so the hub never writes into a directory the agent controls.

## CLI

| Command | |
| --- | --- |
| `omp-hub serve [--config f] [--port n]` | Start the hub |
| `omp-hub pair [--name phone]` | Create a device token and print its sign-in link and QR code |
| `omp-hub token create <name>` / `list` / `revoke <id>` | Manage tokens (works while the hub runs) |
| `omp-hub config` | Validate and print the resolved config |

## Environments

An environment is what a sandbox looks like: an `image`, or a `dockerfile` built on first use and tagged with its content hash, plus `resources`, `network`, `env`, named-volume `mounts`, `setup` commands run once per session, and an omp `settings` overlay. `hub.yaml` environments are operator-owned. Environments added from the app cannot use host mounts, host build contexts, extra runtime flags, networks outside `runtime.allowedNetworks`, or forward hub-process secrets outside `secrets.allow`.

The hub runs its own command in the image (`--entrypoint`), so an image's `ENTRYPOINT` (such as `oh-my-pi/pi:dev`'s `tini -- omp`) does not wrap it.

### Toolkit images: MCP servers and skills that come with the image

An image can bring its own omp setup, so picking an environment brings its tools:

- Every directory under `/opt/omp/extensions/` is loaded as an omp extension package (`--extension`): its `.mcp.json` servers, `skills/`, `rules/`, `commands/` and so on. Set `OMP_HUB_EXTENSIONS_DIR` in the image to use another directory.
- `PI_CONFIG_FILES=/path/config.yml` in the image sets omp defaults. They have the lowest precedence: the settings page and the environment's `settings` override them.

### Reverse engineering (REA, Ghidra, JADX, Binwalk, …)

[`environments/reverse-engineering`](environments/reverse-engineering/Dockerfile) builds such an image on top of `oh-my-pi/pi:dev`. It includes [REA](https://github.com/morluto/rea): its MCP server and its `reverse-engineer-anything` skill, both taken from the same pinned npm release. It also includes the engines REA drives, already wired up through `REA_*` variables:

| Engine | For |
| --- | --- |
| Ghidra 12.2 + JDK 25 | Native decompilation, through REA and through omp's own read-binary tool |
| JADX headless MCP 0.8.0, Apktool 3.0.3 | Android APK/DEX code and resources |
| Binwalk 3.1.0, Unblob 26.6.4 + extractors | Firmware inspection and extraction |
| Rizin 0.9.1, GDB, objdump | Disassembly and debugging |
| WABT 1.0.42, Wakaru 1.14.0 | WebAssembly, JavaScript bundle recovery |
| pwntools 4.15.0, TShark | Crash diagnostics, packet captures |
| Chromium (`--build-arg WITH_BROWSER=1`) | REA's browser and web-capture tools |

Agents reach REA's tools as `mcp__rea_*` commands in their shell. REA starts with its `hot-cold` catalog: five tools are listed up front, and the other ~260 load on demand through `mcp__rea_discover_tools`. Listing every tool would cost about 100k tokens on each request. The image also makes omp wait for REA to connect before a session starts.

Every download is pinned to a SHA-256. Hopper, IDA and JEB are commercial and not included; Kuna is not verified on Linux. The image is for linux/amd64 only, because Ghidra ships Linux decompiler natives only for x86-64. It is large (about 6 GB), so build it once rather than on a session's first start:

```sh
bun run pi:image                                     # oh-my-pi/pi:dev, from the repository root
bun run --cwd packages/hub image:reverse-engineering # omp-hub/reverse-engineering:dev
```

```yaml
# hub.yaml
environments:
  reverse-engineering:
    image: omp-hub/reverse-engineering:dev
    resources: { memory: 8g, cpus: 4, pids: 4096 } # Ghidra's JVM wants memory and threads
```

Put the binaries, APKs or firmware you want analyzed in the session's repository, or keep the default `bridge` network so the agent can download them. REA analyzes files without running them. Its debugger tools (GDB, Rizin) do run targets, inside the sandbox.

## Security model

- **`hub.yaml` is the trust root.** Anything that widens a sandbox (host mounts, extra flags, networks, which hub secrets are forwarded) is set only there. An environment from the app cannot pick the tag its Dockerfile builds into, so it cannot replace an image a `hub.yaml` environment runs.
- **The hub never runs git on a checkout an agent has touched.** That checkout's `.git/config`, hooks and attributes are the agent's. Diffs are computed inside a sandbox; publishing has a sandbox write a git bundle that the hub imports into its own mirror and pushes from. Pushes are leased against the last published commit, so a branch someone else moved is never overwritten without `force`.
- **Sandbox variables never pass through the container CLI's own environment.** They go in a private `--env-file`, so a variable like `LD_PRELOAD` affects only the sandbox. Image names, mount targets and variable names are validated so values from the app cannot become runtime flags.
- **Sandboxes** drop all capabilities, set `no-new-privileges`, limit pids (and memory and CPU when configured), and run as the hub's uid. Mirrors and settings are mounted read-only. Diff and publish run with no network. `runtime.ociRuntime: runsc` (gVisor) adds a user-space kernel between agents and the host.
- **Access.** Tokens are 256-bit and stored as SHA-256 digests. The event stream uses single-use 30-second tickets. Addresses that keep presenting bad tokens are throttled (a valid token always works). Responses carry a same-origin-only Content Security Policy, and the app renders agent output as text, never as markup.
- **Subscription logins** live in the embedded broker's database (`~/.omp-hub/credentials/`), which only the hub process reads. Agents get access tokens through a per-session, revocable broker token and can never write credentials or see refresh tokens.
- **API keys from Settings** are stored in the hub's SQLite file (keep `~/.omp-hub` private) and given to every agent sandbox. An agent can read them; use the omp auth gateway ([`docs/auth-broker-gateway.md`](../../docs/auth-broker-gateway.md)) with a custom provider if agents must never hold provider keys.
- `runtime.kind: host` runs agents as plain processes with your privileges. It is for development only, and `serve` says so on startup.
- The hub uses the git CLI directly (hooks off, no prompts, no `ext::`) rather than `@oh-my-pi/pi-natives/vcs`, which does not cover mirrors, shared clones, bundles or leased pushes.

## API

Every `/api` route needs `Authorization: Bearer <token>`; errors are `{ "error": "…" }`. `src/contract.ts` defines the JSON the web app relies on, and `src/contract-check.ts` makes `bun check` fail if a route stops matching it. `@oh-my-pi/omp-hub/client` is a typed `hono/client` for scripts.

| Route | |
| --- | --- |
| `GET /healthz` | Liveness, no auth |
| `GET /api/info` | Version, runtime, sandboxing, thinking levels |
| `GET/POST /api/repos`, `GET/DELETE /api/repos/:id`, `POST /api/repos/:id/refresh` | Repositories |
| `GET /api/environments`, `GET/PUT/DELETE /api/environments/:id`, `POST /api/environments/:id/build` | Environments |
| `GET/POST /api/sessions`, `GET/DELETE /api/sessions/:id` | Sessions |
| `POST /api/sessions/:id/{start,stop,abort}` | Lifecycle |
| `POST /api/sessions/:id/prompt` | `{ message, images?, mode?: "steer" \| "followUp" }`; restarts a stopped session |
| `POST /api/sessions/:id/respond` | `{ requestId, answer }` for a pending question |
| `POST /api/sessions/:id/bash` | `{ command, timeoutMs? }` |
| `GET /api/sessions/:id/{messages,diff,events}` | Transcript, changes since start, event backlog |
| `POST /api/sessions/:id/{publish,pull-request}` | Push the branch; open a pull request |
| `POST /api/sessions/:id/ticket` → `GET /api/sessions/:id/stream?ticket=…&since=n` | Live events over WebSocket |
| `GET/PUT /api/profile`, `POST /api/profile/apply` | Agent settings; restart idle sessions |
| `GET /api/secrets`, `PUT/DELETE /api/secrets/:name` | API keys (values are write-only) |
| `GET /api/catalog/providers`, `GET /api/catalog/providers/:id/models` | omp's provider and model catalog |
| `GET /api/subscriptions`, `DELETE /api/subscriptions/:provider/:credentialId` | Sign-in services and signed-in accounts |
| `POST /api/logins`, `GET/DELETE /api/logins/:id`, `POST /api/logins/:id/input` | Run a sign-in: start, poll its steps, answer (paste, code, yes/no), cancel |
| `/sandbox-broker/v1/*` | Agents only: the auth broker, with a per-session token |
| `GET/POST /api/tokens`, `DELETE /api/tokens/:id` | Devices |

The stream sends `{ "type": "hello", lastSeq, truncated }`, then `{ "type": "event", event }` frames. Events carry `seq`, `at` and a `kind`: `status`, `agent` (omp session events; streaming updates are coalesced to the latest message at most every 150 ms), `ui_request` / `ui_resolved`, `prompt_result`, `settled`, `subagent_lifecycle` / `subagent_progress`, `log`. Reconnect with the last `seq` as `since`; `truncated: true` means reload `/messages` first.

## Development

```sh
bun run dev                 # serve with ~/.omp-hub/hub.yaml
bun test                    # contract tests (a scripted agent stands in for omp)
bun run check               # lint, format, server types, web types, contract conformance
```
