# Changelog

All notable changes to this project are documented here. The format
roughly follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.6.0-beta.1] - 2026-04-20

### Added
- **Custom mapping metadata emission.** Custom mappings now emit a
  SignalK `meta` entry alongside `values` so consumers (dashboards, the
  server's unit-preferences layer) know how to interpret each path.
  Follows the `app.handleMessage(..., { updates: [{ meta: [...], values: [...] }]})`
  pattern (signalk-server `src/put.ts`).
- **`unitless` transform type.** A third meta option for per-field mappings:
  passes the value through unchanged (like `none`) but tags the path with
  `meta.units = ""` — explicitly marking it as known-but-unitless. Useful
  for paths like `linkquality`, counters, or indices that have no SI unit.
- **Definitions-driven unit conversion.** The `unit` transform now resolves
  the target SI unit's `inverseFormula` from the server's own
  `/signalk/v1/unitpreferences/definitions` endpoint via mathjs, so every
  conversion the server knows about (including any custom units the admin
  adds at runtime) is immediately available. No conversion table lives in
  the plugin.
- **Live dropdown population.** The webapp's unit transform UI fetches the
  definitions once per page load and builds the base-unit and source-unit
  `<select>` elements from the response. Non-numeric bases (`bool`, `tr`,
  and the three datetime types) are filtered; identity conversions (e.g.
  `K → K`) are kept so users can tag already-SI data with metadata without
  an arithmetic change.
- **`unitpreferencesChanged` listener.** When the server emits this event
  (after admin edits to custom definitions), the plugin re-fetches its
  cached definitions without needing a restart.
- **Test suite.** 84 tests across 9 files (`src/__tests__/`) covering
  every MQTT ingestion pathway: value-only, json-object, full, custom-mapping,
  transforms, topic-match, MMSI exclusion, dispatch selection, and the
  `/api/test-send` HTTP side-channel. Run with `npm test`.

### Changed
- **Refactor: pure parsers extracted.** All payload parsers, topic
  matchers, URN helpers, placeholder extraction, and the transform
  engine moved from closures in `src/index.ts` into `src/parsers.ts` as
  dependency-injected pure functions. `index.ts` now thin-wraps them.
- **Save-time validation for Unit Conversion.** The editor alerts and
  blocks save when an enabled Unit row is missing a Source or SI
  selection, instead of silently persisting a no-op `{ fromUnit: '',
  baseUnit: '' }` pair.
- **Default selections.** The unit dropdowns lead with a `-- Select --`
  placeholder so nothing is auto-chosen. Previously the alphabetically
  first base unit (Coulomb) was auto-selected, producing nonsense
  defaults like `Ah → C` for a length field.

### Fixed
- Unit `baseUnit` is now a first-class field on `ValueTransform.config`
  (was previously accessed via `any`). Legacy `toUnit` is honoured as an
  alias so existing mappings load cleanly.
- Excluded `src/__tests__` from the production build — test code no
  longer ships in `dist/`.

## [0.5.1-beta.2] - 2025-12-23 through 2026-04-19

### Added
- **Custom Payload Mapper.** New transform engine for Zigbee2MQTT-style
  payloads: one MQTT topic pattern drives multiple SignalK paths, each
  field can carry a per-field transform (`boolean-map`, `math`, `unit`,
  `expression`, or none). Paths support `{device}`, `{location}`, etc.
  placeholders extracted from topic wildcards. Includes a webapp editor
  with live "Parse Payload", "Test Mapping", and "Test & Send to
  SignalK" buttons. (`feat: add support for custom payload mapping and
  update README with new features`, 3c78058)
- **`expression` transform.** Safe, sandboxed mathjs `evaluate(expr, { value })`
  for custom per-field formulas. (`feat: add mathjs support for safe
  expression evaluation in SignalK processing`, 17473eda)
- **Five-pair hardcoded unit conversions** (pre-0.6 placeholder for what
  became the definitions-driven system): C→K, F→K, mV→V, %→ratio,
  hPa→Pa.

### Changed
- Removed the `postinstall` script. (16d8a03)

## [0.5.1-beta.1] - 2025-10-13

### Added
- **`json-object` payload format.** Each key in a JSON payload becomes
  its own SignalK path under the rule's base path. (b524df8)
- **Enhanced source-label handling** and better defaults for the
  `$source` field on emitted deltas. (1abeae9)

### Fixed
- Stricter JSON object validation and improved error handling in the
  API routes. (081403d)

## [0.5.0-beta.3] - 2025-10-12

### Fixed
- Plugin is now disabled by default on fresh installs. (629a435)

### Changed
- Added a GitHub Actions CI workflow for format + lint + build.
  (1f7bc25)
- Documentation URL corrected in the README. (10aa439)
- Merged the `aussierules` branch. (d43646a)

## [0.5.0-beta.1] - 2025-07-27

### Changed
- **Beta promotion.** Documentation improvements with formatted JSON
  examples, cleaner imports, unused variables removed. Feature set
  considered stable for broader testing. (71f0512, ba61603)

## [0.5.0-alpha.2] - 2025-07-16 through 2025-07-18

### Added
- **Complete TypeScript conversion.** Type-safe interfaces for
  `ImportRule`, `MQTTImportConfig`, `SignalKDelta`, `PluginState`, and
  generic `ApiResponse<T>`. (0cd5b7b, 3d57737)
- **MQTT topic wildcard matching.** `+` (single segment) and `#`
  (remaining tail) wildcards with regex-backed evaluation. (eaad1bc)
- **Smart self-vessel detection.** URN formats (`urn:mrn:imo:mmsi:...`
  and underscore variant) automatically mapped to `vessels.self`
  context when the MMSI matches the server's self vessel. (4ae0929)
- **Prettier + ESLint** configuration; build scripts; `files` field for
  packaging; `@signalk/server-api` dependency. (7e61222, bd59d8c,
  5eaf239, 34513d2)
- Header styling, CSS polish. (168ef52, e042c3e)

## [0.5.0-alpha.1] - pre-2025-07

### Added
- Original JavaScript implementation, adapted from an 18-month Node-RED
  flow the author ran on a Raspberry Pi.
- Basic MQTT import functionality.
- Web interface for rule management.
- Self-vessel detection and MMSI exclusion.
