#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const usage = require('./usage.js');
const live = require('./live.js');

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;
const MAX_SNAPSHOT_AGE = 10 * MINUTE;
const MAX_CYCLES = 64;
const PRICE_SOURCE = 'https://platform.claude.com/docs/en/about-claude/pricing';

function stateFile() {
  return path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'usage-limits-value.json');
}

function loadPrices(file) {
  const table = Object.assign({}, usage.RATES);
  if (!file) return table;
  const overrides = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) throw new Error('prices must be a model-to-rate JSON object');
  for (const [model, row] of Object.entries(overrides)) {
    if (!model.startsWith('claude-') || model !== model.toLowerCase() || !row || typeof row !== 'object' || Array.isArray(row)) {
      throw new Error('invalid model price: ' + model);
    }
    for (const field of Object.keys(row)) {
      if (!['input', 'output', 'cacheRead'].includes(field) || !Number.isFinite(row[field]) || row[field] < 0) {
        throw new Error('invalid price field: ' + model + '.' + field);
      }
    }
    if (!Number.isFinite(row.input) || !Number.isFinite(row.output)) throw new Error('input and output prices are required: ' + model);
    table[model] = Object.assign({}, row);
  }
  return table;
}

function identityFor(base, rates) {
  return crypto.createHash('sha256').update(JSON.stringify([
    base.accountId || null, base.planId, base.planTier, usage.pricingKey(rates),
  ])).digest('hex');
}

function summary(events, rates) {
  const models = usage.byModel(events);
  for (const row of models) row.estimated = !usage.isKnownModel(row.model, rates);
  const tokens = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
  for (const event of events) {
    for (const key of Object.keys(tokens)) tokens[key] += (event.parts && event.parts[key]) || 0;
  }
  return {
    usd: events.reduce((sum, event) => sum + event.cost, 0),
    tokens: Object.values(tokens).reduce((sum, value) => sum + value, 0),
    tokenParts: tokens,
    calls: events.length,
    subagentCalls: events.filter((event) => event.sidechain).length,
    models,
    unknownModels: models.filter((row) => row.estimated).map((row) => row.model),
  };
}

const ACTIVE_MEASUREMENTS = new Set(['armed', 'waiting-window', 'running']);
const MEASUREMENT_PHASES = { armed: '等待下次清零', 'waiting-window': '已记录 0%，等待新周期',
  running: '正在测量', completed: '测量已完成', stopped: '已手动结束', expired: '周期已结束' };

function updateMeasurement(state, base, events, rows, rates, options) {
  const opts = options || {};
  const history = Array.isArray(state.measurements) ? state.measurements : [];
  const window = rows.find((row) => row.key === 'five_hour');
  const fresh = Number.isFinite(base.snapshotFetchedAt) && base.snapshotFetchedAt <= base.now &&
    base.now - base.snapshotFetchedAt <= MAX_SNAPSHOT_AGE;
  let current = history.find((entry) => ACTIVE_MEASUREMENTS.has(entry.phase));
  let created = false;
  if (opts.measureStart && !current) {
    current = { id: String(base.now), phase: 'armed', armedAt: base.now, zeroAt: null,
      startAt: null, resetsAt: null, endedAt: null, endReason: null, spent: summary([], rates) };
    history.unshift(current);
    created = true;
  }
  if (current && window) {
    if (current.phase === 'armed' && fresh && window.percentUsed === 0 &&
        (base.snapshotFetchedAt >= current.armedAt || (created && opts.freshlyFetched))) {
      current.phase = 'waiting-window';
      current.zeroAt = base.snapshotFetchedAt;
      current.startAt = base.snapshotFetchedAt;
    }
    if (current.phase === 'waiting-window' && fresh && base.snapshotFetchedAt >= current.zeroAt && window.resetsAt > base.now) {
      current.phase = 'running';
      current.resetsAt = window.resetsAt;
      current.startAt = Math.max(current.zeroAt, window.windowStart);
    }
    const refusal = Number.isFinite(current.startAt) ? events.find((event) =>
      event.at >= current.startAt && event.at <= base.now && event.rejected &&
      event.rejected.key === 'five_hour' && event.rejected.status === 'rejected' &&
      (!current.resetsAt || Math.abs(event.rejected.resetsAt - current.resetsAt) <= 2000)) : null;
    if (refusal) {
      current.phase = 'completed';
      current.endedAt = refusal.at;
      current.endReason = 'five-hour-rejection';
    } else if (current.phase === 'running' && fresh && window.percentUsed === 100 &&
               Math.abs(window.resetsAt - current.resetsAt) <= 2000) {
      current.phase = 'completed';
      current.endedAt = base.snapshotFetchedAt;
      current.endReason = 'meter-full';
    } else if (current.phase === 'running' && base.now >= current.resetsAt) {
      current.phase = 'expired';
      current.endedAt = current.resetsAt;
      current.endReason = 'cycle-ended';
    }
    if (opts.measureStop && ACTIVE_MEASUREMENTS.has(current.phase)) {
      current.phase = 'stopped';
      current.endedAt = base.now;
      current.endReason = current.zeroAt === null ? 'cancelled' : 'manual-stop';
    }
    if (Number.isFinite(current.startAt)) {
      const cutoff = Math.min(current.endedAt || base.now, current.resetsAt || base.now);
      current.spent = summary(events.filter((event) => !event.rejected && event.at >= current.startAt && event.at <= cutoff), rates);
    }
    if (!current.observedAt || base.snapshotFetchedAt >= current.observedAt) {
      current.lastPercent = window.percentUsed;
      current.observedAt = base.snapshotFetchedAt;
    }
    current.phaseText = MEASUREMENT_PHASES[current.phase];
  }
  state.measurements = history.slice(0, 20);
  return { current: current || state.measurements[0] || null, history: state.measurements };
}

