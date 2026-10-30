/**
 * Advanced sync: each database merges several GitHub endpoints and links to the others by relations.
 *
 *   Pull Requests   pull + reviews + files + CI runs        -> cycle time, review load, size, CI result (hub)
 *   Delivery Pulse  PRs + runs + commits + issues, per week -> throughput and CI pass rate
 *   Release Notes   releases + the PRs and issues between   -> what shipped in each release
 *   Contributors    PR authors, reviewers, commit authors   -> who builds and who reviews
 *   Issues          issues + the PRs that close them        -> backlog age and linked work
 *   Code Hotspots   files changed by pull requests          -> where change concentrates
 *
 * Every database is recomputed from a shared, short-lived snapshot of the repository.
 */
import type { Worker } from "@notionhq/workers"
import * as Builder from "@notionhq/workers/builder"
import * as Schema from "@notionhq/workers/schema"
import { gh } from "./github.js"

type Pacer = { wait: () => Promise<void> }

const HOUR = 3_600_000
const hoursBetween = (a?: string | null, b?: string | null) =>
  a && b ? Math.round(((new Date(b).getTime() - new Date(a).getTime()) / HOUR) * 10) / 10 : undefined
const daysBetween = (a?: string | null, b?: string | null) => {
  const h = hoursBetween(a, b)
  return h === undefined ? undefined : Math.round((h / 24) * 10) / 10
}
const avg = (xs: number[]) => (xs.length ? Math.round((xs.reduce((s, x) => s + x, 0) / xs.length) * 10) / 10 : undefined)
const clip = (s: string | null | undefined, n = 1900) => (s ?? "").slice(0, n)
const day = (iso?: string | null) => (iso ? iso.slice(0, 10) : undefined)

/** Monday of the week (UTC) as YYYY-MM-DD. */
function weekOf(iso: string) {
  const d = new Date(iso)
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7))
  return d.toISOString().slice(0, 10)
}

/** Drop properties with no value (an empty date or number cannot be sent as null). */
function withoutEmpty<T extends { properties: Record<string, any> }>(c: T): T {
  return { ...c, properties: Object.fromEntries(Object.entries(c.properties).filter(([, v]) => v !== undefined)) }
}
const opt = <T>(v: T | undefined, build: (v: T) => any) => (v === undefined ? undefined : build(v))

const sizeOf = (lines: number) => (lines < 10 ? "XS" : lines < 50 ? "S" : lines < 200 ? "M" : lines < 500 ? "L" : "XL")
const CLOSES = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)/gi

type PR = {
  n: any
  reviews: any[]
  files: any[]
  ci?: string
  issues: number[]
  release?: string
  state: "open" | "merged" | "closed"
}

