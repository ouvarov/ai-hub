import { describe, it, expect } from "vitest";
import {
  identityHeaders,
  toActionUser,
  userFromHeaders,
} from "@shared/lib/caller-identity";

/**
 * The invariant under test: an action's ctx.user is either the full
 * OAuth-derived identity or undefined — never a half-filled record, and never
 * anything sourced from the action's own input. These helpers are the whole
 * chain: proxy encodes identity into headers → agent-runner decodes them →
 * run-action narrows them into ActionContext.
 */

describe("identityHeaders (skill-runner proxy)", () => {
  it("carries the full identity when the caller is signed in", () => {
    const h = identityHeaders({
      email: "person@example.com",
      name: "Person",
      groups: ["ai-hub-users"],
    });
    expect(h["X-User-Email"]).toBe("person@example.com");
    expect(h["X-User-Name"]).toBe("Person");
    expect(JSON.parse(h["X-User-Groups"])).toEqual(["ai-hub-users"]);
    expect(h["Content-Type"]).toBe("application/json");
  });

  it("sends NO identity headers when there is no signed-in caller", () => {
    const h = identityHeaders(undefined);
    expect(Object.keys(h)).toEqual(["Content-Type"]);
  });

  it("treats missing name and groups as defaults, not as absence of identity", () => {
    const h = identityHeaders({ email: "person@example.com" });
    expect(h["X-User-Email"]).toBe("person@example.com");
    expect(h["X-User-Name"]).toBe("Unknown");
    expect(JSON.parse(h["X-User-Groups"])).toEqual([]);
  });
});

describe("userFromHeaders (agent-runner /actions route)", () => {
  it("round-trips the identity the proxy encoded", () => {
    const headers = new Headers(
      identityHeaders({ email: "person@example.com", name: "Person", groups: ["g1", "g2"] }),
    );
    expect(userFromHeaders(headers)).toEqual({
      email: "person@example.com",
      name: "Person",
      groups: ["g1", "g2"],
    });
  });

  it("returns undefined when no email header is present — webhook path", () => {
    expect(userFromHeaders(new Headers({ "Content-Type": "application/json" }))).toBeUndefined();
  });

  it("degrades a malformed groups header to no groups, keeping the identity", () => {
    const headers = new Headers({
      "X-User-Email": "person@example.com",
      "X-User-Groups": "not-json{",
    });
    expect(userFromHeaders(headers)).toEqual({
      email: "person@example.com",
      name: "Unknown",
      groups: [],
    });
  });

  it("drops non-string entries from a valid-JSON groups header", () => {
    const headers = new Headers({
      "X-User-Email": "person@example.com",
      "X-User-Groups": JSON.stringify(["ok", 42, null, "also-ok"]),
    });
    expect(userFromHeaders(headers)?.groups).toEqual(["ok", "also-ok"]);
  });
});

describe("toActionUser (ActionContext narrowing)", () => {
  it("collapses to undefined without an email — no half-filled identities", () => {
    expect(toActionUser(undefined)).toBeUndefined();
    expect(toActionUser({ name: "Ghost", groups: ["g"] })).toBeUndefined();
    expect(toActionUser({ email: "" })).toBeUndefined();
  });

  it("fills defaults around the email anchor", () => {
    expect(toActionUser({ email: "person@example.com" })).toEqual({
      email: "person@example.com",
      name: "Unknown",
      groups: [],
    });
  });
});
