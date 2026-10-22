#include "StatusServiceImpl.h"
#include "ConfigMgr.h"
#include "const.h"
#include "RedisMgr.h"
#include "LarsClient.h"
#include <climits>
#include <iostream>

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

	// 向 Lars 上报一次成功调度，供 Agent 窗口统计失败率 / 过载判断
	auto& lars = LarsClient::Instance();
	if (lars.enabled()) {
		lars.report(server.host, atoi(server.port.c_str()), 0);
	}
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

	// Lars 服务治理：配置在 config.ini [Lars] 段；未启用时退回静态配置
	LarsClient::Instance().InitFromConfig();
}

ChatServer StatusServiceImpl::getChatServer() {
	std::lock_guard<std::mutex> guard(_server_mtx);

	// 1) 优先走 Lars：由 Agent 根据各节点失败率/过载状态返回健康节点
	auto& lars = LarsClient::Instance();
	if (lars.enabled()) {
		std::string ip;
		int port = 0;
		if (lars.getHost(ip, port)) {
			ChatServer s;
			s.host = ip;
			s.port = std::to_string(port);
			s.name = ip + ":" + std::to_string(port);
			return s;
		}
		std::cerr << "[StatusServer] Lars get_host failed, fallback to static config" << std::endl;
	}

	// 2) 静态配置兜底（原实现）：返回配置列表中的第一个节点
	auto minServer = _servers.begin()->second;

	// TODO(lars): 原有基于 Redis LOGIN_COUNT 的最小连接数逻辑已由 Lars 窗口统计替代，
	// 如需保留双写，可在 CServer::on_timer 中继续维护 LOGIN_COUNT。

	return minServer;
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
