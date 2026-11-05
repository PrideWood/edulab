CREATE TABLE shared_model_settings (
  id text PRIMARY KEY CHECK (id = 'deepseek'),
  base_url text NOT NULL,
  model_config jsonb NOT NULL,
  token_ciphertext text NOT NULL,
  token_iv text NOT NULL,
  token_tag text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES admin_users(id)
);
-- Reuse the most recently configured DeepSeek credential without exposing it.
-- Existing styles and session snapshots retain their original configuration.
INSERT INTO shared_model_settings (id, base_url, model_config, token_ciphertext, token_iv, token_tag, updated_by)
SELECT 'deepseek', coze_api_base_url, direct_model - 'systemPrompt',
  coze_token_ciphertext, coze_token_iv, coze_token_tag, updated_by
FROM ai_agent_configs WHERE provider='deepseek' AND coze_token_ciphertext IS NOT NULL
ORDER BY updated_at DESC, id LIMIT 1;
