/** ISO 'YYYY-MM-DD' date arithmetic in whole UTC days (never local time). */

const DAY_MS = 86_400_000

export function toDays(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number]
  return Math.round(Date.UTC(y, m - 1, d) / DAY_MS)
}

export function fromDays(days: number): string {
  const date = new Date(days * DAY_MS)
  const y = date.getUTCFullYear()
  const m = date.getUTCMonth() + 1
  const d = date.getUTCDate()
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

export function addDays(iso: string, days: number): string {
  return fromDays(toDays(iso) + days)
}

/** Same calendar day `years` later; 29 February becomes 28 February. */
export function addYears(iso: string, years: number): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number]
  const year = y + years
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
  const day = m === 2 && d === 29 && !leap ? 28 : d
  return `${String(year).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}
