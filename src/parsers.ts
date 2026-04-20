import { evaluate } from 'mathjs';
import {
  ImportRule,
  PayloadMapping,
  PlaceholderValues,
  SignalKDelta,
  UnitDefinitions,
  ValueTransform,
} from './types';

export type DebugFn = (msg: string) => void;

export interface ParseContext {
  debug: DebugFn;
  selfVesselUrn: string | null;
  topicPrefix: string;
  unitDefinitions: UnitDefinitions | null;
  getMappingById: (id: string) => PayloadMapping | undefined;
}

export type TransformContext = Pick<ParseContext, 'debug' | 'unitDefinitions'>;

const PLACEHOLDER_NAMES = ['device', 'location', 'sensor', 'type', 'id'];

// ============================================
// URN + MMSI helpers
// ============================================

export function urnToMqttFormat(urn: string): string {
  if (!urn) return '';
  return urn.replace(/:/g, '_');
}

export function mqttFormatToUrn(mqttFormat: string): string {
  if (!mqttFormat) return '';
  return mqttFormat.replace(/_/g, ':');
}

export function extractMMSIFromUrn(urn: string): string | null {
  if (!urn) return null;
  const match = urn.match(/urn[_:]+mrn[_:]+imo[_:]+mmsi[_:]+([0-9]+)/);
  return match ? match[1] : null;
}

export function parseMMSIExclusionList(excludeMMSI: string): string[] {
  if (!excludeMMSI || typeof excludeMMSI !== 'string') return [];
  return excludeMMSI
    .split(',')
    .map(mmsi => mmsi.trim())
    .filter(mmsi => mmsi.length > 0);
}

// ============================================
// Topic matching
// ============================================

