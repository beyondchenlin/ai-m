CREATE TABLE `trusted_proxy_nonces` (
  `issuer` text NOT NULL,
  `key_id` text NOT NULL,
  `nonce` text NOT NULL,
  `expires_at_ms` integer NOT NULL,
  `created_at_ms` integer NOT NULL,
  PRIMARY KEY (`issuer`, `key_id`, `nonce`),
  CHECK (length(`issuer`) BETWEEN 1 AND 120),
  CHECK (length(`key_id`) BETWEEN 1 AND 120),
  CHECK (length(`nonce`) BETWEEN 16 AND 128),
  CHECK (`expires_at_ms` > `created_at_ms`)
);
--> statement-breakpoint
CREATE INDEX `trusted_proxy_nonces_expiry_idx`
  ON `trusted_proxy_nonces` (`expires_at_ms`);
