import "server-only";

import { randomUUID } from "node:crypto";
import { query, transaction } from "@/db";
import { decryptSecret, encryptSecret } from "@/lib/secret-crypto";
import { DEFAULT_DIRECT_MODEL, type DirectModelConfig } from "@/lib/direct-model-config";
import { ApiError } from "@/lib/http";

export type SharedModelConfig = Omit<DirectModelConfig, "systemPrompt" | "useSharedConnection">;
export interface SharedModelSummary { baseUrl: string; config: SharedModelConfig; hasToken: boolean; updatedAt: string | null }
interface SharedRow {
  base_url: string; model_config: SharedModelConfig;
  token_ciphertext: string; token_iv: string; token_tag: string; updated_at: string;
}
function summary(row?: SharedRow): SharedModelSummary {
  const { model, temperature, maxTokens, thinking } = DEFAULT_DIRECT_MODEL;
  return { baseUrl: row?.base_url ?? "https://api.deepseek.com", config: row?.model_config ?? { model, temperature, maxTokens, thinking },
    hasToken: Boolean(row?.token_ciphertext), updatedAt: row?.updated_at ?? null };
}
export async function getSharedModelSummary() {
  return summary((await query<SharedRow>("SELECT * FROM shared_model_settings WHERE id='deepseek'")).rows[0]);
}
export async function getSharedModelConnection() {
  const row = (await query<SharedRow>("SELECT * FROM shared_model_settings WHERE id='deepseek'")).rows[0];
  if (!row) throw new ApiError(400, "SHARED_MODEL_REQUIRED", "请先展开共享模型设置，保存 DeepSeek API Key 和模型。");
  return { baseUrl: row.base_url, config: row.model_config,
    token: decryptSecret({ ciphertext: row.token_ciphertext, iv: row.token_iv, tag: row.token_tag }) };
}
export async function saveSharedModel(input: { baseUrl: string; config: SharedModelConfig; token?: string }, adminId: string) {
  return transaction(async client => {
    // Serialize first-time inserts and blank-key edits as well as rotations.
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('edulab:shared-deepseek',0))");
    const old = (await client.query<SharedRow>("SELECT * FROM shared_model_settings WHERE id='deepseek' FOR UPDATE")).rows[0];
    const secret = input.token?.trim() ? encryptSecret(input.token.trim()) : old ? {
      ciphertext: old.token_ciphertext, iv: old.token_iv, tag: old.token_tag,
    } : null;
    if (!secret) throw new ApiError(400, "SHARED_MODEL_REQUIRED", "首次配置请填写 DeepSeek API Key。");
    const row = (await client.query<SharedRow>(`INSERT INTO shared_model_settings
      (id,base_url,model_config,token_ciphertext,token_iv,token_tag,updated_by)
      VALUES ('deepseek',$1,$2::jsonb,$3,$4,$5,$6)
      ON CONFLICT (id) DO UPDATE SET base_url=EXCLUDED.base_url, model_config=EXCLUDED.model_config,
        token_ciphertext=EXCLUDED.token_ciphertext,token_iv=EXCLUDED.token_iv,token_tag=EXCLUDED.token_tag,
        updated_at=now(),updated_by=EXCLUDED.updated_by RETURNING *`,
      [input.baseUrl, JSON.stringify(input.config), secret.ciphertext, secret.iv, secret.tag, adminId])).rows[0];
    await client.query(`INSERT INTO admin_audit_log (id,admin_user_id,action,before_data,after_data)
      VALUES ($1,$2,'ai.shared_model.save',$3::jsonb,$4::jsonb)`, [randomUUID(), adminId, JSON.stringify(summary(old)), JSON.stringify(summary(row))]);
    return summary(row);
  });
}
