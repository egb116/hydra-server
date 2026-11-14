PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_ai_calls` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
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
INSERT INTO `__new_ai_calls`("id", "ts", "feature", "model", "customer_id", "client_key", "input_tokens", "output_tokens", "cost_usd", "latency_ms", "status", "error") SELECT "id", "ts", "feature", "model", "customer_id", "client_key", "input_tokens", "output_tokens", "cost_usd", "latency_ms", "status", "error" FROM `ai_calls`;--> statement-breakpoint
DROP TABLE `ai_calls`;--> statement-breakpoint
ALTER TABLE `__new_ai_calls` RENAME TO `ai_calls`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `ai_calls_ts_idx` ON `ai_calls` (`ts`);--> statement-breakpoint
CREATE INDEX `ai_calls_feature_ts_idx` ON `ai_calls` (`feature`,`ts`);--> statement-breakpoint
CREATE TABLE `__new_reddit_accounts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
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
INSERT INTO `__new_reddit_accounts`("id", "customer_id", "username", "session_enc", "token_enc", "token_expires_at", "status", "next_check_at", "lease_until", "consecutive_failures", "session_failures", "last_success_at", "last_error", "last_error_at", "baseline_at", "proxy_key", "user_agent", "created_at", "updated_at") SELECT "id", "customer_id", "username", "session_enc", "token_enc", "token_expires_at", "status", "next_check_at", "lease_until", "consecutive_failures", "session_failures", "last_success_at", "last_error", "last_error_at", "baseline_at", "proxy_key", "user_agent", "created_at", "updated_at" FROM `reddit_accounts`;--> statement-breakpoint
DROP TABLE `reddit_accounts`;--> statement-breakpoint
ALTER TABLE `__new_reddit_accounts` RENAME TO `reddit_accounts`;--> statement-breakpoint
CREATE INDEX `reddit_accounts_next_check_at_idx` ON `reddit_accounts` (`next_check_at`);--> statement-breakpoint
CREATE INDEX `reddit_accounts_last_error_at_idx` ON `reddit_accounts` (`last_error_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `reddit_accounts_customer_username_unique` ON `reddit_accounts` (`customer_id`,`username`);