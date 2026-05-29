import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// End-to-end CLI integration: spawn the bin with a private DB path, run
// `collect` to seed, then `purge` in both dry-run and --yes modes. We assert
// on exit codes and output substrings rather than exact lines so the format
// can evolve without ripping these tests apart.

const CLI = join(import.meta.dir, "index.ts");

function makeTempDb(): { dbPath: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "startup-leads-test-"));
  const dbPath = join(dir, "test.db");
  return {
    dbPath,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

async function runCli(
  args: string[],
  env: Record<string, string>,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", CLI, ...args], {
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { exitCode, stdout, stderr };
}

test("purge with no mode exits 1 and prints usage on stderr", async () => {
  const { dbPath, cleanup } = makeTempDb();
  try {
    const r = await runCli(["purge"], { STARTUP_LEADS_DB: dbPath });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("--older-than");
    expect(r.stderr).toContain("--risk");
    expect(r.stderr).toContain("--company");
  } finally {
    cleanup();
  }
});

test("collect → purge --company dry-run → purge --company --yes", async () => {
  const { dbPath, cleanup } = makeTempDb();
  try {
    const collect = await runCli(["collect", "--limit", "5", "--source", "fake"], {
      STARTUP_LEADS_DB: dbPath,
    });
    expect(collect.exitCode).toBe(0);

    const dry = await runCli(["purge", "--company", "acme.ai"], {
      STARTUP_LEADS_DB: dbPath,
    });
    expect(dry.exitCode).toBe(0);
    expect(dry.stdout).toContain("Purge preview");
    expect(dry.stdout).toContain("companies");
    // Acme is one of the three fake leads.
    expect(dry.stdout).toMatch(/companies\s*:\s*1/);

    const yes = await runCli(["purge", "--company", "acme.ai", "--yes"], {
      STARTUP_LEADS_DB: dbPath,
    });
    expect(yes.exitCode).toBe(0);
    expect(yes.stdout).toContain("Purged:");
    expect(yes.stdout).toMatch(/companies\s*:\s*1/);

    // Second --yes is idempotent: nothing left to delete.
    const yes2 = await runCli(["purge", "--company", "acme.ai", "--yes"], {
      STARTUP_LEADS_DB: dbPath,
    });
    expect(yes2.exitCode).toBe(0);
    expect(yes2.stdout).toMatch(/companies\s*:\s*0/);
  } finally {
    cleanup();
  }
});

test("purge --company on an unknown domain is a no-op with exit 0", async () => {
  const { dbPath, cleanup } = makeTempDb();
  try {
    const r = await runCli(
      ["purge", "--company", "definitely-not-real.example", "--yes"],
      { STARTUP_LEADS_DB: dbPath },
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/companies\s*:\s*0/);
  } finally {
    cleanup();
  }
});

test("purge --older-than with bad input exits 1", async () => {
  const { dbPath, cleanup } = makeTempDb();
  try {
    const r = await runCli(["purge", "--older-than", "abc"], {
      STARTUP_LEADS_DB: dbPath,
    });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("--older-than");
  } finally {
    cleanup();
  }
});

test("purge --risk dry-run with no matching contacts shows zeros", async () => {
  const { dbPath, cleanup } = makeTempDb();
  try {
    await runCli(["collect", "--limit", "5", "--source", "fake"], {
      STARTUP_LEADS_DB: dbPath,
    });
    const r = await runCli(["purge", "--risk", "blocked"], {
      STARTUP_LEADS_DB: dbPath,
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Purge preview");
    expect(r.stdout).toMatch(/contacts\s*:\s*0/);
  } finally {
    cleanup();
  }
});
