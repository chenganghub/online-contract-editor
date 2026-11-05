CREATE TABLE `sign_evidence` (
	`id` varchar(36) NOT NULL,
	`document_id` varchar(36) NOT NULL,
	`seq` int NOT NULL,
	`action` varchar(20) NOT NULL,
	`signer_key` varchar(32),
	`operator` varchar(100) NOT NULL,
	`operator_name` varchar(100) NOT NULL,
	`ip` varchar(64),
	`user_agent` varchar(300),
	`doc_hash` char(64) NOT NULL,
	`detail_json` json NOT NULL,
	`prev_hash` char(64) NOT NULL,
	`hash` char(64) NOT NULL,
	`at` datetime(3) NOT NULL,
	CONSTRAINT `sign_evidence_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_evidence` UNIQUE(`document_id`,`seq`)
);
--> statement-breakpoint
CREATE TABLE `sign_intent` (
	`id` varchar(36) NOT NULL,
	`document_id` varchar(36) NOT NULL,
	`signer_key` varchar(32) NOT NULL,
	`method` enum('sms','face','password','cert','other') NOT NULL,
	`proof` varchar(200) NOT NULL,
	`expires_at` datetime(3) NOT NULL,
	`used_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `sign_intent_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `signed_file` (
	`id` varchar(36) NOT NULL,
	`document_id` varchar(36) NOT NULL,
	`version` int NOT NULL,
	`sha256` char(64) NOT NULL,
	`size` bigint NOT NULL,
	`page_count` int NOT NULL,
	`cert_subject` varchar(300) NOT NULL,
	`cert_serial` varchar(100) NOT NULL,
	`test_cert` boolean NOT NULL,
	`at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `signed_file_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_signed_file` UNIQUE(`document_id`,`version`)
);
--> statement-breakpoint
CREATE TABLE `signer` (
	`id` varchar(36) NOT NULL,
	`document_id` varchar(36) NOT NULL,
	`signer_key` varchar(32) NOT NULL,
	`name` varchar(100) NOT NULL,
	`kind` enum('person','org') NOT NULL DEFAULT 'person',
	`user_id` varchar(100) NOT NULL,
	`order_no` int NOT NULL,
	`intent_required` boolean NOT NULL DEFAULT true,
	`status` enum('waiting','signed','rejected') NOT NULL DEFAULT 'waiting',
	`intent_method` varchar(20),
	`intent_proof` varchar(200),
	`signed_at` datetime(3),
	`reject_reason` varchar(500),
	CONSTRAINT `signer_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_signer` UNIQUE(`document_id`,`signer_key`)
);
--> statement-breakpoint
ALTER TABLE `doc_token` ADD `signer_key` varchar(32);--> statement-breakpoint
ALTER TABLE `document` ADD `sign_deadline` datetime(3);--> statement-breakpoint
ALTER TABLE `seal_record` ADD `signer_key` varchar(32);--> statement-breakpoint
CREATE INDEX `idx_signed_file_sha` ON `signed_file` (`sha256`);