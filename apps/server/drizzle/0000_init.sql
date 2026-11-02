CREATE TABLE `api_client` (
	`id` varchar(36) NOT NULL,
	`name` varchar(100) NOT NULL,
	`key_hash` char(64) NOT NULL,
	`status` enum('active','disabled') NOT NULL DEFAULT 'active',
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `api_client_id` PRIMARY KEY(`id`),
	CONSTRAINT `api_client_key_hash_unique` UNIQUE(`key_hash`)
);
--> statement-breakpoint
CREATE TABLE `doc_token` (
	`id` varchar(36) NOT NULL,
	`document_id` varchar(36) NOT NULL,
	`mode` enum('edit','fill','seal','view') NOT NULL,
	`user_id` varchar(100) NOT NULL,
	`expires_at` datetime(3) NOT NULL,
	`revoked_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `doc_token_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `document` (
	`id` varchar(36) NOT NULL,
	`template_version_id` varchar(36) NOT NULL,
	`biz_key` varchar(100),
	`title` varchar(200) NOT NULL,
	`status` enum('filling','sealing','sealed','void') NOT NULL DEFAULT 'filling',
	`doc_json` json NOT NULL,
	`values_json` json NOT NULL,
	`fields_json` json NOT NULL,
	`page_count` int,
	`version` int NOT NULL DEFAULT 1,
	`locked_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `document_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `file_asset` (
	`id` varchar(36) NOT NULL,
	`kind` enum('docx','pdf','image','other') NOT NULL,
	`path` varchar(500) NOT NULL,
	`sha256` char(64) NOT NULL,
	`size` bigint NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `file_asset_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `operation_log` (
	`id` varchar(36) NOT NULL,
	`document_id` varchar(36) NOT NULL,
	`ops_json` json NOT NULL,
	`result_json` json NOT NULL,
	`operator` varchar(100) NOT NULL,
	`at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `operation_log_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `seal_record` (
	`id` varchar(36) NOT NULL,
	`document_id` varchar(36) NOT NULL,
	`seal_id` varchar(100) NOT NULL,
	`seal_name` varchar(100) NOT NULL,
	`image_hash` char(64) NOT NULL,
	`page_no` int NOT NULL,
	`x` int NOT NULL,
	`y` int NOT NULL,
	`width` int NOT NULL,
	`height` int NOT NULL,
	`operator` varchar(100) NOT NULL,
	`at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`status` enum('valid','void') NOT NULL DEFAULT 'valid',
	CONSTRAINT `seal_record_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `template` (
	`id` varchar(36) NOT NULL,
	`name` varchar(200) NOT NULL,
	`category` varchar(100),
	`status` enum('active','archived') NOT NULL DEFAULT 'active',
	`created_by` varchar(100) NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `template_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `template_version` (
	`id` varchar(36) NOT NULL,
	`template_id` varchar(36) NOT NULL,
	`version_no` int NOT NULL,
	`doc_json` json NOT NULL,
	`fields_json` json NOT NULL,
	`published_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `template_version_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_template_version` UNIQUE(`template_id`,`version_no`)
);
--> statement-breakpoint
CREATE TABLE `token_permission` (
	`token_id` varchar(36) NOT NULL,
	`field_key` varchar(100) NOT NULL,
	`permission` enum('editable','readonly','required','hidden') NOT NULL,
	CONSTRAINT `token_permission_token_id_field_key_pk` PRIMARY KEY(`token_id`,`field_key`)
);
--> statement-breakpoint
CREATE INDEX `idx_document_biz` ON `document` (`biz_key`);