CREATE UNIQUE INDEX `resource_pool_slots_owner_attempt_unique`
	ON `resource_pool_slots` (`owner_attempt_id`)
	WHERE `owner_attempt_id` IS NOT NULL;
