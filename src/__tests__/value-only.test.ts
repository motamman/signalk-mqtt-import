import { describe, expect, it } from 'vitest';
import { parseValueOnlyMessage } from '../parsers';
import { makeRule, mockContext } from './helpers';

describe('parseValueOnlyMessage', () => {
  it('parses a JSON number payload', () => {
    const rule = makeRule({
      signalKContext: 'vessels.self',
      signalKPath: 'environment.depth',
    });
    const delta = parseValueOnlyMessage(
      '42.5',
      rule,
      'any/topic',
      mockContext()
    );

    expect(delta).not.toBeNull();
    expect(delta!.context).toBe('vessels.self');
    const update = delta!.updates[0] as any;
    expect(update.values[0].path).toBe('environment.depth');
    expect(update.values[0].value).toBe(42.5);
    expect(update.$source).toBe('mqtt-import');
  });

  it('parses a JSON string payload', () => {
    const rule = makeRule({
      signalKContext: 'vessels.self',
      signalKPath: 'design.name',
    });
    const delta = parseValueOnlyMessage(
      '"Lodestar"',
      rule,
      't/x',
      mockContext()
    );

    const update = delta!.updates[0] as any;
    expect(update.values[0].value).toBe('Lodestar');
  });

  it('coerces a non-JSON numeric string to Number', () => {
    const rule = makeRule({
      signalKContext: 'vessels.self',
      signalKPath: 'environment.temperature',
    });
    const delta = parseValueOnlyMessage('7', rule, 't/x', mockContext());
    const update = delta!.updates[0] as any;
    expect(update.values[0].value).toBe(7);
    expect(typeof update.values[0].value).toBe('number');
  });

  it('keeps a non-JSON non-numeric string as a string', () => {
    const rule = makeRule({
      signalKContext: 'vessels.self',
      signalKPath: 'environment.mode',
    });
    const delta = parseValueOnlyMessage('abc', rule, 't/x', mockContext());
    const update = delta!.updates[0] as any;
    expect(update.values[0].value).toBe('abc');
  });

  it('derives path from topic when rule.signalKPath is empty', () => {
    const rule = makeRule({ signalKContext: 'vessels.self' });
    const delta = parseValueOnlyMessage(
      '1',
      rule,
      'vessels/self/navigation/position',
      mockContext({ selfVesselUrn: null })
    );
    const update = delta!.updates[0] as any;
    expect(update.values[0].path).toBe('navigation.position');
  });

  it('defaults $source to mqtt-import when sourceLabel is empty', () => {
    const rule = makeRule({ signalKContext: 'vessels.self', signalKPath: 'x' });
    const delta = parseValueOnlyMessage('1', rule, 't/x', mockContext());
    expect((delta!.updates[0] as any).$source).toBe('mqtt-import');
  });

  it('honours a custom sourceLabel', () => {
    const rule = makeRule({
      signalKContext: 'vessels.self',
      signalKPath: 'x',
      sourceLabel: 'zigbee',
    });
    const delta = parseValueOnlyMessage('1', rule, 't/x', mockContext());
    expect((delta!.updates[0] as any).$source).toBe('zigbee');
  });
});
