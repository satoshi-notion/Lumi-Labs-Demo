/**
 * jira-demo-worker: extends Notion's built-in Jira sync (work items + spaces)
 * with comments, status history, sprints, versions and worklogs, and gives
 * Custom Agents tools that read and write Jira. Each synced row also gets a
 * page body (pageContentMarkdown) with the details that do not fit properties.
 */
import { Worker } from "@notionhq/workers"
import * as Builder from "@notionhq/workers/builder"
import * as Schema from "@notionhq/workers/schema"
import { j } from "@notionhq/workers/schema-builder"
import { registerUseCases } from "./usecases.js"
import { BASE_URL, adfToText, customFieldIds, jira, searchIssues, storyPoints, textToAdf } from "./jira.js"

const worker = new Worker()
export default worker

// Jira Cloud allows bursts; stay well below it.
const jiraApi = worker.pacer("jiraApi", { allowedRequests: 10, intervalMs: 1000 })

const browse = (key: string) => `${BASE_URL}/browse/${key}`
/** Select options are fixed in the schema; values outside a list fall back to "Other". */
const STATUSES = ["To Do", "未着手", "進行中", "品質保証", "完了", "Stuck", "In Progress", "Done", "Unknown"]
const TYPES = ["エピック", "ストーリー", "タスク", "バグ", "ワークストリーム", "Subtask", "Epic", "Story", "Task", "Bug"]
const PRIORITIES = ["Highest", "High", "Medium", "Low", "Lowest", "None"]
const LINK_TYPES = ["Blocks", "Relates", "Duplicate", "Clones"]
const PEOPLE = ["Melanie Harrington", "Marta Giambrone", "Antoine Richert", "Bret Scofield", "Edward Leblanc", "Sales demo", "Renee Ward", "Holly Turay", "Satoshi Suzuki", "Oriana Munoz", "Joseph Roberts", "Alice Antonelli", "Ana Haubold", "Stephanie Lee", "Sandra Lukac", "austen", "Juan Gomez", "Emily Zhang", "Sales Demo - Microsoft", "Unassigned"]
const opts = (names: string[]) => [...names, "Other"].map((name) => ({ name }))
const pick = (value: string | null | undefined, names: string[]) =>
	value && names.includes(value) ? value : "Other"

const clip = (s: string | null | undefined, n = 1900) => (s ?? "").slice(0, n)

/** Bump when a schema or value format changes, so unchanged rows are rewritten once. */
const SCHEMA_REV = "2026-10-30T18:00:00.000Z"
const stamp = (d?: string) => (d && new Date(d) > new Date(SCHEMA_REV) ? d : SCHEMA_REV)

// -- Databases (managed; move them under the demo page after first deploy) --

const comments = worker.database("comments", {
  type: "managed",
  initialTitle: "jira-demo Comments",
  primaryKeyProperty: "Comment ID",
  schema: {
    properties: {
      Comment: Schema.title(),
      "Comment ID": Schema.richText(),
      "Work Item": Schema.richText(),
      "Work Item Summary": Schema.richText(),
      Author: Schema.select(opts(PEOPLE)),
      Task: Schema.relation("taskPoints", { twoWay: true, relatedPropertyName: "Comments" }),
      Created: Schema.date(),
      Updated: Schema.date(),
      URL: Schema.url(),
    },
  },
})

const statusHistory = worker.database("statusHistory", {
  type: "managed",
  initialTitle: "jira-demo Status History",
  primaryKeyProperty: "Change ID",
  schema: {
    properties: {
      Change: Schema.title(),
      "Change ID": Schema.richText(),
      "Work Item": Schema.richText(),
      "Work Item Summary": Schema.richText(),
      From: Schema.select(opts(STATUSES)),
      To: Schema.select(opts(STATUSES)),
      "Changed By": Schema.select(opts(PEOPLE)),
      Task: Schema.relation("taskPoints", { twoWay: true, relatedPropertyName: "Status History" }),
      Changed: Schema.date(),
      URL: Schema.url(),
    },
  },
})

const sprints = worker.database("sprints", {
  type: "managed",
  initialTitle: "jira-demo Sprints",
  primaryKeyProperty: "Sprint ID",
  schema: {
    properties: {
      Sprint: Schema.title(),
      "Sprint ID": Schema.richText(),
      State: Schema.select([
        { name: "future", color: "gray" },
        { name: "active", color: "green" },
        { name: "closed", color: "blue" },
      ]),
      Board: Schema.richText(),
      Goal: Schema.richText(),
      Start: Schema.date(),
      End: Schema.date(),
    },
  },
})

