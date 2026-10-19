import * as fs from 'node:fs';
import * as path from 'node:path';
import { HELD_OUT_TASKS_15 } from './held-out-tasks.js';
import { REAL_BENCHMARK_TASKS_30 } from './tasks-30.js';
import {
  aggregateConditionResults,
  computePairedDelta95CI,
  ConditionAggregate,
  createTaskWorkspace,
  ExperimentCondition,
  RealTrialRecord,
  runHeldOutOracleTests,
  runSingleRealTrial,
  runWorkspaceTests,
} from './runner.js';

export interface HeldOutEvaluationSummary {
  generatedAt: string;
  evaluationType: 'FROZEN_HELD_OUT_MULTI_REPO';
  evidenceClassification: 'REAL_LOCAL_TOOL_CALLING_LLM';
  modelName: string;
  repositoriesCount: number;
  tasksCount: number;
  conditions: ExperimentCondition[];
  totalRealRuns: number;
  prespecifiedDecisionRule: {
    rule: string;
    fastOracleRatePct: number;
    balancedOracleRatePct: number;
    fastMeanInputTokens: number;
    balancedMeanInputTokens: number;
    fastMeanWallClockMs: number;
    balancedMeanWallClockMs: number;
    recommendedDefaultMode: 'FAST' | 'BALANCED';
    rationale: string;
  };
  aggregates: Record<'baseline' | 'FAST' | 'BALANCED' | 'STRICT', ConditionAggregate>;
  pairedComparisonsVsBaseline: Record<
    'FAST' | 'BALANCED' | 'STRICT',
    {
      oracleRateDiffPct: number;
      pairedTaskWins: number;
      pairedTaskLosses: number;
      pairedTaskTies: number;
      inputTokens: ReturnType<typeof computePairedDelta95CI>;
      outputTokens: ReturnType<typeof computePairedDelta95CI>;
      totalTokens: ReturnType<typeof computePairedDelta95CI>;
      wallClockMs: ReturnType<typeof computePairedDelta95CI>;
      equivalentCostUsd: ReturnType<typeof computePairedDelta95CI>;
    }
  >;
  repositoryBreakdown: Array<{
    repoId: string;
    tasksCount: number;
    baselineOracleRatePct: number;
    fastOracleRatePct: number;
    balancedOracleRatePct: number;
    strictOracleRatePct: number;
    baselineMeanInputTokens: number;
    fastMeanInputTokens: number;
    balancedMeanInputTokens: number;
    strictMeanInputTokens: number;
  }>;
  failedTrialsPreserved: RealTrialRecord[];
  developmentSetRegressionVerification: {
    tasksTested: string[];
    trials: RealTrialRecord[];
  };
  trials: RealTrialRecord[];
}

