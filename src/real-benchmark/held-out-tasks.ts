import { RealCodingTask } from './tasks-30.js';

/**
 * 5 Distinct Multi-File Repository Architectures for the Frozen Held-Out Evaluation Set.
 * Each repository contains realistic domain modules so context discovery and ranking are tested
 * across diverse directory structures and naming conventions.
 */
export const HELD_OUT_REPOS: Record<string, Record<string, string>> = {
  'repo-fintech-ledger': {
    'src/audit/trail.mjs': `export function formatAuditLog(actor, action, amount) {\n  return \`[\${actor}] \${action}: \${amount}\`;\n}\n`,
    'src/fx/symbols.mjs': `export const CURRENCY_SYMBOLS = { USD: '$', EUR: '€', GBP: '£', JPY: '¥' };\nexport function getCurrencySymbol(code) {\n  return CURRENCY_SYMBOLS[code] ?? code;\n}\n`,
    'src/ledger/constants.mjs': `export const MAX_SINGLE_WIRE_USD = 250000;\nexport const DEFAULT_CURRENCY = 'USD';\n`,
    'src/tax/vat.mjs': `export function calculateEuVat(netAmount, vatRate = 0.2) {\n  return Number((netAmount * vatRate).toFixed(2));\n}\n`,
    'src/ledger/reconcile.mjs': `export function isBalanced(debits, credits) {\n  return Math.abs(debits - credits) < 0.001;\n}\n`,
    'README.md': `# FinTech Ledger & Settlement Service\n\nRun \`npm test\` to execute the verification suite.\n`,
  },
  'repo-http-gateway': {
    'src/middleware/cors.mjs': `export function buildCorsHeaders(origin = '*') {\n  return { 'access-control-allow-origin': origin, 'access-control-allow-methods': 'GET,POST,PUT,DELETE' };\n}\n`,
    'src/headers/etag.mjs': `export function formatWeakEtag(hash) {\n  return \`W/"\${hash}"\`;\n}\n`,
    'src/router/methods.mjs': `export const ALLOWED_HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];\nexport function isSafeHttpMethod(m) {\n  return m === 'GET' || m === 'HEAD' || m === 'OPTIONS';\n}\n`,
    'src/ratelimit/constants.mjs': `export const DEFAULT_WINDOW_SEC = 60;\nexport const DEFAULT_BURST_CAPACITY = 100;\n`,
    'src/middleware/forwarded.mjs': `export function extractClientIp(xffHeader) {\n  if (!xffHeader) return '127.0.0.1';\n  return String(xffHeader).split(',')[0].trim();\n}\n`,
    'README.md': `# API Gateway & Routing Layer\n\nRun \`npm test\` to execute the verification suite.\n`,
  },
  'repo-workflow-dag': {
    'src/cron/parser.mjs': `export function isWildcardField(field) {\n  return String(field).trim() === '*';\n}\n`,
    'src/dag/types.mjs': `export const STEP_STATES = ['PENDING', 'RUNNING', 'PASSED', 'FAILED', 'SKIPPED'];\n`,
    'src/queue/dlq.mjs': `export class DeadLetterQueue {\n  constructor() { this.items = []; }\n  push(item, reason) { this.items.push({ item, reason }); }\n  size() { return this.items.length; }\n}\n`,
    'src/retry/policy.mjs': `export function shouldRetryExitCode(code) {\n  return code === 429 || code === 502 || code === 503 || code === 504;\n}\n`,
    'src/dag/clock.mjs': `export function elapsedSeconds(startMs, endMs) {\n  return Math.max(0, Math.round((endMs - startMs) / 1000));\n}\n`,
    'README.md': `# Workflow DAG & Task Scheduler\n\nRun \`npm test\` to execute the verification suite.\n`,
  },
  'repo-schema-sanitizer': {
    'src/env/loader.mjs': `export function parseBooleanFlag(raw) {\n  const norm = String(raw ?? '').trim().toLowerCase();\n  return norm === 'true' || norm === '1' || norm === 'yes';\n}\n`,
    'src/format/date.mjs': `export function toYmdDate(isoStr) {\n  return String(isoStr).slice(0, 10);\n}\n`,
    'src/schema/errors.mjs': `export class ValidationError extends Error {\n  constructor(field, reason) {\n    super(\`\${field}: \${reason}\`);\n    this.field = field;\n  }\n}\n`,
    'src/sanitize/phone.mjs': `export function stripPhoneFormatting(raw) {\n  return String(raw).replace(/[^0-9+]/g, '');\n}\n`,
    'src/sanitize/whitespace.mjs': `export function collapseSpaces(str) {\n  return String(str).trim().replace(/\\s+/g, ' ');\n}\n`,
    'README.md': `# Schema Validator & Input Sanitizer\n\nRun \`npm test\` to execute the verification suite.\n`,
  },
  'repo-search-analytics': {
    'src/index/stopwords.mjs': `export const DEFAULT_STOPWORDS = new Set(['a', 'an', 'the', 'of', 'in', 'on', 'for', 'to']);\nexport function isStopword(word) {\n  return DEFAULT_STOPWORDS.has(String(word).toLowerCase());\n}\n`,
    'src/metrics/timer.mjs': `export function msToSeconds(ms) {\n  return Number((ms / 1000).toFixed(3));\n}\n`,
    'src/ranking/weights.mjs': `export const FIELD_WEIGHTS = { title: 3.0, summary: 1.5, body: 1.0 };\n`,
    'src/search/cursor.mjs': `export function encodeCursor(offset) {\n  return Buffer.from(\`cursor:\${offset}\`, 'utf8').toString('base64');\n}\n`,
    'src/metrics/counter.mjs': `export function computeRate(count, durationSec) {\n  if (durationSec <= 0) return 0;\n  return Number((count / durationSec).toFixed(2));\n}\n`,
    'README.md': `# Search Indexing & Analytics Engine\n\nRun \`npm test\` to execute the verification suite.\n`,
  },
};

