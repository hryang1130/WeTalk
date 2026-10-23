# WeTalk Electron 桌面客户端

用 Electron + Node.js 重写的桌面客户端，**不依赖 Qt**，直接对接 WeTalk 整合服务端
（llfcchat 微服务 + Lars 负载均衡）。

## 运行

```bash
cd client-electron
npm install        # 国内如下载慢: ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm install
npm start
```

前置条件：服务端已启动（根目录 `docker compose up -d --build`），GateServer 8080 可达。

> ⚠️ 如果 `npm start` 报 `ipcMain` undefined 或 `--version` 显示 Node 版本号：检查环境变量
> `ELECTRON_RUN_AS_NODE`——从 Electron 应用（如 WorkBuddy/VSCode）内嵌终端启动会继承它，
> 把 electron.exe 降级成纯 Node。清除后重试：`$env:ELECTRON_RUN_AS_NODE=$null`（PowerShell）
> 或 `unset ELECTRON_RUN_AS_NODE`（bash）。

窗口尺寸自动联动：登录/注册页为 460×680 小窗，登录成功切 1060×700 主界面。

## 功能清单（全部已实现）

- ✅ 注册（邮箱验证码）、登录、TCP 认证、30s 心跳、断线原地重置回登录页
- ✅ 好友列表、好友申请/同意、搜索加好友
- ✅ 文本单聊（1017 发送 / 1018 送达回执 / 1019 在线推送 / thread_id 服务端自动建立）
- ✅ **表情面板**（😀 按钮，42 个常用 emoji，点选插入光标处）
- ✅ **图片收发**（📷 → ResourceServer 1037 分片上传 → ChatServer 1035 落库 → 对方经 1033 分片下载渲染）
- ✅ **历史消息**（1029 游标分页，滚到顶部加载更多）
- ✅ **已读回执**（打开会话/收到消息自动上报 1046，气泡显示 已读/未读；对方在线实时收到 1048 通知，跨机经 gRPC 转发）
- ✅ **删除好友**（聊天窗口右上角 🗑，双向删除，对方在线实时收到 1045 通知，跨机经 gRPC 转发）
- ✅ **个人资料设置**（点左下角自己的头像 → 改昵称/签名 → GateServer `POST /user_profile`，token 校验 + Redis 缓存失效）
- ✅ 会话列表按最近消息排序、输入框自适应高度、发送按钮随内容启用
- ✅ 打包：`npm run dist` → `dist/WeTalk-Setup-0.1.0.exe`（NSIS 安装器）
- ⬜ 一般文件传输（1041 双向确认流程）、离线通知(1021)、群聊

## 协议对接说明（面试可讲）

服务端对客户端只暴露两种协议，与客户端语言无关：

1. **HTTP**（GateServer :8080，自写 Beast HTTP）：
   - `POST /get_varifycode` `{email}` → 发送邮箱验证码
   - `POST /user_register` `{email,user,nick,passwd,confirm,icon,varifycode}` → `{uid}`
   - `POST /user_login` `{email,passwd}` → `{uid, token, chathost, chatport, reshost, resport}`
     （chathost 由 StatusServer→Lars 负载均衡选出，这正是整合项目的核心链路）
   - `POST /user_profile` `{uid, token, nick, desc}` → 更新个人资料（校验 Redis token，更新 MySQL 后删除 `ubaseinfo_<uid>` 缓存）
2. **TCP 长连接**（ChatServer :8090/:8091，Asio）：
   - 帧格式：`msgid(2B 大端) + msglen(2B 大端) + JSON body`
   - `1005` TCP 登录 `{uid, token}`（token 校验 Redis `utoken_<uid>`）
   - `1017` 文本消息 / `1018` 送达回执 / `1019` 在线推送
   - `1035` 图片消息 / `1036` 回执（含 message_id，供已读标记）
   - `1043/1044/1045` 删除好友 / 回执 / 被删通知
   - `1046/1047/1048` 已读上报 / 回执 / 已读通知（uid=已读方，touid=收通知的发送方）
   - `1007/1009/1013` 搜索 / 加好友 / 认证好友，`1023` 心跳
   - 常量表与 `server/ChatServer/const.h` 的 `MSG_IDS` 枚举一一对应
