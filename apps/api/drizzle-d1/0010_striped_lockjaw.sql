ALTER TABLE `users` ADD `billing_revision` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
CREATE TRIGGER users_billing_revision AFTER UPDATE ON users
WHEN NEW.billing_revision = OLD.billing_revision
BEGIN
  UPDATE users SET billing_revision=OLD.billing_revision+1 WHERE id=NEW.id;
END;
