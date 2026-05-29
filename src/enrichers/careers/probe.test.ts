import { test, expect } from "bun:test";
import { HttpError, HttpRetryExhaustedError } from "../../http/index.ts";
import { CAREERS_PATHS, probeCareersPaths } from "./probe.ts";
import { makeFakeHttpClient } from "./test-support.ts";

test("probeCareersPaths returns the first 200 response and stops probing", async () => {
  const { client, calls } = makeFakeHttpClient({
    "https://acme.ai/careers": { status: 404 },
    "https://acme.ai/careers/": "<html>Hello careers</html>",
    // /jobs should not be probed once /careers/ wins.
    "https://acme.ai/jobs": "should not be called",
  });

  const result = await probeCareersPaths(client, "acme.ai");

  expect(result.kind).toBe("found");
  if (result.kind === "found") {
    expect(result.url).toBe("https://acme.ai/careers/");
    expect(result.body).toContain("careers");
  }
  expect(calls).toEqual([
    "https://acme.ai/careers",
    "https://acme.ai/careers/",
  ]);
});

test("probeCareersPaths probes paths in the documented order", () => {
  // Pin the order so a reorder is a loud failure (CLAUDE.local.md W-1).
  expect(CAREERS_PATHS).toEqual([
    "/careers",
    "/careers/",
    "/jobs",
    "/jobs/",
    "/work-with-us",
    "/about/careers",
    "/jobs.html",
  ]);
});

test("probeCareersPaths returns not_found when every direct path is 404", async () => {
  const responses: Record<string, { status: number }> = {};
  for (const path of CAREERS_PATHS) {
    responses[`https://acme.ai${path}`] = { status: 404 };
  }
  // No sitemap fallback for this test — let the probe report not_found.
  responses["https://acme.ai/sitemap.xml"] = { status: 404 };

  const { client, calls } = makeFakeHttpClient(responses);
  const result = await probeCareersPaths(client, "acme.ai");

  expect(result.kind).toBe("not_found");
  // All seven paths + sitemap fallback were probed.
  expect(calls).toHaveLength(CAREERS_PATHS.length + 1);
});

test("probeCareersPaths falls back to sitemap when direct paths are all 404", async () => {
  const responses: Record<string, { status: number } | string> = {};
  for (const path of CAREERS_PATHS) {
    responses[`https://acme.ai${path}`] = { status: 404 };
  }
  responses["https://acme.ai/sitemap.xml"] = [
    '<?xml version="1.0"?>',
    "<urlset>",
    "<url><loc>https://acme.ai/grnh/backend</loc></url>",
    "<url><loc>https://acme.ai/grnh/careers</loc></url>",
    "</urlset>",
  ].join("");
  responses["https://acme.ai/grnh/careers"] = "<html>Open roles!</html>";

  const { client, calls } = makeFakeHttpClient(responses);
  const result = await probeCareersPaths(client, "acme.ai");

  expect(result.kind).toBe("found");
  if (result.kind === "found") {
    expect(result.url).toBe("https://acme.ai/grnh/careers");
    expect(result.body).toContain("Open roles");
  }
  // Direct paths + sitemap + first careers-ish URL in the sitemap.
  expect(calls.at(-1)).toBe("https://acme.ai/grnh/careers");
});

test("probeCareersPaths surfaces HttpRetryExhaustedError as a failed result", async () => {
  // Map the first probe to a retry-exhausted error; the probe must not throw.
  // It records the failure and reports `error` so the orchestrator can write a
  // sources row with fetch_status=failed.
  const err = new HttpRetryExhaustedError(
    "https://acme.ai/careers",
    4,
    503,
    "service unavailable",
  );
  const responses: Record<string, { status: number } | string | Error> = {
    "https://acme.ai/careers": err,
  };
  for (const path of CAREERS_PATHS.slice(1)) {
    responses[`https://acme.ai${path}`] = { status: 404 };
  }
  responses["https://acme.ai/sitemap.xml"] = { status: 404 };

  const { client } = makeFakeHttpClient(responses);
  const result = await probeCareersPaths(client, "acme.ai");

  // First probe failed loudly; remaining 404s + sitemap all came back. With
  // no 200 anywhere, the result records the failure for sources.
  expect(result.kind).toBe("error");
  if (result.kind === "error") {
    expect(result.url).toBe("https://acme.ai/careers");
    expect(result.error).toBe(err);
  }
});

test("probeCareersPaths treats a non-retryable HttpError (e.g. 410) as 'not present, keep going'", async () => {
  // A 410 Gone on /careers is the same signal as 404: this URL isn't where the
  // careers page lives. The probe should keep trying the rest of the list.
  const responses: Record<string, { status: number } | string | Error> = {
    "https://acme.ai/careers": new HttpError("https://acme.ai/careers", 410, ""),
  };
  for (const path of CAREERS_PATHS.slice(1, -1)) {
    responses[`https://acme.ai${path}`] = { status: 404 };
  }
  responses[`https://acme.ai${CAREERS_PATHS.at(-1)!}`] = "<html>Found me!</html>";
  responses["https://acme.ai/sitemap.xml"] = { status: 404 };

  const { client } = makeFakeHttpClient(responses);
  const result = await probeCareersPaths(client, "acme.ai");

  expect(result.kind).toBe("found");
  if (result.kind === "found") {
    expect(result.url).toBe(`https://acme.ai${CAREERS_PATHS.at(-1)!}`);
  }
});

test("probeCareersPaths treats an empty 200 body as 'no useful page'", async () => {
  // Empty body would match every job title (substring of "") if we naively
  // accepted it. Probe must skip and keep searching.
  const responses: Record<string, { status: number; body?: string } | string> = {
    "https://acme.ai/careers": { status: 200, body: "   \n\n  " },
  };
  for (const path of CAREERS_PATHS.slice(1, -1)) {
    responses[`https://acme.ai${path}`] = { status: 404 };
  }
  responses[`https://acme.ai${CAREERS_PATHS.at(-1)!}`] = "<html>Real page</html>";
  responses["https://acme.ai/sitemap.xml"] = { status: 404 };

  const { client } = makeFakeHttpClient(responses);
  const result = await probeCareersPaths(client, "acme.ai");

  expect(result.kind).toBe("found");
  if (result.kind === "found") {
    expect(result.body).toContain("Real page");
  }
});