// The denominator must be an account reading. Percentages reconstructed from
// local spend would merely divide that spend by its own earlier estimate.
function buildReport(base, allEvents, previous, rates, options) {
  const now = base.now;
  const identity = identityFor(base, rates);
  const state = base.accountId && previous && previous.version === 1 && previous.identity === identity && Array.isArray(previous.cycles)
    ? JSON.parse(JSON.stringify(previous))
    : { version: 1, identity, cycles: [] };
  const events = allEvents.filter((event) => !event.rejected && event.at <= now);
  const limits = usage.limitWindows(base.utilization);
  const fetchedAt = base.snapshotFetchedAt;
  const rows = [];

  for (const spec of usage.WINDOWS.slice(0, 2)) {
    const limit = limits.find((item) => item.key === spec.key);
    const snapshot = (base.utilization && base.utilization[spec.key]) || (limit && {
      utilization: limit.percent,
      resets_at: Number.isFinite(limit.resetsAt) ? new Date(limit.resetsAt).toISOString() : null,
    });
    const percent = snapshot && Number.isFinite(snapshot.utilization) && snapshot.utilization >= 0 && snapshot.utilization <= 100
      ? snapshot.utilization : null;
    const parsedReset = snapshot && snapshot.resets_at ? Date.parse(snapshot.resets_at) : NaN;
    const resetsAt = Number.isFinite(parsedReset) ? parsedReset : null;
    const start = resetsAt === null ? now - spec.span : resetsAt - spec.span;
    const own = events.filter((event) => event.at >= start && (resetsAt === null || event.at < resetsAt));
    const spent = summary(own, rates);
    const observed = summary(own.filter((event) => event.at <= fetchedAt), rates);
    const row = {
      key: spec.key, label: spec.label, windowStart: start, resetsAt, percentUsed: percent,
      spentUSD: spent.usd, spentTokens: spent.tokens, tokenParts: spent.tokenParts,
      models: spent.models, subagentCalls: spent.subagentCalls, unknownModels: spent.unknownModels,
      observedUSD: observed.usd, observedTokens: observed.tokens,
      totalUSD: null, remainingUSD: null, sample: null, status: 'no-snapshot',
    };
    rows.push(row);
    if (percent === null || percent < 0 || percent > 100) continue;
    if (resetsAt === null) { row.status = 'unanchored'; continue; }
    if (resetsAt <= now) { row.status = 'rolled-over'; continue; }
    if (!Number.isFinite(fetchedAt) || fetchedAt < start || fetchedAt > now) { row.status = 'invalid-time'; continue; }
    if (now - fetchedAt > MAX_SNAPSHOT_AGE) { row.status = 'stale'; continue; }
    if (allEvents.partial) { row.status = 'partial-scan'; continue; }

    // The same server reset can drift by sub-second precision between reads.
    let cycle = state.cycles.find((entry) => entry.key === spec.key && Math.abs(entry.resetsAt - resetsAt) <= 2000);
    if (!cycle) {
      cycle = { key: spec.key, resetsAt, anchor: { at: fetchedAt, percent }, sample: null, latest: null };
      state.cycles.push(cycle);
    }
    // A newer local cache can temporarily disagree with the live source.
    // Do not let an older reading undo a later observation.
    if (cycle.latest && fetchedAt < cycle.latest.at) { row.status = 'older-reading'; continue; }
    const decreased = cycle.latest && percent < cycle.latest.percent;
    if (decreased) {
      cycle.anchor = { at: fetchedAt, percent };
      cycle.sample = null;
      cycle.rebased = true;
    }

    const delta = percent - cycle.anchor.percent;
    const between = summary(own.filter((event) => event.at > cycle.anchor.at && event.at <= fetchedAt), rates);
    let candidate = null;
    if (!decreased && percent <= usage.MAX_BASELINE_PERCENT && delta >= usage.MIN_BASELINE_PERCENT &&
        between.calls >= usage.MIN_BASELINE_TURNS && between.usd > 0 && !between.unknownModels.length) {
      candidate = { totalUSD: between.usd * 100 / delta, method: 'observed-delta', points: delta, calls: between.calls, at: fetchedAt };
    } else if (!decreased && !cycle.rebased && !cycle.sample && percent >= usage.MIN_BASELINE_PERCENT && percent <= usage.MAX_BASELINE_PERCENT &&
        observed.calls >= usage.MIN_BASELINE_TURNS && observed.usd > 0 && !observed.unknownModels.length) {
      candidate = { totalUSD: observed.usd * 100 / percent, method: 'window-to-date', points: percent, calls: observed.calls, at: fetchedAt };
    }
    if (candidate && Number.isFinite(candidate.totalUSD) && candidate.totalUSD > 0) cycle.sample = candidate;
    cycle.latest = { at: fetchedAt, percent, spentUSD: observed.usd, tokens: observed.tokens };

    row.status = decreased ? 'meter-decreased'
      : spent.unknownModels.length ? 'unknown-prices'
        : cycle.sample ? 'estimated'
          : percent < usage.MIN_BASELINE_PERCENT ? 'low-percent'
            : percent > usage.MAX_BASELINE_PERCENT ? 'capped'
              : cycle.rebased ? 'waiting-delta' : 'insufficient-log';
    if (row.status === 'estimated') {
      row.sample = cycle.sample;
      row.totalUSD = cycle.sample.totalUSD;
      // Both figures describe the same snapshot; post-snapshot traffic is
      // included in spentUSD but cannot be assigned an invented percentage.
      row.remainingUSD = row.totalUSD * (100 - percent) / 100;
    }
  }

  state.cycles.sort((a, b) => b.resetsAt - a.resetsAt);
  state.cycles = state.cycles.slice(0, MAX_CYCLES);
  const measurement = updateMeasurement(state, base, allEvents, rows, rates, options);
  for (const row of rows) row.statusText = STATUS[row.status];
  return {
    data: {
      now, plan: base.plan, snapshotFetchedAt: fetchedAt, snapshotSource: base.snapshotSource,
      priceSource: PRICE_SOURCE, pricingKey: identity, coverage: 'local-transcripts-only',
      windows: rows, accountKnown: Boolean(base.accountId),
      measurement: measurement.current, measurements: measurement.history,
      history: state.cycles.filter((entry) => entry.resetsAt <= now && entry.sample).map((entry) => ({
        key: entry.key, resetsAt: entry.resetsAt, totalUSD: entry.sample.totalUSD,
        method: entry.sample.method, points: entry.sample.points, measuredAt: entry.sample.at,
      })),
    },
    state,
  };
}

