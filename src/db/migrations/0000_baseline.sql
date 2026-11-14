CREATE TABLE `ai_calls` (
	`id` integer PRIMARY KEY NOT NULL,
	`ts` integer NOT NULL,
	`feature` text NOT NULL,
	`model` text NOT NULL,
	`customer_id` text,
	`client_key` text,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`cost_usd` real DEFAULT 0 NOT NULL,
	`latency_ms` integer NOT NULL,
	`status` text NOT NULL,
	`error` text
);
--> statement-breakpoint
CREATE INDEX `ai_calls_ts_idx` ON `ai_calls` (`ts`);--> statement-breakpoint
CREATE INDEX `ai_calls_feature_ts_idx` ON `ai_calls` (`feature`,`ts`);--> statement-breakpoint
CREATE TABLE `ai_usage_monthly` (
	`customer_id` text NOT NULL,
	`month` text NOT NULL,
	`request_count` integer DEFAULT 0 NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`cost_usd` real DEFAULT 0 NOT NULL,
	PRIMARY KEY(`customer_id`, `month`)
);
--> statement-breakpoint
CREATE TABLE `customers` (
	`id` integer PRIMARY KEY NOT NULL,
	`customer_id` text NOT NULL,
	`is_pro` integer DEFAULT false NOT NULL,
	`pro_expires_at` integer,
	`entitlement_source` text,
	`entitlement_checked_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `customers_customer_id_unique` ON `customers` (`customer_id`);--> statement-breakpoint
CREATE TABLE `device_accounts` (
	`device_id` integer NOT NULL,
	`account_id` integer NOT NULL,
	PRIMARY KEY(`device_id`, `account_id`),
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`account_id`) REFERENCES `reddit_accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `device_accounts_account_id_idx` ON `device_accounts` (`account_id`);--> statement-breakpoint
CREATE TABLE `devices` (
	`id` integer PRIMARY KEY NOT NULL,
	`push_token` text NOT NULL,
	`customer_id` integer NOT NULL,
	`last_registered_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `devices_push_token_unique` ON `devices` (`push_token`);--> statement-breakpoint
CREATE INDEX `devices_customer_id_idx` ON `devices` (`customer_id`);--> statement-breakpoint
CREATE TABLE `meta` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `notified_items` (
	`account_id` integer NOT NULL,
	`item_id` text NOT NULL,
	`notified_at` integer NOT NULL,
	PRIMARY KEY(`account_id`, `item_id`),
	FOREIGN KEY (`account_id`) REFERENCES `reddit_accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `notified_items_notified_at_idx` ON `notified_items` (`notified_at`);--> statement-breakpoint
CREATE TABLE `push_tickets` (
	`id` integer PRIMARY KEY NOT NULL,
	`ticket_id` text NOT NULL,
	`push_token` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `push_tickets_ticket_id_unique` ON `push_tickets` (`ticket_id`);--> statement-breakpoint
CREATE INDEX `push_tickets_created_at_idx` ON `push_tickets` (`created_at`);--> statement-breakpoint
CREATE TABLE `reddit_accounts` (
	`id` integer PRIMARY KEY NOT NULL,
	`customer_id` integer NOT NULL,
	`username` text NOT NULL,
	`session_enc` text NOT NULL,
	`token_enc` text,
	`token_expires_at` integer,
	`status` text DEFAULT 'active' NOT NULL,
	`next_check_at` integer NOT NULL,
	`lease_until` integer,
	`consecutive_failures` integer DEFAULT 0 NOT NULL,
	`session_failures` integer DEFAULT 0 NOT NULL,
	`last_success_at` integer,
	`last_error` text,
	`last_error_at` integer,
	`baseline_at` integer NOT NULL,
	`proxy_key` text,
	`user_agent` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `reddit_accounts_next_check_at_idx` ON `reddit_accounts` (`next_check_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `reddit_accounts_customer_username_unique` ON `reddit_accounts` (`customer_id`,`username`);