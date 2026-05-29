// Sitemap.xml parser, intentionally minimal.
//
// A full sitemap is a `<urlset>` of `<url><loc>...</loc>...</url>` entries.
// All we need is the list of `<loc>` URLs that look like careers/jobs pages
// — anything else is signal-less for an unknown-job freshness check.
//
// We use a regex instead of an XML library because:
//   1. sitemap.xml shape is rigid (loc is plain text, no CDATA in practice for
//      careers pages), and
//   2. a half-broken / truncated sitemap should yield partial results, not a
//      thrown error that aborts the whole company's probe.

// Path tokens we consider "careers-ish". Same family as probe.ts so that a URL
// in the sitemap and a manually probed URL would qualify by the same rule.
// "/about/careers" (TB-3b-era convention) is covered by the bare "careers"
// token thanks to the substring test.
const CAREERS_TOKENS = ["careers", "jobs", "work-with-us"] as const;

const LOC_RE = /<loc>\s*([^<\s]+)\s*<\/loc>/gi;

export function parseSitemap(xml: string): string[] {
  const out: string[] = [];
  for (const match of xml.matchAll(LOC_RE)) {
    const url = match[1]!;
    if (isCareersLike(url)) {
      out.push(url);
    }
  }
  return out;
}

function isCareersLike(url: string): boolean {
  const path = pathOf(url).toLowerCase();
  return CAREERS_TOKENS.some((token) => path.includes(`/${token}`));
}

// Extract just the path portion of a URL. We don't need a strict URL parser —
// if the input isn't well-formed we treat the whole thing as a path so the
// token test still has a shot.
function pathOf(url: string): string {
  const schemeIdx = url.indexOf("://");
  if (schemeIdx === -1) return url;
  const afterScheme = url.slice(schemeIdx + 3);
  const slash = afterScheme.indexOf("/");
  return slash === -1 ? "" : afterScheme.slice(slash);
}
