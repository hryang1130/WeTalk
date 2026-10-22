#include "LarsClient.h"
#include "lars/lars_api.h"
#include "ConfigMgr.h"
#include <iostream>

// pimpl：隔离 lars_api 头文件依赖
class LarsClientImpl
{
public:
    LarsClientImpl(const std::string& agent_ip, short base_port)
        : _client(agent_ip, base_port) {}

    int regInit(int modid, int cmdid) { return _client.reg_init(modid, cmdid); }
    int getHost(int modid, int cmdid, std::string& ip, int& port)
    { return _client.get_host(modid, cmdid, ip, port); }
    void report(int modid, int cmdid, const std::string& ip, int port, int ret)
    { _client.report(modid, cmdid, ip, port, ret); }

private:
    lars_client _client;
};

LarsClient& LarsClient::Instance()
{
    static LarsClient inst;
    return inst;
}

void LarsClient::Init(const std::string& agent_ip, short agent_udp_base_port, int modid, int cmdid)
{
    std::lock_guard<std::mutex> lock(_mtx);
    try {
        _impl = std::make_unique<LarsClientImpl>(agent_ip, agent_udp_base_port);
        _modid = modid;
        _cmdid = cmdid;
        int ret = _impl->regInit(modid, cmdid);
        if (ret != 0) {
            std::cerr << "[Lars] reg_init(" << modid << "," << cmdid
                      << ") no route yet, will retry on getHost" << std::endl;
        }
        _enabled = true;
        std::cout << "[Lars] enabled: agent=" << agent_ip << ":" << agent_udp_base_port
                  << " modid=" << modid << " cmdid=" << cmdid << std::endl;
    }
    catch (const std::exception& e) {
        std::cerr << "[Lars] init failed: " << e.what() << " (fallback to static config)" << std::endl;
        _enabled = false;
    }
}

void LarsClient::InitFromConfig()
{
    auto& cfg = ConfigMgr::Inst();
    std::string enable = cfg["Lars"]["Enable"];
    if (enable != "true" && enable != "True" && enable != "1") {
        std::cout << "[Lars] disabled, use static chatservers config" << std::endl;
        return;
    }
    Init(cfg["Lars"]["AgentIp"],
         (short)atoi(cfg["Lars"]["AgentPort"].c_str()),
         atoi(cfg["Lars"]["Modid"].c_str()),
         atoi(cfg["Lars"]["Cmdid"].c_str()));
}

bool LarsClient::getHost(std::string& ip, int& port)
{
    if (!_enabled) return false;
    std::lock_guard<std::mutex> lock(_mtx);
    for (int retry = 0; retry < 2; ++retry) {
        int ret = _impl->getHost(_modid, _cmdid, ip, port);
        if (ret == 0) return true;
    }
    return false;
}

void LarsClient::report(const std::string& ip, int port, int retcode)
{
    if (!_enabled) return;
    std::lock_guard<std::mutex> lock(_mtx);
    _impl->report(_modid, _cmdid, ip, port, retcode);
}