const versions = worker.database("versions", {
  type: "managed",
  initialTitle: "jira-demo Versions",
  primaryKeyProperty: "Version ID",
  schema: {
    properties: {
      Version: Schema.title(),
      "Version ID": Schema.richText(),
      Project: Schema.richText(),
      Released: Schema.checkbox(),
      Archived: Schema.checkbox(),
      "Release Date": Schema.date(),
      Description: Schema.richText(),
    },
  },
})

const worklogs = worker.database("worklogs", {
  type: "managed",
  initialTitle: "jira-demo Worklogs",
  primaryKeyProperty: "Worklog ID",
  schema: {
    properties: {
      Worklog: Schema.title(),
      "Worklog ID": Schema.richText(),
      "Work Item": Schema.richText(),
      "Work Item Summary": Schema.richText(),
      Author: Schema.select(opts(PEOPLE)),
      Task: Schema.relation("taskPoints", { twoWay: true, relatedPropertyName: "Worklogs" }),
      "Time Spent": Schema.richText(),
      Hours: Schema.number(),
      Started: Schema.date(),
      URL: Schema.url(),
    },
  },
})


// Project Points: per-space rollup of story points. Task Points: one row per work item.
const projectPoints = worker.database("projectPoints", {
  type: "managed",
  initialTitle: "jira-demo Project Points",
  primaryKeyProperty: "Project Key",
  schema: {
    properties: {
      Project: Schema.title(),
      "Project Key": Schema.richText(),
      "Total Points": Schema.number(),
      "Done Points": Schema.number(),
      "In Progress Points": Schema.number(),
      "To Do Points": Schema.number(),
      "Done %": Schema.number(),
      "Work Items": Schema.number(),
      "Unestimated Items": Schema.number(),
      URL: Schema.url(),
    },
  },
})

const taskPoints = worker.database("taskPoints", {
  type: "managed",
  initialTitle: "jira-demo Task Points",
  primaryKeyProperty: "Work Item",
  schema: {
    properties: {
      Task: Schema.title(),
      "Work Item": Schema.richText(),
      "Story Points": Schema.number(),
      Estimated: Schema.checkbox(),
      Status: Schema.select(opts(STATUSES)),
      "Status Category": Schema.select([
        { name: "To Do", color: "gray" },
        { name: "In Progress", color: "blue" },
        { name: "Done", color: "green" },
      ]),
      Type: Schema.select(opts(TYPES)),
      Assignee: Schema.select(opts(PEOPLE)),
      Sprint: Schema.richText(),
      Parent: Schema.richText(),
      "Original Estimate (h)": Schema.number(),
      "Time Spent (h)": Schema.number(),
      Updated: Schema.date(),
      URL: Schema.url(),
      "Project Record": Schema.relation("projectPoints", { twoWay: true, relatedPropertyName: "Tasks" }),
    },
  },
})

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
type State = { token?: string } | undefined

function defineSync<T>(
  name: string,
  database: ReturnType<typeof worker.database>,
  fetchPage: (mode: Mode, token?: string) => Promise<{ items: T[]; nextToken?: string }>,
  toChanges: (item: T) => Change[],
  schedules = SCHEDULES,
) {
  for (const [mode, schedule] of schedules) {
    worker.sync(`${name}${mode === "replace" ? "Full" : "Delta"}`, {
      database,
      mode,
      schedule,
      execute: async (state: State) => {
        const { items, nextToken } = await fetchPage(mode, state?.token)
        const changes = items.flatMap(toChanges).map((c) => ({ type: "upsert" as const, ...c, upstreamUpdatedAt: stamp(c.upstreamUpdatedAt) }))
        return {
          changes,
          hasMore: Boolean(nextToken),
          nextState: nextToken ? { token: nextToken } : undefined,
        }
      },
    })
  }
}

/** Issues to walk: everything on Full, only recently updated on Delta. */
const issueJql = (mode: Mode) =>
  mode === "replace"
    ? 'created >= "1970-01-01" ORDER BY created ASC'
    : "updated >= -1d ORDER BY updated ASC"

