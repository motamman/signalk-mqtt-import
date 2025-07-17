import * as fs from 'fs-extra';
import * as path from 'path';
import { Router } from 'express';
import { connect, MqttClient } from 'mqtt';
import {
  SignalKApp,
  SignalKPlugin,
  MQTTImportConfig,
  ImportRule,
  SignalKDelta,
  SignalKUpdate,
  SignalKValue,
  PluginState,
  TypedRequest,
  TypedResponse,
  RulesApiResponse,
  MQTTStatusApiResponse,
  StatsApiResponse,
  ApiResponse,
  RuleUpdateRequest,
  MQTTClientOptions,
  TopicParseResult,
  MessageProcessingResult,
  RuleMatchResult,
  VesselUrn,
  ContextExtractionResult,
  MMSIExclusionResult,
  DefaultRuleConfig,
  PayloadFormat
} from './types';

// Global plugin state
let appInstance: SignalKApp;

export = function(app: SignalKApp): SignalKPlugin {
  // Store app instance for global access
  appInstance = app;
  
  const plugin: SignalKPlugin = {
    id: 'signalk-mqtt-import',
    name: 'SignalK MQTT Import Manager',
    description: 'Selectively import SignalK data from MQTT with webapp management interface',
    schema: {},
    start: () => {},
    stop: () => {},
    registerWithRouter: undefined
  };

  // Plugin state
  const state: PluginState = {
    mqttClient: null,
    importRules: [],
    lastReceivedMessages: new Map<string, number>(),
    selfVesselUrn: null,
    rulesFilePath: null,
    currentConfig: undefined
  };

  plugin.start = function(options: Partial<MQTTImportConfig>): void {
    app.debug('Starting SignalK MQTT Import Manager plugin');
    
    const config: MQTTImportConfig = {
      mqttBroker: options?.mqttBroker || 'mqtt://localhost:1883',
      mqttClientId: options?.mqttClientId || 'signalk-mqtt-import',
      mqttUsername: options?.mqttUsername || '',
      mqttPassword: options?.mqttPassword || '',
      topicPrefix: options?.topicPrefix || '',
      enabled: options?.enabled !== false
    };

    state.currentConfig = config;
    plugin.config = config;
    
    // Load rules from persistent storage (or migrate from old config)
    const migratedRules = migrateOldConfiguration(options as any);
    state.importRules = migratedRules || loadRulesFromStorage();
    
    app.debug(`Loaded ${state.importRules.length} import rules from persistent storage`);

    // Get self vessel URN for proper context mapping
    try {
      state.selfVesselUrn = app.selfId || app.getSelfPath('uuid');
      app.debug(`Self vessel URN: ${state.selfVesselUrn}`);
    } catch (error) {
      app.debug(`Warning: Could not get self vessel URN: ${(error as Error).message}`);
    }

    if (!config.enabled) {
      app.debug('MQTT Import plugin disabled');
      return;
    }

    // Initialize MQTT client
    initializeMQTTClient(config);

    app.debug('SignalK MQTT Import Manager plugin started');
  };

  plugin.stop = function(): void {
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
        keepalive: 60
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
      app.debug(`Failed to initialize MQTT client: ${(error as Error).message}`);
    }
  }

  // Subscribe to MQTT topics based on import rules
  function subscribeToMQTTTopics(): void {
    if (!state.mqttClient || !state.mqttClient.connected) {
      return;
    }

    // Get all unique topics from enabled import rules
    const topics = new Set<string>();
    state.importRules.filter(rule => rule.enabled).forEach(rule => {
      let topic = rule.mqttTopic;
      
      // Add topic prefix if configured
      if (state.currentConfig?.topicPrefix) {
        topic = `${state.currentConfig.topicPrefix}/${topic}`;
      }
      
      // Handle vessels/self/* topics by converting to actual URN format
      if (topic.includes('vessels/self/') && state.selfVesselUrn) {
        // Convert vessels/self/* to actual URN format for MQTT subscription
        const urnTopic = topic.replace('vessels/self/', `vessels/${state.selfVesselUrn}/`);
        topics.add(urnTopic);
        app.debug(`Converted vessels/self rule to URN topic: ${urnTopic}`);
        // Also add underscore format if URN contains colons
        if (state.selfVesselUrn.includes(':')) {
          const underscoreUrn = urnToMqttFormat(state.selfVesselUrn);
          const underscoreTopic = topic.replace('vessels/self/', `vessels/${underscoreUrn}/`);
          topics.add(underscoreTopic);
          app.debug(`Also added underscore format: ${underscoreTopic}`);
        }
      } else {
        // Add both underscore and colon formats for URN topics
        topics.add(topic);
        if (topic.includes('urn_mrn_imo_mmsi_')) {
          topics.add(topic.replace(/urn_mrn_imo_mmsi_/g, 'urn:mrn:imo:mmsi:'));
        }
      }
    });

    // Subscribe to all topics
    app.debug(`📡 Subscribing to ${topics.size} MQTT topics...`);
    topics.forEach(topic => {
      state.mqttClient!.subscribe(topic, { qos: 1 }, (err) => {
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
        app.debug(`🔍 Checking rule "${r.name}" with pattern: ${expectedTopic}`);
        
        // First check if topic matches the pattern
        let matches = false;
        
        // Support wildcard matching with URN format flexibility
        if (expectedTopic.includes('#')) {
          const prefix = expectedTopic.replace('#', '');
          
          // Handle vessels/self/* patterns
          if (prefix.includes('vessels/self/') && state.selfVesselUrn) {
            const urnPrefix = prefix.replace('vessels/self/', `vessels/${state.selfVesselUrn}/`);
            const underscoreUrn = urnToMqttFormat(state.selfVesselUrn);
            const underscorePrefix = underscoreUrn ? prefix.replace('vessels/self/', `vessels/${underscoreUrn}/`) : null;
            matches = topic.startsWith(prefix) || topic.startsWith(urnPrefix) || 
                     (underscorePrefix ? topic.startsWith(underscorePrefix) : false);
            app.debug(`🔍 vessels/self matching: ${matches} (tried: ${prefix}, ${urnPrefix}, ${underscorePrefix})`);
          } else {
            matches = topic.startsWith(prefix) || topic.startsWith(prefix.replace(/_/g, ':'));
          }
        } else if (expectedTopic.includes('+')) {
          // Handle vessels/self/* patterns
          if (expectedTopic.includes('vessels/self/') && state.selfVesselUrn) {
            const urnPattern = expectedTopic.replace('vessels/self/', `vessels/${state.selfVesselUrn}/`);
            const underscoreUrn = urnToMqttFormat(state.selfVesselUrn);
            const underscorePattern = underscoreUrn ? expectedTopic.replace('vessels/self/', `vessels/${underscoreUrn}/`) : null;
            const selfRegex = new RegExp(expectedTopic.replace(/\+/g, '[^/]+'));
            const urnRegex = new RegExp(urnPattern.replace(/\+/g, '[^/]+'));
            const underscoreRegex = underscorePattern ? new RegExp(underscorePattern.replace(/\+/g, '[^/]+')) : null;
            matches = selfRegex.test(topic) || urnRegex.test(topic) || 
                     (underscoreRegex ? underscoreRegex.test(topic) : false);
          } else {
            // Create regex patterns for both underscore and colon formats
            const underscoreRegex = new RegExp(expectedTopic.replace(/\+/g, '[^/]+'));
            const colonRegex = new RegExp(expectedTopic.replace(/_/g, ':').replace(/\+/g, '[^/]+'));
            matches = underscoreRegex.test(topic) || colonRegex.test(topic);
          }
        } else {
          // Handle vessels/self/* patterns
          if (expectedTopic.includes('vessels/self/') && state.selfVesselUrn) {
            const urnTopic = expectedTopic.replace('vessels/self/', `vessels/${state.selfVesselUrn}/`);
            const underscoreUrn = urnToMqttFormat(state.selfVesselUrn);
            const underscoreTopic = underscoreUrn ? expectedTopic.replace('vessels/self/', `vessels/${underscoreUrn}/`) : null;
            matches = topic === expectedTopic || topic === urnTopic || 
                     (underscoreTopic ? topic === underscoreTopic : false);
          } else {
            matches = topic === expectedTopic || topic === expectedTopic.replace(/_/g, ':');
          }
        }
        
        // If topic matches, check if MMSI should be excluded
        if (matches && isMMSIExcluded(topic, r)) {
          const mmsi = extractMMSIFromUrn(topic.split('/')[1]);
          app.debug(`🔍 Rule "${r.name}" matches but MMSI ${mmsi} is excluded - continuing search`);
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
      app.debug(`Error handling MQTT message from ${topic}: ${(error as Error).message}`);
    }
  }

  // Parse value-only message format
  function parseValueOnlyMessage(messageStr: string, rule: ImportRule, topic: string): SignalKDelta | null {
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
      const context = rule.signalKContext || extractContextFromTopic(topic, rule);
      const path = rule.signalKPath || extractPathFromTopic(topic, rule);

      return {
        context: context,
        updates: [{
          source: {
            label: rule.sourceLabel || '',
            type: 'mqtt'
          },
          timestamp: new Date().toISOString(),
          values: [{
            path: path,
            value: value
          }]
        }]
      };
    } catch (error) {
      app.debug(`Error parsing value-only message: ${(error as Error).message}`);
      return null;
    }
  }

  // Parse full SignalK message format
  function parseFullSignalKMessage(messageStr: string, rule: ImportRule, topic: string): SignalKDelta | null {
    try {
      const parsed = JSON.parse(messageStr);
      
      // If it's already a proper SignalK delta, use it directly
      if (parsed.context && parsed.updates) {
        return parsed as SignalKDelta;
      }
      
      // Otherwise, try to construct a SignalK delta
      const context = rule.signalKContext || parsed.context || extractContextFromTopic(topic, rule);
      const path = rule.signalKPath || extractPathFromTopic(topic, rule);
      
      return {
        context: context,
        updates: [{
          source: {
            label: rule.sourceLabel || '',
            type: 'mqtt'
          },
          timestamp: new Date().toISOString(),
          values: [{
            path: path,
            value: parsed
          }]
        }]
      };
    } catch (error) {
      app.debug(`Error parsing full SignalK message: ${(error as Error).message}`);
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
    return excludeMMSI.split(',').map(mmsi => mmsi.trim()).filter(mmsi => mmsi.length > 0);
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
      app.debug(`MMSI ${mmsi} excluded by rule "${rule.name}" for topic: ${topic}`);
    }
    
    return isExcluded;
  }

  // Extract SignalK context from MQTT topic
  function extractContextFromTopic(topic: string, rule: ImportRule): string {
    // Remove prefix if present
    let cleanTopic = topic;
    if (state.currentConfig?.topicPrefix) {
      cleanTopic = cleanTopic.replace(`${state.currentConfig.topicPrefix}/`, '');
    }

    const parts = cleanTopic.split('/');
    
    if (parts[0] === 'vessels' && parts.length > 2) {
      const vesselId = parts[1];
      
      // Check if this is the self vessel's URN (handle both formats)
      if (state.selfVesselUrn && (urnToMqttFormat(state.selfVesselUrn) === vesselId || state.selfVesselUrn === vesselId)) {
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
  function extractPathFromTopic(topic: string, rule: ImportRule): string {
    // Remove prefix if present
    let cleanTopic = topic;
    if (state.currentConfig?.topicPrefix) {
      cleanTopic = cleanTopic.replace(`${state.currentConfig.topicPrefix}/`, '');
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
      if (!signalKData.context || !signalKData.updates || !Array.isArray(signalKData.updates)) {
        app.debug('Invalid SignalK data structure');
        return;
      }

      // Apply any transformations if configured
      if (rule.transformValue && typeof rule.transformValue === 'function') {
        signalKData.updates.forEach(update => {
          if (update.values) {
            update.values.forEach(valueUpdate => {
              valueUpdate.value = rule.transformValue!(valueUpdate.value);
            });
          }
        });
      }

      // Send to SignalK
      app.handleMessage(plugin.id, signalKData);
      
      app.debug(`✅ Imported to SignalK: ${signalKData.context} - ${signalKData.updates.length} updates`);
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
        enabled: true,
        payloadFormat: 'full',
        ignoreDuplicates: true,
        excludeMMSI: ''
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
        excludeMMSI: ''
      },
      {
        id: 'vessels-environment',
        name: 'Environment Data (All Vessels)',
        mqttTopic: 'vessels/+/environment/#',
        signalKContext: '', // Will be extracted from topic (auto-detect self)
        signalKPath: '', // Will be extracted from topic
        sourceLabel: '',
        enabled: true,
        payloadFormat: 'full',
        ignoreDuplicates: true,
        excludeMMSI: ''
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
        excludeMMSI: ''
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
        excludeMMSI: ''
      }
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
  plugin.registerWithRouter = function(router: Router): void {
    const express = require('express');
    
    app.debug('registerWithRouter called for MQTT import manager');
    
    // API Routes
    
    // Get current import rules
    router.get('/api/rules', (_: TypedRequest, res: TypedResponse<RulesApiResponse>) => {
      res.json({
        success: true,
        rules: state.importRules,
        mqttConnected: state.mqttClient ? state.mqttClient.connected : false
      });
    });

    // Update import rules
    router.post('/api/rules', (req: TypedRequest<RuleUpdateRequest>, res: TypedResponse<ApiResponse>) => {
      try {
        const newRules = req.body.rules;
        if (!Array.isArray(newRules)) {
          return res.status(400).json({ success: false, error: 'Rules must be an array' });
        }

        state.importRules = newRules;
        
        // Save rules to persistent storage
        if (saveRulesToStorage(newRules)) {
          // Update MQTT subscriptions with new rules
          updateMQTTSubscriptions();
          
          res.json({ success: true, message: 'Import rules updated and saved to persistent storage' });
        } else {
          res.status(500).json({ success: false, error: 'Failed to save rules to persistent storage' });
        }
      } catch (error) {
        res.status(500).json({ success: false, error: (error as Error).message });
      }
    });

    // Get MQTT connection status
    router.get('/api/mqtt-status', (_: TypedRequest, res: TypedResponse<MQTTStatusApiResponse>) => {
      res.json({
        success: true,
        connected: state.mqttClient ? state.mqttClient.connected : false,
        broker: state.currentConfig?.mqttBroker,
        clientId: state.currentConfig?.mqttClientId
      });
    });

    // Test MQTT connection
    router.post('/api/test-mqtt', (_: TypedRequest, res: TypedResponse<ApiResponse>) => {
      try {
        if (!state.mqttClient || !state.mqttClient.connected) {
          return res.status(503).json({ success: false, error: 'MQTT not connected' });
        }

        res.json({ success: true, message: 'MQTT connection is active and receiving messages' });
      } catch (error) {
        res.status(500).json({ success: false, error: (error as Error).message });
      }
    });

    // Get import statistics
    router.get('/api/stats', (_: TypedRequest, res: TypedResponse<StatsApiResponse>) => {
      try {
        const stats = {
          totalRules: state.importRules.length,
          enabledRules: state.importRules.filter(r => r.enabled).length,
          messagesReceived: state.lastReceivedMessages.size,
          mqttConnected: state.mqttClient ? state.mqttClient.connected : false
        };
        
        res.json({ success: true, stats: stats });
      } catch (error) {
        res.status(500).json({ success: false, error: (error as Error).message });
      }
    });

    // Serve static files
    const publicPath = path.join(__dirname, '../public');
    if (fs.existsSync(publicPath)) {
      router.use(express.static(publicPath));
      app.debug('Static files served from:', publicPath);
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
        default: true
      },
      mqttBroker: {
        type: 'string',
        title: 'MQTT Broker URL',
        description: 'MQTT broker connection string (e.g., mqtt://localhost:1883)',
        default: 'mqtt://localhost:1883'
      },
      mqttClientId: {
        type: 'string',
        title: 'MQTT Client ID',
        description: 'Unique client identifier for MQTT connection',
        default: 'signalk-mqtt-import'
      },
      mqttUsername: {
        type: 'string',
        title: 'MQTT Username',
        description: 'Username for MQTT authentication (optional)',
        default: ''
      },
      mqttPassword: {
        type: 'string',
        title: 'MQTT Password',
        description: 'Password for MQTT authentication (optional)',
        default: ''
      },
      topicPrefix: {
        type: 'string',
        title: 'Topic Prefix',
        description: 'Optional prefix for all MQTT topics',
        default: ''
      },
    }
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
      app.debug(`Error loading rules from storage: ${(error as Error).message}`);
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
      app.debug('Migrating import rules from plugin configuration to persistent storage');
      saveRulesToStorage(options.importRules);
      return options.importRules;
    }
    return null;
  }

  return plugin;
};