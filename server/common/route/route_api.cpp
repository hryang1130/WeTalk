#include "route_api.h"
#include "lars.pb.h"
#include "message.h" // vendored reactor: msg_head / MESSAGE_HEAD_LEN
#include <string.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <netdb.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <unistd.h>
#include <cstdio>
#include <thread>
#include <chrono>

// agent 地址解析：点分 IP 直接用；非点分（容器服务名/域名）走 getaddrinfo，
// 解析失败直接报错退出（比静默 0.0.0.0 好排查）
static bool resolve_agent(const std::string& host, struct in_addr* out)
{
    if (inet_pton(AF_INET, host.c_str(), out) == 1) return true;
    struct addrinfo hints, *res = nullptr;
    bzero(&hints, sizeof(hints));
    hints.ai_family = AF_INET;
    hints.ai_socktype = SOCK_DGRAM;
    if (getaddrinfo(host.c_str(), nullptr, &hints, &res) != 0 || res == nullptr) return false;
    *out = ((struct sockaddr_in*)res->ai_addr)->sin_addr;
    freeaddrinfo(res);
    return true;
}

route_client::route_client(const std::string& agent_ip, short udp_base_port) : _seqid(0)
{
    struct sockaddr_in servaddr;
    bzero(&servaddr, sizeof(servaddr));
    servaddr.sin_family = AF_INET;
    if (!resolve_agent(agent_ip, &servaddr.sin_addr)) {
        fprintf(stderr, "route_client: cannot resolve agent address '%s'\n", agent_ip.c_str());
        exit(1);
    }

    for (int i = 0; i < 3; i++) {
        _sockfd[i] = socket(AF_INET, SOCK_DGRAM | SOCK_CLOEXEC, IPPROTO_UDP);
        if (_sockfd[i] == -1) {
            perror("socket()");
            exit(1);
        }
        servaddr.sin_port = htons(udp_base_port + i);
        int ret = connect(_sockfd[i], (const struct sockaddr*)&servaddr, sizeof(servaddr));
        if (ret == -1) {
            perror("connect()");
            exit(1);
        }
    }
}

route_client::~route_client()
{
    for (int i = 0; i < 3; ++i) close(_sockfd[i]);
}

int route_client::reg_init(int modid, int cmdid)
{
    route_set route;
    int retry_cnt = 0;
    while (route.empty() && retry_cnt < 3) {
        get_route(modid, cmdid, route);
        if (route.empty()) std::this_thread::sleep_for(std::chrono::milliseconds(50));
        else break;
        ++retry_cnt;
    }
    if (route.empty()) return lars::RET_NOEXIST;
    return lars::RET_SUCC;
}

int route_client::get_route(int modid, int cmdid, route_set& route)
{
    lars::GetRouteRequest req;
    req.set_modid(modid);
    req.set_cmdid(cmdid);

    char write_buf[4096], read_buf[80 * 1024];
    msg_head head;
    head.msglen = req.ByteSizeLong();
    head.msgid = lars::ID_API_GetRouteRequest;
    memcpy(write_buf, &head, MESSAGE_HEAD_LEN);
    req.SerializeToArray(write_buf + MESSAGE_HEAD_LEN, head.msglen);

    int index = (modid + cmdid) % 3;
    int ret = sendto(_sockfd[index], write_buf, head.msglen + MESSAGE_HEAD_LEN, 0, NULL, 0);
    if (ret == -1) { perror("sendto"); return lars::RET_SYSTEM_ERROR; }

    lars::GetRouteResponse rsp;
    int message_len = recvfrom(_sockfd[index], read_buf, sizeof(read_buf), 0, NULL, NULL);
    if (message_len == -1) { perror("recvfrom"); return lars::RET_SYSTEM_ERROR; }

    memcpy(&head, read_buf, MESSAGE_HEAD_LEN);
    if (head.msgid != lars::ID_API_GetRouteResponse) return lars::RET_SYSTEM_ERROR;

    ret = rsp.ParseFromArray(read_buf + MESSAGE_HEAD_LEN, message_len - MESSAGE_HEAD_LEN);
    if (!ret || rsp.modid() != modid || rsp.cmdid() != cmdid) return lars::RET_SYSTEM_ERROR;

    for (int i = 0; i < rsp.host_size(); i++) {
        const lars::HostInfo& host = rsp.host(i);
        struct in_addr inaddr;
        inaddr.s_addr = ntohl(host.ip());   // 与 vendored reactor 的字节序约定保持一致
        route.push_back(ip_port(inet_ntoa(inaddr), host.port()));
    }
    return lars::RET_SUCC;
}

