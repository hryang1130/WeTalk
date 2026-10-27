# we_reactor

we_reactor 是 **WeTalk 内置的 UDP 路由治理层实现**，为 WeTalk 的微服务提供「服务发现 + 负载均衡 +
调用健康度统计」能力。它由四个模块组成，随主仓库一起构建，不依赖任何外部包管理器：

| 目录 | 产物 | 对外组件名 | 职责 |
| --- | --- | --- | --- |
| `re_reactor/` | `lib/libre_reactor.a` | — | 事件循环 / TCP·UDP 连接 / 线程池，其余三个模块的公共网络库 |
| `re_dns/` | `bin/re_dns` | **route-dns** | 路由表权威节点：持有 `wetalk_route.RouteData`，向提供者与调用方提供查询接口 |
| `re_reporter/` | `bin/re_reporter` | **route-reporter** | 接收各节点上报的调用结果，按滚动窗口统计健康度并推送版本变更 |
| `re_lb_agent/` | `bin/re_lb_agent` | **route-agent** | 部署在每个业务节点旁，按失败率 / 过载窗口筛选可用节点，供调用方 `get_route` |

> 对外一律使用 **route-dns / route-reporter / route-agent** 这套组件名（文档、架构图、compose、
> 配置皆是如此）；`re_*` 是内部实现目录名，不出现在对外表述里。

## 协议

`base/proto/re.proto`（protobuf，包名 `re`）定义治理层内部的消息体。传输层是自定义 UDP 私有协议：

```
msg_head { int32 msgid; int32 msglen; }  +  protobuf body
```

`msgid` 取值为 `ID_GetHostRequest` / `ID_GetHostResponse` / `ID_ReportRequest` 等（见 proto 文件）。
`msglen` 是 body 长度，两字段均为 4 字节小端。

端口规则：服务的 API 端口为 `udp_base_port + (modid + cmdid) % 3`，因此 `modid=1, cmdid=1` 时
（WeTalk 的 ChatServer 路由）实际监听的是 **8890**，而不是配置里的基础端口 8888 —— 联调时按这个算。

## 构建

依赖 `g++`、`make`、`protobuf`（`protoc` + `libprotobuf`）、`libssl`、`libzstd`、`libmysqlclient`。
protobuf 代码需要先生成：

```bash
cd we_reactor
protoc --cpp_out=base/proto -Ibase/proto base/proto/re.proto
make -C re_reactor && make -C re_dns && make -C re_reporter && make -C re_lb_agent
```

Docker 构建见 `docker/Dockerfile.route-{dns,reporter,agent}`：镜像里把系统 `libmysqlclient` 软链成
模块 Makefile 期望的 `base/mysql-connector-c` 布局（该目录不入库）。

## WeTalk patch 清单

以下是本仓库对治理层实现做的修补，源码中均带 `WeTalk patch` 注释。**动这块必须保留注释并同步本文档**：

| 文件 | 修补内容 |
| --- | --- |
| `re_reactor/src/tcp_server.cpp` | `SOCK_NONBLOCK` 曾被注释掉，导致 listen fd 阻塞、主线程卡死在 `accept()`；已恢复非阻塞 |
| `re_reactor/src/thread_pool.cpp` | `get_thread()` 缺少 `_index++`，所有连接都被投递到 0 号线程 |
| `re_dns/src/subscribe.cpp` | `SubscribeList()` 构造函数为空，两个 `pthread_mutex_t` 落在堆上未初始化（`new T()` 存在用户构造函数时不做零初始化）——垃圾值偶然呈「已锁」态时 subscribe/publish 永久阻塞在无人唤醒的 futex。已在构造函数里显式 `pthread_mutex_init` |

## 约定

- 这里的代码是 WeTalk 的内置实现，读者视角应当是「我们自己的治理层」，不要表述成第三方依赖。
- 修改本目录需遵循仓库根的 `AGENT.md`：补丁加 `WeTalk patch` 注释、对外名称统一为 route-* 组件名。
- `re_reactor` 的 `tcp_client` / `udp_client` 用 `inet_aton()` 解析地址，**不认容器服务名**，
  配置里必须写点分 IP（见 `docker/route/route_agent.conf`）。

## License

见本目录 `LICENSE`。
