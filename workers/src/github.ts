/** Minimal GitHub REST client. Token and repo come from worker env vars. */

export const REPO = process.env.GITHUB_REPO ?? "satoshi-notion/Lumi-Labs-Demo"

export async function gh<T>(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const token = process.env.GITHUB_TOKEN
  if (!token) throw new Error("GITHUB_TOKEN is not set (ntn workers env set GITHUB_TOKEN=...)")

  const res = await fetch(`https://api.github.com/repos/${REPO}${path}`, {
    method: init.method ?? "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  })
  if (!res.ok) throw new Error(`GitHub ${res.status} on ${path}: ${await res.text()}`)
  return (await res.json()) as T
}

/** Fetch one page of a list endpoint. Returns items and whether more pages exist. */
export async function ghPage<T>(path: string, page: number, key?: string) {
  const sep = path.includes("?") ? "&" : "?"
  const data = await gh<any>(`${path}${sep}per_page=50&page=${page}`)
  const items: T[] = key ? data[key] : data
  return { items, hasMore: items.length === 50 }
}
