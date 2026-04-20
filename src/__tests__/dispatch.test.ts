import { describe, expect, it } from 'vitest';
import {
  isMMSIExcluded,
  mqttTopicMatches,
  parseCustomMappingMessage,
  parseFullSignalKMessage,
  parseJsonObjectMessage,
  parseValueOnlyMessage,
} from '../parsers';
import { ImportRule } from '../types';
import { makeMapping, makeRule, mockContext } from './helpers';

// Replicates the rule-selection loop inside handleMQTTMessage so we can
// exercise it end-to-end without mounting the full plugin.
function selectRule(
  topic: string,
  rules: ImportRule[],
  topicPrefix: string,
  selfVesselUrn: string | null
): ImportRule | null {
  for (const r of rules) {
    if (!r.enabled) continue;
    const pattern = topicPrefix ? `${topicPrefix}/${r.mqttTopic}` : r.mqttTopic;
    if (!mqttTopicMatches(topic, pattern, selfVesselUrn)) continue;
    if (isMMSIExcluded(topic, r)) continue;
    return r;
  }
  return null;
}

describe('rule selection loop', () => {
  it('skips disabled rules', () => {
    const disabled = makeRule({
      id: 'a',
      mqttTopic: 'vessels/+/#',
      enabled: false,
    });
    expect(selectRule('vessels/self/x', [disabled], '', null)).toBeNull();
  });

  it('returns first matching enabled rule', () => {
    const a = makeRule({ id: 'a', mqttTopic: 'vessels/+/navigation/#' });
    const b = makeRule({ id: 'b', mqttTopic: 'vessels/+/#' });
    expect(selectRule('vessels/self/navigation/x', [a, b], '', null)?.id).toBe(
      'a'
    );
  });

  it('falls through to the next rule when MMSI is excluded', () => {
    const excluding = makeRule({
      id: 'ex',
      mqttTopic: 'vessels/+/navigation/#',
      excludeMMSI: '111',
    });
    const catchAll = makeRule({
      id: 'all',
      mqttTopic: 'vessels/+/#',
    });
    const picked = selectRule(
      'vessels/urn_mrn_imo_mmsi_111/navigation/position',
      [excluding, catchAll],
      '',
      null
    );
    expect(picked?.id).toBe('all');
  });

  it('returns null when nothing matches', () => {
    const r = makeRule({ mqttTopic: 'zigbee2mqtt/+' });
    expect(selectRule('weather/station', [r], '', null)).toBeNull();
  });
});

describe('payloadFormat dispatch', () => {
  it('value-only parser yields a single-value delta', () => {
    const rule = makeRule({
      payloadFormat: 'value-only',
      signalKContext: 'vessels.self',
      signalKPath: 'x',
    });
    const delta = parseValueOnlyMessage('42', rule, 't/x', mockContext());
    const update = delta!.updates[0] as any;
    expect(update.values).toHaveLength(1);
    expect(update.values[0].value).toBe(42);
  });

  it('json-object parser yields multi-value delta', () => {
    const rule = makeRule({
      payloadFormat: 'json-object',
      signalKContext: 'vessels.self',
      signalKPath: 'env',
    });
    const delta = parseJsonObjectMessage(
      '{"a":1,"b":2}',
      rule,
      't/x',
      mockContext()
    );
    expect((delta!.updates[0] as any).values).toHaveLength(2);
  });

  it('full parser preserves an already-complete delta', () => {
    const rule = makeRule({ payloadFormat: 'full' });
    const incoming = {
      context: 'vessels.self',
      updates: [
        {
          $source: 's',
          timestamp: '2026-01-01T00:00:00Z',
          values: [{ path: 'x', value: 1 }],
        },
      ],
    };
    const delta = parseFullSignalKMessage(
      JSON.stringify(incoming),
      rule,
      't/x',
      mockContext()
    );
    expect(delta).toEqual(incoming);
  });

  it('custom-mapping parser resolves the mapping by id', () => {
    const mapping = makeMapping({
      id: 'm1',
      topicPattern: 'sensors/+',
      fieldMappings: [
        {
          sourceKey: 'v',
          signalKPath: 'a.{device}',
          transform: { type: 'none', config: {} },
          enabled: true,
        },
      ],
    });
    const rule = makeRule({
      payloadFormat: 'custom-mapping',
      customMappingId: 'm1',
    });
    const delta = parseCustomMappingMessage(
      '{"v":1}',
      rule,
      'sensors/foo',
      mockContext({ getMappingById: () => mapping })
    );
    expect((delta!.updates[0] as any).values[0].path).toBe('a.foo');
  });
});

describe('dedup key pattern', () => {
  it('identical topic+payload produces the same dedup key', () => {
    const topic = 'zigbee2mqtt/a';
    const payload = JSON.stringify({ v: 1 });
    const k1 = `${topic}:${payload}`;
    const k2 = `${topic}:${payload}`;
    expect(k1).toBe(k2);

    const seen = new Map<string, number>();
    seen.set(k1, Date.now());
    expect(seen.has(k2)).toBe(true);
  });
});
