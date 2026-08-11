import 'dotenv/config';
import { Worker, NativeConnection } from '@temporalio/worker';
import * as activities from './activities/index.js';

async function runWorker() {
  const temporalHost = process.env.TEMPORAL_ADDRESS || 'localhost:7233';
  console.log(`🚀 Starting DareX Temporal Autonomous Agent Worker connecting to ${temporalHost}...`);

  try {
    const connection = await NativeConnection.connect({ address: temporalHost });
    const worker = await Worker.create({
      connection,
      workflowsPath: require.resolve('./workflows/AutonomousAgentWorkflow.js'),
      activities,
      taskQueue: 'darex-agent-tasks',
    });

    console.log('✅ Temporal Agent Worker successfully connected and listening on task queue: "darex-agent-tasks"');
    await worker.run();
  } catch (err: any) {
    console.error('⚠️ Worker failed to connect to Temporal Server:', err.message);
    console.log('Worker will retry on schedule...');
  }
}

runWorker().catch((err) => {
  console.error('Fatal Worker Error:', err);
  process.exit(1);
});
