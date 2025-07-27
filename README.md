# SignalK MQTT Import Manager

**Version 0.5.0-beta.1**

A comprehensive SignalK plugin and webapp provides a web-based interface for managing selective import of SignalK data from MQTT brokers. This plugin serves as the inverse of the MQTT Export plugin, allowing you to import data from MQTT topics back into SignalK.

***THIS REQUIRES A SEPARATELY INSTALLED MQTT BROKER***

Both have been tested with a local and remote Mosquitto broker. I run a local broker which bridges to the remote broker when I have connectivity on the boat. (I also have several DIY sensors that send to a broker regardless of whether the Signal K is running and use this plugin to import the sensor payloads.) This assumes that the payload has a fully formed delta complete with a path, $source, timestamp and value.

This was adapted from a Node-RED flow that was running on my RPI for the last 18 months. I switched to this because Node-RED was starting to eat up reseources as my flows became more numerous and complex.

## Features

- **🌐 Web Interface**: Easy-to-use webapp for managing import rules
- **📋 Rule Management**: Create, edit, enable/disable import rules
- **🎯 Selective Import**: Import only the data you need with flexible topic filtering
- **📊 Real-time Status**: Monitor MQTT connection and message statistics
- **🏷️ Flexible Topic Mapping**: Support for MQTT topic wildcards and auto-extraction of SignalK paths
- **📦 Multiple Formats**: Support for object and value-only payloads
- **🔍 Duplicate Filtering**: Optionally ignore duplicate messages to reduce SignalK updates
- **🏷️ Source Labeling**: Customize source labels for imported data

## Installation

### Method: NPM Installation
```bash
npm install signalk-mqtt-import
sudo systemctl restart signalk
```

### Method: NPM Installation from GitHub repo
```bash
cd ~/.signalk/node_modules
npm install motamman/signalk-mqtt-import
sudo systemctl restart signalk
```

## Development

### Building from Source

```bash
# Clone the repository
git clone https://github.com/motamman/signalk-mqtt-import.git
cd signalk-mqtt-import

# Install dependencies
npm install

# Build TypeScript
npm run build

# Development mode (watch for changes)
npm run dev
```

### Project Structure

```
signalk-mqtt-import/
├── src/
│   ├── index.ts        # Main plugin file (TypeScript)
│   └── types.ts        # TypeScript type definitions
├── dist/               # Compiled JavaScript output
├── public/             # Web interface files
├── package.json        # Dependencies and scripts
└── tsconfig.json       # TypeScript configuration
```

## Configuration

### Plugin Settings

Navigate to **SignalK Admin → Server → Plugin Config → SignalK MQTT Import Manager** for basic MQTT connection settings:

- **Enable MQTT Import**: Master enable/disable switch
- **MQTT Broker URL**: Connection string (e.g., `mqtt://localhost:1883`)
- **Client ID**: Unique identifier for the MQTT connection
- **Username/Password**: Optional authentication credentials
- **Topic Prefix**: Optional prefix for all MQTT topics

### Import Rules Management

**All import rules are managed through the web interface only.** This eliminates configuration conflicts and provides a better user experience.

## Web Interface

Access the management interface at:
- **http://your-signalk-server:3000/plugins/signalk-mqtt-import/**

### Interface Features

#### Status Dashboard
- **MQTT Connection**: Real-time connection status
- **Active Rules**: Number of enabled import rules
- **Messages Received**: Count of messages processed
- **Total Rules**: Total number of configured rules

#### Rule Management
- **Add Rule**: Create new import rules
- **Edit Rule**: Modify existing rules
- **Enable/Disable**: Toggle rules on/off
- **Delete Rule**: Remove unwanted rules
- **Save Changes**: Apply changes and save to persistent storage

