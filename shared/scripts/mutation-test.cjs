/**
 * Mutation testing for the tax engine.
 *
 * The plan's test discipline: "Every test is seen to fail when the behaviour it
 * guards is broken — a test that has never been red proves nothing." A suite that
 * is green on first run has demonstrated nothing about itself, so each mutation
 * below breaks one behaviour deliberately and the suite has to notice.
 *
 * Run with `npm run test:mutations`. Every mutation must be killed; the process
 * exits non-zero if any survives, so it can sit in a gate rather than being a
 * thing somebody remembers to do once.
 *
 * A mutation that survives is the interesting result. It means either the suite has
 * a hole, or the mutation is equivalent — the change cannot be observed through any
 * input the engine accepts. Both are worth knowing and they are reported separately.
 * One of each has already been found and both changed the source: `floorDiv` was
 * only swept over non-negative numerators, where `Math.trunc` and `Math.floor`
 * agree, so `money.test.ts` now sweeps both sides of zero; and `splitOf` and
 * `zeroSplit` each spelled the input-tax rule their own way, which made one of them
 * unobservable, so `tax.ts` now has a single `creditable()`.
 *
 * Adding a mutation is the way to extend this: one entry per behaviour worth
 * breaking, anchored on enough source text to match exactly once. The harness
 * refuses to run an anchor that matches zero or more than one time, because a
 * mutation applied somewhere other than where it was meant is worse than no
 * mutation at all.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');

const MUTATIONS = [
  {
    name: 'roundHalfUp: half up becomes half to even',
    file: 'money.ts',
    edits: [
      {
        find: '  return remainder * 2 >= denominator ? quotient + 1 : quotient;',
        replace:
          '  return remainder * 2 > denominator || (remainder * 2 === denominator && quotient % 2 !== 0) ? quotient + 1 : quotient;',
      },
    ],
  },
  {
    name: 'floorDiv: floor becomes trunc',
    file: 'money.ts',
    edits: [{ find: '  const quotient = Math.floor(numerator / denominator);', replace: '  const quotient = Math.trunc(numerator / denominator);' }],
  },
  {
    name: 'rateLabel: divides by the rate scale, not by one percent',
    file: 'money.ts',
    edits: [
      {
        find: 'floorDiv(rateTenThousandths, TEN_THOUSANDTHS_PER_PERCENT)',
        replace: 'floorDiv(rateTenThousandths, RATE_SCALE)',
      },
    ],
  },
  {
    name: 'rateLabel: pads the remainder on the right',
    file: 'money.ts',
    edits: [
      {
        find: "const digits = String(remainder).padStart(2, '0').replace(/0+$/u, '');",
        replace: "const digits = String(remainder).padEnd(2, '0').replace(/0+$/u, '');",
      },
    ],
  },
  {
    name: 'rateDecimalString: pads the remainder on the right',
    file: 'money.ts',
    edits: [
      {
        find: "  return `${quotient}.${String(remainder).padStart(4, '0')}`;",
        replace: "  return `${quotient}.${String(remainder).padEnd(4, '0')}`;",
      },
    ],
  },
  {
    // The mutation that looks like an improvement rather than a defect: '0.1500'
    // and '0.15' parse to the same rate, so no tax figure anywhere changes. What
    // breaks is the round trip back into the column, and only the identity test
    // against `ACT_1151_AS_STORED` can see it.
    name: 'rateDecimalString: trims the zeros the column stores',
    file: 'money.ts',
    edits: [
      {
        find: "  return `${quotient}.${String(remainder).padStart(4, '0')}`;",
        replace: "  return `${quotient}.${String(remainder).padStart(4, '0').replace(/0+$/u, '')}`;",
      },
    ],
  },
  {
    name: 'parseRate: multiplies by the scale instead of reading the digits',
    file: 'money.ts',
    edits: [{ find: '    text = String(value);', replace: '    return Math.trunc(value * RATE_SCALE);' }],
  },
  {
    name: 'parseRate: pads the rate fraction on the left',
    file: 'money.ts',
    edits: [
      {
        find: "const scaled = Number((fraction ?? '').padEnd(4, '0'));",
        replace: "const scaled = Number((fraction ?? '').padStart(4, '0'));",
      },
    ],
  },
  {
    name: 'pesewasFromDecimalString: pads the fraction on the left',
    file: 'money.ts',
    edits: [
      {
        find: "Number((fraction ?? '').padEnd(2, '0'))",
        replace: "Number((fraction ?? '').padStart(2, '0'))",
      },
    ],
  },
  {
    name: 'assertTotal: uses the arithmetic ceiling instead of the storage one',
    file: 'money.ts',
    edits: [{ find: '  if (value > MAX_TOTAL_PESEWAS) {', replace: '  if (value > MAX_AMOUNT_PESEWAS) {' }],
  },
  {
    name: 'apportionDiscount: no capacity limit on the drift',
    file: 'discount.ts',
    edits: [{ find: '    const placed = room < outstanding ? room : outstanding;', replace: '    const placed = outstanding;' }],
  },
  {
    name: 'apportionDiscount: tie-break becomes latest index first',
    file: 'discount.ts',
    edits: [
      {
        find: '    .sort((a, b) => (b.value === a.value ? a.index - b.index : b.value - a.value));',
        replace: '    .sort((a, b) => (b.value === a.value ? b.index - a.index : b.value - a.value));',
      },
    ],
  },
  {
    name: 'apportionDiscount: drift reported but never placed',
    file: 'discount.ts',
    edits: [{ find: '  let outstanding = drift;', replace: '  let outstanding = 0;' }],
  },
  {
    name: 'apportionDiscount: the basket-total ceiling is removed',
    file: 'discount.ts',
    edits: [
      {
        find: "  if (total > MAX_AMOUNT_PESEWAS) {\n    throw new TaxError('amount_out_of_range', 'The basket is larger than this system can price');\n  }\n",
        replace: '',
      },
    ],
  },
  {
    name: 'apportionDiscount: an over-discount is allowed through',
    file: 'discount.ts',
    edits: [
      {
        find: "  if (discount > total) {\n    throw new TaxError(\n      'discount_exceeds_basket',\n      'The discount is more than the basket is worth'\n    );\n  }\n",
        replace: '',
      },
    ],
  },
  {
    name: 'taxFromInclusiveGross: base first, taxes computed from it',
    file: 'tax.ts',
    edits: [
      {
        find: '  const divisor = inclusiveDivisor(settings);\n  const vat = roundHalfUp(gross * settings.vatRate, divisor);\n  const nhil = roundHalfUp(gross * settings.nhilRate, divisor);\n  const getfund = roundHalfUp(gross * settings.getfundRate, divisor);\n  const taxTotal = vat + nhil + getfund;\n\n  return splitOf(treatment, gross - taxTotal, vat, nhil, getfund);',
        replace: '  const divisor = inclusiveDivisor(settings);\n  const base = roundHalfUp(gross * RATE_SCALE, divisor);\n  const vat = applyRate(base, settings.vatRate);\n  const nhil = applyRate(base, settings.nhilRate);\n  const getfund = applyRate(base, settings.getfundRate);\n\n  return splitOf(treatment, base, vat, nhil, getfund);',
      },
    ],
  },
  {
    name: 'taxOnExclusiveBase: the pre-reform cascade returns',
    file: 'tax.ts',
    edits: [
      {
        find: '  return splitOf(\n    treatment,\n    base,\n    applyRate(base, settings.vatRate),\n    applyRate(base, settings.nhilRate),\n    applyRate(base, settings.getfundRate)\n  );',
        replace: '  const levies = applyRate(base, settings.nhilRate) + applyRate(base, settings.getfundRate);\n  return splitOf(\n    treatment,\n    base,\n    applyRate(base + levies, settings.vatRate),\n    applyRate(base, settings.nhilRate),\n    applyRate(base, settings.getfundRate)\n  );',
      },
    ],
  },
  {
    name: 'creditable: no treatment recovers input tax',
    file: 'tax.ts',
    edits: [{ find: "  return treatment !== 'exempt';", replace: '  return false;' }],
  },
  {
    name: 'creditable: every treatment recovers input tax',
    file: 'tax.ts',
    edits: [{ find: "  return treatment !== 'exempt';", replace: '  return true;' }],
  },
  {
    name: 'taxOnLine: the two pricing modes are swapped',
    file: 'tax.ts',
    edits: [
      {
        find: '  return settings.taxInclusivePricing\n    ? taxFromInclusiveGross(amountPesewas, settings, treatment)\n    : taxOnExclusiveBase(amountPesewas, settings, treatment);',
        replace: '  return settings.taxInclusivePricing\n    ? taxOnExclusiveBase(amountPesewas, settings, treatment)\n    : taxFromInclusiveGross(amountPesewas, settings, treatment);',
      },
    ],
  },
  {
    name: 'taxOnExclusiveBase: the treatment stops deciding, everything is standard',
    file: 'tax.ts',
    edits: [
      {
        find: "  if (treatment !== 'standard') {\n    // Both non-standard treatments charge nothing.",
        replace: "  if (treatment !== 'standard' && settings.vatRate < 0) {\n    // Both non-standard treatments charge nothing.",
      },
    ],
  },
  {
    name: 'taxFromInclusiveGross: the treatment stops deciding, everything is standard',
    file: 'tax.ts',
    edits: [
      {
        find: "  if (treatment !== 'standard') {\n    // An exempt shelf price has no tax inside it",
        replace: "  if (treatment !== 'standard' && settings.vatRate < 0) {\n    // An exempt shelf price has no tax inside it",
      },
    ],
  },
  {
    name: 'priceBasket: lines sorted by value instead of kept in order',
    file: 'basket.ts',
    edits: [
      {
        find: '    lines: Object.freeze(priced),',
        replace: '    lines: Object.freeze([...priced].sort((a, b) => b.lineGross - a.lineGross)),',
      },
    ],
  },
  {
    name: 'priceBasket: the priced lines are returned unfrozen',
    file: 'basket.ts',
    edits: [{ find: '      Object.freeze({\n        id: line.id,', replace: '      ({\n        id: line.id,' }],
  },
  {
    name: 'priceBasket: a VAT treatment is matched case-insensitively',
    file: 'basket.ts',
    edits: [
      {
        find: '      vatTreatment: assertTreatment(line.vatTreatment, `${label} VAT treatment`),',
        replace: '      vatTreatment: assertTreatment(String(line.vatTreatment).toLowerCase(), `${label} VAT treatment`),',
      },
    ],
  },
  {
    name: 'priceBasket: a fractional quantity is accepted',
    file: 'basket.ts',
    edits: [
      {
        find: '    if (!Number.isInteger(line.quantity) || line.quantity < 1) {',
        replace: '    if (line.quantity < 1) {',
      },
    ],
  },
  {
    name: 'priceBasket: two lines may answer to one identifier',
    file: 'basket.ts',
    edits: [
      {
        find: "    if (seen.has(line.id)) {\n      throw new TaxError('line_out_of_range', `${label} repeats the identifier of an earlier line`, label);\n    }\n    seen.add(line.id);",
        replace: '    seen.add(line.id);',
      },
    ],
  },
  {
    name: 'normaliseReason: the reason is stored untrimmed',
    file: 'basket.ts',
    edits: [
      {
        find: "  const text = typeof reason === 'string' ? reason.trim() : '';",
        replace: "  const text = typeof reason === 'string' ? reason : '';",
      },
    ],
  },
  {
    name: 'normaliseReason: a discount no longer needs a reason',
    file: 'basket.ts',
    edits: [
      {
        find: "  if (text === '') {\n    throw new TaxError(\n      'discount_reason_required',\n      'A discount needs a reason recorded against it',\n      'discountReason'\n    );\n  }",
        replace: "  if (text === '' && discount < 0) {\n    throw new TaxError(\n      'discount_reason_required',\n      'A discount needs a reason recorded against it',\n      'discountReason'\n    );\n  }",
      },
    ],
  },
];

// `jest`'s `exports` map does not expose `./bin/jest.js`, so resolve the package
// root through its `package.json` — which it does expose — and walk from there.
const jestBin = path.join(
  path.dirname(require.resolve('jest/package.json', { paths: [ROOT] })),
  'bin',
  'jest.js'
);
if (!fs.existsSync(jestBin)) {
  console.log(`no jest binary at ${jestBin}`);
  process.exit(2);
}

function run() {
  const out = path.join(ROOT, 'mutation-run.json');
  if (fs.existsSync(out)) fs.unlinkSync(out);
  try {
    execFileSync(process.execPath, [jestBin, '--silent', '--json', `--outputFile=${out}`], {
      cwd: ROOT,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
  } catch (error) {
    // A non-zero exit is the expected outcome of a killed mutation.
    if (!fs.existsSync(out)) {
      return { compiled: false, failed: [], stderr: String(error.message).slice(0, 400) };
    }
  }
  const report = JSON.parse(fs.readFileSync(out, 'utf8'));
  fs.unlinkSync(out);
  const failed = [];
  for (const suite of report.testResults) {
    for (const assertion of suite.assertionResults) {
      if (assertion.status === 'failed') failed.push(assertion.fullName);
    }
  }
  return { compiled: report.numTotalTests > 0, total: report.numTotalTests, failed };
}

const results = [];
for (const mutation of MUTATIONS) {
  const target = path.join(SRC, mutation.file);
  const original = fs.readFileSync(target, 'utf8');

  let mutated = original;
  let anchor = 'ok';
  // The sources are CRLF on this checkout and the anchors below are written with
  // `\n`. Every multi-line anchor matched zero times until this was handled, which
  // is worth stating because the failure looked like a code change rather than a
  // harness bug: single-line anchors worked and multi-line ones silently did not.
  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  for (const edit of mutation.edits) {
    const find = edit.find.split('\n').join(eol);
    const replace = edit.replace.split('\n').join(eol);
    const occurrences = mutated.split(find).length - 1;
    if (occurrences !== 1) {
      anchor = `anchor matched ${occurrences} times, expected 1`;
      break;
    }
    mutated = mutated.replace(find, replace);
  }

  if (anchor !== 'ok') {
    results.push({ name: mutation.name, verdict: 'ANCHOR', detail: anchor });
    console.log(`ANCHOR   ${mutation.name} — ${anchor}`);
    continue;
  }

  fs.writeFileSync(target, mutated, 'utf8');
  let outcome;
  try {
    outcome = run();
  } finally {
    fs.writeFileSync(target, original, 'utf8');
  }

  const restored = fs.readFileSync(target, 'utf8') === original;
  if (!restored) {
    console.log(`!! FAILED TO RESTORE ${mutation.file} — aborting`);
    process.exit(2);
  }

  if (!outcome.compiled) {
    results.push({ name: mutation.name, verdict: 'COMPILE', detail: outcome.stderr });
    console.log(`COMPILE  ${mutation.name}`);
    continue;
  }

  if (outcome.failed.length === 0) {
    results.push({ name: mutation.name, verdict: 'SURVIVED', detail: `${outcome.total} tests still passed` });
    console.log(`SURVIVED ${mutation.name}`);
  } else {
    results.push({
      name: mutation.name,
      verdict: 'killed',
      detail: `${outcome.failed.length} of ${outcome.total}`,
      first: outcome.failed.slice(0, 3),
    });
    console.log(`killed   ${mutation.name} — ${outcome.failed.length} of ${outcome.total} tests failed`);
  }
}

const survived = results.filter((r) => r.verdict === 'SURVIVED');
const broken = results.filter((r) => r.verdict === 'ANCHOR' || r.verdict === 'COMPILE');
const killed = results.filter((r) => r.verdict === 'killed');

console.log('');
console.log(`mutations: ${results.length}   killed: ${killed.length}   survived: ${survived.length}   unusable: ${broken.length}`);
for (const entry of survived) console.log(`  SURVIVED: ${entry.name} — ${entry.detail}`);
for (const entry of broken) console.log(`  ${entry.verdict}: ${entry.name} — ${entry.detail}`);

fs.writeFileSync(path.join(ROOT, 'mutation-report.json'), JSON.stringify(results, null, 2), 'utf8');

// Non-zero unless every mutation was killed and every anchor applied. A survivor is
// a hole in the suite and an unusable anchor means the mutation never ran, and
// either one should fail a gate rather than be reported and forgotten.
process.exit(survived.length === 0 && broken.length === 0 ? 0 : 1);