const STATUS = {
  'no-snapshot': '没有可读额度；请先在 Claude Code 中运行 /usage',
  unanchored: '缺少服务端重置时间，无法确定额度周期',
  'rolled-over': '快照所属周期已经结束，等待新快照',
  'invalid-time': '缺少有效的快照时间，无法对齐 token 与额度',
  stale: '额度快照超过 10 分钟，暂停显示当前容量估值',
  'partial-scan': '日志尚未扫描完整，暂停估算',
  'older-reading': '读到较旧的快照，等待更新',
  'meter-decreased': '同周期额度读数下降，重新采样',
  'waiting-delta': '等待重新采样后至少 5 个百分点的真实消耗',
  'unknown-prices': '存在未知模型价格；请用 --prices 补充',
  'low-percent': '消耗不足 5%，等待更多样本',
  capped: '接近或达到封顶，不能据此反推总容量',
  'insufficient-log': '本周期缺少至少 5 次可计价调用',
  estimated: '根据本机用量估算',
};

const REFRESH = {
  live: 'OAuth 额度已更新', fresh: '使用近期快照', 'local-only': '仅本地数据',
  disabled: '已禁止联网', offline: '网络不可用，使用本地数据', backoff: '请求退避中',
  no_credentials: '缺少 Claude OAuth 凭据', expired: '登录已过期，等待 Claude Code 续期',
  unauthorized: '登录已失效，请重新登录 Claude Code', forbidden: '此登录无法读取额度',
  rate_limited: '额度接口限流', server: '额度服务暂不可用', http: '额度请求失败',
  bad_response: '额度接口响应不可读',
  desktop_keyring_locked: '请在 Linux 桌面会话中解锁登录钥匙串',
  desktop_dependencies: 'Desktop 接入需要 Python 3、python3-dbus 和 python3-cryptography',
};

