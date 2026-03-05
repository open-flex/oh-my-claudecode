/**
 * Event-driven team runtime v2 — replaces the polling watchdog from runtime.ts.
 *
 * Feature-flagged via OMC_RUNTIME_V2=1 environment variable.
 * NO done.json polling. Completion is detected via:
 * - CLI API lifecycle transitions (claim-task, transition-task-status)
 * - Event-driven monitor snapshots
 * - Worker heartbeat/status files
 *
 * Preserves: sentinel gate, circuit breaker, failure sidecars.
 * Removes: done.json watchdog loop, sleep-based polling.
 *
 * Architecture matches OMX runtime.ts: startTeam, monitorTeam, shutdownTeam,
 * assignTask, resumeTeam as discrete operations driven by the caller.
 */

import { join, resolve } from 'path';
import { existsSync } from 'fs';
import { mkdir, rm, readdir } from 'fs/promises';
import { performance } from 'perf_hooks';
import { TeamPaths, absPath, teamStateRoot } from './state-paths.js';
import {
  readTeamConfig,
  readTeamManifest,
  readWorkerStatus,
  readWorkerHeartbeat,
  readMonitorSnapshot,
  writeMonitorSnapshot,
  readTeamPhaseState,
  writeTeamPhaseState,
  writeShutdownRequest,
  readShutdownAck,
  writeWorkerIdentity,
  writeWorkerInbox,
  listTasksFromFiles,
  saveTeamConfig,
  cleanupTeamState,
} from './monitor.js';
import { appendTeamEvent, emitMonitorDerivedEvents } from './events.js';
import { inferPhase } from './phase-controller.js';
import type {
  TeamConfig,
  TeamManifestV2,
  TeamPolicy,
  TeamTask,
  TeamMonitorSnapshotState,
  TeamPhaseState,
  WorkerInfo,
  WorkerStatus,
  WorkerHeartbeat,
  ShutdownAck,
} from './types.js';
import type { TeamPhase } from './phase-controller.js';

// ---------------------------------------------------------------------------
// Feature flag
// ---------------------------------------------------------------------------

export function isRuntimeV2Enabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.OMC_RUNTIME_V2;
  if (!raw) return false;
  return ['1', 'true', 'yes'].includes(raw.trim().toLowerCase());
}

// ---------------------------------------------------------------------------
// Runtime state (returned by startTeam, consumed by monitorTeam/shutdownTeam)
// ---------------------------------------------------------------------------

export interface TeamRuntimeV2 {
  teamName: string;
  sanitizedName: string;
  sessionName: string;
  config: TeamConfig;
  cwd: string;
}

// ---------------------------------------------------------------------------
// Monitor snapshot result
// ---------------------------------------------------------------------------

export interface TeamSnapshotV2 {
  teamName: string;
  phase: TeamPhase;
  workers: Array<{
    name: string;
    alive: boolean;
    status: WorkerStatus;
    heartbeat: WorkerHeartbeat | null;
    assignedTasks: string[];
    turnsWithoutProgress: number;
  }>;
  tasks: {
    total: number;
    pending: number;
    blocked: number;
    in_progress: number;
    completed: number;
    failed: number;
    items: TeamTask[];
  };
  allTasksTerminal: boolean;
  deadWorkers: string[];
  nonReportingWorkers: string[];
  recommendations: string[];
  performance: {
    list_tasks_ms: number;
    worker_scan_ms: number;
    total_ms: number;
    updated_at: string;
  };
}

// ---------------------------------------------------------------------------
// Shutdown options
// ---------------------------------------------------------------------------

export interface ShutdownOptionsV2 {
  force?: boolean;
  ralph?: boolean;
  timeoutMs?: number;
}

interface ShutdownGateCounts {
  total: number;
  pending: number;
  blocked: number;
  in_progress: number;
  completed: number;
  failed: number;
  allowed: boolean;
}

// ---------------------------------------------------------------------------
// Helper: sanitize team name
// ---------------------------------------------------------------------------

function sanitizeTeamName(name: string): string {
  return name.replace(/[^a-z0-9-]/g, '').slice(0, 30);
}

// ---------------------------------------------------------------------------
// Helper: check worker liveness via tmux pane
// ---------------------------------------------------------------------------

