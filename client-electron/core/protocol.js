// WeTalk 线协议：4 字节头(msgid 2B 大端 + msglen 2B 大端) + JSON body
// 与 server/ChatServer/const.h 的 MSG_IDS 保持一致，服务端 CSession::asyncReadFull 用
// network_to_host_short 解析，故两端都按大端(网络字节序)编解码。
const HEAD_TOTAL_LEN = 4;
const HEAD_ID_LEN = 2;
const HEAD_DATA_LEN = 2;

// 服务端 server/ChatServer/const.h MSG_IDS（勿改，与 C++ 枚举一一对应）
const MSG_IDS = {
  MSG_CHAT_LOGIN: 1005,          // TCP 登录(带 HTTP 登录返回的 token)
  MSG_CHAT_LOGIN_RSP: 1006,
  ID_SEARCH_USER_REQ: 1007,      // {uid: "搜索串(uid或name)"}
  ID_SEARCH_USER_RSP: 1008,
  ID_ADD_FRIEND_REQ: 1009,       // {uid, applyname, bakname, touid}
  ID_ADD_FRIEND_RSP: 1010,
  ID_NOTIFY_ADD_FRIEND_REQ: 1011,// {applyuid, name, desc, icon, sex, nick}
  ID_AUTH_FRIEND_REQ: 1013,      // {fromuid, touid, back}
  ID_AUTH_FRIEND_RSP: 1014,
  ID_NOTIFY_AUTH_FRIEND_REQ: 1015,
  ID_TEXT_CHAT_MSG_REQ: 1017,    // {fromuid, touid, thread_id, text_array:[{content, unique_id}]}
  ID_TEXT_CHAT_MSG_RSP: 1018,    // {error, fromuid, touid, thread_id, chat_datas:[...]}
  ID_NOTIFY_TEXT_CHAT_MSG_REQ: 1019,
  ID_NOTIFY_OFF_LINE_REQ: 1021,
  ID_HEART_BEAT_REQ: 1023,
  ID_HEARTBEAT_RSP: 1024,
  ID_LOAD_CHAT_MSG_REQ: 1029,
  ID_LOAD_CHAT_MSG_RSP: 1030,
  ID_IMG_CHAT_MSG_REQ: 1035,
};

// server/GateServer/const.h ErrorCodes（响应 error 字段）
const ERROR_CODES = {
  0: '成功',
  1001: 'JSON解析错误',
  1002: 'RPC请求失败',
  1003: '验证码过期',
  1004: '验证码错误',
  1005: '用户已存在',
  1006: '密码错误',
  1007: '邮箱不匹配',
  1009: '密码更新失败',
  1010: 'Token失效',
  1011: 'uid无效',
  1012: '创建聊天失败',
  1013: '加载聊天失败',
};

/** 组帧：msgid + JSON 对象 -> Buffer */
function encodeFrame(msgid, obj) {
  const body = Buffer.from(JSON.stringify(obj || {}), 'utf8');
  const head = Buffer.alloc(HEAD_TOTAL_LEN);
  head.writeUInt16BE(msgid, 0);
  head.writeUInt16BE(body.length, HEAD_ID_LEN);
  return Buffer.concat([head, body]);
}

/**
 * 增量拆包状态机：把 socket 收到的字节流喂进来，吐出完整帧。
 * 用法: state = {buf: Buffer.alloc(0)}; on chunk -> decodeFrames(state, chunk) => [{msgid, obj}]
 */
function decodeFrames(state, chunk, onError) {
  state.buf = state.buf.length ? Buffer.concat([state.buf, chunk]) : chunk;
  const frames = [];
  while (state.buf.length >= HEAD_TOTAL_LEN) {
    const msgid = state.buf.readUInt16BE(0);
    const msglen = state.buf.readUInt16BE(HEAD_ID_LEN);
    if (msglen > 1024 * 64) { // 服务端 MAX_LENGTH=2K，放宽防御异常流
      if (onError) onError(new Error(`frame too large: ${msglen}`));
      state.buf = Buffer.alloc(0);
      return frames;
    }
    if (state.buf.length < HEAD_TOTAL_LEN + msglen) break; // 半包，等下一段
    const body = state.buf.slice(HEAD_TOTAL_LEN, HEAD_TOTAL_LEN + msglen);
    state.buf = state.buf.slice(HEAD_TOTAL_LEN + msglen);
    let obj = {};
    try { obj = JSON.parse(body.toString('utf8')); } catch (_) { obj = { raw: body.toString('utf8') }; }
    frames.push({ msgid, obj });
  }
  return frames;
}

module.exports = { HEAD_TOTAL_LEN, MSG_IDS, ERROR_CODES, encodeFrame, decodeFrames };
