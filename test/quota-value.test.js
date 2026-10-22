'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-limits-value-test-'));
process.env.CLAUDE_CONFIG_DIR = scratch;
process.env.USAGE_LIMITS_FETCH = 'off';
test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));

const usage = require('../skills/usage-limits/scripts/usage.js');
const value = require('../skills/usage-limits/scripts/quota-value.js');
const run = promisify(execFile);
const MINUTE = 60000;
const HOUR = 60 * MINUTE;
const NOW = Date.parse('2026-10-22T12:00:00Z');
const rates = value.loadPrices();

test('Desktop OAuth selection matches account, organization, audience and scopes, preferring a live Code token', async (t) => {
  let python = null;
  for (const candidate of ['python3', 'python']) {
    try { await run(candidate, ['--version']); python = candidate; break; } catch (err) { /* Try the other launcher. */ }
  }
  if (!python) return t.skip('Python 3 is optional outside Linux Desktop');
  const source = path.join(__dirname, '..', 'skills', 'usage-limits', 'scripts', 'desktop-usage.py');
  const script = `import importlib.util,sys
spec=importlib.util.spec_from_file_location('desktop_usage',sys.argv[1])
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
account={'accountUuid':'acc','organizationUuid':'org'}
prefix='acct:acc|client:org:https://api.anthropic.com:'
cache={
 prefix+'user:inference user:profile':{'token':'live','expiresAt':3000},
 prefix+'user:inference user:profile user:sessions:claude_code':{'token':'old','expiresAt':1000},
 'acct:other|client:org:https://api.anthropic.com:user:inference user:profile':{'token':'other','expiresAt':9000},
 'acct:acc|client:other:https://api.anthropic.com:user:inference user:profile':{'token':'other-org','expiresAt':9000},
 prefix+'user:inference':{'token':'no-profile','expiresAt':9000},
 'acct:acc|client:org:https://example.com:user:inference user:profile':{'token':'wrong-audience','expiresAt':9000}}
assert module.select_token(cache,account,2000)['token']=='live'
cache[prefix+'user:inference user:profile user:sessions:claude_code']['expiresAt']=4000
assert module.select_token(cache,account,2000)['token']=='old'
assert module.select_token(cache,{'accountUuid':'none','organizationUuid':'org'},2000) is None
assert module.NoRedirect().redirect_request(None,None,302,'',{},'https://example.com') is None
print('OK')`;
  const result = await run(python, ['-c', script, source], { env: Object.assign({}, process.env, { PYTHONDONTWRITEBYTECODE: '1' }) });
  assert.equal(result.stdout.trim(), 'OK');
});

function base(extra) {
  return Object.assign({
    now: NOW, accountId: 'fixture-account', planId: 'max_5x', planTier: 'default_claude_max_5x', plan: 'Claude Max 5x',
    snapshotFetchedAt: NOW - MINUTE, snapshotSource: 'live',
    utilization: {
      five_hour: { utilization: 40, resets_at: new Date(NOW + HOUR).toISOString() },
      seven_day: { utilization: 20, resets_at: new Date(NOW + 24 * HOUR).toISOString() },
    },
  }, extra);
}

function calls(at, total, model) {
  return Array.from({ length: 5 }, (_, index) => ({
    at: at + index, cost: total / 5, tokens: 100, model: model || 'claude-sonnet-5-5',
    sidechain: index === 4,
    parts: { input: 10, cacheWrite: 20, cacheRead: 60, output: 10 },
  }));
}

test('5h and weekly capacity use their own snapshot-aligned spend and token splits', () => {
  const events = [...calls(NOW - 10 * HOUR, 40), ...calls(NOW - HOUR, 20), ...calls(NOW - 30000, 200)];
  const { data } = value.buildReport(base(), events, null, rates);
  const [five, weekly] = data.windows;
  assert.equal(five.totalUSD, 50, 'post-snapshot $200 does not inflate the denominator');
  assert.equal(five.remainingUSD, 30);
  assert.equal(five.spentUSD, 220, 'the latest spend is still shown');
  assert.equal(five.observedUSD, 20);
  assert.equal(weekly.totalUSD, 300);
  assert.equal(weekly.remainingUSD, 240);
  assert.equal(five.spentTokens, 1000);
  assert.deepEqual(five.tokenParts, { input: 100, cacheWrite: 200, cacheRead: 600, output: 100 });
  assert.equal(five.subagentCalls, 2);
  assert.equal(five.sample.method, 'window-to-date');
});

