CREATE TABLE `resource_reconciliation_proofs` (
	`id` text PRIMARY KEY NOT NULL,
	`attempt_id` text NOT NULL,
	`backend_id` text NOT NULL,
	`external_job_id` text NOT NULL,
	`proof_kind` text NOT NULL,
	`observed_at_ms` integer NOT NULL,
	`resource_pool_id` text NOT NULL,
	`resource_slot_no` integer NOT NULL,
	`resource_lease_token` text NOT NULL,
	`resource_fencing_token` integer NOT NULL,
	`disposition` text DEFAULT 'retained' NOT NULL,
	`reconciled_at_ms` integer,
	`created_at_ms` integer NOT NULL,
	FOREIGN KEY (`attempt_id`) REFERENCES `generation_attempts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`backend_id`) REFERENCES `execution_backends`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`resource_pool_id`) REFERENCES `resource_pools`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT `resource_reconciliation_proofs_kind_check` CHECK (`proof_kind` IN ('history-completed', 'history-cancelled', 'history-failed')),
	CONSTRAINT `resource_reconciliation_proofs_observed_check` CHECK (`observed_at_ms` > 0),
	CONSTRAINT `resource_reconciliation_proofs_slot_check` CHECK (`resource_slot_no` > 0),
	CONSTRAINT `resource_reconciliation_proofs_lease_check` CHECK (length(`resource_lease_token`) > 0),
	CONSTRAINT `resource_reconciliation_proofs_fence_check` CHECK (`resource_fencing_token` >= 0),
	CONSTRAINT `resource_reconciliation_proofs_disposition_check` CHECK (`disposition` IN ('retained', 'reconciled')),
	CONSTRAINT `resource_reconciliation_proofs_reconciled_check` CHECK (
		(`disposition` = 'retained' AND `reconciled_at_ms` IS NULL)
		OR (`disposition` = 'reconciled' AND `reconciled_at_ms` IS NOT NULL AND `reconciled_at_ms` >= `observed_at_ms`)
	),
	CONSTRAINT `resource_reconciliation_proofs_created_check` CHECK (`created_at_ms` > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `resource_reconciliation_proofs_lease_unique` ON `resource_reconciliation_proofs` (`attempt_id`,`resource_pool_id`,`resource_slot_no`,`resource_lease_token`,`resource_fencing_token`);
--> statement-breakpoint
CREATE UNIQUE INDEX `resource_reconciliation_proofs_external_unique` ON `resource_reconciliation_proofs` (`backend_id`,`external_job_id`);
--> statement-breakpoint
CREATE INDEX `resource_reconciliation_proofs_disposition_observed_idx` ON `resource_reconciliation_proofs` (`disposition`,`observed_at_ms`);
--> statement-breakpoint
CREATE INDEX `resource_reconciliation_proofs_attempt_idx` ON `resource_reconciliation_proofs` (`attempt_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `resource_pool_slots_owner_attempt_unique`
	ON `resource_pool_slots` (`owner_attempt_id`)
	WHERE `owner_attempt_id` IS NOT NULL;
