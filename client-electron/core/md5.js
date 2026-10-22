// 纯 JS MD5（RFC 1321）。服务端 ResourceServer 用文件内容的 md5 作为 Redis 索引/断点续传 key，
// Web Crypto 不提供 MD5，故自带实现。输出 32 位小写十六进制，与 C++/Qt 版一致。
function md5(/** Uint8Array|Buffer */ bytes) {
  const S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
  const K = new Int32Array(64);
  for (let i = 0; i < 64; i++) K[i] = (Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296)) | 0;

  const len = bytes.length;
  const withPad = (((len + 8) >> 6) + 1) << 6; // 补到 64 的倍数且至少留 8 字节长度域
  const m = new Uint8Array(withPad);
  m.set(bytes);
  m[len] = 0x80;
  const bitLen = len * 8;
  for (let i = 0; i < 8; i++) m[withPad - 8 + i] = (bitLen >>> (8 * i)) & 0xff;

  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  const rotl = (x, c) => (x << c) | (x >>> (32 - c));

  for (let off = 0; off < withPad; off += 64) {
    const M = new Int32Array(16);
    for (let i = 0; i < 16; i++) {
      M[i] = (m[off + 4 * i]) | (m[off + 4 * i + 1] << 8) | (m[off + 4 * i + 2] << 16) | (m[off + 4 * i + 3] << 24);
    }
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F, g;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
      else { F = C ^ (B | ~D); g = (7 * i) % 16; }
      F = (F + A + K[i] + M[g]) | 0;
      A = D; D = C; C = B;
      B = (B + rotl(F, S[i])) | 0;
    }
    a0 = (a0 + A) | 0; b0 = (b0 + B) | 0; c0 = (c0 + C) | 0; d0 = (d0 + D) | 0;
  }
  const out = new Uint8Array(16);
  [a0, b0, c0, d0].forEach((v, i) => {
    out[4 * i] = v & 0xff; out[4 * i + 1] = (v >>> 8) & 0xff;
    out[4 * i + 2] = (v >>> 16) & 0xff; out[4 * i + 3] = (v >>> 24) & 0xff;
  });
  return Buffer.from(out).toString('hex');
}
module.exports = { md5 };
