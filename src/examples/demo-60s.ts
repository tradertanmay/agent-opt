import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AgentOptimizerCore } from '../core/optimizer.js';
import { createConfigForMode } from '../config/index.js';
import {
  formatPlatformHookOutput,
  installPlatformAdapter,
} from '../adapters/index.js';
import { HELD_OUT_TASKS_15 } from '../real-benchmark/held-out-tasks.js';
import { runSingleRealTrial } from '../real-benchmark/runner.js';

async function runLaunchDemonstration(): Promise<void> {
  console.log('================================================================================');
  console.log('  AgentOpt v0.1.0 — Reproducible Side-by-Side Launch Demonstration');
  console.log('  "Make your existing AI coding agent better. No new agent. No workflow migration."');
  console.log('================================================================================\n');

  // Part A: Deterministic Lifecycle Walkthrough (Context Map + Read Dedup + Stop Verification Gate)
  const demoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-opt-60s-demo-'));
  try {
    fs.writeFileSync(
      path.join(demoDir, 'package.json'),
      JSON.stringify(
        {
          name: 'acme-checkout-service',
          version: '1.0.0',
          type: 'module',
          scripts: {
            test: 'node --test test/checkout.test.mjs',
          },
        },
        null,
        2
      ),
      'utf-8'
    );

    fs.mkdirSync(path.join(demoDir, 'src', 'pricing'), { recursive: true });
    fs.mkdirSync(path.join(demoDir, 'src', 'cart'), { recursive: true });
    fs.mkdirSync(path.join(demoDir, 'test'), { recursive: true });

    fs.writeFileSync(
      path.join(demoDir, 'src', 'pricing', 'tiers.mjs'),
      [
        'export function getBulkDiscountRate(quantity) {',
        '  if (quantity >= 100) return 0.15;',
        '  if (quantity >= 25) return 0.08;',
        '  return 0;',
        '}',
      ].join('\n') + '\n',
      'utf-8'
    );

    const brokenCheckout = [
      "import { getBulkDiscountRate } from '../pricing/tiers.mjs';",
      '',
      'export function computeOrderTotalCents(order) {',
      '  const subtotal = order.unitPriceCents * order.quantity;',
      '  const discount = getBulkDiscountRate(order.quantity);',
      '  // BUG: fractional cents not rounded',
      '  return subtotal * (1 - discount);',
      '}',
    ].join('\n') + '\n';

    fs.writeFileSync(path.join(demoDir, 'src', 'cart', 'checkout.mjs'), brokenCheckout, 'utf-8');
    fs.writeFileSync(
      path.join(demoDir, 'test', 'checkout.test.mjs'),
      [
        "import test from 'node:test';",
        "import assert from 'node:assert/strict';",
        "import { computeOrderTotalCents } from '../src/cart/checkout.mjs';",
        "test('computeOrderTotalCents rounds discounted cents to integer', () => {",
        '  assert.equal(computeOrderTotalCents({ unitPriceCents: 33, quantity: 27 }), 820);',
        '});',
      ].join('\n') + '\n',
      'utf-8'
    );

    console.log('[Part 1] Google Antigravity Plugin Installation & Hook Walkthrough');
    const agyInstall = installPlatformAdapter(demoDir, 'google-antigravity');
    console.log(`  + Installed Antigravity bundle: ${agyInstall.installedFiles.map((f) => path.relative(demoDir, f)).join(', ')}`);

    const coreBalanced = new AgentOptimizerCore({
      cwd: demoDir,
      config: createConfigForMode('BALANCED'),
    });
    const sessionId = 'demo_agy_session_01';

    const promptDec = coreBalanced.handleEvent({
      platform: 'google-antigravity',
      sessionId,
      event: 'PreInvocation',
      timestamp: new Date().toISOString(),
      cwd: demoDir,
      userPrompt: 'Fix fractional cent rounding in computeOrderTotalCents and verify bulk discount calculation.',
    });
    console.log(`  + PreInvocation Context Map injected (${promptDec.diagnostics.contextTokensInjected} tokens, ${promptDec.diagnostics.latencyMs}ms):`);
    for (const line of (promptDec.injectedContext || '').split('\n').slice(0, 5)) {
      console.log(`      ${line}`);
    }

    // Simulate agent making an incomplete edit (still broken) and claiming completion
    coreBalanced.handleEvent({
      platform: 'google-antigravity',
      sessionId,
      event: 'PostToolUse',
      timestamp: new Date().toISOString(),
      cwd: demoDir,
      toolName: 'Write',
      toolInput: { file_path: 'src/cart/checkout.mjs', content: brokenCheckout + '// edited\n' },
    });

    const failedStop = coreBalanced.handleEvent({
      platform: 'google-antigravity',
      sessionId,
      event: 'Stop',
      timestamp: new Date().toISOString(),
      cwd: demoDir,
      rawPayload: { last_assistant_message: 'Fixed rounding in checkout.mjs, all tests pass!' },
    });
    const agyStopJson = formatPlatformHookOutput('google-antigravity', 'Stop', failedStop).stdout;
    console.log(`  + Unverified/broken completion intercepted by BALANCED Stop hook:`);
    console.log(`      Action: ${failedStop.action.toUpperCase()} | Status: ${failedStop.diagnostics.verificationStatus}`);
    console.log(`      Antigravity Stop Payload: ${agyStopJson.slice(0, 140)}...`);

    // Fix the file properly -> BALANCED Stop hook verifies in-hook with 0 extra LLM continuations!
    const fixedCheckout = brokenCheckout.replace(
      'return subtotal * (1 - discount);',
      'return Math.round(subtotal * (1 - discount));'
    );
    fs.writeFileSync(path.join(demoDir, 'src', 'cart', 'checkout.mjs'), fixedCheckout, 'utf-8');
    coreBalanced.handleEvent({
      platform: 'google-antigravity',
      sessionId,
      event: 'PostToolUse',
      timestamp: new Date().toISOString(),
      cwd: demoDir,
      toolName: 'Write',
      toolInput: { file_path: 'src/cart/checkout.mjs', content: fixedCheckout },
    });
    const verifiedStop = coreBalanced.handleEvent({
      platform: 'google-antigravity',
      sessionId,
      event: 'Stop',
      timestamp: new Date().toISOString(),
      cwd: demoDir,
      rawPayload: { last_assistant_message: 'Applied Math.round to discounted subtotal.' },
    });
    console.log(`  + After valid fix, BALANCED Stop hook runs silent test probe and releases immediately:`);
    console.log(`      Action: ${verifiedStop.action.toUpperCase()} | Status: ${verifiedStop.diagnostics.verificationStatus}\n`);
  } finally {
    fs.rmSync(demoDir, { recursive: true, force: true });
  }

  // Part B: Real Local Tool-Calling LLM Side-by-Side Execution (Without AgentOpt vs With AgentOpt)
  console.log('[Part 2] Live Side-by-Side Real Coding Task Execution (Without AgentOpt vs With AgentOpt)');
  const demoTask = HELD_OUT_TASKS_15.find((t) => t.id === 'ho_06_bearer_scope_check')!;
  console.log(`  Task ID:     ${demoTask.id} (${demoTask.repoId})`);
  console.log(`  Task Title:  ${demoTask.title}`);
  console.log(`  Target Files: ${demoTask.targetFiles.join(', ')}\n`);

  try {
    const withoutOpt = await runSingleRealTrial(demoTask, 'baseline', 'qwen2.5:7b');
    const withOptFast = await runSingleRealTrial(demoTask, 'FAST', 'qwen2.5:7b');
    const withOptBalanced = await runSingleRealTrial(demoTask, 'BALANCED', 'qwen2.5:7b');

    const tokenReductionPct =
      withoutOpt.inputTokens > 0
        ? (((withoutOpt.inputTokens - withOptFast.inputTokens) / withoutOpt.inputTokens) * 100).toFixed(1)
        : '0.0';
    const timeReductionPct =
      withoutOpt.wallClockMs > 0
        ? (((withoutOpt.wallClockMs - withOptFast.wallClockMs) / withoutOpt.wallClockMs) * 100).toFixed(1)
        : '0.0';

    console.log('  +-----------------------------------------------------------------------------------+');
    console.log('  | Metric                     | Without AgentOpt | With AgentOpt (FAST) | BALANCED   |');
    console.log('  +----------------------------+------------------+----------------------+------------+');
    console.log(
      `  | Held-Out Oracle Passed     | ${String(withoutOpt.heldOutOraclePassed).padEnd(16)} | ${String(withOptFast.heldOutOraclePassed).padEnd(20)} | ${String(withOptBalanced.heldOutOraclePassed).padEnd(10)} |`
    );
    console.log(
      `  | Provider Input Tokens      | ${String(withoutOpt.inputTokens).padEnd(16)} | ${`${withOptFast.inputTokens} (-${tokenReductionPct}%)`.padEnd(20)} | ${String(withOptBalanced.inputTokens).padEnd(10)} |`
    );
    console.log(
      `  | Provider Output Tokens     | ${String(withoutOpt.outputTokens).padEnd(16)} | ${String(withOptFast.outputTokens).padEnd(20)} | ${String(withOptBalanced.outputTokens).padEnd(10)} |`
    );
    console.log(
      `  | Total Inference Tokens     | ${String(withoutOpt.totalTokens).padEnd(16)} | ${String(withOptFast.totalTokens).padEnd(20)} | ${String(withOptBalanced.totalTokens).padEnd(10)} |`
    );
    console.log(
      `  | LLM Turns / Tool Calls     | ${`${withoutOpt.llmTurns} / ${withoutOpt.toolCallsCount}`.padEnd(16)} | ${`${withOptFast.llmTurns} / ${withOptFast.toolCallsCount}`.padEnd(20)} | ${`${withOptBalanced.llmTurns} / ${withOptBalanced.toolCallsCount}`.padEnd(10)} |`
    );
    console.log(
      `  | Wall-Clock Latency (ms)    | ${`${Math.round(withoutOpt.wallClockMs)}ms`.padEnd(16)} | ${`${Math.round(withOptFast.wallClockMs)}ms (-${timeReductionPct}%)`.padEnd(20)} | ${`${Math.round(withOptBalanced.wallClockMs)}ms`.padEnd(10)} |`
    );
    console.log(
      `  | Final Verification Status  | ${withoutOpt.finalVerificationStatus.padEnd(16)} | ${withOptFast.finalVerificationStatus.padEnd(20)} | ${withOptBalanced.finalVerificationStatus.padEnd(10)} |`
    );
    console.log('  +-----------------------------------------------------------------------------------+\n');

    console.log(`  Without AgentOpt Trajectory: ${withoutOpt.traceSummary.join(' -> ')}`);
    console.log(`  With AgentOpt (FAST) Trace:  ${withOptFast.traceSummary.join(' -> ')}`);
    console.log(`  With AgentOpt (BALANCED):    ${withOptBalanced.traceSummary.join(' -> ')}\n`);

    console.log(
      '  [Methodological Note] This single-task side-by-side recording illustrates how AgentOpt'
    );
    console.log(
      '  replaces blind repository scanning with targeted symbol/file context and in-hook verification.'
    );
    console.log(
      '  Single runs must not be extrapolated as universal performance; see docs/HELD_OUT_BENCHMARK_REPORT.md'
    );
    console.log(
      '  for full multi-repository held-out benchmark aggregates, confidence intervals, and failure logs.\n'
    );

    const outPath = path.resolve(process.cwd(), 'benchmarks/launch-demo-recording.json');
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(
      outPath,
      JSON.stringify(
        {
          recordedAt: new Date().toISOString(),
          taskId: demoTask.id,
          repoId: demoTask.repoId,
          withoutAgentOpt: withoutOpt,
          withAgentOptFast: withOptFast,
          withAgentOptBalanced: withOptBalanced,
        },
        null,
        2
      ),
      'utf-8'
    );
  } catch (err) {
    console.log(
      `  [Note] Local Ollama server not reachable for live LLM portion (${(err as Error).message}).`
    );
  }
}

runLaunchDemonstration();
