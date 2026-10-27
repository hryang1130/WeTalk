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

依赖 `cmake ≥ 3.16`、`g++`、`protobuf`（`protoc` + `libprotobuf`）；只有 `re_dns` / `re_reporter` 额外需要
`libmysqlclient`（`re_lb_agent` 的路由表在内存里，不连库）。全部走 CMake，`re.pb.cc` 由 CMake 自动调用 protoc 生成。

```bash
# 三个可执行体（route-dns / route-reporter / route-agent），产物在 build/bin/
cmake -S we_reactor -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build -j"$(nproc)"

# 只构建其中一个（三个镜像各自这么做：route-agent 因此完全不碰 MySQL）
cmake -S we_reactor -B build -DCMAKE_BUILD_TYPE=Release -DWE_REACTOR_BINS=re_lb_agent
cmake --build build -j"$(nproc)" --target re_lb_agent

# 只要 re.pb（服务端构建就是这么用的：不编译 reactor 网络库，也不需要 MySQL）
cmake -S we_reactor -B build -DCMAKE_BUILD_TYPE=Release \
      -DWE_REACTOR_BUILD_BINS=OFF -DWE_REACTOR_BUILD_NET=OFF
```

`server/CMakeLists.txt` 通过 `add_subdirectory` 引入本目录，并置 `WE_REACTOR_BUILD_BINS=OFF` /
`WE_REACTOR_BUILD_NET=OFF` —— 服务端只用 `re.pb` 的消息定义，自己实现 UDP 客户端
（`server/common/route/route_api.cpp`），所以既不编 reactor 也不拉 MySQL 依赖。
Docker 构建见 `docker/Dockerfile.route-{dns,reporter,agent}`。

## WeTalk patch 清单

以下是本仓库对治理层实现做的修补，源码中均带 `WeTalk patch` 注释。**动这块必须保留注释并同步本文档**：

| 文件 | 修补内容 |
| --- | --- |
| `re_reactor/src/tcp_server.cpp` | `SOCK_NONBLOCK` 曾被注释掉，导致 listen fd 阻塞、主线程卡死在 `accept()`；已恢复非阻塞 |
| `re_reactor/src/thread_pool.cpp` | `get_thread()` 缺少 `_index++`，所有连接都被投递到 0 号线程 |
| `re_dns/src/subscribe.cpp` | `SubscribeList()` 构造函数为空，两个 `pthread_mutex_t` 落在堆上未初始化（`new T()` 存在用户构造函数时不做零初始化）——垃圾值偶然呈「已锁」态时 subscribe/publish 永久阻塞在无人唤醒的 futex。已在构造函数里显式 `pthread_mutex_init` |

