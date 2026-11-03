import { describe, expect, it } from 'vitest'
import { dropAfterId, stepAfterId } from './projectOrder'

describe('dropAfterId', () => {
  const order = ['a', 'b', 'c', 'd']

  it('returns the project that ends up directly before the dropped one', () => {
    expect(dropAfterId(order, 'a', 'c')).toBe('c') // a moves below c
    expect(dropAfterId(order, 'd', 'b')).toBe('a') // d moves above b
    expect(dropAfterId(order, 'c', 'a')).toBeNull() // c becomes first
    expect(dropAfterId(order, 'b', 'd')).toBe('d') // b becomes last
  })

  it('returns undefined when nothing moves', () => {
    expect(dropAfterId(order, 'b', 'b')).toBeUndefined()
    expect(dropAfterId(order, 'b', null)).toBeUndefined()
    expect(dropAfterId(order, 'x', 'b')).toBeUndefined()
    expect(dropAfterId(order, 'b', 'x')).toBeUndefined()
  })

  it('works on a filtered subsequence (hidden projects keep their place around it)', () => {
    // Visible: active projects only; the store places "after c" in the full order.
    expect(dropAfterId(['a', 'c', 'e'], 'e', 'c')).toBe('a')
  })
})

describe('stepAfterId', () => {
  it('moves up / down by one and stops at the edges', () => {
    expect(stepAfterId(['a', 'b', 'c'], 'c', -1)).toBe('a')
    expect(stepAfterId(['a', 'b', 'c'], 'b', -1)).toBeNull()
    expect(stepAfterId(['a', 'b', 'c'], 'a', 1)).toBe('b')
    expect(stepAfterId(['a', 'b', 'c'], 'a', -1)).toBeUndefined()
    expect(stepAfterId(['a', 'b', 'c'], 'c', 1)).toBeUndefined()
    expect(stepAfterId(['a', 'b', 'c'], 'x', 1)).toBeUndefined()
  })
})
