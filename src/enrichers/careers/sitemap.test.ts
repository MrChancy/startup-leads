import { test, expect } from "bun:test";
import { parseSitemap } from "./sitemap.ts";
import { loadFixture } from "./test-support.ts";

test("parseSitemap returns only careers-ish URLs from a sitemap fixture", () => {
  const xml = loadFixture("sitemap.xml");
  const urls = parseSitemap(xml);

  // /, /about, /blog are filtered out. /careers, /jobs/*, /work-with-us/*
  // survive.
  expect(urls).toEqual([
    "https://example.com/careers",
    "https://example.com/careers/backend-engineer",
    "https://example.com/jobs/software-engineer",
    "https://example.com/work-with-us/designer",
  ]);
});

test("parseSitemap handles malformed XML by returning whatever it can extract", () => {
  // No XML parser ceremony: we only read <loc>...</loc>. A truncated
  // doc is just "fewer urls", never a throw.
  const xml =
    "<urlset><url><loc>https://x.com/careers</loc></url><url><loc>https://x.co";
  expect(parseSitemap(xml)).toEqual(["https://x.com/careers"]);
});

test("parseSitemap ignores non-careers paths even if loc is present", () => {
  const xml = `<urlset>
    <url><loc>https://x.com/pricing</loc></url>
    <url><loc>https://x.com/team</loc></url>
  </urlset>`;
  expect(parseSitemap(xml)).toEqual([]);
});

test("parseSitemap matches the standard careers path families case-insensitively", () => {
  const xml = `<urlset>
    <url><loc>https://x.com/Careers</loc></url>
    <url><loc>https://x.com/JOBS/data-eng</loc></url>
    <url><loc>https://x.com/work-with-us</loc></url>
    <url><loc>https://x.com/about/careers</loc></url>
  </urlset>`;
  expect(parseSitemap(xml)).toEqual([
    "https://x.com/Careers",
    "https://x.com/JOBS/data-eng",
    "https://x.com/work-with-us",
    "https://x.com/about/careers",
  ]);
});
