/**
 * Bridge auth.
 *
 * In the Renku deployment the gateway authenticates the user before any traffic reaches
 * the session pod, so the bridge does not run OAuth itself. As defense-in-depth we also
 * require a shared token (injected into the session via `env_variable_overrides` as
 * PI_BRIDGE_TOKEN and known to the client) so that a leaked session URL alone cannot
 * drive the agent.
 *
 * If PI_BRIDGE_TOKEN is unset (e.g. local dev), auth is disabled.
 */

import { timingSafeEqual } from "node:crypto";

const EXPECTED = process.env.PI_BRIDGE_TOKEN;

export function authDisabled(): boolean {
  return !EXPECTED;
}

export function tokenValid(provided: string | undefined): boolean {
  if (!EXPECTED) return true; // dev mode
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(EXPECTED);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Pull a token from `?token=` or the `Authorization: Bearer` header. */
export function tokenFromRequest(url: string, authHeader?: string): string | undefined {
  try {
    const q = new URL(url, "http://localhost").searchParams.get("token");
    if (q) return q;
  } catch {
    /* ignore */
  }
  if (authHeader?.startsWith("Bearer ")) return authHeader.slice("Bearer ".length);
  return undefined;
}
