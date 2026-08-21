ALTER TABLE experiment_settings
  ADD COLUMN IF NOT EXISTS database_message_storage_enabled boolean NOT NULL DEFAULT true;

ALTER TABLE chat_requests
  ALTER COLUMN user_message_id DROP NOT NULL;
