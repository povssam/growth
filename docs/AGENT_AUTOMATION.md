# ChatGPT + Claude Code on the web

This repository uses **Claude Code in the browser**, not the Anthropic API or the Claude Code GitHub Action.

## Workflow
1. ChatGPT writes a scoped GitHub Issue using the connected GitHub plugin.
2. Open Claude Code on the web and start a task using the GitHub repository and Issue link, or use an official Claude GitHub task handoff if it is enabled on the account.
3. Claude Code works in its own cloud environment and opens a draft pull request.
4. GitHub Actions validates the PR with web build, API typecheck and Docker engine image build.
5. ChatGPT reviews the PR via the connected GitHub plugin and gives a brief with Merge / Request changes / Reject options.
6. User approves any merge. No automatic production deployment or paid GPU jobs.

## Important limits
- No `ANTHROPIC_API_KEY`, `XAI_API_KEY`, or model API setup is needed for this repo.
- A GitHub Issue label does **not** by itself launch Claude Code on the web. This requires an officially supported Claude web task trigger or an explicit user launch. Do not install an API-based workflow as a substitute.
- GitHub Actions can run on PR events; automatic ChatGPT review requires a separately supported event/scheduled integration.
- Claude web plan usage and GitHub Actions limits still apply.
- No Grok integration, auto-merge or automatic repair loop is installed.