test('observed percentage deltas supersede a window-to-date estimate without assuming old log coverage', () => {
  const initial = value.buildReport(base(), calls(NOW - HOUR, 20), null, rates);
  const later = base({ now: NOW + 5 * MINUTE, snapshotFetchedAt: NOW + 4 * MINUTE });
  later.utilization.five_hour.utilization = 60;
  later.utilization.five_hour.resets_at = new Date(NOW + HOUR - 761).toISOString();
  const events = [...calls(NOW - HOUR, 20), ...calls(NOW + MINUTE, 30)];
  const result = value.buildReport(later, events, initial.state, rates);
  const row = result.data.windows[0];
  assert.equal(row.sample.method, 'observed-delta');
  assert.equal(row.sample.points, 20);
  assert.equal(row.totalUSD, 150, '$30 moved 20 real percentage points');
  assert.equal(row.remainingUSD, 60);
  assert.equal(result.state.cycles.filter((cycle) => cycle.key === 'five_hour').length, 1, 'server timestamp jitter does not split a cycle');
  const repeated = value.buildReport(later, events, result.state, rates);
  assert.deepEqual(repeated.data.windows, result.data.windows, 're-reading the same snapshot never double-counts');
});

test('invalid or weak readings never create dollar capacity from a guessed percentage', () => {
  const cases = [
    [{ utilization: 0, resets_at: new Date(NOW + HOUR).toISOString() }, {}, 'low-percent'],
    [{ utilization: 1, resets_at: new Date(NOW + HOUR).toISOString() }, {}, 'low-percent'],
    [{ utilization: 100, resets_at: new Date(NOW + HOUR).toISOString() }, {}, 'capped'],
    [{ utilization: 40, resets_at: null }, {}, 'unanchored'],
    [{ utilization: 40, resets_at: new Date(NOW - MINUTE).toISOString() }, {}, 'rolled-over'],
    [{ utilization: 40, resets_at: new Date(NOW + HOUR).toISOString() }, { snapshotFetchedAt: NOW - 11 * MINUTE }, 'stale'],
    [{ utilization: 40, resets_at: new Date(NOW + HOUR).toISOString() }, { snapshotFetchedAt: null }, 'invalid-time'],
    [{ utilization: 40, resets_at: new Date(NOW + HOUR).toISOString() }, { snapshotFetchedAt: NOW + MINUTE }, 'invalid-time'],
  ];
  for (const [snapshot, extra, status] of cases) {
    const source = base(extra);
    source.utilization.five_hour = snapshot;
    const result = value.buildReport(source, calls(NOW - HOUR, 20), null, rates).data.windows[0];
    assert.equal(result.status, status);
    assert.equal(result.totalUSD, null, status);
    assert.equal(result.remainingUSD, null, status);
  }
  const partial = calls(NOW - HOUR, 20);
  partial.partial = true;
  assert.equal(value.buildReport(base(), partial, null, rates).data.windows[0].status, 'partial-scan');
});

test('a capped reading can show the same cycle earlier estimate but cannot recalibrate it', () => {
  const first = value.buildReport(base(), calls(NOW - HOUR, 20), null, rates);
  const full = base({ now: NOW + MINUTE, snapshotFetchedAt: NOW });
  full.utilization.five_hour.utilization = 100;
  const result = value.buildReport(full, [...calls(NOW - HOUR, 20), ...calls(NOW - 30000, 200)], first.state, rates);
  assert.equal(result.data.windows[0].totalUSD, 50);
  assert.equal(result.data.windows[0].remainingUSD, 0);
  assert.equal(result.data.windows[0].sample.at, first.data.windows[0].sample.at);
});

