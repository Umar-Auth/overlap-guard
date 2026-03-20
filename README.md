# overlap-guard

Slack-based delegate backend for Umar.

## What It Does

- replies on Umar's behalf in Slack when he is unavailable
- classifies mentions into queries or tasks
- answers "what is Umar working on?" from Umar's own Linear and GitHub context
- creates Linear tasks for work requests
- can prepare an isolated git worktree, run an external coding worker, commit, push, and open a PR
- logs observations and can refresh `memory/ROLE.md`, `memory/SKILL.md`, and `memory/SOUL.md`

## Core Runtime Flow

```mermaid
flowchart LR
  A["Slack Mention"] --> B["Availability Gate"]
  B --> C["Thread Context + Project Resolve"]
  C --> D["Classifier"]
  D -->|Query| E["Umar Work Context + Brain Reply"]
  D -->|Task| F["Linear Ticket + Task Runner"]
  F --> G["Worktree + Executor + Checks + PR"]
  E --> H["Reply As Umar"]
  G --> H
```

## Environment

Required:
- `SLACK_SIGNING_SECRET`
- `SLACK_BOT_TOKEN`
- `SLACK_USER_TOKEN`
- `SLACK_MY_USER_ID`
- `SLACK_TEAM_ID`
- `OPENAI_API_KEY`
- `GITHUB_TOKEN`
- `LINEAR_API_KEY`

Optional but important for production:
- `AUTO_CREATE_LINEAR_TASKS=true`
- `TASK_EXECUTOR_COMMAND=...`
- `PROJECT_SEARCH_ROOTS=/Users/umar_cpp/Documents/GitHub`
- `TASK_EXECUTION_ENABLED=true`
- `TASK_COMMIT_ENABLED=true`
- `TASK_PUSH_ENABLED=true`
- `TASK_CREATE_PR_ENABLED=true`
- `SLACK_DEBUG_AUTO_REPLY=true`
- `SLACK_ALLOW_SELF_TEST=true`
- `GOOGLE_AI_API_KEY=...`
- `GOOGLE_IMAGE_MODEL=gemini-3.1-flash-image-preview`

## Project Registry

Configure repos in [projects/registry.json](/Users/umar_cpp/Documents/GitHub/overlap-guard/projects/registry.json).

Recommended fields per project:
- `repoOwner`
- `repoName`
- `localPath`
- `linearTeamId`
- `linearProjectId`
- `baseBranch`
- `testCommand`

## Scripts

- `npm start`
- `npm run typecheck`
- `npm run refresh-memory`
