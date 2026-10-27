#include "route_api.h"
#include "re.pb.h"
#include <string.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <sys/time.h>
#include <netdb.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <unistd.h>
#include <errno.h>
#include <cstdio>
#include <thread>
#include <chrono>

// 请求-应答超时：agent 是同步 UDP 调用，若它假死/丢包，绝不能让调用方无限阻塞
#define ROUTE_IO_TIMEOUT_MS 300

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

    struct timeval tv;
    tv.tv_sec = 0;
    tv.tv_usec = ROUTE_IO_TIMEOUT_MS * 1000;

    for (int i = 0; i < 3; i++) {
        _sockfd[i] = socket(AF_INET, SOCK_DGRAM | SOCK_CLOEXEC, IPPROTO_UDP);
        if (_sockfd[i] == -1) {
            perror("socket()");
            exit(1);
        }
        // 收发都设超时：recvfrom 不再无限阻塞（上层还有 2 次重试 + 静态配置兜底）
        setsockopt(_sockfd[i], SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
        setsockopt(_sockfd[i], SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof(tv));
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
    if (route.empty()) return re::RET_NOEXIST;
    return re::RET_SUCC;
}

int route_client::get_route(int modid, int cmdid, route_set& route)
{
    re::GetRouteRequest req;
    req.set_modid(modid);
    req.set_cmdid(cmdid);

    char write_buf[4096], read_buf[80 * 1024];
    route_msg_head head;
    head.msglen = req.ByteSizeLong();
    head.msgid = re::ID_API_GetRouteRequest;
    memcpy(write_buf, &head, ROUTE_HEAD_LEN);
    req.SerializeToArray(write_buf + ROUTE_HEAD_LEN, head.msglen);

    int index = (modid + cmdid) % 3;
    int ret = sendto(_sockfd[index], write_buf, head.msglen + ROUTE_HEAD_LEN, 0, NULL, 0);
    if (ret == -1) { perror("sendto"); return re::RET_SYSTEM_ERROR; }

    re::GetRouteResponse rsp;
    int message_len = recvfrom(_sockfd[index], read_buf, sizeof(read_buf), 0, NULL, NULL);
    if (message_len == -1) {
        if (errno == EAGAIN || errno == EWOULDBLOCK)
            fprintf(stderr, "route_client: get_route timeout (%d ms)\n", ROUTE_IO_TIMEOUT_MS);
        else
            perror("recvfrom");
        return re::RET_SYSTEM_ERROR;
    }

    memcpy(&head, read_buf, ROUTE_HEAD_LEN);
    if (head.msgid != re::ID_API_GetRouteResponse) return re::RET_SYSTEM_ERROR;

    ret = rsp.ParseFromArray(read_buf + ROUTE_HEAD_LEN, message_len - ROUTE_HEAD_LEN);
    if (!ret || rsp.modid() != modid || rsp.cmdid() != cmdid) return re::RET_SYSTEM_ERROR;

    for (int i = 0; i < rsp.host_size(); i++) {
        const re::HostInfo& host = rsp.host(i);
        struct in_addr inaddr;
        inaddr.s_addr = ntohl(host.ip());   // 与 we_reactor reactor 的字节序约定保持一致
        route.push_back(ip_port(inet_ntoa(inaddr), host.port()));
    }
    return re::RET_SUCC;
}

int route_client::get_host(int modid, int cmdid, std::string& ip, int& port)
{
    uint32_t seq = _seqid++;
    re::GetHostRequest req;
    req.set_seq(seq);
    req.set_modid(modid);
    req.set_cmdid(cmdid);

    char write_buf[4096], read_buf[4096];
    route_msg_head head;
    head.msglen = req.ByteSizeLong();
    head.msgid = re::ID_GetHostRequest;
    memcpy(write_buf, &head, ROUTE_HEAD_LEN);
    req.SerializeToArray(write_buf + ROUTE_HEAD_LEN, head.msglen);

    int index = (modid + cmdid) % 3;
    int ret = sendto(_sockfd[index], write_buf, head.msglen + ROUTE_HEAD_LEN, 0, NULL, 0);
    if (ret == -1) { perror("sendto"); return re::RET_SYSTEM_ERROR; }

    re::GetHostResponse rsp;
    int message_len = recvfrom(_sockfd[index], read_buf, sizeof(read_buf), 0, NULL, NULL);
    if (message_len == -1) {
        if (errno == EAGAIN || errno == EWOULDBLOCK)
            fprintf(stderr, "route_client: get_host timeout (%d ms)\n", ROUTE_IO_TIMEOUT_MS);
        else
            perror("recvfrom");
        return re::RET_SYSTEM_ERROR;
    }

    memcpy(&head, read_buf, ROUTE_HEAD_LEN);
    if (head.msgid != re::ID_GetHostResponse) return re::RET_SYSTEM_ERROR;

    ret = rsp.ParseFromArray(read_buf + ROUTE_HEAD_LEN, message_len - ROUTE_HEAD_LEN);
    if (!ret || rsp.modid() != modid || rsp.cmdid() != cmdid) return re::RET_SYSTEM_ERROR;

    // 必须检查 retcode：agent 无路由/过载时回 RET_NOEXIST/RET_OVERLOAD，
    // 此时 host 字段是 proto3 默认值(ip=0,port=0)，若不检查会把 "0.0.0.0:0"
    // 当成有效结果返回（曾导致全新部署时所有登录失败）
    if (rsp.retcode() != re::RET_SUCC) return rsp.retcode();

    const re::HostInfo& host = rsp.host();
    struct in_addr inaddr;
    inaddr.s_addr = ntohl(host.ip());
    ip = inet_ntoa(inaddr);
    port = host.port();
    return re::RET_SUCC;
}

void route_client::report(int modid, int cmdid, const std::string& ip, int port, int retcode)
{
    re::ReportRequest req;
    req.set_modid(modid);
    req.set_cmdid(cmdid);

    // we_reactor proto：ReportRequest = {modid, cmdid, host(单个), retcode}
    struct in_addr inaddr;
    inet_aton(ip.c_str(), &inaddr);
    re::HostInfo* host = req.mutable_host();
    host->set_ip(htonl(inaddr.s_addr));
    host->set_port(port);
    req.set_retcode(retcode);

    char write_buf[4096];
    route_msg_head head;
    head.msglen = req.ByteSizeLong();
    head.msgid = re::ID_ReportRequest;
    memcpy(write_buf, &head, ROUTE_HEAD_LEN);
    req.SerializeToArray(write_buf + ROUTE_HEAD_LEN, head.msglen);

    // 必须和 get_host 走同一个分片：agent 每个 UDP 端口一套独立的 route_lb，
    // 发到别的端口会因为那套 route_lb 里没有这条 modid/cmdid 而被静默丢弃
    // （曾硬编码发到 index 1，导致上报永远不落库、失败率统计形同虚设）
    int index = (modid + cmdid) % 3;
    int ret = sendto(_sockfd[index], write_buf, head.msglen + ROUTE_HEAD_LEN, 0, NULL, 0);
    if (ret == -1) perror("sendto(report)");
}
