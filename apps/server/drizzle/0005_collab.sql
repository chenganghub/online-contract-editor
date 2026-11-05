CREATE TABLE `comment` (
	`id` varchar(36) NOT NULL,
	`document_id` varchar(36) NOT NULL,
	`parent_id` varchar(36),
	`quote` varchar(500),
	`occurrence` int,
	`body` varchar(2000) NOT NULL,
	`author_id` varchar(100) NOT NULL,
	`author_name` varchar(100) NOT NULL,
	`resolved` boolean NOT NULL DEFAULT false,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `comment_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `document_revision` (
	`id` varchar(36) NOT NULL,
	`document_id` varchar(36) NOT NULL,
	`version` int NOT NULL,
	`reason` varchar(50) NOT NULL,
	`doc_json` json NOT NULL,
	`values_json` json NOT NULL,
	`operator` varchar(100) NOT NULL,
	`operator_name` varchar(100),
	`at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `document_revision_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_revision` UNIQUE(`document_id`,`version`)
);
--> statement-breakpoint
ALTER TABLE `doc_token` ADD `user_name` varchar(100);--> statement-breakpoint
ALTER TABLE `document` ADD `field_versions` json;--> statement-breakpoint
ALTER TABLE `document` ADD `body_version` int DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `document` ADD `edit_lock_user` varchar(100);--> statement-breakpoint
ALTER TABLE `document` ADD `edit_lock_name` varchar(100);--> statement-breakpoint
ALTER TABLE `document` ADD `edit_lock_conn` varchar(36);--> statement-breakpoint
ALTER TABLE `document` ADD `edit_lock_expires` datetime(3);--> statement-breakpoint
CREATE INDEX `idx_comment_document` ON `comment` (`document_id`);