export async function runHeldOutModeEvaluation(
  outputPath: string,
  modelName = 'qwen2.5:7b'
): Promise<HeldOutEvaluationSummary> {
  // 1. Pre-flight verification that all 15 frozen held-out tasks fail before agent edits
  for (const task of HELD_OUT_TASKS_15) {
    const dir = createTaskWorkspace(task);
    try {
      const ws = runWorkspaceTests(dir);
      const ora = runHeldOutOracleTests(dir, task);
      if (ws.passed || ora.passed) {
        throw new Error(`Held-out task ${task.id} passed before fix!`);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  const conditions: Array<'baseline' | 'FAST' | 'BALANCED' | 'STRICT'> = [
    'baseline',
    'FAST',
    'BALANCED',
    'STRICT',
  ];

  // 2. Verify development set regressions (task_01 and task_03) across all 4 conditions
  const devRegTasks = REAL_BENCHMARK_TASKS_30.filter(
    (t) => t.id === 'task_01_lru_eviction' || t.id === 'task_03_deep_freeze_array'
  );
  const devRegTrials: RealTrialRecord[] = [];
  for (const task of devRegTasks) {
    for (const cond of conditions) {
      const rec = await runSingleRealTrial(task, cond, modelName);
      devRegTrials.push(rec);
      process.stdout.write(
        `[Dev Regression Check] ${task.id} | ${cond.padEnd(8)} | ws=${rec.workspaceTestsPassed} ora=${rec.heldOutOraclePassed} inTok=${rec.inputTokens} outTok=${rec.outputTokens} turns=${rec.llmTurns} stopBlocks=${rec.stopHookInterceptions}\n`
      );
    }
  }

  // 3. Run the 15-task frozen held-out test set across 5 repositories (60 runs)
  const allTrials: RealTrialRecord[] = [];
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const partialPath = outputPath + '.partial.json';
  if (fs.existsSync(partialPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(partialPath, 'utf8')) as {
        trials?: RealTrialRecord[];
      };
      if (Array.isArray(parsed.trials)) {
        allTrials.push(...parsed.trials);
      }
    } catch {
      // ignore
    }
  }

  for (let i = 0; i < HELD_OUT_TASKS_15.length; i++) {
    const task = HELD_OUT_TASKS_15[i];
    for (const cond of conditions) {
      const existing = allTrials.find(
        (r) => r.taskId === task.id && r.condition === cond
      );
      if (existing) continue;
      const rec = await runSingleRealTrial(task, cond, modelName);
      allTrials.push(rec);
      process.stdout.write(
        `[Held-Out ${i + 1}/15 ${task.id} (${task.repoId})] ${cond.padEnd(8)} | ` +
          `ws=${rec.workspaceTestsPassed} ora=${rec.heldOutOraclePassed} | ` +
          `in=${rec.inputTokens} out=${rec.outputTokens} tot=${rec.totalTokens} | ` +
          `turns=${rec.llmTurns} stopBlocks=${rec.stopHookInterceptions} time=${Math.round(rec.wallClockMs)}ms\n`
      );
      fs.writeFileSync(
        partialPath,
        JSON.stringify({ trialsCount: allTrials.length, trials: allTrials }, null, 2),
        'utf8'
      );
    }
  }

  const aggregates = {
    baseline: aggregateConditionResults(allTrials, 'baseline'),
    FAST: aggregateConditionResults(allTrials, 'FAST'),
    BALANCED: aggregateConditionResults(allTrials, 'BALANCED'),
    STRICT: aggregateConditionResults(allTrials, 'STRICT'),
  };

  const baseRecords = HELD_OUT_TASKS_15.map(
    (t) => allTrials.find((r) => r.taskId === t.id && r.condition === 'baseline')!
  );

  const buildPaired = (cond: 'FAST' | 'BALANCED' | 'STRICT') => {
    const treatRecords = HELD_OUT_TASKS_15.map(
      (t) => allTrials.find((r) => r.taskId === t.id && r.condition === cond)!
    );
    let wins = 0;
    let losses = 0;
    let ties = 0;
    for (let i = 0; i < HELD_OUT_TASKS_15.length; i++) {
      const bPass = baseRecords[i].heldOutOraclePassed;
      const tPass = treatRecords[i].heldOutOraclePassed;
      if (tPass && !bPass) wins++;
      else if (!tPass && bPass) losses++;
      else ties++;
    }
    return {
      oracleRateDiffPct: Number(
        (
          aggregates[cond].oracleCompletion.ratePct -
          aggregates.baseline.oracleCompletion.ratePct
        ).toFixed(1)
      ),
      pairedTaskWins: wins,
      pairedTaskLosses: losses,
      pairedTaskTies: ties,
      inputTokens: computePairedDelta95CI(
        baseRecords.map((r) => r.inputTokens),
        treatRecords.map((r) => r.inputTokens)
      ),
      outputTokens: computePairedDelta95CI(
        baseRecords.map((r) => r.outputTokens),
        treatRecords.map((r) => r.outputTokens)
      ),
      totalTokens: computePairedDelta95CI(
        baseRecords.map((r) => r.totalTokens),
        treatRecords.map((r) => r.totalTokens)
      ),
      wallClockMs: computePairedDelta95CI(
        baseRecords.map((r) => r.wallClockMs),
        treatRecords.map((r) => r.wallClockMs)
      ),
      equivalentCostUsd: computePairedDelta95CI(
        baseRecords.map((r) => r.equivalentApiCostUsd),
        treatRecords.map((r) => r.equivalentApiCostUsd)
      ),
    };
  };

  const repoIds = [
    'repo-fintech-ledger',
    'repo-http-gateway',
    'repo-workflow-dag',
    'repo-schema-sanitizer',
    'repo-search-analytics',
  ];

  const repositoryBreakdown = repoIds.map((repoId) => {
    const repoTaskIds = new Set(
      HELD_OUT_TASKS_15.filter((t) => t.repoId === repoId).map((t) => t.id)
    );
    const forCond = (c: ExperimentCondition) =>
      allTrials.filter((r) => repoTaskIds.has(r.taskId) && r.condition === c);
    const rate = (arr: RealTrialRecord[]) =>
      arr.length > 0
        ? Number(
            ((arr.filter((r) => r.heldOutOraclePassed).length / arr.length) * 100).toFixed(1)
          )
        : 0;
    const meanIn = (arr: RealTrialRecord[]) =>
      arr.length > 0
        ? Math.round(arr.reduce((a, r) => a + r.inputTokens, 0) / arr.length)
        : 0;

    return {
      repoId,
      tasksCount: repoTaskIds.size,
      baselineOracleRatePct: rate(forCond('baseline')),
      fastOracleRatePct: rate(forCond('FAST')),
      balancedOracleRatePct: rate(forCond('BALANCED')),
      strictOracleRatePct: rate(forCond('STRICT')),
      baselineMeanInputTokens: meanIn(forCond('baseline')),
      fastMeanInputTokens: meanIn(forCond('FAST')),
      balancedMeanInputTokens: meanIn(forCond('BALANCED')),
      strictMeanInputTokens: meanIn(forCond('STRICT')),
    };
  });

  // Evaluate prespecified decision rule for default mode (BALANCED vs FAST)
  const fastRate = aggregates.FAST.oracleCompletion.ratePct;
  const balRate = aggregates.BALANCED.oracleCompletion.ratePct;
  const fastIn = aggregates.FAST.meanInputTokens;
  const balIn = aggregates.BALANCED.meanInputTokens;
  const fastMs = aggregates.FAST.meanWallClockMs;
  const balMs = aggregates.BALANCED.meanWallClockMs;

  const isBalancedStrictlySuperior =
    balRate > fastRate ||
    (balRate === fastRate && balIn < fastIn && balMs < fastMs);
  const recommendedDefaultMode: 'FAST' | 'BALANCED' = isBalancedStrictlySuperior
    ? 'BALANCED'
    : 'FAST';

  const rationale = isBalancedStrictlySuperior
    ? `BALANCED achieved higher held-out oracle completion (${balRate}% vs ${fastRate}%) and is selected as the default mode.`
    : `Under the prespecified evaluation rule, BALANCED (${balRate}% oracle completion, ${balIn} mean input tokens, ${balMs}ms latency) did not outperform FAST (${fastRate}% oracle completion, ${fastIn} mean input tokens, ${fastMs}ms latency); therefore FAST is selected as the default mode, with BALANCED and STRICT available as opt-in verification modes.`;

  const summary: HeldOutEvaluationSummary = {
    generatedAt: new Date().toISOString(),
    evaluationType: 'FROZEN_HELD_OUT_MULTI_REPO',
    evidenceClassification: 'REAL_LOCAL_TOOL_CALLING_LLM',
    modelName,
    repositoriesCount: repoIds.length,
    tasksCount: HELD_OUT_TASKS_15.length,
    conditions,
    totalRealRuns: allTrials.length,
    prespecifiedDecisionRule: {
      rule: 'Default to BALANCED only if BALANCED > FAST on held-out oracle completion rate (or equal completion with lower token and latency cost); otherwise default to FAST.',
      fastOracleRatePct: fastRate,
      balancedOracleRatePct: balRate,
      fastMeanInputTokens: fastIn,
      balancedMeanInputTokens: balIn,
      fastMeanWallClockMs: fastMs,
      balancedMeanWallClockMs: balMs,
      recommendedDefaultMode,
      rationale,
    },
    aggregates,
    pairedComparisonsVsBaseline: {
      FAST: buildPaired('FAST'),
      BALANCED: buildPaired('BALANCED'),
      STRICT: buildPaired('STRICT'),
    },
    repositoryBreakdown,
    failedTrialsPreserved: allTrials.filter((r) => !r.heldOutOraclePassed),
    developmentSetRegressionVerification: {
      tasksTested: devRegTasks.map((t) => t.id),
      trials: devRegTrials,
    },
    trials: allTrials,
  };

  fs.writeFileSync(outputPath, JSON.stringify(summary, null, 2), 'utf8');
  return summary;
}

import { pathToFileURL } from 'node:url';

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const out = path.resolve(process.cwd(), 'benchmarks/held-out-modes-results.json');
  runHeldOutModeEvaluation(out)
    .then((res) => {
      console.log('\n=== HELD-OUT MULTI-REPO EVALUATION COMPLETE ===');
      console.log('Recommended Default Mode:', res.prespecifiedDecisionRule.recommendedDefaultMode);
      console.log('Rationale:', res.prespecifiedDecisionRule.rationale);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}

