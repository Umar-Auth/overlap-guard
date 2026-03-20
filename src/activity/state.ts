import { config } from '../config';

export interface FileActivity {
  user: string;
  file: string;
  timestamp: number;
}

const activeFiles = new Map<string, Map<string, FileActivity>>();

export function cleanStaleEntries() {
  const cutoff = Date.now() - config.staleMinutes * 60 * 1000;

  for (const [file, users] of activeFiles) {
    for (const [user, activity] of users) {
      if (activity.timestamp < cutoff) {
        users.delete(user);
      }
    }

    if (users.size === 0) {
      activeFiles.delete(file);
    }
  }
}

export function trackFile(user: string, file: string): string[] {
  cleanStaleEntries();

  if (!activeFiles.has(file)) {
    activeFiles.set(file, new Map());
  }

  const fileUsers = activeFiles.get(file)!;
  const otherUsers = [...fileUsers.keys()].filter(existingUser => existingUser !== user);

  fileUsers.set(user, { user, file, timestamp: Date.now() });
  return otherUsers;
}

export function getActivitySnapshot() {
  cleanStaleEntries();

  const snapshot: Record<string, string[]> = {};
  for (const [file, users] of activeFiles) {
    snapshot[file] = [...users.keys()];
  }

  return snapshot;
}

export function getUsersForMatchingFile(file: string) {
  cleanStaleEntries();

  const users: string[] = [];
  for (const [trackedFile, trackedUsers] of activeFiles) {
    if (trackedFile.includes(file) || file.includes(trackedFile)) {
      users.push(...trackedUsers.keys());
    }
  }

  return [...new Set(users)];
}
