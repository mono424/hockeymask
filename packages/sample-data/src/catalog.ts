/**
 * Static reference data for Acme Outdoor, the fictional outdoor-gear retailer behind the
 * sample dataset: currencies, classes, locations, vendors and the product range that item
 * SKUs are drawn from.
 */

/** [internal id, ISO code, name] */
export const CURRENCIES: readonly (readonly [number, string, string])[] = [
  [1, 'USD', 'US Dollar'],
  [2, 'EUR', 'Euro'],
  [3, 'GBP', 'British Pound'],
  [4, 'CAD', 'Canadian Dollar'],
]

/** Top-level class -> its subclasses. Ids are assigned in this order, parents first. */
export const CLASSES: readonly (readonly [string, readonly string[]])[] = [
  ['Camping', ['Tents', 'Sleeping Bags', 'Cooking']],
  ['Apparel', ['Jackets', 'Base Layers', 'Pants']],
  ['Footwear', ['Hiking Boots', 'Trail Runners', 'Sandals']],
  ['Climbing', ['Harnesses', 'Ropes', 'Hardware']],
  ['Accessories', ['Backpacks', 'Headlamps', 'Bottles']],
]

/** A retired subclass: present in NetSuite, inactive, no items. */
export const INACTIVE_CLASS: readonly [string, string] = ['Camping', 'Hammocks']

export interface Location {
  id: number
  name: string
  locationtype: 'Warehouse' | 'Store' | '3PL' | 'Office'
  country: string
  city: string
  inactive: boolean
}

export const LOCATIONS: readonly Location[] = [
  {
    id: 1,
    name: 'Reno DC',
    locationtype: 'Warehouse',
    country: 'US',
    city: 'Reno',
    inactive: false,
  },
  {
    id: 2,
    name: 'Columbus DC',
    locationtype: 'Warehouse',
    country: 'US',
    city: 'Columbus',
    inactive: false,
  },
  {
    id: 3,
    name: 'Rotterdam DC',
    locationtype: 'Warehouse',
    country: 'NL',
    city: 'Rotterdam',
    inactive: false,
  },
  { id: 4, name: 'Leeds 3PL', locationtype: '3PL', country: 'GB', city: 'Leeds', inactive: false },
  {
    id: 5,
    name: 'Toronto 3PL',
    locationtype: '3PL',
    country: 'CA',
    city: 'Toronto',
    inactive: false,
  },
  {
    id: 6,
    name: 'Denver Store',
    locationtype: 'Store',
    country: 'US',
    city: 'Denver',
    inactive: false,
  },
  {
    id: 7,
    name: 'Portland Store',
    locationtype: 'Store',
    country: 'US',
    city: 'Portland',
    inactive: false,
  },
  {
    id: 8,
    name: 'Seattle HQ',
    locationtype: 'Office',
    country: 'US',
    city: 'Seattle',
    inactive: false,
  },
  {
    id: 9,
    name: 'Memphis DC',
    locationtype: 'Warehouse',
    country: 'US',
    city: 'Memphis',
    inactive: true,
  },
]

/** Locations that hold stock in the inventory snapshot: active warehouses and 3PLs. */
export const STOCK_LOCATIONS: readonly number[] = LOCATIONS.filter(
  (l) => !l.inactive && (l.locationtype === 'Warehouse' || l.locationtype === '3PL'),
).map((l) => l.id)

export interface Vendor {
  id: number
  companyname: string
  /** ISO code, resolved to the currency's internal id. */
  currency: string
  country: string
  leadTimeDays: number | null
  /** Top-level class this vendor supplies. */
  supplies: string
  inactive: boolean
}

