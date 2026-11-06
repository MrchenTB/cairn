/**
 * Without an explicit source Tailwind scans the whole repository, and its Vite plugin answers a
 * change to any scanned file outside the module graph (docs/*.md, README.md) with a full reload of
 * every open dev page. An edit to the docs then closes menus and dialogs under running e2e tests.
 */
import { readFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'

test('Tailwind scans src only, so editing the docs does not reload the pages under test', () => {
  expect(readFileSync('src/index.css', 'utf8')).toMatch(/^@import 'tailwindcss' source\('\.'\);$/m)
})
