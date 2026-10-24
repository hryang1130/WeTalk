#!/bin/bash
# route-dns / route-reporter 启动门槛：
# 等 mysql 的"真实"服务器能通过 TCP 完成查询后再 exec 业务二进制。
# 背景：mysql 官方镜像 init 阶段的临时实例 --skip-networking，TCP 不通；
# 且即便 socket 可用也可能尚未真正就绪。vendored dns 在该窗口内连库会
# 卡死后台加载线程（fresh-deploy 实测必现），故必须等稳定后再启动。
# 用法: wait-mysql.sh <db_name> -- <command...>
set -e
DB="$1"; shift; shift
until mysql -h mysql -uroot -p123456 -N -e "SELECT COUNT(*) FROM ${DB}.RouteData;" >/dev/null 2>&1; do
  echo "waiting for mysql route data (TCP)..."; sleep 1
done
exec "$@"
