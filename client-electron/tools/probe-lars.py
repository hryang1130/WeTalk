# 临时探针：按 Lars 私有协议向 agent UDP 发 GetHostRequest(1,1)，打印原始响应。
# 用法: python3 probe.py [port] [host]
import socket, struct, sys

port = int(sys.argv[1]) if len(sys.argv) > 1 else 8890
host = sys.argv[2] if len(sys.argv) > 2 else '127.0.0.1'

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

# GetHostRequest { seq=1, modid=1, cmdid=1 }
body = b'\x08' + varint(1) + b'\x10' + varint(1) + b'\x18' + varint(1)
head = struct.pack('<ii', 4, len(body))  # msgid=4 (ID_GetHostRequest), msglen

s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
s.settimeout(3)
s.sendto(head + body, (host, port))
try:
    data, _ = s.recvfrom(4096)
except socket.timeout:
    print('TIMEOUT: no response from agent on', host, port)
    sys.exit(1)

mid, mlen = struct.unpack('<ii', data[:8])
print('resp head: msgid=%d msglen=%d total=%d' % (mid, mlen, len(data)))
pb = data[8:8 + mlen]
print('body hex:', pb.hex())

# naive protobuf parse
i = 0
fields = {}
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
        fields[f] = ('varint', v)
        print('field %d varint %d' % (f, v))
    elif wt == 2:
        l = pb[i]; i += 1
        sub = pb[i:i + l]; i += l
        fields[f] = ('msg', sub)
        print('field %d msg %s' % (f, sub.hex()))
        # try HostInfo: ip f1, port f2
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
                print('  host field %d = %d' % (f2, v2))
            else:
                print('  host wt', w2); break
        if 1 in hv:
            ip = hv[1] & 0xFFFFFFFF
            print('  host ip=%d.%d.%d.%d port=%s' % (
                ip & 0xFF, (ip >> 8) & 0xFF, (ip >> 16) & 0xFF, (ip >> 24) & 0xFF, hv.get(2)))
    else:
        print('unexpected wire type', wt)
        break
