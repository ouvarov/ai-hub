import { describe, it, expect } from "vitest";
import { hasAccess } from "@shared/lib/access";

/**
 * The invariant under test: `hasAccess` is the whole access rule, on every call
 * path. It already answers "yes" for a tool that declares no groups, so a call
 * path never needs to ask "is this one restricted?" first — it just calls this.
 *
 * Why this is worth a test: the proxy path used to wrap this in a second,
 * name-based condition (`PROXY_ENFORCE_ACCESS_FOR`), which meant an action could
 * declare `allowedGroups` and still be listed and executed by anyone. Verified
 * live on 2026-08-18: an external account whose only group was `Gamma AI Hub`
 * called `web_health_check` (declares `allowedGroups: ["test-ai-hub-1"]`) and
 * reached input validation, i.e. no access check ran. The fix was to delete the
 * extra condition so all four call sites read identically.
 */

describe("hasAccess", () => {
  it("admits everyone when a tool declares no groups", () => {
    expect(hasAccess(undefined, [])).toBe(true);
    expect(hasAccess([], [])).toBe(true);
    expect(hasAccess(undefined, ["Gamma AI Hub"])).toBe(true);
  });

  it("admits a member of any one declared group", () => {
    expect(hasAccess(["Alpha AI Hub"], ["Alpha AI Hub"])).toBe(true);
    expect(
      hasAccess(["Alpha AI Hub", "Beta AI Hub"], ["Beta AI Hub"]),
    ).toBe(true);
  });

  it("refuses a signed-in caller who is in none of the declared groups", () => {
    expect(hasAccess(["Alpha AI Hub"], ["Gamma AI Hub"])).toBe(false);
    expect(hasAccess(["Beta AI Hub"], ["Gamma AI Hub"])).toBe(false);
    expect(hasAccess(["test-ai-hub-1"], ["Gamma AI Hub"])).toBe(false);
  });

  it("refuses a caller with no groups at all", () => {
    expect(hasAccess(["Alpha AI Hub"], [])).toBe(false);
  });

  it("matches group names exactly — no trimming, no case folding", () => {
    // A real group in Authentik is literally "TA Sourcing  AI Hub" (two spaces).
    // Callers get their group names from the Authentik token verbatim, so the
    // comparison must stay exact or that group silently stops matching.
    expect(hasAccess(["TA Sourcing  AI Hub"], ["TA Sourcing  AI Hub"])).toBe(true);
    expect(hasAccess(["TA Sourcing  AI Hub"], ["TA Sourcing AI Hub"])).toBe(false);
    expect(hasAccess(["Alpha AI Hub"], ["alpha ai hub"])).toBe(false);
    expect(hasAccess(["Alpha AI Hub"], [" Alpha AI Hub "])).toBe(false);
  });
});
