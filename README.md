# WeTalk — C++ IM Microservices with Service Governance, One-Command Deploy

**English** | [简体中文](README.zh-CN.md)

> WeTalk is a C++ microservice instant-messaging system: an access gateway, chat servers, a file service and a verification-code service, plus UDP-based service governance (load balancing / failure eviction / hot route updates) — all containerized, brought up with a single `docker compose up -d --build`.
>
> **Deployment guide: [DEPLOY.md](DEPLOY.md)** (Linux server / local Docker Desktop, plus FAQ).

> The project evolved from an integration of [llfcchat](https://github.com/secondtonone1/llfcchat) (a C++ microservice chat system by 恋恋风辰) and [aceld/Lars](https://github.com/aceld/Lars) (a UDP load-balancing / service-governance framework), with substantial original work on top: StatusServer now performs real load balancing through the governance framework instead of reading a static list, and the project adds a file service, read receipts, friend removal, offline messaging and more. Credits to the original authors.

The desktop client is **Electron** (`client-electron/`, feature list & protocol map in [client-electron/README-CLIENT.md](client-electron/README-CLIENT.md)).

## Quick Start (5 steps)

```bash
# 1. Configure environment
cp .env.example .env                  # set CHAT_ADV_IP1/2 to 127.0.0.1 for local development
# 2. (Optional) registration emails: put your 163 SMTP auth code into
#    docker/configs/VarifyServer/config.json
# 3. Build & start all 12 containers
docker compose up -d --build
# 4. Wait until ready (~1 min)
docker ps                             # all Up, wetalk-mysql shows (healthy)
# 5. Start the desktop client
cd client-electron && npm install && npm start
```

**Built-in test accounts** (seeded into MySQL, already friends with each other):

| Email | Password | uid | Note |
| --- | --- | --- | --- |
| `hao@wetalk.com` | `123456` | 1059 | friends with xm |
| `xm@wetalk.com` | `123456` | 1099 | nickname XiaoMing |
| `llfc@163.com` and other seeds | see `docker/mysql/init/02-wetalk.sql` | — | seeded from the original project |

> Registering new accounts requires the SMTP auth code; without it, use the test accounts above or insert rows into the MySQL `user` table directly.

**Feature list** (client): register / login / heartbeat · friend requests & approval · 1:1 text chat (delivery + online push) · emoji panel ·
image messages (chunked upload/download) · **file transfer** (any format, original filename & size preserved, downloads via native save dialog) ·
cursor-paginated history · **read receipts** (cross-server real-time gRPC notify) · **friend removal** (bidirectional + real-time notify) ·
**profile editing** (nickname / signature) · **auto-reconnect** (exponential backoff; history & unread re-synced on recovery, never kicked to the login page) ·
server address memory. On the server side: governance-based load balancing (8090/8091 rotation + failure eviction),
cross-server gRPC peer notifications (messages / receipts / friend removal), message persistence (`wetalk.chat_message` — history survives reconnects).

**Verify the server pipeline** (no client needed):

```bash
cd client-electron
node test-e2e.js        # login → auth → text → image upload → persistence → history → download diff → read report, prints ALL PASS
node test-file.js       # file messages: 1003 upload → 1035 (with filename/size) → history → download md5 diff
node test-offline.js    # offline messaging: A sends while B is offline → B logs in, gets unread_list + the message in history
node test-profile.js    # /user_profile endpoint
```

## Architecture

![WeTalk architecture](docs/architecture.svg)

> Source: `docs/architecture.svg` (edit the SVG directly; `client-electron/tools/svgshot.js` renders it offscreen to PNG for preview).

**The main path**: the client logs in over HTTP at the Gate (①) → the Gate asks Status for a chat node via gRPC (②) →
Status picks a healthy node through the governance framework (agent `get_route`; health tracked by the reporter; the route
table lives in MySQL `lars_dns.RouteData`) → the client opens a **direct TCP connection** to that ChatServer (③), and all
messages / receipts / heartbeats flow over that long connection. Images and files bypass the message channel entirely via
the dedicated **ResourceServer data plane** (④, chunked upload + chunked download).

**Key design decisions**:

- **Control plane / data plane separation**: the Gate is a stateless HTTP front; chat connections are held directly by
  ChatServers; file traffic goes to ResourceServer. None of them drag each other down.
- **Horizontal scaling via governance, not static config**: StatusServer reports every scheduling result; the agent tracks
  failure rates / overload in a sliding window, so bad nodes are evicted naturally. The route table supports versioned hot
  updates (RouteChange) — adding a node requires no code change.
- **Cross-server consistency via gRPC peer notification**: the two ChatServers forward text / image / read-receipt /
  friend-removal notifications over gRPC so users receive events in real time regardless of which node they are on.
- **Offline messaging backed by MySQL**: messages land in `chat_message` (`status=0` unread); the login response carries
  `unread_list`, so nothing is lost across reconnects or re-logins.

### Key integration changes (vs. the original llfcchat)

| Area | Original | Integrated |
| --- | --- | --- |
| `StatusServiceImpl::getChatServer()` | reads a static list from config.ini, returns the first | prefers `WetalkRouteClient::getHost()` (agent returns healthy nodes by failure/overload window), falls back to static config |
| Call-result feedback | none | StatusServer reports every successful scheduling via `WetalkRouteClient::report()`; the agent tracks node health in a sliding window |
| Node registration | hard-coded in config.ini | routes live in MySQL `lars_dns.RouteData` (modid=1, cmdid=1), with versioned hot updates (RouteChange) |
| Build | Windows VS project, local machine only | Linux CMake build + one Docker image per service, `compose up` in one command |
| Governance API | agent address hard-coded 127.0.0.1 | `server/common/lars/lars_api.cpp` now takes addresses via constructor parameters (required for container networking) |

### Original work in this repo (diff of `server/` vs. upstream llfcchat)

> Verified file-by-file with a diff script (2026-10-22, upstream commit `4a01c4f`). These changes are unique to this repo:

| Area | Location | Content |
| --- | --- | --- |
| Image messages | `ChatServer/const.h`, `LogicSystem.*` | new protocol `ID_IMG_CHAT_MSG_REQ/RSP/NOTIFY` (1035/1036/1039) and the `DealChatImgMsg` flow (md5 dedup, unique_id, token check) |
| Message reliability | `ChatServer/const.h`, `MysqlDao.*`, `MysqlMgr.*` | `AddChatMsg` persistence + a `MsgStatus` state machine (UN_READ / SEND_FAILED / READED / UN_UPLOAD) powering offline messaging and read receipts |
| Concurrency fix | `ChatServer/MysqlDao.cpp` | friend-relation inserts use a fixed uid ordering (smaller uid first), eliminating deadlocks / unique-key conflicts on concurrent mutual adds |
| Logout security | `ChatServer/CSession.cpp` | the Redis token (`USERTOKENPREFIX+uid`) is deleted on logout |
| Redis capability | `StatusServer/RedisMgr.*` | added `SetWithExpire` (atomic SETEX) for verification codes / tokens |
| File service | `ResourceServer/` (48 files; not in the original) | self-built file server: FileInfo / FileSystem / FileWorker / LogicWorker, Redis `DistLock`, file-info sync protocol `ID_FILE_INFO_SYNC_REQ/RSP` (1041/1042), Gate returns `reshost/resport` in the login response |
| Social extensions | `ChatServer/const.h`, `LogicSystem.*`, `MysqlDao.*`, `ChatGrpcClient.*`, `ChatServiceImpl.*`, `message.proto` | added 2026-10-23: friend removal `1043/1044/1045` (bidirectional), read receipts `1046/1047/1048` (`chat_message.status` 0→2 + targeted UPDATE), server-side auto-creation of `chat_thread` on first message; cross-server notify via new gRPC `NotifyReadMsg/NotifyDelFriend` |
| Profile editing | `GateServer/LogicSystem.cpp`, `MysqlDao.*` | HTTP `POST /user_profile`: Redis token check → update user nick/desc (`desc` is a reserved word, needs backticks) → evict the `ubaseinfo_<uid>` cache |

### Directory

```
wetalk/
├── server/                # server sources (with Linux CMake) + common/WetalkRouteClient + common/lars (patched route API)
├── third_party/Lars/      # upstream governance framework (sparse checkout; base/ skipped for invalid Windows filenames, lars.proto restored)
├── docker/
│   ├── Dockerfile.service / Dockerfile.varify / Dockerfile.lars-*
│   ├── configs/           # container config.ini per service (MySQL/Redis point at compose service names)
│   ├── lars/              # lars_dns / lb_agent / reporter configs
│   ├── mysql/init/        # lars_dns DB (route table) + wetalk business DB
│   └── seed/seed.sh       # writes ChatServer nodes into RouteData after startup
├── docker-compose.yml
├── docs/architecture.svg  # architecture diagram (referenced above; edit the SVG directly)
├── client-electron/       # Electron desktop client (HTTP + raw TCP frame protocol; see its README-CLIENT.md)
└── .env.example
```

## Running

```bash
cp .env.example .env
# Edit .env: set CHAT_ADV_IP1/2 to your LAN IP (used by the client to reach 8090/8091; 127.0.0.1 for local dev)
# Edit docker/configs/VarifyServer/config.json: your own 163 SMTP auth code (registration emails fail without it)
docker compose up -d --build
docker compose logs -f status lars-agent
```

> **Upgrading from an older deployment**: the business database was renamed `llfc` → `wetalk`. The old database inside the
> MySQL volume is not migrated automatically — run `docker compose down -v` (wipes data) and `up -d --build` again so the
> init scripts create the new database with seed data.

## Ports

| Port | Service | Used by |
| --- | --- | --- |
| 8080 | GateServer (HTTP) | client: login / register / profile |
| 8090 / 8091 | ChatServer1 / 2 (TCP frame protocol) | client: long connection, messages, receipts, heartbeat |
| 9090 | ResourceServer (TCP chunked) | client: image / file upload & download |
| 8888 / 7779 (UDP) | lars-agent (get_route / report) | StatusServer |
| 3306 / 6379 | MySQL / Redis | services (internal network) |

- Gate (HTTP login/register): `http://<host>:8080`
- ChatServer: `<CHAT_ADV_IP>:8090 / 8091` (which one is decided by Status via the governance framework — the client never hard-codes it)
- Watch scheduling: `docker compose logs status | grep Lars`

## Known issues / TODO

### Client (Electron)

| Item | Note |
| --- | --- |
| ~~Auto-reconnect~~ ✅ done | main process reconnects with exponential backoff (1s→30s, up to 8 tries) and re-authenticates (1005); the renderer shows a banner instead of returning to the login page; friends / unread / history re-sync on recovery |
| ~~File transfer~~ ✅ done | reuses 1003 chunked upload + 1035 persistence (server wraps original filename/size into a content JSON); file bubbles with name/size/download button; downloads via 1033 chunks + native save dialog. Verified by `npm run test:file` |
| ~~Server address memory~~ ✅ done | the Gate address is stored in localStorage after a successful login/register and refilled on next launch |
| Avatar upload | server supports 1031/1032; the client currently shows letter avatars (initial + color) |
| Group chat | `chat_thread.type` reserves private/group, but there are no group tables / protocols / UI yet |
| Message recall / delete | not implemented; `chat_message` can be extended |
| Message search | only uid/name search for adding friends; no history search |
| Desktop notifications / tray | no system notification when minimized; no tray icon |
| Image compression | images are sent as raw base64 chunks; no pre-send scaling / progress bar |
| Multi-device login | `usession_<uid>` is single-session by design; a later login kicks the earlier one (inherited from the original) |

### Server / infrastructure

- [ ] Upstream `lars_api get_route` seems to double-convert IP byte order (ntohl result assigned straight into `s_addr`); kept upstream behavior in `common/lars/lars_api.cpp` with a note — verify with `get_route` printing on first bring-up.
- [ ] Upstream `dns_route.cpp` reads serverip with `atoi` (overflows above 2^31); suggest `strtoul`.
- [ ] Generated protobuf files (message.pb.cc etc.) are from an old protoc; the Linux build regenerates them via CMake — mind versions if mixing with Windows builds.
- [x] The ChatServer2 source directory is archived at `server/_attic/ChatServer2-outdated/` (an **outdated copy without the later changes**; always build via ChatServer + the two config.ini files, see compose chat1/chat2).
- [x] VarifyServer got a config.ini; ResourceServer is a self-built service with its config in `docker/configs/`.

## Containerization caveat (inet_aton)

The upstream `lars_reactor` `tcp_client`/`udp_client` parse addresses with `inet_aton()` and **cannot resolve compose service
names**. How this repo handles it:

- `docker/lars/lars_lb_agent.conf` `[reporter]`/`[dnsserver]` use fixed compose IPs (172.20.0.21 / 172.20.0.20); `lars_dns`/`lars_reporter` reach MySQL through libmysqlclient's own resolver, so service names work there.
- `docker/configs/StatusServer/config.ini` `[Lars] AgentIp` is 172.20.0.22.
- `common/lars/lars_api.cpp` (patched) was upgraded: dotted IPs pass through, hostnames go through `getaddrinfo`, and resolution failure exits with an explicit error.

## Build fix log (integration wrap-up, 2026-10-23)

| Problem | Fix |
| --- | --- |
| `common/WetalkRouteClient.cpp` (formerly LarsClient.cpp) was compiled by no target; status link always failed | CMake gained the `wetalk_common` static library, linked into every service |
| the `lars_api` library compiled both the patched and the upstream `lars_api.cpp`, duplicating symbols | only the patched version is compiled; upstream headers no longer participate |
| `WetalkRouteClient.cpp` missing the `ConfigMgr.h` include | added (common/ and per-service ConfigMgr are identical in content; implementations are provided per service) |
| `Dockerfile.service` had wrong output path `build/${SERVICE}/${SERVICE}` and copied nonexistent configs | fixed to `build/${SERVICE}`; configs are always mounted by compose (chat1/chat2 share the chat image) |
| compose `depends_on` mixed map/list syntax (invalid) | unified to map form |
| peer RPC hostnames `chatserver1/2` unresolvable inside the container network | chat1/chat2 got network aliases `chatserver1`/`chatserver2` |
| ResourceServer needs direct client access (gate returns reshost/resport) | compose exposes port 9090 |
| **VarifyServer is actually a Node.js service** (server.js + @grpc/grpc-js + nodemailer); putting it into CMake was doomed | removed the varify CMake target; added `docker/Dockerfile.varify` (node:20-alpine + npm install); compose mounts the container `config.json` (original author's public mysql/redis endpoints replaced with service names; SMTP auth code left as placeholder) |
