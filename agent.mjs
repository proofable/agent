#!/usr/bin/env node
/**
 * The Proofable agent. agent.json defines it; every command uses the hosted MCP server.
 *
 *   setup [--no-browser]                 own key and identity, then the owner signs its permission
 *   permit                               print the link that signs or renews the permission
 *   status                               identity, limits, and what the permission allows
 *   job "<task>" [--repo owner/name] [--ref <commit>] [--computer]
 *   verify [run folder | latest]         check a job's signed records offline
 *   listing [--publish]                  save the listing that runs as this agent
 */
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Wallet } from 'ethers';
import { getHostedAgentCreateUrl, verifyPortableProofEnvelope } from '@proofable/sdk';
import { evaluateRuntimeAction, isRuntimeBundle } from '@proofable/sdk/runtime-mount';
import { API_URL, MCP_URL, accessKey, close, fetchWithRetry, listTools, serviceRevision, tool } from './mcp.mjs';

const AGENT_FILE = resolve('agent.json');
const KEY_FILE = resolve('.agent', 'key.json');
export const RUNS = resolve(process.env.PROOFABLE_RUNS_DIR || 'runs');
const DAY_MS = 86_400_000;
export const TERMINAL = ['completed', 'failed', 'cancelled'];
const QHASH = /^0x[0-9a-f]{64}$/i;
const SHA = /^[0-9a-f]{40}$/i;
const REPO = /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9_.-]+$/;

const lower = (v) => String(v || '').toLowerCase();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const writeJson = (file, value) => writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
export const readAgent = () => JSON.parse(readFileSync(AGENT_FILE, 'utf8'));
const statementOf = (envelope) => { try { return JSON.parse(envelope?.data?.content || 'null'); } catch { return null; } };
const untilText = (expiresAt) => (expiresAt ? `until ${new Date(Number(expiresAt)).toISOString().slice(0, 10)}` : 'with no end date');

/** Proofable refused the agent: no active permission, or an action the permission does not allow. */
export class Refused extends Error {
  constructor(message, decisionQHash = null) {
    super(message);
    this.decisionQHash = decisionQHash;
  }
}

async function ownerWallet(t = tool) {
  const ctx = await t('proofable_context', {});
  const address = lower(ctx?.profileContext?.principal?.primaryAccount);
  if (!/^0x[0-9a-f]{40}$/.test(address)) throw new Error('This access key has no wallet account to own an agent.');
  return address;
}

/** The agent's own key. It signs the agent's identity and never leaves this machine. */
function agentKey() {
  if (!existsSync(KEY_FILE)) {
    mkdirSync(resolve('.agent'), { recursive: true });
    const wallet = Wallet.createRandom();
    writeJson(KEY_FILE, { address: lower(wallet.address), privateKey: wallet.privateKey });
    try { chmodSync(KEY_FILE, 0o600); } catch { /* not every file system supports it */ }
  }
  return new Wallet(JSON.parse(readFileSync(KEY_FILE, 'utf8')).privateKey);
}

/** The limits in agent.json. A missing or zero `expiresInDays` means the permission has no end date. */
function limits(agent) {
  const days = Number(agent.permission.expiresInDays);
  const expiresAt = Number.isFinite(days) && days > 0 ? Date.now() + days * DAY_MS : undefined;
  return { actions: agent.permission.actions, expiresAt, maxSpend: String(agent.permission.maxSpend ?? '0') };
}

