# gh-demo-worker

A [Notion Worker](https://developers.notion.com/workers/get-started/overview) that
extends Notion's native GitHub Sync (pull requests and issues) with:

| Capability | Key | What it does |
| --- | --- | --- |
| Sync | `commits*` | Commit history |
| Sync | `releases*` | GitHub releases |
| Sync | `runs*` | GitHub Actions workflow runs and conclusions |
| Sync | `reviews*` | Pull request reviews (approved / changes requested) |
| Tool | `createGithubIssue` | Create a GitHub issue from Notion (Notion → GitHub) |
| Tool | `getPullRequestStatus` | Reviews and CI checks for a PR |

Each sync has a `*Delta` (every 5 minutes) and a `*Full` (daily replace, which
also performs the initial import).

## Deploy

```bash
cd workers
ntn workers deploy --name gh-demo-worker
ntn workers env set GITHUB_TOKEN=<token> GITHUB_REPO=satoshi-notion/Lumi-Labs-Demo
ntn workers sync trigger commitsFull   # optional: don't wait for the daily run
```
