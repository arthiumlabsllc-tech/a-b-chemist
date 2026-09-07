import { decimalFromRate, labelFromRate, parseRateField } from '../rates';

/**
 * The rate field is where the ten-thousandths/decimal/percentage trap is most
 * likely to be sprung by a person rather than by a program: an owner types `15`
 * meaning 15%, or clears the box, or adds a fifth decimal. Every one of those is
 * an ordinary keystroke that must come back as a message and not a throw, and the
 * ones that are rates must come back with all three spellings agreeing.
 */
describe('parseRateField', () => {
  it('reads a two-place decimal into all three spellings', () => {
    const result = parseRateField('0.15', 'VAT');
    expect(result).toEqual({ ok: true, rate: 1500, label: '15%', decimal: '0.1500' });
  });

  it('reads the four-place spelling the column stores', () => {
    expect(parseRateField('0.1500', 'VAT')).toEqual({
      ok: true,
      rate: 1500,
      label: '15%',
      decimal: '0.1500',
    });
  });

  it('reads a fractional-percent levy without losing the half', () => {
    // NHIL and GETFund are 2.5%: 250 ten-thousandths, labelled '2.5%' not '2.50%'.
    expect(parseRateField('0.025', 'NHIL')).toEqual({
      ok: true,
      rate: 250,
      label: '2.5%',
      decimal: '0.0250',
    });
  });

  it('reads zero as charging none', () => {
    expect(parseRateField('0', 'VAT')).toEqual({
      ok: true,
      rate: 0,
      label: '0%',
      decimal: '0.0000',
    });
  });

  it('reads a bare 1 as one hundred percent, the top of the range', () => {
    expect(parseRateField('1', 'VAT')).toEqual({
      ok: true,
      rate: 10_000,
      label: '100%',
      decimal: '1.0000',
    });
  });

  it('trims surrounding space before reading', () => {
    expect(parseRateField('  0.15  ', 'VAT')).toEqual({
      ok: true,
      rate: 1500,
      label: '15%',
      decimal: '0.1500',
    });
  });

  it('refuses an empty field with a message that says how to charge none', () => {
    const result = parseRateField('', 'VAT');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.message).toContain('0 to charge none');
  });

  it('refuses a whitespace-only field the same as an empty one', () => {
    expect(parseRateField('   ', 'VAT').ok).toBe(false);
  });

  it('refuses a percentage typed as a whole number', () => {
    // The trap: an owner types 15 for 15%. It is above one, so it is refused
    // rather than read as fifteen-hundred percent or silently as zero.
    const result = parseRateField('15', 'VAT');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.message).toContain('VAT');
  });

  it('names the field it was given in the refusal', () => {
    const result = parseRateField('15', 'GETFund levy');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.message).toContain('GETFund levy');
  });

  it('refuses a rate above one', () => {
    expect(parseRateField('1.5', 'VAT').ok).toBe(false);
  });

  it('refuses a fifth decimal place', () => {
    expect(parseRateField('0.12345', 'VAT').ok).toBe(false);
  });

  it('refuses a negative rate', () => {
    expect(parseRateField('-0.1', 'VAT').ok).toBe(false);
  });

  it('refuses text that is not a number', () => {
    expect(parseRateField('abc', 'VAT').ok).toBe(false);
  });
});

describe('decimalFromRate', () => {
  it('turns GRA reference ten-thousandths into the decimal a field holds', () => {
    // This is the "restore Act 1151" path: act1151.vatRate is 1500, and the field
    // must be seeded with '0.1500' — never with 1500, which parseRate would read
    // as 15,000%.
    expect(decimalFromRate(1500)).toBe('0.1500');
    expect(decimalFromRate(250)).toBe('0.0250');
  });

  it('round-trips a rate the field already parsed', () => {
    const parsed = parseRateField('0.025', 'NHIL');
    if (!parsed.ok) throw new Error('expected the rate to parse');
    expect(decimalFromRate(parsed.rate)).toBe(parsed.decimal);
  });

  it('handles the ends of the range', () => {
    expect(decimalFromRate(0)).toBe('0.0000');
    expect(decimalFromRate(10_000)).toBe('1.0000');
  });
});

describe('labelFromRate', () => {
  it('reads GRA reference ten-thousandths as the percentages an owner recognises', () => {
    // The Act 1151 card shows these three: VAT 15%, and the two 2.5% levies.
    expect(labelFromRate(1500)).toBe('15%');
    expect(labelFromRate(250)).toBe('2.5%');
  });

  it('agrees with the label parseRateField derives from the same rate', () => {
    const parsed = parseRateField('0.15', 'VAT');
    if (!parsed.ok) throw new Error('expected the rate to parse');
    expect(labelFromRate(parsed.rate)).toBe(parsed.label);
  });

  it('handles the ends of the range', () => {
    expect(labelFromRate(0)).toBe('0%');
    expect(labelFromRate(10_000)).toBe('100%');
  });
});
