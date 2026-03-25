import { readFileSync, writeFileSync } from 'fs';
import path from 'path';

import { config } from '../config';
import { runCommandWithInput } from './shell';
import { readRunJson } from './taskRuns';

export interface CodexStructuredResult {
  summary: string;
  implementation_summary: string;
  branch_name: string;
  base_branch: string;
  worktree_path: string;
  changed_files: string[];
  tests_run: string[];
  commit_sha: string;
  pr_url: string;
  pr_number: string;
  blockers: string[];
  follow_up: string[];
}

function buildCodexGitEnv() {
  const entries: Array<[string, string]> = [
    ['credential.helper', ''],
    ['credential.interactive', 'never'],
    ['core.askPass', ''],
  ];

  if (config.githubToken) {
    const basic = Buffer.from(`x-access-token:${config.githubToken}`).toString('base64');
    entries.push(['http.https://github.com/.extraheader', `AUTHORIZATION: basic ${basic}`]);
  }

  const gitConfigEnv = entries.reduce<Record<string, string>>((acc, [key, value], index) => {
    acc[`GIT_CONFIG_KEY_${index}`] = key;
    acc[`GIT_CONFIG_VALUE_${index}`] = value;
    return acc;
  }, {});

  return {
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'Never',
    GIT_ASKPASS: '/usr/bin/true',
    GIT_CONFIG_COUNT: String(entries.length),
    ...gitConfigEnv,
  };
}

export async function runCodexTask(params: {
  workspacePath: string;
  runFolder: string;
  prompt: string;
  schemaFile: string;
}) {
  const resultFile = path.join(params.runFolder, 'codex-result.json');
  const args = ['exec', '-C', params.workspacePath, '--output-schema', params.schemaFile, '-o', resultFile];

  if (config.codexExecModel) {
    args.push('-m', config.codexExecModel);
  }

  if (config.codexDangerouslyBypassSandbox) {
    args.push('--dangerously-bypass-approvals-and-sandbox');
  } else {
    args.push('--full-auto');
  }

  args.push('-');

  const result = await runCommandWithInput(config.codexCliPath, args, params.workspacePath, params.prompt, {
    env: buildCodexGitEnv(),
    timeoutMs: 60 * 60 * 1000,
  });

  writeFileSync(path.join(params.runFolder, 'codex-stdout.log'), result.stdout, 'utf8');
  writeFileSync(path.join(params.runFolder, 'codex-stderr.log'), result.stderr, 'utf8');

  let structured: CodexStructuredResult | null = null;
  try {
    structured = readRunJson<CodexStructuredResult>(resultFile);
    if (!structured) {
      const raw = readFileSync(resultFile, 'utf8').trim();
      structured = raw ? JSON.parse(raw) as CodexStructuredResult : null;
    }
  } catch {
    structured = null;
  }

  return {
    ...result,
    structured,
    resultFile,
  };
}
