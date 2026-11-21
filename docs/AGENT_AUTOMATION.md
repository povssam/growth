# Claude + Grok automation

This change is deliberately staged behind a PR. Nothing runs on the default branch until merged.

1. Configure `ANTHROPIC_API_KEY` and `XAI_API_KEY` as GitHub Actions repository secrets. Never commit keys.
2. Create the GitHub label `agent:claude`. Add it to an issue with a specific task and acceptance criteria, or comment `/claude implement` as repository owner.
3. Claude Code Action attempts implementation and a draft PR. The PR triggers frontend build, API typecheck and a Docker engine build.
4. Grok posts a read-only review as a PR comment if `XAI_API_KEY` is configured.
5. Request a ChatGPT review of the PR using the connected GitHub plugin. Automatic ChatGPT notifications and reviews require a separate supported webhook/event integration.
6. Human reviews the brief and decides whether to merge. No automatic production deployment from these workflows.

**Costs:** Claude and xAI API calls may be billed. Docker CI consumes GitHub Actions minutes and storage. No RunPod or GPU jobs are launched.

**Security:** The Grok workflow only runs on same-repository PRs; it sends a diff to xAI, so do not use it for private code unless that disclosure is approved. Disable this workflow if third-party review is not allowed. Model reviews are not a replacement for code review or CI.

**Current limits:** This starter does not implement autonomous Grok code repair, webhook-triggered ChatGPT review, or two-retry repair loops. Add those only after the first complete issue-to-PR cycle passes. The `grok-4` model identifier and Claude action configuration should be checked against the currently enabled API versions before enabling paid keys.
