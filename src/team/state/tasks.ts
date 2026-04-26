import { randomUUID } from 'crypto';
import { join } from 'path';
import { existsSync } from 'fs';
import { readFile, readdir } from 'fs/promises';
import type { TeamTaskStatus } from '../contracts.js';
import type {
  TeamTask,
  TaskReadiness,
  ClaimTaskResult,
  TransitionTaskResult,
  ReleaseTaskClaimResult,
  TeamMonitorSnapshotState,
} from '../types.js';

interface TaskReadDeps {
  readTask: (teamName: string, taskId: string, cwd: string) => Promise<TeamTask | null>;
}

export async function computeTaskReadiness(
  teamName: string,
  taskId: string,
  cwd: string,
  deps: TaskReadDeps,
): Promise<TaskReadiness> {
  const task = await deps.readTask(teamName, taskId, cwd);
  if (!task) return { ready: false, reason: 'blocked_dependency', dependencies: [] };

  const depIds = task.depends_on ?? task.blocked_by ?? [];
  if (depIds.length === 0) return { ready: true };

  const depTasks = await Promise.all(depIds.map((depId) => deps.readTask(teamName, depId, cwd)));
  const incomplete = depIds.filter((_, idx) => depTasks[idx]?.status !== 'completed');
  if (incomplete.length > 0) return { ready: false, reason: 'blocked_dependency', dependencies: incomplete };

  return { ready: true };
}

interface ClaimTaskDeps extends TaskReadDeps {
  teamName: string;
  cwd: string;
  readTeamConfig: (teamName: string, cwd: string) => Promise<{ workers: Array<{ name: string }> } | null>;
  withTaskClaimLock: <T>(teamName: string, taskId: string, cwd: string, fn: () => Promise<T>) => Promise<{ ok: true; value: T } | { ok: false }>;
  isTerminalTaskStatus: (status: TeamTaskStatus) => boolean;
  taskFilePath: (teamName: string, taskId: string, cwd: string) => string;
  writeAtomic: (path: string, data: string) => Promise<void>;
}

export async function claimTask(
  taskId: string,
  workerName: string,
  expectedVersion: number | null,
  deps: ClaimTaskDeps,
): Promise<ClaimTaskResult> {
  const cfg = await deps.readTeamConfig(deps.teamName, deps.cwd);
  if (!cfg || !cfg.workers.some((w) => w.name === workerName)) return { ok: false, error: 'worker_not_found' };

  const existing = await deps.readTask(deps.teamName, taskId, deps.cwd);
  if (!existing) return { ok: false, error: 'task_not_found' };

  const readiness = await computeTaskReadiness(deps.teamName, taskId, deps.cwd, deps);
  if (readiness.ready === false) {
    return { ok: false, error: 'blocked_dependency', dependencies: readiness.dependencies };
  }

  const lock = await deps.withTaskClaimLock(deps.teamName, taskId, deps.cwd, async () => {
    const current = await deps.readTask(deps.teamName, taskId, deps.cwd);
    if (!current) return { ok: false as const, error: 'task_not_found' as const };

    if (expectedVersion !== null && current.version !== expectedVersion) return { ok: false as const, error: 'claim_conflict' as const };

    const readinessAfterLock = await computeTaskReadiness(deps.teamName, taskId, deps.cwd, deps);
    if (readinessAfterLock.ready === false) {
      return { ok: false as const, error: 'blocked_dependency' as const, dependencies: readinessAfterLock.dependencies };
    }

    if (deps.isTerminalTaskStatus(current.status)) return { ok: false as const, error: 'already_terminal' as const };
    if (current.status === 'in_progress') return { ok: false as const, error: 'claim_conflict' as const };

    if (current.status === 'pending' || current.status === 'blocked') {
      if (current.claim) return { ok: false as const, error: 'claim_conflict' as const };
      if (current.owner && current.owner !== workerName) return { ok: false as const, error: 'claim_conflict' as const };
    }

    const claimToken = randomUUID();
    const updated: TeamTask = {
      ...current,
      status: 'in_progress',
      owner: workerName,
      claim: { owner: workerName, token: claimToken, leased_until: new Date(Date.now() + 15 * 60 * 1000).toISOString() },
      version: current.version + 1,
    };

    await deps.writeAtomic(deps.taskFilePath(deps.teamName, taskId, deps.cwd), JSON.stringify(updated, null, 2));
    return { ok: true as const, task: updated, claimToken };
  });

  if (!lock.ok) return { ok: false, error: 'claim_conflict' };
  return lock.value;
}

interface TransitionDeps extends ClaimTaskDeps {
  canTransitionTaskStatus: (from: TeamTaskStatus, to: TeamTaskStatus) => boolean;
  appendTeamEvent: (
    teamName: string,
    event: {
      type: 'task_completed' | 'task_failed';
      worker: string;
      task_id?: string;
      message_id?: string | null;
      reason?: string;
    },
    cwd: string,
  ) => Promise<unknown>;
  readMonitorSnapshot: (teamName: string, cwd: string) => Promise<TeamMonitorSnapshotState | null>;
  writeMonitorSnapshot: (teamName: string, snapshot: TeamMonitorSnapshotState, cwd: string) => Promise<void>;
}