const VENDOR_ROWS: readonly (readonly [string, string, string, number | null, string])[] = [
  ['Summit Shelter Co.', 'USD', 'US', 45, 'Camping'],
  ['Northwind Tents Ltd.', 'GBP', 'GB', 60, 'Camping'],
  ['Pinecone Down Works', 'CAD', 'CA', 50, 'Camping'],
  ['Basecamp Metalware', 'USD', 'US', 30, 'Camping'],
  ['Granite Peak Supply', 'USD', 'US', null, 'Camping'],
  ['Cascade Apparel Inc.', 'USD', 'US', 75, 'Apparel'],
  ['Fjord Textiles AS', 'EUR', 'NO', 90, 'Apparel'],
  ['Merino Mills Pty', 'USD', 'AU', 120, 'Apparel'],
  ['Redwood Garment Co.', 'USD', 'US', 40, 'Apparel'],
  ['Atlas Knitwear', 'EUR', 'PT', null, 'Apparel'],
  ['Trailhead Footwear', 'USD', 'US', 80, 'Footwear'],
  ['Dolomiti Calzature', 'EUR', 'IT', 100, 'Footwear'],
  ['Ridgeline Shoe Co.', 'USD', 'VN', 110, 'Footwear'],
  ['Coastal Sandal Works', 'USD', 'US', 35, 'Footwear'],
  ['Highline Ropes', 'EUR', 'CZ', 70, 'Climbing'],
  ['Crag & Chalk Ltd.', 'GBP', 'GB', 55, 'Climbing'],
  ['Vertical Hardware', 'USD', 'US', 45, 'Climbing'],
  ['Bouldertown Supply', 'USD', 'US', null, 'Climbing'],
  ['Wayfarer Packs', 'USD', 'US', 60, 'Accessories'],
  ['Lumen Optics Co.', 'USD', 'TW', 85, 'Accessories'],
  ['Evergreen Bottle Co.', 'CAD', 'CA', 40, 'Accessories'],
  ['Meridian Bags', 'EUR', 'DE', 65, 'Accessories'],
  ['Polar Goods Trading', 'USD', 'CN', 95, 'Accessories'],
  ['Westward Outfitters', 'USD', 'US', 30, 'Apparel'],
  ['Old Mill Canvas', 'USD', 'US', null, 'Camping'],
]

const INACTIVE_VENDORS = new Set([2018, 2025])

export const VENDORS: readonly Vendor[] = VENDOR_ROWS.map(
  ([companyname, currency, country, leadTimeDays, supplies], i) => ({
    id: 2001 + i,
    companyname,
    currency,
    country,
    leadTimeDays,
    supplies,
    inactive: INACTIVE_VENDORS.has(2001 + i),
  }),
)

/** [SKU code, display name] */
export const COLORS: readonly (readonly [string, string])[] = [
  ['GRN', 'Green'],
  ['BLU', 'Blue'],
  ['BLK', 'Black'],
  ['RED', 'Red'],
  ['ORG', 'Orange'],
  ['GRY', 'Grey'],
  ['YEL', 'Yellow'],
  ['OLV', 'Olive'],
  ['NVY', 'Navy'],
  ['TAN', 'Tan'],
]

/** Product tiers: [SKU / display suffix, price factor, weight factor]. */
export const TIERS: readonly (readonly [string, number, number])[] = [
  ['', 1, 1],
  ['LITE', 0.8, 0.8],
  ['PRO', 1.35, 1.1],
]

export interface Product {
  code: string
  name: string
  /** Subclass name (see `CLASSES`). */
  subclass: string
  sizes: readonly string[]
  /** Base price range in USD. */
  price: readonly [number, number]
  /** Weight range in grams. */
  grams: readonly [number, number]
  /** Typical packed length, width, height in mm. */
  dims: readonly [number, number, number]
}

const APPAREL = ['XS', 'S', 'M', 'L', 'XL']
const SHOES = ['7', '8', '9', '10', '11', '12', '13']

