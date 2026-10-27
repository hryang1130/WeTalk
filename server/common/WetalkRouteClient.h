#pragma once
// 对路由治理 UDP API（route_client）的线程安全封装。
// 底层 route_client 非线程安全；此处统一加锁并接入 ConfigMgr。
#include <string>
#include <memory>
#include <mutex>
#include <utility>
#include <vector>

class WetalkRouteClientImpl;

class WetalkRouteClient
{
public:
    static WetalkRouteClient& Instance();

    // 从 ConfigMgr 的 [Route] 段读取配置；Enable != true 时不启用（走静态配置兜底）
    void InitFromConfig();
    // 也可以手动初始化（测试用）
    void Init(const std::string& agent_ip, short agent_udp_base_port, int modid, int cmdid);

    bool enabled() const { return _enabled; }
    int modid() const { return _modid; }
    int cmdid() const { return _cmdid; }

    // 从 route-agent 获取一个健康节点；失败返回 false
    bool getHost(std::string& ip, int& port);
    // 取该 modid/cmdid 的全部节点（探活等场景用）；返回 0 表示成功，hosts 为 (ip, port) 列表
    int getRoute(std::vector<std::pair<std::string, int>>& hosts);
    // 上报一次调用结果：retcode 0 = 成功
    void report(const std::string& ip, int port, int retcode);

private:
    WetalkRouteClient() = default;
    bool _enabled = false;
    int _modid = 1;
    int _cmdid = 1;
    std::mutex _mtx;
    std::unique_ptr<WetalkRouteClientImpl> _impl;
};
