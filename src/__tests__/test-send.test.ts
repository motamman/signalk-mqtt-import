import express from 'express';
import os from 'os';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Prevent the plugin from actually opening an MQTT socket during tests.
vi.mock('mqtt', () => ({
  connect: vi.fn(() => ({
    on: vi.fn(),
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    end: vi.fn(),
    connected: false,
  })),
}));

// `export = function (app) { ... }` in index.ts compiles to
// `module.exports = fn`. With esModuleInterop the default import is the
// function itself.
import pluginFactory from '../index';

function mountPlugin() {
  const handleMessage = vi.fn();
  const app = {
    debug: vi.fn(),
    selfId: 'urn:mrn:imo:mmsi:368396230',
    getSelfPath: (_: string) => undefined,
    getDataDirPath: () => os.tmpdir(),
    handleMessage,
    config: { settings: { port: 0 } },
  } as any;

  const plugin = pluginFactory(app);
  plugin.start({ enabled: false }, () => {});

  const expressApp = express();
  expressApp.use(express.json());
  const router = express.Router();
  plugin.registerWithRouter!(router);
  expressApp.use('/', router);

  return { expressApp, handleMessage, plugin };
}

describe('POST /api/test-send', () => {
  let harness: ReturnType<typeof mountPlugin>;

  beforeEach(() => {
    harness = mountPlugin();
  });

  it('accepts a valid delta and forwards it to app.handleMessage', async () => {
    const delta = {
      context: 'vessels.self',
      updates: [
        {
          $source: 'test',
          timestamp: '2026-01-01T00:00:00Z',
          values: [
            { path: 'environment.wind.speed', value: 5 },
            { path: 'environment.wind.angle', value: 1.2 },
          ],
        },
      ],
    };

    const res = await request(harness.expressApp)
      .post('/api/test-send')
      .send({ delta });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    // Response message reports the number of paths across updates.
    expect(res.body.message).toContain('2');

    expect(harness.handleMessage).toHaveBeenCalledTimes(1);
    expect(harness.handleMessage.mock.calls[0][1]).toEqual(delta);
  });

  it('rejects a delta missing context', async () => {
    const res = await request(harness.expressApp)
      .post('/api/test-send')
      .send({ delta: { updates: [] } });
    expect(res.status).toBe(400);
    expect(harness.handleMessage).not.toHaveBeenCalled();
  });

  it('rejects a delta missing updates', async () => {
    const res = await request(harness.expressApp)
      .post('/api/test-send')
      .send({ delta: { context: 'vessels.self' } });
    expect(res.status).toBe(400);
    expect(harness.handleMessage).not.toHaveBeenCalled();
  });
});
