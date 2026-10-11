import "server-only";

import { randomUUID } from "node:crypto";
import { experiment as defaultExperiment, type ExperimentConfig } from "@/config/experiment";
import { query, transaction } from "@/db";
import { decryptSecret, encryptSecret } from "@/lib/secret-crypto";

export interface ExperimentLimits {
  maxUserMessages: number | null;
  maxMessageChars: number;
  sessionDurationMinutes: number | null;
}

export interface HistoryMemorySettings { enabled: boolean; maxInputTokens: number }
export const DEFAULT_HISTORY_MEMORY: HistoryMemorySettings = { enabled:true,maxInputTokens:6000 };

export interface ExperimentSettings {
  version: number;
  experiment: ExperimentConfig;
  limits: ExperimentLimits;
  storage: { databaseMessagesEnabled: boolean };
  ai: { baseUrl: string; botId: string; hasToken: boolean };
  memory?: HistoryMemorySettings;
}

export interface ExperimentSessionSnapshot {
  version: number;
  experiment: ExperimentConfig;
  limits: ExperimentLimits;
  storage: { databaseMessagesEnabled: boolean };
  ai: { provider?: "coze" | "dify"; baseUrl: string; botId: string; agentId?: string; runId?: string; internalName?: string };
  memory?: HistoryMemorySettings;
}

interface SettingsRow {
  experiment_id: string;
  version: number;
  task_visible: boolean;
  chat_enabled: boolean;
  task_label: string;
  task_title: string;
  task_introduction: string;
  task_requirements: string[];
  task_material: string;
  task_hint: string;
  assistant_name: string;
  welcome_message: string;
  max_user_messages: number | null;
  max_message_chars: number;
  session_duration_minutes: number | null;
  database_message_storage_enabled: boolean;
  coze_api_base_url: string;
  coze_bot_id: string | null;
  coze_token_ciphertext: string | null;
  coze_token_iv: string | null;
  coze_token_tag: string | null;
  history_memory_enabled?: boolean;
  history_memory_max_input_tokens?: number;
}

function fallbackSettings(experimentId = defaultExperiment.id): ExperimentSettings {
  return {
    version: 1,
    experiment: { ...defaultExperiment, id: experimentId, requirements: [...defaultExperiment.requirements] },
    limits: { maxUserMessages: null, maxMessageChars: 2000, sessionDurationMinutes: null },
    storage: { databaseMessagesEnabled: true },
    memory: { ...DEFAULT_HISTORY_MEMORY },
    ai: {
      baseUrl: process.env.COZE_API_BASE_URL ?? "https://api.coze.com",
      botId: process.env.COZE_BOT_ID ?? "",
      hasToken: Boolean(process.env.COZE_API_TOKEN),
    },
  };
}

function mapRow(row: SettingsRow): ExperimentSettings {
  return {
    version: row.version,
    experiment: {
      id: row.experiment_id, label: row.task_label, title: row.task_title,
      introduction: row.task_introduction, requirements: row.task_requirements,
      material: row.task_material, hint: row.task_hint,
      assistantName: row.assistant_name, welcome: row.welcome_message,
      taskVisible: row.task_visible, chatEnabled: row.chat_enabled,
    },
    limits: {
      maxUserMessages: row.max_user_messages,
      maxMessageChars: row.max_message_chars,
      sessionDurationMinutes: row.session_duration_minutes,
    },
    storage: { databaseMessagesEnabled: row.database_message_storage_enabled },
    memory: { enabled:row.history_memory_enabled ?? true,maxInputTokens:row.history_memory_max_input_tokens ?? 6000 },
    ai: {
      baseUrl: row.coze_api_base_url,
      botId: row.coze_bot_id ?? "",
      hasToken: Boolean(row.coze_token_ciphertext || process.env.COZE_API_TOKEN),
    },
  };
}

