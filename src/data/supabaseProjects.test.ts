import { describe, expect, it } from 'vitest'
import {
  PRODUCTION_PROJECT_REF,
  projectRefOf,
  STAGING_PROJECT_REF,
  supabaseTargetProblem,
} from './supabaseProjects.ts'

const PRODUCTION = 'productionproject000'
const url = (ref: string) => `https://${ref}.supabase.co`
const STAGING_URL = url(STAGING_PROJECT_REF)
const PRODUCTION_URL = url(PRODUCTION)

const check = (vercelEnv: string | undefined, target: string | undefined, hasKey = true) =>
  supabaseTargetProblem({ vercelEnv, url: target, hasKey, productionRef: PRODUCTION })

describe('projectRefOf', () => {
  it('reads the ref of a hosted project, and nothing else', () => {
    expect(projectRefOf('https://abc123.supabase.co')).toBe('abc123')
    expect(projectRefOf(' https://abc123.supabase.co/ ')).toBe('abc123')
    expect(projectRefOf('http://abc123.supabase.co')).toBeNull()
    expect(projectRefOf('https://abc123.supabase.co.evil.example')).toBeNull()
    expect(projectRefOf('http://127.0.0.1:54321')).toBeNull()
    expect(projectRefOf('')).toBeNull()
  })
})

describe('the recorded projects', () => {
  const real = (vercelEnv: string | undefined, ref: string) =>
    supabaseTargetProblem({ vercelEnv, url: url(ref), hasKey: true })

  it('are two different projects', () => {
    expect(projectRefOf(url(PRODUCTION_PROJECT_REF))).toBe(PRODUCTION_PROJECT_REF)
    expect(PRODUCTION_PROJECT_REF).not.toBe(STAGING_PROJECT_REF)
  })

  it('keep the real production project out of this computer and out of previews', () => {
    expect(real(undefined, PRODUCTION_PROJECT_REF)).toMatch(/only the production site/)
    expect(real('preview', PRODUCTION_PROJECT_REF)).toMatch(/must use the staging project/)
    expect(real('production', PRODUCTION_PROJECT_REF)).toBeNull()
    expect(real('preview', STAGING_PROJECT_REF)).toBeNull()
    expect(real('production', STAGING_PROJECT_REF)).toMatch(/points at the staging project/)
  })
})

describe('supabaseTargetProblem', () => {
  it('on this computer: anything but production', () => {
    expect(check(undefined, undefined, false)).toBeNull()
    expect(check(undefined, 'http://127.0.0.1:54321')).toBeNull()
    expect(check(undefined, STAGING_URL)).toBeNull()
    expect(check(undefined, PRODUCTION_URL)).toMatch(/only the production site/)
    expect(check(undefined, `${PRODUCTION_URL}/`)).toMatch(/only the production site/)
  })

  it('a preview: only staging, never production, never local mode', () => {
    expect(check('preview', STAGING_URL)).toBeNull()
    expect(check('preview', PRODUCTION_URL)).toMatch(/must use the staging project/)
    expect(check('preview', url('someotherproject'))).toMatch(/must use the staging project/)
    expect(check('preview', undefined, false)).toMatch(/must use the staging project/)
    expect(check('preview', STAGING_URL, false)).toMatch(/must use the staging project/)
  })

  it('the production site: only production, never staging, never local mode', () => {
    expect(check('production', PRODUCTION_URL)).toBeNull()
    expect(check('production', STAGING_URL)).toMatch(/points at the staging project/)
    expect(check('production', url('someotherproject'))).toMatch(/other than/)
    expect(check('production', undefined, false)).toMatch(/runs in local mode/)
    expect(check('production', PRODUCTION_URL, false)).toMatch(/runs in local mode/)
  })

  it('before the production project exists, the rules that need its ref stand aside', () => {
    const before = (vercelEnv: string | undefined, target: string) =>
      supabaseTargetProblem({ vercelEnv, url: target, hasKey: true, productionRef: '' })
    expect(before(undefined, url('anything'))).toBeNull()
    expect(before('production', url('anything'))).toBeNull()
    expect(before('production', STAGING_URL)).toMatch(/points at the staging project/)
    expect(before('preview', url('anything'))).toMatch(/must use the staging project/)
  })
})
