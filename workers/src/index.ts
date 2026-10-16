/**
 * gh-demo-worker: extends Notion's native GitHub Sync (PRs + issues) with
 * commits, releases, workflow runs, PR reviews, and agent tools that write
 * back to GitHub.
 */
import { Worker } from "@notionhq/workers"
import * as Builder from "@notionhq/workers/builder"
import * as Schema from "@notionhq/workers/schema"
import { j } from "@notionhq/workers/schema-builder"
import { REPO, gh, ghPage } from "./github.js"

const worker = new Worker()
export default worker

const githubApi = worker.pacer("githubApi", { allowedRequests: 10, intervalMs: 1000 })

// -- Databases (managed; move them under the demo page after first deploy) --

const commits = worker.database("commits", {
  type: "managed",
  initialTitle: "gh-demo Commits",
  primaryKeyProperty: "SHA",
  schema: {
    properties: {
      Message: Schema.title(),
      SHA: Schema.richText(),
      Author: Schema.richText(),
      Committed: Schema.date(),
      URL: Schema.url(),
    },
  },
})

const releases = worker.database("releases", {
  type: "managed",
  initialTitle: "gh-demo Releases",
  primaryKeyProperty: "Release ID",
  schema: {
    properties: {
      Name: Schema.title(),
      "Release ID": Schema.richText(),
      Tag: Schema.richText(),
      Published: Schema.date(),
      Prerelease: Schema.checkbox(),
      Notes: Schema.richText(),
      URL: Schema.url(),
    },
  },
})

const runs = worker.database("runs", {
  type: "managed",
  initialTitle: "gh-demo Workflow Runs",
  primaryKeyProperty: "Run ID",
  schema: {
    properties: {
      Run: Schema.title(),
      "Run ID": Schema.richText(),
      Status: Schema.select([
        { name: "queued", color: "gray" },
        { name: "in_progress", color: "yellow" },
        { name: "completed", color: "blue" },
      ]),
      Conclusion: Schema.select([
        { name: "success", color: "green" },
        { name: "failure", color: "red" },
        { name: "cancelled", color: "gray" },
        { name: "skipped", color: "gray" },
      ]),
      Branch: Schema.richText(),
      Event: Schema.richText(),
      Started: Schema.date(),
      URL: Schema.url(),
    },
  },
})

const reviews = worker.database("reviews", {
  type: "managed",
  initialTitle: "gh-demo PR Reviews",
  primaryKeyProperty: "Review ID",
  schema: {
    properties: {
      Review: Schema.title(),
      "Review ID": Schema.richText(),
      "PR Number": Schema.number(),
      Reviewer: Schema.richText(),
      State: Schema.select([
        { name: "APPROVED", color: "green" },
        { name: "CHANGES_REQUESTED", color: "red" },
        { name: "COMMENTED", color: "gray" },
      ]),
      Submitted: Schema.date(),
      URL: Schema.url(),
    },
  },
})

// -- Syncs: 5m deltas with a daily full replace so first import is automatic --

type Mode = "replace" | "incremental"
const SCHEDULES: Array<[Mode, "5m" | "1d"]> = [
  ["incremental", "5m"],
  ["replace", "1d"],
]

function defineSync<T>(
  name: string,
  database: ReturnType<typeof worker.database>,
  fetchPage: (page: number) => Promise<{ items: T[]; hasMore: boolean }>,
  toChange: (item: T) => { key: string; properties: Record<string, any> } | null,
) {
  for (const [mode, schedule] of SCHEDULES) {
    worker.sync(`${name}${mode === "replace" ? "Full" : "Delta"}`, {
      database,
      mode,
      schedule,
      execute: async (state: { page?: number } | undefined) => {
        const page = state?.page ?? 1
        await githubApi.wait()
        const { items, hasMore } = await fetchPage(page)
        const changes = items.flatMap((item) => {
          const c = toChange(item)
          return c ? [{ type: "upsert" as const, ...c }] : []
        })
        return { changes, hasMore, nextState: hasMore ? { page: page + 1 } : undefined }
      },
    })
  }
}

