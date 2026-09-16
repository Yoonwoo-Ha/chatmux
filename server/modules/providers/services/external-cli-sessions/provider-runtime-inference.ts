import { homedir } from 'node:os';
import { join, relative, sep, isAbsolute } from 'node:path';
import { readFile, realpath, readdir } from 'node:fs/promises';

import { providerRegistry } from '@/modules/providers/provider.registry.js';
import { sessionsDb } from '@/modules/database/index.js';

import { parseProcStatStartTicks, processStartMs } from '../process-start-time.service.js';
import { tmuxPaneIdentityKey } from '../../../../../shared/tmux.js';
import { validateLocalAgentContext } from '../local-agent-context.service.js';

import { descendants, isClaudeRuntimeProcess, parseClaudeRuntimeSession } from './process-classification.js';
import { assignFreshIndexedProviderSessionIds, assignUniqueIndexedProviderSessionIds } from './session-correlation.js';
import { MAX_CLAUDE_PANE_RECEIPTS, MAX_CLAUDE_PARKED_RECEIPTS, MAX_RUNTIME_DESCRIPTORS, TRANSCRIPT_FILE_SESSION_ID_RE } from './contracts-and-resume.js';
import type { ClaudeRuntimeReceipt, ExternalCliSession, ExternalPane, ExternalSessionBinding, FreshIndexedProviderSession, ProcessTreeEntry } from './contracts-and-resume.js';

export type ClaudePaneReceiptCandidate = {
  pid: number;
  receipt: ClaudeRuntimeReceipt;
};

/** The pane identity a Claude receipt declares: `<session>:@<window>.%<pane>`. */
export function claudeReceiptPaneTag(pane: Pick<ExternalPane, 'name' | 'tmux'>): string {
  return `${pane.name}:${pane.tmux.windowId}.${pane.tmux.paneId}`;
}

/**
 * Picks the receipt of the Claude runtime that OWNS a pane. Counting processes
 * cannot decide this: a pane running background jobs holds a receipt for the
 * TUI, its daemon, and every background runtime, and only the TUI's receipt
 * names the pane. Ambiguity fails closed. Receipts from builds that write no
 * pane identity keep the previous rule — one runtime, one readable receipt —
 * so existing bindings do not change.
 */
export function selectClaudePaneReceipt(args: {
  paneTag: string;
  runtimePidCount: number;
  candidates: readonly ClaudePaneReceiptCandidate[];
}): ClaudePaneReceiptCandidate | null {
  const claimed = args.candidates.filter((candidate) => candidate.receipt.tmux === args.paneTag);
  if (claimed.length > 0) {
    const interactive = claimed.filter((candidate) => candidate.receipt.kind === 'interactive');
    const owners = interactive.length > 0 ? interactive : claimed;
    return owners.length === 1 ? owners[0] : null;
  }
  // A receipt that names a DIFFERENT pane is evidence of a mismatch, never a
  // fallback: only a receipt with no pane identity at all can take this path.
  const [only] = args.candidates;
  return args.runtimePidCount === 1 && args.candidates.length === 1 && only.receipt.tmux === null
    ? only
    : null;
}

/** Picks the background runtime that a parked pane receipt handed its conversation to. */
export function selectParkedClaudeReceipt(
  candidates: readonly ClaudePaneReceiptCandidate[],
  parkedJobId: string,
): ClaudePaneReceiptCandidate | null {
  const owners = candidates.filter((candidate) => (
    candidate.receipt.kind === 'bg' && candidate.receipt.jobId === parkedJobId
  ));
  return owners.length === 1 ? owners[0] : null;
}

function claudeReceiptDirectory(): string {
  return join(homedir(), '.claude', 'sessions');
}

async function readClaudeRuntimeReceipt(pid: number): Promise<ClaudePaneReceiptCandidate | null> {
  try {
    const receipt = parseClaudeRuntimeSession(
      JSON.parse(await readFile(join(claudeReceiptDirectory(), `${pid}.json`), 'utf8')),
      pid,
    );
    return receipt ? { pid, receipt } : null;
  } catch {
    // The Claude runtime receipt is best-effort and may disappear on exit.
    return null;
  }
}

