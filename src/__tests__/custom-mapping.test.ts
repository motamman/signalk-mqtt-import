import { describe, expect, it } from 'vitest';
import { parseCustomMappingMessage } from '../parsers';
import { PayloadMapping } from '../types';
import {
  loadUnitDefinitionsFixture,
  makeMapping,
  makeRule,
  mockContext,
} from './helpers';

function zigbeeMapping(): PayloadMapping {
  return makeMapping({
    id: 'zigbee',
    topicPattern: 'zigbee2mqtt/+',
    signalKContext: 'vessels.self',
    fieldMappings: [
      {
        sourceKey: 'battery',
        signalKPath: 'sensors.{device}.battery',
        transform: { type: 'none', config: {} },
        enabled: true,
      },
      {
        sourceKey: 'contact',
        signalKPath: 'sensors.{device}.status',
        transform: {
          type: 'boolean-map',
          config: { trueValue: 'open', falseValue: 'closed' },
        },
        enabled: true,
      },
      {
        sourceKey: 'device_temperature',
        signalKPath: 'sensors.{device}.temperature',
        transform: {
          type: 'unit',
          config: { baseUnit: 'K', fromUnit: 'C' },
        },
        enabled: true,
      },
      {
        sourceKey: 'disabled_field',
        signalKPath: 'sensors.{device}.disabled',
        transform: { type: 'none', config: {} },
        enabled: false,
      },
    ],
  });
}

