/** Minimal Jira Cloud REST client. Site, email and API token come from worker env vars. */

export const BASE_URL = (process.env.JIRA_BASE_URL ?? "https://notionsmltesting.atlassian.net").replace(/\/$/, "")

export async function jira<T>(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const email = process.env.JIRA_EMAIL
  const token = process.env.JIRA_API_TOKEN
  if (!email || !token) {
    throw new Error("JIRA_EMAIL / JIRA_API_TOKEN are not set (ntn workers env set ...)")
  }

  const res = await fetch(`${BASE_URL}${path}`, {
    method: init.method ?? "GET",
    headers: {
      Authorization: `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  })
  if (!res.ok) throw new Error(`Jira ${res.status} on ${path}: ${await res.text()}`)
  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

/** Atlassian Document Format -> Markdown-ish plain text. */
export function adfToText(node: any): string {
  if (!node) return ""
  if (typeof node === "string") return node
  const kids = (node.content ?? []).map(adfToText)
  switch (node.type) {
    case "text":
      return node.text ?? ""
    case "hardBreak":
      return "\n"
    case "paragraph":
    case "heading":
      return kids.join("") + "\n\n"
    case "bulletList":
    case "orderedList":
      return kids.join("") + "\n"
    case "listItem":
      return "- " + kids.join("").trim() + "\n"
    case "codeBlock":
      return "```\n" + kids.join("") + "\n```\n\n"
    case "mention":
      return node.attrs?.text ?? ""
    default:
      return kids.join("")
  }
}

/** Wrap plain text in a minimal ADF document (for comments and descriptions). */
export function textToAdf(text: string) {
  return {
    type: "doc",
    version: 1,
    content: text
      .split(/\n{2,}/)
      .map((p) => ({ type: "paragraph", content: [{ type: "text", text: p }] })),
  }
}

export interface IssueRef {
  id: string
  key: string
  fields: { summary?: string; status?: { name: string }; project?: { key: string } }
}

/** One page of issues from a JQL search. Token-based pagination. */
export async function searchIssues(jql: string, nextPageToken?: string, maxResults = 10) {
  const qs = new URLSearchParams({ jql, maxResults: String(maxResults), fields: "summary,status,project" })
  if (nextPageToken) qs.set("nextPageToken", nextPageToken)
  const data = await jira<{ issues: IssueRef[]; nextPageToken?: string }>(`/rest/api/3/search/jql?${qs}`)
  return { issues: data.issues, nextPageToken: data.nextPageToken }
}
