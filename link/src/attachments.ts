import { randomBytes } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DATA_DIR } from './settings.ts'

// Files a window attaches to a message (dragged in, pasted or picked; any kind, from the desktop or a phone): kept
// under the data folder, one folder per day, so she can open them by path. The session lists this folder as an
// additional directory, so reading an attachment never asks for permission.

export const ATTACH_DIR = join(DATA_DIR, 'attachments')
export const ATTACH_MAX_BYTES = 25 * 1024 * 1024
const NAME_MAX = 120

/** A file name that stays a file name: no folders, no characters Windows refuses, never empty. */
export function safeName(name: string) {
  const base = name.split(/[\\/]/).pop() ?? ''
  const clean = base.replace(/[<>:"|?*\u0000-\u001f]/g, '_').replace(/^[.\s]+|[.\s]+$/g, '').slice(-NAME_MAX)
  return clean || 'file'
}

/** Writes the bytes and returns where; a short random prefix keeps two files of one name apart. */
export async function putAttachment(name: string, base64: string): Promise<string> {
  const bytes = Buffer.from(base64, 'base64')
  if (bytes.length > ATTACH_MAX_BYTES) {
    throw new Error(`That file is ${(bytes.length / 1024 / 1024).toFixed(1)} MB; attachments can be up to ${ATTACH_MAX_BYTES / 1024 / 1024} MB.`)
  }
  const day = new Date().toISOString().slice(0, 10)
  const dir = join(ATTACH_DIR, day)
  await mkdir(dir, { recursive: true })
  const path = join(dir, `${randomBytes(3).toString('hex')}-${safeName(name)}`)
  await writeFile(path, bytes)
  return path
}
