# WeTalk Electron 桌面客户端

用 Electron + Node.js 重写的桌面客户端，**不依赖 Qt**，直接对接 WeTalk 整合服务端
（llfcchat 微服务 + Lars 负载均衡）。

## 协议对接说明（面试可讲）

服务端对客户端只暴露两种协议，与客户端语言无关：

1. **HTTP**（GateServer :8080，自写 Beast HTTP）：
   - `POST /get_varifycode` `{email}` → 发送邮箱验证码
   - `POST /user_register` `{email,user,nick,passwd,confirm,icon,varifycode}` → `{uid}`
   - `POST /user_login` `{email,passwd}` → `{uid, token, chathost, chatport, reshost, resport}`
     （chathost 由 StatusServer→Lars 负载均衡选出，这正是整合项目的核心链路）
2. **TCP 长连接**（ChatServer :8090/:8091，Asio）：
   - 帧格式：`msgid(2B 大端) + msglen(2B 大端) + JSON body`
   - `1005` TCP 登录 `{uid, token}`（token 来自 HTTP 登录，校验 Redis `utoken_<uid>`）
   - `1017` 文本消息 `{fromuid, touid, thread_id, text_array:[{content, unique_id}]}`
   - `1007/1009/1013` 搜索 / 加好友 / 认证好友，`1023` 心跳
   - 常量表与 `server/ChatServer/const.h` 的 `MSG_IDS` 枚举一一对应

gRPC 只存在于服务间调用（Gate↔Status↔Chat），客户端完全不接触。

## 目录

```
client-electron/
├── main.js            # 主进程：net.Socket 长连接 + 拆包状态机 + 心跳(30s) + IPC
├── preload.js         # contextBridge 桥接（安全模式，renderer 不开 nodeIntegration）
├── core/protocol.js   # 线协议：帧编解码 + MSG_IDS 常量（与 C++ const.h 对齐）
└── renderer/          # 登录/注册 + 好友列表 + 单聊 UI
```

## 运行

```bash
cd client-electron
npm install        # 国内如下载慢: ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm install
npm start
```

> ⚠️ 如果 `npm start` 报 `ipcMain` undefined 或 `--version` 显示 Node 版本号：检查环境变量
> `ELECTRON_RUN_AS_NODE`——从 Electron 应用（如 WorkBuddy/VSCode）内嵌终端启动会继承它，
> 把 electron.exe 降级成纯 Node。清除后重试：`$env:ELECTRON_RUN_AS_NODE=$null`（PowerShell）
> 或 `unset ELECTRON_RUN_AS_NODE`（bash）。

前置条件：服务端已启动（`docker compose up -d --build`），GateServer 8080 可达。
登录流程：注册（需 VarifyServer 邮箱验证码，需先在 `docker/configs/VarifyServer/config.json` 填 SMTP 授权码）
→ 登录 → TCP 认证 → 好友列表/单聊。

## 已实现 / 未实现

- ✅ 注册、验证码、登录、TCP 认证、心跳、好友列表、好友申请/同意、搜索加好友、文本单聊（含送达回执 1018、在线推送 1019、thread_id 回填）
- ⬜ 图片消息(1035)、文件同步(1041)、历史消息加载(1029)、离线通知(1021)、群聊
- ⬜ 打包（electron-builder 打 Windows 安装包）
