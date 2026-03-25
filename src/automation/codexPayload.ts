import path from 'path';

import { loadMemoryProfile } from '../memory/profile';
import type { MessageClassification } from '../brain/classifier';
import type { ProjectRegistryEntry } from '../projects/registry';
import { writeRunArtifact, writeRunJson } from './taskRuns';

interface CodexPayloadParams {
  runId: string;
  runFolder: string;
  taskThreadFolder: string;
  messageText: string;
  threadContext?: string;
  senderName: string;
  project?: ProjectRegistryEntry;
  classification: MessageClassification;
  linearIssue?: { identifier: string; url: string; title: string } | null;
  workSnapshotText: string;
  repoRoot: string;
  baseBranch: string;
}

function sanitizeBranchPart(input: string) {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'task';
}

function buildSuggestedBranch(params: CodexPayloadParams) {
  const issuePart = params.linearIssue?.identifier || params.runId;
  const projectPart = params.project?.id || params.project?.repoName || 'task';
  return `codex/${sanitizeBranchPart(projectPart)}-${sanitizeBranchPart(issuePart)}`;
}

function buildPrompt(params: CodexPayloadParams) {
  const memory = loadMemoryProfile();
  const suggestedBranch = buildSuggestedBranch(params);
  const suggestedWorktreePath = path.join(
    params.repoRoot,
    '.delegate-worktrees',
    suggestedBranch.replace(/\//g, '-')
  );

  return [
    '# Codex Execution Task',
    '',
    'You are the code execution worker for Umar’s Slack delegate.',
    'You own the full implementation lifecycle for this task.',
    'You must inspect the repository, create the branch/worktree if needed, implement the change, run checks, commit, push, and open the PR yourself.',
    'Do not ask for approval. Operate non-interactively.',
    'GitHub auth is already available in the environment. Do not prompt for username or password.',
    'Prefer an isolated worktree so the base repo stays clean.',
    'If the repository is already clean and you can safely work directly in the repo root, that is allowed, but prefer the suggested worktree path.',
    'If the task is ambiguous, implement the safest high-confidence slice and explain what is left in blockers or follow_up.',
    '',
    `Run ID: ${params.runId}`,
    `Sender: ${params.senderName}`,
    `Project: ${params.project ? `${params.project.name} - ${params.project.description}` : 'unknown'}`,
    `Classification: ${params.classification.type} / ${params.classification.route}`,
    params.linearIssue ? `Linear Issue: ${params.linearIssue.identifier} ${params.linearIssue.url}` : 'Linear Issue: not created',
    `Repository root: ${params.repoRoot}`,
    `Base branch: ${params.baseBranch}`,
    `Suggested branch: ${suggestedBranch}`,
    `Suggested worktree path: ${suggestedWorktreePath}`,
    `Task thread folder: ${params.taskThreadFolder}`,
    '',
    '## Request',
    params.messageText,
    '',
    '## Thread Context',
    params.threadContext || 'No additional thread context.',
    '',
    '## Current Umar Work Snapshot',
    params.workSnapshotText,
    '',
    '## ROLE',
    memory.role,
    '',
    '## SKILL',
    memory.skill,
    '',
    '## SOUL',
    memory.soul,
    '',
    '## Required Execution Steps',
    `1. Work from the repository root \`${params.repoRoot}\`.`,
    `2. Create or reuse an isolated worktree under \`${path.join(params.repoRoot, '.delegate-worktrees')}\` whenever practical.`,
    `3. Create a git branch prefixed with \`codex/\`. Prefer \`${suggestedBranch}\`.`,
    `4. Inspect the codebase and identify the correct files/components to change.`,
    '5. Implement the requested change completely enough to open a PR.',
    '6. Run relevant tests, build, lint, or typecheck commands for the touched area. If no reasonable automated checks exist, leave tests_run empty and mention that in follow_up.',
    '7. Commit the change with a clear commit message, preferably starting with the Linear identifier when available.',
    '8. Push the branch to origin.',
    `9. Open a pull request against \`${params.baseBranch}\`. This base branch was selected by the orchestrator using the policy: prefer \`staging\`, otherwise fall back to \`main\`.`,
    '10. If GitHub CLI is available, you may use it for PR creation. Otherwise use the GitHub API with the existing token available in the environment.',
    '11. Leave the worktree and code changes in place for traceability.',
    '',
    '## Output Requirements',
    'Return JSON matching the provided schema exactly.',
    'Use empty strings for branch_name, worktree_path, commit_sha, pr_url, and pr_number only if the step truly could not be completed.',
    'Always return arrays for changed_files, tests_run, blockers, and follow_up, even when they are empty.',
    'Include a concise implementation summary and mention any blockers or remaining follow-up work.',
  ].join('\n');
}

function buildSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: [
      'summary',
      'implementation_summary',
      'branch_name',
      'base_branch',
      'worktree_path',
      'changed_files',
      'tests_run',
      'commit_sha',
      'pr_url',
      'pr_number',
      'blockers',
      'follow_up',
    ],
    properties: {
      summary: { type: 'string' },
      implementation_summary: { type: 'string' },
      branch_name: { type: 'string' },
      base_branch: { type: 'string' },
      worktree_path: { type: 'string' },
      changed_files: {
        type: 'array',
        items: { type: 'string' },
      },
      tests_run: {
        type: 'array',
        items: { type: 'string' },
      },
      commit_sha: { type: 'string' },
      pr_url: { type: 'string' },
      pr_number: { type: 'string' },
      blockers: {
        type: 'array',
        items: { type: 'string' },
      },
      follow_up: {
        type: 'array',
        items: { type: 'string' },
      },
    },
  };
}

export function createCodexPayload(params: CodexPayloadParams) {
  const prompt = buildPrompt(params);
  const schema = buildSchema();

  const promptFile = writeRunArtifact(params.runFolder, 'codex-prompt.md', prompt);
  const schemaFile = writeRunJson(params.runFolder, 'codex-output-schema.json', schema);
  writeRunJson(params.runFolder, 'task-context.json', {
    runId: params.runId,
    senderName: params.senderName,
    messageText: params.messageText,
    threadContext: params.threadContext || '',
    project: params.project || null,
    classification: params.classification,
    linearIssue: params.linearIssue || null,
    repoRoot: params.repoRoot,
    baseBranch: params.baseBranch,
    suggestedBranch: buildSuggestedBranch(params),
    taskThreadFolder: params.taskThreadFolder,
  });

  return {
    prompt,
    promptFile,
    schemaFile,
    suggestedBranch: buildSuggestedBranch(params),
  };
}
