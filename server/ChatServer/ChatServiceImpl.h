#pragma once
#include <grpcpp/grpcpp.h>
#include "message.grpc.pb.h"
#include "message.pb.h"
#include <mutex>
#include "data.h"
#include "CServer.h"
#include <memory>

using grpc::Server;
using grpc::ServerBuilder;
using grpc::ServerContext;
using grpc::Status;
using message::AddFriendReq;
using message::AddFriendRsp;

using message::AuthFriendReq;
using message::AuthFriendRsp;

using message::ChatService;
using message::TextChatMsgReq;
using message::TextChatMsgRsp;
using message::TextChatData;
using message::KickUserReq;
using message::KickUserRsp;
using message::ReadMsgReq;
using message::ReadMsgRsp;
using message::DelFriendReq;
using message::DelFriendRsp;
using message::ImgChatMsgReq;
using message::ImgChatMsgRsp;


class ChatServiceImpl final: public ChatService::Service
{
public:
	ChatServiceImpl();
	Status NotifyAddFriend(ServerContext* context, const AddFriendReq* request,
		AddFriendRsp* reply) override;

	Status NotifyAuthFriend(ServerContext* context, 
		const AuthFriendReq* request, AuthFriendRsp* response) override;

	Status NotifyTextChatMsg(::grpc::ServerContext* context, 
		const TextChatMsgReq* request, TextChatMsgRsp* response) override;

	bool GetBaseInfo(std::string base_key, int uid, std::shared_ptr<UserInfo>& userinfo);

	//接受rpc踢人请求
	Status NotifyKickUser(::grpc::ServerContext* context,
		const KickUserReq* request, KickUserRsp* response) override;

	//已读上报跨机通知（推给消息发送方 touid）
	Status NotifyReadMsg(::grpc::ServerContext* context,
		const ReadMsgReq* request, ReadMsgRsp* response) override;

	//删除好友跨机通知（推给被删方 touid）
	Status NotifyDelFriend(::grpc::ServerContext* context,
		const DelFriendReq* request, DelFriendRsp* response) override;

	//图片消息跨机通知（推给接收方 touid）
	Status NotifyImgChatMsg(::grpc::ServerContext* context,
		const ImgChatMsgReq* request, ImgChatMsgRsp* response) override;

	void RegisterServer(std::shared_ptr<CServer> pServer);
private:
	std::shared_ptr<CServer> _p_server;
};

