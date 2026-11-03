import { describe, expect, it } from 'vitest'
import {
  makeDependency,
  makePhase,
  makeProject,
  makeTask,
  makeWorkspace,
} from '@/domain/testFactories'
import type { BackupFile } from '@/domain/types'
import {
  backupFileName,
  buildTasksCsv,
  csvField,
  MAX_BACKUP_FILE_BYTES,
  parseBackupText,
  readBackupFile,
  serializeBackup,
  tasksCsvFileName,
  toCsv,
} from './backup'

const BOM = '﻿'

describe('CSV encoding (RFC 4180)', () => {
  it('quotes only when needed and doubles inner quotes', () => {
    expect(csvField('plain')).toBe('plain')
    expect(csvField(null)).toBe('')
    expect(csvField('a,b')).toBe('"a,b"')
    expect(csvField('say "hi"')).toBe('"say ""hi"""')
    expect(csvField('line 1\nline 2')).toBe('"line 1\nline 2"')
    expect(csvField('crlf\r\n')).toBe('"crlf\r\n"')
    expect(csvField(' padded ')).toBe('" padded "')
    expect(csvField('中文標題')).toBe('中文標題')
  })

  it('defuses spreadsheet formulas', () => {
    expect(csvField('=SUM(A1:A2)')).toBe("'=SUM(A1:A2)")
    expect(csvField('+1')).toBe("'+1")
    expect(csvField('-x')).toBe("'-x")
    expect(csvField('@cmd')).toBe("'@cmd")
    expect(csvField('=HYPERLINK("x","y")')).toBe(`"'=HYPERLINK(""x"",""y"")"`)
  })

  it('joins rows with CRLF', () => {
    expect(
      toCsv([
        ['a', 'b'],
        ['c', null],
      ]),
    ).toBe('a,b\r\nc,\r\n')
  })
})

describe('buildTasksCsv', () => {
  const rows = {
    projects: [
      makeProject({ id: 'p2', name: 'Second', sortOrder: 'a1', status: 'archived' }),
      makeProject({ id: 'p1', name: 'First, Inc.', sortOrder: 'a0' }),
    ],
    phases: [
      makePhase({ id: 'ph2', projectId: 'p1', name: 'Build', sortOrder: 'a1' }),
      makePhase({ id: 'ph1', projectId: 'p1', name: 'Plan', sortOrder: 'a0' }),
    ],
    tasks: [
      makeTask({
        id: 'b',
        projectId: 'p1',
        phaseId: 'ph2',
        title: 'Ship',
        sortOrder: 'a0',
        priority: 'urgent',
      }),
      makeTask({
        id: 'a',
        projectId: 'p1',
        phaseId: 'ph1',
        title: 'Design',
        sortOrder: 'a1',
        status: 'done',
        startDate: '2026-11-02',
        dueDate: '2026-11-04',
        completedAt: '2026-11-04T10:00:00.000Z',
        description: 'Line 1\nLine "2"',
      }),
      makeTask({
        id: 'a1',
        projectId: 'p1',
        phaseId: 'ph1',
        parentTaskId: 'a',
        title: 'Sketch',
        status: 'in_progress',
      }),
      makeTask({ id: 'n', projectId: 'p1', title: 'Loose', sortOrder: 'a5' }),
      makeTask({ id: 'z', projectId: 'p2', title: 'Old', priority: 'low' }),
    ],
  }

  it('writes a BOM, the header and one row per task in List order', () => {
    const csv = buildTasksCsv(rows)
    expect(csv.startsWith(BOM)).toBe(true)
    const lines = csv.slice(1).split('\r\n')
    expect(lines[0]).toBe(
      'Project,Phase,Parent task,Title,Status,Priority,Start,Due,Completed at,Description',
    )
    expect(lines.slice(1, -1)).toEqual([
      '"First, Inc.",,,Loose,To Do,None,,,,',
      // the description's line break stays inside the quoted field
      '"First, Inc.",Plan,,Design,Done,None,2026-11-02,2026-11-04,2026-11-04T10:00:00.000Z,"Line 1\nLine ""2"""',
      '"First, Inc.",Plan,Design,Sketch,In Progress,None,,,,',
      '"First, Inc.",Build,,Ship,To Do,Urgent,,,,',
      'Second,,,Old,To Do,Low,,,,',
    ])
    expect(lines.at(-1)).toBe('')
  })

  it('accepts the normalised workspace (records) as well as backup arrays', () => {
    expect(buildTasksCsv(makeWorkspace(rows))).toBe(buildTasksCsv(rows))
  })
})

describe('backup files', () => {
  const file: BackupFile = {
    app: 'cairn',
    formatVersion: 1,
    exportedAt: '2026-11-02T00:00:00.000Z',
    preferences: null,
    data: {
      projects: [makeProject({ id: 'p' })],
      phases: [],
      tasks: [makeTask({ id: 'a', projectId: 'p' }), makeTask({ id: 'b', projectId: 'p' })],
      milestones: [],
      dependencies: [makeDependency({ projectId: 'p', predecessorId: 'a', successorId: 'b' })],
    },
  }

  it('names downloads with the date', () => {
    expect(backupFileName('2026-11-02')).toBe('cairn-backup-2026-11-02.json')
    expect(tasksCsvFileName('2026-11-02')).toBe('cairn-tasks-2026-11-02.csv')
    expect(backupFileName()).toMatch(/^cairn-backup-\d{4}-\d{2}-\d{2}\.json$/)
  })

  it('parses its own serialisation (with or without a BOM)', () => {
    const text = serializeBackup(file)
    expect(parseBackupText(text)).toMatchObject({ ok: true, value: { app: 'cairn' } })
    expect(parseBackupText(BOM + text).ok).toBe(true)
  })

  it('rejects non-JSON, foreign JSON and invalid backups with validation errors', () => {
    expect(parseBackupText('{oops')).toMatchObject({
      ok: false,
      error: { kind: 'validation', message: /valid JSON/ },
    })
    expect(parseBackupText('{"hello":1}')).toMatchObject({
      ok: false,
      error: { kind: 'validation' },
    })
    const broken = structuredClone(file)
    broken.data.tasks[0].projectId = 'missing'
    expect(parseBackupText(JSON.stringify(broken))).toMatchObject({
      ok: false,
      error: { kind: 'validation' },
    })
  })

  it('reads uploaded files and refuses oversized ones before reading', async () => {
    const blob = new Blob([serializeBackup(file)], { type: 'application/json' })
    expect(await readBackupFile(blob)).toMatchObject({
      ok: true,
      value: { data: { tasks: [{ id: 'a' }, { id: 'b' }] } },
    })

    const huge = {
      size: MAX_BACKUP_FILE_BYTES + 1,
      text: () => Promise.reject(new Error('should not read')),
    }
    expect(await readBackupFile(huge as unknown as Blob)).toMatchObject({
      ok: false,
      error: { kind: 'validation' },
    })

    const unreadable = { size: 10, text: () => Promise.reject(new Error('disk error')) }
    expect(await readBackupFile(unreadable as unknown as Blob)).toMatchObject({
      ok: false,
      error: { kind: 'unknown' },
    })
  })
})