test('history survives a reset while the new cycle waits for its own sample', () => {
  const first = value.buildReport(base(), calls(NOW - HOUR, 20), null, rates);
  const source = base({ now: NOW + 2 * HOUR, snapshotFetchedAt: NOW + 2 * HOUR - MINUTE });
  source.utilization.five_hour = { utilization: 0, resets_at: new Date(NOW + 6 * HOUR).toISOString() };
  const result = value.buildReport(source, calls(NOW - HOUR, 20), first.state, rates);
  assert.equal(result.data.windows[0].totalUSD, null);
  assert.equal(result.data.history[0].totalUSD, 50);
  assert.equal(result.data.history[0].key, 'five_hour');
});

test('account, tier and price changes isolate calibrations and history', () => {
  const first = value.buildReport(base(), calls(NOW - HOUR, 20), null, rates);
  for (const extra of [{ accountId: 'other' }, { planId: 'max_20x' }, { planTier: 'other-tier' }]) {
    const source = base(extra);
    source.utilization.five_hour.utilization = 0;
    const result = value.buildReport(source, [], first.state, rates);
    assert.equal(result.data.windows[0].totalUSD, null);
    assert.notEqual(result.state.identity, first.state.identity);
  }
  const changed = Object.assign({}, rates, { 'claude-sonnet-5-5': { input: 3, output: 15 } });
  const result = value.buildReport(base(), [], first.state, changed);
  assert.notEqual(result.state.identity, first.state.identity);
  assert.equal(result.data.windows[0].totalUSD, null);
});

test('a backwards meter or older snapshot cannot silently reuse a capacity estimate', () => {
  const first = value.buildReport(base(), calls(NOW - HOUR, 20), null, rates);
  const decreased = base({ snapshotFetchedAt: NOW });
  decreased.utilization.five_hour.utilization = 30;
  const result = value.buildReport(decreased, calls(NOW - HOUR, 20), first.state, rates);
  assert.equal(result.data.windows[0].status, 'meter-decreased');
  assert.equal(result.data.windows[0].totalUSD, null);
  const repeated = value.buildReport(decreased, calls(NOW - HOUR, 20), result.state, rates);
  assert.equal(repeated.data.windows[0].status, 'waiting-delta');
  assert.equal(repeated.data.windows[0].totalUSD, null, 'a repeated reading cannot undo a required resample');
  const older = value.buildReport(base({ snapshotFetchedAt: NOW - 2 * MINUTE }), [], first.state, rates);
  assert.equal(older.data.windows[0].status, 'older-reading');
});

test('unknown model prices are visible and do not become an asserted capacity', () => {
  const result = value.buildReport(base(), calls(NOW - HOUR, 20, 'claude-sonnet-unknown'), null, rates).data;
  assert.equal(result.windows[0].status, 'unknown-prices');
  assert.equal(result.windows[0].totalUSD, null);
  assert.deepEqual(result.windows[0].unknownModels, ['claude-sonnet-unknown']);
  assert.match(value.render(result), /价格待确认/);
  assert.match(value.render(result), /预计总价值：待采样/);
});

test('price overrides validate units and invalidate cached token costs, including cache TTLs', async () => {
  const project = path.join(scratch, 'projects', 'linux-project');
  fs.mkdirSync(project, { recursive: true });
  const transcript = path.join(project, 'priced.jsonl');
  const record = {
    type: 'assistant', timestamp: new Date().toISOString(), requestId: 'price-req',
    message: { id: 'price-msg', model: 'claude-sonnet-5-5', usage: {
      input_tokens: 1e6, output_tokens: 1e6, cache_read_input_tokens: 1e6,
      cache_creation_input_tokens: 2e6, cache_creation: { ephemeral_5m_input_tokens: 1e6, ephemeral_1h_input_tokens: 1e6 },
    } },
  };
  fs.writeFileSync(transcript, JSON.stringify(record) + '\n');
  const before = await usage.readClaudeEvents(Date.now() - HOUR);
  assert.equal(before[0].cost, 18.6);
  const pricesFile = path.join(scratch, 'prices.json');
  fs.writeFileSync(pricesFile, JSON.stringify({ 'claude-sonnet-5-5': { input: 4, output: 20, cacheRead: 0.4 } }));
  const overridden = value.loadPrices(pricesFile);
  const repriced = await usage.readClaudeEvents(Date.now() - HOUR, { rates: overridden });
  assert.equal(repriced[0].cost, 37.4);
  assert.equal((await usage.readClaudeEvents(Date.now() - HOUR))[0].cost, 18.6, 'the standard report must not inherit override costs');
  for (const invalid of [{ 'claude-foo': { input: -1, output: 2 } }, { 'claude-foo': { input: 1 } }, [], { 'claude-foo': { input: 1, output: 2, extra: 9 } }]) {
    fs.writeFileSync(pricesFile, JSON.stringify(invalid));
    assert.throws(() => value.loadPrices(pricesFile));
  }
});

