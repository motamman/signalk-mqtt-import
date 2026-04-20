import { describe, expect, it } from 'vitest';
import { parseJsonObjectMessage } from '../parsers';
import { makeRule, mockContext } from './helpers';

describe('parseJsonObjectMessage', () => {
  it('expands each key into its own value entry', () => {
    const rule = makeRule({
      signalKContext: 'vessels.self',
      signalKPath: 'environment',
    });
    const delta = parseJsonObjectMessage(
      JSON.stringify({ temperature: 293, humidity: 0.5 }),
      rule,
      't/x',
      mockContext()
    );

    const update = delta!.updates[0] as any;
    expect(update.values).toHaveLength(2);
    const byPath = Object.fromEntries(
      update.values.map((v: any) => [v.path, v.value])
    );
    expect(byPath['environment.temperature']).toBe(293);
    expect(byPath['environment.humidity']).toBe(0.5);
  });

  it('rejects arrays', () => {
    const ctx = mockContext();
    const rule = makeRule({ signalKContext: 'vessels.self', signalKPath: 'x' });
    const delta = parseJsonObjectMessage('[1,2]', rule, 't/x', ctx);
    expect(delta).toBeNull();
    expect(ctx.debug).toHaveBeenCalled();
  });

  it('rejects primitive payloads', () => {
    const ctx = mockContext();
    const rule = makeRule({ signalKContext: 'vessels.self', signalKPath: 'x' });
    expect(parseJsonObjectMessage('42', rule, 't/x', ctx)).toBeNull();
  });

  it('derives basePath from topic when rule.signalKPath is empty', () => {
    const rule = makeRule({ signalKContext: 'vessels.self' });
    const delta = parseJsonObjectMessage(
      JSON.stringify({ a: 1 }),
      rule,
      'vessels/self/environment',
      mockContext()
    );
    const update = delta!.updates[0] as any;
    expect(update.values[0].path).toBe('environment.a');
  });

  it('preserves null field values', () => {
    const rule = makeRule({ signalKContext: 'vessels.self', signalKPath: 'x' });
    const delta = parseJsonObjectMessage(
      JSON.stringify({ gone: null }),
      rule,
      't/x',
      mockContext()
    );
    const update = delta!.updates[0] as any;
    expect(update.values[0].value).toBeNull();
  });
});
