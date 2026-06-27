export interface Env {
  DB: D1Database;
  GATEWAY_RATE_LIMITER: { limit(opts: { key: string }): Promise<{ success: boolean }> };
  GATEWAY_KEY: string;
  OPENROUTER_API_KEY: string;
  PERSPECTIVE_API_KEY?: string;
  DISCORD_WEBHOOK_URL?: string;
  FALLBACK_MODEL: string;
  OPENROUTER_BASE_URL: string;
  HTTP_REFERER: string;
  X_TITLE: string;
}

export interface Variables {
  feature: string;
  callerHash: string;
}

export type ServiceStatus = "healthy" | "degraded" | "down" | "unknown";

export interface Service {
  id: string;
  org: string;
  project: string;
  region: string;
  name: string;
  kind: string;
  environment: string;      // production | staging | sandbox | dev
  url: string | null;
  status: ServiceStatus;
  latency_ms: number | null;
  version: string | null;
  last_check: number | null;
  created_at: number;
  updated_at: number;
}

export interface Project {
  id: string;
  org: string;
  name: string;
  environment: string;      // production | staging | sandbox | dev
  type: string;             // service | tool | api | game | platform
  owner: string | null;
  repo: string | null;
  deploy_target: string | null;
  description: string | null;
  created_at: number;
  updated_at: number;
}

export interface ActivityRow {
  id: string;
  org: string;
  project: string | null;
  service_id: string | null;
  kind: string;
  message: string;
  detail: string | null;
  created_at: number;
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
