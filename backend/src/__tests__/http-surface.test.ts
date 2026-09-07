import request from 'supertest';
import { createApp } from '../app';
import { closePool } from '../database/pool';

/**
 * The HTTP surface that exists before any feature is built: the response
 * envelope, the two health endpoints, and the behaviour of a request that goes
 * wrong.
 *
 * These are worth testing before the routes arrive because everything added
 * later inherits this shape. A till that learns the envelope here does not have
 * to relearn it per endpoint.
 */
describe('HTTP surface', () => {
  const app = createApp();

  afterAll(async () => {
    // The readiness probe opens a pool. Left open, jest reports it as a dangling
    // handle and the suite appears to hang on exit.
    await closePool();
  });

  describe('GET /health', () => {
    it('answers 200 without needing the database', async () => {
      const response = await request(app).get('/health');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        success: true,
        data: expect.objectContaining({
          status: 'ok',
          service: 'a-and-b-chemist-api',
        }),
      });
    });
  });

  describe('GET /health/ready', () => {
    it('answers 503 when the database refuses the connection', async () => {
      // jest.setup.js points DATABASE_URL at 127.0.0.1:1, which refuses at once.
      // This is the failure path a readiness probe exists for; the success path
      // needs a real Postgres and is covered by the harness in database/tests.
      const response = await request(app).get('/health/ready');

      expect(response.status).toBe(503);
      expect(response.body).toEqual({
        success: false,
        error: expect.objectContaining({ code: 'database_unavailable' }),
      });
    });

    it('includes the driver detail outside production', async () => {
      const response = await request(app).get('/health/ready');

      // NODE_ENV is 'test' here, so the detail is deliberately present — it names
      // the refused host and port, which is exactly what makes the failure
      // diagnosable on a laptop. Production withholds it; that branch is pinned
      // by the config flag and asserted in config.test.ts rather than by
      // pretending to run as production here.
      expect(response.body.error.details).toEqual(expect.any(String));
    });
  });

  describe('unknown routes', () => {
    it('answers a JSON 404 rather than the Express HTML page', async () => {
      const response = await request(app).get('/no-such-endpoint');

      expect(response.status).toBe(404);
      expect(response.headers['content-type']).toMatch(/application\/json/);
      expect(response.body).toEqual({
        success: false,
        error: expect.objectContaining({
          code: 'not_found',
          message: expect.stringContaining('/no-such-endpoint'),
        }),
      });
    });
  });

  describe('malformed requests', () => {
    it('answers 400 for a body that is not valid JSON', async () => {
      const response = await request(app)
        .post('/health')
        .set('Content-Type', 'application/json')
        .send('{"broken": ');

      // Body parsing happens before routing, so this is a 400 and not a 404:
      // the request was understood badly, not sent somewhere that does not
      // exist. Getting that the wrong way round sends a caller looking for a
      // missing route instead of a missing brace.
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('invalid_json');
    });
  });

  describe('cross-origin requests', () => {
    it('allows the configured origin', async () => {
      const response = await request(app)
        .get('/health')
        .set('Origin', 'http://localhost:3000');

      expect(response.status).toBe(200);
      expect(response.headers['access-control-allow-origin']).toBe('http://localhost:3000');
    });

    it('refuses an origin that is not configured', async () => {
      const response = await request(app)
        .get('/health')
        .set('Origin', 'https://not-our-frontend.example');

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('origin_not_allowed');
    });

    it('allows a request with no Origin header, so health checks and curl work', async () => {
      const response = await request(app).get('/health');

      expect(response.status).toBe(200);
    });
  });
});
