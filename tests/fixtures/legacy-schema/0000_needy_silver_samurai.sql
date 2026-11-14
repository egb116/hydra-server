CREATE TABLE `ai_requests` (
	`id` integer PRIMARY KEY NOT NULL,
	`customer_id` text NOT NULL,
	`month` text NOT NULL,
	`request_count` integer DEFAULT 0 NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`createdAt` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	`updatedAt` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `ai_requests_customer_id_idx` ON `ai_requests` (`customer_id`);--> statement-breakpoint
CREATE INDEX `ai_requests_month_idx` ON `ai_requests` (`month`);--> statement-breakpoint
CREATE UNIQUE INDEX `ai_requests_customer_month_idx` ON `ai_requests` (`customer_id`,`month`);--> statement-breakpoint
CREATE INDEX `ai_requests_created_at_idx` ON `ai_requests` (`createdAt`);--> statement-breakpoint
CREATE INDEX `ai_requests_updated_at_idx` ON `ai_requests` (`updatedAt`);--> statement-breakpoint
CREATE TABLE `customers` (
	`id` integer PRIMARY KEY NOT NULL,
	`customer_id` text NOT NULL,
	`is_subscribed` integer,
	`push_token` text,
	`createdAt` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	`updatedAt` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `customers_customer_id_unique` ON `customers` (`customer_id`);--> statement-breakpoint
CREATE INDEX `customer_customer_id_idx` ON `customers` (`customer_id`);--> statement-breakpoint
CREATE INDEX `customer_created_at_idx` ON `customers` (`createdAt`);--> statement-breakpoint
CREATE INDEX `customer_updated_at_idx` ON `customers` (`updatedAt`);--> statement-breakpoint
CREATE TABLE `reddit_accounts` (
	`id` integer PRIMARY KEY NOT NULL,
	`customer_id` text NOT NULL,
	`username` text NOT NULL,
	`session` text NOT NULL,
	`last_message_id` text,
	`last_checked_at` text,
	`createdAt` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	`updatedAt` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `reddit_account_customer_id_idx` ON `reddit_accounts` (`customer_id`);--> statement-breakpoint
CREATE INDEX `reddit_account_username_idx` ON `reddit_accounts` (`username`);--> statement-breakpoint
CREATE UNIQUE INDEX `reddit_account_customer_username_idx` ON `reddit_accounts` (`customer_id`,`username`);--> statement-breakpoint
CREATE INDEX `reddit_account_created_at_idx` ON `reddit_accounts` (`createdAt`);--> statement-breakpoint
CREATE INDEX `reddit_account_updated_at_idx` ON `reddit_accounts` (`updatedAt`);--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` integer PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`data` text,
	`error` text,
	`startedAt` text,
	`failedAt` text,
	`completedAt` text,
	`createdAt` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	`updatedAt` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `task_created_at_idx` ON `tasks` (`createdAt`);--> statement-breakpoint
CREATE INDEX `task_updated_at_idx` ON `tasks` (`updatedAt`);