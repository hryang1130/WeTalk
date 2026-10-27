CREATE DATABASE IF NOT EXISTS wetalk_route;
USE wetalk_route;

CREATE TABLE IF NOT EXISTS RouteData (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  modid INT NOT NULL,
  cmdid INT NOT NULL,
  serverip INT UNSIGNED NOT NULL,
  serverport INT NOT NULL,
  KEY idx_mod_cmd (modid, cmdid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;

CREATE TABLE IF NOT EXISTS RouteVersion (
  id INT PRIMARY KEY,
  version BIGINT NOT NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS RouteChange (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  modid INT NOT NULL,
  cmdid INT NOT NULL,
  version BIGINT NOT NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS ServerCallStatus (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  modid INT NOT NULL,
  cmdid INT NOT NULL,
  ip INT UNSIGNED NOT NULL,
  port INT UNSIGNED NOT NULL,
  caller INT UNSIGNED NOT NULL DEFAULT 0,
  succ_cnt INT UNSIGNED NOT NULL DEFAULT 0,
  err_cnt INT UNSIGNED NOT NULL DEFAULT 0,
  ts INT UNSIGNED NOT NULL DEFAULT 0,
  overload TINYINT NOT NULL DEFAULT 0,
  UNIQUE KEY uk_status (modid, cmdid, ip, port, caller)
) ENGINE=InnoDB;

-- 默认路由必须在 init 阶段就位（WeReactor 后台加载逻辑曾因 SubscribeList 锁未初始化
-- 卡死、已修复，此处直接种好数据进一步保证 dns 首启必有路由），seed.sh 会在部署时
-- 按 .env 的 CHAT_ADV_IP 全量替换这里的默认值。
INSERT IGNORE INTO RouteData (modid, cmdid, serverip, serverport) VALUES
  (1, 1, INET_ATON('127.0.0.1'), 8090),
  (1, 1, INET_ATON('127.0.0.1'), 8091);

INSERT IGNORE INTO RouteVersion (id, version) VALUES (1, 1);
