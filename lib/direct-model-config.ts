export interface DirectModelConfig {
  model: string;
  systemPrompt: string;
  temperature: number;
  maxTokens: number;
  thinking: boolean;
}

export const DEFAULT_DIRECT_MODEL: DirectModelConfig = {
  model: "deepseek-flash",
  systemPrompt: "你是一位耐心、严谨的学习助手。请使用中文，结合学生的问题提供清晰、准确的帮助。",
  temperature: 0.7,
  maxTokens: 4096,
  thinking: false,
};
