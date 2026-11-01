import { execFile, spawn } from 'node:child_process'
import { existsSync, watch, type FSWatcher } from 'node:fs'
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { DATA_DIR } from './settings.ts'

// A card's motion opened in Blender: her model and the motion (a VMD) loaded by MMD Tools, a working .blend saved up
// front so Ctrl+S just saves, and every save exported as a VMD that comes back to the app. Blender is the user's own
// install, found on its own or picked by the user once; a phone never starts it.

export const BLENDER_DIR = join(DATA_DIR, 'blender')
/** The blender.exe the user picked, when it wasn't found on its own. */
const PICKED = join(BLENDER_DIR, 'blender-path.txt')
/** Saves in Blender come close together (an export after each): one read per burst. */
const SETTLE_MS = 200

/** Only Blender itself: a path the app hands over is never run unless it is blender.exe (or blender). */
export const isBlenderExe = (path: string) => /^blender(\.exe)?$/i.test(basename(path)) && existsSync(path)

const regDefault = (key: string) =>
  new Promise<string | undefined>((done) => {
    execFile('reg', ['query', key, '/ve'], { windowsHide: true, timeout: 5000 }, (err, out) => done(err ? undefined : /REG_SZ\s+(.+)/.exec(out)?.[1]?.trim()))
  })

/** blender.exe as Windows knows it: the program that opens .blend files, then the usual install folders. */
async function search(): Promise<string | undefined> {
  if (process.platform !== 'win32') return ['/Applications/Blender.app/Contents/MacOS/Blender', '/usr/bin/blender', '/snap/bin/blender'].find(existsSync)
  for (const hive of ['HKCU', 'HKLM']) {
    const prog = await regDefault(`${hive}\\SOFTWARE\\Classes\\.blend`)
    const cmd = prog && (await regDefault(`${hive}\\SOFTWARE\\Classes\\${prog}\\shell\\open\\command`))
    const exe = cmd && /^"([^"]+)"|^(\S+)/.exec(cmd)
    // The launcher (blender-launcher.exe) is a wrapper with no console: Blender itself sits beside it.
    const path = exe && join(dirname(exe[1] ?? exe[2]!), 'blender.exe')
    if (path && existsSync(path)) return path
  }
  const roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter((d): d is string => !!d)
  for (const root of roots) {
    const foundation = join(root, 'Blender Foundation')
    const versions = (await readdir(foundation).catch(() => [] as string[])).filter((d) => /^Blender/i.test(d))
    // The newest first: "Blender 5.2" sorts after "Blender 4.5" by its numbers.
    versions.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
    for (const v of versions) if (existsSync(join(foundation, v, 'blender.exe'))) return join(foundation, v, 'blender.exe')
    const steam = join(root, 'Steam', 'steamapps', 'common', 'Blender', 'blender.exe')
    if (existsSync(steam)) return steam
  }
  return undefined
}

/** Where Blender is: `picked` (the user just chose it, and it is remembered), the one picked before, or a search. */
export async function findBlender(picked?: string): Promise<string | undefined> {
  if (picked) {
    if (!isBlenderExe(picked)) return undefined
    await mkdir(BLENDER_DIR, { recursive: true })
    await writeFile(PICKED, picked)
    return picked
  }
  if (process.env.WC_BLENDER) return process.env.WC_BLENDER
  const before = (await readFile(PICKED, 'utf8').catch(() => '')).trim()
  return before && isBlenderExe(before) ? before : search()
}