/** Fetch a page of issues, then a per-issue child resource for each. */
function perIssue<C>(load: (issueKey: string) => Promise<C[]>) {
  return async (mode: Mode, token?: string) => {
    await jiraApi.wait()
    const { issues, nextPageToken } = await searchIssues(issueJql(mode), token)
    const items: Array<C & { issue: { key: string; summary: string } }> = []
    for (const issue of issues) {
      await jiraApi.wait()
      const children = await load(issue.key)
      for (const c of children) {
        items.push({ ...c, issue: { key: issue.key, summary: issue.fields.summary ?? "" } })
      }
    }
    return { items, nextToken: nextPageToken }
  }
}

// Comments: the comment text becomes the page body.
defineSync<any>(
  "comments",
  comments,
  perIssue(async (key) => (await jira<any>(`/rest/api/3/issue/${key}/comment?maxResults=100`)).comments ?? []),
  (c) => {
    const text = adfToText(c.body).trim()
    return [
      {
        key: `${c.issue.key}:${c.id}`,
        upstreamUpdatedAt: c.updated,
        properties: {
          Comment: Builder.title(clip(text.split("\n")[0] || "(empty comment)", 100)),
          "Comment ID": Builder.richText(`${c.issue.key}:${c.id}`),
          "Work Item": Builder.richText(c.issue.key),
          "Work Item Summary": Builder.richText(c.issue.summary),
          Author: Builder.select(pick(c.author?.displayName, PEOPLE)),
          Task: [Builder.relation(c.issue.key)],
          Created: Builder.dateTime(c.created),
          Updated: Builder.dateTime(c.updated),
          URL: Builder.url(`${browse(c.issue.key)}?focusedCommentId=${c.id}`),
        },
        pageContentMarkdown: [
          `## Comment on [${c.issue.key} ${c.issue.summary}](${browse(c.issue.key)})`,
          `\n**Author:** ${c.author?.displayName ?? "unknown"} · ${c.created}`,
          `\n${text || "_Empty comment._"}`,
        ].join("\n"),
      },
    ]
  },
)

// Status history: one row per status transition.
defineSync<any>(
  "statusHistory",
  statusHistory,
  perIssue(async (key) => {
    const data = await jira<any>(`/rest/api/3/issue/${key}/changelog?maxResults=100`)
    return (data.values ?? []).filter((h: any) => h.items?.some((i: any) => i.field === "status"))
  }),
  (h) => {
    const item = h.items.find((i: any) => i.field === "status")
    return [
      {
        key: `${h.issue.key}:${h.id}`,
        upstreamUpdatedAt: h.created,
        properties: {
          Change: Builder.title(`${h.issue.key}: ${item.fromString} → ${item.toString}`),
          "Change ID": Builder.richText(`${h.issue.key}:${h.id}`),
          "Work Item": Builder.richText(h.issue.key),
          "Work Item Summary": Builder.richText(h.issue.summary),
          From: Builder.select(pick(item.fromString, STATUSES)),
          To: Builder.select(pick(item.toString, STATUSES)),
          "Changed By": Builder.select(pick(h.author?.displayName, PEOPLE)),
          Task: [Builder.relation(h.issue.key)],
          Changed: Builder.dateTime(h.created),
          URL: Builder.url(browse(h.issue.key)),
        },
        pageContentMarkdown: [
          `## ${h.issue.key}: ${item.fromString} → ${item.toString}`,
          `\n**Work item:** [${h.issue.key} ${h.issue.summary}](${browse(h.issue.key)})`,
          `**Changed by:** ${h.author?.displayName ?? "unknown"} · ${h.created}`,
          h.items.length > 1
            ? `\n### Other fields changed in the same update\n\n${h.items
                .filter((i: any) => i.field !== "status")
                .map((i: any) => `- **${i.field}:** ${i.fromString ?? "(none)"} → ${i.toString ?? "(none)"}`)
                .join("\n")}`
            : "",
        ].join("\n"),
      },
    ]
  },
)

// Worklogs: time tracking entries.
defineSync<any>(
  "worklogs",
  worklogs,
  perIssue(async (key) => (await jira<any>(`/rest/api/3/issue/${key}/worklog`)).worklogs ?? []),
  (w) => {
    const note = adfToText(w.comment).trim()
    return [
      {
        key: `${w.issue.key}:${w.id}`,
        upstreamUpdatedAt: w.updated,
        properties: {
          Worklog: Builder.title(`${w.issue.key}: ${w.timeSpent} by ${w.author?.displayName ?? "unknown"}`),
          "Worklog ID": Builder.richText(`${w.issue.key}:${w.id}`),
          "Work Item": Builder.richText(w.issue.key),
          "Work Item Summary": Builder.richText(w.issue.summary),
          Author: Builder.select(pick(w.author?.displayName, PEOPLE)),
          Task: [Builder.relation(w.issue.key)],
          "Time Spent": Builder.richText(w.timeSpent ?? ""),
          Hours: Builder.number(Math.round(((w.timeSpentSeconds ?? 0) / 3600) * 100) / 100),
          Started: Builder.dateTime(w.started),
          URL: Builder.url(browse(w.issue.key)),
        },
        pageContentMarkdown: [
          `## ${w.timeSpent} on [${w.issue.key} ${w.issue.summary}](${browse(w.issue.key)})`,
          `\n**Author:** ${w.author?.displayName ?? "unknown"} · started ${w.started}`,
          `\n${note || "_No description._"}`,
        ].join("\n"),
      },
    ]
  },
)