// ── identity and permission ─────────────────────────────────────────────────────────────
async function setup(flags) {
  const agent = readAgent();
  const owner = await ownerWallet();
  console.log(`Connected to ${MCP_URL} as ${owner} (${(await listTools()).length} tools).`);

  const key = agentKey();
  const agentWallet = lower(key.address);
  if (agent.agentWallet && lower(agent.agentWallet) !== agentWallet) {
    throw new Error(`agent.json names account ${agent.agentWallet}, but .agent/key.json holds ${agentWallet}.`);
  }
  const { actions, expiresAt, maxSpend } = limits(agent);
  const create = (extra = {}) => tool('proofable_agent_create', {
    agentId: agent.agentId,
    agentWallet,
    agentLabel: agent.label,
    agentType: 'agent',
    description: agent.description,
    instructions: agent.instructions,
    capabilities: ['mcp', 'receipts', 'delegation'],
    defaultRuntime: { origin: 'hosted' },
    delegationAllowedActions: actions,
    expiresAt,
    maxSpend,
    ...extra,
  });

  let res = await create();
  let identity = agent.identity || res?.proofs?.identity?.qHash || null;
  const step = res?.signatures?.step1_agent_identity;
  if (step) {
    const p = step.nextCall.params;
    const signed = await tool('proofable_verify', {
      walletAddress: p.walletAddress,
      verifierIds: p.verifierIds,
      data: p.data,
      chain: p.chain,
      signedTimestamp: p.signedTimestamp,
      signature: await key.signMessage(step.signerString),
    });
    identity = signed?.qHash;
  }
  if (!QHASH.test(String(identity || ''))) throw new Error(`The identity was not recorded: ${JSON.stringify(res?.message || res).slice(0, 300)}`);
  writeJson(AGENT_FILE, { ...agent, agentWallet, identity });
  console.log(`${agent.label} has its own account ${agentWallet} and a signed identity.`);

  if (flags['no-browser']) {
    res = await create({ identityQHash: identity });
    if (res?.linked !== true) throw new Error(`The permission was not recorded: ${JSON.stringify(res?.message || res).slice(0, 300)}`);
    console.log('Permission recorded from your access key. Run `npm run status`.');
    return;
  }
  await permit();
}

async function permit() {
  const agent = readAgent();
  if (!agent.agentWallet || !agent.identity) throw new Error('Run `npm run setup` first.');
  const { actions, expiresAt, maxSpend } = limits(agent);
  const url = getHostedAgentCreateUrl({
    agentId: agent.agentId,
    agentWallet: agent.agentWallet,
    controllerWallet: await ownerWallet(),
    identityQHash: agent.identity,
    agentLabel: agent.label,
    agentType: 'agent',
    allowedActions: actions,
    expiresAt,
    maxSpend,
  });
  console.log(`\nSign the permission with your wallet:\n\n${url}\n`);
  console.log(`It allows ${actions.join(', ')} ${untilText(expiresAt)}, spend cap ${maxSpend}. Then run \`npm run status\`.`);
}

/** The agent's active permission, read from Proofable. Revoked or expired means refused, in every runtime. */
export async function current(agent, t = tool) {
  if (!agent.agentWallet || !agent.identity) throw new Error('Run `npm run setup` first.');
  const link = await t('proofable_agent_link', { agentWallet: agent.agentWallet, agentId: agent.agentId });
  const permission = link?.proofs?.delegation;
  if (link?.linked !== true || !QHASH.test(String(permission?.qHash || '')) || permission.isExpired) {
    throw new Refused('The agent has no active permission. Run `npm run permit` and sign the link.');
  }
  return permission;
}

/** Each action decided the way an MCP client that mounts the agent decides it, before it runs. */
export async function decisions(agent, permission, t = tool) {
  const mount = await t('proofable_agent_mount', { agentId: agent.agentId, agentWallet: agent.agentWallet });
  const bundle = isRuntimeBundle(mount) ? mount : mount?.data;
  return [...new Set([...permission.allowedActions, 'send_message', 'make_payment', 'manage_proofs'])].map((action) => {
    const d = evaluateRuntimeAction(bundle, action);
    return { action, allowed: d.allowed === true, code: d.allowed ? null : d.code };
  });
}

async function status() {
  const agent = readAgent();
  const permission = await current(agent);
  console.log(`${agent.label} (${agent.agentId})`);
  console.log(`  account     ${agent.agentWallet}`);
  console.log(`  identity    ${agent.identity}`);
  console.log(`  permission  ${permission.qHash}`);
  console.log(`  expires     ${permission.expiresAt ? new Date(Number(permission.expiresAt)).toISOString() : 'never'}`);
  console.log(`  spend cap   ${permission.maxSpend ?? 'none'}`);
  for (const d of await decisions(agent, permission)) {
    console.log(`  ${d.action.padEnd(14)} ${d.allowed ? 'allowed' : `refused (${d.code})`}`);
  }
}