3. **ResourceServer 数据面**（:9090，直连）：
   - ⚠️ **包头与 ChatServer 不同**：`msgid(2B 大端) + msglen(4B 大端)`，共 6 字节
     （见 `server/ResourceServer/const.h`，这是踩过的坑）
   - `1037` 图片分片上传（片 ≤32KB，JSON 内 data=base64）/ `1033` 分片下载（首片校验 uid+token）
   - 响应 msgid = 请求 msgid + 1
   - ⚠️ **下载路径按 uid 分目录**：上传落在 `out/<上传者uid>/<name>`，而 1033 默认按
     **请求方 uid** 拼 `out/<请求方uid>/<name>`，所以「B 下载 A 发的图」天然 404
     （现象：气泡里只有文件名、缩略图空白）。已在
     `server/ResourceServer/LogicWorker.cpp` 的 `ID_DOWN_LOAD_FILE_REQ` 里加了跨用户定位：
     直连路径不存在时按文件名在 `out/*/` 下找回（图片 name 就是内容 md5，天然唯一）。
     回归脚本：`node test-img-download.js`（A 上传→B 下载→字节比对 + 伪造 token 反例）。
   - 上传目录由 `[Output] Path` + `[Static] Path` 决定（= cwd/Path/Static）。
     本仓库配成 `data/img`，compose 把 `./docker/data/resource` 挂到 `/app/data`，
     **不挂卷的话重建镜像/重启容器会把所有图片一起清空**。


gRPC 只存在于服务间调用（Gate↔Status↔Chat、Chat↔Chat 同类通知），客户端完全不接触。

## 目录

```
client-electron/
├── main.js            # 主进程：ChatServer 长连接 + ResourceServer 数据面 + IPC（含窗口尺寸/焦点修复）
├── preload.js         # contextBridge 桥接（sandbox:false，renderer 不开 nodeIntegration）
├── core/protocol.js   # ChatServer 线协议 + 全部 MSG_IDS（与 C++ const.h 对齐）
├── core/resClient.js  # ResourceServer 客户端（6B 包头！分片上传/下载，data=base64，片≤32KB）
├── core/md5.js        # 纯 JS MD5（Web Crypto 无 MD5；服务端用内容 md5 做去重/续传 key）
├── renderer/          # 登录/注册 + 三栏主界面 + 聊天 + 表情面板 + 资料弹窗
├── test-e2e.js        # 端到端联调脚本（见下），node test-e2e.js [email] [passwd] [peer_uid]
├── test-img-cross.js  # 跨用户图片全链路（A 发→B 收 1039→B 下载→已读回执）
├── test-img-download.js # 跨用户下载 + token 反例
├── test-profile.js    # /user_profile 端点联调脚本
└── mock-server.js     # 本地演示服务（8080/8090/9090），无需 Docker 即可体验 UI
```

## 联调测试脚本

服务端 12 容器全部在跑的前提下：

```bash
node test-e2e.js        # HTTP登录→TCP认证→表情文本(1017)→图片上传(1037)→图片消息(1035)
                        # →历史(1029)→图片下载字节比对→已读上报(1046)，全链路 ALL PASS 输出
node test-img-download.js  # 跨用户图片下载：xm 上传 → hao 下载 → 字节一致（+ 伪造 token 应被拒）
node test-img-cross.js  # 复刻真实场景：A 上传→A 发 1035→B 在线收 1039→B 下载比对→B 报已读→A 收 1048
node test-profile.js    # /user_profile：错误 token 拒绝 + 正常保存
```

> 注意：脚本使用真实测试数据，不要把 `touid` 传成需要保留好友关系的账号后调用删除流程。

## 演示模式

`npm run mock` 启动假服务端（8080/8090/9090），无需 Docker 即可体验大部分 UI 交互；
真实服务端按 `../DEPLOY.md` 部署后，登录页把 Gate 地址改成服务器地址即可，客户端代码不用改。