export const PRODUCTS: readonly Product[] = [
  {
    code: 'TENT',
    name: 'Trail Tent',
    subclass: 'Tents',
    sizes: ['1P', '2P', '3P', '4P'],
    price: [180, 520],
    grams: [1100, 3800],
    dims: [500, 180, 180],
  },
  {
    code: 'TARP',
    name: 'Camp Tarp',
    subclass: 'Tents',
    sizes: ['S', 'L'],
    price: [60, 140],
    grams: [350, 900],
    dims: [300, 120, 100],
  },
  {
    code: 'BAG',
    name: 'Down Sleeping Bag',
    subclass: 'Sleeping Bags',
    sizes: ['REG', 'LONG'],
    price: [220, 480],
    grams: [800, 1600],
    dims: [400, 220, 220],
  },
  {
    code: 'QUILT',
    name: 'Camp Quilt',
    subclass: 'Sleeping Bags',
    sizes: ['REG', 'LONG'],
    price: [150, 320],
    grams: [550, 1000],
    dims: [350, 200, 200],
  },
  {
    code: 'STOVE',
    name: 'Canister Stove',
    subclass: 'Cooking',
    sizes: [''],
    price: [45, 120],
    grams: [80, 400],
    dims: [120, 90, 90],
  },
  {
    code: 'POT',
    name: 'Titanium Pot',
    subclass: 'Cooking',
    sizes: ['750ML', '1100ML'],
    price: [35, 75],
    grams: [100, 200],
    dims: [140, 120, 120],
  },
  {
    code: 'JKT-RAIN',
    name: 'Rain Jacket',
    subclass: 'Jackets',
    sizes: APPAREL,
    price: [120, 380],
    grams: [250, 520],
    dims: [350, 280, 60],
  },
  {
    code: 'JKT-DOWN',
    name: 'Down Jacket',
    subclass: 'Jackets',
    sizes: APPAREL,
    price: [180, 420],
    grams: [300, 700],
    dims: [380, 300, 90],
  },
  {
    code: 'BASE-MER',
    name: 'Merino Base Layer',
    subclass: 'Base Layers',
    sizes: APPAREL,
    price: [60, 130],
    grams: [150, 260],
    dims: [300, 240, 30],
  },
  {
    code: 'PANT-HIKE',
    name: 'Hiking Pants',
    subclass: 'Pants',
    sizes: APPAREL,
    price: [70, 160],
    grams: [280, 450],
    dims: [350, 280, 40],
  },
  {
    code: 'BOOT-MID',
    name: 'Mid Hiking Boot',
    subclass: 'Hiking Boots',
    sizes: SHOES,
    price: [140, 280],
    grams: [900, 1400],
    dims: [330, 220, 130],
  },
  {
    code: 'SHOE-TRL',
    name: 'Trail Runner',
    subclass: 'Trail Runners',
    sizes: SHOES,
    price: [110, 190],
    grams: [550, 800],
    dims: [320, 200, 120],
  },
  {
    code: 'SNDL',
    name: 'Sport Sandal',
    subclass: 'Sandals',
    sizes: SHOES.slice(0, 6),
    price: [50, 110],
    grams: [400, 650],
    dims: [300, 180, 90],
  },
  {
    code: 'HRNS',
    name: 'Climbing Harness',
    subclass: 'Harnesses',
    sizes: ['XS', 'S', 'M', 'L'],
    price: [60, 150],
    grams: [280, 450],
    dims: [250, 200, 80],
  },
  {
    code: 'ROPE-DYN',
    name: 'Dynamic Rope 9.5mm',
    subclass: 'Ropes',
    sizes: ['40M', '60M', '70M'],
    price: [140, 320],
    grams: [2400, 4300],
    dims: [400, 400, 150],
  },
  {
    code: 'CRAB',
    name: 'Locking Carabiner',
    subclass: 'Hardware',
    sizes: ['', '3PK'],
    price: [12, 40],
    grams: [45, 180],
    dims: [120, 70, 20],
  },
  {
    code: 'PACK',
    name: 'Day Pack',
    subclass: 'Backpacks',
    sizes: ['20L', '30L'],
    price: [70, 160],
    grams: [500, 1100],
    dims: [480, 300, 180],
  },
  {
    code: 'PACK-EXP',
    name: 'Expedition Pack',
    subclass: 'Backpacks',
    sizes: ['55L', '65L'],
    price: [220, 420],
    grams: [1600, 2400],
    dims: [750, 350, 250],
  },
  {
    code: 'LAMP',
    name: 'Headlamp',
    subclass: 'Headlamps',
    sizes: ['300LM', '500LM'],
    price: [30, 90],
    grams: [60, 120],
    dims: [110, 80, 60],
  },
  {
    code: 'BTL',
    name: 'Insulated Bottle',
    subclass: 'Bottles',
    sizes: ['500ML', '1L'],
    price: [25, 50],
    grams: [280, 500],
    dims: [260, 80, 80],
  },
]
