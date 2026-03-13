export interface StartupAllocationTask {
  subject: string;
  description: string;
  owner?: string;
}

export interface StartupAllocationDecision {
  workerName: string;
  taskIndex: number;
}

function workerName(index: number): string {
  return `worker-${index + 1}`;
}

function normalizeExplicitOwner(rawOwner: string | undefined, workerCount: number): string | null {
  if (typeof rawOwner !== 'string') return null;
  const trimmed = rawOwner.trim();
  const match = /^worker-(\d+)$/.exec(trimmed);
  if (!match) return null;
  const numeric = Number.parseInt(match[1] ?? '', 10);
  if (!Number.isFinite(numeric) || numeric < 1 || numeric > workerCount) return null;
  return `worker-${numeric}`;
}

export function allocateStartupTasks(
  workerCount: number,
  tasks: StartupAllocationTask[],
): StartupAllocationDecision[] {
  if (workerCount <= 0 || tasks.length === 0) return [];

  const decisions: StartupAllocationDecision[] = [];
  const nextTaskByWorker = new Map<string, number[]>();
  for (let i = 0; i < workerCount; i += 1) {
    nextTaskByWorker.set(workerName(i), []);
  }

  let roundRobinCursor = 0;

  for (let taskIndex = 0; taskIndex < tasks.length; taskIndex += 1) {
    const explicitOwner = normalizeExplicitOwner(tasks[taskIndex]?.owner, workerCount);
    if (explicitOwner) {
      decisions.push({ workerName: explicitOwner, taskIndex });
      nextTaskByWorker.get(explicitOwner)?.push(taskIndex);
      continue;
    }

    const targetWorker = workerName(roundRobinCursor % workerCount);
    decisions.push({ workerName: targetWorker, taskIndex });
    nextTaskByWorker.get(targetWorker)?.push(taskIndex);
    roundRobinCursor += 1;
  }

  return decisions;
}