const SETTINGS_SELECT = `SELECT experiment_id, version, task_visible, chat_enabled, task_label, task_title,
  task_introduction, task_requirements, task_material, task_hint, assistant_name, welcome_message,
  max_user_messages, max_message_chars, session_duration_minutes, database_message_storage_enabled,
  coze_api_base_url, coze_bot_id,
  coze_token_ciphertext, coze_token_iv, coze_token_tag, history_memory_enabled, history_memory_max_input_tokens
  FROM experiment_settings WHERE experiment_id = $1`;

export async function getExperimentSettings(experimentId = defaultExperiment.id, fallback = true) {
  try {
    const result = await query<SettingsRow>(SETTINGS_SELECT, [experimentId]);
    if (result.rows[0]) return mapRow(result.rows[0]);
    if (experimentId !== defaultExperiment.id) throw new Error("EXPERIMENT_SETTINGS_NOT_FOUND");
    return fallbackSettings(experimentId);
  } catch (error) {
    if (!fallback || experimentId !== defaultExperiment.id) throw error;
    return fallbackSettings(experimentId);
  }
}

export function buildSessionSnapshot(settings: ExperimentSettings): ExperimentSessionSnapshot {
  return {
    version: settings.version,
    experiment: { ...settings.experiment, requirements: [...settings.experiment.requirements] },
    limits: { ...settings.limits },
    storage: { ...settings.storage },
    memory: { ...(settings.memory ?? DEFAULT_HISTORY_MEMORY) },
    ai: { baseUrl: settings.ai.baseUrl, botId: settings.ai.botId },
  };
}

export async function getRuntimeAiConfig(experimentId: string, snapshot: ExperimentSessionSnapshot | null) {
  if (snapshot?.ai.agentId) {
    const agents = await query<{ provider?: "coze" | "dify"; coze_token_ciphertext: string | null; coze_token_iv: string | null; coze_token_tag: string | null }>(
      `SELECT provider, coze_token_ciphertext, coze_token_iv, coze_token_tag FROM ai_agent_configs WHERE id=$1 AND experiment_id=$2`,
      [snapshot.ai.agentId, experimentId]);
    const agent = agents.rows[0];
    if (!agent) throw new Error("ASSIGNED_AGENT_NOT_FOUND");
    const provider = snapshot.ai.provider ?? "coze";
    if (provider !== (agent.provider ?? "coze")) throw new Error("ASSIGNED_PROVIDER_MISMATCH");
    const token = agent.coze_token_ciphertext && agent.coze_token_iv && agent.coze_token_tag
      ? decryptSecret({ ciphertext: agent.coze_token_ciphertext, iv: agent.coze_token_iv, tag: agent.coze_token_tag })
      : provider === "coze" ? process.env.COZE_API_TOKEN ?? "" : "";
    return { provider, token, botId: snapshot.ai.botId, baseUrl: snapshot.ai.baseUrl };
  }

  if (snapshot?.ai.provider === "dify") throw new Error("ASSIGNED_AGENT_NOT_FOUND");
  let row: SettingsRow | undefined;
  try { row = (await query<SettingsRow>(SETTINGS_SELECT, [experimentId])).rows[0]; } catch { /* Environment fallback below. */ }
  let token = process.env.COZE_API_TOKEN ?? "";
  if (row?.coze_token_ciphertext && row.coze_token_iv && row.coze_token_tag) {
    token = decryptSecret({ ciphertext: row.coze_token_ciphertext, iv: row.coze_token_iv, tag: row.coze_token_tag });
  }
  return {
    provider: "coze" as const,
    token,
    botId: snapshot?.ai.botId || row?.coze_bot_id || process.env.COZE_BOT_ID || "",
    baseUrl: snapshot?.ai.baseUrl || row?.coze_api_base_url || process.env.COZE_API_BASE_URL || "https://api.coze.com",
  };
}

export interface SaveExperimentSettingsInput {
  experiment: ExperimentConfig;
  limits: ExperimentLimits;
  storage: { databaseMessagesEnabled: boolean };
  ai: { baseUrl: string; botId: string; token?: string };
  memory?: HistoryMemorySettings;
}

