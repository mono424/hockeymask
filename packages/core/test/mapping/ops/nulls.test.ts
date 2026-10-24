import { describe, expect, it } from 'vite-plus/test'
import { OMIT } from '../../../src/mapping/values'
import { t } from '../../../src/mapping/types'
import { compile, compileError, evaluate, evaluateError, typeOf } from '../helpers'

const fields = { s: t.nullable(t.string), n: t.nullable(t.number), u: t.unknown, req: t.string }
const from = (path: string) => ({ op: 'extract', path })

describe('blank_to_null', () => {
  it.each([
    ['', null],
    ['   ', null],
    [' x ', ' x '],
    [null, null],
  ])('%j -> %j', (value, expected) => {
    expect(evaluate([from('s'), { op: 'blank_to_null' }], { s: value }, { fields })).toBe(expected)
  })

  it('yields string? and is infallible', () => {
    const compiled = compile([from('req'), { op: 'blank_to_null' }], { fields })
    expect(typeOf([from('req'), { op: 'blank_to_null' }], { fields })).toBe('string?')
    expect(compiled.fallible).toBe(false)
  })

  it('rejects non-strings and params', () => {
    expect(compileError([from('n'), { op: 'blank_to_null' }], { fields })).toContain(
      'blank_to_null expects string, got number',
    )
    expect(compileError([from('s'), { op: 'blank_to_null', x: 1 }], { fields })).toContain('x')
  })
})

describe('default', () => {
  it('replaces null and makes the type non-null', () => {
    const steps = [from('n'), { op: 'default', value: 0 }]
    expect(typeOf(steps, { fields })).toBe('number')
    expect(evaluate(steps, { n: null }, { fields })).toBe(0)
    expect(evaluate(steps, { n: 5 }, { fields })).toBe(5)
  })

  it('takes the literal type for an unknown input', () => {
    expect(typeOf([from('u'), { op: 'default', value: 'x' }], { fields })).toBe('string')
  })

  it.each([
    [{ value: null }, 'non-null'],
    [{ value: 'x' }, 'default value is string, input is number?'],
    [{}, 'value'],
  ])('rejects %j', (params, message) => {
    expect(compileError([from('n'), { op: 'default', ...params }], { fields })).toContain(message)
  })

  it('is infallible', () => {
    expect(compile([from('n'), { op: 'default', value: 1 }], { fields }).fallible).toBe(false)
  })
})

describe('require', () => {
  it('passes values and makes the type non-null', () => {
    const steps = [from('s'), { op: 'require' }]
    expect(typeOf(steps, { fields })).toBe('string')
    expect(evaluate(steps, { s: 'x' }, { fields })).toBe('x')
    expect(compile(steps, { fields }).fallible).toBe(true)
  })

  it('raises required_null with the default or a custom message', () => {
    expect(evaluateError([from('s'), { op: 'require' }], { s: null }, { fields })).toMatchObject({
      code: 'required_null',
      detail: 'required value is null',
      op: 'require',
      step: 1,
    })
    expect(
      evaluateError([from('s'), { op: 'require', message: 'sku missing' }], {}, { fields }).detail,
    ).toBe('sku missing')
  })

  it('rejects a non-string message', () => {
    expect(compileError([from('s'), { op: 'require', message: 1 }], { fields })).toContain(
      'message',
    )
  })
})

describe('omit_if_null', () => {
  it('omits null and keeps values', () => {
    const steps = [from('n'), { op: 'omit_if_null' }]
    const compiled = compile(steps, { fields })
    expect(compiled.omittable).toBe(true)
    expect(compiled.fallible).toBe(false)
    expect(typeOf(steps, { fields })).toBe('number?')
    expect(evaluate(steps, { n: null }, { fields })).toBe(OMIT)
    expect(evaluate(steps, { n: 3 }, { fields })).toBe(3)
  })

  it('must be the last step', () => {
    expect(compileError([from('s'), { op: 'omit_if_null' }, { op: 'trim' }], { fields })).toContain(
      'omit_if_null must be the last step',
    )
  })

  it('takes no params', () => {
    expect(compileError([from('s'), { op: 'omit_if_null', x: 1 }], { fields })).toContain('x')
  })
})