/**
 * True when the pid still runs the exact process the receipt was written for.
 * The receipt carries the immutable /proc start tick of its own pid, so a
 * reused pid cannot inherit a stale binding. Platforms without /proc keep the
 * previous behavior, which had no generation to check.
 */
async function isCurrentClaudeGeneration(candidate: ClaudePaneReceiptCandidate): Promise<boolean> {
  if (candidate.receipt.procStart === null || process.platform !== 'linux') return true;
  const stat = await readFile(`/proc/${candidate.pid}/stat`, 'utf8').catch(() => null);
  if (stat === null) return false;
  const ticks = parseProcStatStartTicks(stat);
  return ticks !== null && String(ticks) === candidate.receipt.procStart;
}

/**
 * A Claude TUI can park its conversation into a background runtime and keep its
 * own, now inactive, session id in the pane receipt. The parked receipt names
 * the job it handed off, and the background runtime's receipt carries the same
 * job id, so the conversation the pane actually displays is reached through
 * that declared chain. The working directory only has to agree; it never
 * authorizes the link on its own.
 */
async function resolveParkedClaudeReceipt(
  parkedJobId: string,
  realPaneCwd: string,
): Promise<ClaudePaneReceiptCandidate | null> {
  const entries = await readdir(claudeReceiptDirectory()).catch(() => []);
  const pids = entries
    .map((entry) => /^(\d{1,10})\.json$/.exec(entry)?.[1])
    .filter((pid): pid is string => pid !== undefined)
    .slice(0, MAX_CLAUDE_PARKED_RECEIPTS)
    .map(Number);
  const receipts = (await Promise.all(pids.map(readClaudeRuntimeReceipt)))
    .filter((candidate): candidate is ClaudePaneReceiptCandidate => candidate !== null);

  const owner = selectParkedClaudeReceipt(receipts, parkedJobId);
  if (!owner || !(await isCurrentClaudeGeneration(owner))) return null;
  const realReceiptCwd = await realpath(owner.receipt.cwd).catch(() => null);
  return realReceiptCwd === realPaneCwd ? owner : null;
}

export async function inferClaudeSessionIds(args: {
  sessions: ExternalCliSession[];
  panes: ExternalPane[];
  procs: ProcessTreeEntry[];
}): Promise<Map<string, string>> {
  const claudeTargets = new Set(
    args.sessions
      .filter((session) => session.kind === 'claude')
      .map((session) => tmuxPaneIdentityKey(session.tmux)),
  );
  if (claudeTargets.size === 0) return new Map();

  const children = new Map<number, number[]>();
  const procByPid = new Map(args.procs.map((proc) => [proc.pid, proc]));
  for (const proc of args.procs) {
    const siblings = children.get(proc.ppid) ?? [];
    siblings.push(proc.pid);
    children.set(proc.ppid, siblings);
  }

  const candidates = new Map<string, { paneTag: string; cwd: string; pids: number[] }>();
  for (const pane of args.panes) {
    const targetKey = tmuxPaneIdentityKey(pane.tmux);
    if (!claudeTargets.has(targetKey) || !pane.cwd) continue;
    const pids = descendants(pane.pid, children).filter((pid) => {
      const proc = procByPid.get(pid);
      return proc ? isClaudeRuntimeProcess(proc) : false;
    });
    if (pids.length > 0) {
      candidates.set(targetKey, { paneTag: claudeReceiptPaneTag(pane), cwd: pane.cwd, pids });
    }
  }

  const resolved = new Map<string, string>();
  await Promise.all([...candidates].map(async ([targetKey, pane]) => {
    const receipts = (await Promise.all(
      pane.pids.slice(0, MAX_CLAUDE_PANE_RECEIPTS).map(readClaudeRuntimeReceipt),
    )).filter((candidate): candidate is ClaudePaneReceiptCandidate => candidate !== null);

    const owner = selectClaudePaneReceipt({
      paneTag: pane.paneTag,
      runtimePidCount: pane.pids.length,
      candidates: receipts,
    });
    if (!owner || !(await isCurrentClaudeGeneration(owner))) return;

    const [realPaneCwd, realReceiptCwd] = await Promise.all([
      realpath(pane.cwd).catch(() => null),
      realpath(owner.receipt.cwd).catch(() => null),
    ]);
    if (realPaneCwd === null || realPaneCwd !== realReceiptCwd) return;

    const parked = owner.receipt.parkedJobId
      ? await resolveParkedClaudeReceipt(owner.receipt.parkedJobId, realPaneCwd)
      : null;
    resolved.set(targetKey, (parked ?? owner).receipt.sessionId);
  }));
  return resolved;
}