// Versions: fix versions of every space.
defineSync<any>(
  "versions",
  versions,
  async () => {
    await jiraApi.wait()
    const projects = (await jira<any>("/rest/api/3/project/search?maxResults=100")).values ?? []
    const items: any[] = []
    for (const p of projects) {
      await jiraApi.wait()
      const vs = await jira<any[]>(`/rest/api/3/project/${p.key}/versions`).catch(() => [])
      for (const v of vs) items.push({ ...v, projectKey: p.key })
    }
    return { items }
  },
  (v) => [
    {
      key: String(v.id),
      properties: {
        Version: Builder.title(v.name),
        "Version ID": Builder.richText(String(v.id)),
        Project: Builder.richText(v.projectKey),
        Released: Builder.checkbox(Boolean(v.released)),
        Archived: Builder.checkbox(Boolean(v.archived)),
        ...(v.releaseDate ? { "Release Date": Builder.date(v.releaseDate) } : {}),
        Description: Builder.richText(clip(v.description)),
      },
      pageContentMarkdown: [
        `## ${v.name}${v.released ? " (released)" : ""}`,
        `\n**Project:** ${v.projectKey}${v.releaseDate ? ` · **Release date:** ${v.releaseDate}` : ""}`,
        `\n${v.description || "_No description._"}`,
        `\n[Open the project's versions in Jira](${BASE_URL}/projects/${v.projectKey}?selectedItem=com.atlassian.jira.jira-projects-plugin:release-page)`,
      ].join("\n"),
    },
  ],
)

// Sprints: all boards that support sprints (Scrum). Kanban boards are skipped.
defineSync<any>(
  "sprints",
  sprints,
  async () => {
    await jiraApi.wait()
    const boards = (await jira<any>("/rest/agile/1.0/board?maxResults=50")).values ?? []
    const items: any[] = []
    for (const b of boards) {
      await jiraApi.wait()
      const data = await jira<any>(`/rest/agile/1.0/board/${b.id}/sprint?maxResults=50`).catch(() => null)
      for (const s of data?.values ?? []) items.push({ ...s, boardName: b.name })
    }
    return { items }
  },
  (s) => [
    {
      key: String(s.id),
      upstreamUpdatedAt: s.completeDate ?? s.startDate,
      properties: {
        Sprint: Builder.title(s.name),
        "Sprint ID": Builder.richText(String(s.id)),
        State: Builder.select(s.state),
        Board: Builder.richText(s.boardName ?? ""),
        Goal: Builder.richText(clip(s.goal)),
        ...(s.startDate ? { Start: Builder.dateTime(s.startDate) } : {}),
        ...(s.endDate ? { End: Builder.dateTime(s.endDate) } : {}),
      },
      pageContentMarkdown: [
        `## ${s.name} (${s.state})`,
        `\n**Board:** ${s.boardName}`,
        `\n**Goal:** ${s.goal || "_No goal set._"}`,
        `\n${s.startDate ?? "?"} → ${s.endDate ?? "?"}${s.completeDate ? ` (completed ${s.completeDate})` : ""}`,
      ].join("\n"),
    },
  ],
)


const POINT_FIELDS = (ids: { points: string[]; sprint?: string }) =>
  ["summary", "status", "project", "issuetype", "assignee", "parent", "updated", "timeoriginalestimate", "timespent", ...ids.points, ids.sprint]
    .filter(Boolean)
    .join(",")
const hours = (sec?: number | null) => Math.round(((sec ?? 0) / 3600) * 100) / 100

