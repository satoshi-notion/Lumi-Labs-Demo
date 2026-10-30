/**
 * GitHub worker: extends Notion's native GitHub Sync (PRs + issues) with
 * commits, releases, workflow runs, PR reviews, and agent tools that write
 * back to GitHub. Each synced row also gets a page body (pageContentMarkdown)
 * with the details that do not fit into properties.
 */
import { Worker } from "@notionhq/workers"
import * as Builder from "@notionhq/workers/builder"
import * as Schema from "@notionhq/workers/schema"
import { j } from "@notionhq/workers/schema-builder"
import { REPO, gh, ghPage } from "./github.js"
import { registerUseCases } from "./usecases.js"

const worker = new Worker()
export default worker

const githubApi = worker.pacer("githubApi", { allowedRequests: 10, intervalMs: 1000 })

registerUseCases(worker, githubApi)

/** Select options are fixed in the schema; values outside a list fall back to "Other". */
const PEOPLE = ["satoshi-notion", "satoshi0817", "jay23606", "Satoshi Suzuki"]
const EVENTS = ["push", "pull_request", "workflow_dispatch", "schedule"]
const opts = (names: string[]) => [...names, "Other"].map((name) => ({ name }))
const pick = (value: string | null | undefined, names: string[]) =>
	value && names.includes(value) ? value : "Other"

/** Bump when a schema or value format changes, so unchanged rows are rewritten once. */
const SCHEMA_REV = "2026-10-30T18:00:00.000Z"
const stamp = (d?: string) => (d && new Date(d) > new Date(SCHEMA_REV) ? d : SCHEMA_REV)

// -- Databases (managed; move them under the demo page after first deploy) --

const commits = worker.database("commits", {
  type: "managed",
  initialTitle: "Commits",
  primaryKeyProperty: "SHA",
  schema: {
    properties: {
      Message: Schema.title(),
      // Full SHA: must equal the sync key, otherwise every run creates duplicates.
      SHA: Schema.richText(),
      "Short SHA": Schema.richText(),
      Author: Schema.select(opts(PEOPLE)),
      Committed: Schema.date(),
      Description: Schema.richText(),
      "Files Changed": Schema.number(),
      Additions: Schema.number(),
      Deletions: Schema.number(),
      "Pull Request": Schema.richText(),
      URL: Schema.url(),
    },
  },
})

const releases = worker.database("releases", {
  type: "managed",
  initialTitle: "Releases",
  primaryKeyProperty: "Release ID",
  schema: {
    properties: {
      Name: Schema.title(),
      "Release ID": Schema.richText(),
      Tag: Schema.richText(),
      Published: Schema.date(),
      Prerelease: Schema.checkbox(),
      Author: Schema.select(opts(PEOPLE)),
      Notes: Schema.richText(),
      URL: Schema.url(),
    },
  },
})

const runs = worker.database("runs", {
  type: "managed",
  initialTitle: "Workflow Runs",
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
      Event: Schema.select(opts(EVENTS)),
      Actor: Schema.select(opts(PEOPLE)),
      Commit: Schema.richText(),
      "Commit Record": Schema.relation("commits", { twoWay: true, relatedPropertyName: "Workflow Runs" }),
      "Failed Step": Schema.richText(),
      Started: Schema.date(),
      URL: Schema.url(),
    },
  },
})

const reviews = worker.database("reviews", {
  type: "managed",
  initialTitle: "PR Reviews",
  primaryKeyProperty: "Review ID",
  schema: {
    properties: {
      Review: Schema.title(),
      "Review ID": Schema.richText(),
      "PR Number": Schema.number(),
      "PR Title": Schema.richText(),
      Reviewer: Schema.select(opts(PEOPLE)),
      State: Schema.select([
        { name: "APPROVED", color: "green" },
        { name: "CHANGES_REQUESTED", color: "red" },
        { name: "COMMENTED", color: "gray" },
      ]),
      Comment: Schema.richText(),
      "Inline Comments": Schema.number(),
      Submitted: Schema.date(),
      URL: Schema.url(),
    },
  },
})

// -- Helpers --

const clip = (s: string | null | undefined, n = 1900) => (s ?? "").slice(0, n)

/** "Title\n\nBody" -> body text (without the subject line). */
const commitBody = (message: string) => message.split("\n").slice(1).join("\n").trim()

// -- Syncs: 5m deltas + daily full replace so the first import is automatic --

type Mode = "replace" | "incremental"
const SCHEDULES: Array<[Mode, "5m" | "1d"]> = [
  ["incremental", "5m"],
  ["replace", "1d"],
]