// ── jobs ────────────────────────────────────────────────────────────────────────────────
async function latestCommit(repo) {
  const res = await fetchWithRetry(`https://api.github.com/repos/${repo}/commits/HEAD`, { headers: { accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(15_000) });
  const sha = (await res.json().catch(() => null))?.sha;
  if (!res.ok || !SHA.test(String(sha || ''))) throw new Error(`Could not read the latest commit of ${repo}. Use a public repository or pass --ref <commit>.`);
  return lower(sha);
}

async function envelope(qHash, t = tool) {
  if (!QHASH.test(String(qHash || ''))) return null;
  const got = await t('proofable_proofs_get', { qHash, include: 'content' });
  return (got?.data?.proofs || []).find((p) => lower(p.qHash) === lower(qHash))?.portableProof || null;
}

/** The task and where it runs: a public repository at one commit, an isolated computer, or neither. */
export async function jobSpec(task, flags = {}) {
  const prompt = String(task || '').trim();
  if (!prompt) throw new Error('Give the agent a task: npm run job -- "<task>" [--repo owner/name].');
  const repo = flags.repo ? String(flags.repo).replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/, '') : null;
  if (repo && !REPO.test(repo)) throw new Error('Name the repository as owner/name.');
  const ref = repo ? lower(flags.ref || (await latestCommit(repo))) : null;
  const runtime = repo ? { requiresComputer: true, repo: { slug: repo, ref } } : flags.computer ? { requiresComputer: true } : null;
  return { task: prompt, runtime };
}

/**
 * Start a job as the agent. Proofable checks it against the permission before anything runs and
 * signs the decision either way, so a refusal comes back with its own receipt.
 */
export async function dispatch(agent, spec, t = tool) {
  const [owner, permission, revision] = await Promise.all([ownerWallet(t), current(agent, t), serviceRevision()]);
  let created;
  try {
    created = await t('proofable_job_create', {
      agentId: agent.agentId,
      agentWallet: agent.agentWallet,
      delegationQHash: permission.qHash,
      prompt: spec.task,
      ...(spec.runtime ? { runtime: spec.runtime } : {}),
    });
  } catch (error) {
    if (!error.body) throw error;
    created = error.body;
  }
  const decisionQHash = created?.authorityDecision?.qHash || created?.authorityDecisionQHash || null;
  const jobId = created?.jobId || created?.job?.jobId;
  if (!jobId) {
    throw new Refused(`The job was refused: ${String(created?.message || created?.error || JSON.stringify(created)).slice(0, 400)}`, decisionQHash);
  }
  return { jobId, owner, permission, revision, decisionQHash, task: spec.task, runtime: spec.runtime };
}

/** Poll the job until it ends or `until` passes, then give its receipt a moment to land. */
export async function waitForJob(jobId, { until = Date.now() + 15 * 60_000, every = 5000 } = {}, t = tool) {
  let state = {};
  while (!TERMINAL.includes(lower(state.status)) && Date.now() < until) {
    await sleep(every);
    state = (await t('proofable_job_get', { jobId }))?.job || {};
  }
  for (let i = 0; TERMINAL.includes(lower(state.status)) && !QHASH.test(String(state.terminalQHash || '')) && i < 10 && Date.now() < until; i += 1) {
    await sleep(2000);
    state = (await t('proofable_job_get', { jobId }))?.job || state;
  }
  return state;
}