export function registerUseCases(worker: Worker, githubApi: Pacer) {
  // ---------- databases ----------
  const pullRequests = worker.database("ucPullRequests", {
    type: "managed",
    initialTitle: "Pull Requests",
    primaryKeyProperty: "Number",
    schema: {
      properties: {
        "Pull Request": Schema.title(),
        Number: Schema.richText(),
        State: Schema.select([
          { name: "open", color: "green" },
          { name: "merged", color: "purple" },
          { name: "closed", color: "gray" },
        ]),
        Draft: Schema.checkbox(),
        Branch: Schema.richText(),
        Created: Schema.date(),
        Merged: Schema.date(),
        "Cycle Time (hours)": Schema.number(),
        "First Review (hours)": Schema.number(),
        Reviews: Schema.number(),
        Approvals: Schema.number(),
        "Changes Requested": Schema.number(),
        "Inline Comments": Schema.number(),
        Commits: Schema.number(),
        "Files Changed": Schema.number(),
        Additions: Schema.number(),
        Deletions: Schema.number(),
        Size: Schema.select([
          { name: "XS", color: "gray" },
          { name: "S", color: "blue" },
          { name: "M", color: "yellow" },
          { name: "L", color: "orange" },
          { name: "XL", color: "red" },
        ]),
        CI: Schema.select([
          { name: "success", color: "green" },
          { name: "failure", color: "red" },
          { name: "none", color: "gray" },
        ]),
        URL: Schema.url(),
        Author: Schema.relation("ucContributors", { twoWay: true, relatedPropertyName: "Authored PRs" }),
        Reviewers: Schema.relation("ucContributors", { twoWay: true, relatedPropertyName: "Reviewed PRs" }),
        Issues: Schema.relation("ucIssues", { twoWay: true, relatedPropertyName: "Pull Requests" }),
        Release: Schema.relation("ucReleases", { twoWay: true, relatedPropertyName: "Pull Requests" }),
        Week: Schema.relation("ucWeeks", { twoWay: true, relatedPropertyName: "Merged PRs" }),
        Files: Schema.relation("ucFiles", { twoWay: true, relatedPropertyName: "Pull Requests" }),
      },
    },
  })

  const weeks = worker.database("ucWeeks", {
    type: "managed",
    initialTitle: "Delivery Pulse",
    primaryKeyProperty: "Week Start",
    schema: {
      properties: {
        Week: Schema.title(),
        "Week Start": Schema.richText(),
        "PRs Opened": Schema.number(),
        "PRs Merged": Schema.number(),
        Commits: Schema.number(),
        "CI Runs": Schema.number(),
        "CI Pass %": Schema.number(),
        "Avg Cycle Time (hours)": Schema.number(),
        "Issues Closed": Schema.number(),
        "Bugs Closed": Schema.number(),
        Additions: Schema.number(),
        Deletions: Schema.number(),
      },
    },
  })

  const releases = worker.database("ucReleases", {
    type: "managed",
    initialTitle: "Release Notes",
    primaryKeyProperty: "Tag",
    schema: {
      properties: {
        Release: Schema.title(),
        Tag: Schema.richText(),
        Published: Schema.date(),
        Prerelease: Schema.checkbox(),
        "PRs Included": Schema.number(),
        "Issues Fixed Count": Schema.number(),
        Additions: Schema.number(),
        Deletions: Schema.number(),
        "Days Since Previous": Schema.number(),
        Contributors: Schema.richText(),
        URL: Schema.url(),
      },
    },
  })

  const contributors = worker.database("ucContributors", {
    type: "managed",
    initialTitle: "Contributors",
    primaryKeyProperty: "Login",
    schema: {
      properties: {
        Contributor: Schema.title(),
        Login: Schema.richText(),
        "PRs Authored": Schema.number(),
        "PRs Merged": Schema.number(),
        "Reviews Given": Schema.number(),
        "Approvals Given": Schema.number(),
        Commits: Schema.number(),
        Additions: Schema.number(),
        Deletions: Schema.number(),
        "Avg Cycle Time (hours)": Schema.number(),
        "Avg Review Turnaround (hours)": Schema.number(),
        "Last Active": Schema.date(),
        URL: Schema.url(),
      },
    },
  })

  const issues = worker.database("ucIssues", {
    type: "managed",
    initialTitle: "Issues",
    primaryKeyProperty: "Number",
    schema: {
      properties: {
        Issue: Schema.title(),
        Number: Schema.richText(),
        State: Schema.select([
          { name: "open", color: "green" },
          { name: "closed", color: "purple" },
        ]),
        Labels: Schema.multiSelect([
          { name: "bug", color: "red" },
          { name: "enhancement", color: "blue" },
          { name: "documentation", color: "gray" },
          { name: "good first issue", color: "green" },
          { name: "priority: high", color: "orange" },
          { name: "help wanted", color: "purple" },
          { name: "question", color: "pink" },
        ]),
        Author: Schema.richText(),
        Created: Schema.date(),
        Closed: Schema.date(),
        "Age (days)": Schema.number(),
        "Time to Close (days)": Schema.number(),
        Comments: Schema.number(),
        "Linked PRs": Schema.number(),
        "Has PR": Schema.checkbox(),
        URL: Schema.url(),
        "Released In": Schema.relation("ucReleases", { twoWay: true, relatedPropertyName: "Issues Fixed" }),
      },
    },
  })

  const files = worker.database("ucFiles", {
    type: "managed",
    initialTitle: "Code Hotspots",
    primaryKeyProperty: "Path",
    schema: {
      properties: {
        File: Schema.title(),
        Path: Schema.richText(),
        Directory: Schema.richText(),
        "PRs Touching": Schema.number(),
        Additions: Schema.number(),
        Deletions: Schema.number(),
        Authors: Schema.number(),
        "Last Changed": Schema.date(),
      },
    },
  })

  // ---------- shared snapshot ----------
  type Snapshot = Awaited<ReturnType<typeof load>>
  let cache: { at: number; snap: Promise<Snapshot> } | undefined
  const snapshot = () => {
    if (!cache || Date.now() - cache.at > 120_000) cache = { at: Date.now(), snap: load() }
    return cache.snap
  }

  async function list<T>(path: string, key?: string, max = 3): Promise<T[]> {
    const out: T[] = []
    for (let page = 1; page <= max; page++) {
      await githubApi.wait()
      const sep = path.includes("?") ? "&" : "?"
      const data = await gh<any>(`${path}${sep}per_page=100&page=${page}`)
      const items: T[] = key ? data[key] : data
      out.push(...items)
      if (items.length < 100) break
    }
    return out
  }

  async function load() {
    const [prList, issueList, releaseList, runs, commits] = await Promise.all([
      list<any>("/pulls?state=all"),
      list<any>("/issues?state=all"),
      list<any>("/releases", undefined, 1),
      list<any>("/actions/runs", "workflow_runs"),
      list<any>("/commits"),
    ])
    const rels = releaseList
      .filter((r) => !r.draft)
      .sort((a, b) => +new Date(a.published_at ?? a.created_at) - +new Date(b.published_at ?? b.created_at))
    const releaseAt = (r: any) => r.published_at ?? r.created_at

    const prs: PR[] = []
    for (const s of prList) {
      await githubApi.wait()
      const n = await gh<any>(`/pulls/${s.number}`)
      await githubApi.wait()
      const reviews = await gh<any[]>(`/pulls/${s.number}/reviews?per_page=100`).catch(() => [])
      await githubApi.wait()
      const files = await gh<any[]>(`/pulls/${s.number}/files?per_page=100`).catch(() => [])
      const sha = n.head.sha
      const run = runs
        .filter((r) => r.head_sha === sha && r.event === "pull_request")
        .sort((a, b) => +new Date(b.created_at) - +new Date(a.created_at))[0]
      const text = `${n.title}\n${n.body ?? ""}`
      const linked = [...text.matchAll(CLOSES)].map((m) => Number(m[1]))
      const state = n.merged_at ? "merged" : n.state === "closed" ? "closed" : "open"
      const release = n.merged_at ? rels.find((r) => +new Date(releaseAt(r)) >= +new Date(n.merged_at)) : undefined
      prs.push({
        n,
        reviews: reviews.filter((r) => r.state !== "PENDING"),
        files,
        ci: run ? (run.conclusion === "success" ? "success" : run.conclusion === "failure" ? "failure" : "none") : "none",
        issues: [...new Set(linked)],
        release: release?.tag_name,
        state,
      })
    }

    const realIssues = issueList.filter((i) => !i.pull_request)
    const issueNumbers = new Set(realIssues.map((i) => i.number))
    for (const p of prs) p.issues = p.issues.filter((i) => issueNumbers.has(i))
    return { prs, issues: realIssues, releases: rels, runs, commits }
  }

  /** Issue -> the release it shipped in: closed after the previous release, up to this one. */
  const releaseOfIssue = (rels: any[], closedAt?: string | null) => {
    if (!closedAt) return undefined
    return rels.find((r) => +new Date(r.published_at ?? r.created_at) >= +new Date(closedAt))?.tag_name
  }

  function aggregate<T>(
    name: string,
    database: ReturnType<typeof worker.database>,
    compute: (s: Snapshot) => T[],
    toChange: (t: T, s: Snapshot) => { key: string; properties: Record<string, any>; pageContentMarkdown?: string },
  ) {
    worker.sync(name, {
      database,
      mode: "replace",
      schedule: "30m",
      execute: async (state: { offset?: number } | undefined) => {
        const snap = await snapshot()
        const all = compute(snap)
        const offset = state?.offset ?? 0
        const slice = all.slice(offset, offset + 100)
        const more = offset + 100 < all.length
        return {
          changes: slice.map((t) => withoutEmpty({ type: "upsert" as const, ...toChange(t, snap) })),
          hasMore: more,
          nextState: more ? { offset: offset + 100 } : undefined,
        }
      },
    })
  }

  // Pull Requests: the hub.
  aggregate<PR>(
    "ucPullRequestsSync",
    pullRequests,
    (s) => s.prs,
    (p, s) => {
      const n = p.n
      const reviewers = [...new Set(p.reviews.map((r) => r.user?.login).filter(Boolean))].filter((l) => l !== n.user?.login)
      const firstReview = p.reviews.map((r) => r.submitted_at).filter(Boolean).sort()[0]
      const lines = (n.additions ?? 0) + (n.deletions ?? 0)
      const icon = (st: string) => (st === "APPROVED" ? "✅" : st === "CHANGES_REQUESTED" ? "❌" : "💬")
      const md = [
        `## #${n.number} ${n.title}`,
        `\n**State:** ${p.state} · **Author:** ${n.user?.login} · **Branch:** \`${n.head.ref}\` → \`${n.base.ref}\` · [View on GitHub](${n.html_url})`,
        `**CI:** ${p.ci}${p.release ? ` · **Shipped in:** ${p.release}` : ""}${p.issues.length ? ` · **Closes:** ${p.issues.map((i) => `#${i}`).join(", ")}` : ""}`,
        n.body ? `\n${clip(n.body, 1500)}` : "",
        p.reviews.length ? "\n### Reviews" : "",
        ...p.reviews.map((r) => `- ${icon(r.state)} **${r.user?.login}** ${r.state.toLowerCase().replace("_", " ")}${r.body ? `: ${clip(r.body, 200)}` : ""}`),
        `\n### Changes (+${n.additions ?? 0} / -${n.deletions ?? 0} in ${n.changed_files ?? p.files.length} files)`,
        "",
        "| File | + | - |",
        "| --- | --- | --- |",
        ...p.files.slice(0, 30).map((f) => `| \`${f.filename}\` | ${f.additions} | ${f.deletions} |`),
      ].join("\n")
      const merged = n.merged_at
      return {
        key: String(n.number),
        pageContentMarkdown: md,
        properties: {
          "Pull Request": Builder.title(`#${n.number} ${n.title}`),
          Number: Builder.richText(String(n.number)),
          State: Builder.select(p.state),
          Draft: Builder.checkbox(Boolean(n.draft)),
          Branch: Builder.richText(n.head.ref),
          Created: opt(day(n.created_at), Builder.date),
          Merged: opt(day(merged), Builder.date),
          "Cycle Time (hours)": opt(hoursBetween(n.created_at, merged), Builder.number),
          "First Review (hours)": opt(hoursBetween(n.created_at, firstReview), Builder.number),
          Reviews: Builder.number(p.reviews.length),
          Approvals: Builder.number(p.reviews.filter((r) => r.state === "APPROVED").length),
          "Changes Requested": Builder.number(p.reviews.filter((r) => r.state === "CHANGES_REQUESTED").length),
          "Inline Comments": Builder.number(n.review_comments ?? 0),
          Commits: Builder.number(n.commits ?? 0),
          "Files Changed": Builder.number(n.changed_files ?? p.files.length),
          Additions: Builder.number(n.additions ?? 0),
          Deletions: Builder.number(n.deletions ?? 0),
          Size: Builder.select(sizeOf(lines)),
          CI: Builder.select(p.ci ?? "none"),
          URL: Builder.url(n.html_url),
          Author: n.user?.login ? [Builder.relation(n.user.login)] : [],
          Reviewers: reviewers.map((l) => Builder.relation(l as string)),
          Issues: p.issues.map((i) => Builder.relation(String(i))),
          Release: p.release ? [Builder.relation(p.release)] : [],
          Week: merged ? [Builder.relation(weekOf(merged))] : [],
          Files: p.files.slice(0, 50).map((f) => Builder.relation(f.filename)),
        },
      }
    },
  )

  // Delivery Pulse: one row per week that has any activity.
  aggregate<string>(
    "ucWeeksSync",
    weeks,
    (s) => {
      const set = new Set<string>()
      for (const p of s.prs) {
        set.add(weekOf(p.n.created_at))
        if (p.n.merged_at) set.add(weekOf(p.n.merged_at))
      }
      for (const r of s.runs) set.add(weekOf(r.created_at))
      for (const c of s.commits) if (c.commit?.author?.date) set.add(weekOf(c.commit.author.date))
      return [...set].sort().reverse()
    },
    (w, s) => {
      const inWeek = (iso?: string | null) => Boolean(iso) && weekOf(iso as string) === w
      const merged = s.prs.filter((p) => inWeek(p.n.merged_at))
      const runs = s.runs.filter((r) => inWeek(r.created_at) && r.conclusion)
      const closed = s.issues.filter((i) => inWeek(i.closed_at))
      const label = new Date(`${w}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })
      return {
        key: w,
        properties: {
          Week: Builder.title(`Week of ${label}`),
          "Week Start": Builder.richText(w),
          "PRs Opened": Builder.number(s.prs.filter((p) => inWeek(p.n.created_at)).length),
          "PRs Merged": Builder.number(merged.length),
          Commits: Builder.number(s.commits.filter((c) => inWeek(c.commit?.author?.date)).length),
          "CI Runs": Builder.number(runs.length),
          "CI Pass %": opt(
            runs.length ? Math.round((runs.filter((r) => r.conclusion === "success").length / runs.length) * 100) : undefined,
            Builder.number,
          ),
          "Avg Cycle Time (hours)": opt(avg(merged.map((p) => hoursBetween(p.n.created_at, p.n.merged_at) ?? 0)), Builder.number),
          "Issues Closed": Builder.number(closed.length),
          "Bugs Closed": Builder.number(closed.filter((i) => (i.labels ?? []).some((l: any) => l.name === "bug")).length),
          Additions: Builder.number(merged.reduce((t, p) => t + (p.n.additions ?? 0), 0)),
          Deletions: Builder.number(merged.reduce((t, p) => t + (p.n.deletions ?? 0), 0)),
        },
      }
    },
  )

  // Release Notes: what shipped in each release.
  aggregate<any>(
    "ucReleasesSync",
    releases,
    (s) => [...s.releases].reverse(),
    (r, s) => {
      const asc = s.releases
      const idx = asc.findIndex((x) => x.id === r.id)
      const prev = idx > 0 ? asc[idx - 1] : undefined
      const published = r.published_at ?? r.created_at
      const prs = s.prs.filter((p) => p.release === r.tag_name)
      const fixed = s.issues.filter((i) => releaseOfIssue(asc, i.closed_at) === r.tag_name)
      const people = [...new Set(prs.map((p) => p.n.user?.login).filter(Boolean))]
      return {
        key: r.tag_name,
        pageContentMarkdown: [
          `## ${r.name || r.tag_name}${r.prerelease ? " (pre-release)" : ""}`,
          `\n**Published:** ${day(published)} · [View on GitHub](${r.html_url})`,
          `\n${r.body || "_No release notes._"}`,
          prs.length ? "\n### Pull requests in this release" : "",
          ...prs.map((p) => `- #${p.n.number} ${p.n.title} (${p.n.user?.login})`),
          fixed.length ? "\n### Issues fixed" : "",
          ...fixed.map((i) => `- #${i.number} ${i.title}`),
        ].join("\n"),
        properties: {
          Release: Builder.title(r.name || r.tag_name),
          Tag: Builder.richText(r.tag_name),
          Published: opt(day(published), Builder.date),
          Prerelease: Builder.checkbox(Boolean(r.prerelease)),
          "PRs Included": Builder.number(prs.length),
          "Issues Fixed Count": Builder.number(fixed.length),
          Additions: Builder.number(prs.reduce((t, p) => t + (p.n.additions ?? 0), 0)),
          Deletions: Builder.number(prs.reduce((t, p) => t + (p.n.deletions ?? 0), 0)),
          "Days Since Previous": opt(prev ? daysBetween(prev.published_at ?? prev.created_at, published) : undefined, Builder.number),
          Contributors: Builder.richText(people.join(", ")),
          URL: Builder.url(r.html_url),
        },
      }
    },
  )

  // Contributors: authors, reviewers and commit authors.
  aggregate<string>(
    "ucContributorsSync",
    contributors,
    (s) => {
      const set = new Set<string>()
      for (const p of s.prs) {
        if (p.n.user?.login) set.add(p.n.user.login)
        for (const r of p.reviews) if (r.user?.login) set.add(r.user.login)
      }
      for (const c of s.commits) if (c.author?.login) set.add(c.author.login)
      return [...set].sort()
    },
    (login, s) => {
      const authored = s.prs.filter((p) => p.n.user?.login === login)
      const merged = authored.filter((p) => p.n.merged_at)
      const given = s.prs.flatMap((p) => p.reviews.filter((r) => r.user?.login === login && p.n.user?.login !== login).map((r) => ({ r, p })))
      const turnaround = [
        ...new Set(given.map((g) => g.p.n.number)),
      ].map((num) => {
        const p = s.prs.find((x) => x.n.number === num)!
        const first = given.filter((g) => g.p.n.number === num).map((g) => g.r.submitted_at).sort()[0]
        return hoursBetween(p.n.created_at, first) ?? 0
      })
      const commits = s.commits.filter((c) => c.author?.login === login)
      const times = [
        ...authored.map((p) => p.n.updated_at),
        ...given.map((g) => g.r.submitted_at),
        ...commits.map((c) => c.commit?.author?.date),
      ].filter(Boolean) as string[]
      return {
        key: login,
        properties: {
          Contributor: Builder.title(login),
          Login: Builder.richText(login),
          "PRs Authored": Builder.number(authored.length),
          "PRs Merged": Builder.number(merged.length),
          "Reviews Given": Builder.number(given.length),
          "Approvals Given": Builder.number(given.filter((g) => g.r.state === "APPROVED").length),
          Commits: Builder.number(commits.length),
          Additions: Builder.number(authored.reduce((t, p) => t + (p.n.additions ?? 0), 0)),
          Deletions: Builder.number(authored.reduce((t, p) => t + (p.n.deletions ?? 0), 0)),
          "Avg Cycle Time (hours)": opt(avg(merged.map((p) => hoursBetween(p.n.created_at, p.n.merged_at) ?? 0)), Builder.number),
          "Avg Review Turnaround (hours)": opt(avg(turnaround), Builder.number),
          "Last Active": opt(day(times.sort().at(-1)), Builder.date),
          URL: Builder.url(`https://github.com/${login}`),
        },
      }
    },
  )

  // Issues: backlog with the pull requests that close them.
  aggregate<any>(
    "ucIssuesSync",
    issues,
    (s) => s.issues,
    (i, s) => {
      const linked = s.prs.filter((p) => p.issues.includes(i.number))
      const now = new Date().toISOString()
      const release = releaseOfIssue(s.releases, i.closed_at)
      return {
        key: String(i.number),
        pageContentMarkdown: [
          `## #${i.number} ${i.title}`,
          `\n**State:** ${i.state} · **Author:** ${i.user?.login} · [View on GitHub](${i.html_url})`,
          i.body ? `\n${clip(i.body, 1500)}` : "",
          linked.length ? "\n### Pull requests" : "",
          ...linked.map((p) => `- #${p.n.number} ${p.n.title} (${p.state})`),
        ].join("\n"),
        properties: {
          Issue: Builder.title(`#${i.number} ${i.title}`),
          Number: Builder.richText(String(i.number)),
          State: Builder.select(i.state),
          Labels: Builder.multiSelect(...(i.labels ?? []).map((l: any) => l.name)),
          Author: Builder.richText(i.user?.login ?? ""),
          Created: opt(day(i.created_at), Builder.date),
          Closed: opt(day(i.closed_at), Builder.date),
          "Age (days)": opt(i.state === "open" ? daysBetween(i.created_at, now) : undefined, Builder.number),
          "Time to Close (days)": opt(daysBetween(i.created_at, i.closed_at), Builder.number),
          Comments: Builder.number(i.comments ?? 0),
          "Linked PRs": Builder.number(linked.length),
          "Has PR": Builder.checkbox(linked.length > 0),
          URL: Builder.url(i.html_url),
          "Released In": release ? [Builder.relation(release)] : [],
        },
      }
    },
  )

  // Code Hotspots: files touched by pull requests.
  aggregate<{ path: string; prs: PR[] }>(
    "ucFilesSync",
    files,
    (s) => {
      const by = new Map<string, PR[]>()
      for (const p of s.prs) for (const f of p.files.slice(0, 50)) by.set(f.filename, [...(by.get(f.filename) ?? []), p])
      return [...by.entries()]
        .map(([path, prs]) => ({ path, prs }))
        .sort((a, b) => b.prs.length - a.prs.length)
        .slice(0, 300)
    },
    ({ path, prs }) => {
      const stats = prs.map((p) => p.files.find((f) => f.filename === path))
      const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "(root)"
      return {
        key: path,
        properties: {
          File: Builder.title(path),
          Path: Builder.richText(path),
          Directory: Builder.richText(dir),
          "PRs Touching": Builder.number(prs.length),
          Additions: Builder.number(stats.reduce((t, f) => t + (f?.additions ?? 0), 0)),
          Deletions: Builder.number(stats.reduce((t, f) => t + (f?.deletions ?? 0), 0)),
          Authors: Builder.number(new Set(prs.map((p) => p.n.user?.login)).size),
          "Last Changed": opt(day(prs.map((p) => p.n.merged_at ?? p.n.updated_at).sort().at(-1)), Builder.date),
        },
      }
    },
  )
}
