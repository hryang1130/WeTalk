#include "WetalkRouteClient.h"
#include "route/route_api.h"
#include "ConfigMgr.h"
#include <iostream>

// pimpl：隔离 route_api 头文件依赖
class WetalkRouteClientImpl
{
public:
    WetalkRouteClientImpl(const std::string& agent_ip, short base_port)
        : _client(agent_ip, base_port) {}

    int regInit(int modid, int cmdid) { return _client.reg_init(modid, cmdid); }
    int getHost(int modid, int cmdid, std::string& ip, int& port)
    { return _client.get_host(modid, cmdid, ip, port); }
    int getRoute(int modid, int cmdid, route_set& rs)
    { return _client.get_route(modid, cmdid, rs); }
    void report(int modid, int cmdid, const std::string& ip, int port, int ret)
    { _client.report(modid, cmdid, ip, port, ret); }

private:
    route_client _client;
};

WetalkRouteClient& WetalkRouteClient::Instance()
{
    static WetalkRouteClient inst;
    return inst;
}

void WetalkRouteClient::Init(const std::string& agent_ip, short agent_udp_base_port, int modid, int cmdid)
{
    std::lock_guard<std::mutex> lock(_mtx);
    try {
        _impl = std::make_unique<WetalkRouteClientImpl>(agent_ip, agent_udp_base_port);
        _modid = modid;
        _cmdid = cmdid;
        int ret = _impl->regInit(modid, cmdid);
        if (ret != 0) {
            std::cerr << "[Route] reg_init(" << modid << "," << cmdid
                      << ") no route yet, will retry on getHost" << std::endl;
        }
        _enabled = true;
        std::cout << "[Route] enabled: agent=" << agent_ip << ":" << agent_udp_base_port
                  << " modid=" << modid << " cmdid=" << cmdid << std::endl;
    }
    catch (const std::exception& e) {
        std::cerr << "[Route] init failed: " << e.what() << " (fallback to static config)" << std::endl;
        _enabled = false;
    }
}

void WetalkRouteClient::InitFromConfig()
{
    auto& cfg = ConfigMgr::Inst();
    std::string enable = cfg["Route"]["Enable"];
    if (enable != "true" && enable != "True" && enable != "1") {
        std::cout << "[Route] disabled, use static chatservers config" << std::endl;
        return;
    }
    Init(cfg["Route"]["AgentIp"],
         (short)atoi(cfg["Route"]["AgentPort"].c_str()),
         atoi(cfg["Route"]["Modid"].c_str()),
         atoi(cfg["Route"]["Cmdid"].c_str()));
}

bool WetalkRouteClient::getHost(std::string& ip, int& port)
{
    if (!_enabled) return false;
    std::lock_guard<std::mutex> lock(_mtx);
    for (int retry = 0; retry < 2; ++retry) {
        int ret = _impl->getHost(_modid, _cmdid, ip, port);
        if (ret == 0) return true;
    }
    return false;
}

int WetalkRouteClient::getRoute(std::vector<std::pair<std::string, int>>& hosts)
{
    if (!_enabled) return -1;
    std::lock_guard<std::mutex> lock(_mtx);
    route_set rs;
    int ret = _impl->getRoute(_modid, _cmdid, rs);
    if (ret != 0) return ret;
    hosts.reserve(hosts.size() + rs.size());
    for (route_set_it it = rs.begin(); it != rs.end(); ++it) {
        hosts.emplace_back(it->first, it->second);
    }
    return 0;
}

void WetalkRouteClient::report(const std::string& ip, int port, int retcode)
{
    if (!_enabled) return;
    std::lock_guard<std::mutex> lock(_mtx);
    _impl->report(_modid, _cmdid, ip, port, retcode);
}
