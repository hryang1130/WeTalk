# 临时探针：按 we_reactor 私有协议向 route-dns TCP 7778 发 GetRouteRequest(1,1)，打印原始响应。
# 用法: python3 probe-dns.py [host] [port]
import socket, struct, sys

host = sys.argv[1] if len(sys.argv) > 1 else '172.20.0.20'
port = int(sys.argv[2]) if len(sys.argv) > 2 else 7778

def varint(n):
    out = b''
    while True:
        b = n & 0x7F
        n >>= 7
        if n:
            out += bytes([b | 0x80])
        else:
            out += bytes([b])
            break
    return out

# GetRouteRequest { modid=1, cmdid=1 }
body = b'\x08' + varint(1) + b'\x10' + varint(1)
head = struct.pack('<ii', 1, len(body))  # msgid=1 (ID_GetRouteRequest), msglen

s = socket.create_connection((host, port), timeout=3)
s.settimeout(3)
s.sendall(head + body)
data = b''
try:
    while len(data) < 8:
        chunk = s.recv(8 - len(data))
        if not chunk:
            break
        data += chunk
    mid, mlen = struct.unpack('<ii', data[:8]) if len(data) == 8 else (None, None)
    pb = b''
    if mlen:
        while len(pb) < mlen:
            chunk = s.recv(mlen - len(pb))
            if not chunk:
                break
            pb += chunk
except socket.timeout:
    print('TIMEOUT waiting dns response')
    sys.exit(1)

if mid is None:
    print('no response head, got bytes:', data.hex())
    sys.exit(1)

print('resp head: msgid=%d msglen=%d' % (mid, mlen))
print('body hex:', pb.hex())
# naive protobuf parse: field1 modid, field2 cmdid, field3 repeated HostInfo{1:ip,2:port}
i = 0
while i < len(pb):
    key = pb[i]; i += 1
    f, wt = key >> 3, key & 7
    if wt == 0:
        v = 0; sh = 0
        while True:
            b = pb[i]; i += 1
            v |= (b & 0x7F) << sh; sh += 7
            if not b & 0x80:
                break
        print('field %d varint %d' % (f, v))
    elif wt == 2:
        l = pb[i]; i += 1
        sub = pb[i:i + l]; i += l
        j = 0; hv = {}
        while j < len(sub):
            k2 = sub[j]; j += 1
            f2, w2 = k2 >> 3, k2 & 7
            if w2 == 0:
                v2 = 0; sh2 = 0
                while True:
                    b2 = sub[j]; j += 1
                    v2 |= (b2 & 0x7F) << sh2; sh2 += 7
                    if not b2 & 0x80:
                        break
                hv[f2] = v2
        ip = hv.get(1, 0) & 0xFFFFFFFF
        print('host ip=%d.%d.%d.%d port=%s' % (
            ip & 0xFF, (ip >> 8) & 0xFF, (ip >> 16) & 0xFF, (ip >> 24) & 0xFF, hv.get(2)))
    else:
        print('unexpected wire type', wt)
        break