describe('parseCustomMappingMessage', () => {
  it('extracts device placeholder from + wildcard and applies it to paths', () => {
    const mapping = zigbeeMapping();
    const rule = makeRule({
      payloadFormat: 'custom-mapping',
      customMappingId: 'zigbee',
    });
    const ctx = mockContext({
      getMappingById: () => mapping,
      unitDefinitions: loadUnitDefinitionsFixture(),
    });

    const payload = JSON.stringify({
      battery: 87,
      contact: false,
      device_temperature: 25,
      disabled_field: 'should be ignored',
    });

    const delta = parseCustomMappingMessage(
      payload,
      rule,
      'zigbee2mqtt/StateRoomFoo',
      ctx
    );

    expect(delta!.context).toBe('vessels.self');
    const update = delta!.updates[0] as any;
    const byPath = Object.fromEntries(
      update.values.map((v: any) => [v.path, v.value])
    );

    expect(byPath['sensors.StateRoomFoo.battery']).toBe(87);
    expect(byPath['sensors.StateRoomFoo.status']).toBe('closed');
    expect(byPath['sensors.StateRoomFoo.temperature']).toBeCloseTo(298.15, 5);
    expect(byPath['sensors.StateRoomFoo.disabled']).toBeUndefined();
  });

  it('captures # multi-level wildcard as the remainder', () => {
    const mapping = makeMapping({
      id: 'multi',
      topicPattern: 'sensors/#',
      fieldMappings: [
        {
          sourceKey: 'v',
          signalKPath: 'captured.{device}',
          transform: { type: 'none', config: {} },
          enabled: true,
        },
      ],
    });
    const rule = makeRule({
      payloadFormat: 'custom-mapping',
      customMappingId: 'multi',
    });
    const ctx = mockContext({ getMappingById: () => mapping });

    const delta = parseCustomMappingMessage(
      JSON.stringify({ v: 1 }),
      rule,
      'sensors/zone1/left/port',
      ctx
    );

    const update = delta!.updates[0] as any;
    expect(update.values[0].path).toBe('captured.zone1/left/port');
  });

  it('returns null when customMappingId is missing', () => {
    const rule = makeRule({ payloadFormat: 'custom-mapping' });
    const ctx = mockContext();
    expect(parseCustomMappingMessage('{}', rule, 't/x', ctx)).toBeNull();
    expect(ctx.debug).toHaveBeenCalled();
  });

  it('returns null when mapping id does not resolve', () => {
    const rule = makeRule({
      payloadFormat: 'custom-mapping',
      customMappingId: 'nope',
    });
    const ctx = mockContext({ getMappingById: () => undefined });
    expect(parseCustomMappingMessage('{}', rule, 't/x', ctx)).toBeNull();
  });

  it('returns null when every field mapping is skipped', () => {
    const mapping = makeMapping({
      id: 'empty',
      topicPattern: 'x/+',
      fieldMappings: [
        {
          sourceKey: 'missing',
          signalKPath: 'a',
          transform: { type: 'none', config: {} },
          enabled: true,
        },
      ],
    });
    const rule = makeRule({
      payloadFormat: 'custom-mapping',
      customMappingId: 'empty',
    });
    const ctx = mockContext({ getMappingById: () => mapping });
    expect(
      parseCustomMappingMessage('{"other":1}', rule, 'x/one', ctx)
    ).toBeNull();
  });

  it('emits units metadata for fields with a unit transform', () => {
    const mapping = zigbeeMapping();
    const rule = makeRule({
      payloadFormat: 'custom-mapping',
      customMappingId: 'zigbee',
    });
    const ctx = mockContext({
      getMappingById: () => mapping,
      unitDefinitions: loadUnitDefinitionsFixture(),
    });

    const payload = JSON.stringify({
      battery: 87,
      contact: false,
      device_temperature: 25,
    });

    const delta = parseCustomMappingMessage(
      payload,
      rule,
      'zigbee2mqtt/FooDev',
      ctx
    );

    const update = delta!.updates[0] as any;
    expect(Array.isArray(update.meta)).toBe(true);
    // Only the unit-transformed field should produce a meta entry.
    expect(update.meta).toHaveLength(1);
    expect(update.meta[0]).toEqual({
      path: 'sensors.FooDev.temperature',
      value: { units: 'K' },
    });
  });

  it('honours legacy toUnit as the units source for meta', () => {
    const mapping = makeMapping({
      id: 'legacy',
      topicPattern: 't/+',
      fieldMappings: [
        {
          sourceKey: 'p',
          signalKPath: 'environment.pressure',
          transform: {
            type: 'unit',
            config: { fromUnit: 'hPa', toUnit: 'Pa' },
          },
          enabled: true,
        },
      ],
    });
    const rule = makeRule({
      payloadFormat: 'custom-mapping',
      customMappingId: 'legacy',
    });
    const ctx = mockContext({
      getMappingById: () => mapping,
      unitDefinitions: loadUnitDefinitionsFixture(),
    });

    const delta = parseCustomMappingMessage('{"p":1013}', rule, 't/one', ctx);

    const update = delta!.updates[0] as any;
    expect(update.meta[0].value.units).toBe('Pa');
  });

  it('emits meta with empty units for unitless-transformed fields', () => {
    const mapping = makeMapping({
      id: 'u',
      topicPattern: 't/+',
      fieldMappings: [
        {
          sourceKey: 'linkquality',
          signalKPath: 'sensors.x.linkquality',
          transform: { type: 'unitless', config: {} },
          enabled: true,
        },
      ],
    });
    const rule = makeRule({
      payloadFormat: 'custom-mapping',
      customMappingId: 'u',
    });
    const ctx = mockContext({ getMappingById: () => mapping });

    const delta = parseCustomMappingMessage(
      '{"linkquality":42}',
      rule,
      't/one',
      ctx
    );
    const update = delta!.updates[0] as any;
    // Value passes through unchanged.
    expect(update.values[0].value).toBe(42);
    // Meta tags the path as explicitly unitless.
    expect(update.meta).toHaveLength(1);
    expect(update.meta[0]).toEqual({
      path: 'sensors.x.linkquality',
      value: { units: '' },
    });
  });

  it('omits meta entirely when no field has a unit or unitless transform', () => {
    const mapping = makeMapping({
      id: 'plain',
      topicPattern: 'p/+',
      fieldMappings: [
        {
          sourceKey: 'v',
          signalKPath: 'env.v',
          transform: { type: 'none', config: {} },
          enabled: true,
        },
      ],
    });
    const rule = makeRule({
      payloadFormat: 'custom-mapping',
      customMappingId: 'plain',
    });
    const ctx = mockContext({ getMappingById: () => mapping });

    const delta = parseCustomMappingMessage('{"v":1}', rule, 'p/one', ctx);
    const update = delta!.updates[0] as any;
    expect(update.meta).toBeUndefined();
  });

  it('uses mqtt-import-custom as default $source and respects rule.sourceLabel', () => {
    const mapping = makeMapping({
      id: 'm',
      topicPattern: 't/+',
      fieldMappings: [
        {
          sourceKey: 'v',
          signalKPath: 'a',
          transform: { type: 'none', config: {} },
          enabled: true,
        },
      ],
    });
    const ruleDefault = makeRule({
      payloadFormat: 'custom-mapping',
      customMappingId: 'm',
    });
    const ctxDefault = mockContext({ getMappingById: () => mapping });
    const defaultDelta = parseCustomMappingMessage(
      '{"v":1}',
      ruleDefault,
      't/x',
      ctxDefault
    );
    expect((defaultDelta!.updates[0] as any).$source).toBe(
      'mqtt-import-custom'
    );

    const ruleLabeled = makeRule({
      payloadFormat: 'custom-mapping',
      customMappingId: 'm',
      sourceLabel: 'zigbee',
    });
    const ctxLabeled = mockContext({ getMappingById: () => mapping });
    const labeledDelta = parseCustomMappingMessage(
      '{"v":1}',
      ruleLabeled,
      't/x',
      ctxLabeled
    );
    expect((labeledDelta!.updates[0] as any).$source).toBe('zigbee');
  });
});
