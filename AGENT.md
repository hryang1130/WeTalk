# AGENT.md — Operating Guide for AI Coding Agents

> Rules and context for AI coding assistants (Claude Code, Codex, Cursor, ...) working in this repository.
> 本文件约束在本仓库工作的 AI 编码助手：哪些是契约、哪些不能碰、怎么验证。人类开发者同样适用。

## What this repo is (30 seconds)

**WeTalk** — a C++ microservice IM system: GateServer (HTTP access), StatusServer (node scheduling), ChatServer ×2 (TCP long connections), ResourceServer (file/image data plane), VarifyServer (email codes, Node.js), plus a built-in UDP route-governance trio (route-dns / route-reporter / route-agent) and an Electron desktop client. 12 containers, one `docker compose up -d --build`.

The project was integrated from **llfcchat** (chat microservices), then a self-built route-governance layer was added (vendored internals live under `third_party/Lars/`) and heavily extended (file service, read receipts, friend removal, offline messaging, auto-reconnect). Naming rule: the governance components are **route-dns / route-reporter / route-agent** everywhere user-visible (docs, diagram, compose, configs). Credits live in the README — keep them there.

## Golden rules

1. **The wire protocol is a contract.** Message IDs must stay in lockstep between
   `server/ChatServer/const.h` (C++) and `client-electron/core/protocol.js` (JS).
   ChatServer frames: `msgid(2B BE) + msglen(2B BE) + JSON body`.
   ResourceServer frames are **different**: `msgid(2B BE) + msglen(4B BE) + JSON`.
   // 两端协议编号必须同步改，头部长度两端还不一样，别想当然。

2. **Do not edit `third_party/Lars/`.** It is vendored (treated as an internal implementation detail, never
   presented as a third-party dependency in docs/diagram). The self-built governance API lives in
   `server/common/route/route_api.cpp` and the wrapper in `server/common/WetalkRouteClient.{h,cpp}`.
   // vendored 内部实现目录不许动；对外一律称 WeTalk 路由治理组件（route-dns/reporter/agent），补丁打在自研层。

3. **Configs are mounted, not baked.** Container configs live in `docker/configs/<Service>/`
   and are volume-mounted by compose. The copies under `server/<Service>/config.ini` are for
   non-Docker local runs — when you change one, change both. // 配置改动两边同步。

4. **DB schema changes need a volume reset.** Init scripts in `docker/mysql/init/*.sql` only run
   on a **fresh** MySQL volume. Business DB name is `wetalk`; route table DB is `wetalk_route`.
   // 改了建表脚本必须 down -v 重建卷，否则永远不生效。

5. **`server/_attic/` is dead code.** Never build or edit it (outdated copy kept for reference).

6. **Never run `git rm -r --cached <dir>` on this machine.** A local git quirk deletes the whole
   parent directory **from disk** (this actually happened, 2026-10-23, took out `client-electron/`
   including node_modules). To untrack files, use `git update-index --force-remove -- <path>` per path.
   // 本机 git 连坐 bug：删子目录会把父目录整个从磁盘端掉，血泪教训。

7. **Network (CN dev environment).** github.com needs the Clash proxy (`127.0.0.1:7897`).
   Push/fetch use SSH via `ssh.github.com:443` with a ProxyCommand — already configured in
   `~/.ssh/config`. For npm/electron downloads set `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`.
   // 直连 GitHub 必挂；npm 装 electron 卡住就是没走镜像。

8. **Windows sandbox quirks.** The sandbox PowerShell drops coreutils (`ls`, `grep`, `env` are
   unavailable; use PowerShell cmdlets or node one-liners). Before launching any electron binary:
   `$env:ELECTRON_RUN_AS_NODE = $null` or it runs as plain Node (global env var is set on this machine).

9. **Startup ordering is enforced by healthchecks — do not weaken them.** After `down -v`, MySQL
   runs its init SQL on a temp instance that answers `mysqladmin ping`, so a ping-based healthcheck
   lies. The mysql healthcheck therefore verifies `USE wetalk_route; USE wetalk` (i.e. all init SQL done),
   and route-dns/route-reporter have `/dev/tcp` port healthchecks because the agent's tcp_client
   never reconnects after a failed first attempt. All long-running services have
   `restart: unless-stopped` (the seed one-shot container must NOT have it).
   // ping 型健康检查在 MySQL 初始化期会"假 healthy"，治理组件连不上一次就永远瘫，靠 healthcheck+restart 兜底。