export function mqttTopicMatches(
  topic: string,
  pattern: string,
  selfVesselUrn?: string | null
): boolean {
  if (pattern.includes('vessels/self/') && selfVesselUrn) {
    const urnPattern = pattern.replace(
      'vessels/self/',
      `vessels/${selfVesselUrn}/`
    );
    const underscoreUrn = urnToMqttFormat(selfVesselUrn);
    const underscorePattern = pattern.replace(
      'vessels/self/',
      `vessels/${underscoreUrn}/`
    );

    return (
      mqttTopicMatches(
        topic,
        pattern.replace('vessels/self/', 'vessels/+/')
      ) ||
      mqttTopicMatches(topic, urnPattern) ||
      (underscoreUrn ? mqttTopicMatches(topic, underscorePattern) : false)
    );
  }

  const regexPattern = pattern
    .replace(/\+/g, '[^/]+')
    .replace(/#$/, '.*')
    .replace(/#\//, '.*/');

  const colonPattern = pattern.replace(
    /urn_mrn_imo_mmsi_/g,
    'urn:mrn:imo:mmsi:'
  );
  let colonRegexPattern = '';
  if (colonPattern !== pattern) {
    colonRegexPattern = colonPattern
      .replace(/\+/g, '[^/]+')
      .replace(/#$/, '.*')
      .replace(/#\//, '.*/');
  }

  const regex = new RegExp(`^${regexPattern}$`);
  const colonRegex = colonRegexPattern
    ? new RegExp(`^${colonRegexPattern}$`)
    : null;

  return regex.test(topic) || (colonRegex ? colonRegex.test(topic) : false);
}

export function isMMSIExcluded(
  topic: string,
  rule: ImportRule,
  debug: DebugFn = () => {}
): boolean {
  const exclusionList = parseMMSIExclusionList(rule.excludeMMSI || '');
  if (exclusionList.length === 0) return false;

  const parts = topic.split('/');
  if (parts.length < 2 || parts[0] !== 'vessels') return false;

  const mmsi = extractMMSIFromUrn(parts[1]);
  if (!mmsi) return false;

  const excluded = exclusionList.includes(mmsi);
  if (excluded) {
    debug(`MMSI ${mmsi} excluded by rule "${rule.name}" for topic: ${topic}`);
  }
  return excluded;
}

// ============================================
// Context / path extraction
// ============================================

function stripPrefix(topic: string, topicPrefix: string): string {
  if (!topicPrefix) return topic;
  return topic.replace(`${topicPrefix}/`, '');
}

export function extractContextFromTopic(
  topic: string,
  topicPrefix: string,
  selfVesselUrn: string | null
): string {
  const cleanTopic = stripPrefix(topic, topicPrefix);
  const parts = cleanTopic.split('/');

  if (parts[0] === 'vessels' && parts.length > 2) {
    const vesselId = parts[1];

    if (
      selfVesselUrn &&
      (urnToMqttFormat(selfVesselUrn) === vesselId ||
        selfVesselUrn === vesselId)
    ) {
      return 'vessels.self';
    }

    if (vesselId.startsWith('urn_')) {
      return `vessels.${mqttFormatToUrn(vesselId)}`;
    } else if (vesselId.startsWith('urn:')) {
      return `vessels.${vesselId}`;
    }

    return `vessels.${vesselId}`;
  }

  return 'vessels.self';
}

export function extractPathFromTopic(
  topic: string,
  topicPrefix: string
): string {
  const cleanTopic = stripPrefix(topic, topicPrefix);
  const parts = cleanTopic.split('/');

  if (parts[0] === 'vessels' && parts.length > 2) {
    return parts.slice(2).join('.');
  }

  return cleanTopic.replace(/\//g, '.');
}

// ============================================
// Placeholders
// ============================================

export function extractPlaceholdersFromTopic(
  topicPattern: string,
  actualTopic: string
): PlaceholderValues {
  const placeholders: PlaceholderValues = {};
  const patternParts = topicPattern.split('/');
  const topicParts = actualTopic.split('/');

  let placeholderIndex = 0;

  for (let i = 0; i < patternParts.length && i < topicParts.length; i++) {
    if (patternParts[i] === '+') {
      const name =
        PLACEHOLDER_NAMES[placeholderIndex] ||
        `placeholder${placeholderIndex}`;
      placeholders[name] = topicParts[i];
      placeholderIndex++;
    } else if (patternParts[i] === '#') {
      const remaining = topicParts.slice(i).join('/');
      const name =
        PLACEHOLDER_NAMES[placeholderIndex] ||
        `placeholder${placeholderIndex}`;
      placeholders[name] = remaining;
      break;
    }
  }

  return placeholders;
}

export function applyPlaceholders(
  pathTemplate: string,
  placeholders: PlaceholderValues
): string {
  let result = pathTemplate;
  for (const [key, value] of Object.entries(placeholders)) {
    result = result.replace(new RegExp(`\\{${key}\\}`, 'g'), value);
  }
  return result;
}

// ============================================
// Value transforms
// ============================================

export function applyTransform(
  value: any,
  transform: ValueTransform,
  ctx: TransformContext
): any {
  // 'unitless' is handled at the delta-assembly layer so it can emit
  // meta alongside values; the value itself is unchanged, same as 'none'.
  if (!transform || transform.type === 'none' || transform.type === 'unitless') {
    return value;
  }

  const config = transform.config || {};
  const { debug, unitDefinitions } = ctx;

  switch (transform.type) {
    case 'boolean-map':
      if (typeof value === 'boolean') {
        return value ? config.trueValue : config.falseValue;
      }
      return value ? config.trueValue : config.falseValue;

    case 'math': {
      const numValue = Number(value);
      if (isNaN(numValue)) {
        debug(`Cannot apply math transform to non-numeric value: ${value}`);
        return value;
      }
      const operand = config.operand || 0;
      switch (config.operation) {
        case 'multiply':
          return numValue * operand;
        case 'divide':
          return operand !== 0 ? numValue / operand : numValue;
        case 'add':
          return numValue + operand;
        case 'subtract':
          return numValue - operand;
        default:
          return numValue;
      }
    }

    case 'unit': {
      const baseUnit = config.baseUnit || config.toUnit;
      const fromUnit = config.fromUnit;
      if (!unitDefinitions || !baseUnit || !fromUnit) return value;

      const conversion =
        unitDefinitions[baseUnit]?.conversions?.[fromUnit];
      if (!conversion?.inverseFormula) {
        debug(
          `No unit conversion found for ${fromUnit} -> ${baseUnit}`
        );
        return value;
      }

      const num = Number(value);
      if (isNaN(num)) {
        debug(
          `Cannot apply unit transform to non-numeric value: ${value}`
        );
        return value;
      }

      try {
        return evaluate(conversion.inverseFormula, { value: num });
      } catch (error) {
        debug(
          `Unit conversion ${fromUnit} -> ${baseUnit} failed: ${(error as Error).message}`
        );
        return value;
      }
    }

    case 'expression':
      if (config.expression) {
        try {
          return evaluate(config.expression, { value });
        } catch (error) {
          debug(`Error evaluating expression: ${(error as Error).message}`);
          return value;
        }
      }
      return value;

    default:
      return value;
  }
}

// ============================================
// Payload parsers
// ============================================

export function parseValueOnlyMessage(
  messageStr: string,
  rule: ImportRule,
  topic: string,
  ctx: ParseContext
): SignalKDelta | null {
  try {
    let value: any;
    try {
      value = JSON.parse(messageStr);
    } catch {
      value = isNaN(Number(messageStr)) ? messageStr : Number(messageStr);
    }

    const context =
      rule.signalKContext ||
      extractContextFromTopic(topic, ctx.topicPrefix, ctx.selfVesselUrn);
    const path =
      rule.signalKPath || extractPathFromTopic(topic, ctx.topicPrefix);

    return {
      context: context as any,
      updates: [
        {
          $source: rule.sourceLabel || 'mqtt-import',
          timestamp: new Date().toISOString() as any,
          values: [
            {
              path: path as any,
              value: value,
            },
          ],
        } as any,
      ],
    };
  } catch (error) {
    ctx.debug(
      `Error parsing value-only message: ${(error as Error).message}`
    );
    return null;
  }
}

export function parseJsonObjectMessage(
  messageStr: string,
  rule: ImportRule,
  topic: string,
  ctx: ParseContext
): SignalKDelta | null {
  try {
    const jsonObject = JSON.parse(messageStr);

    if (
      typeof jsonObject !== 'object' ||
      jsonObject === null ||
      Array.isArray(jsonObject)
    ) {
      ctx.debug('JSON object format requires a valid JSON object');
      return null;
    }

    const context =
      rule.signalKContext ||
      extractContextFromTopic(topic, ctx.topicPrefix, ctx.selfVesselUrn);
    const basePath =
      rule.signalKPath || extractPathFromTopic(topic, ctx.topicPrefix);

    const values = Object.entries(jsonObject).map(([key, value]) => ({
      path: `${basePath}.${key}` as any,
      value: value as any,
    }));

    return {
      context: context as any,
      updates: [
        {
          $source: rule.sourceLabel || 'mqtt-import',
          timestamp: new Date().toISOString() as any,
          values: values,
        } as any,
      ],
    };
  } catch (error) {
    ctx.debug(
      `Error parsing JSON object message: ${(error as Error).message}`
    );
    return null;
  }
}

export function parseFullSignalKMessage(
  messageStr: string,
  rule: ImportRule,
  topic: string,
  ctx: ParseContext
): SignalKDelta | null {
  try {
    const parsed = JSON.parse(messageStr);

    if (parsed.context && parsed.updates) {
      return parsed as SignalKDelta;
    }

    const context =
      rule.signalKContext ||
      parsed.context ||
      extractContextFromTopic(topic, ctx.topicPrefix, ctx.selfVesselUrn);
    const path =
      rule.signalKPath || extractPathFromTopic(topic, ctx.topicPrefix);

    return {
      context: context as any,
      updates: [
        {
          $source: rule.sourceLabel || 'mqtt-import',
          timestamp: new Date().toISOString() as any,
          values: [
            {
              path: path as any,
              value: parsed,
            },
          ],
        } as any,
      ],
    };
  } catch (error) {
    ctx.debug(
      `Error parsing full SignalK message: ${(error as Error).message}`
    );
    return null;
  }
}

export function parseCustomMappingMessage(
  messageStr: string,
  rule: ImportRule,
  topic: string,
  ctx: ParseContext
): SignalKDelta | null {
  if (!rule.customMappingId) {
    ctx.debug('Custom mapping rule missing customMappingId');
    return null;
  }

  const mapping = ctx.getMappingById(rule.customMappingId);
  if (!mapping) {
    ctx.debug(`Mapping not found: ${rule.customMappingId}`);
    return null;
  }

  try {
    const jsonObject = JSON.parse(messageStr);

    if (
      typeof jsonObject !== 'object' ||
      jsonObject === null ||
      Array.isArray(jsonObject)
    ) {
      ctx.debug('Custom mapping format requires a valid JSON object');
      return null;
    }

    const placeholders = extractPlaceholdersFromTopic(
      mapping.topicPattern,
      topic
    );

    const values: Array<{ path: any; value: any }> = [];
    // Meta entries derived from per-field unit transforms. The SignalK
    // server accepts `updates[].meta: [{ path, value: { units, ... } }]`
    // and registers it against the path's metadata node — see
    // signalk-server src/put.ts:243–255 and docs/guides/unitpreferences.md.
    const meta: Array<{ path: any; value: { units: string } }> = [];

    for (const fieldMapping of mapping.fieldMappings) {
      if (!fieldMapping.enabled) continue;

      const sourceValue = jsonObject[fieldMapping.sourceKey];
      if (sourceValue === undefined) continue;

      const transformedValue = applyTransform(
        sourceValue,
        fieldMapping.transform,
        { debug: ctx.debug, unitDefinitions: ctx.unitDefinitions }
      );

      const finalPath = applyPlaceholders(
        fieldMapping.signalKPath,
        placeholders
      );

      values.push({
        path: finalPath as any,
        value: transformedValue,
      });

      // Attach path metadata:
      // - 'unit' transform emits the target SI base as `units` so
      //   dashboards and the server's unit-preferences layer know how
      //   to interpret the value.
      // - 'unitless' emits `units: ""`, explicitly marking the path as
      //   known-but-unitless (distinct from 'none' which emits nothing
      //   at all).
      if (fieldMapping.transform?.type === 'unit') {
        const baseUnit =
          fieldMapping.transform.config?.baseUnit ||
          fieldMapping.transform.config?.toUnit;
        if (baseUnit) {
          meta.push({
            path: finalPath as any,
            value: { units: baseUnit },
          });
        }
      } else if (fieldMapping.transform?.type === 'unitless') {
        meta.push({
          path: finalPath as any,
          value: { units: '' },
        });
      }
    }

    if (values.length === 0) {
      ctx.debug('No values extracted from custom mapping');
      return null;
    }

    const context =
      mapping.signalKContext || rule.signalKContext || 'vessels.self';
    const sourceLabel = rule.sourceLabel || 'mqtt-import-custom';

    const update: any = {
      $source: sourceLabel,
      timestamp: new Date().toISOString(),
      values,
    };
    if (meta.length > 0) update.meta = meta;

    return {
      context: context as any,
      updates: [update],
    };
  } catch (error) {
    ctx.debug(
      `Error parsing custom mapping message: ${(error as Error).message}`
    );
    return null;
  }
}
