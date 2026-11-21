# ChatGPT + Claude Code on the web

No Anthropic API key, Grok, Claude GitHub Action, or local CLI is required for the intended workflow.

## Working pieces
1. ChatGPT prepares GitHub Issues with scope, acceptance criteria and tests through the connected GitHub plugin.
2. Claude Code on the web (https://claude.ai/code) uses its connected GitHub repository to implement the task, push a branch and open a PR.
3. GitHub Actions validates PRs: frontend build, API typecheck and Docker engine build.
4. ChatGPT's Growth PR review automation checks GitHub hourly for new/updated Claude PRs, reads diffs and CI status, and sends a decision brief when something meaningful changes.
5. The user decides whether to merge. No auto-merge, GPU activation or production deployment.

## Claude Code web auto-fix (official feature)
Claude Code web can watch a PR and react to failed CI checks and review comments. The Claude GitHub App must be installed on this repository. In claude.ai/code, open the cloud session's Changes card, use the PR menu and enable **Auto-fix**. In the Claude mobile app, ask Claude to auto-fix the PR. For an existing PR, paste its URL into a Claude cloud session and request auto-fix.

Auto-fix is per PR, not a repository-wide toggle installed by this PR. It handles clear fixes and asks for clarification on ambiguous changes. Reference: https://code.claude.com/docs/en/claude-code-on-the-web

## Remaining Claude-side trigger
GitHub Issues alone do not automatically start Claude Code web sessions. To eliminate manual launch, configure an official Claude cloud scheduled/triggered task inside Claude Code, with GitHub access, to periodically check the issue queue and implement tasks. This is an Anthropic account-side setting, not something a GitHub workflow can turn on. Do not pretend it is configured without verifying the task in Claude.

Suggested Claude cloud task instruction:

> In povssam/growth, check open GitHub Issues labeled agent:claude that have no linked implementation PR. Choose one issue at a time, read AGENTS.md, implement on a new branch, run relevant tests, and open a draft PR linking the issue. Enable Auto-fix on your PR when supported. Do not merge, deploy, modify secrets, spend GPU budget, or alter other projects. If no eligible issue exists, stop.

## Safety and limits
- Claude web usage counts against the user's Claude plan; GitHub Actions minutes/storage may also apply.
- Never put tokens in issues or PRs.
- ChatGPT's monitoring cadence is hourly, not instantaneous.
- No API-based coding agent or external model review service is installed.
