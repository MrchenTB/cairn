import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeProject, makeTask } from '@/domain/testFactories'
import type { BackupFile } from '@/domain/types'
import { downloadBackup, downloadTasksCsv, readBackupFile, serializeBackup } from './backup'

/** jsdom has neither Blob.text() nor URL.createObjectURL: read blobs with FileReader. */
function blobText(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsText(blob)
  })
}

function captureDownloads() {
  const blobs: Blob[] = []
  const anchors: HTMLAnchorElement[] = []
  Object.assign(URL, {
    createObjectURL: vi.fn((blob: Blob) => {
      blobs.push(blob)
      return `blob:cairn/${blobs.length}`
    }),
    revokeObjectURL: vi.fn(),
  })
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    anchors.push(this)
  })
  return { blobs, anchors }
}

const file: BackupFile = {
  app: 'cairn',
  formatVersion: 1,
  exportedAt: '2026-11-02T00:00:00.000Z',
  preferences: null,
  data: {
    projects: [makeProject({ id: 'p', name: 'Home' })],
    phases: [],
    tasks: [makeTask({ id: 't', projectId: 'p', title: '待辦' })],
    milestones: [],
    dependencies: [],
  },
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('downloads', () => {
  it('downloads the JSON backup as cairn-backup-<date>.json', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    const { blobs, anchors } = captureDownloads()
    downloadBackup(file, '2026-11-02')
    expect(anchors).toHaveLength(1)
    expect(anchors[0].download).toBe('cairn-backup-2026-11-02.json')
    expect(anchors[0].isConnected).toBe(false) // cleaned up after the click
    expect(URL.revokeObjectURL).not.toHaveBeenCalled() // revoked later, not before the download starts
    vi.runAllTimers()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:cairn/1')
    vi.useRealTimers()
    expect(blobs[0].type).toBe('application/json')
    expect(JSON.parse(await blobText(blobs[0]))).toEqual(file)
  })

  it('downloads tasks as UTF-8 CSV with a BOM', async () => {
    const { blobs, anchors } = captureDownloads()
    downloadTasksCsv(file.data, '2026-11-02')
    expect(anchors[0].download).toBe('cairn-tasks-2026-11-02.csv')
    expect(blobs[0].type).toBe('text/csv;charset=utf-8')
    const bytes = new Uint8Array(
      await new Promise<ArrayBuffer>((resolve) => {
        const reader = new FileReader()
        reader.onload = () => resolve(reader.result as ArrayBuffer)
        reader.readAsArrayBuffer(blobs[0])
      }),
    )
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
    expect(await blobText(blobs[0])).toContain('Home,,,待辦,To Do,None')
  })
})

describe('readBackupFile in a browser-like environment', () => {
  it('reads a File chosen in an <input type="file"> (FileReader fallback)', async () => {
    const upload = new File([serializeBackup(file)], 'cairn-backup-2026-11-02.json', {
      type: 'application/json',
    })
    expect(await readBackupFile(upload)).toMatchObject({
      ok: true,
      value: { data: { tasks: [{ title: '待辦' }] } },
    })
  })
})
