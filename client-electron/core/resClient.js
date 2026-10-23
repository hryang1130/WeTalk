// ResourceServer 客户端（数据面）：文件/图片分片上传下载。
// 协议同 4 字节头(大端 msgid+msglen)+JSON；分片明文 ≤32KB（server/ResourceServer/const.h MAX_FILE_LEN），
// JSON 里 data 字段为 base64。
// 上传: 1037(ID_IMG_CHAT_UPLOAD_REQ, 图片) / 1003(一般文件)，逐片 last=1 结束
// 下载: 1033 {seq,name,uid,token,client_path} 从 seq=1 循环，RSP {data,seq,last?...} 直到服务端置 last
//       （1033 首片服务端校验 Redis token，必须传登录时的 uid/token）
const net = require('net');
const { md5 } = require('./md5');

const CHUNK = 32 * 1024;

// ResourceServer 的包头与 ChatServer 不同：msgid(2B 大端) + msglen(4B 大端)，共 6 字节
// （server/ResourceServer/const.h: HEAD_TOTAL_LEN=6, HEAD_DATA_LEN=4, network_to_host_long）
function resEncode(msgid, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  const head = Buffer.alloc(6);
  head.writeUInt16BE(msgid, 0);
  head.writeUInt32BE(body.length, 2);
  return Buffer.concat([head, body]);
}
function resDecode(state, chunk) {
  state.buf = state.buf.length ? Buffer.concat([state.buf, chunk]) : chunk;
  const frames = [];
  for (;;) {
    if (state.buf.length < 6) break;
    const msgid = state.buf.readUInt16BE(0);
    const len = state.buf.readUInt32BE(2);
    if (state.buf.length < 6 + len) break;
    const body = state.buf.slice(6, 6 + len);
    state.buf = state.buf.slice(6 + len);
    let obj = null;
    try { obj = JSON.parse(body.toString('utf8')); } catch (_) { obj = {}; }
    frames.push({ msgid, obj });
  }
  return frames;
}

class ResClient {
  constructor(onLog = () => {}) {
    this.sock = null;
    this.rx = { buf: Buffer.alloc(0) };
    this.pending = [];   // 等待响应的请求 {msgid, resolve}
    this.onLog = onLog;
  }

  connect(host, port) {
    return new Promise((resolve, reject) => {
      this.close();
      this.sock = net.createConnection({ host, port });
      let settled = false;
      this.sock.on('connect', () => { settled = true; resolve(true); });
      this.sock.on('data', (chunk) => this._onData(chunk));
      this.sock.on('error', (err) => {
        this.onLog('[res] error: ' + err.message);
        if (!settled) { settled = true; reject(err); }
        else this._failAll(err.message);
      });
      this.sock.on('close', () => this._failAll('connection closed'));
      this.sock.setTimeout(8000, () => { if (!settled) { this.sock.destroy(); reject(new Error('connect timeout')); } });
    });
  }

  close() { if (this.sock) { try { this.sock.destroy(); } catch (_) {} this.sock = null; } this._failAll('closed'); }

  _failAll(msg) {
    for (const p of this.pending) p.reject(new Error(msg));
    this.pending = [];
  }

  _onData(chunk) {
    const frames = resDecode(this.rx, chunk);
    for (const f of frames) {
      const idx = this.pending.findIndex((p) => p.msgid === f.msgid);
      if (idx >= 0) this.pending.splice(idx, 1)[0].resolve(f.obj);
      else this.onLog('[res] unhandled frame msgid=' + f.msgid);
    }
  }

  _request(msgid, obj, rspMsgid = null, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      if (!this.sock) return reject(new Error('resource not connected'));
      // 注意：ResourceServer 的响应 msgid = 请求 msgid + 1（1037→1038、1033→1034、1003→1004）
      const p = { msgid: rspMsgid || msgid, resolve, reject };
      this.pending.push(p);
      this.sock.write(resEncode(msgid, obj));
      setTimeout(() => {
        const i = this.pending.indexOf(p);
        if (i >= 0) { this.pending.splice(i, 1); reject(new Error('request timeout msgid=' + msgid)); }
      }, timeoutMs);
    });
  }

  /** 分片上传，返回最终回执。msgid 用 1037(图片)或 1003(文件)。name 为服务端存储名 */
  async upload(uid, msgid, name, buffer) {
    const total = buffer.length;
    const totalSeq = Math.max(1, Math.ceil(total / CHUNK));
    let lastRsp = null;
    for (let seq = 1; seq <= totalSeq; seq++) {
      const slice = buffer.slice((seq - 1) * CHUNK, seq * CHUNK);
      const rsp = await this._request(msgid, {
        md5: this._md5Of(name, buffer), seq,
        name, total_size: total, trans_size: slice.length,
        last: seq === totalSeq ? 1 : 0,
        data: slice.toString('base64'), uid,
      }, msgid + 1);
      if (rsp.error !== 0) throw new Error('upload failed at seq ' + seq + ': ' + rsp.error);
      lastRsp = rsp;
    }
    return lastRsp;
  }

  /** 循环下载所有分片，返回 {buffer, name} */
  async download(uid, token, name) {
    const chunks = [];
    let seq = 1;
    for (;;) {
      const rsp = await this._request(1033, {
        seq, name, uid, token, client_path: '',
      }, 1034);
      if (rsp.error !== 0) throw new Error('download failed at seq ' + seq + ': ' + rsp.error);
      chunks.push(Buffer.from(rsp.data, 'base64'));
      const done = rsp.last === 1 || rsp.last === true;
      const received = chunks.reduce((n, c) => n + c.length, 0);
      if (done || (rsp.total_size && Number(rsp.total_size) <= received)) break;
      seq++;
    }
    return { buffer: Buffer.concat(chunks), name };
  }

  // 服务端 Redis 里 md5 key 由客户端上传时自带；这里对内容算真实 md5（与 Qt 版一致）
  _md5Of(name, buffer) {
    const { md5 } = require('./md5');
    return md5(buffer);
  }
}

module.exports = { ResClient, CHUNK };
