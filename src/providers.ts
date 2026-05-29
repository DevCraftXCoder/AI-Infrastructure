import type { Env, ChatRequest } from "./types.js";

export interface ProviderResult { response: Response; wasFallback: boolean }

class HttpError extends Error {
  constructor(public status: number, msg: string) { super(msg); }
}

async function withRetry<T>(op: () => Promise<T>, tries = 3): Promise<T> {
  for (let i = 0; i <= tries; i++) {
    try { return await op(); } catch (e) {
      if (e instanceof HttpError && e.status < 500) throw e;
      if (i === tries) throw e;
      await new Promise(r => setTimeout(r, 1000 * Math.pow(2, i) + Math.random() * 500));
    }
  }
  throw new Error("unreachable");
}

async function fetch1(env: Env, body: string): Promise<Response> {
  const r = await fetch(env.OPENROUTER_BASE_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.OPENROUTER_API_KEY}`, "HTTP-Referer": env.HTTP_REFERER, "X-Title": env.X_TITLE, "Content-Type": "application/json" },
    body,
  });
  if (r.status >= 400 && r.status < 500) throw new HttpError(r.status, await r.text().catch(() => ""));
  if (r.status >= 500) throw new Error(await r.text().catch(() => ""));
  return r;
}

async function dispatch(req: ChatRequest, env: Env, fallback: boolean): Promise<ProviderResult> {
  const body = JSON.stringify(req);
  const upstream = await withRetry(() => fetch1(env, body));
  const headers: Record<string, string> = { "x-gateway-fallback": fallback ? "true" : "false" };

  if (req.stream) {
    return { response: new Response(upstream.body, { status: upstream.status, headers: { ...headers, "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } }), wasFallback: fallback };
  }
  return { response: new Response(await upstream.text(), { status: 200, headers: { ...headers, "Content-Type": "application/json" } }), wasFallback: fallback };
}

export async function callProvider(req: ChatRequest, env: Env): Promise<ProviderResult> {
  try {
    return await dispatch(req, env, false);
  } catch (e) {
    if (e instanceof HttpError && e.status < 500) throw e;
    return await dispatch({ ...req, model: env.FALLBACK_MODEL }, env, true);
  }
}