#### Rule Configuration Options
- **Name**: Descriptive name for the rule
- **MQTT Topic**: Topic to subscribe to (supports + and # wildcards)
- **SignalK Context**: Target SignalK context (optional - can be extracted from topic)
- **SignalK Path**: Target SignalK path (optional - can be extracted from topic)
- **Source Label**: Label to use for the data source in SignalK
- **Payload Format**: Expected format of MQTT messages (full SignalK or value-only)
- **Ignore Duplicates**: Skip duplicate messages to reduce SignalK updates
- **Exclude MMSI**: Comma-separated list of MMSI numbers to exclude from this rule

## MQTT Topic Mapping

### Topic Wildcards
- **+**: Single-level wildcard (e.g., `vessels/+/navigation/position`)
- **#**: Multi-level wildcard (e.g., `vessels/self/navigation/#`)

### Automatic Path Extraction
When SignalK Context or Path are left empty, they are automatically extracted from the MQTT topic:

Examples:
- Topic: `vessels/urn_mrn_imo_mmsi_368396230/navigation/position` → Context: `vessels.self` (if 368396230 is self vessel), Path: `navigation.position`
- Topic: `vessels/urn_mrn_imo_mmsi_123456789/electrical/batteries/house/voltage` → Context: `vessels.urn:mrn:imo:mmsi:123456789`, Path: `electrical.batteries.house.voltage`

### Smart Self Vessel Detection
The plugin automatically detects when MQTT topics reference the self vessel:

- **Self Vessel URN**: Plugin retrieves the self vessel's URN from SignalK server at startup
- **Auto-mapping**: Topics like `vessels/urn_mrn_imo_mmsi_368396230/...` are automatically mapped to `vessels.self` context if the MMSI matches the self vessel
- **External Vessels**: Other vessel URNs are properly converted to standard SignalK format (`vessels.urn:mrn:imo:mmsi:123456789`)

## TypeScript Features

### Key Interfaces
- `ImportRule`: Import rule configuration
- `MQTTImportConfig`: Plugin configuration
- `SignalKDelta`: SignalK delta message structure
- `ApiResponse<T>`: Generic API response typing
- `PluginState`: Internal plugin state management

## Default Import Rules

The plugin comes with practical rules for common marine data import (configured via web interface):

1. **All Vessel Data** - `vessels/urn_mrn_imo_mmsi_+/#` (auto-detects self vessel)
2. **Navigation Data** - `vessels/urn_mrn_imo_mmsi_+/navigation/#` (auto-detects self vessel)
3. **Environment Data** - `vessels/urn_mrn_imo_mmsi_+/environment/#` (auto-detects self vessel)
4. **Electrical Data** - `vessels/urn_mrn_imo_mmsi_+/electrical/#` (disabled by default)
5. **Propulsion Data** - `vessels/urn_mrn_imo_mmsi_+/propulsion/#` (disabled by default)

**Note**: These rules are created automatically on first startup and can be modified through the web interface.

## API Endpoints

### GET /api/rules
Get all import rules and MQTT connection status.

**Response:**
```typescript
{
  success: boolean;
  rules: ImportRule[];
  mqttConnected: boolean;
}
```

### POST /api/rules
Update import rules.

**Request:**
```typescript
{
  rules: ImportRule[];
}
```

### GET /api/mqtt-status
Get MQTT connection status.

**Response:**
```typescript
{
  success: boolean;
  connected: boolean;
  broker: string;
  clientId: string;
}
```

### GET /api/stats
Get import statistics.

**Response:**
```typescript
{
  success: boolean;
  stats: {
    totalRules: number;
    enabledRules: number;
    messagesReceived: number;
    mqttConnected: boolean;
  };
}
```

## Integration with Export Plugin

This plugin is designed to work seamlessly with the SignalK MQTT Export plugin:

1. **Export Plugin**: Publishes SignalK data to MQTT topics
2. **Import Plugin**: Subscribes to MQTT topics and imports data back to SignalK

This allows you to:
- Bridge SignalK instances across networks
- Share data between different vessels
- Implement data processing pipelines
- Create backup/restore mechanisms

## Payload Formats

### Full SignalK Structure
Expected format matches the output of the MQTT Export plugin:
```json
{
  "context": "vessels.urn:mrn:imo:mmsi:368396230",
  "updates": [
    {
      "source": {
        "sentence": "GLL",
        "talker": "GN",
        "type": "NMEA0183",
        "label": "maiana"
      },
      "$source": "maiana.GN",
      "timestamp": "2025-07-27T18:31:14.000Z",
      "values": [
        {
          "path": "navigation.position",
          "value": {
            "longitude": -72.08771,
            "latitude": 41.32969833333333
          }
        }
      ]
    }
  ]
}
```

or 

```json
{
  "context": "vessels.urn:mrn:imo:mmsi:368396230",
  "updates": [
    {
      "$source": "zennora-weatherflow-derived",
      "timestamp": "2025-07-27T18:38:08.152Z",
      "values": [
        {
          "path": "environment.wind.speedApparent",
          "value": 3.97
        }
      ]
    }
  ]
}
```


## Troubleshooting

### Common Issues

1. **MQTT Connection Failed**
   - Check MQTT broker URL and credentials
   - Ensure network connectivity
   - Verify firewall settings

2. **No Data Appearing in SignalK**
   - Check if import rules are enabled
   - Verify MQTT topic patterns match published topics
   - Ensure self vessel MMSI is correctly detected in plugin logs
   - Review SignalK debug logs

3. **TypeScript Compilation Issues**
   - Ensure all dependencies are installed: `npm install`
   - Check TypeScript version compatibility
   - Review tsconfig.json settings

4. **Duplicate Data**
   - Enable "Ignore Duplicates" option
   - Check for overlapping import rules

### Debug Mode
Enable debug logging in SignalK admin to see detailed import processing:
```
[DEBUG] 📥 Received MQTT message on topic: vessels/urn_mrn_imo_mmsi_368396230/navigation/position
[DEBUG] ✅ Rule matched: "Navigation Data (All Vessels)" for topic: vessels/urn_mrn_imo_mmsi_368396230/navigation/position
[DEBUG] 📤 Successfully processed message for topic: vessels/urn_mrn_imo_mmsi_368396230/navigation/position
```

## License

MIT License - See [LICENSE](../LICENSE) file for details.

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes with proper TypeScript typing
4. Submit a pull request

## Changelog

### v0.5.0-beta.1 (Beta Release)
- **📝 Improved documentation** with formatted JSON examples for better readability
- **🔄 Version bump** to beta status indicating stable feature set
- **✨ Ready for broader testing** with all core features implemented

### v0.5.0-alpha.2 (TypeScript Conversion)
- **🎯 Complete TypeScript conversion** with full type safety
- **📝 Comprehensive type definitions** for all data structures
- **🔍 Enhanced IDE support** with autocomplete and error detection
- **🏗️ Improved architecture** with well-defined interfaces
- **⚡ Better performance** with optimized compilation
- **🐛 Bug fixes** and improved error handling
- **📚 Enhanced documentation** with type-aware examples

### v0.5.0-alpha.1 (JavaScript)
- Original JavaScript implementation
- Basic MQTT import functionality
- Web interface for rule management
- Self vessel detection and MMSI exclusion