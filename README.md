# WeTalk — llfcchat 微服务 + Lars 负载均衡 服务治理整合

> **部署启动流程见 [DEPLOY.md](DEPLOY.md)**（Linux 服务器部署 / 本机 Docker Desktop 两种形态 + 常见问题）。

把 [llfcchat](https://github.com/secondtonone1/llfcchat)（C++ 微服务聊天系统，原作者恋恋风辰；作者 gitee 原仓库已不公开，gitee 同 commit 镜像：[tfn3147546/llfcchat](https://gitee.com/tfn3147546/llfcchat)，HEAD `4a01c4f`）和 [aceld/Lars](https://github.com/aceld/Lars)（UDP 负载均衡/服务治理框架）整合成一个 **可 Docker Compose 一键部署** 的项目，
并让 StatusServer 通过 Lars 做真正的负载均衡，而不是读静态配置。

## 架构

```
                         ┌─────────────── docker network: 172.20.0.0/16 ───────────────┐
 Qt 客户端 ──8080──▶ GateServer ──gRPC──▶ StatusServer ──UDP 8888──▶ lars-agent ──TCP──▶ lars-dns ◀── MySQL(lars_dns)
   │                     │                        │  ▲                │ UDP 7779                ▲
   │                     │                        │  │ report         ▼                        │ 路由表 RouteData
   │                     ├──gRPC──▶ VarifyServer  │  └─────── lars-reporter ────────────────────┘
   │                     └──gRPC──▶ ResourceServer │
   ├──8090──▶ ChatServer1 ◀──gRPC(peer)──▶ ChatServer2 ◀── 种子路由(modid=1,cmdid=1)
   └──8091──▶ ChatServer2
```

### 关键整合点（相对原版 llfcchat 的改动）

| 位置 | 原版 | 整合后 |
| --- | --- | --- |
| `StatusServiceImpl::getChatServer()` | 读 config.ini 静态列表，返回第一个 | 优先走 `LarsClient::getHost()`（Agent 按失败率/过载窗口返回健康节点），失败才回退静态配置 |
| 调用结果反馈 | 无 | StatusServer 每次调度成功后 `LarsClient::report()` 上报，Agent 滚动窗口统计节点健康度 |
| 节点注册 | 写死在 config.ini | 路由写在 MySQL `lars_dns.RouteData`（modid=1, cmdid=1），支持 RouteChange 版本化热更新 |
| 构建 | Windows VS 工程只能本机跑 | 新增 Linux CMake 构建 + 每服务一个 Docker 镜像，compose 一键起 |
| Lars API | agent 地址写死 127.0.0.1 | `server/common/lars/lars_api.cpp` 改为构造参数传入（容器间互访必需） |

### 基于原版的自行开发内容（本仓库 server/ 相对 GitHub 原版 llfcchat 的 diff）

> 已用脚本逐文件比对（2026-10-22，原版 commit `4a01c4f`）。以下改动是本地版本独有的，面试可指认源码：

| 类别 | 位置 | 内容 |
| --- | --- | --- |
| 图片消息 | `ChatServer/const.h`、`LogicSystem.*` | 新增协议 `ID_IMG_CHAT_MSG_REQ/RSP/NOTIFY`(1035/1036/1039) 与 `DealChatImgMsg` 处理流程（md5 去重、unique_id、token 校验） |
| 消息可靠性 | `ChatServer/const.h`、`MysqlDao.*`、`MysqlMgr.*` | 新增 `AddChatMsg` 聊天记录落库 + `MsgStatus` 状态机（UN_READ / SEND_FAILED / READED / UN_UPLOAD），支撑离线消息与已读回执 |
| 并发修复 | `ChatServer/MysqlDao.cpp` | 好友关系插入按 uid 大小固定顺序（self_id 取较小 uid），消除并发互加好友时的死锁/唯一键冲突 |
| 登出安全 | `ChatServer/CSession.cpp` | 登出时删除 Redis 中 `USERTOKENPREFIX+uid` 的 token |
| Redis 能力 | `StatusServer/RedisMgr.*` | 新增 `SetWithExpire`（SETEX 原子写值+过期），供验证码/token 使用 |
| 文件服务 | `ResourceServer/`（48 个文件，原版无此服务） | 自建文件资源服务器：FileInfo/FileSystem/FileWorker/LogicWorker、Redis `DistLock` 分布式锁、文件信息同步协议 `ID_FILE_INFO_SYNC_REQ/RSP`(1041/1042)，GateServer 登录响应下发 `reshost/resport` |


### 目录

```
wetalk/
├── server/                # llfcchat server 源码（含 Linux CMake）+ common/LarsClient + common/lars（改造版 API）
├── third_party/Lars/      # Lars 源码（sparse checkout，base/ 因含 Windows 非法文件名未检出，lars.proto 已补齐）
├── docker/
│   ├── Dockerfile.service / Dockerfile.varify / Dockerfile.lars-*
│   ├── configs/           # 每个服务的容器版 config.ini（Mysql/Redis 指向容器服务名）
│   ├── lars/              # lars_dns / lb_agent / reporter 配置
│   ├── mysql/init/        # lars_dns 库(含路由表) + llfc 业务库
│   └── seed/seed.sh       # 启动后把 ChatServer 节点写进 RouteData
├── docker-compose.yml
├── client-electron/      # Electron 桌面客户端（不依赖 Qt，HTTP + TCP 帧协议直连服务端，见其 README-CLIENT.md）
└── .env.example
```

## 运行

```bash
cp .env.example .env
# 编辑 .env：CHAT_ADV_IP1/2 填本机局域网 IP（Qt 客户端要用它直连 8090/8091）
# 编辑 docker/configs/VarifyServer/config.json：填你自己的 163 SMTP 授权码（原作者授权码已移除，不填则注册时收不到验证码邮件）
docker compose up -d --build
docker compose logs -f status lars-agent
```

- Gate（HTTP 登录注册）：`http://<host>:8080`
- ChatServer：`<CHAT_ADV_IP>:8090 / 8091`
- 观察调度结果：`docker compose logs status | grep Lars`

## 已知问题 / TODO

- [ ] 上游 lars_api `get_route` 的 IP 字节序转换疑似有双重转换（ntohl 后直接赋给 s_addr），已在 `common/lars/lars_api.cpp` 保持上游行为并标注；首次联调时优先用 `get_route` 打印验证。
- [ ] Lars 上游 `dns_route.cpp` 用 `atoi` 读 serverip（>2^31 会溢出），建议后续改 `strtoul`。
- [ ] protobuf 生成文件（message.pb.cc 等）是老版本 protoc 产物，Linux 构建统一用 CMake 重新生成，Windows 侧如混用需注意版本。
- [x] ChatServer2 源码目录已归档到 `server/_attic/ChatServer2-outdated/`（它是**不含后续自研修改的旧拷贝**，构建一律用 ChatServer + 两份 config.ini，见 compose chat1/chat2）。
- [x] VarifyServer 补了 config.ini；ResourceServer 为自建服务，其配置项已含在本目录 `docker/configs/`。

## 容器化联调注意（inet_aton 坑）

上游 `lars_reactor` 的 `tcp_client`/`udp_client` 用 `inet_aton()` 解析地址，**不能填容器服务名**。本工程处理：

- `docker/lars/lars_lb_agent.conf` 的 `[reporter]`/`[dnsserver]` 直接写 compose 固定 IP（172.20.0.21 / 172.20.0.20）；`lars_dns`/`lars_reporter` 连 MySQL 走 libmysqlclient 自带域名解析，服务名可用。
- `docker/configs/StatusServer/config.ini` 的 `[Lars] AgentIp` 写 172.20.0.22。
- `common/lars/lars_api.cpp`（改造版）已升级：点分 IP 直接用，主机名走 `getaddrinfo`，解析失败显式报错退出。

## 构建修复记录（2026-10-23 整合收尾）

| 问题 | 修复 |
| --- | --- |
| `common/LarsClient.cpp` 未被任何 target 编译，status 链接必失败 | CMake 新增 `wetalk_common` 静态库并链接进全部服务 |
| `lars_api` 库同时编译改造版与上游 `lars_api.cpp`，同名类重复符号 | 只编译改造版；上游头文件不再参与 |
| `LarsClient.cpp` 缺 `ConfigMgr.h` include | 已补（common/ 与各服务目录的 ConfigMgr 内容一致，实现由服务自身提供） |
| `Dockerfile.service` 产物路径 `build/${SERVICE}/${SERVICE}` 错、COPY 不存在的 config | 改为 `build/${SERVICE}`；config 一律由 compose 卷挂载（chat1/chat2 共用 chat 镜像） |
| compose `depends_on` 混用 map/list 语法非法 | 统一 map 形式 |
| ChatServer 间 peer RPC 主机名 `chatserver1/2` 在容器网不可解析 | chat1/chat2 加 network aliases `chatserver1`/`chatserver2` |
| ResourceServer 需要客户端直连（gate 下发 reshost/resport） | compose 暴露 9090 端口 |
| **VarifyServer 其实是 Node.js 服务**（server.js + @grpc/grpc-js + nodemailer），放进 CMake 必然构建失败 | CMake 移除 varify target；新增 `docker/Dockerfile.varify`（node:20-alpine + npm install）；compose 改挂容器版 `config.json`（原作者公网 mysql/redis 地址已替换为容器服务名，SMTP 授权码留占位） |
