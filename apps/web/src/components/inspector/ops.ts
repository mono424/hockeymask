/**
 * The record ops a field pipeline can use, as the inspector presents them: a plain-language
 * label, a group for the step picker, the step a new one starts as, and how each param is
 * edited. Ops and params are the engine's (see docs/operators.md); this is presentation.
 */

export type ParamKind =
  /** One field of the record. */
  | 'field'
  /** One field, or several for a tuple (`extract`). */
  | 'fieldOrFields'
  /** Several fields, in order (`coalesce`). */
  | 'fields'
  | 'text'
  | 'number'
  | 'integer'
  | 'switch'
  /** A JSON literal: text, number, true, false or null. */
  | 'literal'
  | 'unit'
  | 'dateFormat'
  | 'duration'
  | 'timeZone'
  /** A condition on the piped value (and fields of the record). */
  | 'cond'
  | 'lookupTable'
  /** A literal, a field (`{ ref }`) or a version param (`{ param }`). */
  | 'operand'

export interface ParamSpec {
  readonly key: string
  readonly label: string
  readonly kind: ParamKind
  readonly placeholder?: string
  readonly hint?: string
  readonly optional?: boolean
  readonly options?: readonly { value: string; label: string }[]
}

export interface OpInfo {
  readonly op: string
  readonly label: string
  readonly group: OpGroup
  readonly summary: string
  readonly make: () => Record<string, unknown>
  readonly params: readonly ParamSpec[]
  /** Starts a pipeline (reads the record, takes no piped value). */
  readonly entry?: boolean
}

export const OP_GROUPS = [
  'Read',
  'Missing values',
  'Convert',
  'Numbers',
  'Text',
  'Dates',
  'Decide',
  'Lists',
  'Look up',
  'Code',
] as const
export type OpGroup = (typeof OP_GROUPS)[number]

const UNITS = ['mg', 'g', 'kg', 't', 'oz', 'lb', 'mm', 'cm', 'm', 'km', 'in', 'ft', 'ml', 'l', 'm3']
const unitOptions = UNITS.map((u) => ({ value: u, label: u }))

const p = (
  key: string,
  label: string,
  kind: ParamKind,
  extra: Partial<ParamSpec> = {},
): ParamSpec => ({
  key,
  label,
  kind,
  ...extra,
})