type Change = {
  key: string
  properties: Record<string, any>
  pageContentMarkdown?: string
  upstreamUpdatedAt?: string
}

function defineSync<T>(
  name: string,
  database: ReturnType<typeof worker.database>,
  fetchPage: (page: number) => Promise<{ items: T[]; hasMore: boolean }>,
  toChange: (item: T) => Promise<Change | null> | Change | null,
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
        const changes = []
        for (const item of items) {
          const c = await toChange(item)
          if (c) changes.push({ type: "upsert" as const, ...c, upstreamUpdatedAt: stamp(c.upstreamUpdatedAt) })
        }
        return { changes, hasMore, nextState: hasMore ? { page: page + 1 } : undefined }
      },
    })
  }
}

// Commits: the list endpoint has no diff info, so fetch each commit's detail.
defineSync<any>(
  "commits",
  commits,
  (page) => ghPage("/commits", page),
  async (summary) => {
    await githubApi.wait()
    const c = await gh<any>(`/commits/${summary.sha}`)
    // PRs that contain this commit (squash merges link back to the PR).
    await githubApi.wait()
    const prs = await gh<any[]>(`/commits/${c.sha}/pulls`).catch(() => [])
    const files: any[] = c.files ?? []
    const body = commitBody(c.commit.message)
    const md = [
      `## ${String(c.commit.message).split("\n")[0]}`,
      body && `\n${body}`,
      `\n**Author:** ${c.commit.author?.name ?? "unknown"} (${c.author?.login ?? "n/a"})`,
      `**Commit:** [\`${c.sha.slice(0, 7)}\`](${c.html_url})`,
      prs.length ? `**Pull request:** ${prs.map((p) => `[#${p.number} ${p.title}](${p.html_url})`).join(", ")}` : "",
      `\n### Changes (+${c.stats?.additions ?? 0} / -${c.stats?.deletions ?? 0} in ${files.length} files)`,
      "",
      "| File | Status | + | - |",
      "| --- | --- | --- | --- |",
      ...files.slice(0, 50).map((f) => `| \`${f.filename}\` | ${f.status} | ${f.additions} | ${f.deletions} |`),
    ]
      .join("\n")
    return {
      key: c.sha,
      upstreamUpdatedAt: c.commit.author?.date,
      properties: {
        Message: Builder.title(String(c.commit.message).split("\n")[0]),
        SHA: Builder.richText(c.sha),
        "Short SHA": Builder.richText(c.sha.slice(0, 7)),
        Author: Builder.select(pick(c.commit.author?.name ?? c.author?.login, PEOPLE)),
        Committed: Builder.dateTime(c.commit.author.date),
        Description: Builder.richText(clip(body)),
        "Files Changed": Builder.number(files.length),
        Additions: Builder.number(c.stats?.additions ?? 0),
        Deletions: Builder.number(c.stats?.deletions ?? 0),
        "Pull Request": Builder.richText(prs.map((p) => `#${p.number}`).join(", ")),
        URL: Builder.url(c.html_url),
      },
      pageContentMarkdown: md,
    }
  },
)

// Releases: release notes become the page body.
defineSync<any>(
  "releases",
  releases,
  (page) => ghPage("/releases", page),
  (r) => ({
    key: String(r.id),
    upstreamUpdatedAt: r.published_at ?? r.created_at,
    properties: {
      Name: Builder.title(r.name || r.tag_name),
      "Release ID": Builder.richText(String(r.id)),
      Tag: Builder.richText(r.tag_name),
      Published: Builder.dateTime(r.published_at ?? r.created_at),
      Prerelease: Builder.checkbox(Boolean(r.prerelease)),
      Author: Builder.select(pick(r.author?.login, PEOPLE)),
      Notes: Builder.richText(clip(r.body)),
      URL: Builder.url(r.html_url),
    },
    pageContentMarkdown: [
      `## ${r.name || r.tag_name}${r.prerelease ? " (pre-release)" : ""}`,
      `\n**Tag:** \`${r.tag_name}\` · **Target:** \`${r.target_commitish}\` · [View on GitHub](${r.html_url})`,
      `\n${r.body || "_No release notes._"}`,
    ].join("\n"),
  }),
)

// Workflow runs: jobs and steps (with the failing step called out).
defineSync<any>(
  "runs",
  runs,
  (page) => ghPage("/actions/runs", page, "workflow_runs"),
  async (r) => {
    await githubApi.wait()
    const { jobs } = await gh<any>(`/actions/runs/${r.id}/jobs`).catch(() => ({ jobs: [] }))
    const failed = jobs
      .flatMap((job: any) =>
        (job.steps ?? []).filter((s: any) => s.conclusion === "failure").map((s: any) => `${job.name} › ${s.name}`),
      )
      .join(", ")
    // Relate to the Commits database only for commits that exist on main
    // (PR branch commits are not synced there).
    const onMain = await gh<any>(`/compare/main...${r.head_sha}`)
      .then((c) => c.status === "behind" || c.status === "identical")
      .catch(() => false)
    const icon = (c: string | null) =>
      c === "success" ? "✅" : c === "failure" ? "❌" : c === "skipped" ? "⏭️" : c === "cancelled" ? "🚫" : "⏳"
    const md = [
      `## ${r.name} #${r.run_number}`,
      `\n${icon(r.conclusion)} **${r.conclusion ?? r.status}** · event \`${r.event}\` · branch \`${r.head_branch}\``,
      `\n**Commit:** \`${r.head_sha.slice(0, 7)}\` ${String(r.head_commit?.message ?? "").split("\n")[0]}`,
      `**Triggered by:** ${r.triggering_actor?.login ?? r.actor?.login ?? "unknown"} · [View run](${r.html_url})`,
      failed ? `\n> ❌ **Failed step:** ${failed}` : "",
      "\n### Jobs",
      ...jobs.flatMap((job: any) => [
        `\n**${icon(job.conclusion)} ${job.name}**`,
        ...(job.steps ?? []).map((s: any) => `- ${icon(s.conclusion)} ${s.name}`),
      ]),
    ].join("\n")
    return {
      key: String(r.id),
      upstreamUpdatedAt: r.updated_at,
      properties: {
        Run: Builder.title(`${r.name} #${r.run_number}: ${r.display_title}`),
        "Run ID": Builder.richText(String(r.id)),
        Status: Builder.select(r.status),
        ...(r.conclusion ? { Conclusion: Builder.select(r.conclusion) } : {}),
        Branch: Builder.richText(r.head_branch ?? ""),
        Event: Builder.select(pick(r.event, EVENTS)),
        Actor: Builder.select(pick(r.triggering_actor?.login ?? r.actor?.login, PEOPLE)),
        Commit: Builder.richText(r.head_sha.slice(0, 7)),
        ...(onMain ? { "Commit Record": [Builder.relation(r.head_sha)] } : {}),
        "Failed Step": Builder.richText(failed),
        Started: Builder.dateTime(r.run_started_at ?? r.created_at),
        URL: Builder.url(r.html_url),
      },
      pageContentMarkdown: md,
    }
  },
)

// Reviews per PR: walk all PRs and flatten their reviews into one page,
// including the review body and inline (line-level) comments.
defineSync<any>(
  "reviews",
  reviews,
  async (page) => {
    const prs = await ghPage<any>("/pulls?state=all", page)
    const items: any[] = []
    for (const pr of prs.items) {
      await githubApi.wait()
      const list = await gh<any[]>(`/pulls/${pr.number}/reviews`)
      for (const r of list) {
        if (!r.submitted_at) continue
        await githubApi.wait()
        const inline = await gh<any[]>(`/pulls/${pr.number}/reviews/${r.id}/comments`).catch(() => [])
        items.push({ ...r, pr, inline })
      }
    }
    return { items, hasMore: prs.hasMore }
  },
  (r) => ({
    key: String(r.id),
    upstreamUpdatedAt: r.submitted_at,
    properties: {
      Review: Builder.title(`PR #${r.pr.number} ${r.state} by ${r.user.login}`),
      "Review ID": Builder.richText(String(r.id)),
      "PR Number": Builder.number(r.pr.number),
      "PR Title": Builder.richText(r.pr.title),
      Reviewer: Builder.select(pick(r.user.login, PEOPLE)),
      State: Builder.select(r.state),
      Comment: Builder.richText(clip(r.body)),
      "Inline Comments": Builder.number(r.inline.length),
      Submitted: Builder.dateTime(r.submitted_at),
      URL: Builder.url(r.html_url),
    },
    pageContentMarkdown: [
      `## ${r.state} on [PR #${r.pr.number}: ${r.pr.title}](${r.pr.html_url})`,
      `\n**Reviewer:** ${r.user.login} · [View review](${r.html_url})`,
      `\n${r.body ? r.body : "_No review summary._"}`,
      r.inline.length ? "\n### Inline comments" : "",
      ...r.inline.map(
        (c: any) =>
          `\n**\`${c.path}${c.line ? `:${c.line}` : ""}\`**\n\n> ${String(c.body).split("\n").join("\n> ")}\n\n\`\`\`diff\n${clip(c.diff_hunk, 600)}\n\`\`\``,
      ),
    ].join("\n"),
  }),
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
