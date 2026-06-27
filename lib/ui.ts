/**
 * Map domain values to Catalyst Badge colors so chips carry meaning at a glance.
 * Return types are the exact Catalyst color keys so `<Badge color={...}>` type-checks.
 */

export function funderColor(
  type: string
): 'blue' | 'violet' | 'amber' | 'zinc' {
  switch (type) {
    case 'federal':
      return 'blue'
    case 'foundation':
      return 'violet'
    case 'state':
      return 'amber'
    default:
      return 'zinc'
  }
}

export function statusColor(
  status: string
): 'zinc' | 'amber' | 'sky' | 'indigo' | 'emerald' | 'red' {
  switch (status) {
    case 'reviewing':
      return 'amber'
    case 'active':
      return 'sky'
    case 'submitted':
      return 'indigo'
    case 'awarded':
      return 'emerald'
    case 'rejected':
      return 'red'
    default:
      return 'zinc' // discovered / archived
  }
}

/**
 * Read a fetch Response as JSON, but tolerate a non-JSON body (e.g. a platform
 * 5xx/timeout page). Throws a readable error instead of a cryptic JSON parse
 * error so the UI can show what actually happened.
 */
export async function readApiJson<T = unknown>(res: Response, label = 'Request'): Promise<T> {
  const text = await res.text()
  let data: unknown = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = null
  }
  if (!res.ok || data === null) {
    const fromBody =
      data && typeof data === 'object' && 'error' in data
        ? String((data as { error: unknown }).error)
        : ''
    const timeout = res.status === 504 ? ' — the request timed out' : ''
    throw new Error(fromBody || `${label} failed (HTTP ${res.status})${timeout}.`)
  }
  return data as T
}

export function sourceColor(source: string): 'emerald' | 'blue' | 'zinc' {
  switch (source) {
    case 'kb':
      return 'emerald'
    case 'ai':
      return 'blue'
    default:
      return 'zinc' // team / empty
  }
}
