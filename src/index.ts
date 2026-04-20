import * as fs from 'fs-extra';
import * as path from 'path';
import * as http from 'http';
import * as https from 'https';
import { Router } from 'express';
import { connect } from 'mqtt';
import * as yaml from 'js-yaml';
import {
  SignalKApp,
  SignalKPlugin,
  MQTTImportConfig,
  ImportRule,
  SignalKDelta,
  PluginState,
  TypedRequest,
  TypedResponse,
  RulesApiResponse,
  MQTTStatusApiResponse,
  StatsApiResponse,
  ApiResponse,
  RuleUpdateRequest,
  MQTTClientOptions,
  PayloadMapping,
  ValueTransform,
  MappingsApiResponse,
  ParsePayloadRequest,
  ParsePayloadResponse,
  TestMappingRequest,
  TestMappingResponse,
  YamlExportData,
  YamlImportRequest,
  YamlImportResponse,
  UnitDefinitions,
} from './types';
import * as parsers from './parsers';

// Global plugin state

export = function (app: SignalKApp): SignalKPlugin {
  const plugin: SignalKPlugin = {
    id: 'signalk-mqtt-import',
    name: 'SignalK MQTT Import Manager',
    description:
      'Selectively import SignalK data from MQTT with webapp management interface',
    schema: {},
    start: () => {},
    stop: () => {},
    registerWithRouter: undefined,
  };

  // Plugin state
  const state: PluginState = {
    mqttClient: null,
    importRules: [],
    payloadMappings: [],
    lastReceivedMessages: new Map<string, number>(),
    selfVesselUrn: null,
    rulesFilePath: null,
    mappingsFilePath: null,
    currentConfig: undefined,
    unitDefinitions: null,
  };

  let unitPrefsListener: (() => void) | null = null;

  // Build a parser context snapshot. State is read at call time so
  // live changes to self-URN, topic prefix, mappings, and fetched unit
  // definitions are always reflected.
  function getParseContext(): parsers.ParseContext {
    return {
      debug: app.debug,
      selfVesselUrn: state.selfVesselUrn,
      topicPrefix: state.currentConfig?.topicPrefix || '',
      unitDefinitions: state.unitDefinitions,
      getMappingById: (id: string) =>
        state.payloadMappings.find(m => m.id === id),
    };
  }

  plugin.start = function (options: Partial<MQTTImportConfig>): void {
    app.debug('Starting SignalK MQTT Import Manager plugin');

    const config: MQTTImportConfig = {
      mqttBroker: options?.mqttBroker || 'mqtt://localhost:1883',
      mqttClientId: options?.mqttClientId || 'signalk-mqtt-import',
      mqttUsername: options?.mqttUsername || '',
      mqttPassword: options?.mqttPassword || '',
      topicPrefix: options?.topicPrefix || '',
      enabled: options?.enabled !== false,
    };

    state.currentConfig = config;
    plugin.config = config;

    // Load rules from persistent storage (or migrate from old config)
    const migratedRules = migrateOldConfiguration(options as any);
    state.importRules = migratedRules || loadRulesFromStorage();

    app.debug(
      `Loaded ${state.importRules.length} import rules from persistent storage`
    );

    // Load payload mappings from persistent storage
    state.payloadMappings = loadMappingsFromStorage();
    app.debug(
      `Loaded ${state.payloadMappings.length} payload mappings from persistent storage`
    );

    // Get self vessel URN for proper context mapping
    try {
      state.selfVesselUrn = app.selfId || app.getSelfPath('uuid');
      app.debug(`Self vessel URN: ${state.selfVesselUrn}`);
    } catch (error) {
      app.debug(
        `Warning: Could not get self vessel URN: ${(error as Error).message}`
      );
    }

    if (!config.enabled) {
      app.debug('MQTT Import plugin disabled');
      return;
    }

    // Fetch the server's unit-conversion definitions so the `unit`
    // transform can honour any custom units the admin has defined.
    loadUnitDefinitions();

    // Re-fetch when the server emits a unit-preferences change.
    const anyApp = app as any;
    if (typeof anyApp.on === 'function') {
      unitPrefsListener = () => loadUnitDefinitions();
      anyApp.on('unitpreferencesChanged', unitPrefsListener);
    }

    // Initialize MQTT client
    initializeMQTTClient(config);

    app.debug('SignalK MQTT Import Manager plugin started');
  };

  plugin.stop = function (): void {
    app.debug('Stopping SignalK MQTT Import Manager plugin');

    const anyApp = app as any;
    if (unitPrefsListener && typeof anyApp.off === 'function') {
      anyApp.off('unitpreferencesChanged', unitPrefsListener);
    }
    unitPrefsListener = null;

    // Disconnect MQTT client
    if (state.mqttClient) {
      state.mqttClient.end();
      state.mqttClient = null;
    }

    state.lastReceivedMessages.clear();
    app.debug('SignalK MQTT Import Manager plugin stopped');
  };

  // Fetch the server's unit-conversion definitions via self-HTTP.
  // This mirrors `getMergedDefinitions()` in signalk-server and includes
  // both built-in and any admin-added custom units.
  function loadUnitDefinitions(): void {
    const anyApp = app as any;
    const settings = anyApp?.config?.settings || {};
    const ssl = !!settings.ssl;
    const port =
      Number(process.env?.PORT) ||
      (ssl ? settings.sslport || 3443 : settings.port || 3000);
    const proto = ssl ? https : http;

    const req = proto.get(
      {
        host: '127.0.0.1',
        port,
        path: '/signalk/v1/unitpreferences/definitions',
        headers: { accept: 'application/json' },
        timeout: 5000,
      },
      res => {
        const chunks: Buffer[] = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => {
          if (res.statusCode !== 200) {
            app.debug(
              `Unit definitions fetch returned ${res.statusCode}; leaving cache empty`
            );
            return;
          }
          try {
            const body = Buffer.concat(chunks).toString('utf8');
            const parsed = JSON.parse(body) as UnitDefinitions;
            state.unitDefinitions = parsed;
            const baseCount = Object.keys(parsed).length;
            app.debug(
              `Loaded ${baseCount} SI unit base definitions from SignalK server`
            );
          } catch (error) {
            app.debug(
              `Failed to parse unit definitions: ${(error as Error).message}`
            );
          }
        });
      }
    );

    req.on('timeout', () => {
      req.destroy(new Error('timeout'));
    });
    req.on('error', (error: Error) => {
      app.debug(`Failed to fetch unit definitions: ${error.message}`);
    });
  }

  // Initialize MQTT client
  function initializeMQTTClient(config: MQTTImportConfig): void {
    try {
      const mqttOptions: MQTTClientOptions = {
        clientId: config.mqttClientId,
        clean: true,
        reconnectPeriod: 5000,
        keepalive: 60,
      };

      if (config.mqttUsername && config.mqttPassword) {
        mqttOptions.username = config.mqttUsername;
        mqttOptions.password = config.mqttPassword;
      }

      state.mqttClient = connect(config.mqttBroker, mqttOptions);

      state.mqttClient.on('connect', () => {
        app.debug(`✅ Connected to MQTT broker: ${config.mqttBroker}`);
        subscribeToMQTTTopics();
      });

      state.mqttClient.on('error', (error: Error) => {
        app.debug(`❌ MQTT client error: ${error.message}`);
      });

      state.mqttClient.on('close', () => {
        app.debug('🔌 MQTT client disconnected');
      });

      state.mqttClient.on('reconnect', () => {
        app.debug('🔄 MQTT client reconnecting...');
      });

      state.mqttClient.on('message', (topic: string, message: Buffer) => {
        handleMQTTMessage(topic, message);
      });
    } catch (error) {
      app.debug(
        `Failed to initialize MQTT client: ${(error as Error).message}`
      );
    }
  }

  // Subscribe to MQTT topics based on import rules
  function subscribeToMQTTTopics(): void {
    if (!state.mqttClient || !state.mqttClient.connected) {
      return;
    }

    // Get all unique topics from enabled import rules
    const topics = new Set<string>();
    state.importRules
      .filter(rule => rule.enabled)
      .forEach(rule => {
        let topic = rule.mqttTopic;

        // Add topic prefix if configured
        if (state.currentConfig?.topicPrefix) {
          topic = `${state.currentConfig.topicPrefix}/${topic}`;
        }

        // Handle vessels/self/* topics by converting to actual URN format
        if (topic.includes('vessels/self/') && state.selfVesselUrn) {
          // Convert vessels/self/* to actual URN format for MQTT subscription
          const urnTopic = topic.replace(
            'vessels/self/',
            `vessels/${state.selfVesselUrn}/`
          );
          topics.add(urnTopic);
          app.debug(`Converted vessels/self rule to URN topic: ${urnTopic}`);
          // Also add underscore format if URN contains colons
          if (state.selfVesselUrn.includes(':')) {
            const underscoreUrn = urnToMqttFormat(state.selfVesselUrn);
            const underscoreTopic = topic.replace(
              'vessels/self/',
              `vessels/${underscoreUrn}/`
            );
            topics.add(underscoreTopic);
            app.debug(`Also added underscore format: ${underscoreTopic}`);
          }
        } else {
          // Add both underscore and colon formats for URN topics
          topics.add(topic);
          if (topic.includes('urn_mrn_imo_mmsi_')) {
            topics.add(
              topic.replace(/urn_mrn_imo_mmsi_/g, 'urn:mrn:imo:mmsi:')
            );
          }
        }
      });

    // Subscribe to all topics
    app.debug(`📡 Subscribing to ${topics.size} MQTT topics...`);
    topics.forEach(topic => {
      state.mqttClient!.subscribe(topic, { qos: 1 }, err => {
        if (err) {
          app.debug(`❌ Failed to subscribe to ${topic}: ${err.message}`);
        } else {
          app.debug(`✅ Subscribed to MQTT topic: ${topic}`);
        }
      });
    });

    app.debug(`Subscribed to ${topics.size} MQTT topics`);
  }

  // Handle incoming MQTT messages
  function handleMQTTMessage(topic: string, message: Buffer): void {
    try {
      const messageStr = message.toString();

      // Debug: Log incoming message
      app.debug(`📥 Received MQTT message on topic: ${topic}`);

      // Find matching import rule (that doesn't exclude this MMSI)
      let rule: ImportRule | null = null;
      for (const r of state.importRules) {
        if (!r.enabled) continue;

        let expectedTopic = r.mqttTopic;
        if (state.currentConfig?.topicPrefix) {
          expectedTopic = `${state.currentConfig.topicPrefix}/${expectedTopic}`;
        }

        // Debug: Log rule matching attempt
        app.debug(
          `🔍 Checking rule "${r.name}" with pattern: ${expectedTopic}`
        );

        // First check if topic matches the pattern
        let matches = false;

        // Use proper MQTT wildcard matching
        matches = mqttTopicMatches(topic, expectedTopic, state.selfVesselUrn);

        // If topic matches, check if MMSI should be excluded
        if (matches && isMMSIExcluded(topic, r)) {
          const mmsi = extractMMSIFromUrn(topic.split('/')[1]);
          app.debug(
            `🔍 Rule "${r.name}" matches but MMSI ${mmsi} is excluded - continuing search`
          );
          continue; // Continue looking for other rules
        }

        // If this rule matches and doesn't exclude, use it
        if (matches) {
          rule = r;
          break;
        }
      }

      if (!rule) {
        app.debug(`❌ No import rule found for topic: ${topic}`);
        return;
      }

      app.debug(`✅ Rule matched: "${rule.name}" for topic: ${topic}`);

      // Check for duplicate messages if enabled
      if (rule.ignoreDuplicates) {
        const messageKey = `${topic}:${messageStr}`;
        if (state.lastReceivedMessages.has(messageKey)) {
          return; // Skip duplicate message
        }
        state.lastReceivedMessages.set(messageKey, Date.now());

        // Clean up old messages (keep last 1000 messages)
        if (state.lastReceivedMessages.size > 1000) {
          const entries = Array.from(state.lastReceivedMessages.entries());
          const oldest = entries.slice(0, 500);
          oldest.forEach(([key]) => state.lastReceivedMessages.delete(key));
        }
      }

      // Parse the message based on expected format
      let signalKData: SignalKDelta | null;
      if (rule.payloadFormat === 'value-only') {
        signalKData = parseValueOnlyMessage(messageStr, rule, topic);
      } else if (rule.payloadFormat === 'json-object') {
        signalKData = parseJsonObjectMessage(messageStr, rule, topic);
      } else if (rule.payloadFormat === 'custom-mapping') {
        signalKData = parseCustomMappingMessage(messageStr, rule, topic);
      } else {
        signalKData = parseFullSignalKMessage(messageStr, rule, topic);
      }

      if (signalKData) {
        sendToSignalK(signalKData, rule);
        app.debug(`📤 Successfully processed message for topic: ${topic}`);
      } else {
        app.debug(`⚠️ Failed to parse message for topic: ${topic}`);
      }
    } catch (error) {
      app.debug(
        `Error handling MQTT message from ${topic}: ${(error as Error).message}`
      );
    }
  }

  // Parse value-only message format
  function parseValueOnlyMessage(
    messageStr: string,
    rule: ImportRule,
    topic: string
  ): SignalKDelta | null {
    return parsers.parseValueOnlyMessage(
      messageStr,
      rule,
      topic,
      getParseContext()
    );
  }

  // Parse JSON object message format - each key becomes a separate path
  function parseJsonObjectMessage(
    messageStr: string,
    rule: ImportRule,
    topic: string
  ): SignalKDelta | null {
    return parsers.parseJsonObjectMessage(
      messageStr,
      rule,
      topic,
      getParseContext()
    );
  }

  // Parse full SignalK message format
  function parseFullSignalKMessage(
    messageStr: string,
    rule: ImportRule,
    topic: string
  ): SignalKDelta | null {
    return parsers.parseFullSignalKMessage(
      messageStr,
      rule,
      topic,
      getParseContext()
    );
  }

  // Thin wrappers that close over plugin state/app and delegate to
  // the pure implementations in ./parsers.
  const urnToMqttFormat = parsers.urnToMqttFormat;
  const extractMMSIFromUrn = parsers.extractMMSIFromUrn;

  function mqttTopicMatches(
    topic: string,
    pattern: string,
    selfVesselUrn?: string | null
  ): boolean {
    return parsers.mqttTopicMatches(topic, pattern, selfVesselUrn);
  }

  function isMMSIExcluded(topic: string, rule: ImportRule): boolean {
    return parsers.isMMSIExcluded(topic, rule, app.debug);
  }

  function extractContextFromTopic(topic: string): string {
    return parsers.extractContextFromTopic(
      topic,
      state.currentConfig?.topicPrefix || '',
      state.selfVesselUrn
    );
  }

  function extractPathFromTopic(topic: string): string {
    return parsers.extractPathFromTopic(
      topic,
      state.currentConfig?.topicPrefix || ''
    );
  }

  // Send data to SignalK
  function sendToSignalK(signalKData: SignalKDelta, rule: ImportRule): void {
    try {
      // Validate the data structure
      if (
        !signalKData.context ||
        !signalKData.updates ||
        !Array.isArray(signalKData.updates)
      ) {
        app.debug('Invalid SignalK data structure');
        return;
      }

      // Apply any transformations if configured
      if (rule.transformValue && typeof rule.transformValue === 'function') {
        signalKData.updates.forEach(update => {
          if ((update as any).values) {
            (update as any).values.forEach((valueUpdate: any) => {
              valueUpdate.value = rule.transformValue!(valueUpdate.value);
            });
          }
        });
      }

      // Send to SignalK
      app.handleMessage(plugin.id, signalKData as any);

      app.debug(
        `✅ Imported to SignalK: ${signalKData.context} - ${signalKData.updates.length} updates`
      );
    } catch (error) {
      app.debug(`Error sending to SignalK: ${(error as Error).message}`);
    }
  }

  // Get default import rules
  function getDefaultImportRules(): ImportRule[] {
    return [
      {
        id: 'vessels-all-data',
        name: 'All Vessel Data (Auto-detect Self)',
        mqttTopic: 'vessels/+/#',
        signalKContext: '', // Will be extracted from topic (auto-detect self)
        signalKPath: '', // Will be extracted from topic
        sourceLabel: '',
        enabled: false, // Disabled by default
        payloadFormat: 'full',
        ignoreDuplicates: true,
        excludeMMSI: '',
      },
      {
        id: 'vessels-navigation',
        name: 'Navigation Data (All Vessels)',
        mqttTopic: 'vessels/+/navigation/#',
        signalKContext: '', // Will be extracted from topic (auto-detect self)
        signalKPath: '', // Will be extracted from topic
        sourceLabel: '',
        enabled: true,
        payloadFormat: 'full',
        ignoreDuplicates: true,
        excludeMMSI: '',
      },
      {
        id: 'vessels-environment',
        name: 'Environment Data (All Vessels)',
        mqttTopic: 'vessels/+/environment/#',
        signalKContext: '', // Will be extracted from topic (auto-detect self)
        signalKPath: '', // Will be extracted from topic
        sourceLabel: '',
        enabled: false, // Disabled by default
        payloadFormat: 'full',
        ignoreDuplicates: true,
        excludeMMSI: '',
      },
      {
        id: 'vessels-electrical',
        name: 'Electrical Data (All Vessels)',
        mqttTopic: 'vessels/+/electrical/#',
        signalKContext: '', // Will be extracted from topic (auto-detect self)
        signalKPath: '', // Will be extracted from topic
        sourceLabel: '',
        enabled: false, // Disabled by default
        payloadFormat: 'full',
        ignoreDuplicates: true,
        excludeMMSI: '',
      },
      {
        id: 'vessels-propulsion',
        name: 'Propulsion Data (All Vessels)',
        mqttTopic: 'vessels/+/propulsion/#',
        signalKContext: '', // Will be extracted from topic (auto-detect self)
        signalKPath: '', // Will be extracted from topic
        sourceLabel: '',
        enabled: false, // Disabled by default
        payloadFormat: 'full',
        ignoreDuplicates: true,
        excludeMMSI: '',
      },
    ];
  }

  // Update MQTT subscriptions when rules change
  function updateMQTTSubscriptions(): void {
    if (state.mqttClient && state.mqttClient.connected) {
      // Unsubscribe from all topics first
      state.mqttClient.unsubscribe('#');

      // Re-subscribe based on current rules
      subscribeToMQTTTopics();
    }
  }

  // Plugin webapp routes
  plugin.registerWithRouter = function (router: Router): void {
    const express = require('express');

    app.debug('registerWithRouter called for MQTT import manager');

    // API Routes

    // Get current import rules
    router.get(
      '/api/rules',
      (_: TypedRequest, res: TypedResponse<RulesApiResponse>) => {
        res.json({
          success: true,
          rules: state.importRules,
          mqttConnected: state.mqttClient ? state.mqttClient.connected : false,
        });
      }
    );

    // Update import rules
    router.post(
      '/api/rules',
      (
        req: TypedRequest<RuleUpdateRequest>,
        res: TypedResponse<ApiResponse>
      ) => {
        try {
          const newRules = req.body.rules;
          if (!Array.isArray(newRules)) {
            return res
              .status(400)
              .json({ success: false, error: 'Rules must be an array' });
          }

          state.importRules = newRules;

          // Save rules to persistent storage
          if (saveRulesToStorage(newRules)) {
            // Update MQTT subscriptions with new rules
            updateMQTTSubscriptions();

            res.json({
              success: true,
              message: 'Import rules updated and saved to persistent storage',
            });
          } else {
            res.status(500).json({
              success: false,
              error: 'Failed to save rules to persistent storage',
            });
          }
        } catch (error) {
          res
            .status(500)
            .json({ success: false, error: (error as Error).message });
        }
      }
    );

    // Get MQTT connection status
    router.get(
      '/api/mqtt-status',
      (_: TypedRequest, res: TypedResponse<MQTTStatusApiResponse>) => {
        res.json({
          success: true,
          connected: state.mqttClient ? state.mqttClient.connected : false,
          broker: state.currentConfig?.mqttBroker,
          clientId: state.currentConfig?.mqttClientId,
        });
      }
    );

    // Test MQTT connection
    router.post(
      '/api/test-mqtt',
      (_: TypedRequest, res: TypedResponse<ApiResponse>) => {
        try {
          if (!state.mqttClient || !state.mqttClient.connected) {
            return res
              .status(503)
              .json({ success: false, error: 'MQTT not connected' });
          }

          res.json({
            success: true,
            message: 'MQTT connection is active and receiving messages',
          });
        } catch (error) {
          res
            .status(500)
            .json({ success: false, error: (error as Error).message });
        }
      }
    );

    // Get import statistics
    router.get(
      '/api/stats',
      (_: TypedRequest, res: TypedResponse<StatsApiResponse>) => {
        try {
          const stats = {
            totalRules: state.importRules.length,
            enabledRules: state.importRules.filter(r => r.enabled).length,
            messagesReceived: state.lastReceivedMessages.size,
            mqttConnected: state.mqttClient
              ? state.mqttClient.connected
              : false,
          };

          res.json({ success: true, stats: stats });
        } catch (error) {
          res
            .status(500)
            .json({ success: false, error: (error as Error).message });
        }
      }
    );

    // Test send to SignalK
    router.post(
      '/api/test-send',
      (
        req: TypedRequest<{ delta: SignalKDelta }>,
        res: TypedResponse<ApiResponse>
      ) => {
        try {
          const { delta } = req.body;

          if (!delta || !delta.context || !delta.updates) {
            return res.status(400).json({
              success: false,
              error: 'Invalid delta structure',
            });
          }

          // Send to SignalK
          app.handleMessage(plugin.id, delta as any);

          app.debug(`Test payload sent to SignalK: ${JSON.stringify(delta)}`);

          // Count total paths sent
          let pathCount = 0;
          delta.updates.forEach((update: any) => {
            if (update.values && Array.isArray(update.values)) {
              pathCount += update.values.length;
            }
          });

          res.json({
            success: true,
            message: `Sent ${pathCount} path(s) to SignalK`,
          });
        } catch (error) {
          res
            .status(500)
            .json({ success: false, error: (error as Error).message });
        }
      }
    );

    // ============================================
    // Payload Mapping API Endpoints
    // ============================================

    // Get all payload mappings
    router.get(
      '/api/mappings',
      (_: TypedRequest, res: TypedResponse<MappingsApiResponse>) => {
        res.json({
          success: true,
          mappings: state.payloadMappings,
        });
      }
    );

    // Update/save payload mappings
    router.post(
      '/api/mappings',
      (
        req: TypedRequest<{ mappings: PayloadMapping[] }>,
        res: TypedResponse<ApiResponse>
      ) => {
        try {
          const newMappings = req.body.mappings;
          if (!Array.isArray(newMappings)) {
            return res
              .status(400)
              .json({ success: false, error: 'Mappings must be an array' });
          }

          state.payloadMappings = newMappings;

          if (saveMappingsToStorage(newMappings)) {
            res.json({
              success: true,
              message: 'Payload mappings saved successfully',
            });
          } else {
            res.status(500).json({
              success: false,
              error: 'Failed to save mappings to storage',
            });
          }
        } catch (error) {
          res
            .status(500)
            .json({ success: false, error: (error as Error).message });
        }
      }
    );

    // Delete a specific mapping
    router.delete(
      '/api/mappings/:id',
      (req: TypedRequest, res: TypedResponse<ApiResponse>) => {
        try {
          const mappingId = req.params.id;
          const index = state.payloadMappings.findIndex(
            (m) => m.id === mappingId
          );

          if (index === -1) {
            return res
              .status(404)
              .json({ success: false, error: 'Mapping not found' });
          }

          state.payloadMappings.splice(index, 1);

          if (saveMappingsToStorage(state.payloadMappings)) {
            res.json({
              success: true,
              message: 'Mapping deleted successfully',
            });
          } else {
            res.status(500).json({
              success: false,
              error: 'Failed to save mappings after deletion',
            });
          }
        } catch (error) {
          res
            .status(500)
            .json({ success: false, error: (error as Error).message });
        }
      }
    );

    // Parse a payload and return field suggestions
    router.post(
      '/api/parse-payload',
      (
        req: TypedRequest<ParsePayloadRequest>,
        res: TypedResponse<ParsePayloadResponse>
      ) => {
        try {
          const { payload, topic } = req.body;

          if (!payload) {
            return res
              .status(400)
              .json({ success: false, error: 'Payload is required' });
          }

          const jsonObject = JSON.parse(payload);

          if (
            typeof jsonObject !== 'object' ||
            jsonObject === null ||
            Array.isArray(jsonObject)
          ) {
            return res.status(400).json({
              success: false,
              error: 'Payload must be a valid JSON object',
            });
          }

          // Extract base path from topic using existing logic
          const basePath = topic ? extractPathFromTopic(topic) : '';

          // Extract fields - path is basePath + key
          const fields = Object.entries(jsonObject).map(([key, value]) => {
            const type = Array.isArray(value)
              ? 'array'
              : value === null
                ? 'null'
                : typeof value;

            // Path comes from topic + key
            const suggestedPath = basePath ? `${basePath}.${key}` : key;

            return {
              key,
              value,
              type,
              suggestedPath,
            };
          });

          res.json({
            success: true,
            fields,
          });
        } catch (error) {
          res.status(400).json({
            success: false,
            error: `Invalid JSON: ${(error as Error).message}`,
          });
        }
      }
    );

    // Test a mapping against a sample payload
    router.post(
      '/api/test-mapping',
      (
        req: TypedRequest<TestMappingRequest>,
        res: TypedResponse<TestMappingResponse>
      ) => {
        try {
          const { payload, topic, mapping } = req.body;

          if (!payload || !mapping) {
            return res.status(400).json({
              success: false,
              error: 'Payload and mapping are required',
            });
          }

          const jsonObject = JSON.parse(payload);

          // Extract placeholders from topic
          const placeholders = extractPlaceholdersFromTopic(
            mapping.topicPattern,
            topic || mapping.topicPattern.replace(/[+#]/g, 'test')
          );

          // Process each field mapping
          const results: Array<{
            sourceKey: string;
            originalValue: any;
            transformedValue: any;
            signalKPath: string;
          }> = [];

          const values: Array<{ path: any; value: any }> = [];

          for (const fieldMapping of mapping.fieldMappings) {
            if (!fieldMapping.enabled) continue;

            const sourceValue = jsonObject[fieldMapping.sourceKey];
            if (sourceValue === undefined) continue;

            const transformedValue = applyTransform(
              sourceValue,
              fieldMapping.transform
            );

            const finalPath = applyPlaceholders(
              fieldMapping.signalKPath,
              placeholders
            );

            results.push({
              sourceKey: fieldMapping.sourceKey,
              originalValue: sourceValue,
              transformedValue,
              signalKPath: finalPath,
            });

            values.push({
              path: finalPath as any,
              value: transformedValue,
            });
          }

          const delta: SignalKDelta = {
            context: (mapping.signalKContext || 'vessels.self') as any,
            updates: [
              {
                $source: 'mqtt-import-test',
                timestamp: new Date().toISOString() as any,
                values,
              } as any,
            ],
          };

          res.json({
            success: true,
            results,
            delta,
          });
        } catch (error) {
          res.status(400).json({
            success: false,
            error: (error as Error).message,
          });
        }
      }
    );

    // Export rules and mappings as YAML
    router.get(
      '/api/export-yaml',
      (_: TypedRequest, res: TypedResponse) => {
        try {
          const yamlContent = exportToYaml();
          res.setHeader('Content-Type', 'text/yaml');
          res.setHeader(
            'Content-Disposition',
            'attachment; filename="mqtt-import-config.yaml"'
          );
          res.send(yamlContent);
        } catch (error) {
          res
            .status(500)
            .json({ success: false, error: (error as Error).message });
        }
      }
    );

    // Import rules and mappings from YAML
    router.post(
      '/api/import-yaml',
      (
        req: TypedRequest<YamlImportRequest>,
        res: TypedResponse<YamlImportResponse>
      ) => {
        try {
          const { yamlContent } = req.body;

          if (!yamlContent) {
            return res
              .status(400)
              .json({ success: false, error: 'YAML content is required' });
          }

          const { rules, mappings, warnings } = importFromYaml(yamlContent);

          // Save imported data
          state.importRules = rules;
          state.payloadMappings = mappings;

          const rulesSaved = saveRulesToStorage(rules);
          const mappingsSaved = saveMappingsToStorage(mappings);

          if (rulesSaved && mappingsSaved) {
            // Update MQTT subscriptions
            updateMQTTSubscriptions();

            res.json({
              success: true,
              rulesImported: rules.length,
              mappingsImported: mappings.length,
              warnings,
              message: `Imported ${rules.length} rules and ${mappings.length} mappings`,
            });
          } else {
            res.status(500).json({
              success: false,
              error: 'Failed to save imported configuration',
            });
          }
        } catch (error) {
          res.status(400).json({
            success: false,
            error: (error as Error).message,
          });
        }
      }
    );

    // Serve static files
    const publicPath = path.join(__dirname, '../public');
    if (fs.existsSync(publicPath)) {
      router.use(express.static(publicPath));
      app.debug(`Static files served from: ${publicPath}`);
    }

    app.debug('MQTT Import Manager web routes registered');
  };

  // Configuration schema
  plugin.schema = {
    type: 'object',
    properties: {
      enabled: {
        type: 'boolean',
        title: 'Enable MQTT Import',
        description: 'Enable/disable the MQTT import functionality',
        default: true,
      },
      mqttBroker: {
        type: 'string',
        title: 'MQTT Broker URL',
        description:
          'MQTT broker connection string (e.g., mqtt://localhost:1883)',
        default: 'mqtt://localhost:1883',
      },
      mqttClientId: {
        type: 'string',
        title: 'MQTT Client ID',
        description: 'Unique client identifier for MQTT connection',
        default: 'signalk-mqtt-import',
      },
      mqttUsername: {
        type: 'string',
        title: 'MQTT Username',
        description: 'Username for MQTT authentication (optional)',
        default: '',
      },
      mqttPassword: {
        type: 'string',
        title: 'MQTT Password',
        description: 'Password for MQTT authentication (optional)',
        default: '',
      },
      topicPrefix: {
        type: 'string',
        title: 'Topic Prefix',
        description: 'Optional prefix for all MQTT topics',
        default: '',
      },
    },
  };

  // Persistent storage functions
  function getRulesFilePath(): string {
    if (!state.rulesFilePath) {
      const dataDir = app.getDataDirPath();
      state.rulesFilePath = path.join(dataDir, 'mqtt-import-rules.json');
    }
    return state.rulesFilePath;
  }

  function loadRulesFromStorage(): ImportRule[] {
    try {
      const filePath = getRulesFilePath();
      if (fs.existsSync(filePath)) {
        const data = fs.readFileSync(filePath, 'utf8');
        return JSON.parse(data) as ImportRule[];
      }
    } catch (error) {
      app.debug(
        `Error loading rules from storage: ${(error as Error).message}`
      );
    }
    return getDefaultImportRules();
  }

  function saveRulesToStorage(rules: ImportRule[]): boolean {
    try {
      const filePath = getRulesFilePath();
      fs.writeFileSync(filePath, JSON.stringify(rules, null, 2));
      app.debug(`Rules saved to: ${filePath}`);
      return true;
    } catch (error) {
      app.debug(`Error saving rules to storage: ${(error as Error).message}`);
      return false;
    }
  }

  function migrateOldConfiguration(options: any): ImportRule[] | null {
    // Migrate rules from old plugin config if they exist
    if (options.importRules && Array.isArray(options.importRules)) {
      app.debug(
        'Migrating import rules from plugin configuration to persistent storage'
      );
      saveRulesToStorage(options.importRules);
      return options.importRules;
    }
    return null;
  }

  // ============================================
  // Payload Mappings Storage Functions
  // ============================================

  function getMappingsFilePath(): string {
    if (!state.mappingsFilePath) {
      const dataDir = app.getDataDirPath();
      state.mappingsFilePath = path.join(dataDir, 'mqtt-import-mappings.json');
    }
    return state.mappingsFilePath;
  }

  function loadMappingsFromStorage(): PayloadMapping[] {
    try {
      const filePath = getMappingsFilePath();
      if (fs.existsSync(filePath)) {
        const data = fs.readFileSync(filePath, 'utf8');
        return JSON.parse(data) as PayloadMapping[];
      }
    } catch (error) {
      app.debug(
        `Error loading mappings from storage: ${(error as Error).message}`
      );
    }
    return [];
  }

  function saveMappingsToStorage(mappings: PayloadMapping[]): boolean {
    try {
      const filePath = getMappingsFilePath();
      fs.writeFileSync(filePath, JSON.stringify(mappings, null, 2));
      app.debug(`Mappings saved to: ${filePath}`);
      return true;
    } catch (error) {
      app.debug(
        `Error saving mappings to storage: ${(error as Error).message}`
      );
      return false;
    }
  }

  function getMappingById(mappingId: string): PayloadMapping | undefined {
    return state.payloadMappings.find((m) => m.id === mappingId);
  }

  // Placeholder / transform / custom-mapping helpers — delegate to the
  // pure implementations in ./parsers.
  const extractPlaceholdersFromTopic = parsers.extractPlaceholdersFromTopic;
  const applyPlaceholders = parsers.applyPlaceholders;

  function applyTransform(value: any, transform: ValueTransform): any {
    return parsers.applyTransform(value, transform, {
      debug: app.debug,
      unitDefinitions: state.unitDefinitions,
    });
  }

  function parseCustomMappingMessage(
    messageStr: string,
    rule: ImportRule,
    topic: string
  ): SignalKDelta | null {
    return parsers.parseCustomMappingMessage(
      messageStr,
      rule,
      topic,
      getParseContext()
    );
  }

  // ============================================
  // YAML Export/Import Functions
  // ============================================

  function exportToYaml(): string {
    const exportData: YamlExportData = {
      version: '1.0',
      exportedAt: new Date().toISOString(),
      rules: state.importRules,
      mappings: state.payloadMappings,
    };
    return yaml.dump(exportData, { indent: 2, lineWidth: 120 });
  }

  function importFromYaml(
    yamlContent: string
  ): { rules: ImportRule[]; mappings: PayloadMapping[]; warnings: string[] } {
    const warnings: string[] = [];

    try {
      const data = yaml.load(yamlContent) as YamlExportData;

      if (!data || typeof data !== 'object') {
        throw new Error('Invalid YAML structure');
      }

      const rules: ImportRule[] = [];
      const mappings: PayloadMapping[] = [];

      // Validate and import rules
      if (Array.isArray(data.rules)) {
        for (const rule of data.rules) {
          if (rule.id && rule.mqttTopic) {
            rules.push({
              id: rule.id,
              name: rule.name || '',
              mqttTopic: rule.mqttTopic,
              signalKContext: rule.signalKContext || '',
              signalKPath: rule.signalKPath || '',
              sourceLabel: rule.sourceLabel || '',
              enabled: rule.enabled !== false,
              payloadFormat: rule.payloadFormat || 'full',
              ignoreDuplicates: rule.ignoreDuplicates || false,
              excludeMMSI: rule.excludeMMSI,
              customMappingId: rule.customMappingId,
            });
          } else {
            warnings.push(`Skipped invalid rule: missing id or mqttTopic`);
          }
        }
      }

      // Validate and import mappings
      if (Array.isArray(data.mappings)) {
        for (const mapping of data.mappings) {
          if (mapping.id && mapping.topicPattern) {
            mappings.push({
              id: mapping.id,
              name: mapping.name || '',
              description: mapping.description,
              topicPattern: mapping.topicPattern,
              signalKContext: mapping.signalKContext || 'vessels.self',
              fieldMappings: Array.isArray(mapping.fieldMappings)
                ? mapping.fieldMappings.map((fm: any) => ({
                    sourceKey: fm.sourceKey || '',
                    signalKPath: fm.signalKPath || '',
                    transform: fm.transform || { type: 'none', config: {} },
                    enabled: fm.enabled !== false,
                  }))
                : [],
              enabled: mapping.enabled !== false,
              createdAt: mapping.createdAt,
              updatedAt: new Date().toISOString(),
            });
          } else {
            warnings.push(`Skipped invalid mapping: missing id or topicPattern`);
          }
        }
      }

      return { rules, mappings, warnings };
    } catch (error) {
      throw new Error(`YAML parse error: ${(error as Error).message}`);
    }
  }

  return plugin
};
