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

窗口尺寸自动联动：登录/注册页为 460×680 / 460×780（注册表单更长），登录成功切 1060×700 主界面。

## 界面设计说明（改 UI 前先看这段）

整体基调是**暖中性底 + 单一深酒红强调色**：不用冷灰、不用大面积渐变、不靠重阴影，
层次靠留白、字重和发丝线（`--line` / `--line-2`）区分。所有颜色、圆角、阴影都在
`renderer/style.css` 顶部的 `:root` 里，换主题只改那一块（用 CSS 变量而不是硬编码颜色）。

- 颜色：`--ink / --ink-2 / --ink-3 / --ink-4` 四级文字色，`--brand(#8c2f3b)` 强调，
  `--surface / --surface-2 / --canvas` 三级面，`--rail` 是左侧导航条。
- 形状：`--r-sm/md/lg/xl` = 8/12/16/20，阴影 `--shadow-1/2/3/pop`。
- 头像：字母 + 单色渐变（颜色由 uid 取色板），渐变在 CSS 里用 `--av` + `color-mix` 生成，
  JS 只负责 `el.style.setProperty('--av', color)`。
- 消息：气泡**只包内容**，时间和已读（`✓` / `✓✓`）放在气泡下方的小字里；
  同侧连续消息只在本组最后一条挂头像；消息按天分组（今天 / 昨天 / 10月21日）。
- 图标一律用描边 SVG（`.icon-svg`），不用 emoji 当图标——emoji 在不同机器上字重/大小都不稳。

### 改样式的可视化验证（重要）

不用靠猜。`tools/shot.js` 会用假数据把真实页面渲染并截图：

```bash
npm run shot        # 输出 client-electron/__ui/01-auth … 06-profile.png
```

原理：`tools/preload-stub.js` 把 `window.wetalk` 换成桩函数，`tools/seed-main.js`
在页面里直接灌 `state`（假好友/假会话/假图片），然后 `capturePage()` 出图。
改完 CSS/HTML 先跑它看一眼，比反复让人肉眼看快得多。
（`__ui/` 已 gitignore，纯本地产物。）

## 功能清单（全部已实现）

- ✅ 注册（邮箱验证码）、登录、TCP 认证、10s 心跳、断线原地重置回登录页
- ✅ 好友列表、好友申请/同意、搜索加好友
- ✅ 文本单聊（1017 发送 / 1018 送达回执 / 1019 在线推送 / thread_id 服务端自动建立）
- ✅ **表情面板**（😀 按钮，42 个常用 emoji，点选插入光标处）
- ✅ **图片收发**（📷 → ResourceServer 1037 分片上传 → ChatServer 1035 落库 → 对方经 1033 分片下载渲染）
- ✅ **历史消息**（1029 游标分页，滚到顶部加载更多）
- ✅ **已读回执**（打开会话/收到消息自动上报 1046，气泡下方显示 `✓` 未读 / `✓✓` 已读；对方在线实时收到 1048 通知，跨机经 gRPC 转发）
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
│   ├── index.html
│   ├── style.css      # 设计变量都在顶部 :root，改主题只改那里
│   └── app.js         # 渲染层逻辑（只通过 window.wetalk 与主进程通信）
├── tools/             # 开发工具（不进打包）
│   ├── shot.js        # npm run shot：假数据渲染真实页面并截图到 __ui/
│   ├── cdp-eval.js    # 连 Electron CDP 端口执行 JS（自动化验证 UI 状态用）
│   ├── send-one.js    # 以某账号登录并发一条文本给目标 uid（给 GUI 窗口喂实时消息）
│   ├── preload-stub.js
│   └── seed-main.js
├── test-e2e.js        # 端到端联调脚本（见下），node test-e2e.js [email] [passwd] [peer_uid]
├── test-img-cross.js  # 跨用户图片全链路（A 发→B 收 1039→B 下载→已读回执）
├── test-img-download.js # 跨用户下载 + token 反例
├── test-offline.js    # 离线消息：A 发→B 重登→unread_list + 历史含离线消息
├── test-file.js       # 文件消息：1003 上传→1035(fname/fsize)→历史 JSON→下载 md5 比对
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
node test-offline.js    # 离线消息：B 不在线 A 发消息 → B 登录收 unread_list + 历史含该消息
node test-file.js       # 文件消息全链路（npm run test:file）
node test-profile.js    # /user_profile：错误 token 拒绝 + 正常保存
```

## 断线自动重连

主进程在意外断线（网络错误/服务端断开）时按 1s→2s→4s→8s→16s→30s 指数退避自动重连（最多 8 次），
重连成功后自动重发 1005 认证；渲染层只在顶部显示琥珀色横幅，**不踢回登录页**，恢复后自动刷新
好友列表/未读数并补拉历史。要点：

- 主动断开（登出、手动重连、退出程序）会作废重连循环（代际号 `reconnectGen`）；
- 被丢弃的旧 socket 打了 `_wetalk_discard` 标记，其 close/error 事件不再触发重连（防止滚雪球）；
- 重连期间 `tcp:closed` 不会下发，渲染层只听 `tcp:reconnecting`；
- 验证方法：登录后 `docker restart wetalk-chat1 wetalk-chat2`，观察日志 `[reconnect]` 与横幅自动消失。

> 注意：脚本使用真实测试数据，不要把 `touid` 传成需要保留好友关系的账号后调用删除流程。

## 演示模式

`npm run mock` 启动假服务端（8080/8090/9090），无需 Docker 即可体验大部分 UI 交互；
真实服务端按 `../DEPLOY.md` 部署后，登录页把 Gate 地址改成服务器地址即可，客户端代码不用改。
