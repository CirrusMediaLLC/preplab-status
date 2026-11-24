import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePrevious, planAlerts, probe, sendAlert, snapshot } from './monitor.mjs';

const up = { checkedAt: '2026-11-24T12:00:00.000Z', services: { website: 'operational', app: 'operational', hq: 'operational' } };
const read = outcomes => async ({ id }) => outcomes[id]?.shift() ?? true;
const wait = async () => {};

test('only 200 and true readiness pass, and redirects are not followed', async () => {
  const app = { url: 'https://example.test/api/health', readiness: true };
  assert.equal(await probe(app, async (_, options) => {
    assert.equal(options.redirect, 'manual');
    return Response.json({ ok: true });
  }), true);
  assert.equal(await probe(app, async () => Response.json({ ok: false })), false);
  assert.equal(await probe(app, async () => new Response(null, { status: 307 })), false);
});

test('two failures open one alert and two successes close it', async () => {
  const down = await snapshot(up, { check: read({ app: [false, false] }), wait });
  assert.equal(down.services.app, 'unavailable');
  assert.deepEqual(planAlerts(up, down).map(alert => alert.event), ['app/unavailable']);
  assert.deepEqual(planAlerts(down, down), []);
  const recovered = await snapshot(down, { check: read({ app: [true, true] }), wait });
  assert.deepEqual(planAlerts(down, recovered).map(alert => alert.event), ['app/recovered']);
});

test('a transient check stays unconfirmed and initial success does not email', async () => {
  const current = await snapshot(null, { check: read({ hq: [false, true] }), wait });
  assert.equal(current.services.hq, 'unknown');
  assert.deepEqual(planAlerts(null, current), []);
  assert.deepEqual(planAlerts(current, up), []);
  assert.deepEqual(parsePrevious(JSON.stringify(current)), current);
  assert.throws(() => parsePrevious('{"unexpected":true}'));
});

test('the initial probe invokes the checker with only its service argument', async () => {
  const current = await snapshot(null, {
    check: async (...args) => {
      assert.equal(args.length, 1);
      return true;
    },
    wait: async () => assert.fail('Healthy services should not need confirmation'),
  });
  assert.deepEqual(current.services, up.services);
});

test('both operators get separate messages and a retry reuses the idempotency key', async () => {
  const env = { STATUS_RESEND_KEY: 'test-only', STATUS_ALERT_FROM: 'test-sender@trypreplab.com', STATUS_ALERT_TO: 'operator-one@trypreplab.com,operator-two@trypreplab.com' };
  const alert = planAlerts(up, { ...up, services: { ...up.services, website: 'unavailable' } })[0];
  const keys = [];
  const request = async (_, options) => {
    const messages = JSON.parse(options.body);
    assert.deepEqual(messages.map(message => message.to), [['operator-one@trypreplab.com'], ['operator-two@trypreplab.com']]);
    keys.push(options.headers['Idempotency-Key']);
    return Response.json({ data: [{ id: 'first' }, { id: 'second' }] });
  };
  await sendAlert(alert, up.checkedAt, env, request);
  await sendAlert(alert, up.checkedAt, env, request);
  assert.equal(keys[0], keys[1]);
  await assert.rejects(sendAlert(alert, up.checkedAt, env, async () => Response.json({ data: [{ id: 'first' }] })));
});
