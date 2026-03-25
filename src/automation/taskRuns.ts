import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'fs';
import path from 'path';

function sanitizePart(input: string) {
  return input.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
}

function ensureRoot() {
  const root = path.resolve(process.cwd(), 'data', 'task-runs');
  mkdirSync(root, { recursive: true });
  return root;
}

export function createTaskRunFolder(params: {
  channelId: string;
  slackTs: string;
  runId: string;
}) {
  const root = ensureRoot();
  const threadFolder = path.join(root, `${sanitizePart(params.channelId)}__${sanitizePart(params.slackTs.replace(/\./g, '_'))}`);
  const runFolder = path.join(threadFolder, params.runId);
  mkdirSync(threadFolder, { recursive: true });
  mkdirSync(runFolder, { recursive: true });
  return { threadFolder, runFolder };
}

export function writeRunArtifact(runFolder: string, fileName: string, content: string) {
  const filePath = path.join(runFolder, fileName);
  writeFileSync(filePath, content, 'utf8');
  return filePath;
}

export function writeRunJson(runFolder: string, fileName: string, payload: unknown) {
  return writeRunArtifact(runFolder, fileName, JSON.stringify(payload, null, 2));
}

export function readRunJson<T>(filePath: string) {
  if (!existsSync(filePath)) {
    return null;
  }

  return JSON.parse(readFileSync(filePath, 'utf8')) as T;
}

export function readLatestThreadArtifact<T>(threadFolder: string, fileName: string) {
  if (!existsSync(threadFolder)) {
    return null;
  }

  const runFolders = readdirSync(threadFolder)
    .map(name => path.join(threadFolder, name))
    .filter(candidate => {
      try {
        return statSync(candidate).isDirectory();
      } catch {
        return false;
      }
    })
    .sort()
    .reverse();

  for (const runFolder of runFolders) {
    const artifactPath = path.join(runFolder, fileName);
    const payload = readRunJson<T>(artifactPath);
    if (payload) {
      return payload;
    }
  }

  return null;
}