int route_client::get_host(int modid, int cmdid, std::string& ip, int& port)
{
    uint32_t seq = _seqid++;
    lars::GetHostRequest req;
    req.set_seq(seq);
    req.set_modid(modid);
    req.set_cmdid(cmdid);

    char write_buf[4096], read_buf[4096];
    msg_head head;
    head.msglen = req.ByteSizeLong();
    head.msgid = lars::ID_GetHostRequest;
    memcpy(write_buf, &head, MESSAGE_HEAD_LEN);
    req.SerializeToArray(write_buf + MESSAGE_HEAD_LEN, head.msglen);

    int index = (modid + cmdid) % 3;
    int ret = sendto(_sockfd[index], write_buf, head.msglen + MESSAGE_HEAD_LEN, 0, NULL, 0);
    if (ret == -1) { perror("sendto"); return lars::RET_SYSTEM_ERROR; }

    lars::GetHostResponse rsp;
    int message_len = recvfrom(_sockfd[index], read_buf, sizeof(read_buf), 0, NULL, NULL);
    if (message_len == -1) { perror("recvfrom"); return lars::RET_SYSTEM_ERROR; }

    memcpy(&head, read_buf, MESSAGE_HEAD_LEN);
    if (head.msgid != lars::ID_GetHostResponse) return lars::RET_SYSTEM_ERROR;

    ret = rsp.ParseFromArray(read_buf + MESSAGE_HEAD_LEN, message_len - MESSAGE_HEAD_LEN);
    if (!ret || rsp.modid() != modid || rsp.cmdid() != cmdid) return lars::RET_SYSTEM_ERROR;

    // 必须检查 retcode：agent 无路由/过载时回 RET_NOEXIST/RET_OVERLOAD，
    // 此时 host 字段是 proto3 默认值(ip=0,port=0)，若不检查会把 "0.0.0.0:0"
    // 当成有效结果返回（曾导致全新部署时所有登录失败）
    if (rsp.retcode() != lars::RET_SUCC) return rsp.retcode();

    const lars::HostInfo& host = rsp.host();
    struct in_addr inaddr;
    inaddr.s_addr = ntohl(host.ip());
    ip = inet_ntoa(inaddr);
    port = host.port();
    return lars::RET_SUCC;
}

void route_client::report(int modid, int cmdid, const std::string& ip, int port, int retcode)
{
    lars::ReportRequest req;
    req.set_modid(modid);
    req.set_cmdid(cmdid);

    // vendored proto：ReportRequest = {modid, cmdid, host(单个), retcode}
    struct in_addr inaddr;
    inet_aton(ip.c_str(), &inaddr);
    lars::HostInfo* host = req.mutable_host();
    host->set_ip(htonl(inaddr.s_addr));
    host->set_port(port);
    req.set_retcode(retcode);

    char write_buf[4096];
    msg_head head;
    head.msglen = req.ByteSizeLong();
    head.msgid = lars::ID_ReportRequest;
    memcpy(write_buf, &head, MESSAGE_HEAD_LEN);
    req.SerializeToArray(write_buf + MESSAGE_HEAD_LEN, head.msglen);

    // report 走第二个 agent udp server
    int ret = sendto(_sockfd[1], write_buf, head.msglen + MESSAGE_HEAD_LEN, 0, NULL, 0);
    if (ret == -1) perror("sendto(report)");
}
