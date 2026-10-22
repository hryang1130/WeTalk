#!/bin/sh
# 等 mysql 就绪后写入 ChatServer 路由（serverip 需要客户端可达的对外 IP）
set -e
until mysqladmin ping -h mysql -uroot -p"123456" --silent; do
  echo "waiting for mysql..."; sleep 2
done
mysql -h mysql -uroot -p"123456" lars_dns <<SQL
INSERT IGNORE INTO RouteData (modid, cmdid, serverip, serverport) VALUES
  (1, 1, INET_ATON('${CHAT_ADV_IP1}'), 8090),
  (1, 1, INET_ATON('${CHAT_ADV_IP2}'), 8091);
UPDATE RouteVersion SET version = version + 1 WHERE id = 1;
INSERT INTO RouteChange (modid, cmdid, version)
  SELECT 1, 1, version FROM RouteVersion WHERE id = 1;
SELECT modid, cmdid, serverip, serverport FROM RouteData;
SQL
echo "seed done"