/** Write the run folder `verify` checks offline: the record, the answer, and their checksums. */
export async function recordRun(agent, run, state, t = tool) {
  const receipt = QHASH.test(String(state.terminalQHash || '')) ? state.terminalQHash : null;
  const runId = `job-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${String(run.jobId).slice(0, 8)}`;
  const dir = join(RUNS, runId);
  mkdirSync(dir, { recursive: true });
  const { permission } = run;
  const record = {
    schema: 'proofable-agent-run/v1',
    agentId: agent.agentId,
    agentWallet: agent.agentWallet,
    owner: run.owner,
    revision: run.revision,
    jobId: run.jobId,
    task: run.task,
    runtime: run.runtime || null,
    status: lower(state.status) || 'unknown',
    permission: { qHash: permission.qHash, allowedActions: permission.allowedActions, expiresAt: permission.expiresAt, maxSpend: permission.maxSpend ?? null },
    receipt: { qHash: receipt, envelope: await envelope(receipt, t) },
    decision: { qHash: run.decisionQHash, envelope: await envelope(run.decisionQHash, t) },
  };
  const response = String(statementOf(record.receipt.envelope)?.result?.response || state.result?.response || '').trim();
  writeJson(join(dir, 'run.json'), record);
  writeFileSync(join(dir, 'response.md'), `${response}\n`);
  const files = readdirSync(dir).sort();
  writeFileSync(join(dir, 'SHA256SUMS'), `${files.map((f) => `${sha256(readFileSync(join(dir, f)))}  ${f}`).join('\n')}\n`);
  writeFileSync(join(RUNS, 'LATEST'), `${runId}\n`);
  return { dir, response };
}

async function job(args, flags) {
  const agent = readAgent();
  const spec = await jobSpec(args[0], flags);
  const run = await dispatch(agent, spec);
  const repo = spec.runtime?.repo;
  console.log(`Job ${run.jobId}${repo ? ` on ${repo.slug}@${repo.ref.slice(0, 12)}` : ''}${spec.runtime ? ', on an isolated computer' : ''} …`);
  const { dir, response } = await recordRun(agent, run, await waitForJob(run.jobId));
  console.log(`\n${response}\n`);
  if (!(await verify([dir]))) process.exitCode = 1;
}

// ── offline check, from the run folder alone ────────────────────────────────────────────
export async function verify(args) {
  let dir = String(args[0] || 'latest');
  if (dir === 'latest') dir = join(RUNS, readFileSync(join(RUNS, 'LATEST'), 'utf8').trim());
  dir = resolve(dir);
  const failed = [];
  const check = (ok, what) => { console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed.push(what); };
  console.log(`Checking ${dir} offline`);

  for (const line of readFileSync(join(dir, 'SHA256SUMS'), 'utf8').split('\n').filter(Boolean)) {
    const [digest, name] = line.split(/\s+/);
    check(existsSync(join(dir, name)) && sha256(readFileSync(join(dir, name))) === digest, `checksum ${name}`);
  }
  const rec = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8'));

  const receipt = rec.receipt?.envelope;
  const s = statementOf(receipt) || {};
  check(Boolean(receipt) && (await verifyPortableProofEnvelope(receipt)).valid && lower(receipt.qHash) === lower(rec.receipt.qHash), 'receipt signature (CAIP-380)');
  check(lower(receipt?.data?.owner) === lower(rec.owner), 'receipt names the owner');
  check(s.kind === 'agent-job' && s.jobId === rec.jobId && s.agentId === rec.agentId && s.prompt === rec.task, 'receipt is this job, agent and task');
  if (rec.runtime?.repo) check(lower(s.runtime?.repo?.slug) === lower(rec.runtime.repo.slug) && lower(s.runtime?.repo?.ref) === lower(rec.runtime.repo.ref), 'receipt names the repository and commit');
  check(s.status === 'completed', 'job completed');

  const decision = rec.decision?.envelope;
  const d = statementOf(decision) || {};
  check(Boolean(decision) && (await verifyPortableProofEnvelope(decision)).valid && lower(decision.qHash) === lower(rec.decision.qHash), 'dispatch decision signature (CAIP-380)');
  check(d.outcome === 'ALLOW' && lower(d.delegationQHash) === lower(rec.permission.qHash) && d.agentId === rec.agentId, 'decision allowed this agent under this permission');

  console.log(failed.length ? `${failed.length} check(s) failed.` : 'All checks pass.');
  return failed.length === 0;
}

