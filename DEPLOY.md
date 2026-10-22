# 部署指南

两种部署形态，按你的环境二选一。**服务端必须跑在 Linux 内核上**（Lars reactor 用 epoll、
`common/lars/lars_api.cpp` 用 POSIX socket），Windows 原生 MSVC/MinGW 无法编译；
Windows 侧只跑 Electron 客户端。

## 方案 A：服务端在 Linux 服务器（推荐，你要的形态）

### 1. 服务器准备（Ubuntu 22.04 为例）

```bash
# 只需要 Docker，构建全在容器内完成，宿主机不用装 gcc/boost
curl -fsSL https://get.docker.com | sh
sudo systemctl enable --now docker
docker compose version   # 需要 v2（Docker 20.10+ 自带）
```

### 2. 代码上服务器

```bash
# 方式一：从 Windows 推到服务器（在 Windows 上执行）
scp -r D:\Code\cpp\wetalk-im user@<服务器IP>:~/
# 方式二：把 wetalk-im push 到 GitHub/Gitee 私有仓库，服务器上 git clone
```

### 3. 配置并启动（服务器上）

```bash
cd ~/wetalk-im
cp .env.example .env
```

编辑 `.env`，**CHAT_ADV_IP1/2 填服务器的公网 IP**（云服务器填公网 IP，
同一内网则填内网 IP）——这是 Lars 路由表里通告给客户端的 ChatServer 地址：

```ini
CHAT_ADV_IP1=<服务器公网IP>
CHAT_ADV_IP2=<服务器公网IP>
```

```bash
# VarifyServer 邮箱验证码：填你自己的 163 SMTP 授权码（注册功能需要）
vim docker/configs/VarifyServer/config.json   # 改 email.user / email.pass
docker compose up -d --build                  # 首次构建约 5-10 分钟
docker compose logs -f status gate            # 观察启动
docker compose exec mysql mysql -uroot -p123456 lars_dns \
  -e "SELECT modid,cmdid,INET_NTOA(serverip),serverport FROM RouteData;"   # 验证路由已写入
```

### 4. 放行端口（云服务器安全组 + ufw/firewalld）

| 端口 | 用途 |
| --- | --- |
| 8080/tcp | GateServer HTTP（注册/登录） |
| 8090/tcp、8091/tcp | ChatServer 长连接 |
| 9090/tcp | ResourceServer（文件，可选） |

MySQL/Redis/Lars 三组件只在容器网络内部通信，**不要**对外放行。

### 5. Windows 客户端

```powershell
cd D:\Code\cpp\wetalk-im\client-electron
npm start
```

登录页第一行 **GateServer 地址** 填 `http://<服务器公网IP>:8080`。
登录成功后服务端会把 ChatServer 地址（=CHAT_ADV_IP）下发给客户端，客户端自动直连 8090/8091。

### 6. 验证负载均衡生效

服务器上 `docker compose logs status | grep Lars`，连续登录多个账号应看到
getHost 在 chatserver1/chatserver2 之间轮换；`docker compose logs lars-agent`
可观察 report 上报与窗口统计。

---

## 方案 B：全部跑在本机 Windows（需先装 Docker Desktop）

1. 安装 [Docker Desktop for Windows](https://www.docker.com/products/docker-desktop/)（需 WSL2 后端，安装器会引导）。
2. 其余步骤与方案 A 完全相同，只是：
   - `.env` 的 CHAT_ADV_IP1/2 填 `127.0.0.1`（或本机局域网 IP，供局域网内其他设备连）
   - 客户端 GateServer 地址保持 `http://127.0.0.1:8080`
3. `docker compose up -d --build` 后直接 `npm start`。

> 为什么不能不装 Docker 直接编译？`server/` 是 Linux C++ 代码（VS 工程是历史产物），
> Lars 网络库基于 epoll + POSIX socket。若想彻底原生 Windows 化需把 reactor 换成
> IOCP/select 实现，工作量大于收益，不建议。

## 常见问题

| 现象 | 排查 |
| --- | --- |
| 登录返回 RPCFailed | status 容器没起来或 Gate 连不上 status：`docker compose ps`、`logs gate` |
| HTTP 登录成功但 TCP 认证失败(TokenInvalid) | 客户端连的 ChatServer 与发 token 的不是同一 Redis：确认两容器同 compose 网络 |
| 连不上 8090/8091 | `.env` CHAT_ADV_IP 填错（客户端不可达）；安全组未放行；`docker compose logs seed` |
| 调度始终同一个节点 | `RouteData` 只有一条：重跑 `docker compose restart seed` |
| 注册收不到验证码邮件 | VarifyServer SMTP 授权码未填/过期：`docker compose logs varify` |