async function isWorkerPaneAlive(paneId: string | undefined): Promise<boolean> {
  if (!paneId) return false;
  try {
    const { isWorkerAlive } = await import('./tmux-session.js');
    return await isWorkerAlive(paneId);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// StartTeam V2 — create state, spawn workers, write initial dispatch requests
// ---------------------------------------------------------------------------

export interface StartTeamV2Config {
  teamName: string;
  workerCount: number;
  agentTypes: string[];
  tasks: Array<{ subject: string; description: string; owner?: string; blocked_by?: string[] }>;
  cwd: string;
}

/**
 * Start a team with the v2 event-driven runtime.
 * Creates state directory, writes config, spawns workers via tmux, and
 * writes initial inbox instructions via dispatch queue. NO done.json.
 */
export async function startTeamV2(config: StartTeamV2Config): Promise<TeamRuntimeV2> {
  const sanitized = sanitizeTeamName(config.teamName);
  const leaderCwd = resolve(config.cwd);
  const root = absPath(leaderCwd, TeamPaths.root(sanitized));

  // Ensure state directories
  await mkdir(absPath(leaderCwd, TeamPaths.tasks(sanitized)), { recursive: true });
  await mkdir(absPath(leaderCwd, TeamPaths.workers(sanitized)), { recursive: true });

  // Delegate to existing startTeam for the actual tmux/pane creation
  // which handles worker spawning, overlay writing, etc.
  // The v2 runtime wraps it with event-driven monitoring instead of watchdog.
  const { startTeam } = await import('./runtime.js');
  const v1Runtime = await startTeam({
    teamName: config.teamName,
    workerCount: config.workerCount,
    agentTypes: config.agentTypes as any,
    tasks: config.tasks,
    cwd: config.cwd,
  });

  // Write initial event
  await appendTeamEvent(sanitized, {
    type: 'team_leader_nudge',
    worker: 'leader-fixed',
    reason: `start_team_v2: workers=${config.workerCount} tasks=${config.tasks.length}`,
  }, leaderCwd);

  const sessionName = v1Runtime.sessionName || `omc-team-${sanitized}`;

  return {
    teamName: sanitized,
    sanitizedName: sanitized,
    sessionName,
    config: {
      name: sanitized,
      task: config.tasks.map(t => t.subject).join('; '),
      agent_type: config.agentTypes[0] || 'claude',
      worker_launch_mode: 'interactive',
      worker_count: config.workerCount,
      max_workers: 20,
      workers: v1Runtime.workerPaneIds?.map((paneId, i) => ({
        name: `worker-${i + 1}`,
        index: i + 1,
        role: config.agentTypes[i] || config.agentTypes[0] || 'claude',
        assigned_tasks: [],
        pane_id: paneId,
        working_dir: leaderCwd,
      })) || [],
      created_at: new Date().toISOString(),
      tmux_session: sessionName,
      next_task_id: config.tasks.length + 1,
      leader_cwd: leaderCwd,
      team_state_root: teamStateRoot(leaderCwd, sanitized),
      leader_pane_id: v1Runtime.leaderPaneId || null,
      hud_pane_id: null,
      resize_hook_name: null,
      resize_hook_target: null,
    },
    cwd: leaderCwd,
  };
}

// ---------------------------------------------------------------------------
// Circuit breaker — 3 consecutive failures -> write watchdog-failed.json
// ---------------------------------------------------------------------------

const CIRCUIT_BREAKER_THRESHOLD = 3;

export async function writeWatchdogFailedMarker(
  teamName: string,
  cwd: string,
  reason: string,
): Promise<void> {
  const { writeFile } = await import('fs/promises');
  const marker = {
    failedAt: Date.now(),
    reason,
    writtenBy: 'runtime-v2',
  };
  const root = absPath(cwd, TeamPaths.root(sanitizeTeamName(teamName)));
  const markerPath = join(root, 'watchdog-failed.json');
  await mkdir(root, { recursive: true });
  await writeFile(markerPath, JSON.stringify(marker, null, 2), 'utf-8');
}

/**
 * Circuit breaker context for tracking consecutive monitor failures.
 * The caller (runtime-cli v2 loop) should call recordSuccess on each
 * successful monitor cycle and recordFailure on each error. When the
 * threshold is reached, the breaker trips and writes watchdog-failed.json.
 */
export class CircuitBreakerV2 {
  private consecutiveFailures = 0;
  private tripped = false;

  constructor(
    private readonly teamName: string,
    private readonly cwd: string,
    private readonly threshold: number = CIRCUIT_BREAKER_THRESHOLD,
  ) {}

  recordSuccess(): void {
    this.consecutiveFailures = 0;
  }

  async recordFailure(reason: string): Promise<boolean> {
    this.consecutiveFailures++;
    if (this.consecutiveFailures >= this.threshold && !this.tripped) {
      this.tripped = true;
      await writeWatchdogFailedMarker(this.teamName, this.cwd, reason);
      return true; // breaker tripped
    }
    return false;
  }

  isTripped(): boolean {
    return this.tripped;
  }
}

// ---------------------------------------------------------------------------
// Failure sidecars — requeue tasks from dead workers
// ---------------------------------------------------------------------------

/**
 * Requeue tasks from dead workers by writing failure sidecars and resetting
 * task status back to pending so they can be claimed by other workers.
 */
export async function requeueDeadWorkerTasks(
  teamName: string,
  deadWorkerNames: string[],
  cwd: string,
): Promise<string[]> {
  const sanitized = sanitizeTeamName(teamName);
  const tasks = await listTasksFromFiles(sanitized, cwd);
  const requeued: string[] = [];

  const deadSet = new Set(deadWorkerNames);

  for (const task of tasks) {
    if (task.status !== 'in_progress') continue;
    if (!task.owner || !deadSet.has(task.owner)) continue;

    // Write failure sidecar
    const sidecarPath = absPath(cwd, `${TeamPaths.tasks(sanitized)}/${task.id}.failure.json`);
    const sidecar = {
      taskId: task.id,
      lastError: `worker_dead:${task.owner}`,
      retryCount: 0,
      lastFailedAt: new Date().toISOString(),
    };
    const { writeFile } = await import('fs/promises');
    await mkdir(absPath(cwd, TeamPaths.tasks(sanitized)), { recursive: true });
    await writeFile(sidecarPath, JSON.stringify(sidecar, null, 2), 'utf-8');

    // Reset task to pending (clear owner and claim)
    const taskPath = absPath(cwd, TeamPaths.taskFile(sanitized, task.id));
    try {
      const raw = await import('fs/promises').then(fs => fs.readFile(taskPath, 'utf-8'));
      const taskData = JSON.parse(raw);
      taskData.status = 'pending';
      taskData.owner = undefined;
      taskData.claim = undefined;
      await writeFile(taskPath, JSON.stringify(taskData, null, 2), 'utf-8');
      requeued.push(task.id);
    } catch {
      // Task file may have been removed; skip
    }

    await appendTeamEvent(sanitized, {
      type: 'team_leader_nudge',
      worker: 'leader-fixed',
      task_id: task.id,
      reason: `requeue_dead_worker:${task.owner}`,
    }, cwd).catch(() => {});
  }

  return requeued;
}

// ---------------------------------------------------------------------------
// monitorTeam — snapshot-based, event-driven (no watchdog)
// ---------------------------------------------------------------------------

/**
 * Take a single monitor snapshot of team state.
 * Caller drives the loop (e.g., runtime-cli poll interval or event trigger).
 */
export async function monitorTeamV2(
  teamName: string,
  cwd: string,
): Promise<TeamSnapshotV2 | null> {
  const monitorStartMs = performance.now();
  const sanitized = sanitizeTeamName(teamName);
  const config = await readTeamConfig(sanitized, cwd);
  if (!config) return null;

  const previousSnapshot = await readMonitorSnapshot(sanitized, cwd);

  // Load all tasks
  const listTasksStartMs = performance.now();
  const allTasks = await listTasksFromFiles(sanitized, cwd);
  const listTasksMs = performance.now() - listTasksStartMs;

  const taskById = new Map(allTasks.map((task) => [task.id, task] as const));
  const inProgressByOwner = new Map<string, TeamTask[]>();
  for (const task of allTasks) {
    if (task.status !== 'in_progress' || !task.owner) continue;
    const existing = inProgressByOwner.get(task.owner) || [];
    existing.push(task);
    inProgressByOwner.set(task.owner, existing);
  }

  // Scan workers
  const workers: TeamSnapshotV2['workers'] = [];
  const deadWorkers: string[] = [];
  const nonReportingWorkers: string[] = [];
  const recommendations: string[] = [];

  const workerScanStartMs = performance.now();
  const workerSignals = await Promise.all(
    config.workers.map(async (worker) => {
      const alive = await isWorkerPaneAlive(worker.pane_id);
      const [status, heartbeat] = await Promise.all([
        readWorkerStatus(sanitized, worker.name, cwd),
        readWorkerHeartbeat(sanitized, worker.name, cwd),
      ]);
      return { worker, alive, status, heartbeat };
    }),
  );
  const workerScanMs = performance.now() - workerScanStartMs;

  for (const { worker: w, alive, status, heartbeat } of workerSignals) {
    const currentTask = status.current_task_id ? taskById.get(status.current_task_id) ?? null : null;
    const previousTurns = previousSnapshot ? (previousSnapshot.workerTurnCountByName[w.name] ?? 0) : null;
    const previousTaskId = previousSnapshot?.workerTaskIdByName[w.name] ?? '';
    const currentTaskId = status.current_task_id ?? '';
    const turnsWithoutProgress =
      heartbeat &&
      previousTurns !== null &&
      status.state === 'working' &&
      currentTask &&
      (currentTask.status === 'pending' || currentTask.status === 'in_progress') &&
      currentTaskId !== '' &&
      previousTaskId === currentTaskId
        ? Math.max(0, heartbeat.turn_count - previousTurns)
        : 0;

    workers.push({
      name: w.name,
      alive,
      status,
      heartbeat,
      assignedTasks: w.assigned_tasks,
      turnsWithoutProgress,
    });

    if (!alive) {
      deadWorkers.push(w.name);
      const deadWorkerTasks = inProgressByOwner.get(w.name) || [];
      for (const t of deadWorkerTasks) {
        recommendations.push(`Reassign task-${t.id} from dead ${w.name}`);
      }
    }

    if (alive && turnsWithoutProgress > 5) {
      nonReportingWorkers.push(w.name);
      recommendations.push(`Send reminder to non-reporting ${w.name}`);
    }
  }

  // Count tasks
  const taskCounts = {
    total: allTasks.length,
    pending: allTasks.filter((t) => t.status === 'pending').length,
    blocked: allTasks.filter((t) => t.status === 'blocked').length,
    in_progress: allTasks.filter((t) => t.status === 'in_progress').length,
    completed: allTasks.filter((t) => t.status === 'completed').length,
    failed: allTasks.filter((t) => t.status === 'failed').length,
  };

  const allTasksTerminal = taskCounts.pending === 0 && taskCounts.blocked === 0 && taskCounts.in_progress === 0;

  // Infer phase from task distribution
  const phase = inferPhase(allTasks.map((t) => ({
    status: t.status,
    metadata: undefined,
  })));

  // Emit monitor-derived events (task completions, worker state changes)
  await emitMonitorDerivedEvents(
    sanitized,
    allTasks,
    workers.map((w) => ({ name: w.name, alive: w.alive, status: w.status })),
    previousSnapshot,
    cwd,
  );

  // Persist snapshot for next cycle
  const updatedAt = new Date().toISOString();
  const totalMs = performance.now() - monitorStartMs;
  await writeMonitorSnapshot(sanitized, {
    taskStatusById: Object.fromEntries(allTasks.map((t) => [t.id, t.status])),
    workerAliveByName: Object.fromEntries(workers.map((w) => [w.name, w.alive])),
    workerStateByName: Object.fromEntries(workers.map((w) => [w.name, w.status.state])),
    workerTurnCountByName: Object.fromEntries(workers.map((w) => [w.name, w.heartbeat?.turn_count ?? 0])),
    workerTaskIdByName: Object.fromEntries(workers.map((w) => [w.name, w.status.current_task_id ?? ''])),
    mailboxNotifiedByMessageId: previousSnapshot?.mailboxNotifiedByMessageId ?? {},
    completedEventTaskIds: previousSnapshot?.completedEventTaskIds ?? {},
    monitorTimings: {
      list_tasks_ms: Number(listTasksMs.toFixed(2)),
      worker_scan_ms: Number(workerScanMs.toFixed(2)),
      mailbox_delivery_ms: 0,
      total_ms: Number(totalMs.toFixed(2)),
      updated_at: updatedAt,
    },
  }, cwd);

  return {
    teamName: sanitized,
    phase,
    workers,
    tasks: {
      ...taskCounts,
      items: allTasks,
    },
    allTasksTerminal,
    deadWorkers,
    nonReportingWorkers,
    recommendations,
    performance: {
      list_tasks_ms: Number(listTasksMs.toFixed(2)),
      worker_scan_ms: Number(workerScanMs.toFixed(2)),
      total_ms: Number(totalMs.toFixed(2)),
      updated_at: updatedAt,
    },
  };
}

// ---------------------------------------------------------------------------
// shutdownTeam — graceful shutdown with gate, ack, force kill
// ---------------------------------------------------------------------------

/**
 * Graceful team shutdown matching OMX semantics:
 * 1. Shutdown gate check (unless force)
 * 2. Send shutdown request to all workers via inbox
 * 3. Wait for ack or timeout
 * 4. Force kill remaining tmux panes
 * 5. Clean up state
 */
export async function shutdownTeamV2(
  teamName: string,
  cwd: string,
  options: ShutdownOptionsV2 = {},
): Promise<void> {
  const force = options.force === true;
  const ralph = options.ralph === true;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const sanitized = sanitizeTeamName(teamName);
  const config = await readTeamConfig(sanitized, cwd);

  if (!config) {
    // No config — try to kill tmux session and clean up
    try {
      const { killTeamSession } = await import('./tmux-session.js');
      await killTeamSession(`omc-team-${sanitized}`, [], undefined);
    } catch {}
    await cleanupTeamState(sanitized, cwd);
    return;
  }

  // 1. Shutdown gate check
  if (!force) {
    const allTasks = await listTasksFromFiles(sanitized, cwd);
    const gate: ShutdownGateCounts = {
      total: allTasks.length,
      pending: allTasks.filter((t) => t.status === 'pending').length,
      blocked: allTasks.filter((t) => t.status === 'blocked').length,
      in_progress: allTasks.filter((t) => t.status === 'in_progress').length,
      completed: allTasks.filter((t) => t.status === 'completed').length,
      failed: allTasks.filter((t) => t.status === 'failed').length,
      allowed: false,
    };
    gate.allowed = gate.pending === 0 && gate.blocked === 0 && gate.in_progress === 0 && gate.failed === 0;

    await appendTeamEvent(sanitized, {
      type: 'shutdown_gate',
      worker: 'leader-fixed',
      reason: `allowed=${gate.allowed} total=${gate.total} pending=${gate.pending} blocked=${gate.blocked} in_progress=${gate.in_progress} completed=${gate.completed} failed=${gate.failed}${ralph ? ' policy=ralph' : ''}`,
    }, cwd).catch(() => {});

    if (!gate.allowed) {
      const hasActiveWork = gate.pending > 0 || gate.blocked > 0 || gate.in_progress > 0;
      if (ralph && !hasActiveWork) {
        // Ralph policy: bypass on failure-only scenarios
        await appendTeamEvent(sanitized, {
          type: 'team_leader_nudge',
          worker: 'leader-fixed',
          reason: `gate_bypassed:pending=${gate.pending},blocked=${gate.blocked},in_progress=${gate.in_progress},failed=${gate.failed}`,
        }, cwd).catch(() => {});
      } else {
        throw new Error(
          `shutdown_gate_blocked:pending=${gate.pending},blocked=${gate.blocked},in_progress=${gate.in_progress},failed=${gate.failed}`,
        );
      }
    }
  }

  if (force) {
    await appendTeamEvent(sanitized, {
      type: 'shutdown_gate_forced',
      worker: 'leader-fixed',
      reason: 'force_bypass',
    }, cwd).catch(() => {});
  }

  // 2. Send shutdown request to each worker
  const shutdownRequestTimes = new Map<string, string>();
  for (const w of config.workers) {
    try {
      const requestedAt = new Date().toISOString();
      await writeShutdownRequest(sanitized, w.name, 'leader-fixed', cwd);
      shutdownRequestTimes.set(w.name, requestedAt);
      // Write shutdown inbox
      const shutdownInbox = `# Shutdown Request\n\nAll tasks are complete. Please wrap up and respond with a shutdown acknowledgement.\n\nWrite your ack to: ${TeamPaths.shutdownAck(sanitized, w.name)}\nFormat: {"status":"accept","reason":"ok","updated_at":"<iso>"}\n\nThen exit your session.\n`;
      await writeWorkerInbox(sanitized, w.name, shutdownInbox, cwd);
    } catch (err) {
      process.stderr.write(`[team/runtime-v2] shutdown request failed for ${w.name}: ${err}\n`);
    }
  }

  // 3. Wait for ack or timeout
  const deadline = Date.now() + timeoutMs;
  const rejected: Array<{ worker: string; reason: string }> = [];
  const ackedWorkers = new Set<string>();

  while (Date.now() < deadline) {
    for (const w of config.workers) {
      if (ackedWorkers.has(w.name)) continue;
      const ack = await readShutdownAck(sanitized, w.name, cwd, shutdownRequestTimes.get(w.name));
      if (ack) {
        ackedWorkers.add(w.name);
        await appendTeamEvent(sanitized, {
          type: 'shutdown_ack',
          worker: w.name,
          reason: ack.status === 'reject' ? `reject:${ack.reason || 'no_reason'}` : 'accept',
        }, cwd).catch(() => {});
        if (ack.status === 'reject') {
          rejected.push({ worker: w.name, reason: ack.reason || 'no_reason' });
        }
      }
    }

    if (rejected.length > 0 && !force) {
      const detail = rejected.map((r) => `${r.worker}:${r.reason}`).join(',');
      throw new Error(`shutdown_rejected:${detail}`);
    }

    // Check if all workers have acked or exited
    const allDone = config.workers.every((w) => ackedWorkers.has(w.name));
    if (allDone) break;

    await new Promise((r) => setTimeout(r, 2_000));
  }

  // 4. Force kill remaining tmux panes
  try {
    const { killWorkerPanes, killTeamSession } = await import('./tmux-session.js');
    const workerPaneIds = config.workers
      .map((w) => w.pane_id)
      .filter((p): p is string => typeof p === 'string' && p.trim().length > 0);
    await killWorkerPanes({
      paneIds: workerPaneIds,
      leaderPaneId: config.leader_pane_id ?? undefined,
      teamName: sanitized,
      cwd,
    });
    // Destroy tmux session if it's a standalone session
    if (config.tmux_session && !config.tmux_session.includes(':')) {
      await killTeamSession(config.tmux_session, [], undefined);
    }
  } catch (err) {
    process.stderr.write(`[team/runtime-v2] tmux cleanup: ${err}\n`);
  }

  // 5. Ralph completion logging
  if (ralph) {
    const finalTasks = await listTasksFromFiles(sanitized, cwd).catch(() => [] as TeamTask[]);
    const completed = finalTasks.filter((t) => t.status === 'completed').length;
    const failed = finalTasks.filter((t) => t.status === 'failed').length;
    const pending = finalTasks.filter((t) => t.status === 'pending').length;
    await appendTeamEvent(sanitized, {
      type: 'team_leader_nudge',
      worker: 'leader-fixed',
      reason: `ralph_cleanup_summary: total=${finalTasks.length} completed=${completed} failed=${failed} pending=${pending} force=${force}`,
    }, cwd).catch(() => {});
  }

  // 6. Clean up state
  await cleanupTeamState(sanitized, cwd);
}

// ---------------------------------------------------------------------------
// resumeTeam — reconstruct runtime from persisted state
// ---------------------------------------------------------------------------

export async function resumeTeamV2(
  teamName: string,
  cwd: string,
): Promise<TeamRuntimeV2 | null> {
  const sanitized = sanitizeTeamName(teamName);
  const config = await readTeamConfig(sanitized, cwd);
  if (!config) return null;

  // Verify tmux session is alive
  try {
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const execFileAsync = promisify(execFile);
    const sessionName = config.tmux_session || `omc-team-${sanitized}`;
    await execFileAsync('tmux', ['has-session', '-t', sessionName.split(':')[0]]);

    return {
      teamName: sanitized,
      sanitizedName: sanitized,
      sessionName,
      config,
      cwd,
    };
  } catch {
    return null; // Session not alive
  }
}

// ---------------------------------------------------------------------------
// findActiveTeams — discover running teams
// ---------------------------------------------------------------------------

export async function findActiveTeamsV2(cwd: string): Promise<string[]> {
  const root = join(cwd, '.omc', 'state', 'team');
  if (!existsSync(root)) return [];
  const entries = await readdir(root, { withFileTypes: true });
  const active: string[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const teamName = e.name;
    const config = await readTeamConfig(teamName, cwd);
    if (config) {
      active.push(teamName);
    }
  }
  return active;
}
