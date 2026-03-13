import { describe, expect, it } from 'vitest';

import { allocateStartupTasks } from '../allocation-policy.js';

describe('allocateStartupTasks', () => {
  it('returns empty for no workers or tasks', () => {
    expect(allocateStartupTasks(0, [{ subject: 'a', description: 'b' }])).toEqual([]);
    expect(allocateStartupTasks(2, [])).toEqual([]);
  });

  it('preserves valid explicit owners', () => {
    expect(allocateStartupTasks(3, [
      { subject: 'a', description: 'b', owner: 'worker-2' },
      { subject: 'c', description: 'd', owner: 'worker-3' },
    ])).toEqual([
      { workerName: 'worker-2', taskIndex: 0 },
      { workerName: 'worker-3', taskIndex: 1 },
    ]);
  });

  it('falls back to round-robin for missing or invalid owners', () => {
    expect(allocateStartupTasks(2, [
      { subject: 'a', description: 'b' },
      { subject: 'c', description: 'd', owner: 'leader-fixed' },
      { subject: 'e', description: 'f', owner: 'worker-9' },
    ])).toEqual([
      { workerName: 'worker-1', taskIndex: 0 },
      { workerName: 'worker-2', taskIndex: 1 },
      { workerName: 'worker-1', taskIndex: 2 },
    ]);
  });

  it('keeps later round-robin assignments stable around explicit owners', () => {
    expect(allocateStartupTasks(3, [
      { subject: 'a', description: 'b' },
      { subject: 'c', description: 'd', owner: 'worker-3' },
      { subject: 'e', description: 'f' },
      { subject: 'g', description: 'h' },
    ])).toEqual([
      { workerName: 'worker-1', taskIndex: 0 },
      { workerName: 'worker-3', taskIndex: 1 },
      { workerName: 'worker-2', taskIndex: 2 },
      { workerName: 'worker-3', taskIndex: 3 },
    ]);
  });
});