export async function saveExperimentSettings(input: SaveExperimentSettingsInput, adminUserId: string) {
  return transaction(async (client) => {
    const current = await client.query<SettingsRow>(`${SETTINGS_SELECT} FOR UPDATE`, [input.experiment.id]);
    const before = current.rows[0] ? mapRow(current.rows[0]) : null;
    const encrypted = input.ai.token?.trim() ? encryptSecret(input.ai.token.trim()) : null;
    const version = (current.rows[0]?.version ?? 0) + 1;
    const memory = input.memory ?? before?.memory ?? DEFAULT_HISTORY_MEMORY;
    const values = [
      input.experiment.id, version, input.experiment.taskVisible, input.experiment.chatEnabled,
      input.experiment.label, input.experiment.title, input.experiment.introduction,
      JSON.stringify(input.experiment.requirements), input.experiment.material, input.experiment.hint,
      input.experiment.assistantName, input.experiment.welcome,
      input.limits.maxUserMessages, input.limits.maxMessageChars, input.limits.sessionDurationMinutes,
      input.storage.databaseMessagesEnabled, input.ai.baseUrl, input.ai.botId || null,
      encrypted?.ciphertext ?? current.rows[0]?.coze_token_ciphertext ?? null,
      encrypted?.iv ?? current.rows[0]?.coze_token_iv ?? null,
      encrypted?.tag ?? current.rows[0]?.coze_token_tag ?? null,
      adminUserId,
      memory.enabled,memory.maxInputTokens,
    ];
    await client.query(
      `INSERT INTO experiment_settings (experiment_id, version, task_visible, chat_enabled, task_label,
        task_title, task_introduction, task_requirements, task_material, task_hint, assistant_name,
        welcome_message, max_user_messages, max_message_chars, session_duration_minutes,
        database_message_storage_enabled, coze_api_base_url, coze_bot_id, coze_token_ciphertext,
        coze_token_iv, coze_token_tag, updated_by, history_memory_enabled, history_memory_max_input_tokens)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)
       ON CONFLICT (experiment_id) DO UPDATE SET version = EXCLUDED.version,
        task_visible = EXCLUDED.task_visible, chat_enabled = EXCLUDED.chat_enabled,
        task_label = EXCLUDED.task_label, task_title = EXCLUDED.task_title,
        task_introduction = EXCLUDED.task_introduction, task_requirements = EXCLUDED.task_requirements,
        task_material = EXCLUDED.task_material, task_hint = EXCLUDED.task_hint,
        assistant_name = EXCLUDED.assistant_name, welcome_message = EXCLUDED.welcome_message,
        max_user_messages = EXCLUDED.max_user_messages, max_message_chars = EXCLUDED.max_message_chars,
        session_duration_minutes = EXCLUDED.session_duration_minutes,
        database_message_storage_enabled = EXCLUDED.database_message_storage_enabled,
        history_memory_enabled = EXCLUDED.history_memory_enabled,
        history_memory_max_input_tokens = EXCLUDED.history_memory_max_input_tokens,
        coze_api_base_url = EXCLUDED.coze_api_base_url, coze_bot_id = EXCLUDED.coze_bot_id,
        coze_token_ciphertext = EXCLUDED.coze_token_ciphertext, coze_token_iv = EXCLUDED.coze_token_iv,
        coze_token_tag = EXCLUDED.coze_token_tag, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      values,
    );
    const after = await client.query<SettingsRow>(SETTINGS_SELECT, [input.experiment.id]);
    const saved = mapRow(after.rows[0]);
    await client.query(
      `INSERT INTO admin_audit_log (id, admin_user_id, action, experiment_id, before_data, after_data)
       VALUES ($1, $2, 'experiment.settings.update', $3, $4::jsonb, $5::jsonb)`,
      [randomUUID(), adminUserId, input.experiment.id, JSON.stringify(before), JSON.stringify(saved)],
    );
    return saved;
  });
}
