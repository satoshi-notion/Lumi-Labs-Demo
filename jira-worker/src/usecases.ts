/**
 * Use-case syncs: each database merges several Jira endpoints and links to the others by relations.
 *
 *   Work Items    issue + changelog + comments + worklogs   -> one row and a time-ordered page body
 *   Sprint Health board sprints + sprint issues              -> committed / completed / carried over
 *   Epics         epics + their children                    -> progress, risk, due dates
 *   Releases      versions + fixVersion items                -> readiness
 *   People        assignees + open work + recent worklogs    -> workload
 *   Dependencies  issue links + both ends' status            -> active blockers
 */
import { Worker } from "@notionhq/workers"
import * as Builder from "@notionhq/workers/builder"
import * as Schema from "@notionhq/workers/schema"
import { BASE_URL, adfToText, customFieldIds, jira, searchIssues, storyPoints } from "./jira.js"

type Pacer = { wait: () => Promise<void> }
type Ids = { points: string[]; sprint?: string }

/** Select options are fixed in the schema; values outside a list fall back to "Other". */
const STATUSES = ["To Do", "未着手", "進行中", "品質保証", "完了", "Stuck", "In Progress", "Done", "Unknown"]
const TYPES = ["エピック", "ストーリー", "タスク", "バグ", "ワークストリーム", "Subtask", "Epic", "Story", "Task", "Bug"]
const PRIORITIES = ["Highest", "High", "Medium", "Low", "Lowest", "None"]
const LINK_TYPES = ["Blocks", "Relates", "Duplicate", "Clones"]
const PEOPLE = ["Melanie Harrington", "Marta Giambrone", "Antoine Richert", "Bret Scofield", "Edward Leblanc", "Sales demo", "Renee Ward", "Holly Turay", "Satoshi Suzuki", "Oriana Munoz", "Joseph Roberts", "Alice Antonelli", "Ana Haubold", "Stephanie Lee", "Sandra Lukac", "austen", "Juan Gomez", "Emily Zhang", "Sales Demo - Microsoft", "Unassigned"]
const opts = (names: string[]) => [...names, "Other"].map((name) => ({ name }))
const pick = (value: string | null | undefined, names: string[]) =>
	value && names.includes(value) ? value : "Other"

const browse = (key: string) => `${BASE_URL}/browse/${key}`
const DAY = 86_400_000
const hrs = (sec?: number | null) => Math.round(((sec ?? 0) / 3600) * 100) / 100
const round1 = (n: number) => Math.round(n * 10) / 10
const catName = (k?: string) => (({ new: "To Do", indeterminate: "In Progress", done: "Done" }) as Record<string, string>)[k ?? ""] ?? "To Do"
const isDone = (i: any) => i.fields.status?.statusCategory?.key === "done"
const isEpic = (i: any) => i.fields.issuetype?.hierarchyLevel === 1
const stamp = (iso: string) => iso.slice(0, 16).replace("T", " ")

const SCAN_FIELDS = (ids: Ids) =>
  [
    "summary", "status", "issuetype", "parent", "assignee", "reporter", "duedate", "updated", "created", "resolutiondate",
    "priority", "fixVersions", "issuelinks", "project", "timespent", ...ids.points, ids.sprint,
  ]
    .filter(Boolean)
    .join(",")

/** Drop properties with no value (an empty date cannot be sent as null). */
function withoutEmpty<T extends { properties: Record<string, any> }>(c: T): T {
  return { ...c, properties: Object.fromEntries(Object.entries(c.properties).filter(([, v]) => v !== undefined)) }
}

