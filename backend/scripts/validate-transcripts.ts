/**
 * Measures `transcript-parser` against a REAL transcript corpus.
 *
 * Why this exists (PRD R1): the session JSONL schema is internal and
 * undocumented, and it changes across Claude Code releases. Our unit tests use
 * synthetic fixtures, so they prove the parser is TOLERANT but never that it is
 * ACCURATE — a release that renames a field would keep every test green while
 * the dashboard quietly went blank, because unrecognised entries degrade to
 * `unknown` by design rather than failing loudly.
 *
 * This script closes that loop: point it at a real corpus and it reports what
 * fraction of lines we actually understand. Run it after upgrading Claude Code.
 *
 *   npm run validate:transcripts -- ~/.claude/projects
 *
 * Exits non-zero if the unknown rate exceeds the threshold, so it can gate a
 * release. It prints ONLY aggregate counts and structural signatures — never
 * transcript content, which is real conversation data.
 */

import fs from "node:fs";
import path from "node:path";
import { parseEntry } from "../src/transcript-parser.js";

const DEFAULT_MAX_UNKNOWN_PCT = 5;

function findTranscripts(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable dir is not fatal to a survey
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".jsonl")) out.push(p);
    }
  };
  walk(root);
  return out;
}

/**
 * A content-free description of an entry we failed to classify: entry type plus
 * the set of content-block types. Enough to diagnose a schema change, with no
 * conversation text.
 */
function shapeOf(line: string): string {
  try {
    const o = JSON.parse(line) as {
      type?: unknown;
      message?: { content?: unknown };
    };
    const content = o.message?.content;
    const blocks = Array.isArray(content)
      ? [...new Set(content.map((b) => (b as { type?: string })?.type))].join("+")
      : typeof content;
    return `type=${String(o.type)} content=${blocks}`;
  } catch {
    return "unparseable-json";
  }
}

function main(): void {
  const root = process.argv[2] ?? path.join(process.env.HOME ?? "", ".claude/projects");
  const maxUnknownPct = Number(process.env.MAX_UNKNOWN_PCT ?? DEFAULT_MAX_UNKNOWN_PCT);

  if (!fs.existsSync(root)) {
    console.error(`No transcript corpus at ${root}`);
    console.error("Pass one explicitly: npm run validate:transcripts -- <dir>");
    process.exit(2);
  }

  const files = findTranscripts(root);
  const kinds = new Map<string, number>();
  const unknownShapes = new Map<string, number>();
  let total = 0;

  for (const file of files) {
    let contents: string;
    try {
      contents = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const line of contents.split("\n")) {
      if (!line.trim()) continue;
      total++;
      const entry = parseEntry(line);
      kinds.set(entry.kind, (kinds.get(entry.kind) ?? 0) + 1);
      if (entry.kind === "unknown") {
        const shape = shapeOf(line);
        unknownShapes.set(shape, (unknownShapes.get(shape) ?? 0) + 1);
      }
    }
  }

  if (total === 0) {
    console.error(`Found ${files.length} file(s) under ${root} but no entries.`);
    process.exit(2);
  }

  const unknown = kinds.get("unknown") ?? 0;
  const pct = (unknown / total) * 100;

  console.log(`corpus: ${files.length} file(s), ${total} entries`);
  console.log("classified:");
  for (const [kind, n] of [...kinds].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(6)}  ${kind}`);
  }
  console.log(`unknown rate: ${pct.toFixed(1)}% (threshold ${maxUnknownPct}%)`);

  if (unknownShapes.size > 0) {
    console.log("unclassified shapes (structure only, no content):");
    for (const [shape, n] of [...unknownShapes].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
      console.log(`  ${String(n).padStart(6)}  ${shape}`);
    }
  }

  if (pct > maxUnknownPct) {
    console.error(
      `\nFAIL: ${pct.toFixed(1)}% of entries are unrecognised. The transcript ` +
        `schema has probably changed — see the shapes above.`,
    );
    process.exit(1);
  }
  console.log("\nOK");
}

main();
