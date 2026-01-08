import { Request, Response } from 'express';
import { MqttClient } from 'mqtt';
import {
  ServerAPI,
  Plugin,
  Delta,
  Update,
  PathValue,
  Context,
  Path,
  Timestamp,
} from '@signalk/server-api';

// Re-export SignalK types for convenience
export type SignalKApp = ServerAPI;
export type SignalKDelta = Delta;
export type SignalKUpdate = Update;
export type SignalKValue = PathValue;
export type SignalKContext = Context;
export type SignalKPath = Path;
export type SignalKTimestamp = Timestamp;

// Extended Plugin interface for our needs
export interface SignalKPlugin extends Plugin {
  config?: MQTTImportConfig;
}

// Plugin Configuration
export interface MQTTImportConfig {
  enabled: boolean;
  mqttBroker: string;
  mqttClientId: string;
  mqttUsername: string;
  mqttPassword: string;
  topicPrefix: string;
}

// Import Rule Configuration
export interface ImportRule {
  id: string;
  name: string;
  mqttTopic: string;
  signalKContext: string;
  signalKPath: string;
  sourceLabel: string;
  enabled: boolean;
  payloadFormat: 'full' | 'value-only' | 'json-object' | 'custom-mapping';
  ignoreDuplicates: boolean;
  excludeMMSI?: string;
  customMappingId?: string; // Reference to PayloadMapping when payloadFormat is 'custom-mapping'
  transformValue?: (value: any) => any;
}

// SignalK Data Structures
// SignalK types are now imported from @signalk/server-api

// MQTT Related Types
export interface MQTTConnectionStatus {
  connected: boolean;
  broker: string;
  clientId: string;
}

export interface MQTTMessage {
  topic: string;
  payload: string;
  timestamp: string;
}

// API Response Types
export interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

export interface RulesApiResponse extends ApiResponse {
  rules?: ImportRule[];
  mqttConnected?: boolean;
}

export interface MQTTStatusApiResponse extends ApiResponse {
  connected?: boolean;
  broker?: string;
  clientId?: string;
}

export interface StatsApiResponse extends ApiResponse {
  stats?: {
    totalRules: number;
    enabledRules: number;
    messagesReceived: number;
    mqttConnected: boolean;
  };
}

// Express Router Types
export interface TypedRequest<T = any> extends Request {
  body: T;
  params: { [key: string]: string };
  query: { [key: string]: string };
}

export interface TypedResponse<T = any> extends Response {
  json: (body: T) => this;
  status: (code: number) => this;
}

// Internal Plugin State
export interface PluginState {
  mqttClient: MqttClient | null;
  importRules: ImportRule[];
  payloadMappings: PayloadMapping[];
  lastReceivedMessages: Map<string, number>;
  selfVesselUrn: string | null;
  rulesFilePath: string | null;
  mappingsFilePath: string | null;
  currentConfig?: MQTTImportConfig;
}

// MQTT Client Options
export interface MQTTClientOptions {
  clientId: string;
  clean: boolean;
  reconnectPeriod: number;
  keepalive: number;
  username?: string;
  password?: string;
}

// Topic Processing Types
export interface TopicParseResult {
  context: string;
  path: string;
  vesselId?: string;
  mmsi?: string;
}

export interface MessageProcessingResult {
  signalKData: SignalKDelta | null;
  processed: boolean;
  error?: string;
}

// Rule Processing Types
export interface RuleMatchResult {
  rule: ImportRule | null;
  matches: boolean;
  excluded: boolean;
  reason?: string;
}

// Utility Types
export type PayloadFormat = 'full' | 'value-only' | 'json-object' | 'custom-mapping';
export type MessageKey = string; // Format: "topic:message"

// Error Types
export interface PluginError extends Error {
  code?: string;
  details?: any;
}

// Vessel URN Types
export interface VesselUrn {
  full: string; // urn:mrn:imo:mmsi:368396230
  mqtt: string; // urn_mrn_imo_mmsi_368396230
  mmsi: string; // 368396230
  isSelf: boolean;
}

