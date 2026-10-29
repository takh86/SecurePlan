import { parseExpectedVersion } from './expected-version.js';

const codeOf = (header: string | string[] | undefined) => {
  try {
    parseExpectedVersion(header);
    return null;
  } catch (error) {
    const { status, response } = error as { status?: number; response?: { code?: string } };
    return `${status} ${response?.code}`;
  }
};

describe('#73 — Expected-Version header parser (U-2)', () => {
  it.each([
    ['1', 1],
    ['7', 7],
    ['1793260800123456', 1793260800123456],
    ['9007199254740991', Number.MAX_SAFE_INTEGER],
  ])('accepts %s', (header, expected) => {
    expect(parseExpectedVersion(header)).toBe(expected);
  });

  it('a missing header is EXPECTED_VERSION_REQUIRED', () => {
    expect(codeOf(undefined)).toBe('400 EXPECTED_VERSION_REQUIRED');
  });

  it.each([
    ['empty', ''],
    ['letters', 'abc'],
    ['zero', '0'],
    ['negative', '-1'],
    ['explicit plus sign', '+1'],
    ['leading zero', '01'],
    ['decimal', '1.0'],
    ['exponent', '1e3'],
    ['inner whitespace', '1 2'],
    ['surrounding whitespace (the HTTP layer strips it, the parser does not)', ' 7 '],
    ['sent twice, as Node joins it', '1, 2'],
    ['sent twice with the same value', '5, 5'],
    ['above the safe-integer range', '9007199254740992'],
    ['17 digits', '10000000000000000'],
    ['hexadecimal', '0x10'],
    ['non-ASCII digits', '١٢'],
    ['full-width digits', '１'],
  ])('rejects %s as INVALID_EXPECTED_VERSION', (_label, header) => {
    expect(codeOf(header)).toBe('400 INVALID_EXPECTED_VERSION');
  });

  it('rejects an array value (never a valid single header)', () => {
    expect(codeOf(['1'])).toBe('400 INVALID_EXPECTED_VERSION');
    expect(codeOf(['1', '2'])).toBe('400 INVALID_EXPECTED_VERSION');
  });
});
