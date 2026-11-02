import type { ActionUser } from "@shared/types/action";

/**
 * Caller identity codec — the one place that encodes the OAuth-derived caller
 * into X-User-* headers and decodes them back.
 *
 * Why this lives in _shared: the encoding side runs in skill-runner (the action
 * proxy) and the decoding side in agent-runner (the /actions/:name route). Two
 * hand-rolled copies of the same header convention is exactly how the two ends
 * drift apart — and a drift here does not fail loudly, it silently strips the
 * caller from ctx.user, which downstream actions treat as "refuse to run".
 *
 * Trust model: these headers are only meaningful on internal hops. The Gateway
 * sets them after validating the OAuth token; the skill-runner proxy re-asserts
 * them from its own validated props over the service binding; the Gateway's
 * public webhook route rebuilds its forwarded request with Content-Type only,
 * so nothing an external caller sends survives into agent-runner. Never read
 * these headers off a request that arrived from the public internet.
 */

/** Loosely-typed user props as the runners hold them (all fields optional). */
export interface CallerProps {
  email?: string;
  name?: string;
  groups?: string[];
}

/**
 * Headers for a proxied action call, carrying the caller identity when there
 * is one. Without a signed-in caller only Content-Type is sent — absent
 * identity must look absent, not like an anonymous-but-present user.
 */
export function identityHeaders(userProps?: CallerProps): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (userProps?.email) {
    headers["X-User-Email"] = userProps.email;
    headers["X-User-Name"] = userProps.name ?? "Unknown";
    headers["X-User-Groups"] = JSON.stringify(userProps.groups ?? []);
  }
  return headers;
}

/**
 * Decode the caller from X-User-* headers on an internal request.
 * A malformed groups header degrades to "no groups" rather than failing the
 * request — the identity is still real, group membership is just unproven.
 */
export function userFromHeaders(headers: Headers): CallerProps | undefined {
  const email = headers.get("X-User-Email");
  if (!email) return undefined;
  let groups: string[] = [];
  try {
    const raw = headers.get("X-User-Groups");
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    if (Array.isArray(parsed)) groups = parsed.filter((g): g is string => typeof g === "string");
  } catch {
    /* malformed groups header → no groups */
  }
  return {
    email,
    name: headers.get("X-User-Name") ?? "Unknown",
    groups,
  };
}

/**
 * Narrow loose caller props into the ActionContext shape.
 * Email is the identity anchor: without it there is no caller, so the whole
 * object collapses to undefined rather than a half-filled record.
 */
export function toActionUser(userProps?: CallerProps): ActionUser | undefined {
  if (!userProps?.email) return undefined;
  return {
    email: userProps.email,
    name: userProps.name ?? "Unknown",
    groups: userProps.groups ?? [],
  };
}