/**
 * Frozen Held-Out Test Set (15 Unseen Tasks across 5 Distinct Multi-File Repositories).
 * Never used to tune ranking weights or prompt templates.
 */
export const HELD_OUT_TASKS_15: RealCodingTask[] = [
  // ==================== REPO 1: FINTECH LEDGER (ho_01 - ho_03) ====================
  {
    id: 'ho_01_compound_interest_rounding',
    repoId: 'repo-fintech-ledger',
    repoFiles: HELD_OUT_REPOS['repo-fintech-ledger'],
    category: 'bugfix',
    title: 'Fix daily compound interest rate division and 2-decimal rounding',
    prompt:
      'Fix `computeDailyCompound(principal, annualRate, days)` in `src/ledger/interest.mjs` where the daily factor uses `(1 + annualRate)` instead of `(1 + annualRate / 365)` and round the returned amount to 2 decimal places using `Number(result.toFixed(2))`.',
    targetFiles: ['src/ledger/interest.mjs'],
    initialFiles: {
      'src/ledger/interest.mjs': `export function computeDailyCompound(principal, annualRate, days) {
  if (principal <= 0 || days <= 0) return principal;
  const total = principal * Math.pow(1 + annualRate, days);
  return total;
}
`,
    },
    workspaceTestFile: `import test from 'node:test';
import assert from 'node:assert/strict';
import { computeDailyCompound } from '../src/ledger/interest.mjs';

test('computeDailyCompound divides annualRate by 365 and rounds to 2 decimals', () => {
  assert.equal(computeDailyCompound(1000, 0.05, 365), 1051.27);
});
`,
    heldOutOracleTestCode: `import test from 'node:test';
import assert from 'node:assert/strict';
import { computeDailyCompound } from '../src/ledger/interest.mjs';

test('Oracle: computeDailyCompound handles 365 days, 30 days, and zero days', () => {
  assert.equal(computeDailyCompound(1000, 0.05, 365), 1051.27);
  assert.equal(computeDailyCompound(5000, 0.0365, 30), 5015.02);
  assert.equal(computeDailyCompound(1000, 0.05, 0), 1000);
});
`,
  },
  {
    id: 'ho_02_ledger_overdraft_guard',
    repoId: 'repo-fintech-ledger',
    repoFiles: HELD_OUT_REPOS['repo-fintech-ledger'],
    category: 'validation',
    title: 'Enforce positive amount and overdraft guard in applyTransfer',
    prompt:
      'Update `applyTransfer(fromBalance, toBalance, amount)` in `src/ledger/transfer.mjs` to throw `new Error("Invalid transfer amount")` if `amount <= 0` and throw `new Error("Insufficient funds")` if `amount > fromBalance`.',
    targetFiles: ['src/ledger/transfer.mjs'],
    initialFiles: {
      'src/ledger/transfer.mjs': `export function applyTransfer(fromBalance, toBalance, amount) {
  return {
    fromBalance: fromBalance - amount,
    toBalance: toBalance + amount,
  };
}
`,
    },
    workspaceTestFile: `import test from 'node:test';
import assert from 'node:assert/strict';
import { applyTransfer } from '../src/ledger/transfer.mjs';

test('applyTransfer validates positive amount and sufficient funds', () => {
  assert.deepEqual(applyTransfer(100, 50, 40), { fromBalance: 60, toBalance: 90 });
  assert.throws(() => applyTransfer(100, 50, 0), /Invalid transfer amount/);
  assert.throws(() => applyTransfer(30, 50, 40), /Insufficient funds/);
});
`,
    heldOutOracleTestCode: `import test from 'node:test';
import assert from 'node:assert/strict';
import { applyTransfer } from '../src/ledger/transfer.mjs';

test('Oracle: applyTransfer handles exact balance, overdraft, and negative amounts', () => {
  assert.deepEqual(applyTransfer(75, 25, 75), { fromBalance: 0, toBalance: 100 });
  assert.throws(() => applyTransfer(75, 25, -10), /Invalid transfer amount/);
  assert.throws(() => applyTransfer(75, 25, 76), /Insufficient funds/);
});
`,
  },
  {
    id: 'ho_03_fx_cross_conversion',
    repoId: 'repo-fintech-ledger',
    repoFiles: HELD_OUT_REPOS['repo-fintech-ledger'],
    category: 'multi_file',
    title: 'Add CHF rate to USD_RATES and round convertCurrency to 2 decimals',
    prompt:
      'In `src/fx/rates.mjs`, add `CHF: 0.9` to `USD_RATES`. In `src/fx/converter.mjs`, update `convertCurrency(amount, fromCode, toCode)` so the returned value is rounded to 2 decimal places using `Number(val.toFixed(2))`.',
    targetFiles: ['src/fx/rates.mjs', 'src/fx/converter.mjs'],
    initialFiles: {
      'src/fx/rates.mjs': `export const USD_RATES = {
  USD: 1.0,
  EUR: 0.8,
  GBP: 0.75,
};
`,
      'src/fx/converter.mjs': `import { USD_RATES } from './rates.mjs';

export function convertCurrency(amount, fromCode, toCode) {
  const fromRate = USD_RATES[fromCode];
  const toRate = USD_RATES[toCode];
  if (!fromRate || !toRate) {
    throw new Error('Unsupported currency');
  }
  const inUsd = amount / fromRate;
  return inUsd * toRate;
}
`,
    },
    workspaceTestFile: `import test from 'node:test';
import assert from 'node:assert/strict';
import { convertCurrency } from '../src/fx/converter.mjs';

test('convertCurrency supports CHF and rounds to 2 decimals', () => {
  assert.equal(convertCurrency(100, 'USD', 'CHF'), 90);
  assert.equal(convertCurrency(100, 'GBP', 'EUR'), 106.67);
});
`,
    heldOutOracleTestCode: `import test from 'node:test';
import assert from 'node:assert/strict';
import { USD_RATES } from '../src/fx/rates.mjs';
import { convertCurrency } from '../src/fx/converter.mjs';

test('Oracle: CHF rate and cross-currency rounding', () => {
  assert.equal(USD_RATES.CHF, 0.9);
  assert.equal(convertCurrency(90, 'CHF', 'EUR'), 80);
  assert.equal(convertCurrency(50, 'GBP', 'CHF'), 60);
  assert.equal(convertCurrency(10, 'GBP', 'USD'), 13.33);
});
`,
  },

  // ==================== REPO 2: HTTP GATEWAY (ho_04 - ho_06) ====================
  {
    id: 'ho_04_token_bucket_refill',
    repoId: 'repo-http-gateway',
    repoFiles: HELD_OUT_REPOS['repo-http-gateway'],
    category: 'bugfix',
    title: 'Cap refillTokens at bucket capacity',
    prompt:
      'Fix `refillTokens(currentTokens, capacity, refillAmount)` in `src/ratelimit/bucket.mjs` so the returned token count is capped at `capacity` using `Math.min(capacity, currentTokens + Math.max(0, refillAmount))`.',
    targetFiles: ['src/ratelimit/bucket.mjs'],
    initialFiles: {
      'src/ratelimit/bucket.mjs': `export function refillTokens(currentTokens, capacity, refillAmount) {
  return currentTokens + refillAmount;
}
`,
    },
    workspaceTestFile: `import test from 'node:test';
import assert from 'node:assert/strict';
import { refillTokens } from '../src/ratelimit/bucket.mjs';

test('refillTokens caps token count at capacity', () => {
  assert.equal(refillTokens(80, 100, 50), 100);
  assert.equal(refillTokens(40, 100, 25), 65);
});
`,
    heldOutOracleTestCode: `import test from 'node:test';
import assert from 'node:assert/strict';
import { refillTokens } from '../src/ratelimit/bucket.mjs';

test('Oracle: refillTokens caps at capacity and ignores negative refill amounts', () => {
  assert.equal(refillTokens(95, 100, 20), 100);
  assert.equal(refillTokens(10, 50, 15), 25);
  assert.equal(refillTokens(30, 50, -5), 30);
});
`,
  },
  {
    id: 'ho_05_route_param_matcher',
    repoId: 'repo-http-gateway',
    repoFiles: HELD_OUT_REPOS['repo-http-gateway'],
    category: 'feature',
    title: 'Extract named :param segments in extractPathParams',
    prompt:
      'Implement `extractPathParams(pattern, actualPath)` in `src/router/matcher.mjs` so dynamic `:param` segments are returned as key-value pairs (e.g. `pattern = "/orgs/:orgId/users/:userId"` and `actualPath = "/orgs/acme/users/42"` returns `{ orgId: "acme", userId: "42" }`), and return `null` if segment counts or static segments do not match.',
    targetFiles: ['src/router/matcher.mjs'],
    initialFiles: {
      'src/router/matcher.mjs': `export function extractPathParams(pattern, actualPath) {
  const patParts = String(pattern).split('/').filter(Boolean);
  const pathParts = String(actualPath).split('/').filter(Boolean);
  if (patParts.length !== pathParts.length) return null;
  const params = {};
  return params;
}
`,
    },
    workspaceTestFile: `import test from 'node:test';
import assert from 'node:assert/strict';
import { extractPathParams } from '../src/router/matcher.mjs';

test('extractPathParams extracts named parameters and rejects mismatched paths', () => {
  assert.deepEqual(extractPathParams('/users/:id', '/users/42'), { id: '42' });
  assert.equal(extractPathParams('/users/:id', '/posts/42'), null);
});
`,
    heldOutOracleTestCode: `import test from 'node:test';
import assert from 'node:assert/strict';
import { extractPathParams } from '../src/router/matcher.mjs';

test('Oracle: extractPathParams handles multiple params and mismatched lengths', () => {
  assert.deepEqual(
    extractPathParams('/orgs/:orgId/repos/:repo', '/orgs/deepmind/repos/agentopt'),
    { orgId: 'deepmind', repo: 'agentopt' }
  );
  assert.equal(extractPathParams('/orgs/:orgId/repos', '/orgs/deepmind/issues'), null);
  assert.equal(extractPathParams('/orgs/:orgId', '/orgs/deepmind/extra'), null);
});
`,
  },
  {
    id: 'ho_06_bearer_scope_check',
    repoId: 'repo-http-gateway',
    repoFiles: HELD_OUT_REPOS['repo-http-gateway'],
    category: 'multi_file',
    title: 'Trim bearer token in parseAuthHeader and verify scope in authorizeRequest',
    prompt:
      'In `src/middleware/bearer.mjs`, update `parseAuthHeader(header)` to `.trim()` the extracted token after `"Bearer "`. In `src/middleware/guard.mjs`, update `authorizeRequest(header, requiredScope, tokenScopesMap)` to return `true` only when `tokenScopesMap[token]` is an array that `.includes(requiredScope)`.',
    targetFiles: ['src/middleware/bearer.mjs', 'src/middleware/guard.mjs'],
    initialFiles: {
      'src/middleware/bearer.mjs': `export function parseAuthHeader(header) {
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
    return null;
  }
  return header.slice(7);
}
`,
      'src/middleware/guard.mjs': `import { parseAuthHeader } from './bearer.mjs';

export function authorizeRequest(header, requiredScope, tokenScopesMap) {
  const token = parseAuthHeader(header);
  if (!token || !tokenScopesMap) return false;
  const scopes = tokenScopesMap[token];
  return Boolean(scopes);
}
`,
    },
    workspaceTestFile: `import test from 'node:test';
import assert from 'node:assert/strict';
import { authorizeRequest } from '../src/middleware/guard.mjs';

test('authorizeRequest trims bearer token and verifies requiredScope', () => {
  const map = { tok_1: ['read:users', 'write:users'] };
  assert.equal(authorizeRequest('Bearer   tok_1  ', 'write:users', map), true);
  assert.equal(authorizeRequest('Bearer tok_1', 'admin:all', map), false);
});
`,
    heldOutOracleTestCode: `import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAuthHeader } from '../src/middleware/bearer.mjs';
import { authorizeRequest } from '../src/middleware/guard.mjs';

test('Oracle: parseAuthHeader and authorizeRequest enforce exact scope membership', () => {
  assert.equal(parseAuthHeader('Bearer  abc_123 '), 'abc_123');
  const map = { abc_123: ['billing:read'] };
  assert.equal(authorizeRequest('Bearer  abc_123 ', 'billing:read', map), true);
  assert.equal(authorizeRequest('Bearer abc_123', 'billing:write', map), false);
  assert.equal(authorizeRequest('Basic xyz', 'billing:read', map), false);
});
`,
  },

  // ==================== REPO 3: WORKFLOW DAG (ho_07 - ho_09) ====================
  {
    id: 'ho_07_priority_queue_order',
    repoId: 'repo-workflow-dag',
    repoFiles: HELD_OUT_REPOS['repo-workflow-dag'],
    category: 'bugfix',
    title: 'Fix PriorityTaskQueue sort order so highest priority dequeues first',
    prompt:
      'Fix `PriorityTaskQueue.enqueue(name, priority)` in `src/queue/priority.mjs` where items are sorted ascending (`a.priority - b.priority`) instead of descending (`b.priority - a.priority`) so `dequeue()` returns the highest-priority task name first.',
    targetFiles: ['src/queue/priority.mjs'],
    initialFiles: {
      'src/queue/priority.mjs': `export class PriorityTaskQueue {
  constructor() {
    this.items = [];
  }

  enqueue(name, priority = 0) {
    this.items.push({ name, priority });
    this.items.sort((a, b) => a.priority - b.priority);
  }

  dequeue() {
    const next = this.items.shift();
    return next ? next.name : null;
  }
}
`,
    },
    workspaceTestFile: `import test from 'node:test';
import assert from 'node:assert/strict';
import { PriorityTaskQueue } from '../src/queue/priority.mjs';

test('PriorityTaskQueue dequeues highest priority item first', () => {
  const q = new PriorityTaskQueue();
  q.enqueue('low', 1);
  q.enqueue('critical', 10);
  q.enqueue('medium', 5);
  assert.equal(q.dequeue(), 'critical');
  assert.equal(q.dequeue(), 'medium');
});
`,
    heldOutOracleTestCode: `import test from 'node:test';
import assert from 'node:assert/strict';
import { PriorityTaskQueue } from '../src/queue/priority.mjs';

test('Oracle: PriorityTaskQueue ordering and empty queue handling', () => {
  const q = new PriorityTaskQueue();
  q.enqueue('t1', 2);
  q.enqueue('t2', 99);
  q.enqueue('t3', 50);
  assert.equal(q.dequeue(), 't2');
  assert.equal(q.dequeue(), 't3');
  assert.equal(q.dequeue(), 't1');
  assert.equal(q.dequeue(), null);
});
`,
  },
  {
    id: 'ho_08_dedup_event_window',
    repoId: 'repo-workflow-dag',
    repoFiles: HELD_OUT_REPOS['repo-workflow-dag'],
    category: 'algorithms',
    title: 'Deduplicate workflow events by id preserving first occurrence order',
    prompt:
      'Implement `deduplicateEvents(events)` in `src/dag/dedup.mjs` so duplicate events with the same `event.id` are filtered out while preserving the first occurrence in original array order.',
    targetFiles: ['src/dag/dedup.mjs'],
    initialFiles: {
      'src/dag/dedup.mjs': `export function deduplicateEvents(events) {
  if (!Array.isArray(events)) return [];
  return events;
}
`,
    },
    workspaceTestFile: `import test from 'node:test';
import assert from 'node:assert/strict';
import { deduplicateEvents } from '../src/dag/dedup.mjs';

test('deduplicateEvents keeps first event per id', () => {
  const input = [
    { id: 'e1', seq: 1 },
    { id: 'e2', seq: 2 },
    { id: 'e1', seq: 3 },
  ];
  assert.deepEqual(deduplicateEvents(input), [
    { id: 'e1', seq: 1 },
    { id: 'e2', seq: 2 },
  ]);
});
`,
    heldOutOracleTestCode: `import test from 'node:test';
import assert from 'node:assert/strict';
import { deduplicateEvents } from '../src/dag/dedup.mjs';

test('Oracle: deduplicateEvents preserves first occurrence and handles empty input', () => {
  const list = [
    { id: 'a', v: 10 },
    { id: 'b', v: 20 },
    { id: 'a', v: 30 },
    { id: 'c', v: 40 },
    { id: 'b', v: 50 },
  ];
  assert.deepEqual(deduplicateEvents(list), [
    { id: 'a', v: 10 },
    { id: 'b', v: 20 },
    { id: 'c', v: 40 },
  ]);
  assert.deepEqual(deduplicateEvents([]), []);
});
`,
  },
  {
    id: 'ho_09_pipeline_step_status',
    repoId: 'repo-workflow-dag',
    repoFiles: HELD_OUT_REPOS['repo-workflow-dag'],
    category: 'multi_file',
    title: 'Format step status as PASS/FAIL and join pipeline summary with arrows',
    prompt:
      'In `src/dag/formatter.mjs`, update `formatStepResult(name, ok)` to return `"${name}:PASS"` when `ok` is true and `"${name}:FAIL"` when `ok` is false. In `src/dag/runner.mjs`, update `summarizePipeline(steps)` to join the formatted steps with `" -> "` instead of `","`.',
    targetFiles: ['src/dag/formatter.mjs', 'src/dag/runner.mjs'],
    initialFiles: {
      'src/dag/formatter.mjs': `export function formatStepResult(name, ok) {
  return \`\${name}:\${ok ? 'OK' : 'ERR'}\`;
}
`,
      'src/dag/runner.mjs': `import { formatStepResult } from './formatter.mjs';

export function summarizePipeline(steps) {
  if (!Array.isArray(steps) || steps.length === 0) return '';
  return steps.map((s) => formatStepResult(s.name, s.ok)).join(',');
}
`,
    },
    workspaceTestFile: `import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizePipeline } from '../src/dag/runner.mjs';

test('summarizePipeline formats PASS/FAIL and joins with arrow', () => {
  const steps = [
    { name: 'build', ok: true },
    { name: 'test', ok: false },
  ];
  assert.equal(summarizePipeline(steps), 'build:PASS -> test:FAIL');
});
`,
    heldOutOracleTestCode: `import test from 'node:test';
import assert from 'node:assert/strict';
import { formatStepResult } from '../src/dag/formatter.mjs';
import { summarizePipeline } from '../src/dag/runner.mjs';

test('Oracle: formatStepResult and summarizePipeline multi-step formatting', () => {
  assert.equal(formatStepResult('lint', true), 'lint:PASS');
  assert.equal(formatStepResult('deploy', false), 'deploy:FAIL');
  assert.equal(
    summarizePipeline([
      { name: 'lint', ok: true },
      { name: 'unit', ok: true },
      { name: 'e2e', ok: false },
    ]),
    'lint:PASS -> unit:PASS -> e2e:FAIL'
  );
});
`,
  },

  // ==================== REPO 4: SCHEMA SANITIZER (ho_10 - ho_12) ====================
  {
    id: 'ho_10_html_escape_quotes',
    repoId: 'repo-schema-sanitizer',
    repoFiles: HELD_OUT_REPOS['repo-schema-sanitizer'],
    category: 'bugfix',
    title: 'Escape double quotes as &quot; in escapeHtmlAttr',
    prompt:
      'Fix `escapeHtmlAttr(str)` in `src/sanitize/html.mjs` so double quotes `"` are also replaced with `"&quot;"` after escaping `&`, `<`, and `>`.',
    targetFiles: ['src/sanitize/html.mjs'],
    initialFiles: {
      'src/sanitize/html.mjs': `export function escapeHtmlAttr(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
`,
    },
    workspaceTestFile: `import test from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtmlAttr } from '../src/sanitize/html.mjs';

test('escapeHtmlAttr escapes double quotes as &quot;', () => {
  assert.equal(escapeHtmlAttr('a "quoted" <tag>'), 'a &quot;quoted&quot; &lt;tag&gt;');
});
`,
    heldOutOracleTestCode: `import test from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtmlAttr } from '../src/sanitize/html.mjs';

test('Oracle: escapeHtmlAttr escapes &, <, >, and "', () => {
  assert.equal(
    escapeHtmlAttr('"hello" & <world>'),
    '&quot;hello&quot; &amp; &lt;world&gt;'
  );
});
`,
  },
  {
    id: 'ho_11_mask_credit_card',
    repoId: 'repo-schema-sanitizer',
    repoFiles: HELD_OUT_REPOS['repo-schema-sanitizer'],
    category: 'validation',
    title: 'Mask all digits except last 4 in maskCardNumber',
    prompt:
      'Fix `maskCardNumber(cardStr)` in `src/sanitize/card.mjs` so spaces and hyphens are stripped first, and all digits except the last 4 are replaced with `"*"` (`"*".repeat(digits.length - 4) + digits.slice(-4)`), returning `""` if fewer than 4 digits exist.',
    targetFiles: ['src/sanitize/card.mjs'],
    initialFiles: {
      'src/sanitize/card.mjs': `export function maskCardNumber(cardStr) {
  const digits = String(cardStr ?? '').replace(/[\\s-]/g, '');
  if (digits.length < 4) return '';
  return digits.slice(-4);
}
`,
    },
    workspaceTestFile: `import test from 'node:test';
import assert from 'node:assert/strict';
import { maskCardNumber } from '../src/sanitize/card.mjs';

test('maskCardNumber masks leading digits with asterisks', () => {
  assert.equal(maskCardNumber('4111-2222-3333-4444'), '************4444');
  assert.equal(maskCardNumber('123'), '');
});
`,
    heldOutOracleTestCode: `import test from 'node:test';
import assert from 'node:assert/strict';
import { maskCardNumber } from '../src/sanitize/card.mjs';

test('Oracle: maskCardNumber handles 16-digit, 15-digit Amex, and 4-digit inputs', () => {
  assert.equal(maskCardNumber('4111 2222 3333 9876'), '************9876');
  assert.equal(maskCardNumber('3782-822463-10005'), '***********0005');
  assert.equal(maskCardNumber('9999'), '9999');
  assert.equal(maskCardNumber('12'), '');
});
`,
  },
  {
    id: 'ho_12_schema_required_fields',
    repoId: 'repo-schema-sanitizer',
    repoFiles: HELD_OUT_REPOS['repo-schema-sanitizer'],
    category: 'multi_file',
    title: 'Reject whitespace-only strings in isNonEmptyValue and return missing keys in validateRequiredFields',
    prompt:
      'In `src/schema/predicates.mjs`, update `isNonEmptyValue(val)` so strings that are empty after `.trim()` return `false`. In `src/schema/validator.mjs`, update `validateRequiredFields(record, requiredKeys)` to return an array of keys from `requiredKeys` where `!isNonEmptyValue(record[key])`.',
    targetFiles: ['src/schema/predicates.mjs', 'src/schema/validator.mjs'],
    initialFiles: {
      'src/schema/predicates.mjs': `export function isNonEmptyValue(val) {
  if (val === null || val === undefined) return false;
  return true;
}
`,
      'src/schema/validator.mjs': `import { isNonEmptyValue } from './predicates.mjs';

export function validateRequiredFields(record, requiredKeys) {
  const missing = [];
  for (const key of requiredKeys) {
    if (!isNonEmptyValue(record?.[key])) {
      // TODO: push missing key
    }
  }
  return missing;
}
`,
    },
    workspaceTestFile: `import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRequiredFields } from '../src/schema/validator.mjs';

test('validateRequiredFields detects null, undefined, and whitespace-only strings', () => {
  const rec = { name: 'Ada', email: '   ', role: null };
  assert.deepEqual(validateRequiredFields(rec, ['name', 'email', 'role']), ['email', 'role']);
});
`,
    heldOutOracleTestCode: `import test from 'node:test';
import assert from 'node:assert/strict';
import { isNonEmptyValue } from '../src/schema/predicates.mjs';
import { validateRequiredFields } from '../src/schema/validator.mjs';

test('Oracle: isNonEmptyValue and validateRequiredFields edge cases', () => {
  assert.equal(isNonEmptyValue('  '), false);
  assert.equal(isNonEmptyValue('ok'), true);
  assert.equal(isNonEmptyValue(0), true);
  assert.deepEqual(
    validateRequiredFields({ a: 'x', b: '', c: undefined, d: 0 }, ['a', 'b', 'c', 'd']),
    ['b', 'c']
  );
});
`,
  },

  // ==================== REPO 5: SEARCH ANALYTICS (ho_13 - ho_15) ====================
  {
    id: 'ho_13_jaccard_similarity_empty',
    repoId: 'repo-search-analytics',
    repoFiles: HELD_OUT_REPOS['repo-search-analytics'],
    category: 'bugfix',
    title: 'Handle empty sets in jaccardSimilarity without returning NaN',
    prompt:
      'Fix `jaccardSimilarity(arrA, arrB)` in `src/search/similarity.mjs` so when `union.size === 0` (both input arrays are empty) it returns `1` instead of `NaN`, and otherwise returns `Number((intersection / union.size).toFixed(4))`.',
    targetFiles: ['src/search/similarity.mjs'],
    initialFiles: {
      'src/search/similarity.mjs': `export function jaccardSimilarity(arrA, arrB) {
  const setA = new Set(arrA);
  const setB = new Set(arrB);
  const union = new Set([...setA, ...setB]);
  let intersection = 0;
  for (const item of setA) {
    if (setB.has(item)) intersection += 1;
  }
  return Number((intersection / union.size).toFixed(4));
}
`,
    },
    workspaceTestFile: `import test from 'node:test';
import assert from 'node:assert/strict';
import { jaccardSimilarity } from '../src/search/similarity.mjs';

test('jaccardSimilarity returns 1 for two empty arrays and computes ratio otherwise', () => {
  assert.equal(jaccardSimilarity([], []), 1);
  assert.equal(jaccardSimilarity(['a', 'b'], ['b', 'c']), 0.3333);
});
`,
    heldOutOracleTestCode: `import test from 'node:test';
import assert from 'node:assert/strict';
import { jaccardSimilarity } from '../src/search/similarity.mjs';

test('Oracle: jaccardSimilarity handles empty, disjoint, and identical sets', () => {
  assert.equal(jaccardSimilarity([], []), 1);
  assert.equal(jaccardSimilarity(['x'], []), 0);
  assert.equal(jaccardSimilarity(['a', 'b'], ['a', 'b']), 1);
  assert.equal(jaccardSimilarity([1, 2, 3], [2, 3, 4]), 0.5);
});
`,
  },
  {
    id: 'ho_14_percentile_p95_index',
    repoId: 'repo-search-analytics',
    repoFiles: HELD_OUT_REPOS['repo-search-analytics'],
    category: 'algorithms',
    title: 'Fix nearest-rank index in computePercentile',
    prompt:
      'Fix `computePercentile(sortedValues, p)` in `src/metrics/percentile.mjs` so it returns `0` for an empty array and uses nearest-rank index `Math.max(0, Math.min(sortedValues.length - 1, Math.ceil((p / 100) * sortedValues.length) - 1))`.',
    targetFiles: ['src/metrics/percentile.mjs'],
    initialFiles: {
      'src/metrics/percentile.mjs': `export function computePercentile(sortedValues, p) {
  if (!Array.isArray(sortedValues) || sortedValues.length === 0) return null;
  const idx = Math.floor((p / 100) * sortedValues.length);
  return sortedValues[idx];
}
`,
    },
    workspaceTestFile: `import test from 'node:test';
import assert from 'node:assert/strict';
import { computePercentile } from '../src/metrics/percentile.mjs';

test('computePercentile computes nearest-rank percentile and returns 0 for empty list', () => {
  assert.equal(computePercentile([], 95), 0);
  assert.equal(computePercentile([10, 20, 30, 40, 50], 60), 30);
  assert.equal(computePercentile([10, 20, 30, 40, 50], 100), 50);
});
`,
    heldOutOracleTestCode: `import test from 'node:test';
import assert from 'node:assert/strict';
import { computePercentile } from '../src/metrics/percentile.mjs';

test('Oracle: computePercentile handles p50, p95, p100, and empty arrays', () => {
  const vals = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  assert.equal(computePercentile(vals, 50), 5);
  assert.equal(computePercentile(vals, 90), 9);
  assert.equal(computePercentile(vals, 100), 10);
  assert.equal(computePercentile([], 50), 0);
});
`,
  },
  {
    id: 'ho_15_search_snippet_highlight',
    repoId: 'repo-search-analytics',
    repoFiles: HELD_OUT_REPOS['repo-search-analytics'],
    category: 'multi_file',
    title: 'Normalize search term in normalizeTerm and count case-insensitive word matches',
    prompt:
      'In `src/search/tokenizer.mjs`, update `normalizeTerm(term)` to return `String(term ?? "").trim().toLowerCase()`. In `src/search/matcher.mjs`, update `countTermOccurrences(text, term)` to split `String(text ?? "").toLowerCase()` on non-alphanumeric characters `/[^a-z0-9]+/` and count how many tokens equal `normalizeTerm(term)`.',
    targetFiles: ['src/search/tokenizer.mjs', 'src/search/matcher.mjs'],
    initialFiles: {
      'src/search/tokenizer.mjs': `export function normalizeTerm(term) {
  return String(term ?? '');
}
`,
      'src/search/matcher.mjs': `import { normalizeTerm } from './tokenizer.mjs';

export function countTermOccurrences(text, term) {
  const target = normalizeTerm(term);
  if (!target) return 0;
  const words = String(text ?? '').split(/\\s+/);
  return words.filter((w) => w === target).length;
}
`,
    },
    workspaceTestFile: `import test from 'node:test';
import assert from 'node:assert/strict';
import { countTermOccurrences } from '../src/search/matcher.mjs';

test('countTermOccurrences matches case-insensitively across punctuation', () => {
  assert.equal(countTermOccurrences('Agent, agent! AGENT?', '  Agent '), 3);
});
`,
    heldOutOracleTestCode: `import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTerm } from '../src/search/tokenizer.mjs';
import { countTermOccurrences } from '../src/search/matcher.mjs';

test('Oracle: normalizeTerm and countTermOccurrences handle punctuation and empty terms', () => {
  assert.equal(normalizeTerm('  Query '), 'query');
  assert.equal(countTermOccurrences('Run query; then re-run QUERY.', 'Query'), 2);
  assert.equal(countTermOccurrences('Run query', '   '), 0);
});
`,
  },
];
