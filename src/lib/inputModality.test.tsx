import { fireEvent } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { INPUT_MODALITY_ATTRIBUTE, getInputModality, installInputModality } from './inputModality'

describe('input modality', () => {
  it('starts as keyboard and mirrors the latest input on <html>', () => {
    installInputModality()
    installInputModality() // idempotent
    const html = document.documentElement
    expect(getInputModality()).toBe('keyboard')
    expect(html).toHaveAttribute(INPUT_MODALITY_ATTRIBUTE, 'keyboard')

    fireEvent.pointerDown(document.body)
    expect(getInputModality()).toBe('pointer')
    expect(html).toHaveAttribute(INPUT_MODALITY_ATTRIBUTE, 'pointer')

    fireEvent.keyDown(document.body, { key: 'Tab' })
    expect(getInputModality()).toBe('keyboard')
    expect(html).toHaveAttribute(INPUT_MODALITY_ATTRIBUTE, 'keyboard')
  })

  it('sees events even when a handler stops them (capture phase)', () => {
    installInputModality()
    const button = document.createElement('button')
    button.addEventListener('pointerdown', (event) => event.stopPropagation())
    document.body.append(button)
    fireEvent.pointerDown(button)
    expect(getInputModality()).toBe('pointer')
    button.remove()
    fireEvent.keyDown(document.body, { key: 'a' })
  })
})