export function extractContainedTranscriptSessionId(
  sessionsRoot: string,
  transcriptPath: string,
): string | null {
  const rel = relative(sessionsRoot, transcriptPath);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  return TRANSCRIPT_FILE_SESSION_ID_RE.exec(rel)?.[1] ?? null;
}

/**
 * Oh My Pi keeps its active JSONL transcript open for the lifetime of the TUI.
 * Resolve that file through /proc so an already-running, untagged tmux pane can
 * attach to structured history without relying on filesystem creation times.
 */
export const PI_TRANSCRIPT_HOME_DIRS = {
  omp: '.omp',
  omo: '.omo',
} as const;

export async function inferOpenPiSessionIds(
  sessions: ExternalCliSession[],
): Promise<Map<string, string>> {
  const resolved = new Map<string, string>();
  const kinds = Object.keys(PI_TRANSCRIPT_HOME_DIRS) as Array<keyof typeof PI_TRANSCRIPT_HOME_DIRS>;
  await Promise.all(kinds.map(async (kind) => {
    const targets = sessions.filter((session) => (
      session.kind === kind
      && session.agentPid !== undefined
    ));
    if (targets.length === 0) return;

    const sessionsRoot = await realpath(
      join(homedir(), PI_TRANSCRIPT_HOME_DIRS[kind], 'agent', 'sessions'),
    ).catch(() => null);
    if (!sessionsRoot) return;

    await Promise.all(targets.map(async (session) => {
      const fdRoot = `/proc/${session.agentPid}/fd`;
      const descriptors = await readdir(fdRoot).catch(() => []);
      const transcriptById = new Map<string, string>();
      await Promise.all(descriptors.slice(0, MAX_RUNTIME_DESCRIPTORS).map(async (descriptor) => {
        const transcriptPath = await realpath(join(fdRoot, descriptor)).catch(() => null);
        if (!transcriptPath) return;
        const sessionId = extractContainedTranscriptSessionId(sessionsRoot, transcriptPath);
        if (sessionId) transcriptById.set(sessionId, transcriptPath);
      }));
      if (transcriptById.size !== 1) return;

      const [[sessionId, transcriptPath]] = [...transcriptById];
      if (!sessionsDb.getSessionByProviderSessionId(kind, sessionId)) {
        await providerRegistry.resolveProvider(kind).sessionSynchronizer
          .synchronizeFile(transcriptPath)
          .catch(() => undefined);
      }
      resolved.set(tmuxPaneIdentityKey(session.tmux), sessionId);
    }));
  }));
  return resolved;
}

export async function addExternalRuntimeMetadata(args: {
  sessions: ExternalCliSession[];
  panes: ExternalPane[];
  procs: ProcessTreeEntry[];
}): Promise<ExternalCliSession[]> {
  return Promise.all(args.sessions.map(async (session) => {
    if (session.kind === 'ssh' || session.agentPid === undefined) return session;
    const startedAtMs = await processStartMs(session.agentPid);
    const connectionIssue = await validateLocalAgentContext({
      pid: session.agentPid,
      startedAtMs,
      socketPath: session.tmux.socketPath,
    });
    if (connectionIssue) {
      const { providerSessionId: _providerSessionId, binding: _binding, ...unbound } = session;
      return {
        ...unbound,
        ...(startedAtMs === null ? {} : { startedAtMs }),
        connectionIssue,
      };
    }
    return startedAtMs === null ? session : { ...session, startedAtMs };
  }));
}

