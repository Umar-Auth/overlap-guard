import { config } from '../config';
import { getMyWorkSnapshot } from '../integrations/myWork';
import { logObservation } from '../observation/log';
import type { ProjectRegistryEntry } from '../projects/registry';
import type { MessageClassification } from '../brain/classifier';
import { createLinearTaskFromSlack } from './linearTasks';
import { createCodexPayload } from './codexPayload';
import { runCodexTask, type CodexStructuredResult } from './codexExecutor';
import { preflightTaskExecution } from './preflight';
import { finishActiveTask, refreshActiveTask, startActiveTask } from './taskState';
import { createTaskRunFolder, readLatestThreadArtifact, writeRunArtifact, writeRunJson } from './taskRuns';
import { runCommandLine } from './shell';

interface TaskRunResult {
  finalReply: string;
}

interface ExecutorResult {
  code: number;
  stdout: string;
  stderr: string;
  structured: CodexStructuredResult | null;
}

function trimOutput(output: string, maxLength = 1200) {
  return output.length > maxLength ? `${output.slice(0, maxLength)}\n...` : output;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string) {
  let timer: NodeJS.Timeout | null = null;

  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
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

function formatBusyMessage(params: {
  projectId?: string;
  summary?: string;
  startedAt: string;
  updatedAt?: string;
  stage?: string;
}) {
  const started = new Date(params.startedAt).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
  });
  const updated = params.updatedAt
    ? new Date(params.updatedAt).toLocaleTimeString('en-US', {
        hour: 'numeric',
        minute: '2-digit',
      })
    : null;
  return [
    `I’m already executing one task right now${params.projectId ? ` for *${params.projectId}*` : ''}.`,
    params.summary ? `Current task: ${params.summary}` : '',
    params.stage ? `Current stage: ${params.stage}` : '',
    `Started: ${started}`,
    updated ? `Last update: ${updated}` : '',
  ].filter(Boolean).join('\n');
}

function formatExecutorFailure(
  linearIssue: { identifier: string; url: string } | null,
  threadFolder: string,
  executorResult: ExecutorResult
) {
  const output = trimOutput(executorResult.stderr || executorResult.stdout || 'No output captured.');
  return linearIssue
    ? `I created *${linearIssue.identifier}*, but the Codex implementation run failed.\n\n${output}\n\nTask run folder: \`${threadFolder}\``
    : `The Codex implementation run failed.\n\n${output}\n\nTask run folder: \`${threadFolder}\``;
}

