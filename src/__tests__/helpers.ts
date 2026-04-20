import { readFileSync } from 'fs';
import { join } from 'path';
import { vi } from 'vitest';
import { ImportRule, PayloadMapping, UnitDefinitions } from '../types';
import { ParseContext } from '../parsers';

const fixturePath = join(__dirname, 'fixtures', 'unit-definitions.json');

let cachedUnitDefinitions: UnitDefinitions | null = null;
export function loadUnitDefinitionsFixture(): UnitDefinitions {
  if (!cachedUnitDefinitions) {
    cachedUnitDefinitions = JSON.parse(
      readFileSync(fixturePath, 'utf8')
    ) as UnitDefinitions;
  }
  return cachedUnitDefinitions;
}

export interface MockContext extends ParseContext {
  debugLog: string[];
  debug: ParseContext['debug'] & { mock: { calls: unknown[][] } };
}

export function mockContext(
  overrides: Partial<ParseContext> = {}
): MockContext {
  const debugLog: string[] = [];
  const debug = vi.fn((msg: string) => {
    debugLog.push(msg);
  }) as unknown as MockContext['debug'];
  return {
    debug,
    debugLog,
    selfVesselUrn: overrides.selfVesselUrn ?? null,
    topicPrefix: overrides.topicPrefix ?? '',
    unitDefinitions: overrides.unitDefinitions ?? null,
    getMappingById:
      overrides.getMappingById ??
      (() => undefined as PayloadMapping | undefined),
  };
}

export function makeRule(overrides: Partial<ImportRule> = {}): ImportRule {
  return {
    id: overrides.id ?? 'test-rule',
    name: overrides.name ?? 'Test Rule',
    mqttTopic: overrides.mqttTopic ?? 'test/topic',
    signalKContext: overrides.signalKContext ?? '',
    signalKPath: overrides.signalKPath ?? '',
    sourceLabel: overrides.sourceLabel ?? '',
    enabled: overrides.enabled ?? true,
    payloadFormat: overrides.payloadFormat ?? 'value-only',
    ignoreDuplicates: overrides.ignoreDuplicates ?? false,
    excludeMMSI: overrides.excludeMMSI,
    customMappingId: overrides.customMappingId,
    transformValue: overrides.transformValue,
  };
}

export function makeMapping(
  overrides: Partial<PayloadMapping> = {}
): PayloadMapping {
  return {
    id: overrides.id ?? 'test-mapping',
    name: overrides.name ?? 'Test Mapping',
    topicPattern: overrides.topicPattern ?? 'test/+',
    signalKContext: overrides.signalKContext ?? 'vessels.self',
    fieldMappings: overrides.fieldMappings ?? [],
    enabled: overrides.enabled ?? true,
  };
}