export async function inferIndexedProviderSessionIds(
  sessions: ExternalCliSession[],
  attemptableTargetKeys: ReadonlySet<string>,
): Promise<Map<string, string>> {
  const unresolved = sessions.filter((session): session is ExternalCliSession & {
    kind: 'cursor' | 'opencode' | 'omp' | 'omo';
    cwd: string;
    startedAtMs: number;
  } => (
    (session.kind === 'cursor' || session.kind === 'opencode' || session.kind === 'omp' || session.kind === 'omo')
    && !session.providerSessionId
    && typeof session.cwd === 'string'
    && typeof session.startedAtMs === 'number'
  ));
  if (unresolved.length === 0) return new Map();

  const providers = [...new Set(
    unresolved
      .filter((session) => attemptableTargetKeys.has(tmuxPaneIdentityKey(session.tmux)))
      .map((session) => session.kind),
  )];
  await Promise.all(providers.map(async (provider) => {
    const starts = unresolved
      .filter((session) => session.kind === provider)
      .map((session) => session.startedAtMs);
    const since = new Date(Math.min(...starts) - 30_000);
    await providerRegistry.resolveProvider(provider).sessionSynchronizer.synchronize(since);
  })).catch(() => undefined);

  const candidates: FreshIndexedProviderSession[] = [];
  const seen = new Set<string>();
  for (const session of unresolved) {
    for (const row of sessionsDb.getSessionsByProjectPath(session.cwd)) {
      const providerSessionId = row.provider_session_id;
      if (
        row.provider !== session.kind
        || !providerSessionId
        || row.session_id !== providerSessionId
      ) {
        continue;
      }
      const key = `${session.kind}:${providerSessionId}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      candidates.push({
        id: providerSessionId,
        kind: session.kind,
        cwd: session.cwd,
        createdAtMs: new Date(row.created_at).getTime(),
        updatedAtMs: new Date(row.updated_at).getTime(),
        diskDiscovered: true,
      });
    }
  }
  const fresh = assignFreshIndexedProviderSessionIds(unresolved, candidates);
  return new Map(
    [...assignUniqueIndexedProviderSessionIds(unresolved, candidates, fresh, Date.now(), sessions)]
      .filter(([targetKey]) => attemptableTargetKeys.has(targetKey)),
  );
}

export function applyInferredProviderSessionIds(
  sessions: ExternalCliSession[],
  inferredIds: ReadonlyMap<string, string>,
  authoritativeTargetKeys: ReadonlySet<string> = new Set(),
  displayOverrideTargetKeys: ReadonlySet<string> = new Set(),
): ExternalCliSession[] {
  return sessions.map((session) => {
    if (session.connectionIssue || session.kind === 'shell' || session.kind === 'ssh') {
      const { providerSessionId: _providerSessionId, binding: _binding, ...unbound } = session;
      return unbound;
    }
    const targetKey = tmuxPaneIdentityKey(session.tmux);
    const providerSessionId = inferredIds.get(targetKey);
    // Authoritative keys are the process-scoped sources (runtime receipt,
    // open transcript, open rollout); everything else in `inferredIds` came
    // from a cwd or time-window guess and is graded accordingly.
    const binding: ExternalSessionBinding = authoritativeTargetKeys.has(targetKey) ? 'observed' : 'inferred';
    return providerSessionId
      && (!session.providerSessionId || authoritativeTargetKeys.has(targetKey) || displayOverrideTargetKeys.has(targetKey))
      ? { ...session, providerSessionId, binding }
      : session;
  });
}

export type ExternalProviderSessionInference = {
  ids: Map<string, string>;
  authoritativeTargetKeys: Set<string>;
  displayOverrideTargetKeys?: Set<string>;
};
