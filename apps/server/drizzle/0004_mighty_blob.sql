CREATE TABLE `template_draft` (
	`template_id` varchar(36) NOT NULL,
	`client_id` varchar(36) NOT NULL,
	`doc_json` json NOT NULL,
	`fields_json` json NOT NULL,
	`version` int NOT NULL DEFAULT 1,
	CONSTRAINT `template_draft_template_id` PRIMARY KEY(`template_id`)
);
--> statement-breakpoint
CREATE TABLE `template_edit_token` (
	`id` varchar(36) NOT NULL,
	`template_id` varchar(36) NOT NULL,
	`user_id` varchar(100) NOT NULL,
	`expires_at` datetime(3) NOT NULL,
	`revoked_at` datetime(3),
	CONSTRAINT `template_edit_token_id` PRIMARY KEY(`id`)
);
