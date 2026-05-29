export interface Env {
  DB: D1Database;
  GATEWAY_RATE_LIMITER: { limit(opts: { key: string }): Promise<{ success: boolean }> };
  GATEWAY_KEY: string;
  OPENROUTER_API_KEY: string;
  PERSPECTIVE_API_KEY?: string;
  FALLBACK_MODEL: string;
  OPENROUTER_BASE_URL: string;
  HTTP_REFERER: string;
  X_TITLE: string;
}

export interface Variables {
  feature: string;
  callerHash: string;
}

export interface ContentPart {
  type: string;
  text: string;
  cache_control?: { type: string };
}

export interface ChatMessage {
  role: string;
  content: string | ContentPart[];
}

export interface ChatUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  [key: string]: unknown;
}

export interface ChatResponse {
  choices: Array<{ message: ChatMessage }>;
  usage?: ChatUsage;
}
