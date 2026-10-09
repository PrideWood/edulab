import "server-only";

import { randomUUID } from "node:crypto";
import { query, transaction } from "@/db";
import { experiment } from "@/config/experiment";
import { ApiError } from "@/lib/http";

export async function listExperiments() {
  await query("INSERT INTO experiments (id,name) VALUES ($1,$2) ON CONFLICT DO NOTHING", [experiment.id, experiment.title]);
  const result = await query<{ id: string; name: string }>("SELECT id,name FROM experiments ORDER BY created_at,id");
  return result.rows;
}

export async function createExperiment(name: string, sourceId: string, adminId: string) {
  return transaction(async (client) => {
    const source = await client.query("SELECT id FROM experiments WHERE id=$1 FOR SHARE", [sourceId]);
    if (!source.rows[0]) throw new ApiError(404, "EXPERIMENT_NOT_FOUND", "复制来源实验不存在。");
    const id = `study-${randomUUID()}`;
    await client.query("INSERT INTO experiments (id,name,created_by) VALUES ($1,$2,$3)", [id,name,adminId]);
    // Copy configuration and encrypted credentials server-side; later edits
    // belong to the new experiment and cannot alter the source experiment.
    const copied = await client.query(`INSERT INTO experiment_settings (
      experiment_id,version,task_visible,chat_enabled,task_label,task_title,task_introduction,
      task_requirements,task_material,task_hint,assistant_name,welcome_message,max_user_messages,
      max_message_chars,session_duration_minutes,database_message_storage_enabled,coze_api_base_url,
      coze_bot_id,coze_token_ciphertext,coze_token_iv,coze_token_tag,updated_by)
      SELECT $1,1,task_visible,chat_enabled,task_label,task_title,task_introduction,
      task_requirements,task_material,task_hint,assistant_name,welcome_message,max_user_messages,
      max_message_chars,session_duration_minutes,database_message_storage_enabled,coze_api_base_url,
      coze_bot_id,coze_token_ciphertext,coze_token_iv,coze_token_tag,$3
      FROM experiment_settings WHERE experiment_id=$2`, [id,sourceId,adminId]);
    if (!copied.rowCount) throw new ApiError(409, "EXPERIMENT_SETTINGS_MISSING", "来源实验尚未保存配置，请先保存后重试。");
    const agents = await client.query<{ id: string }>("SELECT id FROM ai_agent_configs WHERE experiment_id=$1", [sourceId]);
    for (const agent of agents.rows) await client.query(`INSERT INTO ai_agent_configs (id,experiment_id,internal_name,
      coze_api_base_url,coze_bot_id,coze_token_ciphertext,coze_token_iv,coze_token_tag,enabled,updated_by)
      SELECT $1,$2,internal_name,coze_api_base_url,coze_bot_id,coze_token_ciphertext,coze_token_iv,coze_token_tag,enabled,$3
      FROM ai_agent_configs WHERE id=$4`, [randomUUID(),id,adminId,agent.id]);
    await client.query(`INSERT INTO admin_audit_log (id,admin_user_id,action,experiment_id,after_data)
      VALUES ($1,$2,'experiment.create',$3,$4::jsonb)`, [randomUUID(),adminId,id,JSON.stringify({ name,sourceId })]);
    return { id,name };
  });
}
