import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const services = [
  { id: 'website', name: 'Website', url: 'https://trypreplab.com/' },
  { id: 'app', name: 'Learner app', url: 'https://trypreplab.com/api/health', readiness: true },
  { id: 'hq', name: 'HQ sign-in', url: 'https://hq.trypreplab.com/hq/login' },
];
const statusPage = 'https://cirrusmediallc.github.io/preplab-status/';
const resendUrl = 'https://api.resend.com/emails/batch';

export async function probe(service, request = fetch) {
  try {
    const result = await request(service.url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
      headers: { 'Cache-Control': 'no-cache', 'User-Agent': 'PrepLab-Status/1.0' },
    });
    if (!service.readiness || result.status !== 200) {
      await result.body?.cancel();
      return result.status === 200;
    }
    return (await result.json())?.ok === true;
  } catch {
    return false;
  }
}

export function parsePrevious(raw) {
  if (raw === '') return null;
  const value = JSON.parse(raw);
  if (
    !Number.isFinite(Date.parse(value?.checkedAt)) ||
    !services.every(({ id }) => ['operational', 'unavailable', 'unknown'].includes(value?.services?.[id]))
  ) {
    throw new Error('Stored monitor state is invalid.');
  }
  return value;
}

export async function snapshot(previous, { check = probe, wait = sleep, now = () => new Date() } = {}) {
  const first = await Promise.all(services.map(check));
  const needsConfirmation = services.map(({ id }, index) =>
    first[index] ? previous?.services[id] === 'unavailable' : true,
  );
  if (needsConfirmation.some(Boolean)) await wait(35_000);
  const results = await Promise.all(services.map(async (service, index) => {
    if (!needsConfirmation[index]) return 'operational';
    const confirmed = await check(service);
    if (confirmed !== first[index]) return 'unknown';
    return confirmed ? 'operational' : 'unavailable';
  }));
  return { checkedAt: now().toISOString(), services: Object.fromEntries(services.map(({ id }, i) => [id, results[i]])) };
}

export function planAlerts(previous, current) {
  return services.flatMap(({ id, name }) => {
    const before = previous?.services[id];
    const after = current.services[id];
    if (after === 'unknown' || before === after || (before !== 'unavailable' && after === 'operational')) return [];
    const status = after === 'operational' ? 'recovered' : 'unavailable';
    return [{ event: `${id}/${status}`, subject: `[PrepLab Status] ${name} ${status}`, text: `${name} is ${status}.\n\n${statusPage}` }];
  });
}

const testAlert = {
  event: 'test',
  subject: '[PrepLab Status] Test alert',
  text: `This is a test of PrepLab’s website, learner app, and HQ sign-in alerts. No outage is being reported.\n\n${statusPage}`,
};

export async function sendAlert(alert, keySeed, env = process.env, request = fetch) {
  const apiKey = env.STATUS_RESEND_KEY?.trim();
  const from = env.STATUS_ALERT_FROM?.trim();
  const recipients = [...new Set((env.STATUS_ALERT_TO ?? '').split(',').map(address => address.trim().toLowerCase()).filter(Boolean))];
  const isPrepLabAddress = address => /^[^\s@]+@trypreplab\.com$/i.test(address);
  if (!apiKey || !from || !isPrepLabAddress(from) || recipients.length !== 2 || !recipients.every(isPrepLabAddress)) {
    throw new Error('Status email configuration is missing or invalid.');
  }
  const payload = recipients.map(to => ({ from: `PrepLab Status <${from}>`, to: [to], subject: alert.subject, text: alert.text }));
  const body = JSON.stringify(payload);
  const idempotencyKey = createHash('sha256').update(`${keySeed}\n${alert.event}\n${body}`).digest('hex');
  let reply;
  try {
    reply = await request(resendUrl, {
      method: 'POST',
      signal: AbortSignal.timeout(15_000),
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
      body,
    });
  } catch {
    throw new Error('Could not reach Resend.');
  }
  if (!reply.ok) throw new Error(`Resend rejected the status email (HTTP ${reply.status}).`);
  const result = await reply.json();
  if (result?.data?.length !== recipients.length || !result.data.every(item => item?.id)) {
    throw new Error('Resend did not accept both status emails.');
  }
  console.log(`Resend accepted both copies of the ${alert.event} email.`);
}

async function main([job, previousPath, statePath, outputPath]) {
  const previous = parsePrevious(readFileSync(previousPath, 'utf8').replace(/^\uFEFF/, '').trim());
  if (job === 'probe') {
    const current = await snapshot(previous);
    writeFileSync(outputPath, JSON.stringify(current) + '\n');
    const baseline = {
      checkedAt: current.checkedAt,
      services: Object.fromEntries(services.map(({ id }) => [id, current.services[id] === 'unknown'
        ? previous?.services[id] ?? 'unknown'
        : current.services[id]])),
    };
    writeFileSync(statePath, JSON.stringify(baseline) + '\n');
    return;
  }
  if (job !== 'alert') throw new Error('Unknown monitor command.');
  const current = JSON.parse(readFileSync(outputPath, 'utf8'));
  const alerts = planAlerts(previous, current);
  for (const alert of alerts) {
    await sendAlert(alert, previous?.checkedAt ?? 'first-check');
    if (alerts.length > 1) await sleep(600);
  }
  if (process.env.STATUS_TEST_ALERT === 'true') {
    await sendAlert(testAlert, process.env.GITHUB_RUN_ID ?? 'local-test');
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).catch(error => {
    console.error(error.message);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, 'Monitor step failed. See its output for details.\n');
    process.exitCode = 1;
  });
}