// Task Points: story points per work item (Full: all, Delta: updated in last day).
defineSync<any>(
  "taskPoints",
  taskPoints,
  async (mode, token) => {
    const ids = await customFieldIds()
    await jiraApi.wait()
    const { issues, nextPageToken } = await searchIssues(issueJql(mode), token, 50, POINT_FIELDS(ids))
    return { items: issues.map((i) => ({ ...i, ids })), nextToken: nextPageToken }
  },
  (i) => {
    const f = i.fields
    const points = storyPoints(f, i.ids)
    const sprints: any[] = (i.ids.sprint && f[i.ids.sprint]) || []
    const sprint = sprints.find((s) => s.state === "active") ?? sprints[sprints.length - 1]
    return [
      {
        key: i.key,
        upstreamUpdatedAt: f.updated,
        properties: {
          Task: Builder.title(`${i.key}: ${f.summary ?? ""}`),
          "Work Item": Builder.richText(i.key),
          "Story Points": Builder.number(points ?? 0),
          Estimated: Builder.checkbox(points != null),
          Status: Builder.select(pick(f.status?.name ?? "Unknown", STATUSES)),
          "Status Category": Builder.select(
            ({ new: "To Do", indeterminate: "In Progress", done: "Done" } as Record<string, string>)[f.status?.statusCategory?.key] ?? "To Do",
          ),
          Type: Builder.select(pick(f.issuetype?.name ?? "Task", TYPES)),
          Assignee: Builder.select(pick(f.assignee?.displayName ?? "Unassigned", PEOPLE)),
          Sprint: Builder.richText(sprint?.name ?? ""),
          Parent: Builder.richText(f.parent?.key ?? ""),
          "Original Estimate (h)": Builder.number(hours(f.timeoriginalestimate)),
          "Time Spent (h)": Builder.number(hours(f.timespent)),
          Updated: Builder.dateTime(f.updated),
          URL: Builder.url(browse(i.key)),
          "Project Record": [Builder.relation(f.project?.key ?? "")],
        },
        pageContentMarkdown: [
          `## [${i.key} ${f.summary ?? ""}](${browse(i.key)})`,
          `\n**Story points:** ${points ?? "_not estimated_"} · **Status:** ${f.status?.name ?? "?"} · **Assignee:** ${f.assignee?.displayName ?? "Unassigned"}`,
          sprint ? `**Sprint:** ${sprint.name} (${sprint.state})` : "",
          f.parent ? `**Parent:** ${f.parent.key} ${f.parent.fields?.summary ?? ""}` : "",
        ].filter(Boolean).join("\n"),
      },
    ]
  },
)

// Project Points: aggregates every work item per space, so each run rescans all issues.
// Row counts are small for a demo; for large sites, page this by project via state.
defineSync<any>(
  "projectPoints",
  projectPoints,
  async () => {
    const ids = await customFieldIds()
    await jiraApi.wait()
    const projects = (await jira<any>("/rest/api/3/project/search?maxResults=100")).values ?? []
    const items: any[] = []
    for (const p of projects) {
      const agg = { total: 0, done: 0, progress: 0, todo: 0, items: 0, unestimated: 0 }
      let token: string | undefined
      do {
        await jiraApi.wait()
        const page = await searchIssues(`project = "${p.key}" ORDER BY created ASC`, token, 100, POINT_FIELDS(ids))
        for (const i of page.issues) {
          const pts = storyPoints(i.fields, ids)
          const cat = i.fields.status?.statusCategory?.key
          agg.items++
          if (pts == null) agg.unestimated++
          agg.total += pts ?? 0
          if (cat === "done") agg.done += pts ?? 0
          else if (cat === "indeterminate") agg.progress += pts ?? 0
          else agg.todo += pts ?? 0
        }
        token = page.nextPageToken
      } while (token)
      items.push({ ...p, agg })
    }
    return { items }
  },
  (p) => {
    const a = p.agg
    const pct = a.total ? Math.round((a.done / a.total) * 100) : 0
    return [
      {
        key: p.key,
        properties: {
          Project: Builder.title(`${p.key} – ${p.name}`),
          "Project Key": Builder.richText(p.key),
          "Total Points": Builder.number(a.total),
          "Done Points": Builder.number(a.done),
          "In Progress Points": Builder.number(a.progress),
          "To Do Points": Builder.number(a.todo),
          "Done %": Builder.number(pct),
          "Work Items": Builder.number(a.items),
          "Unestimated Items": Builder.number(a.unestimated),
          URL: Builder.url(`${BASE_URL}/jira/software/projects/${p.key}/summary`),
        },
        pageContentMarkdown: [
          `## ${p.name} (${p.key}) — ${pct}% done`,
          `\n| Status category | Points |\n| --- | --- |\n| Done | ${a.done} |\n| In Progress | ${a.progress} |\n| To Do | ${a.todo} |\n| **Total** | **${a.total}** |`,
          `\n${a.items} work items, ${a.unestimated} without a story point estimate.`,
          `\n[Open in Jira](${BASE_URL}/jira/software/projects/${p.key}/summary)`,
        ].join("\n"),
      },
    ]
  },
)

