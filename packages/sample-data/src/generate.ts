/**
 * Deterministic generator for the Acme Outdoor sample dataset.
 *
 * `generate({ scale, seed })` returns the same tables for the same arguments, on any
 * machine: a NetSuite account (items, classes, locations, vendors, item vendors, currencies)
 * and a Snowflake inventory mart (daily stock per item, location and bin).
 *
 * The data is dirty the way real ERP data is: blank UPCs, weights in mixed units, garbage
 * dimensions (0 or negative), inactive records, and nullable fields left empty.
 */

import * as cat from './catalog'
import { addDays } from './dates'
import { type Cell, column as C, type ColumnSpec, type Dataset, type Row, TableData } from './model'
import { Rng } from './prng'

/** Items at scale 1. */
export const FULL_ITEMS = 2_000
/** Floor on the item count, so small scales still give a multi-page stock table. */
export const MIN_ITEMS = 200
export const DEFAULT_AS_OF = '2026-10-04'
/** Days of stock history up to and including `asOf`. */
export const SNAPSHOT_DAYS = 3

export const SNOWFLAKE_DATABASE = 'ANALYTICS'
export const SNOWFLAKE_SCHEMA = 'INVENTORY'
export const STOCK_SNAPSHOT = `${SNOWFLAKE_DATABASE}.${SNOWFLAKE_SCHEMA}.STOCK_SNAPSHOT`

const P_BLANK_UPC = 0.08
const P_INACTIVE_ITEM = 0.05
const P_BAD_DIMS = 0.03
const P_SECOND_VENDOR = 0.3
const P_NEGATIVE_STOCK = 0.005
/** Weight units with their relative frequency and grams per unit. */
const WEIGHT_UNITS = ['g', 'kg', 'lb', 'oz'] as const
const WEIGHT_UNIT_SHARE = [0.35, 0.2, 0.3, 0.15]
const GRAMS_PER: Record<(typeof WEIGHT_UNITS)[number], number> = {
  g: 1,
  kg: 1000,
  lb: 453.592,
  oz: 28.3495,
}

// --- column definitions --------------------------------------------------------------------

const custom = { custom: true }
const required = { nullable: false }

export const ITEM_COLUMNS: ColumnSpec[] = [
  C('id', 'BIGINT', 'integer', 'Internal ID', required),
  C('itemid', 'VARCHAR', 'string', 'Item Name/Number', required),
  C('displayname', 'VARCHAR', 'string', 'Display Name'),
  C('upccode', 'VARCHAR', 'string', 'UPC Code'),
  C('baseprice', 'DECIMAL(12,2)', 'number', 'Base Price'),
  C('cost', 'DECIMAL(12,2)', 'number', 'Purchase Price'),
  C('weight', 'DOUBLE', 'number', 'Item Weight'),
  C('weightunit', 'VARCHAR', 'string', 'Weight Units'),
  C('class', 'BIGINT', 'select', 'Class', { references: 'classification' }),
  C('isinactive', 'VARCHAR', 'boolean', 'Inactive', required),
  C('custitem_color', 'VARCHAR', 'string', 'Color', custom),
  C('custitem_launch_date', 'DATE', 'date', 'Launch Date', custom),
  C('custitem_length_mm', 'BIGINT', 'integer', 'Length (mm)', custom),
  C('custitem_width_mm', 'BIGINT', 'integer', 'Width (mm)', custom),
  C('custitem_height_mm', 'BIGINT', 'integer', 'Height (mm)', custom),
  C('custitem_case_qty', 'BIGINT', 'integer', 'Units per Case', custom),
]

export const LOCATION_COLUMNS: ColumnSpec[] = [
  C('id', 'BIGINT', 'integer', 'Internal ID', required),
  C('name', 'VARCHAR', 'string', 'Name', required),
  C('fullname', 'VARCHAR', 'string', 'Full Name'),
  C('isinactive', 'VARCHAR', 'boolean', 'Inactive', required),
  C('locationtype', 'VARCHAR', 'string', 'Location Type'),
  C('country', 'VARCHAR', 'string', 'Country'),
  C('city', 'VARCHAR', 'string', 'City'),
]

export const VENDOR_COLUMNS: ColumnSpec[] = [
  C('id', 'BIGINT', 'integer', 'Internal ID', required),
  C('entityid', 'VARCHAR', 'string', 'Vendor ID', required),
  C('companyname', 'VARCHAR', 'string', 'Company Name'),
  C('isinactive', 'VARCHAR', 'boolean', 'Inactive', required),
  C('currency', 'BIGINT', 'select', 'Currency', { references: 'currency' }),
  C('country', 'VARCHAR', 'string', 'Country'),
  C('custentity_lead_time_days', 'BIGINT', 'integer', 'Lead Time (days)', custom),
]

