#include "StatusServiceImpl.h"
#include "ConfigMgr.h"
#include "const.h"
#include "RedisMgr.h"
#include "WetalkRouteClient.h"
#include <climits>
#include <iostream>
#include <chrono>
#include <thread>
#include <vector>
#include <map>
#include <cstdlib>
#include <utility>
#include <iterator>
#include <ctime>
#include <fcntl.h>
#include <unistd.h>
#include <errno.h>
#include <sys/socket.h>
#include <sys/select.h>
#include <netinet/in.h>
#include <netdb.h>
#include <arpa/inet.h>

namespace {

// re.proto 的返回码（这里只用到两个，避免为了常量把 re.pb.h 拉进本 TU）
constexpr int ROUTE_RET_SUCC = 0;
constexpr int ROUTE_RET_SYSTEM_ERROR = 2;

// timeout_ms 内能否建立 TCP 连接。
// 注意：connect 不受 SO_SNDTIMEO 约束，必须用「非阻塞 connect + select」才能真正限时。
bool tcp_reachable(const std::string& ip, int port, int timeout_ms)
{
	struct sockaddr_in addr;
	bzero(&addr, sizeof(addr));
	addr.sin_family = AF_INET;
	// 点分 IP 直接用；容器服务名/域名走一次 DNS（compose 的 alias 也能解析）
	if (inet_pton(AF_INET, ip.c_str(), &addr.sin_addr) != 1) {
		struct addrinfo hints, *res = nullptr;
		bzero(&hints, sizeof(hints));
		hints.ai_family = AF_INET;
		hints.ai_socktype = SOCK_STREAM;
		if (getaddrinfo(ip.c_str(), nullptr, &hints, &res) != 0 || res == nullptr) {
			return false;
		}
		addr.sin_addr = ((struct sockaddr_in*)res->ai_addr)->sin_addr;
		freeaddrinfo(res);
	}
	addr.sin_port = htons((uint16_t)port);

	int fd = socket(AF_INET, SOCK_STREAM | SOCK_CLOEXEC, IPPROTO_TCP);
	if (fd < 0) {
		return false;
	}

	int flags = fcntl(fd, F_GETFL, 0);
	fcntl(fd, F_SETFL, flags | O_NONBLOCK);

	bool ok = false;
	int ret = connect(fd, (struct sockaddr*)&addr, sizeof(addr));
	if (ret == 0) {
		ok = true;
	}
	else if (errno == EINPROGRESS) {
		fd_set wset;
		FD_ZERO(&wset);
		FD_SET(fd, &wset);
		struct timeval tv;
		tv.tv_sec = timeout_ms / 1000;
		tv.tv_usec = (timeout_ms % 1000) * 1000;
		if (select(fd + 1, nullptr, &wset, nullptr, &tv) > 0) {
			int err = 0;
			socklen_t len = sizeof(err);
			if (getsockopt(fd, SOL_SOCKET, SO_ERROR, &err, &len) == 0 && err == 0) {
				ok = true;
			}
		}
	}

	close(fd);
	return ok;
}

} // namespace

std::string generate_unique_string() {
	// 创建UUID对象
	boost::uuids::uuid uuid = boost::uuids::random_generator()();

	// 将UUID转换为字符串
	std::string unique_string = to_string(uuid);

	return unique_string;
}

Status StatusServiceImpl::GetChatServer(ServerContext* context, const GetChatServerReq* request, GetChatServerRsp* reply)
{
	const auto& server = getChatServer();
	reply->set_host(server.host);
	reply->set_port(server.port);
	reply->set_error(ErrorCodes::Success);
	reply->set_token(generate_unique_string());
	insertToken(request->uid(), reply->token());

	// 上报不再放这里：这里只是「拿到了一台地址」，不代表那台机器活着。
	// 真实可达性由 startHealthProbe() 的探活线程上报（见下）。
	return Status::OK;
}

StatusServiceImpl::StatusServiceImpl()
{
	auto& cfg = ConfigMgr::Inst();
	auto server_list = cfg["chatservers"]["Name"];

	std::vector<std::string> words;

	std::stringstream ss(server_list);
	std::string word;

	while (std::getline(ss, word, ',')) {
		words.push_back(word);
	}

	for (auto& word : words) {
		if (cfg[word]["Name"].empty()) {
			continue;
		}

		ChatServer server;
		server.port = cfg[word]["Port"];
		server.host = cfg[word]["Host"];
		server.name = cfg[word]["Name"];
		_servers[server.name] = server;
	}

	// 路由治理：配置在 config.ini [Route] 段；未启用时退回静态配置
	WetalkRouteClient::Instance().InitFromConfig();

	// 探活上报：让 agent 的失败率窗口有真实数据
	startHealthProbe();
}

