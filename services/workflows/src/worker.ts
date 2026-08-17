import 'dotenv/config';
import { Worker, NativeConnection } from '@temporalio/worker';
import * as activities from './activities/index.js';
import { assertEmbeddingWorkerConfig } from './activities/embed.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runWorker() {
  // Prod fail-fast: unset EMBEDDING_MODEL kills this process, not webhooks.
  assertEmbeddingWorkerConfig();

  const temporalHost = process.env.TEMPORAL_ADDRESS || 'localhost:7233';
  let delayMs = 2000;

  for (;;) {
    console.log(`Starting DareX Temporal Autonomous Agent Worker connecting to ${temporalHost}...`);
    try {
      const connection = await NativeConnection.connect({ address: temporalHost });
      // Workflows registered via workflows/index.ts on this queue:
      //   AutonomousAgentWorkflow, CrewWorkflow, WorkItemWorkflow (O2 wrap),
      //   EmbedWorkflow (M2 — additive), MemoryWriteBackWorkflow (M4 child),
      //   IngestWorkflow / SyncWorkflow (K1–K3 — additive),
      //   PlanExecuteWorkflow (O4), OwnerBriefingWorkflow + StaleChaseWorkflow (O5),
      //   NurtureWorkflow (O6), InsightActionWorkflow (A3),
      //   InstallPackWorkflow + ShowingScheduleWorkflow + RentReminderWorkflow (WS-21).
      // Do not replace this worker or swap the task queue.
      const worker = await Worker.create({
        connection,
        workflowsPath: require.resolve('./workflows/index.js'),
        activities,
        taskQueue: 'darex-agent-tasks',
      });

      console.log('Temporal Agent Worker connected and listening on task queue: "darex-agent-tasks"');
      delayMs = 2000;
      await worker.run();
      return;
    } catch (err: any) {
      console.error('Worker failed to connect to Temporal Server:', err.message);
      console.log(`Retrying in ${Math.round(delayMs / 1000)}s...`);
      await sleep(delayMs);
      delayMs = Math.min(delayMs * 2, 30000);
    }
  }
}

runWorker().catch((err) => {
  console.error('Fatal Worker Error:', err);
  process.exit(1);
});