export async function transitionTaskStatus(
  taskId: string,
  from: TeamTaskStatus,
  to: TeamTaskStatus,
  claimToken: string,
  deps: TransitionDeps,
): Promise<TransitionTaskResult> {
  if (!deps.canTransitionTaskStatus(from, to)) return { ok: false, error: 'invalid_transition' };

  const lock = await deps.withTaskClaimLock(deps.teamName, taskId, deps.cwd, async () => {
    const current = await deps.readTask(deps.teamName, taskId, deps.cwd);
    if (!current) return { ok: false as const, error: 'task_not_found' as const };

    if (deps.isTerminalTaskStatus(current.status)) return { ok: false as const, error: 'already_terminal' as const };
    if (!deps.canTransitionTaskStatus(current.status, to)) return { ok: false as const, error: 'invalid_transition' as const };
    if (current.status !== from) return { ok: false as const, error: 'invalid_transition' as const };

    if (!current.owner || !current.claim || current.claim.owner !== current.owner || current.claim.token !== claimToken) {
      return { ok: false as const, error: 'claim_conflict' as const };
    }
    if (new Date(current.claim.leased_until) <= new Date()) return { ok: false as const, error: 'lease_expired' as const };

    const updated: TeamTask = {
      ...current,
      status: to,
      completed_at: to === 'completed' ? new Date().toISOString() : current.completed_at,
      claim: undefined,
      version: current.version + 1,
    };
    await deps.writeAtomic(deps.taskFilePath(deps.teamName, taskId, deps.cwd), JSON.stringify(updated, null, 2));

    if (to === 'completed') {
      await deps.appendTeamEvent(
        deps.teamName,
        { type: 'task_completed', worker: updated.owner || 'unknown', task_id: updated.id, message_id: null, reason: undefined },
        deps.cwd,
      );
    } else if (to === 'failed') {
      await deps.appendTeamEvent(
        deps.teamName,
        { type: 'task_failed', worker: updated.owner || 'unknown', task_id: updated.id, message_id: null, reason: updated.error || 'task_failed' },
        deps.cwd,
      );
    }

    return { ok: true as const, task: updated };
  });

  if (!lock.ok) return { ok: false, error: 'claim_conflict' };

  if (to === 'completed') {
    const existing = await deps.readMonitorSnapshot(deps.teamName, deps.cwd);
    const updated: TeamMonitorSnapshotState = existing
      ? { ...existing, completedEventTaskIds: { ...(existing.completedEventTaskIds ?? {}), [taskId]: true } }
      : {
          taskStatusById: {},
          workerAliveByName: {},
          workerStateByName: {},
          workerTurnCountByName: {},
          workerTaskIdByName: {},
          mailboxNotifiedByMessageId: {},
          completedEventTaskIds: { [taskId]: true },
        };
    await deps.writeMonitorSnapshot(deps.teamName, updated, deps.cwd);
  }

  return lock.value;
}

type ReleaseDeps = ClaimTaskDeps;

export async function releaseTaskClaim(
  taskId: string,
  claimToken: string,
  _workerName: string,
  deps: ReleaseDeps,
): Promise<ReleaseTaskClaimResult> {
  const lock = await deps.withTaskClaimLock(deps.teamName, taskId, deps.cwd, async () => {
    const current = await deps.readTask(deps.teamName, taskId, deps.cwd);
    if (!current) return { ok: false as const, error: 'task_not_found' as const };

    if (current.status === 'pending' && !current.claim && !current.owner) return { ok: true as const, task: current };
    if (current.status === 'completed' || current.status === 'failed') return { ok: false as const, error: 'already_terminal' as const };

    if (!current.owner || !current.claim || current.claim.owner !== current.owner || current.claim.token !== claimToken) {
      return { ok: false as const, error: 'claim_conflict' as const };
    }
    if (new Date(current.claim.leased_until) <= new Date()) return { ok: false as const, error: 'lease_expired' as const };

    const updated: TeamTask = {
      ...current,
      status: 'pending',
      owner: undefined,
      claim: undefined,
      version: current.version + 1,
    };
    await deps.writeAtomic(deps.taskFilePath(deps.teamName, taskId, deps.cwd), JSON.stringify(updated, null, 2));
    return { ok: true as const, task: updated };
  });

  if (!lock.ok) return { ok: false, error: 'claim_conflict' };
  return lock.value;
}

export async function listTasks(
  teamName: string,
  cwd: string,
  deps: {
    teamDir: (teamName: string, cwd: string) => string;
    isTeamTask: (value: unknown) => value is TeamTask;
  },
): Promise<TeamTask[]> {
  const tasksRoot = join(deps.teamDir(teamName, cwd), 'tasks');
  if (!existsSync(tasksRoot)) return [];

  const entries = await readdir(tasksRoot, { withFileTypes: true });
  const matched = entries.flatMap((entry) => {
    if (!entry.isFile()) return [];
    const match = /^task-(\d+)\.json$/.exec(entry.name);
    if (!match) return [];
    return [{ id: match[1], fileName: entry.name }];
  });

  const loaded = await Promise.all(
    matched.map(async ({ id, fileName }) => {
      try {
        const raw = await readFile(join(tasksRoot, fileName), 'utf8');
        const parsed = JSON.parse(raw) as unknown;
        if (!deps.isTeamTask(parsed)) return null;
        if (parsed.id !== id) return null;
        return parsed;
      } catch {
        return null;
      }
    }),
  );

  const tasks: TeamTask[] = [];
  for (const task of loaded) {
    if (task) tasks.push(task);
  }
  tasks.sort((a, b) => Number(a.id) - Number(b.id));
  return tasks;
}
