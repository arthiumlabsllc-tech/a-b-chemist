#!/usr/bin/env node
/**
 * Enforces the brief's hardest constraint: the excluded national health scheme
 * appears nowhere in this build — not in code, schema, UI copy, receipts,
 * reports, seeds, tests, and not in any file or directory name.
 *
 * This is worth a script rather than a habit because the failure is silent. A
 * leftover enum value, a column on `patients`, a tender option in the payment
 * modal or a route directory all still compile, still pass their own tests, and
 * still ship. The client asked for the scheme to be absent; a build that
 * quietly still bills to it has not met the contract.
 *
 * Two things make this guard slightly unusual, and both are deliberate:
 *
 *  1. Paths are scanned as well as contents. An empty `app/<term>/page.tsx`
 *     has nothing to match on inside, but its very existence is the violation.
 *  2. The term list lives here rather than being hard-coded in one regex, so
 *     the script's own name, its npm alias and its output stay free of the
 *     word. A guard that trips on its own invocation gets disabled, and a
 *     disabled guard is worse than none.
 *
 * The allowlist below is narrow and every entry has to justify itself. Anything
 * allowed here is a document that explains the prohibition, never a place where
 * the thing itself survives.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

/**
 * Case-insensitive terms that must not appear. Split so this file can be named,
 * referenced and read aloud without containing the whole word.
 */
const TERMS = ['n' + 'his'];

const PATTERNS = TERMS.map((term) => new RegExp(term, 'i'));

/** Directories that hold nothing we authored. */
const SKIPPED_DIRS = new Set([
  '.git',
  'node_modules',
  '.next',
  'dist',
  'build',
  'coverage',
  '.nyc_output',
  '.vercel',
  '.render',
  '.pgdata',
]);

/**
 * Files permitted to contain a term, because they are the reason it is banned
 * rather than a place it lives. Adding to this list is a decision that should
 * be argued for in review, not a convenience.
 */
const ALLOWED = new Map([
  ['BRIEF.md', 'states the constraint and the reasoning behind it'],
  ['scripts/guard-banned-terms.js', 'this guard; the pattern is its subject'],
]);

/** Binary and generated extensions that would only produce noise. */
const SKIPPED_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.webp', '.woff', '.woff2',
  '.ttf', '.eot', '.pdf', '.zip', '.lock',
]);

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    // Dot-directories hold tooling state, except CI, where a leftover reference
    // would still ship. Dot-files at the root are ours and are read.
    if (entry.name.startsWith('.') && entry.name !== '.github' && entry.isDirectory()) continue;

    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIPPED_DIRS.has(entry.name)) continue;
      walk(full, out);
    } else if (entry.isFile()) {
      if (SKIPPED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
      if (entry.name === 'package-lock.json') continue;
      out.push(full);
    }
  }
  return out;
}

function matches(text) {
  return PATTERNS.some((pattern) => pattern.test(text));
}

function main() {
  const files = walk(ROOT);
  const hits = [];

  for (const file of files) {
    const relative = path.relative(ROOT, file).split(path.sep).join('/');
    if (ALLOWED.has(relative)) continue;

    // The path is part of the contract too: a directory named after the scheme
    // survives every content search and still shows up in the deployed URL.
    if (matches(relative)) {
      hits.push({ file: relative, line: 0, text: '(file or directory name)' });
    }

    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      // Unreadable is not a match. Failing the guard on a permissions problem
      // would hide the thing it exists to find.
      continue;
    }

    text.split(/\r?\n/).forEach((line, index) => {
      if (matches(line)) {
        hits.push({ file: relative, line: index + 1, text: line.trim().slice(0, 160) });
      }
    });
  }

  const affected = new Set(hits.map((hit) => hit.file)).size;

  if (hits.length === 0) {
    console.log(`guard:banned-terms — clean. Scanned ${files.length} files, ${TERMS.length} term(s), no matches.`);
    return 0;
  }

  console.error(`guard:banned-terms — ${hits.length} match(es) in ${affected} file(s):`);
  for (const hit of hits) {
    console.error(`  ${hit.file}${hit.line ? ':' + hit.line : ''}  ${hit.text}`);
  }
  console.error('');
  console.error('This scheme is out of scope for the build entirely (BRIEF.md section 3.2).');
  console.error('Remove the reference. If a file genuinely needs to discuss the');
  console.error('prohibition, add it to ALLOWED above with a written reason.');
  return 1;
}

process.exit(main());
