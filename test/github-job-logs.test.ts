import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchRedirectedLogText } from "@shared/lib/github";

const PATH = "/repos/acme/ai-hub/actions/jobs/107998832697/logs";
const BLOB = "https://blob.example.net/actions-results/x/job.log?sv=2024&sig=abc";

type Call = { url: string; init: RequestInit };

function stubFetch(responses: Response[]): Call[] {
  const calls: Call[] = [];
  let i = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      const res = responses[i++];
      if (!res) throw new Error(`unexpected fetch #${i} to ${url}`);
      return res;
    }),
  );
  return calls;
}

function headersOf(init: RequestInit): Record<string, string> {
  return (init.headers ?? {}) as Record<string, string>;
}

function hasAuth(init: RequestInit): boolean {
  return Object.keys(headersOf(init)).some((k) => k.toLowerCase() === "authorization");
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchRedirectedLogText", () => {
  it("sends the GitHub token only on the first hop and strips it on the redirect", async () => {
    const calls = stubFetch([
      new Response(null, { status: 302, headers: { Location: BLOB } }),
      new Response("line1\nline2\nerror TS2322", { status: 206 }),
    ]);

    const text = await fetchRedirectedLogText("ghs_secret", PATH, { Range: "bytes=-131072" });

    expect(text).toContain("error TS2322");
    expect(calls).toHaveLength(2);

    expect(calls[0].url).toBe(`https://api.github.com${PATH}`);
    expect(calls[0].init.redirect).toBe("manual");
    expect(hasAuth(calls[0].init)).toBe(true);

    expect(calls[1].url).toBe(BLOB);
    expect(hasAuth(calls[1].init)).toBe(false);
    expect(headersOf(calls[1].init).Range).toBe("bytes=-131072");
  });

  it("retries without Range when the log host answers 416", async () => {
    const calls = stubFetch([
      new Response(null, { status: 302, headers: { Location: BLOB } }),
      new Response("", { status: 416 }),
      new Response("full log", { status: 200 }),
    ]);

    const text = await fetchRedirectedLogText("ghs_secret", PATH, { Range: "bytes=-131072" });

    expect(text).toBe("full log");
    expect(calls).toHaveLength(3);
    expect(headersOf(calls[2].init).Range).toBeUndefined();
    expect(hasAuth(calls[2].init)).toBe(false);
  });

  it("resolves a relative Location against the API URL", async () => {
    const calls = stubFetch([
      new Response(null, { status: 302, headers: { Location: "/blob/job.log?sig=1" } }),
      new Response("ok", { status: 200 }),
    ]);

    await fetchRedirectedLogText("ghs_secret", PATH);

    expect(calls[1].url).toBe("https://api.github.com/blob/job.log?sig=1");
    expect(hasAuth(calls[1].init)).toBe(false);
  });

  it("throws a clear error when the redirect has no Location", async () => {
    stubFetch([new Response(null, { status: 302 })]);

    await expect(fetchRedirectedLogText("ghs_secret", PATH)).rejects.toThrow(/without a Location header/);
  });

  it("returns an inline body when GitHub does not redirect", async () => {
    const calls = stubFetch([new Response("inline log", { status: 200 })]);

    await expect(fetchRedirectedLogText("ghs_secret", PATH)).resolves.toBe("inline log");
    expect(calls).toHaveLength(1);
  });

  it("surfaces a storage error with its status and never leaks the token", async () => {
    stubFetch([
      new Response(null, { status: 302, headers: { Location: BLOB } }),
      new Response("<Error><Code>AuthenticationFailed</Code></Error>", { status: 403 }),
    ]);

    const err = await fetchRedirectedLogText("ghs_secret", PATH).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/Log download .* failed \(403\)/);
    expect((err as Error).message).not.toContain("ghs_secret");
  });

  it("surfaces a non-redirect API error with its status", async () => {
    stubFetch([new Response('{"message":"Not Found"}', { status: 404 })]);

    await expect(fetchRedirectedLogText("ghs_secret", PATH)).rejects.toThrow(/failed \(404\)/);
  });
});