// Rule Request Types
export interface RuleUpdateRequest {
  rules: ImportRule[];
}

// Statistics Types
export interface ImportStats {
  totalRules: number;
  enabledRules: number;
  messagesReceived: number;
  mqttConnected: boolean;
  topicsSubscribed: number;
  lastMessageTime?: string;
}

// Default Rule Types
export interface DefaultRuleConfig {
  id: string;
  name: string;
  mqttTopic: string;
  enabled: boolean;
  payloadFormat: PayloadFormat;
  ignoreDuplicates: boolean;
}

// Message Deduplication Types
export interface MessageCache {
  key: string;
  timestamp: number;
  count: number;
}

// Topic Subscription Types
export interface TopicSubscription {
  topic: string;
  qos: number;
  ruleIds: string[];
}

// Context Extraction Types
export interface ContextExtractionResult {
  context: string;
  path: string;
  vesselId: string;
  isSelfVessel: boolean;
}

// MMSI Exclusion Types
export interface MMSIExclusionResult {
  excluded: boolean;
  mmsi: string | null;
  reason?: string;
}

// Rule Validation Types
export interface RuleValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

// Storage Types
export interface PersistentStorage {
  filePath: string;
  lastModified: number;
  rules: ImportRule[];
}

// ============================================
// Custom Payload Mapping Types
// ============================================

// Value transformation configuration
export interface ValueTransform {
  type: 'none' | 'boolean-map' | 'math' | 'unit' | 'expression';
  config: {
    // For boolean-map
    trueValue?: any;
    falseValue?: any;
    // For math operations
    operation?: 'multiply' | 'divide' | 'add' | 'subtract';
    operand?: number;
    // For unit conversions
    fromUnit?: string;
    toUnit?: string;
    // For custom expressions (advanced)
    expression?: string;
  };
}

// Individual field mapping within a payload
export interface FieldMapping {
  sourceKey: string; // JSON key from payload, e.g., "contact"
  signalKPath: string; // Full path with optional placeholders, e.g., "notifications.security.{device}.status"
  transform: ValueTransform;
  enabled: boolean;
}

// Complete payload mapping configuration
export interface PayloadMapping {
  id: string;
  name: string;
  description?: string;
  topicPattern: string; // MQTT topic pattern, e.g., "zigbee2mqtt/+"
  signalKContext: string; // e.g., "vessels.self"
  fieldMappings: FieldMapping[];
  enabled: boolean;
  createdAt?: string;
  updatedAt?: string;
}

// Placeholder extraction result
export interface PlaceholderValues {
  [key: string]: string; // e.g., { device: "StateRoomPortHole", location: "stateroom" }
}

// Mapping storage types
export interface MappingsStorage {
  mappings: PayloadMapping[];
  version: string;
  lastModified: string;
}

// API types for mappings
export interface MappingsApiResponse extends ApiResponse {
  mappings?: PayloadMapping[];
}

export interface ParsePayloadRequest {
  payload: string; // JSON string
  topic: string;
}

export interface ParsePayloadResponse extends ApiResponse {
  fields?: Array<{
    key: string;
    value: any;
    type: string;
    suggestedPath?: string;
  }>;
}

export interface TestMappingRequest {
  payload: string;
  topic: string;
  mapping: PayloadMapping;
}

export interface TestMappingResponse extends ApiResponse {
  results?: Array<{
    sourceKey: string;
    originalValue: any;
    transformedValue: any;
    signalKPath: string;
  }>;
  delta?: SignalKDelta;
}

// YAML export/import types
export interface YamlExportData {
  version: string;
  exportedAt: string;
  rules: ImportRule[];
  mappings: PayloadMapping[];
}

export interface YamlImportRequest {
  yamlContent: string;
}

export interface YamlImportResponse extends ApiResponse {
  rulesImported?: number;
  mappingsImported?: number;
  warnings?: string[];
}
