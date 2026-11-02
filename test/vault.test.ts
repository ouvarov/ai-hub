import { describe, it, expect } from "vitest";
import { createVaultClient } from "@shared/lib/vault";

/** Mock Vault KV v2 fetch returning arbitrary JSON value types per key. */
function mockFetch(data: Record<string, unknown>) {
  return async () => ({
    ok: true,
    status: 200,
    text: async () => "",
    json: async () => ({ data: { data } }),
  });
}

describe("vault value normalisation", () => {
  it("normalises every value to a string", async () => {
    const vault = createVaultClient({
      token: "t",
      addr: "http://vault.local/",
      fetchFn: mockFetch({
        api_key: "sk-123",
        count: 5,
        flag: true,
        models: [{ id: "m" }],
        cfg: { a: 1 },
        empty: null,
      }),
    });
    const secrets = await vault.getSecrets("some-path");

    expect(Object.values(secrets).every((v) => typeof v === "string")).toBe(true);
    expect(secrets.api_key).toBe("sk-123"); // strings pass through untouched
    expect(secrets.count).toBe("5");
    expect(secrets.flag).toBe("true");
    expect(secrets.empty).toBe(""); // null/undefined coalesce to ""
  });

  it("serialises objects/arrays to JSON that round-trips through JSON.parse", async () => {
    const vault = createVaultClient({
      token: "t",
      addr: "http://vault.local/",
      fetchFn: mockFetch({ models: [{ id: "m", label: "M" }] }),
    });
    const secrets = await vault.getSecrets("p");
    expect(JSON.parse(secrets.models)).toEqual([{ id: "m", label: "M" }]);
  });

  it("keeps a stored JSON null from becoming the truthy string 'null'", async () => {
    const vault = createVaultClient({
      token: "t",
      addr: "http://vault.local/",
      fetchFn: mockFetch({ token: null }),
    });
    const secrets = await vault.getSecrets("p");
    // the `secret.key ?? ""` fallback in loadAIHubSecrets must still treat it as missing
    expect(secrets.token ?? "").toBe("");
  });
});