function money(value) {
  return Number.isFinite(value) ? '$' + value.toFixed(2) : '待采样';
}

function render(data) {
  const lines = [
    'Claude 订阅额度的 API 等价价值（USD）',
    '套餐：' + data.plan + ' | 快照：' + (Number.isFinite(data.snapshotFetchedAt) ? new Date(data.snapshotFetchedAt).toLocaleString() : '无'),
    '刷新：' + (REFRESH[data.refresh] || '本地数据'),
    '',
  ];
  for (const row of data.windows) {
    const t = row.tokenParts;
    lines.push(row.key === 'five_hour' ? '5 小时额度' : '每周额度');
    lines.push('  已用：' + (row.percentUsed === null ? '未知' : row.percentUsed + '%') + ' | 重置：' + (row.resetsAt === null ? '未知' : new Date(row.resetsAt).toLocaleString()));
    const scope = row.resetsAt === null ? (row.key === 'five_hour' ? '本地近 5 小时' : '本地近 7 天') : '本周期';
    lines.push('  ' + scope + ' token：' + usage.formatCount(row.spentTokens) + ' | API 等价已用：' + money(row.spentUSD) + (row.unknownModels.length ? '（含估价）' : ''));
    lines.push('  输入 ' + usage.formatCount(t.input) + ' / 缓存写入 ' + usage.formatCount(t.cacheWrite) + ' / 缓存读取 ' + usage.formatCount(t.cacheRead) + ' / 输出 ' + usage.formatCount(t.output));
    lines.push('  预计总价值：' + money(row.totalUSD) + ' | 快照时预计剩余：' + money(row.remainingUSD));
    lines.push('  状态：' + STATUS[row.status]);
    if (row.sample) lines.push('  样本：' + (row.sample.method === 'observed-delta' ? '两次真实读数的增量' : '周期累计，假设日志覆盖全部消耗') + ' / ' + row.sample.points + ' 个百分点 / ' + row.sample.calls + ' 次调用 / ' + new Date(row.sample.at).toLocaleString());
    for (const model of row.models) {
      lines.push('    ' + model.model + '：' + usage.formatCount(model.tokens) + ' token，' + money(model.cost) + (model.estimated ? '（价格待确认）' : ''));
    }
    lines.push('');
  }
  if (data.history.length) {
    lines.push('已观察的历史周期（最近 6 个）');
    for (const entry of data.history.slice(0, 6)) {
      lines.push('  ' + (entry.key === 'five_hour' ? '5h' : '每周') + ' / ' + new Date(entry.resetsAt).toLocaleString() + ' / ' + money(entry.totalUSD));
    }
    lines.push('');
  }
  if (data.persistence === false) lines.push('历史记录写入失败；本次读数仍可查看。');
  lines.push('估值不是额外账单；只覆盖本机日志，其他设备或普通 Chat 的消耗会影响反推。');
  lines.push('估值对应采样时的模型与缓存组合；使用组合变化后，API 等价容量也会变化。');
  lines.push('总价值和剩余价值按额度快照时间计算；token 与已用费用包含快照之后的新调用。');
  if (data.measurement) lines.push('完整测量：' + MEASUREMENT_PHASES[data.measurement.phase] + '，本次 API 等价消耗 ' + money(data.measurement.spent.usd));
  return lines.join('\n');
}

