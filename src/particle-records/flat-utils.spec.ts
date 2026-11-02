import {
  codeSystemUri,
  collapseRepeated,
  pairCodes,
  parseFlatDate,
  splitList,
  xmlToText,
} from './flat-utils';

describe('flat-utils', () => {
  describe('parseFlatDate', () => {
    it.each([
      ['2011-05-28T15:19:11+0000', '2011-05-28T15:19:11.000Z'],
      ['1970-12-26 00:00:00.000000+00:00', '1970-12-26T00:00:00.000Z'],
      ['2026-02-06T02:41:44.378318936Z', '2026-02-06T02:41:44.378Z'],
      [', 2011-05-28T15:19:11+0000', '2011-05-28T15:19:11.000Z'],
      ['2026-01-13T16:57:10.003238+00:00', '2026-01-13T16:57:10.003Z'],
    ])('parses Particle format %s', (input, expected) => {
      expect(parseFlatDate(input)?.toISOString()).toBe(expected);
    });

    it('returns undefined for empty or garbage values instead of an Invalid Date', () => {
      expect(parseFlatDate(undefined)).toBeUndefined();
      expect(parseFlatDate('')).toBeUndefined();
      expect(parseFlatDate('not a date')).toBeUndefined();
    });
  });

  it('maps OIDs to the canonical URIs the main-app parser keys on', () => {
    expect(codeSystemUri('urn:oid:2.16.840.1.113883.6.96')).toBe(
      'http://snomed.info/sct',
    );
    expect(codeSystemUri('2.16.840.1.113883.6.1')).toBe('http://loinc.org');
    expect(codeSystemUri('http://example.org/cs')).toBe(
      'http://example.org/cs',
    );
  });

  it('pairs slot-aligned code and system columns and reuses a single system for all codes', () => {
    expect(
      pairCodes(
        'E11.9, 44054006',
        'urn:oid:2.16.840.1.113883.6.90, urn:oid:2.16.840.1.113883.6.96',
      ),
    ).toEqual([
      { system: 'http://hl7.org/fhir/sid/icd-10-cm', value: 'E11.9' },
      { system: 'http://snomed.info/sct', value: '44054006' },
    ]);
    expect(pairCodes('1|2', 'urn:oid:2.16.840.1.113883.6.88')).toHaveLength(2);
  });

  it('collapses names Particle repeats per source section but keeps real commas', () => {
    expect(
      collapseRepeated('Encounter for problem, Encounter for problem'),
    ).toBe('Encounter for problem');
    expect(
      collapseRepeated(
        'Heart failure, unspecified (HCC), Heart failure, unspecified (HCC), Heart failure, unspecified (HCC)',
      ),
    ).toBe('Heart failure, unspecified (HCC)');
    expect(collapseRepeated('Sodium chloride, 0.9%')).toBe(
      'Sodium chloride, 0.9%',
    );
  });

  it('splits delimited lists without empty or duplicate parts', () => {
    expect(splitList('a, b,,a|c')).toEqual(['a', 'b', 'c']);
  });

  it('turns CDA narrative XML into readable text', () => {
    expect(
      xmlToText(
        '<text><paragraph>Short &amp; sharp</paragraph><paragraph>pain</paragraph></text>',
      ),
    ).toBe('Short & sharp\npain');
  });
});
