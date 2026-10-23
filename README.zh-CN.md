# WeTalk — C++ IM 微服务 + 服务治理（Docker Compose 一键部署）

**English** | [简体中文](README.zh-CN.md)

> WeTalk 是一个 C++ 微服务即时通讯系统：接入网关、聊天服务、文件服务、验证码服务，外加基于 UDP 调度的服务治理（负载均衡/故障剔除/路由热更新），全部容器化，`docker compose up -d --build` 一键起。
>
> **部署启动流程见 [DEPLOY.md](DEPLOY.md)**（Linux 服务器部署 / 本机 Docker Desktop 两种形态 + 常见问题）。

> 项目由 [llfcchat](https://github.com/secondtonone1/llfcchat)（C++ 微服务聊天系统，原作者恋恋风辰；gitee 同 commit 镜像：[tfn3147546/llfcchat](https://gitee.com/tfn3147546/llfcchat)，HEAD `4a01c4f`）与 [aceld/Lars](https://github.com/aceld/Lars)（UDP 负载均衡/服务治理框架）整合演化而来，并做了大量自研扩展——让 StatusServer 通过服务治理组件做真正的负载均衡而不是读静态配置，新增文件服务、已读回执、删好友、离线消息等完整能力。致谢两位原作者。

桌面客户端为 **Electron**（`client-electron/`，功能清单与协议见 [client-electron/README-CLIENT.md](client-electron/README-CLIENT.md)）。

## 快速开始（5 步）

```bash
# 1. 配置环境
cp .env.example .env                  # CHAT_ADV_IP1/2 填 127.0.0.1（本机联调）
# 2. （可选）注册要收验证码：docker/configs/VarifyServer/config.json 填 163 SMTP 授权码
# 3. 构建并启动全部 12 个容器
docker compose up -d --build
# 4. 等待就绪（约 1 分钟）
docker ps                             # 全部 Up，wetalk-mysql 显示 (healthy)
# 5. 启动客户端
cd client-electron && npm install && npm start
```

**内置测试账号**（已写进 MySQL 种子，互为好友，可直接双开客户端互聊）：

| 邮箱 | 密码 | uid | 备注 |
| --- | --- | --- | --- |
| `hao@wetalk.com` | `123456` | 1059 | 与 xm 互为好友 |
| `xm@wetalk.com` | `123456` | 1099 | 昵称 XiaoMing |
| `llfc@163.com` 等种子用户 | 见 `docker/mysql/init/02-wetalk.sql` | — | 源自原版项目的种子数据 |

> 注册新账号需要 SMTP 授权码；没有的话按上面方式直接用测试账号，或往 MySQL `user` 表插数据。

**功能一览**（客户端）：注册/登录/心跳 · 好友申请与同意 · 文本单聊（送达/在线推送）· 表情面板 ·
图片收发（分片上传下载）· **文件收发**（任意格式，保留原始文件名/大小，下载弹系统另存为）·
历史消息游标分页 · **已读回执**（跨机 gRPC 实时通知）· **删除好友**（双向+实时通知）·
**个人资料设置**（昵称/签名）· **断线自动重连**（指数退避，恢复后补拉历史/未读，不踢回登录页）·
服务器地址记忆。服务端还提供：Lars 负载均衡调度（8090/8091 轮换+故障剔除）、
ChatServer 间 gRPC 同类通知（消息/已读/删好友跨机转发）、消息持久化（`wetalk.chat_message`，断线重连后历史不丢）。

> ⚠️ **从旧版本升级**：业务库已由 `llfc` 更名为 `wetalk`，MySQL 卷里的旧库不会自动迁移——需要
> `docker compose down -v`（会清空数据）后重新 `up -d --build`，init 脚本会建出新库并写入种子数据。

**验证服务端链路**（不启动客户端也能跑）：

```bash
cd client-electron
node test-e2e.js        # 登录→认证→表情文本→图片上传→落库→历史→下载比对→已读上报，输出 ALL PASS
node test-file.js       # 文件消息：1003 上传 → 1035(带文件名/大小) → 历史 → 下载 md5 比对
node test-offline.js    # 离线消息：B 离线时 A 发消息 → B 登录收 unread_list + 历史含该消息
node test-profile.js    # /user_profile 端点联调
```

## 架构

![WeTalk 架构总览](docs/architecture.svg)

> 图源：`docs/architecture.svg`（可直接改 SVG 里的坐标微调；`client-electron/tools/svgshot.js` 可离屏渲染成 PNG 预览）。

**一条主链路**：客户端 HTTP 登录 Gate（①）→ Gate 用 gRPC 问 Status 要聊天节点（②）→ Status 经 **Lars**
（lars-agent `get_route`，健康度由 lars-reporter 统计、路由表存在 MySQL `lars_dns.RouteData`）选出健康节点并回传 →
客户端 **TCP 直连**该 ChatServer（③），此后消息/已读/心跳都走这条长连接；图片与文件不占消息通道，走独立的
**ResourceServer 数据面**（④，分片上传 + 分片下载）。

**关键设计取舍**：

- **控制面与数据面分离**：Gate 只做 HTTP 无状态接入，聊天连接由 ChatServer 直接持有，文件流量由 ResourceServer 承担，互不拖累。
- **水平扩展靠 Lars 而不是静态配置**：StatusServer 每次调度都上报调用结果，Agent 在滑动窗口里统计失败率/过载，
  坏的节点自然被排除；路由表支持版本化热更新（RouteChange），加节点不用改代码。
- **跨机一致性靠 gRPC peer 通知**：两个 ChatServer 之间用 gRPC 转发文本/图片/已读/删好友通知，保证用户在任意节点都实时收到。
- **离线消息靠 MySQL 兜底**：消息先落 `chat_message`（`status=0` 未读），登录时下发 `unread_list`，重连/重登都不丢。

### 关键整合点（相对原版 llfcchat 的改动）

| 位置 | 原版 | 整合后 |
| --- | --- | --- |
| `StatusServiceImpl::getChatServer()` | 读 config.ini 静态列表，返回第一个 | 优先走 `WetalkRouteClient::getHost()`（Agent 按失败率/过载窗口返回健康节点），失败才回退静态配置 |
| 调用结果反馈 | 无 | StatusServer 每次调度成功后 `WetalkRouteClient::report()` 上报，Agent 滚动窗口统计节点健康度 |
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
| 社交扩展协议 | `ChatServer/const.h`、`LogicSystem.*`、`MysqlDao.*`、`ChatGrpcClient.*`、`ChatServiceImpl.*`、`message.proto` | 2026-10-23 新增：删除好友 `1043/1044/1045`（双向删 friend 表）、已读回执 `1046/1047/1048`（`chat_message.status` 0→2 + 定向 UPDATE）、首条消息服务端自动建 `chat_thread`；跨机通知走新增 gRPC `NotifyReadMsg/NotifyDelFriend` |
| 资料设置 | `GateServer/LogicSystem.cpp`、`MysqlDao.*` | HTTP `POST /user_profile`：Redis token 校验 → 更新 user 表 nick/desc（`desc` 是保留字需反引号）→ 删 `ubaseinfo_<uid>` 缓存 |


### 目录

```
wetalk/
├── server/                # 服务端源码（含 Linux CMake）+ common/WetalkRouteClient + common/lars（改造版路由 API）
├── third_party/Lars/      # Lars 源码（sparse checkout，base/ 因含 Windows 非法文件名未检出，lars.proto 已补齐）
├── docker/
│   ├── Dockerfile.service / Dockerfile.varify / Dockerfile.lars-*
│   ├── configs/           # 每个服务的容器版 config.ini（Mysql/Redis 指向容器服务名）
│   ├── lars/              # lars_dns / lb_agent / reporter 配置
│   ├── mysql/init/        # lars_dns 库(含路由表) + wetalk 业务库
│   └── seed/seed.sh       # 启动后把 ChatServer 节点写进 RouteData
├── docker-compose.yml
├── docs/architecture.svg # 架构图（README 顶部引用，改图直接编辑 SVG）
├── client-electron/      # Electron 桌面客户端（不依赖 Qt，HTTP + TCP 帧协议直连服务端，见其 README-CLIENT.md）
└── .env.example
```

## 运行

```bash
cp .env.example .env
# 编辑 .env：CHAT_ADV_IP1/2 填本机局域网 IP（客户端直连 8090/8091 用；本机联调填 127.0.0.1）
# 编辑 docker/configs/VarifyServer/config.json：填你自己的 163 SMTP 授权码（原作者授权码已移除，不填则注册时收不到验证码邮件）
docker compose up -d --build
docker compose logs -f status lars-agent
```

## 端口一览

| 端口 | 服务 | 谁连它 |
| --- | --- | --- |
| 8080 | GateServer（HTTP） | 客户端：登录/注册/改资料 |
| 8090 / 8091 | ChatServer1 / 2（TCP 帧协议） | 客户端：长连接、消息、已读、心跳 |
| 9090 | ResourceServer（TCP 分片） | 客户端：图片/文件上传下载 |
| 8888 / 7779（UDP） | lars-agent（get_route / 上报） | StatusServer |
| 3306 / 6379 | MySQL / Redis | 各服务（容器内网） |

- Gate（HTTP 登录注册）：`http://<host>:8080`
- ChatServer：`<CHAT_ADV_IP>:8090 / 8091`（具体连哪个由 Status 经 Lars 决定，客户端不需要写死）
- 观察调度结果：`docker compose logs status | grep Lars`

## 已知问题 / TODO

### 客户端（Electron）尚未实现

| 项 | 说明 |
| --- | --- |
| ~~断线自动重连~~ ✅ 已做 | 主进程指数退避（1s→30s，最多 8 次）自动重连 + 重新 1005 认证；期间渲染层显示横幅不踢登录页，恢复后刷新好友/未读并补拉历史。重连彻底失败或认证被拒才回登录页 |
| ~~发文件（非图片）~~ ✅ 已做 | 复用 1003 分片上传 + 1035 落库（服务端把原始文件名/大小包进 content JSON）；客户端有文件气泡（文件名/大小/下载按钮），下载走 1033 分片 + 系统"另存为"。验证：`npm run test:file` |
| ~~服务器地址记忆~~ ✅ 已做 | 登录/注册成功后 Gate 地址写入 localStorage，下次启动自动填充 |
| 上传头像 | 服务端有 1031/1032，客户端目前只显示「首字母 + 配色」的字母头像 |
| 群聊 | 服务端 `chat_thread.type` 预留了 private/group，但没有任何群表/群协议/群 UI |
| 消息撤回 / 删除 | 未做，库里有 `chat_message` 可扩 |
| 消息搜索 | 只有「搜 uid / 用户名」加好友，没有历史消息搜索 |
| 桌面通知 / 托盘 | 窗口最小化后新消息无系统通知，也没有托盘图标 |
| 图片压缩 | 发图直接原图 base64 分片，大图慢；缺发送前缩放/进度条 |
| 多端同时在线 | 服务端 `usession_<uid>` 是单会话，后登录会把前一个踢掉（原版设计如此） |

### 服务端 / 基础设施

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
| `common/WetalkRouteClient.cpp`（原 LarsClient.cpp）未被任何 target 编译，status 链接必失败 | CMake 新增 `wetalk_common` 静态库并链接进全部服务 |
| `lars_api` 库同时编译改造版与上游 `lars_api.cpp`，同名类重复符号 | 只编译改造版；上游头文件不再参与 |
| `WetalkRouteClient.cpp` 缺 `ConfigMgr.h` include | 已补（common/ 与各服务目录的 ConfigMgr 内容一致，实现由服务自身提供） |
| `Dockerfile.service` 产物路径 `build/${SERVICE}/${SERVICE}` 错、COPY 不存在的 config | 改为 `build/${SERVICE}`；config 一律由 compose 卷挂载（chat1/chat2 共用 chat 镜像） |
| compose `depends_on` 混用 map/list 语法非法 | 统一 map 形式 |
| ChatServer 间 peer RPC 主机名 `chatserver1/2` 在容器网不可解析 | chat1/chat2 加 network aliases `chatserver1`/`chatserver2` |
| ResourceServer 需要客户端直连（gate 下发 reshost/resport） | compose 暴露 9090 端口 |
| **VarifyServer 其实是 Node.js 服务**（server.js + @grpc/grpc-js + nodemailer），放进 CMake 必然构建失败 | CMake 移除 varify target；新增 `docker/Dockerfile.varify`（node:20-alpine + npm install）；compose 改挂容器版 `config.json`（原作者公网 mysql/redis 地址已替换为容器服务名，SMTP 授权码留占位） |
