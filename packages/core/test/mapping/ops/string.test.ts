import { describe, expect, it } from 'vite-plus/test'
import { show, t } from '../../../src/mapping/types'
import { compile, compileError, evaluate } from '../helpers'

const fields = {
  s: t.string,
  ns: t.nullable(t.string),
  n: t.number,
  list: t.list(t.string),
  nlist: t.list(t.nullable(t.string)),
  nums: t.list(t.number),
  a: t.nullable(t.string),
  b: t.nullable(t.number),
  c: t.boolean,
}

/** Run `op` on `s` (a string field) and return the result. */
const on = (step: Record<string, unknown>, value: string) =>
  evaluate([{ op: 'extract', path: 's' }, step], { s: value }, { fields })

const typeOf = (step: Record<string, unknown>, path = 's') =>
  show(compile([{ op: 'extract', path }, step], { fields }).type)

const errorOf = (step: Record<string, unknown>, path = 's') =>
  compileError([{ op: 'extract', path }, step], { fields })

/** Ops typed `string -> string`: signature, null propagation and rejection of non-strings. */
describe.each(['trim', 'lower', 'upper', 'slug'])('%s typing', (op) => {
  it('maps string to string and propagates null', () => {
    expect(typeOf({ op })).toBe('string')
    expect(typeOf({ op }, 'ns')).toBe('string?')
    expect(evaluate([{ op: 'extract', path: 'ns' }, { op }], { ns: null }, { fields })).toBe(null)
  })

  it('rejects a number', () => {
    expect(errorOf({ op }, 'n')).toBe(`${op} expects string, got number`)
  })

  it('rejects unknown params', () => {
    expect(errorOf({ op, x: 1 })).toContain('Unrecognized key')
  })
})

describe('trim', () => {
  it.each([
    [{ op: 'trim' }, '  a b  ', 'a b'],
    [{ op: 'trim', chars: '-' }, '--a-b--', 'a-b'],
    [{ op: 'trim', chars: '0' }, '000', ''],
    [{ op: 'trim', chars: ']^\\-' }, '^]a\\-', 'a'],
  ])('%j on %j is %j', (step, value, expected) => {
    expect(on(step, value)).toBe(expected)
  })

  it('rejects empty chars', () => {
    expect(errorOf({ op: 'trim', chars: '' })).toMatch(/^trim: chars: /)
  })
})

describe('lower / upper', () => {
  it('changes case', () => {
    expect(on({ op: 'lower' }, 'AbC')).toBe('abc')
    expect(on({ op: 'upper' }, 'AbC')).toBe('ABC')
  })
})

describe('truncate', () => {
  it.each([
    [{ op: 'truncate', length: 5 }, 'abc', 'abc'],
    [{ op: 'truncate', length: 3 }, 'abc', 'abc'],
    [{ op: 'truncate', length: 2 }, 'abc', 'ab'],
    [{ op: 'truncate', length: 0 }, 'abc', ''],
    [{ op: 'truncate', length: 3, ellipsis: true }, 'abcdef', 'ab…'],
    [{ op: 'truncate', length: 1, ellipsis: true }, 'abc', '…'],
    [{ op: 'truncate', length: 2, ellipsis: false }, 'abc', 'ab'],
    [{ op: 'truncate', length: 2 }, '😀😀😀', '😀😀'],
  ])('%j on %j is %j', (step, value, expected) => {
    expect(on(step, value)).toBe(expected)
  })

  it.each([
    [{ op: 'truncate' }, /^truncate: length: /],
    [{ op: 'truncate', length: -1 }, /^truncate: length: /],
    [{ op: 'truncate', length: 1.5 }, /^truncate: length: /],
    [{ op: 'truncate', length: 0, ellipsis: true }, /needs length >= 1$/],
  ])('rejects %j', (step, message) => {
    expect(errorOf(step)).toMatch(message)
  })

  it('types string to string', () => {
    expect(typeOf({ op: 'truncate', length: 1 })).toBe('string')
  })
})