defineSync<any>(
  "commits",
  commits,
  (page) => ghPage("/commits", page),
  (c) => ({
    key: c.sha,
    properties: {
      Message: Builder.title(String(c.commit.message).split("\n")[0]),
      SHA: Builder.richText(c.sha.slice(0, 7)),
      Author: Builder.richText(c.commit.author?.name ?? c.author?.login ?? "unknown"),
      Committed: Builder.dateTime(c.commit.author.date),
      URL: Builder.url(c.html_url),
    },
  }),
)

defineSync<any>(
  "releases",
  releases,
  (page) => ghPage("/releases", page),
  (r) => ({
    key: String(r.id),
    properties: {
      Name: Builder.title(r.name || r.tag_name),
      "Release ID": Builder.richText(String(r.id)),
      Tag: Builder.richText(r.tag_name),
      Published: Builder.dateTime(r.published_at ?? r.created_at),
      Prerelease: Builder.checkbox(Boolean(r.prerelease)),
      Notes: Builder.richText((r.body ?? "").slice(0, 1900)),
      URL: Builder.url(r.html_url),
    },
  }),
)

defineSync<any>(
  "runs",
  runs,
  (page) => ghPage("/actions/runs", page, "workflow_runs"),
  (r) => ({
    key: String(r.id),
    properties: {
      Run: Builder.title(`${r.name} #${r.run_number}: ${r.display_title}`),
      "Run ID": Builder.richText(String(r.id)),
      Status: Builder.select(r.status),
      ...(r.conclusion ? { Conclusion: Builder.select(r.conclusion) } : {}),
      Branch: Builder.richText(r.head_branch ?? ""),
      Event: Builder.richText(r.event),
      Started: Builder.dateTime(r.run_started_at ?? r.created_at),
      URL: Builder.url(r.html_url),
    },
  }),
)

// Reviews are per PR, so walk all PRs and flatten their reviews into one page.
defineSync<any>(
  "reviews",
  reviews,
  async (page) => {
    const prs = await ghPage<any>("/pulls?state=all", page)
    const items: any[] = []
    for (const pr of prs.items) {
      await githubApi.wait()
      const list = await gh<any[]>(`/pulls/${pr.number}/reviews`)
      items.push(...list.map((r) => ({ ...r, pr })))
    }
    return { items, hasMore: prs.hasMore }
  },
  (r) =>
    r.submitted_at
      ? {
          key: String(r.id),
          properties: {
            Review: Builder.title(`PR #${r.pr.number} ${r.state} by ${r.user.login}`),
            "Review ID": Builder.richText(String(r.id)),
            "PR Number": Builder.number(r.pr.number),
            Reviewer: Builder.richText(r.user.login),
            State: Builder.select(r.state),
            Submitted: Builder.dateTime(r.submitted_at),
            URL: Builder.url(r.html_url),
          },
        }
      : null,
)

// -- Agent tools: Notion -> GitHub (the native sync is one-way) --

worker.tool("createGithubIssue", {
  title: "Create GitHub issue",
  description: `Create an issue in ${REPO}. Use when a spec, bug report, or task in Notion should become a GitHub issue. Returns the issue number and URL.`,
  schema: j.object({
    title: j.string().describe("Issue title."),
    body: j.string().describe("Issue body in Markdown.").nullable(),
    labels: j.array(j.string()).describe("Labels such as bug or enhancement.").nullable(),
  }),
  execute: async ({ title, body, labels }) => {
    const issue = await gh<any>("/issues", {
      method: "POST",
      body: { title, body: body ?? "", labels: labels ?? [] },
    })
    return { number: issue.number, url: issue.html_url }
  },
})

worker.tool("getPullRequestStatus", {
  title: "Get pull request status",
  description: `Get the state, reviews, and CI check results of a pull request in ${REPO}.`,
  schema: j.object({
    number: j.number().describe("Pull request number."),
  }),
  execute: async ({ number }) => {
    const pr = await gh<any>(`/pulls/${number}`)
    const reviewList = await gh<any[]>(`/pulls/${number}/reviews`)
    const checks = await gh<any>(`/commits/${pr.head.sha}/check-runs`)
    return {
      title: pr.title,
      state: pr.merged ? "merged" : pr.draft ? "draft" : pr.state,
      url: pr.html_url,
      reviews: reviewList.map((r) => `${r.user.login}: ${r.state}`),
      checks: checks.check_runs.map((c: any) => `${c.name}: ${c.conclusion ?? c.status}`),
    }
  },
})
