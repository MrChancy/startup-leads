// RFC 4180 CSV encoder. Hand-rolled (per CLAUDE.md: no external libs).
//
// Per-field rule:
//   - null / undefined  → empty string (unquoted).
//   - Numbers (or anything non-string) get String()-ed.
//   - A field must be wrapped in double-quotes when its text contains
//     `,`, `"`, `\n`, `\r`, or starts/ends with whitespace. Otherwise emit
//     raw. Internal `"` characters double to `""` inside the quoted form.
//
// Line rule:
//   - Fields are joined with `,`.
//   - Each line (header and every data row) is terminated by CRLF (`\r\n`)
//     per RFC 4180. Many tools tolerate plain LF, but CRLF is the standard
//     and Excel imports it cleanly.

export type CsvFieldInput = string | number | null | undefined;

const NEEDS_QUOTE = /[",\r\n]/;

export function encodeField(value: CsvFieldInput): string {
  if (value === null || value === undefined) return "";
  const s = typeof value === "string" ? value : String(value);
  if (s === "") return "";
  const startsOrEndsWithWs = /^\s|\s$/.test(s);
  if (!NEEDS_QUOTE.test(s) && !startsOrEndsWithWs) return s;
  return `"${s.replace(/"/g, '""')}"`;
}

export function encodeRow(fields: readonly CsvFieldInput[]): string {
  return fields.map(encodeField).join(",") + "\r\n";
}

export function encodeCsv(
  header: readonly string[],
  rows: ReadonlyArray<readonly CsvFieldInput[]>,
): string {
  let out = encodeRow(header);
  for (const row of rows) out += encodeRow(row);
  return out;
}