/** The script Blender runs: it loads her, pre-saves the .blend, and exports a VMD after each save. */
export const EDIT_SCRIPT = String.raw`# Waifufy Code: her motion in Blender (written by the app; it is rewritten each time).
import bpy, os, sys, json, addon_utils

A = sys.argv[sys.argv.index('--') + 1:]
A = dict(zip(A[0::2], A[1::2]))
EXT = '.vmd'


def status(**kw):
    with open(A['--status'], 'w', encoding='utf-8') as f:
        json.dump(kw, f)


def has_mmd_tools():
    return hasattr(bpy.types, 'MMD_TOOLS_OT_export_vmd')


def enable_mmd_tools():
    if has_mmd_tools():
        return True
    for m in addon_utils.modules():
        if m.__name__.split('.')[-1] == 'mmd_tools':
            try:
                addon_utils.enable(m.__name__, default_set=True, persistent=True)
            except Exception:
                pass
    return has_mmd_tools()


def window():
    wm = bpy.context.window_manager
    return wm.windows[0] if wm.windows else None


def root():
    return next((o for o in bpy.data.objects if getattr(o, 'mmd_type', '') == 'ROOT'), None)


def select_root():
    r = root()
    if not r:
        return None
    for o in bpy.context.view_layer.objects:
        o.select_set(False)
    r.select_set(True)
    bpy.context.view_layer.objects.active = r
    return r


def setup():
    try:
        if not enable_mmd_tools():
            status(error='MMD Tools is not installed in Blender. In Blender: Edit > Preferences > Get Extensions, search "MMD Tools", Install, then open it from the app again.')
            return None
        with bpy.context.temp_override(window=window()):
            for o in list(bpy.data.objects):
                bpy.data.objects.remove(o, do_unlink=True)
            scene = bpy.context.scene
            scene.frame_start = 1
            scene.frame_current = 1
            bpy.ops.mmd_tools.import_model(filepath=A['--pmx'], scale=0.08)
            if not select_root():
                status(error='MMD Tools did not load her model.')
                return None
            bpy.ops.mmd_tools.import_vmd(filepath=A['--vmd'], scale=0.08, margin=0)
            # A pose changed without a keyframe would be left out of the export: Blender keys what is moved.
            scene.tool_settings.use_keyframe_insert_auto = True
            bpy.ops.wm.save_as_mainfile(filepath=A['--blend'])
        status(state='ready')
    except Exception as e:
        status(error='Blender could not load her: %s' % e)
    return None


def export():
    try:
        out = A['--out']
        part = out[:-len(EXT)] + '.part' + EXT
        if os.path.exists(part):
            os.remove(part)
        with bpy.context.temp_override(window=window()):
            if not select_root():
                status(error='Her model is gone from the scene, so nothing was exported.')
                return None
            bpy.ops.mmd_tools.export_vmd(filepath=part, scale=12.5)
        # MMD Tools reports a failed export and still finishes: only the file says it worked.
        if not os.path.exists(part) or os.path.getsize(part) == 0:
            status(error='MMD Tools did not export the motion (see the Info log in Blender).')
            return None
        os.replace(part, out)
        status(state='saved')
    except Exception as e:
        status(error='The motion was not exported: %s' % e)
    return None


@bpy.app.handlers.persistent
def saved(path):
    if os.path.normcase(os.path.abspath(path)) == os.path.normcase(os.path.abspath(A['--blend'])):
        bpy.app.timers.register(export, first_interval=0.05)


bpy.app.handlers.save_post.append(saved)
bpy.app.timers.register(setup, first_interval=0.2)
`

export type BlenderJob = {
  exe: string
  /** Her model, the active card's .pmx. */
  pmx: string
  /** A folder name for this card and emotion (both checked by the caller). */
  name: string
  /** The motion to start from. */
  vmd: Buffer
  /** Each save in Blender: the motion as it is now. */
  onSaved(vmd: Buffer): void
  onError(error: string): void
}

/** The watcher on each open job, so opening the same motion again doesn't hear its saves twice. */
const open = new Map<string, FSWatcher>()

/** Starts Blender on `job`. Resolves once it has started; saves and errors come through the job's callbacks. */
export async function openInBlender(job: BlenderJob) {
  const dir = join(BLENDER_DIR, job.name)
  await mkdir(dir, { recursive: true })
  const files = { script: join(dir, 'edit.py'), vmd: join(dir, 'start.vmd'), blend: join(dir, 'edit.blend'), out: join(dir, 'saved.vmd'), status: join(dir, 'status.json') }
  await Promise.all([writeFile(files.script, EDIT_SCRIPT), writeFile(files.vmd, job.vmd), writeFile(files.status, '{}')])
  open.get(job.name)?.close()

  let timer: NodeJS.Timeout | undefined
  let lastOut = 0
  let lastStatus = ''
  const check = async () => {
    const st = await readFile(files.status, 'utf8').catch(() => '')
    if (st !== lastStatus) {
      lastStatus = st
      const error = (() => {
        try {
          return (JSON.parse(st) as { error?: unknown }).error
        } catch {
          return undefined
        }
      })()
      if (typeof error === 'string') job.onError(error)
    }
    const t = (await stat(files.out).catch(() => undefined))?.mtimeMs ?? 0
    if (t > lastOut) {
      lastOut = t
      const buf = await readFile(files.out).catch(() => undefined)
      if (buf) job.onSaved(buf)
    }
  }
  // An old export from an earlier run isn't a save of this one.
  lastOut = (await stat(files.out).catch(() => undefined))?.mtimeMs ?? 0
  const watcher = watch(dir, () => {
    clearTimeout(timer)
    timer = setTimeout(() => void check(), SETTLE_MS)
  })
  open.set(job.name, watcher)

  const args = ['--python', files.script, '--', '--pmx', job.pmx, '--vmd', files.vmd, '--blend', files.blend, '--out', files.out, '--status', files.status]
  // A .mjs stands in for Blender in the tests.
  const [cmd, argv] = job.exe.endsWith('.mjs') ? [process.execPath, [job.exe, ...args]] : [job.exe, args]
  await new Promise<void>((done, fail) => {
    const child = spawn(cmd, argv, { detached: true, stdio: 'ignore' })
    child.once('spawn', () => done())
    child.once('error', (e) => fail(e))
    child.once('exit', () => {
      // Its last save may still be settling.
      setTimeout(() => {
        void check().finally(() => {
          if (open.get(job.name) === watcher) open.delete(job.name)
          watcher.close()
        })
      }, SETTLE_MS * 2)
    })
    child.unref()
  })
}
