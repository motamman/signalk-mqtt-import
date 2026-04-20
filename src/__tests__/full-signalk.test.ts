import { describe, expect, it } from 'vitest';
import { parseFullSignalKMessage } from '../parsers';
import { makeRule, mockContext } from './helpers';

describe('parseFullSignalKMessage', () => {
  it('passes a complete delta through unchanged', () => {
    const rule = makeRule();
    const incoming = {
      context: 'vessels.urn:mrn:imo:mmsi:1234',
      updates: [
        {
          $source: 'upstream',
          timestamp: '2026-01-01T00:00:00Z',
          values: [{ path: 'navigation.speedOverGround', value: 5 }],
        },
      ],
    };

    const delta = parseFullSignalKMessage(
      JSON.stringify(incoming),
      rule,
      'vessels/urn:mrn:imo:mmsi:1234/navigation/speedOverGround',
      mockContext()
    );

    expect(delta).toEqual(incoming);
  });

  it('wraps arbitrary JSON into a constructed delta', () => {
    const rule = makeRule({
      signalKContext: 'vessels.self',
      signalKPath: 'environment.wind',
    });
    const delta = parseFullSignalKMessage(
      JSON.stringify({ speed: 10 }),
      rule,
      't/x',
      mockContext()
    );

    expect(delta!.context).toBe('vessels.self');
    const update = delta!.updates[0] as any;
    expect(update.values[0].path).toBe('environment.wind');
    expect(update.values[0].value).toEqual({ speed: 10 });
  });

  it('returns null on malformed JSON', () => {
    const ctx = mockContext();
    const rule = makeRule();
    expect(parseFullSignalKMessage('not json', rule, 't/x', ctx)).toBeNull();
    expect(ctx.debug).toHaveBeenCalled();
  });
});
