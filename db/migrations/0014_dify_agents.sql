-- Additive provider support. Existing configurations and snapshots remain Coze.
ALTER TABLE ai_agent_configs ADD COLUMN provider text NOT NULL DEFAULT 'coze'
  CHECK (provider IN ('coze', 'dify'));
ALTER TABLE ai_agent_configs ALTER COLUMN coze_bot_id DROP NOT NULL;
ALTER TABLE ai_agent_configs ADD CONSTRAINT ai_agent_provider_bot_check
  CHECK (provider <> 'coze' OR NULLIF(btrim(coze_bot_id), '') IS NOT NULL);
-- Keep the existing Coze uniqueness constraint. NULL Bot IDs allow independent
-- Dify apps; their app-scoped API keys use the existing encrypted secret fields.
ALTER TABLE experiment_sessions ADD COLUMN dify_conversation_id text;
