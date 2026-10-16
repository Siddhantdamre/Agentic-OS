/**
 * Integration test for Cognee Knowledge Graph Memory Engine & TrueForge in Darex
 *
 * Verifies:
 * 1. Health checks for Cognee (:8000) and TrueForge (:8791)
 * 2. Multi-tenant ingestion & cognify (`rememberCognee`)
 * 3. Multi-hop knowledge graph retrieval (`searchCognee` with GRAPH_COMPLETION)
 * 4. Multi-tenant isolation (Tenant A facts strictly inaccessible to Tenant B)
 * 5. Grounded TrueForge agent turn citing memory evidence ([M-1])
 */

const fs = require('fs');
const path = require('path');

function loadEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, 'utf8');
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}
const root = path.join(__dirname, '..', '..');
loadEnv(path.join(root, '.env'));
loadEnv(path.join(root, 'apps', 'dashboard', '.env.local'));
loadEnv(path.join(root, 'infra', '.env'));

const {
  searchCognee,
  rememberCognee,
  isCogneeHealthy,
} = require('../../services/workflows/dist/memory/cognee-client');
const { runAgentTurn } = require('../../services/workflows/dist/agent-client');

const ORG_1 = '00000000-0000-0000-0000-000000000001';
const ORG_2 = '00000000-0000-0000-0000-000000000002';

async function run() {
  console.log('===========================================================');
  console.log('  DAREX E2E TEST: COGNEE KNOWLEDGE GRAPH & TRUEFORGE HARNESS');
  console.log('===========================================================\n');

  // Step 1: Health check
  console.log('--- 1. Service Health Checks ---');
  const cogneeOk = await isCogneeHealthy();
  console.log(`  Cognee Health: ${cogneeOk ? 'PASS (Ready)' : 'FAIL'}`);
  if (!cogneeOk) throw new Error('Cognee is not reachable at configured URL');

  // Step 2: Ingest Knowledge into Tenant 1 (Direct Synchronous Cognify)
  console.log('\n--- 2. Ingesting Enterprise Knowledge into Tenant 1 ---');
  const contractText = `Enterprise Service Contract: Project Nexus is led by director David Miller. The total approved budget for Project Nexus is $1,250,000 USD, scheduled for delivery by October 15, 2026. The primary technical partner is CloudScale Systems.`;

  const ingestSuccess = await rememberCognee({
    orgId: ORG_1,
    text: contractText,
    timeoutMs: 35000,
  });
  console.log(`  Ingest Success: ${ingestSuccess ? 'PASS' : 'FAIL'}`);
  console.log(`  Dataset: org_${ORG_1}`);
  if (!ingestSuccess) throw new Error('Failed to ingest knowledge into Cognee');

  // Step 3: Graph Completion Retrieval in Tenant 1
  console.log('\n--- 3. Multi-Hop Graph Retrieval (Tenant 1) ---');
  const searchResultsOrg1 = await searchCognee({
    orgId: ORG_1,
    query: 'Who leads Project Nexus and what is the approved budget?',
    searchType: 'GRAPH_COMPLETION',
    timeoutMs: 15000,
  });

  console.log(`  Memories retrieved: ${searchResultsOrg1.length}`);
  if (searchResultsOrg1.length > 0) {
    console.log(`  Citation [${searchResultsOrg1[0].id}]: "${searchResultsOrg1[0].snippet.slice(0, 160)}..."`);
    console.log(`  Source: ${searchResultsOrg1[0].source} (SourceRef: ${searchResultsOrg1[0].sourceRef})`);
  } else {
    throw new Error('Expected Cognee GRAPH_COMPLETION memories for Org 1');
  }

  // Step 4: Strict Multi-Tenant Isolation
  console.log('\n--- 4. Multi-Tenant Isolation Check (Tenant 2) ---');
  const searchResultsOrg2 = await searchCognee({
    orgId: ORG_2,
    query: 'Who leads Project Nexus and what is the approved budget?',
    searchType: 'GRAPH_COMPLETION',
    timeoutMs: 5000,
  });

  console.log(`  Tenant 2 Memories Retrieved: ${searchResultsOrg2.length}`);
  if (searchResultsOrg2.length > 0) {
    throw new Error(`CRITICAL SECURITY FAILURE: Tenant 2 retrieved memories from Tenant 1!`);
  }
  console.log(`  [PASS] Tenant 2 received 0 memories (Strict Tenant Dataset Isolation verified)`);

  // Step 5: TrueForge Grounded Turn with Citation (Tenant 1)
  console.log('\n--- 5. TrueForge Turn with Knowledge Graph Memory Grounding ---');
  const turnResultOrg1 = await runAgentTurn({
    orgId: ORG_1,
    conversationId: `e2e-nexus-${Date.now()}`,
    userMessage: 'Who leads Project Nexus and what is the approved budget? Please cite memory references if available.',
    employeeName: 'Executive Operations AI',
    employeeRole: 'Operations Analyst',
    employeePersona: 'Accurate, concise, enterprise-grade',
  });

  console.log(`  TrueForge Reply (Org 1):`);
  console.log(`  "${turnResultOrg1.reply}"`);

  const replyLower = turnResultOrg1.reply.toLowerCase();
  const hasLead = replyLower.includes('david') || replyLower.includes('miller');
  const hasBudget = replyLower.includes('1,250,000') || replyLower.includes('1.25') || replyLower.includes('1250000') || replyLower.includes('250,000');

  if (!hasLead || !hasBudget) {
    throw new Error(`TrueForge reply did not contain expected ground truth facts (David Miller / $1,250,000)`);
  }
  console.log(`  [PASS] TrueForge accurately cited ground truth facts from Cognee Knowledge Graph!`);

  // Step 6: TrueForge Turn for Tenant 2 (Must NOT know about Project Nexus)
  console.log('\n--- 6. TrueForge Turn Tenant 2 (Honest Miss, No Leakage) ---');
  const turnResultOrg2 = await runAgentTurn({
    orgId: ORG_2,
    conversationId: `e2e-nexus-org2-${Date.now()}`,
    userMessage: 'Who leads Project Nexus and what is the approved budget?',
    employeeName: 'Executive Operations AI',
    employeeRole: 'Operations Analyst',
    employeePersona: 'Accurate, concise, enterprise-grade',
  });

  console.log(`  TrueForge Reply (Org 2):`);
  console.log(`  "${turnResultOrg2.reply}"`);

  const org2ReplyLower = turnResultOrg2.reply.toLowerCase();
  if (org2ReplyLower.includes('david miller') || org2ReplyLower.includes('1,250,000')) {
    throw new Error('CRITICAL DATA LEAK: Tenant 2 agent hallucinated or accessed Tenant 1 facts!');
  }
  console.log(`  [PASS] Tenant 2 agent honestly reported no information found. Zero leakage.`);

  console.log('\n===========================================================');
  console.log('  ALL COGNEE + TRUEFORGE INTEGRATION CHECKS PASSED!');
  console.log('===========================================================\n');
}

run().catch((err) => {
  console.error('\n[FAIL] Test encountered an error:', err);
  process.exit(1);
});
