const BLOCKED = /\b(nigger|nigga|kike|chink|spic|wetback|gook|faggot|dyke|tranny|heil hitler|sieg heil|white power|gas the jews|child porn|jailbait)\b/i;

function normalize(t: string) {
  return t.replace(/[​-‍﻿­]/g, "").replace(/\s+/g, " ")
    .replace(/3/g,"e").replace(/0/g,"o").replace(/1/g,"i").replace(/@/g,"a")
    .replace(/\$/g,"s").replace(/4/g,"a").replace(/5/g,"s").replace(/7/g,"t")
    .toLowerCase();
}

export interface SafetyResult {
  allowed: boolean;
  reason?: string;
  flagged?: boolean;
  flagReason?: string;
}

export function checkSync(text: string): SafetyResult {
  return BLOCKED.test(normalize(text))
    ? { allowed: false, reason: "Content violates guidelines" }
    : { allowed: true };
}

export async function check(text: string, perspectiveKey?: string): Promise<SafetyResult> {
  const sync = checkSync(text);
  if (!sync.allowed || !perspectiveKey) return sync;

  try {
    const resp = await fetch(
      `https://commentanalyzer.googleapis.com/v1alpha1/comments:analyze?key=${perspectiveKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          comment: { text: text.slice(0, 10000) },
          languages: ["en"],
          requestedAttributes: { TOXICITY: {}, SEVERE_TOXICITY: {}, THREAT: {}, IDENTITY_ATTACK: {} },
        }),
        signal: AbortSignal.timeout(3000),
      }
    );
    if (!resp.ok) return { allowed: true };

    const data = (await resp.json()) as { attributeScores?: Record<string, { summaryScore?: { value?: number } }> };
    const s = data.attributeScores;
    if (!s) return { allowed: true };

    if ((s.SEVERE_TOXICITY?.summaryScore?.value ?? 0) > 0.5) return { allowed: true, flagged: true, flagReason: "Severe toxicity" };
    if ((s.THREAT?.summaryScore?.value ?? 0) > 0.7) return { allowed: true, flagged: true, flagReason: "Threat" };
    if ((s.IDENTITY_ATTACK?.summaryScore?.value ?? 0) > 0.7) return { allowed: true, flagged: true, flagReason: "Identity attack" };
    if ((s.TOXICITY?.summaryScore?.value ?? 0) > 0.7) return { allowed: true, flagged: true, flagReason: "Toxicity" };
  } catch { /* graceful fallback */ }

  return { allowed: true };
}
