# ChatGPT + Claude automation

This is a staged draft PR. Workflows become active only after merge.

1. Configure the GitHub Actions repository secret `ANTHROPIC_API_KEY`. Never commit credentials.
2. Create the GitHub label `agent:claude`.
3. ChatGPT creates scoped issues with acceptance criteria via the GitHub connector.
4. Labeling an issue `agent:claude` triggers Claude Code Action. Repository-owner comment `/claude implement` is another trigger.
5. Claude attempts implementation on a branch and opens a draft PR.
6. GitHub Actions validates web build, API typecheck and Docker engine build.
7. ChatGPT reviews PRs through the connected GitHub plugin and provides Merge / Request changes / Reject recommendations. A separate supported event or scheduled automation is required to trigger this without asking.
8. User approves merges. No automatic merge or GPU deployment.

**Costs:** Claude API calls may be billed, and GitHub Actions minutes/storage may be used. No Grok/xAI key or integration is needed.

**Limitations:** No automatic ChatGPT webhook integration or automatic repair loop is installed yet. Validate Claude Code Action compatibility and permissions before merging.
