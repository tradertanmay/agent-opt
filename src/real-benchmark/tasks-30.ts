import * as fs from 'node:fs';
import * as path from 'node:path';

export interface RealCodingTask {
  id: string;
  repoId?: string;
  category:
    | 'bugfix'
    | 'feature'
    | 'multi_file'
    | 'refactoring'
    | 'validation'
    | 'algorithms';
  title: string;
  prompt: string;
  targetFiles: string[];
  /** Optional repository-specific background/distractor files */
  repoFiles?: Record<string, string>;
  /** Files written into the workspace before the agent starts */
  initialFiles: Record<string, string>;
  /** Workspace test file that `npm test` runs during the agent session */
  workspaceTestFile: string;
  /** Held-out independent test suite run AFTER the agent finishes (never visible to the agent during the run) */
  heldOutOracleTestCode: string;
}

/**
 * Generates realistic multi-directory distractor modules in a workspace so file discovery
 * and context selection are genuinely tested.
 */
export function writeDistractorRepoStructure(workspaceDir: string): void {
  const distractorFiles: Record<string, string> = {
    'src/core/env.mjs': `export function getEnvVar(key, fallback = '') {\n  return process.env[key] ?? fallback;\n}\nexport function isProduction() {\n  return getEnvVar('NODE_ENV') === 'production';\n}\n`,
    'src/core/errors.mjs': `export class AppError extends Error {\n  constructor(message, code = 'INTERNAL_ERROR') {\n    super(message);\n    this.code = code;\n  }\n}\n`,
    'src/utils/id.mjs': `let counter = 1000;\nexport function nextId(prefix = 'id') {\n  counter += 1;\n  return \`\${prefix}_\${counter}\`;\n}\n`,
    'src/utils/time.mjs': `export function nowIso() {\n  return new Date().toISOString();\n}\nexport function sleepMs(ms) {\n  return new Promise((r) => setTimeout(r, ms));\n}\n`,
    'src/metrics/counter.mjs': `export class MetricCounter {\n  constructor(name) { this.name = name; this.value = 0; }\n  inc(delta = 1) { this.value += delta; return this.value; }\n  reset() { this.value = 0; }\n}\n`,
    'src/http/headers.mjs': `export function normalizeHeaderName(name) {\n  return String(name).trim().toLowerCase();\n}\nexport function parseBearerToken(headerValue) {\n  if (!headerValue || !headerValue.startsWith('Bearer ')) return null;\n  return headerValue.slice(7).trim();\n}\n`,
    'src/storage/memory-kv.mjs': `export class MemoryKV {\n  constructor() { this.store = new Map(); }\n  get(k) { return this.store.get(k); }\n  set(k, v) { this.store.set(k, v); }\n  delete(k) { return this.store.delete(k); }\n}\n`,
    'README.md': `# Project Workspace\n\nRun \`npm test\` to execute the test suite.\n`,
  };

  for (const [relPath, content] of Object.entries(distractorFiles)) {
    const abs = path.join(workspaceDir, relPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf-8');
  }
}

export const REAL_BENCHMARK_TASKS_30: RealCodingTask[] = [
  // ==================== CATEGORY A: BUG FIXES (1-5) ====================
  {
    id: 'task_01_lru_eviction',
    category: 'bugfix',
    title: 'Fix LRUCache.get recency refresh order',
    prompt:
      'Fix the bug in `src/cache/lru.mjs` where `LRUCache.get(key)` returns the cached value but forgets to refresh the key as most-recently-used before future `set` evictions. Run tests to verify.',
    targetFiles: ['src/cache/lru.mjs'],
    initialFiles: {
      'src/cache/lru.mjs': `export class LRUCache {
  constructor(capacity = 3) {
    this.capacity = capacity;
    this.map = new Map();
  }

  get(key) {
    if (!this.map.has(key)) return undefined;
    return this.map.get(key);
  }

  set(key, value) {
    if (this.map.has(key)) {
      this.map.delete(key);
    } else if (this.map.size >= this.capacity) {
      const oldestKey = this.map.keys().next().value;
      this.map.delete(oldestKey);
    }
    this.map.set(key, value);
  }
}
`,
    },
    workspaceTestFile: `import test from 'node:test';
import assert from 'node:assert/strict';
import { LRUCache } from '../src/cache/lru.mjs';

test('LRUCache refreshes accessed key so it is not evicted next', () => {
  const cache = new LRUCache(2);
  cache.set('a', 1);
  cache.set('b', 2);
  assert.equal(cache.get('a'), 1);
  cache.set('c', 3);
  assert.equal(cache.get('a'), 1);
  assert.equal(cache.get('b'), undefined);
});
`,
    heldOutOracleTestCode: `import test from 'node:test';
import assert from 'node:assert/strict';
import { LRUCache } from '../src/cache/lru.mjs';

test('Oracle: LRUCache eviction order after multiple gets and updates', () => {
  const cache = new LRUCache(3);
  cache.set('k1', 10);
  cache.set('k2', 20);
  cache.set('k3', 30);
  assert.equal(cache.get('k1'), 10);
  cache.set('k4', 40);
  assert.equal(cache.get('k2'), undefined);
  assert.equal(cache.get('k1'), 10);
  assert.equal(cache.get('k3'), 30);
  assert.equal(cache.get('k4'), 40);
  assert.equal(cache.get('missing'), undefined);
});
`,
  },
  {
    id: 'task_02_pagination_offset',
    category: 'bugfix',
    title: 'Fix 1-based page offset calculation in paginateItems',
    prompt:
      'Fix `paginateItems(items, page, pageSize)` in `src/query/paginator.mjs` where 1-based `page = 1` skips the first page of items because offset is calculated as `page * pageSize` instead of `(page - 1) * pageSize`.',
    targetFiles: ['src/query/paginator.mjs'],
    initialFiles: {
      'src/query/paginator.mjs': `export function paginateItems(items, page = 1, pageSize = 10) {
  const safePage = Math.max(1, Number(page) || 1);
  const safeSize = Math.max(1, Number(pageSize) || 10);
  const offset = safePage * safeSize;
  const data = items.slice(offset, offset + safeSize);
  return {
    page: safePage,
    pageSize: safeSize,
    total: items.length,
    data,
  };
}
`,
    },
    workspaceTestFile: `import test from 'node:test';
import assert from 'node:assert/strict';
import { paginateItems } from '../src/query/paginator.mjs';

test('paginateItems returns first slice for page 1', () => {
  const res = paginateItems([1, 2, 3, 4, 5], 1, 2);
  assert.deepEqual(res.data, [1, 2]);
});
`,
    heldOutOracleTestCode: `import test from 'node:test';
import assert from 'node:assert/strict';
import { paginateItems } from '../src/query/paginator.mjs';

test('Oracle: paginateItems handles page 1, page 2, out-of-range page, and metadata', () => {
  const list = ['a', 'b', 'c', 'd', 'e'];
  assert.deepEqual(paginateItems(list, 1, 2).data, ['a', 'b']);
  assert.deepEqual(paginateItems(list, 2, 2).data, ['c', 'd']);
  assert.deepEqual(paginateItems(list, 3, 2).data, ['e']);
  assert.deepEqual(paginateItems(list, 4, 2).data, []);
  assert.equal(paginateItems(list, 1, 2).total, 5);
});
`,
  },
  {
    id: 'task_03_deep_freeze_array',
    category: 'bugfix',
    title: 'Preserve arrays in deepCloneConfig',
    prompt:
      'Fix `deepCloneConfig(obj)` in `src/config/clone.mjs` where arrays are turned into plain objects `{0: ...}` because `typeof val === "object"` does not check `Array.isArray(val)`.',
    targetFiles: ['src/config/clone.mjs'],
    initialFiles: {
      'src/config/clone.mjs': `export function deepCloneConfig(value) {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  const copy = {};
  for (const [k, v] of Object.entries(value)) {
    copy[k] = deepCloneConfig(v);
  }
  return copy;
}
`,
    },
    workspaceTestFile: `import test from 'node:test';
import assert from 'node:assert/strict';
import { deepCloneConfig } from '../src/config/clone.mjs';

test('deepCloneConfig preserves nested arrays', () => {
  const input = { ports: [80, 443], nested: { tags: ['api'] } };
  const cloned = deepCloneConfig(input);
  assert.ok(Array.isArray(cloned.ports));
  assert.deepEqual(cloned, input);
});
`,
    heldOutOracleTestCode: `import test from 'node:test';
import assert from 'node:assert/strict';
import { deepCloneConfig } from '../src/config/clone.mjs';

test('Oracle: deepCloneConfig clones nested arrays and objects without reference sharing', () => {
  const orig = { a: [1, { b: [2, 3] }], c: null, d: 'ok' };
  const clone = deepCloneConfig(orig);
  assert.deepEqual(clone, orig);
  assert.ok(Array.isArray(clone.a));
  assert.ok(Array.isArray(clone.a[1].b));
  clone.a[1].b.push(4);
  assert.equal(orig.a[1].b.length, 2);
});
`,
  },
  {
    id: 'task_04_csv_quoted_comma',
    category: 'bugfix',
    title: 'Fix parseCsvRow trimming and empty column handling',
    prompt:
      'Fix `parseCsvRow(line)` in `src/parsers/csv.mjs` so empty columns (like `"a,,c"`) are preserved as `""` instead of being filtered out by `.filter(Boolean)`.',
    targetFiles: ['src/parsers/csv.mjs'],
    initialFiles: {
      'src/parsers/csv.mjs': `export function parseCsvRow(line) {
  if (typeof line !== 'string' || line.length === 0) return [];
  return line
    .split(',')
    .map((cell) => cell.trim())
    .filter(Boolean);
}
`,
    },
    workspaceTestFile: `import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCsvRow } from '../src/parsers/csv.mjs';

test('parseCsvRow keeps empty cells', () => {
  assert.deepEqual(parseCsvRow('a,,c'), ['a', '', 'c']);
});
`,
    heldOutOracleTestCode: `import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCsvRow } from '../src/parsers/csv.mjs';

test('Oracle: parseCsvRow preserves middle and trailing empty cells and trims whitespace', () => {
  assert.deepEqual(parseCsvRow(' alice , , bob , '), ['alice', '', 'bob', '']);
  assert.deepEqual(parseCsvRow(''), []);
});
`,
  },
  {
    id: 'task_05_semver_numeric',
    category: 'bugfix',
    title: 'Fix numeric comparison in compareSemver',
    prompt:
      'Fix `compareSemver(a, b)` in `src/version/semver.mjs` where version parts are compared as strings (`"10" < "2"`) instead of numbers (`10 > 2`). Return `1` if `a > b`, `-1` if `a < b`, and `0` if equal.',
    targetFiles: ['src/version/semver.mjs'],
    initialFiles: {
      'src/version/semver.mjs': `export function compareSemver(verA, verB) {
  const partsA = String(verA).split('.');
  const partsB = String(verB).split('.');
  for (let i = 0; i < 3; i++) {
    const a = partsA[i] || '0';
    const b = partsB[i] || '0';
    if (a > b) return 1;
    if (a < b) return -1;
  }
  return 0;
}
`,
    },
    workspaceTestFile: `import test from 'node:test';
import assert from 'node:assert/strict';
import { compareSemver } from '../src/version/semver.mjs';

test('compareSemver compares multi-digit segments numerically', () => {
  assert.equal(compareSemver('1.10.0', '1.2.0'), 1);
  assert.equal(compareSemver('1.2.0', '1.10.0'), -1);
});
`,
    heldOutOracleTestCode: `import test from 'node:test';
import assert from 'node:assert/strict';
import { compareSemver } from '../src/version/semver.mjs';

test('Oracle: compareSemver handles major, minor, patch numeric ordering', () => {
  assert.equal(compareSemver('1.10.0', '1.2.0'), 1);
  assert.equal(compareSemver('2.0.0', '10.0.0'), -1);
  assert.equal(compareSemver('1.2.3', '1.2.3'), 0);
  assert.equal(compareSemver('0.0.12', '0.0.9'), 1);
});
`,
  },

  // ==================== CATEGORY B: FEATURE ADDITIONS (6-10) ====================
  {
    id: 'task_06_array_chunk',
    category: 'feature',
    title: 'Implement chunkArray in src/collection/chunk.mjs',
    prompt:
      'Implement and export `chunkArray(items, size)` in `src/collection/chunk.mjs` so it splits `items` into subarrays of length at most `size`, and throws a `RangeError` if `size <= 0`.',
    targetFiles: ['src/collection/chunk.mjs'],
    initialFiles: {
      'src/collection/chunk.mjs': `export function chunkArray(items, size) {
  // TODO: implement chunkArray
  return [];
}
`,
    },
    workspaceTestFile: `import test from 'node:test';
import assert from 'node:assert/strict';
import { chunkArray } from '../src/collection/chunk.mjs';

test('chunkArray splits array into chunks', () => {
  assert.deepEqual(chunkArray([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.throws(() => chunkArray([1, 2], 0), RangeError);
});
`,
    heldOutOracleTestCode: `import test from 'node:test';
import assert from 'node:assert/strict';
import { chunkArray } from '../src/collection/chunk.mjs';

test('Oracle: chunkArray handles empty arrays, exact multiples, remainders, and invalid sizes', () => {
  assert.deepEqual(chunkArray([], 3), []);
  assert.deepEqual(chunkArray([1, 2, 3, 4], 2), [[1, 2], [3, 4]]);
  assert.deepEqual(chunkArray([1, 2, 3], 5), [[1, 2, 3]]);
  assert.throws(() => chunkArray([1], 0), RangeError);
  assert.throws(() => chunkArray([1], -2), RangeError);
});
`,
  },
  {
    id: 'task_07_slugify_url',
    category: 'feature',
    title: 'Implement slugifyTitle in src/string/slug.mjs',
    prompt:
      'Implement and export `slugifyTitle(input)` in `src/string/slug.mjs` that converts `input` to lowercase, replaces any sequence of non-alphanumeric characters with a single hyphen `"-"`, and removes leading or trailing hyphens.',
    targetFiles: ['src/string/slug.mjs'],
    initialFiles: {
      'src/string/slug.mjs': `export function slugifyTitle(input) {
  // TODO: implement slugifyTitle
  return String(input);
}
`,
    },
    workspaceTestFile: `import test from 'node:test';
import assert from 'node:assert/strict';
import { slugifyTitle } from '../src/string/slug.mjs';

test('slugifyTitle formats URL slug', () => {
  assert.equal(slugifyTitle('  Hello, World! 2026 -- '), 'hello-world-2026');
});
`,
    heldOutOracleTestCode: `import test from 'node:test';
import assert from 'node:assert/strict';
import { slugifyTitle } from '../src/string/slug.mjs';

test('Oracle: slugifyTitle handles punctuation runs, leading/trailing symbols, and numbers', () => {
  assert.equal(slugifyTitle('  Hello, World! 2026 -- '), 'hello-world-2026');
  assert.equal(slugifyTitle('***Agent___Opt***'), 'agent-opt');
  assert.equal(slugifyTitle('---'), '');
});
`,
  },
  {
    id: 'task_08_moving_average',
    category: 'feature',
    title: 'Implement meanWindow in src/stats/moving-average.mjs',
    prompt:
      'Implement and export `meanWindow(values, windowSize)` in `src/stats/moving-average.mjs` returning an array of simple moving averages (rounded to 2 decimal places via `Number(avg.toFixed(2))`) for each contiguous window of size `windowSize`. If `windowSize <= 0` or `values.length < windowSize`, return `[]`.',
    targetFiles: ['src/stats/moving-average.mjs'],
    initialFiles: {
      'src/stats/moving-average.mjs': `export function meanWindow(values, windowSize) {
  // TODO: implement simple moving average
  return [];
}
`,
    },
    workspaceTestFile: `import test from 'node:test';
import assert from 'node:assert/strict';
import { meanWindow } from '../src/stats/moving-average.mjs';

test('meanWindow computes moving averages', () => {
  assert.deepEqual(meanWindow([10, 20, 30, 40], 2), [15, 25, 35]);
});
`,
    heldOutOracleTestCode: `import test from 'node:test';
import assert from 'node:assert/strict';
import { meanWindow } from '../src/stats/moving-average.mjs';

test('Oracle: meanWindow handles fractional averages and edge window sizes', () => {
  assert.deepEqual(meanWindow([1, 2, 3, 4], 3), [2, 3]);
  assert.deepEqual(meanWindow([1, 2, 4], 3), [2.33]);
  assert.deepEqual(meanWindow([1, 2], 5), []);
  assert.deepEqual(meanWindow([1, 2], 0), []);
});
`,
  },
  {
    id: 'task_09_query_string',
    category: 'feature',
    title: 'Implement buildQueryString in src/http/query.mjs',
    prompt:
      'Implement and export `buildQueryString(params)` in `src/http/query.mjs` that takes an object, filters out keys whose value is `undefined` or `null`, sorts keys alphabetically, URL-encodes keys and values with `encodeURIComponent`, and joins them with `"&"`.',
    targetFiles: ['src/http/query.mjs'],
    initialFiles: {
      'src/http/query.mjs': `export function buildQueryString(params) {
  // TODO: implement buildQueryString
  return '';
}
`,
    },
    workspaceTestFile: `import test from 'node:test';
import assert from 'node:assert/strict';
import { buildQueryString } from '../src/http/query.mjs';

test('buildQueryString sorts keys and skips null/undefined', () => {
  assert.equal(
    buildQueryString({ z: '1', a: 'hello world', skip: null, undef: undefined }),
    'a=hello%20world&z=1'
  );
});
`,
    heldOutOracleTestCode: `import test from 'node:test';
import assert from 'node:assert/strict';
import { buildQueryString } from '../src/http/query.mjs';

test('Oracle: buildQueryString handles empty objects, booleans, numbers, and encoding', () => {
  assert.equal(buildQueryString({}), '');
  assert.equal(buildQueryString({ b: 2, a: true, c: null }), 'a=true&b=2');
  assert.equal(buildQueryString({ q: 'a&b=c' }), 'q=a%26b%3Dc');
});
`,
  },
  {
    id: 'task_10_set_symmetric_diff',
    category: 'feature',
    title: 'Implement symmetricDifference in src/collection/set-ops.mjs',
    prompt:
      'Implement and export `symmetricDifference(arrA, arrB)` in `src/collection/set-ops.mjs` that returns an array of unique elements present in either `arrA` or `arrB`, but not in both.',
    targetFiles: ['src/collection/set-ops.mjs'],
    initialFiles: {
      'src/collection/set-ops.mjs': `export function symmetricDifference(arrA, arrB) {
  // TODO: implement symmetricDifference
  return [];
}
`,
    },
    workspaceTestFile: `import test from 'node:test';
import assert from 'node:assert/strict';
import { symmetricDifference } from '../src/collection/set-ops.mjs';

test('symmetricDifference returns non-overlapping elements', () => {
  assert.deepEqual(symmetricDifference([1, 2, 3], [2, 3, 4]), [1, 4]);
});
`,
    heldOutOracleTestCode: `import test from 'node:test';
import assert from 'node:assert/strict';
import { symmetricDifference } from '../src/collection/set-ops.mjs';

test('Oracle: symmetricDifference deduplicates within inputs and handles disjoint/identical sets', () => {
  assert.deepEqual(symmetricDifference([1, 1, 2], [2, 3, 3]), [1, 3]);
  assert.deepEqual(symmetricDifference(['a', 'b'], ['a', 'b']), []);
  assert.deepEqual(symmetricDifference([], [5]), [5]);
});
`,
  },

  // ==================== CATEGORY C: MULTI-FILE CHANGES (11-15) ====================
  {
    id: 'task_11_tax_jurisdiction',
    category: 'multi_file',
    title: 'Add CA tax rate and round total in tax calculator',
    prompt:
      'Update `getTaxRate(stateCode)` in `src/tax/rates.mjs` to return `0.0825` for `"CA"`, and update `computeInvoiceWithTax(subtotal, stateCode)` in `src/tax/calculator.mjs` so the result is rounded to 2 decimal places (`Number(total.toFixed(2))`).',
    targetFiles: ['src/tax/rates.mjs', 'src/tax/calculator.mjs'],
    initialFiles: {
      'src/tax/rates.mjs': `const RATES = {
  NY: 0.08,
  TX: 0.0625,
};

export function getTaxRate(stateCode) {
  return RATES[String(stateCode).toUpperCase()] ?? 0;
}
`,
      'src/tax/calculator.mjs': `import { getTaxRate } from './rates.mjs';

export function computeInvoiceWithTax(subtotal, stateCode) {
  const rate = getTaxRate(stateCode);
  return subtotal * (1 + rate);
}
`,
    },
    workspaceTestFile: `import test from 'node:test';
import assert from 'node:assert/strict';
import { computeInvoiceWithTax } from '../src/tax/calculator.mjs';

test('computeInvoiceWithTax supports CA and rounds to 2 decimals', () => {
  assert.equal(computeInvoiceWithTax(100, 'CA'), 108.25);
  assert.equal(computeInvoiceWithTax(19.99, 'CA'), 21.64);
});
`,
    heldOutOracleTestCode: `import test from 'node:test';
import assert from 'node:assert/strict';
import { getTaxRate } from '../src/tax/rates.mjs';
import { computeInvoiceWithTax } from '../src/tax/calculator.mjs';

test('Oracle: CA tax rate and existing NY/TX rates with 2-decimal rounding', () => {
  assert.equal(getTaxRate('CA'), 0.0825);
  assert.equal(getTaxRate('ca'), 0.0825);
  assert.equal(computeInvoiceWithTax(19.99, 'CA'), 21.64);
  assert.equal(computeInvoiceWithTax(50, 'NY'), 54);
  assert.equal(computeInvoiceWithTax(50, 'OR'), 50);
});
`,
  },
  {
    id: 'task_12_auth_token_expiry',
    category: 'multi_file',
    title: 'Fix TTL seconds-to-milliseconds conversion in token verifier',
    prompt:
      'Fix `isTokenExpired(issuedAtMs, ttlSeconds, nowMs)` in `src/auth/token.mjs` where `ttlSeconds` is added directly to `issuedAtMs` instead of multiplying `ttlSeconds * 1000`, breaking `verifySessionHeader` in `src/auth/session.mjs`.',
    targetFiles: ['src/auth/token.mjs', 'src/auth/session.mjs'],
    initialFiles: {
      'src/auth/token.mjs': `export function isTokenExpired(issuedAtMs, ttlSeconds, nowMs = Date.now()) {
  const expiresAtMs = issuedAtMs + ttlSeconds;
  return nowMs >= expiresAtMs;
}
`,
      'src/auth/session.mjs': `import { isTokenExpired } from './token.mjs';

export function verifySessionToken(tokenObj, nowMs) {
  if (!tokenObj || !tokenObj.userId) return { valid: false, reason: 'missing_user' };
  if (isTokenExpired(tokenObj.issuedAtMs, tokenObj.ttlSeconds, nowMs)) {
    return { valid: false, reason: 'expired' };
  }
  return { valid: true, userId: tokenObj.userId };
}
`,
    },
    workspaceTestFile: `import test from 'node:test';
import assert from 'node:assert/strict';
import { verifySessionToken } from '../src/auth/session.mjs';

test('verifySessionToken converts ttlSeconds to milliseconds', () => {
  const res = verifySessionToken({ userId: 'u1', issuedAtMs: 1000, ttlSeconds: 60 }, 30_000);
  assert.equal(res.valid, true);
});
`,
    heldOutOracleTestCode: `import test from 'node:test';
import assert from 'node:assert/strict';
import { isTokenExpired } from '../src/auth/token.mjs';
import { verifySessionToken } from '../src/auth/session.mjs';

test('Oracle: boundary check at exact expiration millisecond', () => {
  assert.equal(isTokenExpired(1000, 60, 60_999), false);
  assert.equal(isTokenExpired(1000, 60, 61_000), true);
  assert.deepEqual(
    verifySessionToken({ userId: 'u2', issuedAtMs: 1000, ttlSeconds: 10 }, 11_000),
    { valid: false, reason: 'expired' }
  );
});
`,
  },
  {
    id: 'task_13_cart_coupon_cap',
    category: 'multi_file',
    title: 'Enforce maxDiscountCents cap in applyPercentageCoupon',
    prompt:
      'Fix `applyPercentageCoupon(subtotalCents, percentOff, maxDiscountCents)` in `src/store/coupon.mjs` so the computed discount never exceeds `maxDiscountCents` when `maxDiscountCents` is provided.',
    targetFiles: ['src/store/coupon.mjs', 'src/store/cart.mjs'],
    initialFiles: {
      'src/store/coupon.mjs': `export function applyPercentageCoupon(subtotalCents, percentOff, maxDiscountCents) {
  const rawDiscount = Math.round(subtotalCents * (percentOff / 100));
  return Math.max(0, subtotalCents - rawDiscount);
}
`,
      'src/store/cart.mjs': `import { applyPercentageCoupon } from './coupon.mjs';

export function checkoutWithCoupon(items, coupon) {
  const subtotal = items.reduce((sum, item) => sum + item.priceCents * item.qty, 0);
  if (!coupon) return subtotal;
  return applyPercentageCoupon(subtotal, coupon.percentOff, coupon.maxDiscountCents);
}
`,
    },
    workspaceTestFile: `import test from 'node:test';
import assert from 'node:assert/strict';
import { checkoutWithCoupon } from '../src/store/cart.mjs';

test('checkoutWithCoupon caps discount at maxDiscountCents', () => {
  const total = checkoutWithCoupon(
    [{ priceCents: 10000, qty: 1 }],
    { percentOff: 50, maxDiscountCents: 2000 }
  );
  assert.equal(total, 8000);
});
`,
    heldOutOracleTestCode: `import test from 'node:test';
import assert from 'node:assert/strict';
import { applyPercentageCoupon } from '../src/store/coupon.mjs';
import { checkoutWithCoupon } from '../src/store/cart.mjs';

test('Oracle: coupon cap when below cap, above cap, and undefined cap', () => {
  assert.equal(applyPercentageCoupon(10000, 20, 5000), 8000);
  assert.equal(applyPercentageCoupon(10000, 20, 1500), 8500);
  assert.equal(applyPercentageCoupon(10000, 20, undefined), 8000);
  assert.equal(checkoutWithCoupon([{ priceCents: 5000, qty: 2 }], { percentOff: 30, maxDiscountCents: 1000 }), 9000);
});
`,
  },
  {
    id: 'task_14_logger_redact',
    category: 'multi_file',
    title: 'Wire maskSensitiveFields into formatLogEntry',
    prompt:
      'Update `formatLogEntry(level, message, metadata)` in `src/logging/formatter.mjs` so it redacts `metadata` using `maskSensitiveFields(metadata)` from `src/logging/redactor.mjs` before JSON serialization.',
    targetFiles: ['src/logging/formatter.mjs', 'src/logging/redactor.mjs'],
    initialFiles: {
      'src/logging/redactor.mjs': `const SECRET_KEYS = new Set(['password', 'token', 'secret', 'apiKey']);

export function maskSensitiveFields(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = SECRET_KEYS.has(k) ? '[REDACTED]' : v;
  }
  return out;
}
`,
      'src/logging/formatter.mjs': `import { maskSensitiveFields } from './redactor.mjs';

export function formatLogEntry(level, message, metadata = {}) {
  return JSON.stringify({
    level: String(level).toUpperCase(),
    message,
    metadata,
  });
}
`,
    },
    workspaceTestFile: `import test from 'node:test';
import assert from 'node:assert/strict';
import { formatLogEntry } from '../src/logging/formatter.mjs';

test('formatLogEntry masks sensitive metadata fields', () => {
  const json = formatLogEntry('info', 'login', { user: 'alice', password: '123' });
  const parsed = JSON.parse(json);
  assert.equal(parsed.metadata.password, '[REDACTED]');
  assert.equal(parsed.metadata.user, 'alice');
});
`,
    heldOutOracleTestCode: `import test from 'node:test';
import assert from 'node:assert/strict';
import { formatLogEntry } from '../src/logging/formatter.mjs';

test('Oracle: formatLogEntry masks password, token, apiKey while keeping safe keys', () => {
  const parsed = JSON.parse(
    formatLogEntry('warn', 'auth', { userId: 42, token: 'xyz', apiKey: 'k1' })
  );
  assert.equal(parsed.level, 'WARN');
  assert.equal(parsed.metadata.userId, 42);
  assert.equal(parsed.metadata.token, '[REDACTED]');
  assert.equal(parsed.metadata.apiKey, '[REDACTED]');
});
`,
  },
  {
    id: 'task_15_unit_converter',
    category: 'multi_file',
    title: 'Fix celsiusToFahrenheit formula in src/units/temperature.mjs',
    prompt:
      'Fix `celsiusToFahrenheit(c)` in `src/units/temperature.mjs` where the conversion uses `c * (5 / 9) + 32` instead of `c * (9 / 5) + 32`, causing `formatWeatherReport` in `src/units/weather.mjs` to report wrong temperatures.',
    targetFiles: ['src/units/temperature.mjs', 'src/units/weather.mjs'],
    initialFiles: {
      'src/units/temperature.mjs': `export function celsiusToFahrenheit(celsius) {
  return Number((celsius * (5 / 9) + 32).toFixed(1));
}
`,
      'src/units/weather.mjs': `import { celsiusToFahrenheit } from './temperature.mjs';

export function formatWeatherReport(city, tempCelsius) {
  const tempF = celsiusToFahrenheit(tempCelsius);
  return \`\${city}: \${tempCelsius}C (\${tempF}F)\`;
}
`,
    },
    workspaceTestFile: `import test from 'node:test';
import assert from 'node:assert/strict';
import { formatWeatherReport } from '../src/units/weather.mjs';

test('formatWeatherReport converts 100C to 212F', () => {
  assert.equal(formatWeatherReport('Austin', 100), 'Austin: 100C (212F)');
});
`,
    heldOutOracleTestCode: `import test from 'node:test';
import assert from 'node:assert/strict';
import { celsiusToFahrenheit } from '../src/units/temperature.mjs';
import { formatWeatherReport } from '../src/units/weather.mjs';

test('Oracle: celsiusToFahrenheit at 0C, 100C, -40C, and 20C', () => {
  assert.equal(celsiusToFahrenheit(0), 32);
  assert.equal(celsiusToFahrenheit(100), 212);
  assert.equal(celsiusToFahrenheit(-40), -40);
  assert.equal(formatWeatherReport('NYC', 20), 'NYC: 20C (68F)');
});
`,
  },

  // ==================== CATEGORY D: REFACTORING & API (16-20) ====================
  {
    id: 'task_16_flatten_nested',
    category: 'refactoring',
    title: 'Respect depth parameter in flattenDepth',
    prompt:
      'Fix `flattenDepth(arr, depth = 1)` in `src/collection/flatten.mjs` so it only flattens up to `depth` levels instead of recursively flattening all nested arrays.',
    targetFiles: ['src/collection/flatten.mjs'],
    initialFiles: {
      'src/collection/flatten.mjs': `export function flattenDepth(arr, depth = 1) {
  const result = [];
  for (const item of arr) {
    if (Array.isArray(item)) {
      result.push(...flattenDepth(item, depth));
    } else {
      result.push(item);
    }
  }
  return result;
}
`,
    },
    workspaceTestFile: `import test from 'node:test';
import assert from 'node:assert/strict';
import { flattenDepth } from '../src/collection/flatten.mjs';

test('flattenDepth flattens only 1 level by default', () => {
  assert.deepEqual(flattenDepth([1, [2, [3, [4]]]], 1), [1, 2, [3, [4]]]);
});
`,
    heldOutOracleTestCode: `import test from 'node:test';
import assert from 'node:assert/strict';
import { flattenDepth } from '../src/collection/flatten.mjs';

test('Oracle: flattenDepth with depth 0, 1, 2, and deep', () => {
  const nested = [1, [2, [3, [4]]]];
  assert.deepEqual(flattenDepth(nested, 0), [1, [2, [3, [4]]]]);
  assert.deepEqual(flattenDepth(nested, 1), [1, 2, [3, [4]]]);
  assert.deepEqual(flattenDepth(nested, 2), [1, 2, 3, [4]]);
});
`,
  },
  {
    id: 'task_17_retry_delay_cap',
    category: 'refactoring',
    title: 'Cap exponential backoff at maxMs in calculateBackoffMs',
    prompt:
      'Fix `calculateBackoffMs(attempt, baseMs = 100, maxMs = 5000)` in `src/net/backoff.mjs` where `Math.max` is used instead of `Math.min`, causing delays to start at `maxMs` instead of being capped at `maxMs`.',
    targetFiles: ['src/net/backoff.mjs'],
    initialFiles: {
      'src/net/backoff.mjs': `export function calculateBackoffMs(attempt, baseMs = 100, maxMs = 5000) {
  const exp = baseMs * Math.pow(2, Math.max(0, attempt));
  return Math.max(maxMs, exp);
}
`,
    },
    workspaceTestFile: `import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateBackoffMs } from '../src/net/backoff.mjs';

test('calculateBackoffMs grows exponentially and caps at maxMs', () => {
  assert.equal(calculateBackoffMs(0, 100, 1000), 100);
  assert.equal(calculateBackoffMs(2, 100, 1000), 400);
  assert.equal(calculateBackoffMs(5, 100, 1000), 1000);
});
`,
    heldOutOracleTestCode: `import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateBackoffMs } from '../src/net/backoff.mjs';

test('Oracle: calculateBackoffMs progression and ceiling', () => {
  assert.equal(calculateBackoffMs(0, 50, 500), 50);
  assert.equal(calculateBackoffMs(1, 50, 500), 100);
  assert.equal(calculateBackoffMs(3, 50, 500), 400);
  assert.equal(calculateBackoffMs(4, 50, 500), 500);
});
`,
  },
  {
    id: 'task_18_path_join_slash',
    category: 'refactoring',
    title: 'Fix duplicate slash in joinUrlSegments',
    prompt:
      'Fix `joinUrlSegments(baseUrl, subPath)` in `src/http/url.mjs` so joining a `baseUrl` ending with `"/"` and a `subPath` starting with `"/"` produces a single `"/"` between them.',
    targetFiles: ['src/http/url.mjs'],
    initialFiles: {
      'src/http/url.mjs': `export function joinUrlSegments(baseUrl, subPath) {
  if (!subPath) return baseUrl;
  return \`\${baseUrl}/\${subPath}\`;
}
`,
    },
    workspaceTestFile: `import test from 'node:test';
import assert from 'node:assert/strict';
import { joinUrlSegments } from '../src/http/url.mjs';

test('joinUrlSegments avoids double slashes', () => {
  assert.equal(
    joinUrlSegments('https://api.example.com/', '/v1/users'),
    'https://api.example.com/v1/users'
  );
});
`,
    heldOutOracleTestCode: `import test from 'node:test';
import assert from 'node:assert/strict';
import { joinUrlSegments } from '../src/http/url.mjs';

test('Oracle: joinUrlSegments normalizes slash combinations', () => {
  assert.equal(joinUrlSegments('https://a.com/', '/b'), 'https://a.com/b');
  assert.equal(joinUrlSegments('https://a.com', 'b'), 'https://a.com/b');
  assert.equal(joinUrlSegments('https://a.com/', 'b/c'), 'https://a.com/b/c');
});
`,
  },
  {
    id: 'task_19_event_emitter_off',
    category: 'refactoring',
    title: 'Fix TypedEmitter.off removing all listeners instead of target listener',
    prompt:
      'Fix `TypedEmitter.off(event, listenerToRemove)` in `src/events/emitter.mjs` where calling `off` deletes the entire event array instead of removing only `listenerToRemove`.',
    targetFiles: ['src/events/emitter.mjs'],
    initialFiles: {
      'src/events/emitter.mjs': `export class TypedEmitter {
  constructor() {
    this.listeners = new Map();
  }

  on(event, fn) {
    const list = this.listeners.get(event) || [];
    list.push(fn);
    this.listeners.set(event, list);
  }

  off(event, fn) {
    this.listeners.delete(event);
  }

  emit(event, payload) {
    const list = this.listeners.get(event) || [];
    for (const fn of list) {
      fn(payload);
    }
  }
}
`,
    },
    workspaceTestFile: `import test from 'node:test';
import assert from 'node:assert/strict';
import { TypedEmitter } from '../src/events/emitter.mjs';

test('TypedEmitter.off removes only the specified listener', () => {
  const bus = new TypedEmitter();
  const calls = [];
  const fn1 = (x) => calls.push('fn1:' + x);
  const fn2 = (x) => calls.push('fn2:' + x);
  bus.on('msg', fn1);
  bus.on('msg', fn2);
  bus.off('msg', fn1);
  bus.emit('msg', 'hi');
  assert.deepEqual(calls, ['fn2:hi']);
});
`,
    heldOutOracleTestCode: `import test from 'node:test';
import assert from 'node:assert/strict';
import { TypedEmitter } from '../src/events/emitter.mjs';

test('Oracle: TypedEmitter.off handles missing events and multiple listeners', () => {
  const bus = new TypedEmitter();
  let count1 = 0;
  let count2 = 0;
  const l1 = () => { count1 += 1; };
  const l2 = () => { count2 += 1; };
  bus.on('tick', l1);
  bus.on('tick', l2);
  bus.off('tick', l1);
  bus.off('nonexistent', l1);
  bus.emit('tick');
  assert.equal(count1, 0);
  assert.equal(count2, 1);
});
`,
  },
  {
    id: 'task_20_matrix_transpose',
    category: 'refactoring',
    title: 'Support non-square rectangular matrices in transposeMatrix',
    prompt:
      'Fix `transposeMatrix(grid)` in `src/math/matrix.mjs` so rectangular matrices ($M \\times N$ where rows $\\neq$ cols, e.g., $2 \\times 3$) transpose into $N \\times M$ ($3 \\times 2$) without crashing or losing elements.',
    targetFiles: ['src/math/matrix.mjs'],
    initialFiles: {
      'src/math/matrix.mjs': `export function transposeMatrix(grid) {
  if (!Array.isArray(grid) || grid.length === 0) return [];
  const n = grid.length;
  const out = Array.from({ length: n }, () => Array(n).fill(0));
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      out[c][r] = grid[r][c];
    }
  }
  return out;
}
`,
    },
    workspaceTestFile: `import test from 'node:test';
import assert from 'node:assert/strict';
import { transposeMatrix } from '../src/math/matrix.mjs';

test('transposeMatrix transposes 2x3 matrix into 3x2', () => {
  assert.deepEqual(
    transposeMatrix([
      [1, 2, 3],
      [4, 5, 6],
    ]),
    [
      [1, 4],
      [2, 5],
      [3, 6],
    ]
  );
});
`,
    heldOutOracleTestCode: `import test from 'node:test';
import assert from 'node:assert/strict';
import { transposeMatrix } from '../src/math/matrix.mjs';

test('Oracle: transposeMatrix handles 2x3, 3x1, square 2x2, and empty', () => {
  assert.deepEqual(transposeMatrix([]), []);
  assert.deepEqual(transposeMatrix([[1, 2, 3]]), [[1], [2], [3]]);
  assert.deepEqual(transposeMatrix([[1, 2], [3, 4]]), [[1, 3], [2, 4]]);
});
`,
  },

  // ==================== CATEGORY E: VALIDATION & EDGE CASES (21-25) ====================
  {
    id: 'task_21_ipv4_validator',
    category: 'validation',
    title: 'Reject leading zeros and out-of-range octets in isValidIPv4',
    prompt:
      'Fix `isValidIPv4(ip)` in `src/net/ip.mjs` so it rejects octets with leading zeros (like `"01"` in `"192.168.01.1"`) and non-digit characters while allowing `"0"` and valid `0..255` octets.',
    targetFiles: ['src/net/ip.mjs'],
    initialFiles: {
      'src/net/ip.mjs': `export function isValidIPv4(ip) {
  if (typeof ip !== 'string') return false;
  const parts = ip.split('.');
  if (parts.length !== 4) return false;
  return parts.every((p) => {
    const n = Number(p);
    return p.length > 0 && !Number.isNaN(n) && n >= 0 && n <= 255;
  });
}
`,
    },
    workspaceTestFile: `import test from 'node:test';
import assert from 'node:assert/strict';
import { isValidIPv4 } from '../src/net/ip.mjs';

test('isValidIPv4 rejects leading zeros', () => {
  assert.equal(isValidIPv4('192.168.0.1'), true);
  assert.equal(isValidIPv4('192.168.01.1'), false);
});
`,
    heldOutOracleTestCode: `import test from 'node:test';
import assert from 'node:assert/strict';
import { isValidIPv4 } from '../src/net/ip.mjs';

test('Oracle: isValidIPv4 validates boundaries, leading zeros, spaces, and hex', () => {
  assert.equal(isValidIPv4('0.0.0.0'), true);
  assert.equal(isValidIPv4('255.255.255.255'), true);
  assert.equal(isValidIPv4('192.168.01.1'), false);
  assert.equal(isValidIPv4('256.1.1.1'), false);
  assert.equal(isValidIPv4('1.2.3. 4'), false);
});
`,
  },
  {
    id: 'task_22_json_safe_parse',
    category: 'validation',
    title: 'Preserve falsy JSON values in safeJsonParse',
    prompt:
      'Fix `safeJsonParse(raw, fallback)` in `src/parsers/json.mjs` where `JSON.parse(raw) || fallback` mistakenly replaces valid falsy JSON results (`0`, `false`, `""`) with `fallback`.',
    targetFiles: ['src/parsers/json.mjs'],
    initialFiles: {
      'src/parsers/json.mjs': `export function safeJsonParse(raw, fallback = null) {
  try {
    return JSON.parse(raw) || fallback;
  } catch {
    return fallback;
  }
}
`,
    },
    workspaceTestFile: `import test from 'node:test';
import assert from 'node:assert/strict';
import { safeJsonParse } from '../src/parsers/json.mjs';

test('safeJsonParse preserves false and 0', () => {
  assert.equal(safeJsonParse('false', true), false);
  assert.equal(safeJsonParse('0', 99), 0);
});
`,
    heldOutOracleTestCode: `import test from 'node:test';
import assert from 'node:assert/strict';
import { safeJsonParse } from '../src/parsers/json.mjs';

test('Oracle: safeJsonParse handles 0, false, empty string, objects, and invalid JSON', () => {
  assert.equal(safeJsonParse('0', 42), 0);
  assert.equal(safeJsonParse('false', true), false);
  assert.equal(safeJsonParse('""', 'default'), '');
  assert.equal(safeJsonParse('{bad', 'fallback'), 'fallback');
});
`,
  },
  {
    id: 'task_23_range_clamp_nan',
    category: 'validation',
    title: 'Handle NaN and inverted bounds in clampNumber',
    prompt:
      'Fix `clampNumber(val, min, max)` in `src/math/clamp.mjs` so that if `Number.isNaN(val)` is true it returns `min`, and if `min > max` it swaps them before clamping.',
    targetFiles: ['src/math/clamp.mjs'],
    initialFiles: {
      'src/math/clamp.mjs': `export function clampNumber(val, min, max) {
  return Math.min(max, Math.max(min, val));
}
`,
    },
    workspaceTestFile: `import test from 'node:test';
import assert from 'node:assert/strict';
import { clampNumber } from '../src/math/clamp.mjs';

test('clampNumber handles NaN and inverted min/max', () => {
  assert.equal(clampNumber(NaN, 10, 20), 10);
  assert.equal(clampNumber(15, 20, 10), 15);
});
`,
    heldOutOracleTestCode: `import test from 'node:test';
import assert from 'node:assert/strict';
import { clampNumber } from '../src/math/clamp.mjs';

test('Oracle: clampNumber normal, NaN, and swapped bounds', () => {
  assert.equal(clampNumber(5, 0, 10), 5);
  assert.equal(clampNumber(-5, 0, 10), 0);
  assert.equal(clampNumber(NaN, 5, 15), 5);
  assert.equal(clampNumber(25, 20, 10), 20);
});
`,
  },
  {
    id: 'task_24_password_strength',
    category: 'validation',
    title: 'Return score 0 for passwords under 8 chars in evaluatePasswordScore',
    prompt:
      'Fix `evaluatePasswordScore(pwd)` in `src/auth/password.mjs` so any password with `pwd.length < 8` immediately returns `0`, even if it contains uppercase letters, digits, and symbols.',
    targetFiles: ['src/auth/password.mjs'],
    initialFiles: {
      'src/auth/password.mjs': `export function evaluatePasswordScore(pwd) {
  if (typeof pwd !== 'string') return 0;
  let score = 0;
  if (pwd.length >= 8) score += 1;
  if (/[A-Z]/.test(pwd)) score += 1;
  if (/[0-9]/.test(pwd)) score += 1;
  if (/[^A-Za-z0-9]/.test(pwd)) score += 1;
  return score;
}
`,
    },
    workspaceTestFile: `import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluatePasswordScore } from '../src/auth/password.mjs';

test('evaluatePasswordScore returns 0 when shorter than 8 characters', () => {
  assert.equal(evaluatePasswordScore('Ab1!'), 0);
  assert.equal(evaluatePasswordScore('StrongPass1!'), 4);
});
`,
    heldOutOracleTestCode: `import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluatePasswordScore } from '../src/auth/password.mjs';

test('Oracle: evaluatePasswordScore enforces minimum length 8 hard gate', () => {
  assert.equal(evaluatePasswordScore('A1!bcde'), 0);
  assert.equal(evaluatePasswordScore('abcdefgh'), 1);
  assert.equal(evaluatePasswordScore('Abcdefg1!'), 4);
});
`,
  },
  {
    id: 'task_25_currency_cents',
    category: 'validation',
    title: 'Fix floating-point truncation in dollarsToCents',
    prompt:
      'Fix `dollarsToCents(amount)` in `src/finance/money.mjs` where `Math.floor(amount * 100)` turns `19.99` into `1998` due to IEEE-754 floating-point precision (`19.99 * 100 === 1998.9999999999998`). Use `Math.round(amount * 100)`.',
    targetFiles: ['src/finance/money.mjs'],
    initialFiles: {
      'src/finance/money.mjs': `export function dollarsToCents(amount) {
  return Math.floor(amount * 100);
}
`,
    },
    workspaceTestFile: `import test from 'node:test';
import assert from 'node:assert/strict';
import { dollarsToCents } from '../src/finance/money.mjs';

test('dollarsToCents converts 19.99 to 1999', () => {
  assert.equal(dollarsToCents(19.99), 1999);
});
`,
    heldOutOracleTestCode: `import test from 'node:test';
import assert from 'node:assert/strict';
import { dollarsToCents } from '../src/finance/money.mjs';

test('Oracle: dollarsToCents handles IEEE-754 edge cases', () => {
  assert.equal(dollarsToCents(19.99), 1999);
  assert.equal(dollarsToCents(1.15), 115);
  assert.equal(dollarsToCents(0), 0);
  assert.equal(dollarsToCents(100.5), 10050);
});
`,
  },

  // ==================== CATEGORY F: ALGORITHMS & PARSERS (26-30) ====================
  {
    id: 'task_26_binary_search',
    category: 'algorithms',
    title: 'Fix upper bound inclusive check in binarySearchIndex',
    prompt:
      'Fix `binarySearchIndex(sorted, target)` in `src/search/binary.mjs` where `while (left < right)` with `right = sorted.length - 1` fails to find `target` when `left === right` (e.g., single-element array or last element). Use `while (left <= right)`.',
    targetFiles: ['src/search/binary.mjs'],
    initialFiles: {
      'src/search/binary.mjs': `export function binarySearchIndex(sorted, target) {
  let left = 0;
  let right = sorted.length - 1;
  while (left < right) {
    const mid = Math.floor((left + right) / 2);
    if (sorted[mid] === target) return mid;
    if (sorted[mid] < target) {
      left = mid + 1;
    } else {
      right = mid - 1;
    }
  }
  return -1;
}
`,
    },
    workspaceTestFile: `import test from 'node:test';
import assert from 'node:assert/strict';
import { binarySearchIndex } from '../src/search/binary.mjs';

test('binarySearchIndex finds last element and single element', () => {
  assert.equal(binarySearchIndex([10, 20, 30], 30), 2);
  assert.equal(binarySearchIndex([42], 42), 0);
});
`,
    heldOutOracleTestCode: `import test from 'node:test';
import assert from 'node:assert/strict';
import { binarySearchIndex } from '../src/search/binary.mjs';

test('Oracle: binarySearchIndex first, middle, last, single, empty, and missing', () => {
  assert.equal(binarySearchIndex([], 5), -1);
  assert.equal(binarySearchIndex([7], 7), 0);
  assert.equal(binarySearchIndex([1, 3, 5, 7, 9], 1), 0);
  assert.equal(binarySearchIndex([1, 3, 5, 7, 9], 9), 4);
  assert.equal(binarySearchIndex([1, 3, 5, 7, 9], 4), -1);
});
`,
  },
  {
    id: 'task_27_anagram_check',
    category: 'algorithms',
    title: 'Ignore case and whitespace in areAnagrams',
    prompt:
      'Fix `areAnagrams(strA, strB)` in `src/string/anagram.mjs` so it normalizes both strings to lowercase and strips whitespace before comparing character counts.',
    targetFiles: ['src/string/anagram.mjs'],
    initialFiles: {
      'src/string/anagram.mjs': `export function areAnagrams(strA, strB) {
  const cleanA = String(strA).split('').sort().join('');
  const cleanB = String(strB).split('').sort().join('');
  return cleanA === cleanB;
}
`,
    },
    workspaceTestFile: `import test from 'node:test';
import assert from 'node:assert/strict';
import { areAnagrams } from '../src/string/anagram.mjs';

test('areAnagrams ignores case and spaces', () => {
  assert.equal(areAnagrams('Dormitory', 'Dirty room'), true);
});
`,
    heldOutOracleTestCode: `import test from 'node:test';
import assert from 'node:assert/strict';
import { areAnagrams } from '../src/string/anagram.mjs';

test('Oracle: areAnagrams case-insensitive and whitespace-insensitive', () => {
  assert.equal(areAnagrams('Listen', 'Silent'), true);
  assert.equal(areAnagrams('Dormitory', 'Dirty room'), true);
  assert.equal(areAnagrams('Hello', 'World'), false);
});
`,
  },
  {
    id: 'task_28_histogram_buckets',
    category: 'algorithms',
    title: 'Fix frequency increment in countFrequencies',
    prompt:
      'Fix `countFrequencies(items)` in `src/stats/frequency.mjs` where `counts[item] = 1` overwrites the count to `1` on repeated items instead of incrementing `(counts[item] ?? 0) + 1`.',
    targetFiles: ['src/stats/frequency.mjs'],
    initialFiles: {
      'src/stats/frequency.mjs': `export function countFrequencies(items) {
  const counts = {};
  for (const item of items) {
    counts[item] = 1;
  }
  return counts;
}
`,
    },
    workspaceTestFile: `import test from 'node:test';
import assert from 'node:assert/strict';
import { countFrequencies } from '../src/stats/frequency.mjs';

test('countFrequencies increments occurrences', () => {
  assert.deepEqual(countFrequencies(['a', 'b', 'a', 'a']), { a: 3, b: 1 });
});
`,
    heldOutOracleTestCode: `import test from 'node:test';
import assert from 'node:assert/strict';
import { countFrequencies } from '../src/stats/frequency.mjs';

test('Oracle: countFrequencies counts multiple keys and empty array', () => {
  assert.deepEqual(countFrequencies([]), {});
  assert.deepEqual(countFrequencies(['x', 'y', 'x', 'z', 'x']), { x: 3, y: 1, z: 1 });
});
`,
  },
  {
    id: 'task_29_markdown_heading',
    category: 'algorithms',
    title: 'Ignore fenced code blocks in extractMarkdownHeadings',
    prompt:
      'Fix `extractMarkdownHeadings(markdown)` in `src/parsers/markdown.mjs` so lines starting with `#` inside fenced code blocks (` ``` `) are ignored.',
    targetFiles: ['src/parsers/markdown.mjs'],
    initialFiles: {
      'src/parsers/markdown.mjs': `export function extractMarkdownHeadings(markdown) {
  const lines = String(markdown).split(/\\r?\\n/);
  const headings = [];
  for (const line of lines) {
    const match = line.match(/^(#{1,6})\\s+(.+)$/);
    if (match) {
      headings.push(match[2].trim());
    }
  }
  return headings;
}
`,
    },
    workspaceTestFile: `import test from 'node:test';
import assert from 'node:assert/strict';
import { extractMarkdownHeadings } from '../src/parsers/markdown.mjs';

test('extractMarkdownHeadings skips comments inside fenced code blocks', () => {
  const md = ['# Title', '\`\`\`bash', '# bash comment', '\`\`\`', '## Section'].join('\\n');
  assert.deepEqual(extractMarkdownHeadings(md), ['Title', 'Section']);
});
`,
    heldOutOracleTestCode: `import test from 'node:test';
import assert from 'node:assert/strict';
import { extractMarkdownHeadings } from '../src/parsers/markdown.mjs';

test('Oracle: extractMarkdownHeadings handles multiple code blocks and heading levels', () => {
  const md = [
    '# H1',
    '\`\`\`python',
    '# not a heading',
    '\`\`\`',
    '### H3',
    '\`\`\`',
    '## also not a heading',
    '\`\`\`',
    '###### H6',
  ].join('\\n');
  assert.deepEqual(extractMarkdownHeadings(md), ['H1', 'H3', 'H6']);
});
`,
  },
  {
    id: 'task_30_interval_merge',
    category: 'algorithms',
    title: 'Sort and merge touching/overlapping intervals in mergeOverlappingIntervals',
    prompt:
      'Fix `mergeOverlappingIntervals(intervals)` in `src/schedule/intervals.mjs` so it sorts intervals by start time first and merges intervals when `next[0] <= current[1]` (instead of `<`).',
    targetFiles: ['src/schedule/intervals.mjs'],
    initialFiles: {
      'src/schedule/intervals.mjs': `export function mergeOverlappingIntervals(intervals) {
  if (!Array.isArray(intervals) || intervals.length === 0) return [];
  const merged = [[...intervals[0]]];
  for (let i = 1; i < intervals.length; i++) {
    const current = merged[merged.length - 1];
    const next = intervals[i];
    if (next[0] < current[1]) {
      current[1] = Math.max(current[1], next[1]);
    } else {
      merged.push([...next]);
    }
  }
  return merged;
}
`,
    },
    workspaceTestFile: `import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeOverlappingIntervals } from '../src/schedule/intervals.mjs';

test('mergeOverlappingIntervals sorts and merges touching intervals', () => {
  assert.deepEqual(
    mergeOverlappingIntervals([[5, 7], [1, 3], [3, 5]]),
    [[1, 7]]
  );
});
`,
    heldOutOracleTestCode: `import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeOverlappingIntervals } from '../src/schedule/intervals.mjs';

test('Oracle: mergeOverlappingIntervals handles unsorted, nested, touching, and disjoint', () => {
  assert.deepEqual(
    mergeOverlappingIntervals([[8, 10], [1, 4], [2, 3], [4, 6]]),
    [[1, 6], [8, 10]]
  );
  assert.deepEqual(mergeOverlappingIntervals([]), []);
});
`,
  },
];