// ── listing: an AI service that runs as this agent ──────────────────────────────────────
async function listing(flags) {
  const agent = readAgent();
  const spec = agent.listing;
  const permission = await current(agent);
  const missing = ['execute_jobs', 'run_command'].filter((a) => !permission.allowedActions.includes(a));
  if (missing.length) throw new Error(`An order runs on an isolated computer, so the permission must allow ${missing.join(' and ')}.`);
  const now = new Date().toISOString();
  const gate = {
    schemaVersion: 2,
    ...(spec.id ? { gateId: spec.id } : {}),
    name: spec.name,
    artifact: {
      type: 'hidden_text',
      label: spec.name,
      value: JSON.stringify({
        schema: 'neus-service-reward-v1',
        prompt: spec.prompt,
        provider: null,
        model: null,
        parameters: [{ name: spec.input, label: 'GitHub repository (owner/name)', required: true }],
      }),
    },
    status: 'active',
    version: 1,
    requirements: [{ verifierId: 'ownership-basic', optional: false, minCount: 1, match: [{ path: 'content', op: 'eq', value: spec.pledge }] }],
    policy: { visibility: 'public', gateFreshnessHours: 0, allowlistAddresses: [] },
    monetization: { billing: { usage: { model: 'creatorCredits' } }, charge: null },
    analytics: { attribution: { templateId: 'ai-service' } },
    marketplaceTemplate: { templateId: 'ai-service', label: 'AI service', tags: ['ai-service:general', 'marketplace:listing', 'gate:listing'] },
    checkout: { mode: 'hosted', flowPlan: { batches: 1, hasInteractive: false, hasBackground: true }, description: spec.description },
    // Each order runs as this agent, under its permission, with the buyer's repository checked out.
    serviceRun: { agentId: agent.agentId, requiresComputer: true, repo: { fromParameter: spec.input } },
    createdAt: now,
    updatedAt: now,
  };
  const res = await fetchWithRetry(`${API_URL}/api/v1/profile/gates${spec.id ? `/${spec.id}` : ''}`, {
    method: spec.id ? 'PATCH' : 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${accessKey()}` },
    body: JSON.stringify({ gate, action: flags.publish ? 'publish' : 'save' }),
    signal: AbortSignal.timeout(60_000),
  });
  const body = await res.json().catch(() => null);
  const saved = body?.data?.gate;
  if (!res.ok || !saved) throw new Error(`The listing was not saved: ${JSON.stringify(body?.error || body).slice(0, 400)}`);
  writeJson(AGENT_FILE, { ...readAgent(), listing: { ...spec, id: saved.gateId } });
  console.log(`${flags.publish ? 'Published' : 'Saved a draft of'} "${saved.name}", running as ${saved.serviceRun?.agentId}.`);
  console.log(flags.publish ? `Share it: https://proofable.me/verify?gateId=${saved.gateId}` : 'Check it under Listings at https://proofable.me/profile?tab=portals, then run `npm run listing -- --publish`.');
}

// ── entry ───────────────────────────────────────────────────────────────────────────────
function parse(argv) {
  const args = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--repo' || a === '--ref') flags[a.slice(2)] = argv[++i];
    else if (a.startsWith('--')) flags[a.slice(2)] = true;
    else args.push(a);
  }
  return { args, flags };
}

const commands = {
  setup: ({ flags }) => setup(flags),
  permit: () => permit(),
  status: () => status(),
  job: ({ args, flags }) => job(args, flags),
  verify: async ({ args }) => { if (!(await verify(args))) process.exitCode = 1; },
  listing: ({ flags }) => listing(flags),
};
// Run as a command; imported as a module, it only exports.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [name, ...rest] = process.argv.slice(2);
  if (!commands[name]) {
    console.log('usage: node agent.mjs <setup | permit | status | job "<task>" [--repo owner/name] [--ref <commit>] [--computer] | verify [run] | listing [--publish]>');
    process.exitCode = name ? 1 : 0;
  } else {
    commands[name](parse(rest))
      .catch((error) => { console.error(`Stopped: ${error?.message || error}`); process.exitCode = 1; })
      .finally(close);
  }
}
