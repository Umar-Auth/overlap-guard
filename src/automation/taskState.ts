import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import path from 'path';

interface ActiveTaskState {
  runId: string;
  channelId: string;
  slackTs: string;
  projectId?: string;
  summary: string;
  startedAt: string;
  updatedAt: string;
  stage?: string;
}

const taskStateDir = path.resolve(process.cwd(), 'data', 'task-runs');
const activeTaskFile = path.join(taskStateDir, 'active-task.json');
const STALE_TASK_MS = 15 * 60 * 1000;

let activeTask: ActiveTaskState | null = null;

function ensureTaskStateDir() {
  mkdirSync(taskStateDir, { recursive: true });
}

function isStale(state: ActiveTaskState | null) {
  if (!state) {
    return false;
  }

  const updatedAt = state.updatedAt || state.startedAt;
  return Boolean(updatedAt && Date.now() - new Date(updatedAt).getTime() > STALE_TASK_MS);
}

function loadActiveTask() {
  if (activeTask) {
    if (isStale(activeTask)) {
      activeTask = null;
      if (existsSync(activeTaskFile)) {
        rmSync(activeTaskFile, { force: true });
      }
      return null;
    }
    return activeTask;
  }

  if (!existsSync(activeTaskFile)) {
    return null;
  }

  try {
    activeTask = JSON.parse(readFileSync(activeTaskFile, 'utf8'));
    if (isStale(activeTask)) {
      activeTask = null;
      rmSync(activeTaskFile, { force: true });
      return null;
    }
    return activeTask;
  } catch {
    return null;
  }
}

export function getActiveTask() {
  return loadActiveTask();
}

export function startActiveTask(state: ActiveTaskState) {
  const existing = loadActiveTask();
  if (existing) {
    return {
      ok: false as const,
      active: existing,
    };
  }

  ensureTaskStateDir();
  activeTask = state;
  writeFileSync(activeTaskFile, JSON.stringify(state, null, 2), 'utf8');
  return {
    ok: true as const,
  };
}

export function refreshActiveTask(runId: string, patch?: Partial<Pick<ActiveTaskState, 'stage' | 'summary'>>) {
  const existing = loadActiveTask();
  if (!existing || existing.runId !== runId) {
    return;
  }

  activeTask = {
    ...existing,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  writeFileSync(activeTaskFile, JSON.stringify(activeTask, null, 2), 'utf8');
}

export function finishActiveTask(runId: string) {
  const existing = loadActiveTask();
  if (!existing || existing.runId !== runId) {
    return;
  }

  activeTask = null;
  if (existsSync(activeTaskFile)) {
    rmSync(activeTaskFile, { force: true });
  }
}
