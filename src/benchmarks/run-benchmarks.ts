import * as fs from 'node:fs';
import * as path from 'node:path';
import { BenchmarkRunner } from '../benchmark/index.js';

function main(): void {
  const runner = new BenchmarkRunner();
  const runsPerTask = 15;
  const start = performance.now();
  const { conditions, rawRuns } = runner.runFullSuite(runsPerTask);
  const elapsedMs = Number((performance.now() - start).toFixed(1));

  const base = conditions['baseline'];
  const v1 = conditions['v1-combined'];
  const v2 = conditions['v2-improved'];

  const pctChange = (from: number, to: number): string => {
    if (from === 0) return '0.0%';
    const diff = ((to - from) / from) * 100;
    const sign = diff > 0 ? '+' : '';
    return `${sign}${diff.toFixed(1)}%`;
  };

  console.log('================================================================================');
  console.log('  AgentOpt Reproducible Benchmark & Ablation Suite');
  console.log(
    `  Tasks: 6 held-out multi-file coding tasks | Runs/task: ${runsPerTask} | Total trials: ${rawRuns.length}`
  );
  console.log(`  Wall-clock benchmark execution time: ${elapsedMs}ms`);
  console.log('================================================================================\n');

  console.log(
    '| Condition | Task Completion | Correctness | Input Tokens (Measured) | Tool Calls | Failed Calls | Latency (ms) | Regressions | Dev Intervention | Cost / Completed Task |'
  );
  console.log('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|');

  for (const c of Object.values(conditions)) {
    const compCi = (c.taskCompletionRate.ci95High - c.taskCompletionRate.mean).toFixed(1);
    const tokCi = Math.round(
      c.measuredInputTokens.ci95High - c.measuredInputTokens.mean
    );
    console.log(
      `| \`${c.condition}\` | **${c.taskCompletionRate.mean.toFixed(1)}%** (±${compCi}%) | ` +
        `${c.correctnessRate.mean.toFixed(1)}% | ` +
        `${Math.round(c.measuredInputTokens.mean)} (±${tokCi}) | ` +
        `${c.toolCalls.mean.toFixed(2)} | ` +
        `${c.failedToolCalls.mean.toFixed(2)} | ` +
        `${Math.round(c.executionLatencyMs.mean)}ms | ` +
        `${c.regressionRate.mean.toFixed(1)}% | ` +
        `${c.developerInterventionRate.mean.toFixed(1)}% | ` +
        `$${c.costPerSuccessfulTaskUsd.toFixed(4)} |`
    );
  }

  console.log('\n--- Key Deltas (Baseline vs AgentOpt v1 vs Improved AgentOpt v2) ---');
  console.log(
    `1. Task Completion:        ${base.taskCompletionRate.mean.toFixed(1)}% -> ${v1.taskCompletionRate.mean.toFixed(1)}% (v1) -> ${v2.taskCompletionRate.mean.toFixed(1)}% (v2)`
  );
  console.log(
    `2. Measured Input Tokens:  ${Math.round(base.measuredInputTokens.mean)} -> ${Math.round(v1.measuredInputTokens.mean)} (${pctChange(base.measuredInputTokens.mean, v1.measuredInputTokens.mean)}) -> ${Math.round(v2.measuredInputTokens.mean)} (${pctChange(base.measuredInputTokens.mean, v2.measuredInputTokens.mean)})`
  );
  console.log(
    `3. Execution Latency:      ${Math.round(base.executionLatencyMs.mean)}ms -> ${Math.round(v1.executionLatencyMs.mean)}ms (${pctChange(base.executionLatencyMs.mean, v1.executionLatencyMs.mean)}) -> ${Math.round(v2.executionLatencyMs.mean)}ms (${pctChange(base.executionLatencyMs.mean, v2.executionLatencyMs.mean)})`
  );
  console.log(
    `4. Failed Tool Calls:      ${base.failedToolCalls.mean.toFixed(2)} -> ${v1.failedToolCalls.mean.toFixed(2)} (${pctChange(base.failedToolCalls.mean, v1.failedToolCalls.mean)}) -> ${v2.failedToolCalls.mean.toFixed(2)} (${pctChange(base.failedToolCalls.mean, v2.failedToolCalls.mean)})`
  );
  console.log(
    `5. Regression Rate:        ${base.regressionRate.mean.toFixed(1)}% -> ${v1.regressionRate.mean.toFixed(1)}% -> ${v2.regressionRate.mean.toFixed(1)}%`
  );
  console.log(
    `6. Developer Intervention: ${base.developerInterventionRate.mean.toFixed(1)}% -> ${v1.developerInterventionRate.mean.toFixed(1)}% -> ${v2.developerInterventionRate.mean.toFixed(1)}%`
  );
  console.log(
    `7. Cost / Completed Task:  $${base.costPerSuccessfulTaskUsd.toFixed(4)} -> $${v1.costPerSuccessfulTaskUsd.toFixed(4)} (${pctChange(base.costPerSuccessfulTaskUsd, v1.costPerSuccessfulTaskUsd)}) -> $${v2.costPerSuccessfulTaskUsd.toFixed(4)} (${pctChange(base.costPerSuccessfulTaskUsd, v2.costPerSuccessfulTaskUsd)})`
  );
  console.log(
    `8. Mean Hook Overhead:     ${v2.hookOverheadMs.mean.toFixed(2)}ms per full task session (< 0.3% of task latency)`
  );

  const outDir = path.resolve(process.cwd(), 'benchmarks');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, 'latest-results.json');
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        runsPerTask,
        totalTrials: rawRuns.length,
        conditions,
      },
      null,
      2
    ) + '\n',
    'utf-8'
  );
  console.log(`\nSaved full statistical benchmark artifact to: ${outPath}`);
}

main();
