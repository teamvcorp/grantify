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
