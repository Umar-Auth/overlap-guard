import { config } from '../config';
import { getMyWorkSnapshot } from '../integrations/myWork';
import { loadMemoryProfile } from '../memory/profile';
import { logObservation } from '../observation/log';
import type { ProjectRegistryEntry } from '../projects/registry';
import type { MessageClassification } from '../brain/classifier';
import { createLinearTaskFromSlack } from './linearTasks';
import { commitChanges, createPullRequest, getChangedFiles, prepareTaskWorkspace, pushBranch, runProjectChecks, writeTaskArtifact } from './git';
import { runCommandLine } from './shell';

interface TaskRunResult {
  finalReply: string;
}

function trimOutput(output: string, maxLength = 1200) {
  return output.length > maxLength ? `${output.slice(0, maxLength)}\n...` : output;
}

function shellEscape(value: string) {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

function renderCommandTemplate(template: string, values: Record<string, string>) {
  return Object.entries(values).reduce((command, [key, value]) => {
    return command.replaceAll(`{${key}}`, shellEscape(value));
  }, template);
}

function buildTaskPrompt(params: {
  messageText: string;
  threadContext?: string;
  senderName: string;
  project?: ProjectRegistryEntry;
  classification: MessageClassification;
  linearIssue?: { identifier: string; url: string; title: string } | null;
  workSnapshotText: string;
}) {
  const memory = loadMemoryProfile();

  return [
    '# Delegate Task Execution Prompt',
    '',
    `Sender: ${params.senderName}`,
    `Project: ${params.project ? `${params.project.name} - ${params.project.description}` : 'unknown'}`,
    `Classification: ${params.classification.type} / ${params.classification.executionMode}`,
    params.linearIssue ? `Linear Issue: ${params.linearIssue.identifier} ${params.linearIssue.url}` : 'Linear Issue: not created',
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
    '## Execution Expectations',
    '- Make the requested code change directly in this workspace if it is well-scoped.',
    '- Keep changes minimal and production-safe.',
    '- Do not commit or push; the orchestrator will handle git afterwards.',
    '- If the task is ambiguous, leave a concise note in the execution summary.',
  ].join('\n');
}

function formatWorkSnapshot(snapshot: Awaited<ReturnType<typeof getMyWorkSnapshot>>) {
  const lines = ['Linear issues:'];

  if (snapshot.linearIssues.length === 0) {
    lines.push('- None');
  } else {
    lines.push(...snapshot.linearIssues.map(issue => `- ${issue.identifier}: ${issue.title} (${issue.status})`));
  }

  lines.push('');
  lines.push('Open PRs:');
  if (snapshot.pullRequests.length === 0) {
    lines.push('- None');
  } else {
    lines.push(...snapshot.pullRequests.map(pr => `- #${pr.number}: ${pr.title} (${pr.repository})`));
  }

  return lines.join('\n');
}

export async function runTaskAutomation(params: {
  messageText: string;
  senderName: string;
  channelId: string;
  slackTs: string;
  classification: MessageClassification;
  project?: ProjectRegistryEntry;
  threadContext?: string;
  onProgress?: (text: string) => Promise<void>;
}): Promise<TaskRunResult> {
  const runId = `${Date.now()}`;
  logObservation({
    kind: 'task_run_started',
    channelId: params.channelId,
    slackTs: params.slackTs,
    projectId: params.project?.id,
    projectName: params.project?.name,
    summary: params.classification.summary,
    executionMode: params.classification.executionMode,
  });

  const say = async (text: string) => {
    if (params.onProgress) {
      await params.onProgress(text);
    }
  };

  await say(`I classified this as a task${params.project ? ` for *${params.project.name}*` : ''} and I’m moving it into execution.`);

  const linearIssue = await createLinearTaskFromSlack(params);
  if (linearIssue) {
    await say(`I created Linear ticket *${linearIssue.identifier}* and attached the Slack context: ${linearIssue.url}`);
  } else {
    await say('I could not create the Linear ticket automatically, so I’m continuing without a ticket link for now.');
  }

  if (params.classification.executionMode !== 'code_change') {
    logObservation({
      kind: 'task_run_queued',
      channelId: params.channelId,
      slackTs: params.slackTs,
      projectId: params.project?.id,
      projectName: params.project?.name,
      linearIssueId: linearIssue?.id,
    });
    return {
      finalReply: linearIssue
        ? `I logged this as task *${linearIssue.identifier}* and kept it in the execution queue: ${linearIssue.url}`
        : 'I classified this as a task and moved it into the execution queue.',
    };
  }

  if (!config.taskExecutionEnabled) {
    logObservation({
      kind: 'task_run_blocked',
      channelId: params.channelId,
      slackTs: params.slackTs,
      projectId: params.project?.id,
      projectName: params.project?.name,
      linearIssueId: linearIssue?.id,
      reason: 'task execution disabled',
    });
    return {
      finalReply: linearIssue
        ? `I captured this in *${linearIssue.identifier}*, but code execution is disabled right now, so I stopped before touching the repo: ${linearIssue.url}`
        : 'I captured the task, but code execution is disabled right now, so I stopped before touching the repo.',
    };
  }

  const workspacePrep = await prepareTaskWorkspace({
    project: params.project,
    branchHint: linearIssue?.identifier || params.classification.summary || 'task',
  });

  if (!workspacePrep.ok) {
    logObservation({
      kind: 'task_run_blocked',
      channelId: params.channelId,
      slackTs: params.slackTs,
      projectId: params.project?.id,
      projectName: params.project?.name,
      linearIssueId: linearIssue?.id,
      reason: workspacePrep.reason,
    });
    return {
      finalReply: linearIssue
        ? `I created *${linearIssue.identifier}*, but I could not prepare the local workspace: ${workspacePrep.reason}`
        : `I classified the task, but I could not prepare the local workspace: ${workspacePrep.reason}`,
    };
  }

  const workspace = workspacePrep.workspace;
  await say(`I prepared the implementation workspace and created branch \`${workspace.branchName}\`.`);

  const workSnapshot = await getMyWorkSnapshot(params.project);
  const taskPrompt = buildTaskPrompt({
    messageText: params.messageText,
    threadContext: params.threadContext,
    senderName: params.senderName,
    project: params.project,
    classification: params.classification,
    linearIssue,
    workSnapshotText: formatWorkSnapshot(workSnapshot),
  });

  const promptFile = writeTaskArtifact({
    workspacePath: workspace.workspacePath,
    runId,
    fileName: 'task-prompt.md',
    content: taskPrompt,
  });

  if (!config.taskExecutorCommand) {
    logObservation({
      kind: 'task_run_blocked',
      channelId: params.channelId,
      slackTs: params.slackTs,
      projectId: params.project?.id,
      projectName: params.project?.name,
      linearIssueId: linearIssue?.id,
      branchName: workspace.branchName,
      reason: 'TASK_EXECUTOR_COMMAND missing',
    });
    return {
      finalReply: linearIssue
        ? `I created *${linearIssue.identifier}* and prepared branch \`${workspace.branchName}\`, but no task executor is configured yet. Add \`TASK_EXECUTOR_COMMAND\` so I can implement and open the PR automatically.`
        : `I prepared branch \`${workspace.branchName}\`, but no task executor is configured yet. Add \`TASK_EXECUTOR_COMMAND\` so I can implement and open the PR automatically.`,
    };
  }

  await say('I’m applying the code change in the project workspace now.');

  const executorCommand = renderCommandTemplate(config.taskExecutorCommand, {
    workspace: workspace.workspacePath,
    promptFile,
    branch: workspace.branchName,
    repoOwner: workspace.repoOwner,
    repoName: workspace.repoName,
    issueIdentifier: linearIssue?.identifier || 'no-linear-issue',
  });

  const executorResult = await runCommandLine(executorCommand, workspace.workspacePath, {
    timeoutMs: 30 * 60 * 1000,
  });

  writeTaskArtifact({
    workspacePath: workspace.workspacePath,
    runId,
    fileName: 'executor-output.log',
    content: [executorResult.stdout, executorResult.stderr].filter(Boolean).join('\n\n'),
  });

  if (executorResult.code !== 0) {
    logObservation({
      kind: 'task_execution_failed',
      channelId: params.channelId,
      slackTs: params.slackTs,
      projectId: params.project?.id,
      projectName: params.project?.name,
      linearIssueId: linearIssue?.id,
      branchName: workspace.branchName,
      output: trimOutput([executorResult.stdout, executorResult.stderr].filter(Boolean).join('\n')),
    });

    return {
      finalReply: linearIssue
        ? `I created *${linearIssue.identifier}* and prepared branch \`${workspace.branchName}\`, but the implementation run failed.\n\n${trimOutput(executorResult.stderr || executorResult.stdout || 'No output captured.')}`
        : `I prepared branch \`${workspace.branchName}\`, but the implementation run failed.\n\n${trimOutput(executorResult.stderr || executorResult.stdout || 'No output captured.')}`,
    };
  }

  const changedFiles = await getChangedFiles(workspace.workspacePath);
  if (changedFiles.length === 0) {
    logObservation({
      kind: 'task_run_no_changes',
      channelId: params.channelId,
      slackTs: params.slackTs,
      projectId: params.project?.id,
      projectName: params.project?.name,
      linearIssueId: linearIssue?.id,
      branchName: workspace.branchName,
    });
    return {
      finalReply: linearIssue
        ? `I created *${linearIssue.identifier}* and ran the implementation flow, but it did not produce any code changes in \`${workspace.branchName}\`.`
        : `I ran the implementation flow, but it did not produce any code changes in \`${workspace.branchName}\`.`,
    };
  }

  await say(`The implementation is done locally. I found changes in ${changedFiles.length} file(s), so I’m running checks next.`);

  const checks = await runProjectChecks(workspace.workspacePath, params.project?.testCommand);
  if (checks.ran) {
    await say(checks.success ? 'Project checks passed, so I’m packaging the change.' : 'Project checks finished with failures, but I’m still recording the result in the task flow.');
  }

  if (!config.taskCommitEnabled) {
    return {
      finalReply: `I completed the code-change pass on \`${workspace.branchName}\`${linearIssue ? ` for *${linearIssue.identifier}*` : ''}, but automatic git commit is disabled.`,
    };
  }

  const commitMessage = linearIssue
    ? `${linearIssue.identifier}: ${params.classification.summary || params.messageText}`.slice(0, 72)
    : `task: ${params.classification.summary || params.messageText}`.slice(0, 72);
  const commit = await commitChanges({
    workspacePath: workspace.workspacePath,
    message: commitMessage,
  });

  if (!commit.success) {
    return {
      finalReply: `I prepared the implementation on \`${workspace.branchName}\`, but I could not create the commit automatically.\n\n${trimOutput(commit.output || 'No git output captured.')}`,
    };
  }

  await say(`I committed the implementation on \`${workspace.branchName}\`.`);

  if (!config.taskPushEnabled) {
    return {
      finalReply: `I committed the implementation on \`${workspace.branchName}\`${linearIssue ? ` for *${linearIssue.identifier}*` : ''}, but automatic push is disabled.`,
    };
  }

  const push = await pushBranch({
    workspacePath: workspace.workspacePath,
    branchName: workspace.branchName,
  });

  if (!push.success) {
    return {
      finalReply: `I committed the implementation on \`${workspace.branchName}\`, but I could not push the branch automatically.\n\n${trimOutput(push.output || 'No git output captured.')}`,
    };
  }

  await say(`I pushed branch \`${workspace.branchName}\` to GitHub.`);

  if (!config.taskCreatePrEnabled) {
    return {
      finalReply: `I pushed \`${workspace.branchName}\`${linearIssue ? ` for *${linearIssue.identifier}*` : ''}, but automatic PR creation is disabled.`,
    };
  }

  const pr = await createPullRequest({
    repoOwner: workspace.repoOwner,
    repoName: workspace.repoName,
    branchName: workspace.branchName,
    baseBranch: workspace.baseBranch,
    title: linearIssue
      ? `${linearIssue.identifier}: ${params.classification.summary || params.messageText}`.slice(0, 120)
      : `${params.classification.summary || params.messageText}`.slice(0, 120),
    body: [
      linearIssue ? `Linear: ${linearIssue.url}` : 'Linear: not linked',
      `Slack thread: channel ${params.channelId}, ts ${params.slackTs}`,
      '',
      'Requested task:',
      params.messageText,
      '',
      checks.ran
        ? `Checks: ${checks.success ? 'passed' : 'failed'}`
        : 'Checks: no project test command configured',
    ].join('\n'),
  });

  await say(`I opened PR *#${pr.number}* against \`${workspace.baseBranch}\`.`);
  logObservation({
    kind: 'task_run_completed',
    channelId: params.channelId,
    slackTs: params.slackTs,
    projectId: params.project?.id,
    projectName: params.project?.name,
    linearIssueId: linearIssue?.id,
    branchName: workspace.branchName,
    pullRequestUrl: pr.url,
    changedFiles,
  });

  return {
    finalReply: [
      linearIssue ? `I created *${linearIssue.identifier}*.` : 'I moved the task into execution.',
      `Implementation branch: \`${workspace.branchName}\``,
      `PR: ${pr.url}`,
      checks.ran
        ? checks.success
          ? 'Checks passed.'
          : `Checks reported issues:\n${trimOutput(checks.output || 'No output captured.')}`
        : 'No automated checks were configured for this project.',
    ].join('\n'),
  };
}
