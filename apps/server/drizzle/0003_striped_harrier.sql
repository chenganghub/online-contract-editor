CREATE TABLE `field_library` (
	`client_id` varchar(36) NOT NULL,
	`version` int NOT NULL,
	`fields_json` json NOT NULL,
	CONSTRAINT `field_library_client_id` PRIMARY KEY(`client_id`)
);