test('the Linux-compatible CLI fetches only usage and persists aggregate history without credentials', async () => {
  const dir = fs.mkdtempSync(path.join(scratch, 'cli-'));
  const now = Date.now();
  const utilization = {
    five_hour: { utilization: 40, resets_at: new Date(now + HOUR).toISOString() },
    seven_day: { utilization: 20, resets_at: new Date(now + 24 * HOUR).toISOString() },
  };
  fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: 'fixture', organizationType: 'claude_pro' } }));
  fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'fixture-oauth-token', expiresAt: now + HOUR } }));
  const project = path.join(dir, 'projects', 'linux-project');
  fs.mkdirSync(project, { recursive: true });
  const lines = Array.from({ length: 5 }, (_, i) => JSON.stringify({
    type: 'assistant', timestamp: new Date(now - MINUTE + i).toISOString(), requestId: 'req-' + i,
    message: { id: 'msg-' + i, model: 'claude-sonnet-5-5', usage: { output_tokens: 100000 } },
  }));
  fs.writeFileSync(path.join(project, 'session.jsonl'), lines.join('\n') + '\n');
  let requests = 0;
  const server = http.createServer((req, res) => {
    requests++;
    assert.equal(req.headers.authorization, 'Bearer fixture-oauth-token');
    assert.equal(req.method, 'GET');
    assert.equal(req.url, '/usage');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(utilization));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const cli = path.join(__dirname, '..', 'bin', 'cli.js');
    const env = Object.assign({}, process.env, {
      CLAUDE_CONFIG_DIR: dir, USAGE_LIMITS_HOST: 'codex', USAGE_LIMITS_FETCH: 'on',
      USAGE_LIMITS_USAGE_URL: 'http://127.0.0.1:' + server.address().port + '/usage',
    });
    const fetched = await run(process.execPath, [cli, 'value', '--json'], { env });
    const data = JSON.parse(fetched.stdout);
    assert.equal(requests, 1);
    assert.equal(data.windows[0].spentUSD, 5);
    assert.equal(data.windows[0].totalUSD, 12.5);
    assert.equal(data.windows[1].totalUSD, 25);
    assert.equal(data.refresh, 'live');
    assert.equal(data.persistence, true);
    const offline = await run(process.execPath, [cli, '--value', '--offline'], { env });
    assert.equal(requests, 1, 'offline mode makes no request');
    assert.match(offline.stdout, /刷新：仅本地数据/);
    assert.match(offline.stdout, /预计总价值：\$12\.50/);
    assert.doesNotMatch(fetched.stdout + fetched.stderr + offline.stdout + fs.readFileSync(path.join(dir, 'usage-limits-value.json'), 'utf8'), /fixture-oauth-token|Bearer/);
    const refreshed = await run(process.execPath, [cli, 'value', '--refresh', '--json'], { env });
    assert.equal(requests, 2, 'manual refresh bypasses the recent cached reading');
    assert.equal(JSON.parse(refreshed.stdout).refresh, 'live');
    await assert.rejects(run(process.execPath, [cli, 'value', '--refresh', '--offline'], { env }), /cannot be combined/);
    assert.equal(requests, 2, 'conflicting flags do not make a request');
    await assert.rejects(run(process.execPath, [cli, 'value', '--refresh', '--json'], {
      env: Object.assign({}, env, { USAGE_LIMITS_FETCH: 'off' }),
    }), (error) => error.code === 1 && JSON.parse(error.stdout).refresh === 'disabled');
    await assert.rejects(run(process.execPath, [cli, 'value', '--host', 'codex'], { env }), /unsupported/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

