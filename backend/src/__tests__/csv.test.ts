import { findMissingColumns, findUnknownColumns, parseCsv } from '../utils/csv';

/**
 * CSV reading.
 *
 * The cases here are the ones a real spreadsheet export produces, not the ones a
 * parser author thinks of first. Every fixture below is a file somebody at A&B
 * could plausibly save, and every assertion is about the imported value being
 * right rather than about the parse not throwing — a parser that quietly shifts
 * a column is worse than one that crashes, because the crash gets noticed.
 */

function valuesOf(source: string): Record<string, string>[] {
  return parseCsv(source).rows.flatMap((row) => (row.ok ? [row.values] : []));
}

function errorsOf(source: string): { line: number; error: string }[] {
  return parseCsv(source).rows.flatMap((row) =>
    row.ok ? [] : [{ line: row.line, error: row.error }]
  );
}

describe('parseCsv', () => {
  it('reads a simple file into records keyed by header name', () => {
    const table = parseCsv('code,name,quantity\nABC-1,Paracetamol,100\nABC-2,Ibuprofen,50\n');
    expect(table.header).toEqual(['code', 'name', 'quantity']);
    expect(table.rows).toHaveLength(2);
    expect(valuesOf('code,name,quantity\nABC-1,Paracetamol,100\n')).toEqual([
      { code: 'ABC-1', name: 'Paracetamol', quantity: '100' },
    ]);
  });

  it('does not care what order the columns are in', () => {
    // Keying by name is the whole point. A spreadsheet with two columns dragged
    // into a different order imports correctly instead of putting a price in the
    // pack size, which is the failure that looks like success.
    const swapped = valuesOf('quantity,name,code\n100,Paracetamol,ABC-1\n');
    const normal = valuesOf('code,name,quantity\nABC-1,Paracetamol,100\n');
    expect(swapped).toEqual(normal);
  });

  it('keeps a comma inside a quoted value in one field', () => {
    const rows = valuesOf('code,name\nABC-1,"Paracetamol 500mg, tabs"\n');
    expect(rows).toEqual([{ code: 'ABC-1', name: 'Paracetamol 500mg, tabs' }]);
  });

  it('unescapes a doubled quote inside a quoted value', () => {
    const rows = valuesOf('code,note\nABC-1,"say ""take after food"""\n');
    expect(rows).toEqual([{ code: 'ABC-1', note: 'say "take after food"' }]);
  });

  it('keeps a newline inside a quoted value in the same record', () => {
    const source = 'code,note\nABC-1,"line one\nline two"\nABC-2,plain\n';
    const rows = valuesOf(source);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.note).toBe('line one\nline two');
    expect(rows[1]).toEqual({ code: 'ABC-2', note: 'plain' });

    // And the reported line is where the record started, which is what a person
    // opening the file sees — not the physical line the record ended on.
    expect(parseCsv(source).rows[1]).toMatchObject({ line: 4, ok: true });
  });

  it('does not trim inside quotes, and does trim outside them', () => {
    const rows = valuesOf('code,name\n  ABC-1  ,"  Kept  "\n');
    expect(rows).toEqual([{ code: 'ABC-1', name: '  Kept  ' }]);
  });

  it('treats a field of only spaces as empty', () => {
    expect(valuesOf('code,note\nABC-1,   \n')).toEqual([{ code: 'ABC-1', note: '' }]);
  });

  it('reads CRLF and LF as the same line break', () => {
    const lf = valuesOf('code,name\nA,one\nB,two\n');
    const crlf = valuesOf('code,name\r\nA,one\r\nB,two\r\n');
    expect(crlf).toEqual(lf);
    // A Windows export must not produce a blank record after every real one.
    expect(parseCsv('code,name\r\nA,one\r\n').rows).toHaveLength(1);
  });

  it('ignores a trailing newline and a blank line in the middle', () => {
    expect(parseCsv('code\nA\n').rows).toHaveLength(1);
    expect(parseCsv('code\nA').rows).toHaveLength(1);
    expect(parseCsv('code\nA\n\nB\n').rows).toHaveLength(2);
    expect(parseCsv('code\nA\n\n\n').rows).toHaveLength(1);
  });

  it('strips the byte-order mark Excel puts in front of a UTF-8 export', () => {
    // Left in place the first header reads as '\uFEFFcode', the column is not
    // found, and every row imports with no code.
    const table = parseCsv('\uFEFFcode,name\nA,one\n');
    expect(table.header[0]).toBe('code');
    expect(valuesOf('\uFEFFcode,name\nA,one\n')).toEqual([{ code: 'A', name: 'one' }]);
  });

  it('fills a short row with empties rather than failing it', () => {
    // Trailing blank cells are how a spreadsheet writes an optional column left
    // unfilled. Failing those rows would reject most real exports.
    expect(valuesOf('code,name,category\nA,one\n')).toEqual([
      { code: 'A', name: 'one', category: '' },
    ]);
  });

  it('fails a long row and says why, without dropping the rest of the file', () => {
    const source = 'code,name\nA,one,extra\nB,two\n';
    const errors = errorsOf(source);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.error).toMatch(/expected 2 columns but found 3/);
    // The fix is named, because the cause is not obvious from the data.
    expect(errors[0]?.error).toMatch(/double quotes/);
    expect(valuesOf(source)).toEqual([{ code: 'B', name: 'two' }]);
  });

  it('reports the physical line a bad row started on', () => {
    const source = 'code,name\nA,one\nB,two,three\n';
    expect(errorsOf(source)).toEqual([
      { line: 3, error: expect.stringMatching(/found 3/) },
    ]);
  });

  it('refuses a file with no header', () => {
    expect(() => parseCsv('')).toThrow(/no header row/);
    expect(() => parseCsv('\n\n')).toThrow(/no header row/);
    expect(() => parseCsv(',,\nA,B,C\n')).toThrow(/no header row/);
  });

  it('refuses an unterminated quote instead of swallowing the file', () => {
    // Everything after the open quote becomes one field, so the remaining rows
    // are not merely wrong but gone. Reporting one bad row here would hide the
    // other four hundred.
    expect(() => parseCsv('code,name\nA,"never closed\nB,two\n')).toThrow(/unterminated quote/);
  });

  it('refuses a header that names a column twice', () => {
    expect(() => parseCsv('code,name,code\nA,one,two\n')).toThrow(/code more than once/);
  });

  it('refuses an empty column name and says where it is', () => {
    expect(() => parseCsv('code,,name\nA,x,one\n')).toThrow(/empty column name at position 2/);
  });

  it('reads a quoted empty value as empty, not as missing', () => {
    expect(valuesOf('code,note\nA,""\n')).toEqual([{ code: 'A', note: '' }]);
  });

  it('handles a single-column file', () => {
    expect(parseCsv('code\nA\nB\n').header).toEqual(['code']);
    expect(valuesOf('code\nA\nB\n')).toEqual([{ code: 'A' }, { code: 'B' }]);
  });
});

describe('findUnknownColumns', () => {
  const known = ['code', 'name', 'quantity'];

  it('is empty when every column is understood', () => {
    expect(findUnknownColumns(['name', 'code'], known)).toEqual([]);
  });

  it('names a column the importer does not understand', () => {
    // Refused rather than ignored: a header typo would otherwise import every
    // row with no expiry at all and report success, and the pharmacy finds out
    // when stock disappears without ever having been dated.
    expect(findUnknownColumns(['code', 'expirty_date'], known)).toEqual(['expirty_date']);
    expect(findUnknownColumns(['code', 'qty', 'cost'], known)).toEqual(['qty', 'cost']);
  });
});

describe('findMissingColumns', () => {
  it('names the required columns the header does not carry', () => {
    expect(findMissingColumns(['code', 'name'], ['code', 'quantity'])).toEqual(['quantity']);
    expect(findMissingColumns(['code', 'quantity'], ['code', 'quantity'])).toEqual([]);
  });
});