describe('pad', () => {
  it.each([
    [{ op: 'pad', length: 5, with: '0', side: 'left' }, '42', '00042'],
    [{ op: 'pad', length: 5, with: '.', side: 'right' }, '42', '42...'],
    [{ op: 'pad', length: 2, with: '0', side: 'left' }, '1234', '1234'],
    [{ op: 'pad', length: 5, with: 'ab', side: 'left' }, 'x', 'ababx'],
  ])('%j on %j is %j', (step, value, expected) => {
    expect(on(step, value)).toBe(expected)
  })

  it.each([
    [{ op: 'pad', length: 0, with: '0', side: 'left' }, /^pad: length: /],
    [{ op: 'pad', length: 2, with: '', side: 'left' }, /^pad: with: /],
    [{ op: 'pad', length: 2, with: '0', side: 'up' }, /^pad: side: /],
    [{ op: 'pad', length: 2, with: '0' }, /^pad: side: /],
  ])('rejects %j', (step, message) => {
    expect(errorOf(step)).toMatch(message)
  })

  it('types string to string', () => {
    expect(typeOf({ op: 'pad', length: 2, with: '0', side: 'left' })).toBe('string')
  })
})

describe('replace', () => {
  it.each([
    [{ op: 'replace', pattern: '.', with: '-' }, 'a.b.c', 'a-b-c'],
    [{ op: 'replace', pattern: '\\d+', with: '#', regex: true }, 'a1b22', 'a#b#'],
    [{ op: 'replace', pattern: 'a', with: '$&$&' }, 'a', '$&$&'],
    [{ op: 'replace', pattern: '(a)', with: '$1', regex: true }, 'a', '$1'],
    [{ op: 'replace', pattern: '\\d', with: '', regex: false }, 'a\\d1', 'a1'],
  ])('%j on %j is %j', (step, value, expected) => {
    expect(on(step, value)).toBe(expected)
  })

  it.each([
    [{ op: 'replace', pattern: '(', with: '', regex: true }, /^replace: pattern: invalid regular/],
    [{ op: 'replace', pattern: 5, with: '', regex: true }, /^replace: pattern: /],
    [{ op: 'replace', pattern: '', with: '' }, /^replace: pattern: /],
    [{ op: 'replace', pattern: 'a' }, /^replace: with: /],
  ])('rejects %j', (step, message) => {
    expect(errorOf(step)).toMatch(message)
  })

  it('accepts an invalid regex as a literal pattern', () => {
    expect(on({ op: 'replace', pattern: '(', with: ')' }, '((')).toBe('))')
  })

  it('types string to string', () => {
    expect(typeOf({ op: 'replace', pattern: 'a', with: 'b' })).toBe('string')
  })
})

describe('regex_extract', () => {
  it.each([
    [{ op: 'regex_extract', pattern: '\\d+' }, 'ab123c45', '123'],
    [{ op: 'regex_extract', pattern: '(\\w)-(\\d)', group: 2 }, 'x-1', '1'],
    [{ op: 'regex_extract', pattern: '\\d' }, 'abc', null],
    [{ op: 'regex_extract', pattern: 'a|(b)', group: 1 }, 'a', null],
  ])('%j on %j is %j', (step, value, expected) => {
    expect(on(step, value)).toBe(expected)
  })

  it('types string to string?', () => {
    expect(typeOf({ op: 'regex_extract', pattern: 'a' })).toBe('string?')
  })

  it.each([
    [{ op: 'regex_extract', pattern: '(' }, /^regex_extract: pattern: invalid regular expression/],
    [
      { op: 'regex_extract', pattern: '(a)', group: 2 },
      /larger than the number of capture groups$/,
    ],
    [{ op: 'regex_extract', pattern: 'a', group: -1 }, /^regex_extract: group: /],
  ])('rejects %j', (step, message) => {
    expect(errorOf(step)).toMatch(message)
  })

  it('rejects a number input', () => {
    expect(errorOf({ op: 'regex_extract', pattern: 'a' }, 'n')).toBe(
      'regex_extract expects string, got number',
    )
  })
})