// -- Use-case syncs: several endpoints merged per database, linked by relations --
registerUseCases(worker, jiraApi)

// -- Agent tools: Notion <-> Jira (the built-in sync is one-way) --

worker.tool("searchJiraIssues", {
  title: "Search Jira work items",
  description: `Run a JQL query against ${BASE_URL} and return matching work items live (newer than the last sync). Example JQL: project = KAN AND statusCategory != Done ORDER BY priority DESC`,
  schema: j.object({
    jql: j.string().describe("JQL query."),
    limit: j.number().describe("Maximum results, default 20.").nullable(),
  }),
  execute: async ({ jql, limit }) => {
    const qs = new URLSearchParams({
      jql,
      maxResults: String(Math.min(limit ?? 20, 50)),
      fields: "summary,status,priority,assignee,issuetype",
    })
    const data = await jira<any>(`/rest/api/3/search/jql?${qs}`)
    return (data.issues ?? []).map((i: any) => ({
      key: i.key,
      summary: i.fields.summary,
      status: i.fields.status?.name,
      type: i.fields.issuetype?.name,
      priority: i.fields.priority?.name,
      assignee: i.fields.assignee?.displayName ?? "Unassigned",
      url: browse(i.key),
    }))
  },
})

worker.tool("createJiraIssue", {
  title: "Create Jira work item",
  description: `Create a work item in ${BASE_URL}. Use when a spec, bug report, or task in Notion should become a Jira work item. Returns the key and URL.`,
  schema: j.object({
    project: j.string().describe("Space (project) key, e.g. KAN."),
    summary: j.string().describe("Work item summary."),
    description: j.string().describe("Description in plain text.").nullable(),
    issueType: j.string().describe("Work type such as Task, Bug or Story. Default Task.").nullable(),
    labels: j.array(j.string()).describe("Labels.").nullable(),
  }),
  execute: async ({ project, summary, description, issueType, labels }) => {
    const created = await jira<any>("/rest/api/3/issue", {
      method: "POST",
      body: {
        fields: {
          project: { key: project },
          summary,
          issuetype: { name: issueType ?? "Task" },
          ...(description ? { description: textToAdf(description) } : {}),
          ...(labels?.length ? { labels } : {}),
        },
      },
    })
    return { key: created.key, url: browse(created.key) }
  },
})

worker.tool("transitionJiraIssue", {
  title: "Move Jira work item to a status",
  description: `Move a work item in ${BASE_URL} to another status (for example "In Progress" or "Done"). Lists the available statuses if the name does not match.`,
  schema: j.object({
    key: j.string().describe("Work item key, e.g. KAN-12."),
    status: j.string().describe("Target status name."),
  }),
  execute: async ({ key, status }): Promise<Record<string, string | boolean | string[]>> => {
    const { transitions } = await jira<any>(`/rest/api/3/issue/${key}/transitions`)
    const t = transitions.find((x: any) => x.to?.name.toLowerCase() === status.toLowerCase() || x.name.toLowerCase() === status.toLowerCase())
    if (!t) {
      return { moved: false, available: transitions.map((x: any) => x.to?.name ?? x.name) }
    }
    await jira(`/rest/api/3/issue/${key}/transitions`, { method: "POST", body: { transition: { id: t.id } } })
    return { moved: true, key, status: t.to?.name ?? t.name, url: browse(key) }
  },
})

worker.tool("addJiraComment", {
  title: "Add Jira comment",
  description: `Post a comment on a work item in ${BASE_URL}, for example a meeting summary or a decision made in Notion.`,
  schema: j.object({
    key: j.string().describe("Work item key, e.g. KAN-12."),
    comment: j.string().describe("Comment text (plain text)."),
  }),
  execute: async ({ key, comment }) => {
    const c = await jira<any>(`/rest/api/3/issue/${key}/comment`, {
      method: "POST",
      body: { body: textToAdf(comment) },
    })
    return { id: c.id, url: `${browse(key)}?focusedCommentId=${c.id}` }
  },
})
