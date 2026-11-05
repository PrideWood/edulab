-- Independent DeepSeek configurations reuse the encrypted credential store.
ALTER TABLE ai_agent_configs DROP CONSTRAINT ai_agent_configs_provider_check;
ALTER TABLE ai_agent_configs ADD CONSTRAINT ai_agent_configs_provider_check
  CHECK (provider IN ('coze', 'dify', 'deepseek'));
ALTER TABLE ai_agent_configs ADD COLUMN direct_model jsonb;
ALTER TABLE ai_agent_configs ADD CONSTRAINT ai_agent_direct_model_check
  CHECK (provider <> 'deepseek' OR (direct_model IS NOT NULL AND jsonb_typeof(direct_model) = 'object'));
