-- Fix: chat tables must live in the `wetalk` schema (ChatServer connects Schema=wetalk).
-- The old 03-chat-message.sql wrongly created a separate `chat_message` database.
USE wetalk;
CREATE TABLE IF NOT EXISTS `chat_thread` (
  `thread_id` bigint UNSIGNED NOT NULL AUTO_INCREMENT,
  `type` varchar(16) NOT NULL DEFAULT 'private',
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`thread_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `private_chat` (
  `thread_id` bigint UNSIGNED NOT NULL,
  `user1_id` bigint UNSIGNED NOT NULL,
  `user2_id` bigint UNSIGNED NOT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`thread_id`),
  UNIQUE KEY `uk_pair` (`user1_id`,`user2_id`),
  KEY `idx_user2` (`user2_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `chat_message` (
  `message_id` bigint UNSIGNED NOT NULL AUTO_INCREMENT,
  `thread_id` bigint UNSIGNED NOT NULL,
  `sender_id` bigint UNSIGNED NOT NULL,
  `recv_id` bigint UNSIGNED NOT NULL,
  `content` text CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `status` tinyint NOT NULL DEFAULT 0 COMMENT '0=unread 1=read 2=retracted',
  PRIMARY KEY (`message_id`),
  KEY `idx_thread_created` (`thread_id`,`created_at`),
  KEY `idx_thread_message` (`thread_id`,`message_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