export const ITEMVENDOR_COLUMNS: ColumnSpec[] = [
  C('item', 'BIGINT', 'select', 'Item', { nullable: false, references: 'item' }),
  C('vendor', 'BIGINT', 'select', 'Vendor', { nullable: false, references: 'vendor' }),
  C('preferredvendor', 'VARCHAR', 'boolean', 'Preferred', required),
  C('purchaseprice', 'DECIMAL(12,2)', 'number', 'Purchase Price'),
  C('vendorcode', 'VARCHAR', 'string', 'Vendor Code'),
]

export const CLASSIFICATION_COLUMNS: ColumnSpec[] = [
  C('id', 'BIGINT', 'integer', 'Internal ID', required),
  C('name', 'VARCHAR', 'string', 'Name', required),
  C('fullname', 'VARCHAR', 'string', 'Full Name'),
  C('parent', 'BIGINT', 'select', 'Subclass of', { references: 'classification' }),
  C('isinactive', 'VARCHAR', 'boolean', 'Inactive', required),
]

export const CURRENCY_COLUMNS: ColumnSpec[] = [
  C('id', 'BIGINT', 'integer', 'Internal ID', required),
  C('symbol', 'VARCHAR', 'string', 'ISO Code', required),
  C('name', 'VARCHAR', 'string', 'Name'),
]

export const STOCK_SNAPSHOT_COLUMNS: ColumnSpec[] = [
  C('SNAPSHOT_ID', 'BIGINT', 'integer', null, required),
  C('ITEM_ID', 'BIGINT', 'integer', null, {
    nullable: false,
    description: 'NetSuite item internal id',
  }),
  C('LOCATION_ID', 'BIGINT', 'integer', null, {
    nullable: false,
    description: 'NetSuite location internal id',
  }),
  C('SNAPSHOT_DATE', 'DATE', 'date', null, required),
  C('BIN', 'VARCHAR', 'string'),
  C('ON_HAND', 'BIGINT', 'integer', null, required),
  C('RESERVED', 'BIGINT', 'integer'),
]

// --- helpers -------------------------------------------------------------------------------

interface Variant {
  product: cat.Product
  tier: (typeof cat.TIERS)[number]
  size: string
  color: (typeof cat.COLORS)[number]
}

/** Every product x tier x size x color, the first one being AO-TENT-2P-GRN. */
function universe(): Variant[] {
  const out: Variant[] = []
  for (const product of cat.PRODUCTS)
    for (const tier of cat.TIERS)
      for (const size of product.sizes)
        for (const color of cat.COLORS) out.push({ product, tier, size, color })
  const first = out.findIndex(
    (v) => v.product.code === 'TENT' && v.tier[0] === '' && v.size === '2P' && v.color[0] === 'GRN',
  )
  return [out[first] as Variant, ...out.filter((_, i) => i !== first)]
}

/** GS1 check digit for a UPC-A / EAN-13 body. */
function gs1Check(body: string): string {
  let sum = 0
  for (let i = 0; i < body.length; i++) {
    sum += Number(body[i]) * ((body.length - i) % 2 === 1 ? 3 : 1)
  }
  return String((10 - (sum % 10)) % 10)
}

const AISLES = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']
const round = (value: number, digits: number) => Number(value.toFixed(digits))
const pad = (n: number, width: number) => String(n).padStart(width, '0')

// --- generator -----------------------------------------------------------------------------

class Generator {
  readonly nItems: number
  private readonly currencyIds = new Map(cat.CURRENCIES.map(([id, code]) => [code, id]))
  /** Subclass name -> classification id; top-level name -> id. */
  private readonly classIds = new Map<string, number>()
  /** Item id -> top-level class name, for picking vendors. */
  private readonly itemParent = new Map<number, string>()

  constructor(
    readonly seed: number,
    readonly scale: number,
    readonly asOf: string,
  ) {
    this.nItems = Math.max(MIN_ITEMS, Math.round(FULL_ITEMS * scale))
  }

  /** One independent stream per table keeps tables stable when another one changes. */
  rng(stream: string): Rng {
    return new Rng(`sample-data:${this.seed}:${stream}`)
  }