const OPS: readonly OpInfo[] = [
  // Read
  {
    op: 'extract',
    label: 'Read field',
    group: 'Read',
    summary: 'Read a field of the record; several fields make a tuple.',
    entry: true,
    make: () => ({ path: '' }),
    params: [p('path', 'Field', 'fieldOrFields')],
  },
  {
    op: 'const',
    label: 'Fixed value',
    group: 'Read',
    summary: 'Always the same value.',
    entry: true,
    make: () => ({ value: '' }),
    params: [p('value', 'Value', 'literal')],
  },
  {
    op: 'coalesce',
    label: 'First present',
    group: 'Read',
    summary: 'The first of several fields that is not empty.',
    entry: true,
    make: () => ({ paths: [] }),
    params: [p('paths', 'Fields, in order', 'fields')],
  },
  // Missing values
  {
    op: 'blank_to_null',
    label: 'Blank to empty',
    group: 'Missing values',
    summary: 'Treat a blank or whitespace-only text as empty.',
    make: () => ({}),
    params: [],
  },
  {
    op: 'default',
    label: 'Default',
    group: 'Missing values',
    summary: 'Use a fixed value when empty.',
    make: () => ({ value: '' }),
    params: [p('value', 'Value', 'literal')],
  },
  {
    op: 'require',
    label: 'Require',
    group: 'Missing values',
    summary: 'Fail the record when empty.',
    make: () => ({}),
    params: [
      p('message', 'Message', 'text', { optional: true, placeholder: 'required value is null' }),
    ],
  },
  {
    op: 'omit_if_null',
    label: 'Leave out if empty',
    group: 'Missing values',
    summary: 'Do not write the field at all when empty. Must be the last step.',
    make: () => ({}),
    params: [],
  },
  // Convert
  {
    op: 'to_number',
    label: 'To number',
    group: 'Convert',
    summary: 'Parse a number from text.',
    make: () => ({}),
    params: [
      p('strict', 'Fail on text that is not a number', 'switch', {
        hint: 'Off: such text becomes empty.',
      }),
    ],
  },
  {
    op: 'to_string',
    label: 'To text',
    group: 'Convert',
    summary: 'Write any value as text.',
    make: () => ({}),
    params: [p('format', 'Date format', 'dateFormat', { optional: true, hint: 'Only for dates.' })],
  },
  {
    op: 'to_bool',
    label: 'To yes / no',
    group: 'Convert',
    summary: 'Only the listed values convert; anything else fails.',
    make: () => ({ true_values: ['T'], false_values: ['F'] }),
    params: [
      p('true_values', 'Yes values', 'text', { placeholder: 'true, 1' }),
      p('false_values', 'No values', 'text', { placeholder: 'false, 0' }),
    ],
  },
  {
    op: 'to_date',
    label: 'To date',
    group: 'Convert',
    summary: 'Parse a date from text or an epoch number.',
    make: () => ({ format: 'YYYY-MM-DD' }),
    params: [
      p('format', 'Format', 'dateFormat'),
      p('tz', 'Time zone', 'timeZone', { optional: true, placeholder: 'Run time zone' }),
    ],
  },
  {
    op: 'assert_type',
    label: 'Check type',
    group: 'Convert',
    summary: 'A checkpoint for the type checker; does nothing at runtime.',
    make: () => ({ type: 'string' }),
    params: [p('type', 'Type', 'text', { placeholder: 'number?' })],
  },
  // Numbers
  {
    op: 'add',
    label: 'Add',
    group: 'Numbers',
    summary: 'Add a constant.',
    make: () => ({ value: 0 }),
    params: [p('value', 'Value', 'number')],
  },
  {
    op: 'subtract',
    label: 'Subtract',
    group: 'Numbers',
    summary: 'Subtract a constant.',
    make: () => ({ value: 0 }),
    params: [p('value', 'Value', 'number')],
  },
  {
    op: 'multiply',
    label: 'Multiply',
    group: 'Numbers',
    summary: 'Multiply by a constant.',
    make: () => ({ by: 1 }),
    params: [p('by', 'By', 'number')],
  },
  {
    op: 'divide',
    label: 'Divide',
    group: 'Numbers',
    summary: 'Divide by a constant (never zero).',
    make: () => ({ by: 1000 }),
    params: [p('by', 'By', 'number')],
  },
  {
    op: 'round',
    label: 'Round',
    group: 'Numbers',
    summary: 'Round to a number of decimals.',
    make: () => ({}),
    params: [
      p('precision', 'Decimals', 'integer', { optional: true, placeholder: '0' }),
      p('mode', 'Mode', 'text', {
        optional: true,
        options: [
          { value: 'half_up', label: 'Half up' },
          { value: 'half_even', label: 'Half even' },
          { value: 'floor', label: 'Down' },
          { value: 'ceil', label: 'Up' },
        ],
      }),
    ],
  },
  {
    op: 'abs',
    label: 'Absolute',
    group: 'Numbers',
    summary: 'Drop the sign.',
    make: () => ({}),
    params: [],
  },
  {
    op: 'clamp',
    label: 'Clamp',
    group: 'Numbers',
    summary: 'Keep within a minimum and maximum.',
    make: () => ({ min: 0 }),
    params: [
      p('min', 'Minimum', 'number', { optional: true }),
      p('max', 'Maximum', 'number', { optional: true }),
    ],
  },
  {
    op: 'convert_unit',
    label: 'Convert unit',
    group: 'Numbers',
    summary: 'Mass, length or volume. The unit comes from a read field, or from "From".',
    make: () => ({ to: 'g' }),
    params: [
      p('to', 'To', 'unit', { options: unitOptions }),
      p('from', 'From', 'unit', {
        optional: true,
        options: unitOptions,
        hint: 'Leave empty when the unit is the second read field.',
      }),
    ],
  },
  // Text
  {
    op: 'trim',
    label: 'Trim',
    group: 'Text',
    summary: 'Remove surrounding whitespace, or the given characters.',
    make: () => ({}),
    params: [p('chars', 'Characters', 'text', { optional: true, placeholder: 'whitespace' })],
  },
  {
    op: 'lower',
    label: 'Lowercase',
    group: 'Text',
    summary: 'All lowercase.',
    make: () => ({}),
    params: [],
  },
  {
    op: 'upper',
    label: 'Uppercase',
    group: 'Text',
    summary: 'All uppercase.',
    make: () => ({}),
    params: [],
  },
  {
    op: 'truncate',
    label: 'Shorten',
    group: 'Text',
    summary: 'Cut to a maximum length.',
    make: () => ({ length: 80 }),
    params: [p('length', 'Length', 'integer'), p('ellipsis', 'End with …', 'switch')],
  },
  {
    op: 'pad',
    label: 'Pad',
    group: 'Text',
    summary: 'Fill to a fixed width, e.g. zero-padded SKUs.',
    make: () => ({ length: 8, with: '0', side: 'left' }),
    params: [
      p('length', 'Length', 'integer'),
      p('with', 'With', 'text'),
      p('side', 'Side', 'text', {
        options: [
          { value: 'left', label: 'Left' },
          { value: 'right', label: 'Right' },
        ],
      }),
    ],
  },
  {
    op: 'replace',
    label: 'Replace',
    group: 'Text',
    summary: 'Replace every occurrence.',
    make: () => ({ pattern: '', with: '' }),
    params: [
      p('pattern', 'Find', 'text'),
      p('with', 'Replace with', 'text', { placeholder: 'nothing' }),
      p('regex', 'Regular expression', 'switch'),
    ],
  },
  {
    op: 'regex_extract',
    label: 'Extract pattern',
    group: 'Text',
    summary: 'The first match of a regular expression; empty if none.',
    make: () => ({ pattern: '' }),
    params: [
      p('pattern', 'Pattern', 'text', { placeholder: '\\d+' }),
      p('group', 'Capture group', 'integer', { optional: true, placeholder: '0' }),
    ],
  },
  {
    op: 'split',
    label: 'Split',
    group: 'Text',
    summary: 'Split text into a list.',
    make: () => ({ separator: ',' }),
    params: [
      p('separator', 'Separator', 'text'),
      p('limit', 'At most', 'integer', { optional: true, placeholder: 'no limit' }),
    ],
  },
  {
    op: 'join',
    label: 'Join list',
    group: 'Text',
    summary: 'Join a list of texts into one.',
    make: () => ({ separator: ', ' }),
    params: [p('separator', 'Separator', 'text')],
  },
  {
    op: 'concat',
    label: 'Combine fields',
    group: 'Text',
    summary: 'Join the fields of a multi-field read.',
    make: () => ({ separator: ' ' }),
    params: [p('separator', 'Separator', 'text', { optional: true, placeholder: 'nothing' })],
  },
  {
    op: 'slug',
    label: 'Slug',
    group: 'Text',
    summary: 'URL-safe lowercase form.',
    make: () => ({}),
    params: [p('separator', 'Separator', 'text', { optional: true, placeholder: '-' })],
  },
  // Dates
  {
    op: 'format_date',
    label: 'Format date',
    group: 'Dates',
    summary: 'Write a date as text.',
    make: () => ({ format: 'YYYY-MM-DD' }),
    params: [
      p('format', 'Format', 'dateFormat'),
      p('tz', 'Time zone', 'timeZone', { optional: true, placeholder: 'Run time zone' }),
    ],
  },
  {
    op: 'shift_date',
    label: 'Shift date',
    group: 'Dates',
    summary: 'Move a date by a duration.',
    make: () => ({ by: '+1d' }),
    params: [p('by', 'By', 'duration')],
  },
  {
    op: 'truncate_date',
    label: 'Start of period',
    group: 'Dates',
    summary: 'Start of the day, month or year.',
    make: () => ({ unit: 'day' }),
    params: [
      p('unit', 'Period', 'text', {
        options: [
          { value: 'day', label: 'Day' },
          { value: 'month', label: 'Month' },
          { value: 'year', label: 'Year' },
        ],
      }),
    ],
  },
  {
    op: 'to_utc',
    label: 'To UTC',
    group: 'Dates',
    summary: 'Normalise before storage.',
    make: () => ({}),
    params: [],
  },
  // Decide
  {
    op: 'when',
    label: 'When',
    group: 'Decide',
    summary: 'Replace the value when a condition holds; the first matching case wins.',
    make: () => ({ cases: [{ cond: { is_null: true }, then: null }] }),
    params: [],
  },
  // Lists
  {
    op: 'each',
    label: 'For each',
    group: 'Lists',
    summary: 'Run steps on every element of a list.',
    make: () => ({ pipeline: [{ op: 'trim' }] }),
    params: [],
  },
  {
    op: 'filter_list',
    label: 'Keep elements',
    group: 'Lists',
    summary: 'Keep the elements that match a condition.',
    make: () => ({ cond: { is_null: false } }),
    params: [p('cond', 'Keep when', 'cond')],
  },
  {
    op: 'index',
    label: 'Element at',
    group: 'Lists',
    summary: 'The element at a position; negative counts from the end.',
    make: () => ({ at: 0 }),
    params: [p('at', 'Position', 'integer')],
  },
  {
    op: 'first',
    label: 'First element',
    group: 'Lists',
    summary: 'The first element.',
    make: () => ({}),
    params: [],
  },
  {
    op: 'last',
    label: 'Last element',
    group: 'Lists',
    summary: 'The last element.',
    make: () => ({}),
    params: [],
  },
  {
    op: 'len',
    label: 'Length',
    group: 'Lists',
    summary: 'Number of elements or characters.',
    make: () => ({}),
    params: [],
  },
  {
    op: 'unique',
    label: 'Unique',
    group: 'Lists',
    summary: 'Drop repeated elements.',
    make: () => ({}),
    params: [],
  },
  {
    op: 'sum',
    label: 'Sum',
    group: 'Lists',
    summary: 'Total of a list of numbers.',
    make: () => ({}),
    params: [],
  },
  {
    op: 'min',
    label: 'Smallest',
    group: 'Lists',
    summary: 'The smallest element.',
    make: () => ({}),
    params: [],
  },
  {
    op: 'max',
    label: 'Largest',
    group: 'Lists',
    summary: 'The largest element.',
    make: () => ({}),
    params: [],
  },
  {
    op: 'contains',
    label: 'Contains',
    group: 'Lists',
    summary: 'Whether the list contains a value.',
    make: () => ({ value: '' }),
    params: [p('value', 'Value', 'operand')],
  },
  // Look up
  {
    op: 'lookup',
    label: 'Translate',
    group: 'Look up',
    summary: 'Translate codes through a table stored with the mapping.',
    make: () => ({ table: '' }),
    params: [
      p('table', 'Table', 'lookupTable'),
      p('on_miss', 'When missing', 'text', {
        optional: true,
        options: [
          { value: 'null', label: 'Empty' },
          { value: 'pass', label: 'Keep value' },
          { value: 'error', label: 'Fail' },
        ],
      }),
    ],
  },
  {
    op: 'lookup_entity',
    label: 'Find in target',
    group: 'Look up',
    summary: 'Resolve a key to a field of a target entity.',
    make: () => ({ entity: '', by: '', field: '' }),
    params: [],
  },
  // Code
  {
    op: 'fn',
    label: 'Function',
    group: 'Code',
    summary: 'A reviewed, named function registered by the host.',
    make: () => ({ ref: '' }),
    params: [p('ref', 'Function', 'text', { placeholder: 'pricing.tier_v3' })],
  },
]

const BY_OP = new Map(OPS.map((o) => [o.op, o]))

export function opInfo(op: string): OpInfo | undefined {
  return BY_OP.get(op)
}

export function opsIn(group: OpGroup, first: boolean): OpInfo[] {
  return OPS.filter((o) => o.group === group && (first ? o.entry || o.op === 'when' : !o.entry))
}

export const DATE_FORMATS = [
  'YYYY-MM-DD',
  'DD.MM.YYYY',
  'MM/DD/YYYY',
  'YYYY-MM-DDTHH:mm:ss',
  'iso',
  'epoch_ms',
  'epoch_s',
]
