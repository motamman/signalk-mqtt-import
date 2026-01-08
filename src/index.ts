import * as fs from 'fs-extra';
import * as path from 'path';
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
  FieldMapping,
  ValueTransform,
  PlaceholderValues,
  MappingsApiResponse,
  ParsePayloadRequest,
  ParsePayloadResponse,
  TestMappingRequest,
  TestMappingResponse,
  YamlExportData,
  YamlImportRequest,
  YamlImportResponse,
} from './types';

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
  };

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

    // Initialize MQTT client
    initializeMQTTClient(config);

    app.debug('SignalK MQTT Import Manager plugin started');
  };

  plugin.stop = function (): void {
    app.debug('Stopping SignalK MQTT Import Manager plugin');

    // Disconnect MQTT client
    if (state.mqttClient) {
      state.mqttClient.end();
      state.mqttClient = null;
    }

    state.lastReceivedMessages.clear();
    app.debug('SignalK MQTT Import Manager plugin stopped');
  };

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
    try {
      let value: any;

      // Try to parse as JSON first
      try {
        value = JSON.parse(messageStr);
      } catch {
        // If not JSON, treat as string/number
        value = isNaN(Number(messageStr)) ? messageStr : Number(messageStr);
      }

      // Extract context and path from topic or rule configuration
      const context = rule.signalKContext || extractContextFromTopic(topic);
      const path = rule.signalKPath || extractPathFromTopic(topic);

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
      app.debug(
        `Error parsing value-only message: ${(error as Error).message}`
      );
      return null;
    }
  }

  // Parse JSON object message format - each key becomes a separate path
  function parseJsonObjectMessage(
    messageStr: string,
    rule: ImportRule,
    topic: string
  ): SignalKDelta | null {
    try {
      const jsonObject = JSON.parse(messageStr);

      // Ensure it's an object (not array or primitive)
      if (
        typeof jsonObject !== 'object' ||
        jsonObject === null ||
        Array.isArray(jsonObject)
      ) {
        app.debug('JSON object format requires a valid JSON object');
        return null;
      }

      // Extract base context and path from topic or rule configuration
      const context = rule.signalKContext || extractContextFromTopic(topic);
      const basePath = rule.signalKPath || extractPathFromTopic(topic);

      // Create a value entry for each key in the JSON object
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
      app.debug(
        `Error parsing JSON object message: ${(error as Error).message}`
      );
      return null;
    }
  }

  // Parse full SignalK message format
  function parseFullSignalKMessage(
    messageStr: string,
    rule: ImportRule,
    topic: string
  ): SignalKDelta | null {
    try {
      const parsed = JSON.parse(messageStr);

      // If it's already a proper SignalK delta, use it directly
      if (parsed.context && parsed.updates) {
        return parsed as SignalKDelta;
      }

      // Otherwise, try to construct a SignalK delta
      const context =
        rule.signalKContext || parsed.context || extractContextFromTopic(topic);
      const path = rule.signalKPath || extractPathFromTopic(topic);

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
      app.debug(
        `Error parsing full SignalK message: ${(error as Error).message}`
      );
      return null;
    }
  }

  // Helper function to convert URN format for MQTT topics
  function urnToMqttFormat(urn: string): string {
    if (!urn) return '';
    // Convert urn:mrn:imo:mmsi:368396230 to urn_mrn_imo_mmsi_368396230
    return urn.replace(/:/g, '_');
  }

  // Helper function to convert MQTT format back to URN
  function mqttFormatToUrn(mqttFormat: string): string {
    if (!mqttFormat) return '';
    // Convert urn_mrn_imo_mmsi_368396230 to urn:mrn:imo:mmsi:368396230
    return mqttFormat.replace(/_/g, ':');
  }

  // Helper function to extract MMSI from URN
  function extractMMSIFromUrn(urn: string): string | null {
    if (!urn) return null;
    // Extract MMSI from urn:mrn:imo:mmsi:368396230 or urn_mrn_imo_mmsi_368396230
    const match = urn.match(/urn[_:]+mrn[_:]+imo[_:]+mmsi[_:]+([0-9]+)/);
    return match ? match[1] : null;
  }

  // Helper function to parse MMSI exclusion list
  function parseMMSIExclusionList(excludeMMSI: string): string[] {
    if (!excludeMMSI || typeof excludeMMSI !== 'string') return [];
    return excludeMMSI
      .split(',')
      .map(mmsi => mmsi.trim())
      .filter(mmsi => mmsi.length > 0);
  }

  // Helper function to match MQTT topics with wildcard patterns
  function mqttTopicMatches(
    topic: string,
    pattern: string,
    selfVesselUrn?: string | null
  ): boolean {
    // Handle vessels/self/* patterns by expanding to all possible formats
    if (pattern.includes('vessels/self/') && selfVesselUrn) {
      // Create patterns for URN format and underscore format
      const urnPattern = pattern.replace(
        'vessels/self/',
        `vessels/${selfVesselUrn}/`
      );
      const underscoreUrn = urnToMqttFormat(selfVesselUrn);
      const underscorePattern = pattern.replace(
        'vessels/self/',
        `vessels/${underscoreUrn}/`
      );

      // Test against all possible patterns
      return (
        mqttTopicMatches(
          topic,
          pattern.replace('vessels/self/', 'vessels/+/')
        ) ||
        mqttTopicMatches(topic, urnPattern) ||
        (underscoreUrn ? mqttTopicMatches(topic, underscorePattern) : false)
      );
    }

    // Convert MQTT pattern to regex pattern
    let regexPattern = pattern
      .replace(/\+/g, '[^/]+') // + matches any characters except /
      .replace(/#$/, '.*') // # at end matches everything
      .replace(/#\//, '.*/'); // # in middle matches everything up to next /

    // Also handle URN format conversion (underscore to colon)
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

    // Create regex objects with anchors
    const regex = new RegExp(`^${regexPattern}$`);
    const colonRegex = colonRegexPattern
      ? new RegExp(`^${colonRegexPattern}$`)
      : null;

    // Test both underscore and colon formats
    return regex.test(topic) || (colonRegex ? colonRegex.test(topic) : false);
  }

  // Helper function to check if MMSI should be excluded
  function isMMSIExcluded(topic: string, rule: ImportRule): boolean {
    const exclusionList = parseMMSIExclusionList(rule.excludeMMSI || '');
    if (exclusionList.length === 0) return false;

    // Extract vessel ID from topic
    const parts = topic.split('/');
    if (parts.length < 2 || parts[0] !== 'vessels') return false;

    const vesselId = parts[1];
    const mmsi = extractMMSIFromUrn(vesselId);

    if (!mmsi) return false;

    const isExcluded = exclusionList.includes(mmsi);

    if (isExcluded) {
      app.debug(
        `MMSI ${mmsi} excluded by rule "${rule.name}" for topic: ${topic}`
      );
    }

    return isExcluded;
  }

  // Extract SignalK context from MQTT topic
  function extractContextFromTopic(topic: string): string {
    // Remove prefix if present
    let cleanTopic = topic;
    if (state.currentConfig?.topicPrefix) {
      cleanTopic = cleanTopic.replace(
        `${state.currentConfig.topicPrefix}/`,
        ''
      );
    }

    const parts = cleanTopic.split('/');

    if (parts[0] === 'vessels' && parts.length > 2) {
      const vesselId = parts[1];

      // Check if this is the self vessel's URN (handle both formats)
      if (
        state.selfVesselUrn &&
        (urnToMqttFormat(state.selfVesselUrn) === vesselId ||
          state.selfVesselUrn === vesselId)
      ) {
        return 'vessels.self';
      }

      // Handle URN format (both underscore and colon)
      if (vesselId.startsWith('urn_')) {
        return `vessels.${mqttFormatToUrn(vesselId)}`;
      } else if (vesselId.startsWith('urn:')) {
        return `vessels.${vesselId}`;
      }

      // Handle other formats
      return `vessels.${vesselId}`;
    }

    // Fallback to vessels.self
    return 'vessels.self';
  }

  // Extract SignalK path from MQTT topic
  function extractPathFromTopic(topic: string): string {
    // Remove prefix if present
    let cleanTopic = topic;
    if (state.currentConfig?.topicPrefix) {
      cleanTopic = cleanTopic.replace(
        `${state.currentConfig.topicPrefix}/`,
        ''
      );
    }

    // Default path extraction: convert topic to SignalK path
    // e.g., "vessels/self/navigation/position" -> "navigation.position"
    const parts = cleanTopic.split('/');

    // Remove context parts (vessels/self or vessels/urn_...)
    if (parts[0] === 'vessels' && parts.length > 2) {
      return parts.slice(2).join('.');
    }

    // Fallback: use the entire topic as path
    return cleanTopic.replace(/\//g, '.');
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

  // ============================================
  // Placeholder Extraction Functions
  // ============================================

  // Default placeholder names for wildcards in order
  const PLACEHOLDER_NAMES = ['device', 'location', 'sensor', 'type', 'id'];

  function extractPlaceholdersFromTopic(
    topicPattern: string,
    actualTopic: string
  ): PlaceholderValues {
    const placeholders: PlaceholderValues = {};

    // Split pattern and actual topic into segments
    const patternParts = topicPattern.split('/');
    const topicParts = actualTopic.split('/');

    let placeholderIndex = 0;

    for (let i = 0; i < patternParts.length && i < topicParts.length; i++) {
      if (patternParts[i] === '+') {
        // Single-level wildcard - capture this segment
        const placeholderName =
          PLACEHOLDER_NAMES[placeholderIndex] || `placeholder${placeholderIndex}`;
        placeholders[placeholderName] = topicParts[i];
        placeholderIndex++;
      } else if (patternParts[i] === '#') {
        // Multi-level wildcard - capture remaining segments joined
        const remaining = topicParts.slice(i).join('/');
        const placeholderName =
          PLACEHOLDER_NAMES[placeholderIndex] || `placeholder${placeholderIndex}`;
        placeholders[placeholderName] = remaining;
        break;
      }
    }

    return placeholders;
  }

  function applyPlaceholders(
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
  // Value Transform Functions
  // ============================================

  function applyTransform(value: any, transform: ValueTransform): any {
    if (!transform || transform.type === 'none') {
      return value;
    }

    const config = transform.config || {};

    switch (transform.type) {
      case 'boolean-map':
        if (typeof value === 'boolean') {
          return value ? config.trueValue : config.falseValue;
        }
        // Handle truthy/falsy values
        return value ? config.trueValue : config.falseValue;

      case 'math':
        const numValue = Number(value);
        if (isNaN(numValue)) {
          app.debug(`Cannot apply math transform to non-numeric value: ${value}`);
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

      case 'unit':
        // Unit conversions
        const fromUnit = config.fromUnit || '';
        const toUnit = config.toUnit || '';
        const num = Number(value);
        if (isNaN(num)) return value;

        // Common conversions
        if (fromUnit === 'C' && toUnit === 'K') {
          return num + 273.15; // Celsius to Kelvin
        }
        if (fromUnit === 'mV' && toUnit === 'V') {
          return num / 1000; // millivolts to volts
        }
        if (fromUnit === '%' && toUnit === 'ratio') {
          return num / 100; // percentage to ratio
        }
        if (fromUnit === 'F' && toUnit === 'K') {
          return (num - 32) * (5 / 9) + 273.15; // Fahrenheit to Kelvin
        }
        if (fromUnit === 'hPa' && toUnit === 'Pa') {
          return num * 100; // hectopascals to pascals
        }
        return num;

      case 'expression':
        // Custom JavaScript expression (advanced)
        if (config.expression) {
          try {
            // Create a safe evaluation context
            const evalFunc = new Function('value', `return ${config.expression}`);
            return evalFunc(value);
          } catch (error) {
            app.debug(
              `Error evaluating expression: ${(error as Error).message}`
            );
            return value;
          }
        }
        return value;

      default:
        return value;
    }
  }

  // ============================================
  // Custom Mapping Message Handler
  // ============================================

  function parseCustomMappingMessage(
    messageStr: string,
    rule: ImportRule,
    topic: string
  ): SignalKDelta | null {
    if (!rule.customMappingId) {
      app.debug('Custom mapping rule missing customMappingId');
      return null;
    }

    const mapping = getMappingById(rule.customMappingId);
    if (!mapping) {
      app.debug(`Mapping not found: ${rule.customMappingId}`);
      return null;
    }

    try {
      const jsonObject = JSON.parse(messageStr);

      if (
        typeof jsonObject !== 'object' ||
        jsonObject === null ||
        Array.isArray(jsonObject)
      ) {
        app.debug('Custom mapping format requires a valid JSON object');
        return null;
      }

      // Extract placeholders from topic
      const placeholders = extractPlaceholdersFromTopic(
        mapping.topicPattern,
        topic
      );

      // Process each field mapping
      const values: Array<{ path: any; value: any }> = [];

      for (const fieldMapping of mapping.fieldMappings) {
        if (!fieldMapping.enabled) continue;

        const sourceValue = jsonObject[fieldMapping.sourceKey];
        if (sourceValue === undefined) continue;

        // Apply value transform
        const transformedValue = applyTransform(
          sourceValue,
          fieldMapping.transform
        );

        // Apply placeholders to path
        const finalPath = applyPlaceholders(
          fieldMapping.signalKPath,
          placeholders
        );

        values.push({
          path: finalPath as any,
          value: transformedValue,
        });
      }

      if (values.length === 0) {
        app.debug('No values extracted from custom mapping');
        return null;
      }

      const context = mapping.signalKContext || rule.signalKContext || 'vessels.self';
      const sourceLabel = rule.sourceLabel || 'mqtt-import-custom';

      return {
        context: context as any,
        updates: [
          {
            $source: sourceLabel,
            timestamp: new Date().toISOString() as any,
            values: values,
          } as any,
        ],
      };
    } catch (error) {
      app.debug(
        `Error parsing custom mapping message: ${(error as Error).message}`
      );
      return null;
    }
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
