# jira-demo-worker

A [Notion Worker](https://developers.notion.com/workers/get-started/overview) that extends Notion's built-in Jira sync (work items and spaces) with:

| Capability | Key | What it does |
| --- | --- | --- |
| Sync | `comments*` | Comments, with the text as the page body |
| Sync | `statusHistory*` | Every status transition (from, to, who, when) |
| Sync | `sprints*` | Sprints of every board |
| Sync | `versions*` | Fix versions of every space |
| Sync | `worklogs*` | Time-tracking entries |
| Tool | `searchJiraIssues` | Live JQL search |
| Tool | `createJiraIssue` | Create a work item from Notion (Notion → Jira) |
| Tool | `transitionJiraIssue` | Move a work item to another status |
| Tool | `addJiraComment` | Post a comment on a work item |

Each sync has `*Delta` (every 5 minutes, recently updated work items) and `*Full` (daily replace, also performs the initial import).

## Deploy

```bash
cd jira-worker
ntn workers deploy --name jira-demo-worker
ntn workers env set JIRA_BASE_URL=https://<site>.atlassian.net JIRA_EMAIL=<email>
ntn workers env set JIRA_API_TOKEN=<token>   # https://id.atlassian.com/manage-profile/security/api-tokens
```

On the first deploy, register only the `*Full` syncs and add `*Delta` afterwards; running both at once on an empty database can duplicate page bodies.