async function collect(options) {
  const opts = options || {};
  usage.setHost('claude');
  const rates = loadPrices(opts.prices);
  const accountId = usage.accountUuid();
  let base = usage.collectClaude(Date.now());
  let refresh = { skipped: 'local-only', outcome: null };
  if (!opts.offline) {
    const request = { cacheFetchedAtMs: base.snapshotFetchedAt, accountUuid: accountId, timeoutMs: 15000 };
    refresh = opts.refresh || opts.measureStart ? await live.refresh(request) : await live.refreshIfStale(request);
  }
  base = Object.assign(usage.collectClaude(Date.now()), { accountId: usage.accountUuid() });
  if (opts.measureStart && !base.accountId) throw new Error('无法识别当前 Claude 账号，请先登录并刷新额度。');
  const events = await usage.readClaudeEvents(base.now - 8 * DAY, { rates });
  // The GUI and the background sampler share a read-modify-write transaction.
  // Atomic rename alone would let one process erase another's measurement click.
  const lock = stateFile() + '.lock';
  fs.mkdirSync(path.dirname(stateFile()), { recursive: true });
  let held = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { fs.mkdirSync(lock); held = true; break; } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      try { if (Date.now() - fs.statSync(lock).mtimeMs > MINUTE) fs.rmdirSync(lock); } catch (ignored) { /* Another writer released it. */ }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  if (!held) throw new Error('另一个窗口正在保存统计，请稍后重试。');
  try {
    let previous = null;
    try { previous = JSON.parse(fs.readFileSync(stateFile(), 'utf8')); } catch (err) { /* First observation. */ }
    const result = buildReport(base, events, previous, rates, Object.assign({}, opts, { freshlyFetched: Boolean(refresh.outcome && refresh.outcome.ok) }));
    result.data.refresh = refresh.outcome ? (refresh.outcome.ok ? 'live' : refresh.outcome.kind) : refresh.skipped;
    result.data.persistence = usage.writeJsonAtomic(stateFile(), result.state);
    return result.data;
  } finally {
    fs.rmdirSync(lock);
  }
}

async function main(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') options.json = true;
    else if (arg === '--offline') options.offline = true;
    else if (arg === '--refresh') options.refresh = true;
    else if (arg === '--measure-start') options.measureStart = true;
    else if (arg === '--measure-stop') options.measureStop = true;
    else if (arg === '--prices' && argv[i + 1] && !argv[i + 1].startsWith('--')) options.prices = argv[++i];
    else if (arg === '--host' && argv[i + 1] === 'claude') i++;
    else throw new Error('value: unsupported or incomplete option ' + arg + '; use --json, --refresh, --offline, --prices FILE or --host claude');
  }
  if (options.refresh && options.offline) throw new Error('value: --refresh and --offline cannot be combined');
  if (options.measureStart && (options.measureStop || options.offline)) throw new Error('value: --measure-start needs online usage and cannot be combined with --measure-stop');
  const data = await collect(options);
  process.stdout.write((options.json ? JSON.stringify(data, null, 2) : render(data)) + '\n');
  return options.refresh && data.refresh !== 'live' ? 1 : 0;
}

module.exports = { main, collect, buildReport, render, loadPrices, stateFile, MAX_SNAPSHOT_AGE, MAX_CYCLES };

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (err) => {
    process.stderr.write('quota-value: ' + err.message + '\n');
    process.exitCode = 1;
  });
}
