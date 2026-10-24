/** A NetSuite item -> product mapping, its source schema authored in Zod. */

import { z } from 'zod'
import { type MappingVersionInput, parseVersion } from '../../../src/mapping/document'
import { TargetSchema } from '../../../src/schema'

export const ItemSource = z
  .object({
    itemid: z
      .string()
      .min(1)
      .meta({
        'x-severity': 'block',
        'x-batch': { presence: { min: 1.0 }, distinct: { ratio: { min: 0.99 } } },
      }),
    displayname: z.string().min(1).meta({ 'x-severity': 'block' }),
    upccode: z
      .string()
      .regex(/^\d{8}$|^\d{13}$|^$/)
      .nullish()
      .meta({ 'x-severity': { default: 'warn', type: 'block' } }),
    custitem_width_mm: z.number().min(0).max(50_000).nullish().meta({ 'x-unit': 'mm' }),
    custitem_height_mm: z.number().min(0).max(50_000).nullish().meta({ 'x-unit': 'mm' }),
    custitem_length_mm: z.number().min(0).max(50_000).nullish().meta({ 'x-unit': 'mm' }),
    weight: z.number().min(0).nullish(),
    weightunit: z.enum(['kg', 'g', 'lb', 'oz']).meta({ 'x-on-new-value': 'block' }),
    custitem_launch_date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullish(),
  })
  .meta({ $id: 'netsuite.item@8' })

/** Stored verbatim as `expectedSchema.items`. */
export const itemsSchema = z.toJSONSchema(ItemSource, { io: 'input' }) as Record<string, unknown>

export const targets = TargetSchema.parse({
  name: 'Target model',
  entities: [
    {
      name: 'product',
      identity: ['sku'],
      fields: [
        { name: 'sku', logicalType: 'string', nullable: false },
        { name: 'title', logicalType: 'string', nullable: false },
        { name: 'ean', logicalType: 'string' },
        { name: 'weight', logicalType: 'decimal', unit: 'g' },
        { name: 'width', logicalType: 'decimal', unit: 'm' },
        { name: 'height', logicalType: 'decimal', unit: 'm' },
        { name: 'length', logicalType: 'decimal', unit: 'm' },
        { name: 'launch_date', logicalType: 'date' },
      ],
    },
  ],
})

const dimension = (key: string, path: string) => ({
  key,
  pipeline: [
    { op: 'extract', path },
    { op: 'if_lte', value: 0, then: null },
    { op: 'divide', by: 1000 },
  ],
})

/**
 * `launchDate` is the field's pipeline: by default it parses the date and drops placeholder
 * dates more than ten years out.
 */
export function productVersion(
  launchDate: unknown[] = [
    { op: 'extract', path: 'custitem_launch_date' },
    { op: 'to_date', format: 'YYYY-MM-DD' },
    { op: 'if_after', date: 'today+10y', then: null },
  ],
  extra: Partial<MappingVersionInput> = {},
) {
  return parseVersion({
    id: 'netsuite.item->product',
    version: 8,
    expectedSchema: { items: itemsSchema },
    nodes: [
      { id: 'items', op: 'source', system: 'netsuite', entity: 'item' },
      {
        id: 'products',
        op: 'map',
        in: 'items',
        fields: [
          { key: 'product.sku', pipeline: [{ op: 'extract', path: 'itemid' }] },
          { key: 'product.title', pipeline: [{ op: 'extract', path: 'displayname' }] },
          {
            key: 'product.ean',
            pipeline: [{ op: 'extract', path: 'upccode' }, { op: 'blank_to_null' }],
          },
          dimension('product.width', 'custitem_width_mm'),
          dimension('product.height', 'custitem_height_mm'),
          dimension('product.length', 'custitem_length_mm'),
          {
            key: 'product.weight',
            pipeline: [
              { op: 'extract', path: ['weight', 'weightunit'] },
              { op: 'convert_unit', to: 'g' },
            ],
          },
          { key: 'product.launch_date', pipeline: launchDate },
        ],
      },
      { id: 'product_out', op: 'sink', in: 'products', target: 'product', key: ['product.sku'] },
    ],
    ...extra,
  })
}