export function registerUseCases(worker: Worker, jiraApi: Pacer) {
  // ---------- databases ----------
  const workItems = worker.database("ucWorkItems", {
    type: "managed",
    initialTitle: "Work Items",
    primaryKeyProperty: "Key",
    schema: {
      properties: {
        "Work Item": Schema.title(),
        Key: Schema.richText(),
        Status: Schema.select(opts(STATUSES)),
        "Status Category": Schema.select([
          { name: "To Do", color: "gray" },
          { name: "In Progress", color: "blue" },
          { name: "Done", color: "green" },
        ]),
        Type: Schema.select(opts(TYPES)),
        Priority: Schema.select(opts(PRIORITIES)),
        "Story Points": Schema.number(),
        Assignee: Schema.select(opts(PEOPLE)),
        Due: Schema.date(),
        Created: Schema.date(),
        Updated: Schema.date(),
        "Lead Time (days)": Schema.number(),
        Reopens: Schema.number(),
        Transitions: Schema.number(),
        Comments: Schema.number(),
        "Hours Logged": Schema.number(),
        "Days Since Update": Schema.number(),
        Overdue: Schema.checkbox(),
        Blocked: Schema.checkbox(),
        URL: Schema.url(),
        Epic: Schema.relation("ucEpics", { twoWay: true, relatedPropertyName: "Work Items" }),
        Sprint: Schema.relation("ucSprints", { twoWay: true, relatedPropertyName: "Work Items" }),
        Release: Schema.relation("ucReleases", { twoWay: true, relatedPropertyName: "Work Items" }),
        Person: Schema.relation("ucPeople", { twoWay: true, relatedPropertyName: "Work Items" }),
      },
    },
  })

  const sprints = worker.database("ucSprints", {
    type: "managed",
    initialTitle: "Sprint Health",
    primaryKeyProperty: "Sprint ID",
    schema: {
      properties: {
        Sprint: Schema.title(),
        "Sprint ID": Schema.richText(),
        Board: Schema.richText(),
        State: Schema.select([
          { name: "future", color: "gray" },
          { name: "active", color: "blue" },
          { name: "closed", color: "green" },
        ]),
        Goal: Schema.richText(),
        Start: Schema.date(),
        End: Schema.date(),
        Items: Schema.number(),
        "Committed Points": Schema.number(),
        "Completed Points": Schema.number(),
        "Carried Over Items": Schema.number(),
        "Carried Over Points": Schema.number(),
        "Completion %": Schema.number(),
        Epics: Schema.relation("ucEpics", { twoWay: true, relatedPropertyName: "Sprints" }),
      },
    },
  })

  const epics = worker.database("ucEpics", {
    type: "managed",
    initialTitle: "Epics",
    primaryKeyProperty: "Key",
    schema: {
      properties: {
        Epic: Schema.title(),
        Key: Schema.richText(),
        Project: Schema.richText(),
        Status: Schema.select(opts(STATUSES)),
        "Child Items": Schema.number(),
        "Done Items": Schema.number(),
        "Points Total": Schema.number(),
        "Points Done": Schema.number(),
        "Done %": Schema.number(),
        "Overdue Items": Schema.number(),
        "Next Due": Schema.date(),
        "Last Updated": Schema.date(),
        URL: Schema.url(),
        Releases: Schema.relation("ucReleases", { twoWay: true, relatedPropertyName: "Epics" }),
      },
    },
  })

  const releases = worker.database("ucReleases", {
    type: "managed",
    initialTitle: "Releases",
    primaryKeyProperty: "Version ID",
    schema: {
      properties: {
        Release: Schema.title(),
        "Version ID": Schema.richText(),
        Project: Schema.richText(),
        "Release Date": Schema.date(),
        Released: Schema.checkbox(),
        "Items Total": Schema.number(),
        "Items Done": Schema.number(),
        "Open Items": Schema.number(),
        "Points Total": Schema.number(),
        "Points Done": Schema.number(),
        "Readiness %": Schema.number(),
        "Days to Release": Schema.number(),
      },
    },
  })

  const people = worker.database("ucPeople", {
    type: "managed",
    initialTitle: "People",
    primaryKeyProperty: "Account ID",
    schema: {
      properties: {
        Person: Schema.title(),
        "Account ID": Schema.richText(),
        "Open Items": Schema.number(),
        "In Progress Items": Schema.number(),
        "Open Points": Schema.number(),
        "Overdue Items": Schema.number(),
        "Hours Logged (14 days)": Schema.number(),
        "Last Active": Schema.date(),
      },
    },
  })

  const dependencies = worker.database("ucDependencies", {
    type: "managed",
    initialTitle: "Dependencies",
    primaryKeyProperty: "Link",
    schema: {
      properties: {
        Dependency: Schema.title(),
        Link: Schema.richText(),
        "Link Type": Schema.select(opts(LINK_TYPES)),
        "Blocker Status": Schema.select(opts(STATUSES)),
        "Blocker Assignee": Schema.select(opts(PEOPLE)),
        "Active Blocker": Schema.checkbox(),
        "Items Waiting": Schema.number(),
        Blocker: Schema.relation("ucWorkItems", { twoWay: true, relatedPropertyName: "Blocks" }),
        Blocked: Schema.relation("ucWorkItems", { twoWay: true, relatedPropertyName: "Blocked By" }),
      },
    },
  })

  // ---------- helpers ----------
  /** Every issue, newest scan each call. Small sites only: aggregates are recomputed in full. */
  async function scan(jql: string, ids: Ids, max = 1000) {
    const out: any[] = []
    let token: string | undefined
    do {
      await jiraApi.wait()
      const page = await searchIssues(jql, token, 100, SCAN_FIELDS(ids))
      out.push(...page.issues)
      token = page.nextPageToken
    } while (token && out.length < max)
    return out
  }
  const ALL = 'created >= "1970-01-01" ORDER BY created ASC'
  const sprintsOf = (i: any, ids: Ids): any[] => (ids.sprint && i.fields[ids.sprint]) || []
  const epicKeyOf = (i: any) => (i.fields.parent?.fields?.issuetype?.hierarchyLevel === 1 ? (i.fields.parent.key as string) : undefined)

  let statusCats: Map<string, string> | undefined
  async function statusCategories() {
    if (statusCats) return statusCats
    const all = await jira<any[]>("/rest/api/3/status")
    statusCats = new Map(all.map((s) => [s.name as string, s.statusCategory?.key as string]))
    return statusCats
  }

  /** One page of work items with their changelog, comments and worklogs. */
  async function fetchWorkItems(mode: "replace" | "incremental", token?: string) {
    const ids = await customFieldIds()
    const cats = await statusCategories()
    await jiraApi.wait()
    const jql = mode === "replace" ? ALL : "updated >= -1d ORDER BY updated ASC"
    const { issues, nextPageToken } = await searchIssues(jql, token, 20, SCAN_FIELDS(ids))
    const items: any[] = []
    for (const issue of issues) {
      if (isEpic(issue)) continue
      await jiraApi.wait()
      const changelog = (await jira<any>(`/rest/api/3/issue/${issue.key}/changelog?maxResults=100`)).values ?? []
      await jiraApi.wait()
      const comments = (await jira<any>(`/rest/api/3/issue/${issue.key}/comment?maxResults=100`)).comments ?? []
      await jiraApi.wait()
      const worklogs = (await jira<any>(`/rest/api/3/issue/${issue.key}/worklog?maxResults=100`)).worklogs ?? []
      items.push({ issue, changelog, comments, worklogs, ids, cats })
    }
    return { items, nextToken: nextPageToken }
  }

  function workItemChange(x: any) {
    const { issue, changelog, comments, worklogs, ids, cats } = x
    const f = issue.fields
    const now = Date.now()
    const points = storyPoints(f, ids)

    // Status changes in time order; a reopen is a move from a Done status to a not-Done one.
    const moves: Array<{ at: string; who: string; from: string; to: string }> = []
    for (const h of changelog) {
      for (const it of h.items ?? []) {
        if (it.field === "status") moves.push({ at: h.created, who: h.author?.displayName ?? "", from: it.fromString, to: it.toString })
      }
    }
    moves.sort((a, b) => a.at.localeCompare(b.at))
    const reopens = moves.filter((m) => cats.get(m.from) === "done" && cats.get(m.to) !== "done").length

    const hoursLogged = worklogs.reduce((s: number, w: any) => s + (w.timeSpentSeconds ?? 0), 0)
    const overdue = Boolean(f.duedate) && !isDone(issue) && new Date(f.duedate).getTime() < now
    const links: any[] = f.issuelinks ?? []
    const blocked = links.some(
      (l) => l.type?.name === "Blocks" && l.inwardIssue && l.inwardIssue.fields?.status?.statusCategory?.key !== "done",
    )
    const created = new Date(f.created).getTime()
    const leadDays = f.resolutiondate ? round1((new Date(f.resolutiondate).getTime() - created) / DAY) : 0

    const sprintRefs = sprintsOf(issue, ids).map((s) => Builder.relation(String(s.id)))
    const fixRefs = (f.fixVersions ?? []).map((v: any) => Builder.relation(String(v.id)))

    const timeline = [
      ...moves.map((m) => ({ at: m.at, text: `Status: ${m.from} → ${m.to} (${m.who})` })),
      ...comments.map((c: any) => ({ at: c.created, text: `Comment by ${c.author?.displayName ?? "?"}: ${adfToText(c.body).trim().replace(/\s+/g, " ").slice(0, 300)}` })),
      ...worklogs.map((w: any) => ({ at: w.started, text: `Logged ${hrs(w.timeSpentSeconds)}h by ${w.author?.displayName ?? "?"}` })),
    ].sort((a, b) => a.at.localeCompare(b.at))

    const body = [
      `## [${issue.key} ${f.summary ?? ""}](${browse(issue.key)})`,
      `\n**${f.status?.name ?? "?"}** · ${f.issuetype?.name ?? ""} · ${points != null ? `${points} pts` : "not estimated"} · ${f.assignee?.displayName ?? "Unassigned"}` +
        (f.duedate ? ` · due ${f.duedate}${overdue ? " (overdue)" : ""}` : ""),
      `\n**Reopened ${reopens}×** · ${moves.length} status changes · ${comments.length} comments · ${hrs(hoursLogged)}h logged${blocked ? " · **blocked**" : ""}`,
      "\n### Timeline",
      timeline.length ? timeline.map((t) => `- ${stamp(t.at)} · ${t.text}`).join("\n") : "_No activity yet._",
    ].join("\n")

    return {
      key: issue.key as string,
      properties: {
        "Work Item": Builder.title(`${issue.key}: ${f.summary ?? ""}`),
        Key: Builder.richText(issue.key),
        Status: Builder.select(pick(f.status?.name ?? "Unknown", STATUSES)),
        "Status Category": Builder.select(catName(f.status?.statusCategory?.key)),
        Type: Builder.select(pick(f.issuetype?.name ?? "Task", TYPES)),
        Priority: Builder.select(pick(f.priority?.name ?? "None", PRIORITIES)),
        "Story Points": Builder.number(points ?? 0),
        Assignee: Builder.select(pick(f.assignee?.displayName ?? "Unassigned", PEOPLE)),
        Due: f.duedate ? Builder.date(f.duedate) : (undefined as any),
        Created: Builder.dateTime(f.created),
        Updated: Builder.dateTime(f.updated),
        "Lead Time (days)": Builder.number(leadDays),
        Reopens: Builder.number(reopens),
        Transitions: Builder.number(moves.length),
        Comments: Builder.number(comments.length),
        "Hours Logged": Builder.number(hrs(hoursLogged)),
        "Days Since Update": Builder.number(Math.max(0, Math.floor((now - new Date(f.updated).getTime()) / DAY))),
        Overdue: Builder.checkbox(overdue),
        Blocked: Builder.checkbox(blocked),
        URL: Builder.url(browse(issue.key)),
        Epic: epicKeyOf(issue) ? [Builder.relation(epicKeyOf(issue)!)] : [],
        Sprint: sprintRefs,
        Release: fixRefs,
        Person: f.assignee?.accountId ? [Builder.relation(f.assignee.accountId)] : [],
      },
      pageContentMarkdown: body,
    }
  }

  // Work Items: Delta every 5 min, Full once a day.
  for (const [mode, schedule] of [["incremental", "5m"], ["replace", "1d"]] as const) {

    worker.sync(`ucWorkItems${mode === "replace" ? "Full" : "Delta"}`, {
      database: workItems,
      mode,
      schedule,
      execute: async (state: { token?: string } | undefined) => {
        const { items, nextToken } = await fetchWorkItems(mode, state?.token)
        return {
          changes: items.map((x) => withoutEmpty({ type: "upsert" as const, ...workItemChange(x) })),
          hasMore: Boolean(nextToken),
          nextState: nextToken ? { token: nextToken } : undefined,
        }
      },
    })
  }

  /** Aggregates recompute everything, so they run as one replace sync, emitted in chunks of 100. */
  function aggregate<T>(
    name: string,
    database: ReturnType<typeof worker.database>,
    compute: () => Promise<T[]>,
    toChange: (t: T) => { key: string; properties: Record<string, any>; pageContentMarkdown?: string },
  ) {
    worker.sync(name, {
      database,
      mode: "replace",
      schedule: "30m",
      execute: async (state: { offset?: number } | undefined) => {
        const all = await compute()
        const offset = state?.offset ?? 0
        const slice = all.slice(offset, offset + 100)
        const more = offset + 100 < all.length
        return {
          changes: slice.map((t) => withoutEmpty({ type: "upsert" as const, ...toChange(t) })),
          hasMore: more,
          nextState: more ? { offset: offset + 100 } : undefined,
        }
      },
    })
  }

  // Sprint Health: sprint + the work items inside it. Carried over = still in a later sprint.
  aggregate<any>(
    "ucSprintsSync",
    sprints,
    async () => {
      const ids = await customFieldIds()
      await jiraApi.wait()
      const boards = (await jira<any>("/rest/agile/1.0/board?maxResults=100")).values ?? []
      const seen = new Map<number, any>()
      for (const b of boards) {
        try {
          await jiraApi.wait()
          const page = await jira<any>(`/rest/agile/1.0/board/${b.id}/sprint?maxResults=50`)
          for (const s of page.values ?? []) if (!seen.has(s.id)) seen.set(s.id, { ...s, board: b.name })
        } catch {
          // Kanban boards have no sprints.
        }
      }
      const out: any[] = []
      for (const s of seen.values()) {
        const issues: any[] = []
        let startAt = 0
        for (;;) {
          await jiraApi.wait()
          const page = await jira<any>(`/rest/agile/1.0/sprint/${s.id}/issue?startAt=${startAt}&maxResults=100&fields=${SCAN_FIELDS(ids)}`)
          issues.push(...(page.issues ?? []))
          startAt += (page.issues ?? []).length
          if (!page.issues?.length || startAt >= page.total) break
        }
        const work = issues.filter((i) => !isEpic(i))
        const carried = s.state === "closed" ? work.filter((i) => sprintsOf(i, ids).some((o: any) => o.id > s.id)) : []
        const carriedKeys = new Set(carried.map((i) => i.key))
        const completed = work.filter((i) => isDone(i) && !carriedKeys.has(i.key))
        const pts = (list: any[]) => list.reduce((n, i) => n + (storyPoints(i.fields, ids) ?? 0), 0)
        const epicKeys = [...new Set(work.map(epicKeyOf).filter(Boolean))] as string[]
        out.push({ ...s, work, carried, completed, committed: pts(work), completedPts: pts(completed), carriedPts: pts(carried), epicKeys })
      }
      return out
    },
    (s) => {
      const pct = s.committed ? Math.round((s.completedPts / s.committed) * 100) : 0
      return {
        key: String(s.id),
        properties: {
          Sprint: Builder.title(s.name),
          "Sprint ID": Builder.richText(String(s.id)),
          ...(s.board ? { Board: Builder.richText(s.board ?? "") } : {}),
          State: Builder.select(s.state),
          Goal: Builder.richText((s.goal ?? "").slice(0, 1900)),
          Start: s.startDate ? Builder.dateTime(s.startDate) : (undefined as any),
          End: s.endDate ? Builder.dateTime(s.endDate) : (undefined as any),
          Items: Builder.number(s.work.length),
          "Committed Points": Builder.number(s.committed),
          "Completed Points": Builder.number(s.completedPts),
          "Carried Over Items": Builder.number(s.carried.length),
          "Carried Over Points": Builder.number(s.carriedPts),
          "Completion %": Builder.number(pct),
          Epics: s.epicKeys.map((k: string) => Builder.relation(k)),
        },
        pageContentMarkdown: [
          `## ${s.name} (${s.state}) — ${pct}% of committed points completed`,
          s.goal ? `\n**Goal:** ${s.goal}` : "",
          `\n| | Items | Points |\n| --- | --- | --- |\n| Committed | ${s.work.length} | ${s.committed} |\n| Completed | ${s.completed.length} | ${s.completedPts} |\n| Carried over | ${s.carried.length} | ${s.carriedPts} |`,
          s.carried.length ? `\n**Carried over:** ${s.carried.map((i: any) => `[${i.key}](${browse(i.key)})`).join(", ")}` : "",
        ].filter(Boolean).join("\n"),
      }
    },
  )

  // Epics: roll up the children of every epic.
  aggregate<any>(
    "ucEpicsSync",
    epics,
    async () => {
      const ids = await customFieldIds()
      const all = await scan(ALL, ids)
      const kids = new Map<string, any[]>()
      for (const i of all) {
        const p = i.fields.parent?.key
        if (p) kids.set(p, [...(kids.get(p) ?? []), i])
      }
      return all.filter(isEpic).map((e) => ({ epic: e, kids: kids.get(e.key) ?? [], ids }))
    },
    ({ epic, kids, ids }) => {
      const f = epic.fields
      const done = kids.filter(isDone)
      const pts = (l: any[]) => l.reduce((n: number, i: any) => n + (storyPoints(i.fields, ids) ?? 0), 0)
      const total = pts(kids)
      const pct = total ? Math.round((pts(done) / total) * 100) : kids.length ? Math.round((done.length / kids.length) * 100) : 0
      const open = kids.filter((i: any) => !isDone(i))
      const overdue = open.filter((i: any) => i.fields.duedate && new Date(i.fields.duedate).getTime() < Date.now())
      const due = open.map((i: any) => i.fields.duedate).filter(Boolean).sort()
      const next = due.find((d: string) => new Date(d).getTime() >= Date.now()) ?? due[0]
      const versions = new Map<string, string>()
      for (const k of kids) for (const v of k.fields.fixVersions ?? []) versions.set(String(v.id), v.name)
      const updated = [f.updated, ...kids.map((k: any) => k.fields.updated)].sort().pop()
      return {
        key: epic.key,
        properties: {
          Epic: Builder.title(`${epic.key}: ${f.summary ?? ""}`),
          Key: Builder.richText(epic.key),
          Project: Builder.richText(f.project?.key ?? ""),
          Status: Builder.select(pick(f.status?.name ?? "Unknown", STATUSES)),
          "Child Items": Builder.number(kids.length),
          "Done Items": Builder.number(done.length),
          "Points Total": Builder.number(total),
          "Points Done": Builder.number(pts(done)),
          "Done %": Builder.number(pct),
          "Overdue Items": Builder.number(overdue.length),
          "Next Due": next ? Builder.date(next) : (undefined as any),
          "Last Updated": Builder.dateTime(updated),
          URL: Builder.url(browse(epic.key)),
          Releases: [...versions.keys()].map((id) => Builder.relation(id)),
        },
        pageContentMarkdown: [
          `## [${epic.key} ${f.summary ?? ""}](${browse(epic.key)}) — ${pct}% done`,
          `\n${done.length} of ${kids.length} items done · ${pts(done)} of ${total} points${overdue.length ? ` · **${overdue.length} overdue**` : ""}`,
          open.length ? `\n### Open items\n${open.map((i: any) => `- [${i.key}](${browse(i.key)}) ${i.fields.summary} · ${i.fields.status?.name}${i.fields.duedate ? ` · due ${i.fields.duedate}` : ""}`).join("\n")}` : "\n_Everything is done._",
          versions.size ? `\n**Releases:** ${[...versions.values()].join(", ")}` : "",
        ].filter(Boolean).join("\n"),
      }
    },
  )

  // Releases: versions plus how ready their work items are.
  aggregate<any>(
    "ucReleasesSync",
    releases,
    async () => {
      const ids = await customFieldIds()
      const all = await scan(ALL, ids)
      await jiraApi.wait()
      const projects = (await jira<any>("/rest/api/3/project/search?maxResults=100")).values ?? []
      const out: any[] = []
      for (const p of projects) {
        await jiraApi.wait()
        const versions = await jira<any[]>(`/rest/api/3/project/${p.key}/versions`)
        for (const v of versions) {
          const items = all.filter((i) => (i.fields.fixVersions ?? []).some((x: any) => String(x.id) === String(v.id)))
          out.push({ v, project: p.key, items, ids })
        }
      }
      return out
    },
    ({ v, project, items, ids }) => {
      const done = items.filter(isDone)
      const pts = (l: any[]) => l.reduce((n: number, i: any) => n + (storyPoints(i.fields, ids) ?? 0), 0)
      const totalPts = pts(items)
      const ready = totalPts ? Math.round((pts(done) / totalPts) * 100) : items.length ? Math.round((done.length / items.length) * 100) : 0
      const days = v.releaseDate && !v.released ? Math.round((new Date(v.releaseDate).getTime() - Date.now()) / DAY) : 0
      const open = items.filter((i: any) => !isDone(i))
      return {
        key: String(v.id),
        properties: {
          Release: Builder.title(`${project} · ${v.name}`),
          "Version ID": Builder.richText(String(v.id)),
          Project: Builder.richText(project),
          "Release Date": v.releaseDate ? Builder.date(v.releaseDate) : (undefined as any),
          Released: Builder.checkbox(Boolean(v.released)),
          "Items Total": Builder.number(items.length),
          "Items Done": Builder.number(done.length),
          "Open Items": Builder.number(open.length),
          "Points Total": Builder.number(totalPts),
          "Points Done": Builder.number(pts(done)),
          "Readiness %": Builder.number(ready),
          "Days to Release": Builder.number(days),
        },
        pageContentMarkdown: [
          `## ${project} · ${v.name} — ${v.released ? "released" : `${ready}% ready`}`,
          v.releaseDate ? `\nRelease date: ${v.releaseDate}${!v.released ? ` (${days >= 0 ? `${days} days left` : `${-days} days overdue`})` : ""}` : "",
          open.length ? `\n### Still open\n${open.map((i: any) => `- [${i.key}](${browse(i.key)}) ${i.fields.summary} · ${i.fields.status?.name}`).join("\n")}` : "\n_No open items._",
        ].filter(Boolean).join("\n"),
      }
    },
  )

  // People: workload per assignee, plus hours logged in the last 14 days.
  aggregate<any>(
    "ucPeopleSync",
    people,
    async () => {
      const ids = await customFieldIds()
      const all = await scan(ALL, ids)
      const byId = new Map<string, any>()
      const person = (id: string, name: string) => {
        if (!byId.has(id)) byId.set(id, { id, name, open: 0, inprog: 0, points: 0, overdue: 0, hours: 0, last: "" })
        return byId.get(id)
      }
      const since = Date.now() - 14 * DAY
      for (const i of all) {
        const a = i.fields.assignee
        if (a && !isEpic(i)) {
          const p = person(a.accountId, a.displayName)
          if (!isDone(i)) {
            p.open++
            p.points += storyPoints(i.fields, ids) ?? 0
            if (i.fields.status?.statusCategory?.key === "indeterminate") p.inprog++
            if (i.fields.duedate && new Date(i.fields.duedate).getTime() < Date.now()) p.overdue++
          }
          if (i.fields.updated > p.last) p.last = i.fields.updated
        }
        if ((i.fields.timespent ?? 0) > 0) {
          await jiraApi.wait()
          for (const w of (await jira<any>(`/rest/api/3/issue/${i.key}/worklog?maxResults=100`)).worklogs ?? []) {
            if (new Date(w.started).getTime() >= since && w.author?.accountId) person(w.author.accountId, w.author.displayName).hours += w.timeSpentSeconds ?? 0
          }
        }
      }
      return [...byId.values()]
    },
    (p) => ({
      key: p.id,
      properties: {
        Person: Builder.title(p.name),
        "Account ID": Builder.richText(p.id),
        "Open Items": Builder.number(p.open),
        "In Progress Items": Builder.number(p.inprog),
        "Open Points": Builder.number(p.points),
        "Overdue Items": Builder.number(p.overdue),
        "Hours Logged (14 days)": Builder.number(hrs(p.hours)),
        "Last Active": p.last ? Builder.dateTime(p.last) : (undefined as any),
      },
      pageContentMarkdown: `## ${p.name}\n\n${p.open} open items (${p.inprog} in progress) · ${p.points} open points · ${p.overdue} overdue · ${hrs(p.hours)}h logged in the last 14 days.`,
    }),
  )

  // Dependencies: "A blocks B" pairs, with the blocker's current state.
  aggregate<any>(
    "ucDependenciesSync",
    dependencies,
    async () => {
      const ids = await customFieldIds()
      const all = await scan(ALL, ids)
      const byKey = new Map(all.map((i) => [i.key as string, i]))
      const pairs = new Map<string, any>()
      for (const i of all) {
        for (const l of i.fields.issuelinks ?? []) {
          const type = l.type?.name as string
          const [blocker, blocked] = l.outwardIssue ? [i.key, l.outwardIssue.key] : [l.inwardIssue?.key, i.key]
          if (!blocker || !blocked) continue
          const k = `${blocker}>${blocked}:${type}`
          if (!pairs.has(k)) pairs.set(k, { k, type, blocker, blocked })
        }
      }
      const list = [...pairs.values()].map((p) => {
        const b = byKey.get(p.blocker)
        return { ...p, bi: b, active: p.type === "Blocks" && b != null && !isDone(b) }
      })
      const waiting = new Map<string, number>()
      for (const p of list) if (p.active) waiting.set(p.blocker, (waiting.get(p.blocker) ?? 0) + 1)
      return list.map((p) => ({ ...p, waiting: waiting.get(p.blocker) ?? 0 }))
    },
    (p) => ({
      key: p.k,
      properties: {
        Dependency: Builder.title(`${p.blocker} ${p.type === "Blocks" ? "blocks" : "relates to"} ${p.blocked}`),
        Link: Builder.richText(p.k),
        "Link Type": Builder.select(pick(p.type, LINK_TYPES)),
        "Blocker Status": Builder.select(pick(p.bi?.fields.status?.name ?? "Unknown", STATUSES)),
        "Blocker Assignee": Builder.select(pick(p.bi?.fields.assignee?.displayName ?? "Unassigned", PEOPLE)),
        "Active Blocker": Builder.checkbox(p.active),
        "Items Waiting": Builder.number(p.waiting),
        Blocker: [Builder.relation(p.blocker)],
        Blocked: [Builder.relation(p.blocked)],
      },
      pageContentMarkdown: `## [${p.blocker}](${browse(p.blocker)}) ${p.type === "Blocks" ? "blocks" : "relates to"} [${p.blocked}](${browse(p.blocked)})\n\nBlocker status: ${p.bi?.fields.status?.name ?? "unknown"}${p.active ? " — **still blocking**" : ""}.`,
    }),
  )
}