  build(): Dataset {
    const netsuite: Record<string, TableData> = {}
    netsuite.currency = new TableData(
      'currency',
      CURRENCY_COLUMNS,
      cat.CURRENCIES.map((r) => [...r]),
      'Currency',
    )
    netsuite.classification = this.classifications()
    netsuite.location = this.locations()
    netsuite.vendor = this.vendors()
    const items = this.items()
    netsuite.item = items
    netsuite.itemvendor = this.itemvendors(items)
    const snowflake: Record<string, TableData> = { [STOCK_SNAPSHOT]: this.stock(items) }
    return { seed: this.seed, scale: this.scale, asOf: this.asOf, netsuite, snowflake }
  }

  // NetSuite --------------------------------------------------------------------------------

  classifications(): TableData {
    const rows: Row[] = []
    let nextId = 1
    for (const [parent, children] of cat.CLASSES) {
      const parentId = nextId++
      this.classIds.set(parent, parentId)
      rows.push([parentId, parent, parent, null, 'F'])
      for (const child of children) {
        this.classIds.set(child, nextId)
        rows.push([nextId++, child, `${parent} : ${child}`, parentId, 'F'])
      }
    }
    const [parent, child] = cat.INACTIVE_CLASS
    rows.push([nextId, child, `${parent} : ${child}`, this.classIds.get(parent) as number, 'T'])
    return new TableData('classification', CLASSIFICATION_COLUMNS, rows, 'Class')
  }

  locations(): TableData {
    const group = { Warehouse: 'Distribution', '3PL': 'Distribution', Store: 'Retail', Office: '' }
    const rows: Row[] = cat.LOCATIONS.map((loc) => [
      loc.id,
      loc.name,
      group[loc.locationtype] ? `${group[loc.locationtype]} : ${loc.name}` : loc.name,
      loc.inactive ? 'T' : 'F',
      loc.locationtype,
      loc.country,
      loc.city,
    ])
    return new TableData('location', LOCATION_COLUMNS, rows, 'Location')
  }

  vendors(): TableData {
    const rows: Row[] = cat.VENDORS.map((v) => [
      v.id,
      `V${pad(v.id - 2000, 5)}`,
      v.companyname,
      v.inactive ? 'T' : 'F',
      this.currencyIds.get(v.currency) as number,
      v.country,
      v.leadTimeDays,
    ])
    return new TableData('vendor', VENDOR_COLUMNS, rows, 'Vendor')
  }

  items(): TableData {
    const rng = this.rng('items')
    const all = universe()
    const order = [all[0] as Variant, ...rng.shuffle(all.slice(1))]
    const parentOf = new Map(cat.CLASSES.flatMap(([p, children]) => children.map((c) => [c, p])))
    const rows: Row[] = []
    let id = 1000
    for (let i = 0; i < this.nItems; i++) {
      id += rng.choice([1, 1, 1, 2, 3, 7])
      const v = order[i % order.length] as Variant
      const generation = Math.floor(i / order.length) + 1
      this.itemParent.set(id, parentOf.get(v.product.subclass) as string)
      rows.push(this.itemRow(rng, v, id, i, generation))
    }
    return new TableData('item', ITEM_COLUMNS, rows, 'Item')
  }

  private itemRow(rng: Rng, v: Variant, id: number, index: number, generation: number): Row {
    const { product, size } = v
    const [tier, priceFactor, weightFactor] = v.tier
    const [colorCode, colorName] = v.color
    const suffix = generation > 1 ? `-V${generation}` : ''
    const sku = ['AO', product.code, tier, size, colorCode].filter(Boolean).join('-') + suffix
    const title = ['Acme', product.name, tier && tier[0] + tier.slice(1).toLowerCase(), size]
      .filter(Boolean)
      .join(' ')
    const displayname = `${title} ${colorName}${generation > 1 ? ` V${generation}` : ''}`

    let upc = ''
    if (rng.random() >= P_BLANK_UPC) {
      const body = rng.random() < 0.7 ? `08461${pad(index, 6)}` : `506123${pad(index, 6)}`
      upc = body + gs1Check(body)
    }

    const price = Math.floor(rng.uniform(...product.price) * priceFactor) + 0.99
    const cost = rng.random() < 0.03 ? null : round(price * rng.uniform(0.38, 0.55), 2)

    const grams = rng.uniform(...product.grams) * weightFactor
    const unit = rng.choices(WEIGHT_UNITS, WEIGHT_UNIT_SHARE)
    const digits = { g: 0, kg: 3, lb: 2, oz: 1 }[unit]
    const weight = rng.random() < 0.01 ? null : round(grams / GRAMS_PER[unit], digits)

    const dims: Cell[] = product.dims.map((d) => Math.round(d * rng.uniform(0.9, 1.1)))
    if (rng.random() < P_BAD_DIMS) {
      dims[rng.randrange(3)] = rng.choice([0, 0, -1, -rng.randint(10, 400)])
    }

    let launch: string | null = null
    if (rng.random() >= 0.12) {
      launch =
        rng.random() < 0.03
          ? addDays(this.asOf, rng.randint(1, 120))
          : addDays(this.asOf, -rng.randint(0, 6 * 365))
    }

    return [
      id,
      sku,
      rng.random() < 0.01 ? null : displayname,
      upc,
      price,
      cost,
      weight,
      unit,
      this.classIds.get(product.subclass) as number,
      rng.random() < P_INACTIVE_ITEM ? 'T' : 'F',
      colorName,
      launch,
      ...dims,
      rng.random() < 0.25 ? null : rng.choice([1, 2, 4, 6, 8, 12, 24]),
    ]
  }