// 后台探活线程：每 3s 对路由里的每个 ChatServer 做一次 TCP connect，
// 成功/失败都上报给 route-agent。这样节点挂掉后 agent 能靠「连续失败次数 / 失败率」
// 把它标成 overload 并从 idle 队列摘掉，登录就不会再被调度到它。
void StatusServiceImpl::startHealthProbe()
{
	if (!WetalkRouteClient::Instance().enabled()) {
		std::cout << "[Route] health probe disabled (route not enabled)" << std::endl;
		return;
	}

	const int probe_interval_s = 3;     // 探活周期
	const int refresh_interval_s = 30;  // 从 agent 重新拉节点列表的周期
	const int probe_timeout_ms = 200;   // 单次 connect 超时

	std::cout << "[Route] health probe started: every " << probe_interval_s
	          << "s, timeout " << probe_timeout_ms << "ms" << std::endl;

	// 探活目标地址：端口 -> 集群内地址（来自静态配置 [chatserverN] Host）。
	// RouteData 里存的是「给客户端用的对外通告地址」，本机 Docker 部署时就是
	// 127.0.0.1——那个地址只有宿主机上的 Electron 客户端能用，status 在容器里
	// 探 127.0.0.1 探到的是自己，会把两台 ChatServer 全判死。
	// 所以按端口对上静态配置里的集群内地址来探活；上报仍然用 route 给的
	// (ip, port)，因为 agent 缓存里的 key 就是它（对不上会被 find 丢掉）。
	// 静态配置里没有的端口（例如热更新新加进来的节点）直接用 route 的地址。
	std::map<int, std::string> internal_host;
	for (const auto& kv : _servers) {
		internal_host[atoi(kv.second.port.c_str())] = kv.second.host;
	}

	std::thread([probe_interval_s, refresh_interval_s, probe_timeout_ms, internal_host]() {
		std::vector<std::pair<std::string, int>> hosts;
		time_t last_refresh = 0;

		while (true) {
			auto& route = WetalkRouteClient::Instance();
			time_t now = time(nullptr);

			// 节点列表来自 route-agent 的缓存（源头是 RouteData），定期刷新即可
			if (hosts.empty() || now - last_refresh >= refresh_interval_s) {
				std::vector<std::pair<std::string, int>> fresh;
				if (route.getRoute(fresh) == 0 && !fresh.empty()) {
					hosts.swap(fresh);
				}
				last_refresh = now;
			}

			for (size_t i = 0; i < hosts.size(); i++) {
				std::string target_ip = hosts[i].first;
				auto it = internal_host.find(hosts[i].second);
				if (it != internal_host.end()) {
					target_ip = it->second;
				}

				bool alive = tcp_reachable(target_ip, hosts[i].second, probe_timeout_ms);
				if (!alive) {
					std::cerr << "[Route] probe failed: " << target_ip << ":" << hosts[i].second
					          << " (route " << hosts[i].first << ":" << hosts[i].second << ")"
					          << std::endl;
				}

				// 上报用 route 的地址：agent 按 (ip, port) 在自己的缓存里找节点
				route.report(hosts[i].first, hosts[i].second,
					alive ? ROUTE_RET_SUCC : ROUTE_RET_SYSTEM_ERROR);
			}

			std::this_thread::sleep_for(std::chrono::seconds(probe_interval_s));
		}
	}).detach();
}

ChatServer StatusServiceImpl::getChatServer() {
	std::lock_guard<std::mutex> guard(_server_mtx);

	// 1) 优先走路由治理：由 route-agent 根据各节点失败率/过载状态返回健康节点
	auto& route = WetalkRouteClient::Instance();
	if (route.enabled()) {
		std::string ip;
		int port = 0;
		if (route.getHost(ip, port)) {
			ChatServer s;
			s.host = ip;
			s.port = std::to_string(port);
			s.name = ip + ":" + std::to_string(port);
			return s;
		}
		std::cerr << "[StatusServer] route get_host failed, fallback to static config" << std::endl;
	}

	// 2) 静态配置兜底：轮询。原实现总是返回 begin()（即第一个节点），
	//    降级时会把所有登录都压到同一台上，反而最不均衡。
	if (_servers.empty()) {
		return ChatServer();
	}
	size_t idx = _fallback_idx++ % _servers.size();
	auto it = _servers.begin();
	std::advance(it, static_cast<long>(idx));

	return it->second;
}

Status StatusServiceImpl::Login(ServerContext* context, const LoginReq* request, LoginRsp* reply)
{
	auto uid = request->uid();
	auto token = request->token();

	std::string uid_str = std::to_string(uid);
	std::string token_key = USERTOKENPREFIX + uid_str;
	std::string token_value = "";
	bool success = RedisMgr::GetInstance()->Get(token_key, token_value);
	if (success) {
		reply->set_error(ErrorCodes::UidInvalid);
		return Status::OK;
	}

	if (token_value != token) {
		reply->set_error(ErrorCodes::TokenInvalid);
		return Status::OK;
	}
	reply->set_error(ErrorCodes::Success);
	reply->set_uid(uid);
	reply->set_token(token);
	return Status::OK;
}

void StatusServiceImpl::insertToken(int uid, std::string token)
{
	std::string uid_str = std::to_string(uid);
	std::string token_key = USERTOKENPREFIX + uid_str;
	RedisMgr::GetInstance()->Set(token_key, token);
}