function formatSuccessReply(params: {
  linearIssue: { identifier: string; url: string } | null;
  result: CodexStructuredResult;
  threadFolder: string;
}) {
  return [
    params.linearIssue ? `I reused *${params.linearIssue.identifier}* and completed the implementation flow.` : 'I completed the implementation flow.',
    params.result.branch_name ? `Branch: \`${params.result.branch_name}\`` : '',
    params.result.pr_url ? `PR: ${params.result.pr_url}` : 'PR: not created',
    params.result.commit_sha ? `Commit: \`${params.result.commit_sha}\`` : '',
    params.result.implementation_summary ? `Summary: ${params.result.implementation_summary}` : '',
    params.result.tests_run.length > 0 ? `Checks: ${params.result.tests_run.join(', ')}` : 'Checks: none reported',
    params.result.follow_up.length > 0 ? `Follow-up: ${params.result.follow_up.join(' | ')}` : '',
    `Task run folder: \`${params.threadFolder}\``,
  ].filter(Boolean).join('\n');
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
  const lock = startActiveTask({
    runId,
    channelId: params.channelId,
    slackTs: params.slackTs,
    projectId: params.project?.id,
    summary: params.classification.summary || params.messageText,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  if (!lock.ok) {
    return {
      finalReply: formatBusyMessage(lock.active),
    };
  }

  const { threadFolder, runFolder } = createTaskRunFolder({
    channelId: params.channelId,
    slackTs: params.slackTs,
    runId,
  });

  writeRunJson(runFolder, 'run-start.json', {
    runId,
    channelId: params.channelId,
    slackTs: params.slackTs,
    senderName: params.senderName,
    project: params.project || null,
    classification: params.classification,
    startedAt: new Date().toISOString(),
  });
  writeRunJson(runFolder, 'classification.json', params.classification);
  writeRunJson(runFolder, 'project-resolution.json', params.project || null);

  logObservation({
    kind: 'task_run_started',
    channelId: params.channelId,
    slackTs: params.slackTs,
    projectId: params.project?.id,
    projectName: params.project?.name,
    summary: params.classification.summary,
    route: params.classification.route,
  });

  const say = async (text: string) => {
    refreshActiveTask(runId, { stage: text });
    if (params.onProgress) {
      await params.onProgress(text);
    }
  };

  try {
    const taskIntro = params.classification.route === 'code_change_task'
      ? `I classified this as an implementation task${params.project ? ` for *${params.project.name}*` : ''}. I’ll create the Linear ticket first, then I’ll hand the full implementation flow to Codex.`
      : `I classified this as a ticket-only task${params.project ? ` for *${params.project.name}*` : ''}. I’m creating the Linear ticket now.`;
    await say(taskIntro);

    const existingLinearIssue = readLatestThreadArtifact<{
      id: string;
      identifier: string;
      title: string;
      url: string;
    }>(threadFolder, 'linear-issue.json');

    const linearIssue = existingLinearIssue || await createLinearTaskFromSlack(params);
    writeRunJson(runFolder, 'linear-issue.json', linearIssue || null);

    logObservation({
      kind: 'task_linear_ticket',
      channelId: params.channelId,
      slackTs: params.slackTs,
      projectId: params.project?.id,
      projectName: params.project?.name,
      linearIssueId: linearIssue?.id,
      route: params.classification.route,
    });

    if (existingLinearIssue) {
      await say(`I found the existing Linear ticket for this thread, so I’m reusing *${existingLinearIssue.identifier}*: ${existingLinearIssue.url}`);
    } else if (linearIssue) {
      await say(`I created Linear ticket *${linearIssue.identifier}* and attached the Slack context: ${linearIssue.url}`);
    } else {
      await say('I could not create the Linear ticket automatically, so I’m continuing without a ticket link for now.');
    }

    if (params.classification.route !== 'code_change_task') {
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
          ? `I logged this as ticket *${linearIssue.identifier}* in Linear: ${linearIssue.url}`
          : 'I classified this as a ticket-only task, but I could not create the Linear ticket automatically.',
      };
    }

    if (!config.taskExecutionEnabled) {
      return {
        finalReply: linearIssue
          ? `I captured this in *${linearIssue.identifier}*, but code execution is disabled right now, so I stopped before touching the repo: ${linearIssue.url}`
          : 'I captured the task, but code execution is disabled right now, so I stopped before touching the repo.',
      };
    }

    const preflight = await preflightTaskExecution(params.project);
    writeRunJson(runFolder, 'preflight.json', preflight);
    if (!preflight.ok) {
      logObservation({
        kind: 'task_run_blocked',
        channelId: params.channelId,
        slackTs: params.slackTs,
        projectId: params.project?.id,
        projectName: params.project?.name,
        linearIssueId: linearIssue?.id,
        reason: preflight.reason,
        stage: preflight.details?.stage,
      });
      return {
        finalReply: linearIssue
          ? `I created *${linearIssue.identifier}*, but I could not start execution: ${preflight.reason}`
          : `I classified the task, but I could not start execution: ${preflight.reason}`,
      };
    }

    await say(
      `I resolved the repo to \`${preflight.details.repoRoot}\` and Codex will branch from \`${preflight.details.baseBranch}\`.`
    );

    await say('I’m gathering the current task and repo context for Codex so it can continue from this thread cleanly.');
    let workSnapshotText = 'Work snapshot unavailable.';
    try {
      const workSnapshot = await withTimeout(getMyWorkSnapshot(params.project), 20_000, 'work snapshot');
      workSnapshotText = formatWorkSnapshot(workSnapshot);
    } catch (err: any) {
      logObservation({
        kind: 'task_context_warning',
        channelId: params.channelId,
        slackTs: params.slackTs,
        projectId: params.project?.id,
        projectName: params.project?.name,
        linearIssueId: linearIssue?.id,
        reason: err.message,
        stage: 'work_snapshot',
      });
      await say('I could not fetch the full work snapshot in time, so I’m continuing with the thread context and repo context only.');
    }
    writeRunArtifact(runFolder, 'work-snapshot.txt', workSnapshotText);

    const payload = createCodexPayload({
      runId,
      runFolder,
      taskThreadFolder: threadFolder,
      messageText: params.messageText,
      threadContext: params.threadContext,
      senderName: params.senderName,
      project: params.project,
      classification: params.classification,
      linearIssue,
      workSnapshotText,
      repoRoot: preflight.details.repoRoot,
      baseBranch: preflight.details.baseBranch,
    });

    await say(`I created the task run folder for this Slack thread at \`${threadFolder}\`.`);
    await say('Codex is taking over now: it will create the branch, implement the change, run checks, push the branch, and open the PR.');
    writeRunJson(runFolder, 'executor-invocation.json', {
      executor: config.taskExecutorCommand ? 'custom-command' : 'codex',
      command: config.taskExecutorCommand || config.codexCliPath,
      model: config.codexExecModel || null,
      repoRoot: preflight.details.repoRoot,
      baseBranch: preflight.details.baseBranch,
      suggestedBranch: payload.suggestedBranch,
    });

    const executorResult: ExecutorResult = config.taskExecutorCommand
      ? {
          ...(await runCommandLine(config.taskExecutorCommand, preflight.details.repoRoot, {
            timeoutMs: 60 * 60 * 1000,
          })),
          structured: null,
        }
      : await runCodexTask({
          workspacePath: preflight.details.repoRoot,
          runFolder,
          prompt: payload.prompt,
          schemaFile: payload.schemaFile,
        });

    writeRunArtifact(
      runFolder,
      'executor-output.log',
      [executorResult.stdout, executorResult.stderr].filter(Boolean).join('\n\n')
    );
    writeRunJson(runFolder, 'executor-result.json', {
      code: executorResult.code,
      structured: executorResult.structured || null,
    });

    if (executorResult.code !== 0 || !executorResult.structured) {
      logObservation({
        kind: 'task_execution_failed',
        channelId: params.channelId,
        slackTs: params.slackTs,
        projectId: params.project?.id,
        projectName: params.project?.name,
        linearIssueId: linearIssue?.id,
        output: trimOutput([executorResult.stdout, executorResult.stderr].filter(Boolean).join('\n')),
        stage: 'codex',
      });
      return {
        finalReply: formatExecutorFailure(linearIssue || null, threadFolder, executorResult),
      };
    }

    const codexStructured = executorResult.structured;
    writeRunJson(runFolder, 'codex-structured.json', codexStructured);

    await say(
      codexStructured.pr_url
        ? `Codex finished the implementation and opened PR ${codexStructured.pr_url}. I’m preparing the final summary now.`
        : 'Codex finished the implementation pass and returned the result. I’m preparing the final summary now.'
    );

    if ((codexStructured.blockers || []).length > 0 && codexStructured.changed_files.length === 0 && !codexStructured.pr_url) {
      logObservation({
        kind: 'task_run_blocked',
        channelId: params.channelId,
        slackTs: params.slackTs,
        projectId: params.project?.id,
        projectName: params.project?.name,
        linearIssueId: linearIssue?.id,
        reason: codexStructured.blockers.join(' | '),
        stage: 'codex',
      });
      return {
        finalReply: [
          linearIssue ? `I reused *${linearIssue.identifier}*, but Codex hit blockers before it could finish.` : 'Codex hit blockers before it could finish.',
          codexStructured.implementation_summary ? `Summary: ${codexStructured.implementation_summary}` : '',
          codexStructured.blockers.length > 0 ? `Blockers: ${codexStructured.blockers.join(' | ')}` : '',
          `Task run folder: \`${threadFolder}\``,
        ].filter(Boolean).join('\n'),
      };
    }

    if (codexStructured.changed_files.length === 0) {
      logObservation({
        kind: 'task_run_no_changes',
        channelId: params.channelId,
        slackTs: params.slackTs,
        projectId: params.project?.id,
        projectName: params.project?.name,
        linearIssueId: linearIssue?.id,
        branchName: codexStructured.branch_name,
      });
      return {
        finalReply: [
          linearIssue ? `I reused *${linearIssue.identifier}*, but Codex did not produce any code changes.` : 'Codex did not produce any code changes.',
          codexStructured.implementation_summary ? `Summary: ${codexStructured.implementation_summary}` : '',
          codexStructured.follow_up.length > 0 ? `Follow-up: ${codexStructured.follow_up.join(' | ')}` : '',
          `Task run folder: \`${threadFolder}\``,
        ].filter(Boolean).join('\n'),
      };
    }

    logObservation({
      kind: 'task_run_completed',
      channelId: params.channelId,
      slackTs: params.slackTs,
      projectId: params.project?.id,
      projectName: params.project?.name,
      linearIssueId: linearIssue?.id,
      branchName: codexStructured.branch_name,
      pullRequestUrl: codexStructured.pr_url,
      changedFiles: codexStructured.changed_files,
    });

    return {
      finalReply: formatSuccessReply({
        linearIssue: linearIssue || null,
        result: codexStructured,
        threadFolder,
      }),
    };
  } finally {
    finishActiveTask(runId);
  }
}
