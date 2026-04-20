import { describe, expect, it } from 'vitest';
import {
  applyPlaceholders,
  extractContextFromTopic,
  extractPathFromTopic,
  extractPlaceholdersFromTopic,
  mqttTopicMatches,
} from '../parsers';

const SELF_URN = 'urn:mrn:imo:mmsi:368396230';
const SELF_URN_UNDERSCORE = 'urn_mrn_imo_mmsi_368396230';

describe('mqttTopicMatches', () => {
  it('matches exact literal topics', () => {
    expect(mqttTopicMatches('a/b/c', 'a/b/c')).toBe(true);
    expect(mqttTopicMatches('a/b/d', 'a/b/c')).toBe(false);
  });

  it('+ matches exactly one segment', () => {
    expect(mqttTopicMatches('a/xx/c', 'a/+/c')).toBe(true);
    expect(mqttTopicMatches('a/xx/yy/c', 'a/+/c')).toBe(false);
  });

  it('# matches the remaining tail', () => {
    expect(mqttTopicMatches('a/b/c/d', 'a/#')).toBe(true);
    expect(mqttTopicMatches('a', 'a/#')).toBe(false);
  });

  it('vessels/self/ expands to the configured URN in both formats', () => {
    const pattern = 'vessels/self/navigation/#';
    expect(
      mqttTopicMatches(
        `vessels/${SELF_URN}/navigation/position`,
        pattern,
        SELF_URN
      )
    ).toBe(true);
    expect(
      mqttTopicMatches(
        `vessels/${SELF_URN_UNDERSCORE}/navigation/position`,
        pattern,
        SELF_URN
      )
    ).toBe(true);
  });

  it('vessels/self/ is treated literally when selfVesselUrn is unset', () => {
    // Expansion to vessels/+/ only happens when the plugin knows the self
    // URN; otherwise the pattern matches only a literal "vessels/self/..."
    // topic (matching the pre-refactor behaviour).
    expect(
      mqttTopicMatches(
        'vessels/urn:mrn:imo:mmsi:1/navigation/x',
        'vessels/self/navigation/#'
      )
    ).toBe(false);
    expect(
      mqttTopicMatches('vessels/self/navigation/x', 'vessels/self/navigation/#')
    ).toBe(true);
  });
});

describe('extractPlaceholdersFromTopic', () => {
  it('assigns ordinal placeholder names for + wildcards', () => {
    const pl = extractPlaceholdersFromTopic(
      'a/+/b/+/c/+',
      'a/alpha/b/beta/c/gamma'
    );
    expect(pl).toEqual({ device: 'alpha', location: 'beta', sensor: 'gamma' });
  });

  it('falls back to placeholderN beyond the named slots', () => {
    const pl = extractPlaceholdersFromTopic('+/+/+/+/+/+', 'a/b/c/d/e/f');
    expect(pl.placeholder5).toBe('f');
  });

  it('captures # as slash-joined remainder', () => {
    const pl = extractPlaceholdersFromTopic('zones/#', 'zones/upper/port/hole');
    expect(pl.device).toBe('upper/port/hole');
  });
});

describe('applyPlaceholders', () => {
  it('substitutes {name} occurrences globally', () => {
    const out = applyPlaceholders('sensors.{device}.{device}.ok', {
      device: 'x1',
    });
    expect(out).toBe('sensors.x1.x1.ok');
  });

  it('leaves unknown placeholders intact', () => {
    const out = applyPlaceholders('a.{missing}.b', { device: 'd' });
    expect(out).toBe('a.{missing}.b');
  });
});

describe('extractContextFromTopic', () => {
  it('maps the self URN (both formats) to vessels.self', () => {
    expect(
      extractContextFromTopic(
        `vessels/${SELF_URN_UNDERSCORE}/navigation/position`,
        '',
        SELF_URN
      )
    ).toBe('vessels.self');
    expect(
      extractContextFromTopic(
        `vessels/${SELF_URN}/navigation/position`,
        '',
        SELF_URN
      )
    ).toBe('vessels.self');
  });

  it('preserves non-self URNs, converting underscore → colon', () => {
    expect(
      extractContextFromTopic('vessels/urn_mrn_imo_mmsi_1/x/y', '', SELF_URN)
    ).toBe('vessels.urn:mrn:imo:mmsi:1');
    expect(
      extractContextFromTopic('vessels/urn:mrn:imo:mmsi:1/x/y', '', SELF_URN)
    ).toBe('vessels.urn:mrn:imo:mmsi:1');
  });

  it('strips a configured topicPrefix before extracting', () => {
    expect(
      extractContextFromTopic(
        `boat/vessels/${SELF_URN_UNDERSCORE}/nav/pos`,
        'boat',
        SELF_URN
      )
    ).toBe('vessels.self');
  });

  it('falls back to vessels.self for non-vessels topics', () => {
    expect(extractContextFromTopic('zigbee2mqtt/x', '', null)).toBe(
      'vessels.self'
    );
  });
});

describe('extractPathFromTopic', () => {
  it('drops vessels/<id> and joins the rest with dots', () => {
    expect(extractPathFromTopic('vessels/self/navigation/position', '')).toBe(
      'navigation.position'
    );
  });

  it('respects the topicPrefix', () => {
    expect(extractPathFromTopic('boat/vessels/self/nav/pos', 'boat')).toBe(
      'nav.pos'
    );
  });

  it('falls back to the full topic when not a vessels/ topic', () => {
    expect(extractPathFromTopic('zigbee2mqtt/x', '')).toBe('zigbee2mqtt.x');
  });
});