describe('split', () => {
  it.each([
    [{ op: 'split', separator: 'x' }, '120x80x40', ['120', '80', '40']],
    [{ op: 'split', separator: ',' }, '', ['']],
    [{ op: 'split', separator: ',', limit: 2 }, 'a,b,c', ['a', 'b,c']],
    [{ op: 'split', separator: ',', limit: 3 }, 'a,b,c', ['a', 'b', 'c']],
    [{ op: 'split', separator: ',', limit: 1 }, 'a,b', ['a,b']],
  ])('%j on %j is %j', (step, value, expected) => {
    expect(on(step, value)).toEqual(expected)
  })

  it('types string to list<string>', () => {
    expect(typeOf({ op: 'split', separator: ',' })).toBe('list<string>')
  })

  it.each([
    [{ op: 'split', separator: '' }, /^split: separator: /],
    [{ op: 'split', separator: ',', limit: 0 }, /^split: limit: /],
  ])('rejects %j', (step, message) => {
    expect(errorOf(step)).toMatch(message)
  })

  it('rejects a number input', () => {
    expect(errorOf({ op: 'split', separator: ',' }, 'n')).toBe('split expects string, got number')
  })
})

describe('join', () => {
  it('joins a list, skipping nulls', () => {
    const steps = [
      { op: 'extract', path: 'nlist' },
      { op: 'join', separator: ', ' },
    ]
    expect(evaluate(steps, { nlist: ['a', null, 'b'] }, { fields })).toBe('a, b')
    expect(show(compile(steps, { fields }).type)).toBe('string')
  })

  it('joins list<string>', () => {
    expect(
      evaluate(
        [
          { op: 'extract', path: 'list' },
          { op: 'join', separator: '' },
        ],
        { list: ['a', 'b'] },
        { fields },
      ),
    ).toBe('ab')
  })

  it.each([
    ['s', 'join expects list<string>, got string'],
    ['nums', 'join expects list<string>, got list<number>'],
  ])('rejects %s', (path, message) => {
    expect(errorOf({ op: 'join', separator: ',' }, path)).toBe(message)
  })

  it('requires a separator', () => {
    expect(errorOf({ op: 'join' }, 'list')).toMatch(/^join: separator: /)
  })
})

describe('concat', () => {
  const steps = (step: Record<string, unknown>) => [{ op: 'extract', path: ['a', 'b', 'c'] }, step]

  it.each([
    [{ op: 'concat' }, { a: 'x', b: 1, c: true }, 'x1true'],
    [{ op: 'concat', separator: '-' }, { a: 'x', b: null, c: false }, 'x-false'],
    [{ op: 'concat', separator: '-' }, { a: null, b: null, c: false }, 'false'],
  ])('%j on %j is %j', (step, record, expected) => {
    expect(evaluate(steps(step), record, { fields })).toBe(expected)
  })

  it('types a scalar tuple to string', () => {
    expect(show(compile(steps({ op: 'concat' }), { fields }).type)).toBe('string')
  })

  it.each([
    [
      [{ op: 'extract', path: 's' }, { op: 'concat' }],
      'concat expects a tuple of strings, numbers or booleans, got string',
    ],
    [
      [{ op: 'extract', path: ['s', 'list'] }, { op: 'concat' }],
      'concat expects a tuple of strings, numbers or booleans, got (string, list<string>)',
    ],
  ])('rejects %j', (pipeline, message) => {
    expect(compileError(pipeline, { fields })).toBe(message)
  })
})

describe('slug', () => {
  it.each([
    [{ op: 'slug' }, 'Acme Trail Tent 2P Green', 'acme-trail-tent-2p-green'],
    [{ op: 'slug' }, '  Crème brûlée!! ', 'creme-brulee'],
    [{ op: 'slug', separator: '_' }, 'A b--c', 'a_b_c'],
    [{ op: 'slug' }, '!!!', ''],
  ])('%j on %j is %j', (step, value, expected) => {
    expect(on(step, value)).toBe(expected)
  })

  it('rejects an empty separator', () => {
    expect(errorOf({ op: 'slug', separator: '' })).toMatch(/^slug: separator: /)
  })
})
