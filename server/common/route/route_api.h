#pragma once
// WeTalk 路由治理 API（route_client）：
// 1) agent 地址由构造参数传入（容器化部署必需）
// 2) 协议与 we_reactor（route-dns/agent）实现保持一致（UDP 私有协议 + re.pb 消息）
//
// 注：这里只用裸 socket + protobuf，不依赖 we_reactor 的 reactor 网络库，
// 所以服务端构建不需要编译 re_reactor（见 server/CMakeLists.txt）。
#include <string>
#include <vector>
#include <utility>
#include <stdint.h>

// 治理层 UDP 私有协议头：{msgid, msglen}，与 we_reactor 的 msg_head 同布局（8 字节，主机序）
struct route_msg_head
{
    int32_t msgid;
    int32_t msglen;
};
#define ROUTE_HEAD_LEN 8

typedef std::pair<std::string, int> ip_port;
typedef std::vector<ip_port> route_set;
typedef route_set::iterator route_set_it;

class route_client
{
public:
    // agent_ip: route-agent 的 UDP 地址; udp_base_port: agent 的 3 个 UDP 端口基数(默认 8888)
    route_client(const std::string& agent_ip, short udp_base_port = 8888);
    ~route_client();

    int reg_init(int modid, int cmdid);
    int get_host(int modid, int cmdid, std::string& ip, int& port);
    void report(int modid, int cmdid, const std::string& ip, int port, int retcode);
    int get_route(int modid, int cmdid, route_set& route);

private:
    int _sockfd[3];
    uint32_t _seqid;
};