10. **Route API retcode is a contract.** `route_client::get_host` (server/common/route/route_api.cpp)
    must check `rsp.retcode()` before reading `rsp.host()` — when the agent has no route yet it
    replies RET_NOEXIST with an unset host (proto3 default ip=0/port=0). Skipping the check yields
    `chathost "0.0.0.0:0"` to clients (this bug actually shipped, 2026-10-23).
    // agent 没路由时不检查 retcode 会把 0.0.0.0:0 当成功返回，客户端直接连爆。

## Build & run

```bash
docker compose up -d --build
# 全量构建并启动 12 个容器（改任何 C++/Dockerfile 后）

docker compose build chat1 && docker compose up -d chat1 chat2
# 只改了 ChatServer 时：chat1/chat2 共用同一镜像，build 一次两个容器都重建

docker compose down -v && docker compose up -d --build
# 改了 docker/mysql/init/*.sql 后：必须清卷重建，否则新表/新库不会出现（会清空数据）
```

Rebuild scope by change type:

| Changed | Rebuild |
| --- | --- |
| `server/ChatServer/**` | `docker compose build chat1` (chat2 shares the image) |
| `server/GateServer/**` | `docker compose build gate` |
| `server/StatusServer/**` | `docker compose build status` |
| `server/ResourceServer/**` | `docker compose build resource` |
| `server/common/**` | gate + status + chat1 (+ resource if MysqlDao/RedisMgr touched) |
| `server/VarifyServer/**` | `docker compose build varify` (Node) |
| `docker/configs/**` | nothing — configs are mounted, just `docker compose restart <svc>` |
| `client-electron/**` | nothing — restart the client (dev mode: `npm start`) |

## Verification loop (before every commit)

```bash
cd client-electron
node test-e2e.js       # 全链路：登录→认证→文本→图片上传→落库→历史→下载比对→已读上报
node test-file.js      # 文件消息：1003 上传→1035(fname/fsize)→历史 JSON→1033 下载 md5 比对
node test-offline.js   # 离线消息：B 离线收消息→B 登录拿 unread_list + 历史
node test-img-cross.js # 跨用户图片：A 发→B 实时收 1039→下载→已读回执
npm run shot           # UI 冒烟：假数据渲染真实页面截图到 __ui/（不连服务器）
```

- Every script must end with `ALL PASS ✅`. Do not commit with a failing suite.
- Tests log in with real accounts (`xm@wetalk.com` / `hao@wetalk.com`, password `123456`).
  The server is single-session per uid — running tests kicks the same account out of any open GUI client.
- Client-side unit of truth for UI: `npm run shot` screenshots in `client-electron/__ui/` (gitignored).

## Client quick facts

- The renderer (`renderer/app.js`) never touches sockets directly; everything goes through
  `window.wetalk` exposed by `preload.js` (contextIsolation on, sandbox off).
- Heavy lifting (TCP, HTTP, file I/O, save dialogs) lives in `main.js` (main process).
- Theme/styling: design tokens are CSS variables in `renderer/style.css` `:root`.
- If `node_modules/electron/dist/electron.exe` is missing after install:
  `node node_modules\electron\install.js` with `ELECTRON_MIRROR` set.

## Commit style

- Conventional Commits: `feat:`, `fix:`, `docs:`, `chore:`. Chinese subject lines are fine.
- One logical change per commit; never push with a failing verification loop.
- Remote is `origin = git@github.com:hryang1130/WeTalk.git` (SSH over 443 via Clash, see rule 7).

## Map of important files

| Path | What it is |
| --- | --- |
| `server/ChatServer/LogicSystem.cpp` | all chat business handlers (one callback per MSG_ID) |
| `server/ChatServer/MysqlDao.cpp` | persistence SQL (messages, friends, threads, unread summary) |
| `server/GateServer/LogicSystem.cpp` | HTTP endpoints (`/user_login`, `/user_register`, `/user_profile`, ...) |
| `server/common/WetalkRouteClient.{h,cpp}` | thread-safe wrapper over the governance agent (get_host / report) |
| `docker-compose.yml` | all 12 services, networks, fixed IPs for the governance trio |
| `docker/mysql/init/*.sql` | DB bootstrap (route table + business schema + seed users) |
| `client-electron/main.js` | main process: TCP connection + reconnect loop + IPC |
| `client-electron/core/protocol.js` | frame codec + all MSG_IDS (mirror of const.h) |
| `client-electron/renderer/app.js` | all UI logic |
