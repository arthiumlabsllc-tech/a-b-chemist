/**
 * CSV reading for the bulk import.
 *
 * Written here rather than pulled in as a dependency because the whole job is
 * eighty lines and the failure modes are the ones that matter: a product name
 * containing a comma, a note containing a newline, and a file saved by Excel
 * with a byte-order mark in front of the first header.
 *
 * `code,name` split on commas reads `"Paracetamol 500mg, tabs"` as two columns
 * and then either shifts every later value one place or drops the row. Neither
 * failure is visible in the imported data — the product simply arrives with the
 * wrong pack size — so the parsing has to be right rather than convenient.
 */

/** A record that parsed. `line` is the physical line it started on, for a message a person can act on. */
export interface CsvRowOk {
  line: number;
  ok: true;
  values: Record<string, string>;
}

/**
 * A record that did not.
 *
 * Kept in the same list as the rows that did, rather than thrown, because the
 * importer reports one bad row without abandoning the other four hundred. A
 * parse failure and a database failure then look the same to the caller, which
 * is what makes "row 37: too many columns" and "row 12: that code already
 * exists" one list a pharmacist can work through.
 */
export interface CsvRowBad {
  line: number;
  ok: false;
  error: string;
}

export type CsvRow = CsvRowOk | CsvRowBad;

export interface CsvTable {
  /** The header, in file order, trimmed. */
  header: string[];
  /** Every record after it, in file order, good and bad together. */
  rows: CsvRow[];
}

/** Excel writes this in front of a UTF-8 export; left in place it corrupts the first header name. */
const BYTE_ORDER_MARK = '\uFEFF';

/**
 * Splits the file into records of raw fields.
 *
 * One pass with an index rather than a line-split followed by a field-split,
 * because a quoted field may contain a newline: splitting on newlines first
 * would cut that record in half and both pieces would look like a row with the
 * wrong number of columns.
 */
function splitRecords(text: string): { fields: string[]; line: number }[] {
  const records: { fields: string[]; line: number }[] = [];
  let field = '';
  let record: string[] = [];
  let inQuotes = false;
  let fieldWasQuoted = false;
  let line = 1;
  let recordLine = 1;
  let index = 0;

  const endField = (): void => {
    // An unquoted field is trimmed, a quoted one is not. `"  kept  "` means
    // somebody went to the trouble of quoting the spaces; `  dropped  ` is a
    // spreadsheet's alignment padding. Trimming both loses information, and
    // trimming neither imports a code that will never match.
    record.push(fieldWasQuoted ? field : field.trim());
    field = '';
    fieldWasQuoted = false;
  };

  const endRecord = (): void => {
    endField();
    records.push({ fields: record, line: recordLine });
    record = [];
  };

  while (index < text.length) {
    const char = text[index] ?? '';

    if (inQuotes) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          // The RFC 4180 escape: two quotes inside a quoted field are one
          // literal quote, and it is how a note like `say "take after food"`
          // survives a round trip through Excel.
          field += '"';
          index += 2;
          continue;
        }
        inQuotes = false;
        index += 1;
        continue;
      }
      // A newline inside quotes is data, and is the reason this is one pass.
      if (char === '\n') line += 1;
      field += char;
      index += 1;
      continue;
    }

    if (char === '"' && field.trim() === '') {
      inQuotes = true;
      fieldWasQuoted = true;
      field = '';
      index += 1;
      continue;
    }

    if (char === ',') {
      endField();
      index += 1;
      continue;
    }

    if (char === '\n' || char === '\r') {
      endRecord();
      // `\r\n` is one break, not two. Consuming the pair together is what stops
      // a Windows export producing a blank record after every real one.
      index += char === '\r' && text[index + 1] === '\n' ? 2 : 1;
      line += 1;
      recordLine = line;
      continue;
    }

    field += char;
    index += 1;
  }

  if (inQuotes) {
    // Everything after an unterminated quote was swallowed into one field, so
    // the rest of the file is not merely wrong but unreadable. A per-row error
    // would report one bad row and quietly drop the hundreds below it.
    throw new Error(
      `unterminated quote: a field opened with " on line ${String(recordLine)} and was never closed`
    );
  }

  // A file that does not end in a newline still has its last record.
  if (field !== '' || record.length > 0) endRecord();

  return records;
}

/**
 * Reads a CSV file into a header and a list of records keyed by header name.
 *
 * Column order in the file does not matter, which is the point of keying by
 * name: a spreadsheet with two columns swapped imports correctly rather than
 * putting a price in the pack size.
 */
export function parseCsv(source: string): CsvTable {
  const text = source.startsWith(BYTE_ORDER_MARK) ? source.slice(1) : source;
  const all = splitRecords(text);

  // A record with one empty field is a blank line — the trailing newline at the
  // end of the file, or a gap somebody left in the middle. It is not a row with
  // one empty column, and importing it would add a product named nothing.
  const records = all.filter(
    (record) => !(record.fields.length === 1 && record.fields[0] === '')
  );

  const headerRecord = records[0];
  if (headerRecord === undefined || headerRecord.fields.every((name) => name === '')) {
    throw new Error('the file has no header row; the first line must name the columns');
  }

  const header = headerRecord.fields;
  const blank = header.indexOf('');
  if (blank !== -1) {
    // A stray comma in the header. Every row then carries a value under a name
    // that is empty, which nothing downstream can ask for, and the column to
    // its right is shifted. Naming the position is the only useful message.
    throw new Error(`the header has an empty column name at position ${String(blank + 1)}`);
  }

  const duplicated = header.filter((name, at) => header.indexOf(name) !== at);
  if (duplicated.length > 0) {
    // Refused rather than resolved. Two columns with the same name means one of
    // them is silently discarded, and which one depends on the order the file
    // happens to be in.
    throw new Error(`the header names ${[...new Set(duplicated)].join(', ')} more than once`);
  }

  const rows: CsvRow[] = records.slice(1).map((record) => {
    if (record.fields.length > header.length) {
      return {
        line: record.line,
        ok: false,
        error:
          `expected ${String(header.length)} columns but found ${String(record.fields.length)}` +
          ' — a comma inside a value needs the value wrapped in double quotes',
      };
    }
    // Fewer fields than the header is not an error: the missing ones are
    // trailing empties, which is how a spreadsheet writes a blank last cell.
    const values: Record<string, string> = {};
    header.forEach((name, at) => {
      values[name] = record.fields[at] ?? '';
    });
    return { line: record.line, ok: true, values };
  });

  return { header, rows };
}

/**
 * Checks the header against the columns the importer understands.
 *
 * Unknown columns are refused rather than ignored. A header typo — `expirty_date`
 * — would otherwise import every row with no expiry at all and report success,
 * and the pharmacy would discover it when stock started disappearing without
 * ever having been dated. Naming the offending columns is what turns that into
 * a thirty-second fix.
 */
export function findUnknownColumns(
  header: readonly string[],
  known: readonly string[]
): string[] {
  return header.filter((name) => !known.includes(name));
}

/** Columns the importer needs and will not proceed without. */
export function findMissingColumns(
  header: readonly string[],
  required: readonly string[]
): string[] {
  return required.filter((name) => !header.includes(name));
}
