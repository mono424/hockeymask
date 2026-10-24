export function formatCount(n: number | null | undefined): string {
  return n === null || n === undefined ? '—' : n.toLocaleString('en-US')
}

/** 'ANALYTICS.INVENTORY.STOCK_SNAPSHOT' -> 'STOCK_SNAPSHOT'. */
export function shortTableName(name: string): string {
  return name.split('.').pop() ?? name
}
