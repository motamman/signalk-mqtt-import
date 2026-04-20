import { describe, expect, it } from 'vitest';
import {
  extractMMSIFromUrn,
  isMMSIExcluded,
  parseMMSIExclusionList,
} from '../parsers';
import { makeRule } from './helpers';

describe('parseMMSIExclusionList', () => {
  it('splits on commas and trims whitespace', () => {
    expect(parseMMSIExclusionList(' 1, 2 ,3 ')).toEqual(['1', '2', '3']);
  });

  it('filters empty entries', () => {
    expect(parseMMSIExclusionList(',,1, ,2')).toEqual(['1', '2']);
  });

  it('returns [] on empty/invalid input', () => {
    expect(parseMMSIExclusionList('')).toEqual([]);
    expect(parseMMSIExclusionList(undefined as any)).toEqual([]);
  });
});

describe('extractMMSIFromUrn', () => {
  it('handles underscore and colon formats', () => {
    expect(extractMMSIFromUrn('urn:mrn:imo:mmsi:368396230')).toBe('368396230');
    expect(extractMMSIFromUrn('urn_mrn_imo_mmsi_368396230')).toBe('368396230');
  });

  it('returns null for non-URN strings', () => {
    expect(extractMMSIFromUrn('vessels.self')).toBeNull();
    expect(extractMMSIFromUrn('')).toBeNull();
  });
});

describe('isMMSIExcluded', () => {
  it('excludes when MMSI appears in the rule list', () => {
    const rule = makeRule({ excludeMMSI: '111, 368396230, 222' });
    expect(
      isMMSIExcluded('vessels/urn_mrn_imo_mmsi_368396230/navigation/x', rule)
    ).toBe(true);
  });

  it('does not exclude unrelated MMSIs', () => {
    const rule = makeRule({ excludeMMSI: '111' });
    expect(
      isMMSIExcluded('vessels/urn_mrn_imo_mmsi_999/navigation/x', rule)
    ).toBe(false);
  });

  it('does not exclude non-vessels topics', () => {
    const rule = makeRule({ excludeMMSI: '111' });
    expect(isMMSIExcluded('zigbee2mqtt/x', rule)).toBe(false);
  });

  it('returns false when the rule has no exclusion list', () => {
    const rule = makeRule({ excludeMMSI: '' });
    expect(isMMSIExcluded('vessels/urn_mrn_imo_mmsi_111/x/y', rule)).toBe(
      false
    );
  });

  it('treats underscore- and colon-format URNs identically', () => {
    const rule = makeRule({ excludeMMSI: '368396230' });
    expect(isMMSIExcluded('vessels/urn:mrn:imo:mmsi:368396230/x/y', rule)).toBe(
      true
    );
    expect(isMMSIExcluded('vessels/urn_mrn_imo_mmsi_368396230/x/y', rule)).toBe(
      true
    );
  });
});
