import type { Context, Next } from "hono";
import type { Env, Variables } from "./types.js";

type Ctx = { Bindings: Env; Variables: Variables };

export async function verifyAuth(c: Context<Ctx>, next: Next): Promise<Response | void> {
  const header = c.req.header("Authorization");
  if (!header?.startsWith("Bearer ")) return c.json({ error: "unauthorized" }, 401);

  const token = header.slice(7);
  if (!c.env.GATEWAY_KEY) return c.json({ error: "unauthorized" }, 401);

  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(token)),
    crypto.subtle.digest("SHA-256", enc.encode(c.env.GATEWAY_KEY)),
  ]);

  if (!crypto.subtle.timingSafeEqual(a, b)) return c.json({ error: "unauthorized" }, 401);

  c.set("callerHash", Array.from(new Uint8Array(a)).map(b => b.toString(16).padStart(2, "0")).join(""));
  return next();
}
