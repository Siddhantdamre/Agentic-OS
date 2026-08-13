import 'dotenv/config';
import { Worker, NativeConnection } from '@temporalio/worker';
import * as activities from './activities/index.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runWorker() {
  const temporalHost = process.env.TEMPORAL_ADDRESS || 'localhost:7233';
  let delayMs = 2000;

  for (;;) {
    console.log(`Starting DareX Temporal Autonomous Agent Worker connecting to ${temporalHost}...`);
    try {
      const connection = await NativeConnection.connect({ address: temporalHost });
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