  itemvendors(items: TableData): TableData {
    const rng = this.rng('itemvendor')
    const pools = new Map<string, cat.Vendor[]>()
    for (const v of cat.VENDORS) pools.set(v.supplies, [...(pools.get(v.supplies) ?? []), v])
    const [iId, iPrice, iCost] = ['id', 'baseprice', 'cost'].map((n) => items.index(n))
    const rows: Row[] = []
    for (const item of items.rows) {
      const id = item[iId as number] as number
      const pool = pools.get(this.itemParent.get(id) as string) as cat.Vendor[]
      const cost =
        (item[iCost as number] as number | null) ?? (item[iPrice as number] as number) * 0.45
      const vendors = rng.sample(pool, rng.random() < P_SECOND_VENDOR ? 2 : 1)
      vendors.forEach((vendor, i) => {
        const initials = vendor.companyname.replace(/[^A-Z]/g, '').slice(0, 3)
        rows.push([
          id,
          vendor.id,
          i === 0 ? 'T' : 'F',
          rng.random() < 0.05 ? null : round(cost * rng.uniform(0.92, 1.08), 2),
          rng.random() < 0.1 ? null : `${initials}-${rng.randint(10_000, 99_999)}`,
        ])
      })
    }
    return new TableData('itemvendor', ITEMVENDOR_COLUMNS, rows, 'Item Vendor')
  }

  // Snowflake -------------------------------------------------------------------------------

  stock(items: TableData): TableData {
    const rng = this.rng('stock')
    const [iId, iInactive] = ['id', 'isinactive'].map((n) => items.index(n))
    // Each active item sits in 2-4 locations, each spread over 1-3 bins.
    const slots: { item: number; location: number; bin: string | null; base: number }[] = []
    for (const item of items.rows) {
      if (item[iInactive as number] === 'T') continue
      const locations = rng.sample(cat.STOCK_LOCATIONS, rng.randint(2, 4)).sort((a, b) => a - b)
      for (const location of locations) {
        const bins = new Set<string>()
        const n = rng.choices([1, 2, 3], [0.6, 0.3, 0.1])
        while (bins.size < n) {
          bins.add(
            `${rng.choice(AISLES)}-${pad(rng.randint(1, 40), 2)}-${pad(rng.randint(1, 6), 2)}`,
          )
        }
        for (const bin of bins) {
          slots.push({
            item: item[iId as number] as number,
            location,
            bin: rng.random() < 0.02 ? null : bin,
            base: Math.round(rng.triangular(0, 400, 40)),
          })
        }
      }
    }
    const rows: Row[] = []
    for (let day = SNAPSHOT_DAYS - 1; day >= 0; day--) {
      const date = addDays(this.asOf, -day)
      for (const s of slots) {
        const onHand =
          rng.random() < P_NEGATIVE_STOCK
            ? -rng.randint(1, 20)
            : Math.max(0, s.base + rng.randint(-15, 15))
        const reserved = rng.random() < 0.1 ? null : rng.randint(0, Math.max(0, onHand) >> 2)
        rows.push([rows.length + 1, s.item, s.location, date, s.bin, onHand, reserved])
      }
    }
    return new TableData(
      STOCK_SNAPSHOT,
      STOCK_SNAPSHOT_COLUMNS,
      rows,
      null,
      'Daily on-hand stock per item, location and bin.',
    )
  }
}

export interface GenerateOptions {
  scale?: number
  seed?: number
  /** 'today' for the generator, ISO date. */
  asOf?: string
}

/** Build the Acme Outdoor dataset. Deterministic in (scale, seed, asOf). */
export function generate({
  scale = 1,
  seed = 42,
  asOf = DEFAULT_AS_OF,
}: GenerateOptions = {}): Dataset {
  if (!(scale > 0)) throw new RangeError('scale must be positive')
  return new Generator(seed, scale, asOf).build()
}
