// Builds the Android app (the phone remote, docs/V0.5.md R77–R78) as a signed release APK for arm64 phones.
//
//   node scripts/build-android.mjs            → build/android/Waifufy-Code-<version>-arm64.apk
//   node scripts/build-android.mjs --rust     stops after the native library when the CLI can't link it (no
//                                             Developer Mode), skipping Gradle: a quick check of the Rust side
//
// Needs JDK 17, the Android SDK (platform 37, build-tools, NDK 28) and the Rust target aarch64-linux-android.
// JAVA_HOME / ANDROID_HOME / NDK_HOME are filled in from the usual install places when unset. Signing uses
// ~/.android/waifufy-code-keystore.properties (or WAIFUFY_KEYSTORE); without it the APK comes out unsigned.
//
// Two Windows workarounds live here:
// - Cargo.toml's crate-type stays ["rlib"] for the desktop (a windows-gnu cdylib fails to link), so this adds
//   staticlib and cdylib for the Android build only, and puts the file back after.
// - `tauri android build` symlinks the library into the Gradle project, which Windows refuses without Developer
//   Mode. When it does, the library is copied in instead and Gradle runs without its Rust step.

import { execSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/(\w:)/, '$1')
const APP = join(ROOT, 'app')
const TAURI = join(APP, 'src-tauri')
const ANDROID = join(TAURI, 'gen', 'android')
const CARGO = join(TAURI, 'Cargo.toml')
const LIB = join(TAURI, 'target', 'aarch64-linux-android', 'release', 'libwaifufy_code_lib.so')
const JNI = join(ANDROID, 'app', 'src', 'main', 'jniLibs', 'arm64-v8a')
const rustOnly = process.argv.includes('--rust')

const local = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local')
const newest = (dir) => (existsSync(dir) ? readdirSync(dir).sort().at(-1) : undefined)
const env = { ...process.env }
if (!env.ANDROID_HOME) env.ANDROID_HOME = join(local, 'Android', 'Sdk')
if (!env.NDK_HOME) {
  const ndk = newest(join(env.ANDROID_HOME, 'ndk'))
  if (ndk) env.NDK_HOME = join(env.ANDROID_HOME, 'ndk', ndk)
}
if (!env.JAVA_HOME) {
  const jdk = newest('C:\\Program Files\\Microsoft')?.startsWith('jdk-17') ? newest('C:\\Program Files\\Microsoft') : undefined
  if (jdk) env.JAVA_HOME = join('C:\\Program Files\\Microsoft', jdk)
}
if (env.JAVA_HOME) env.PATH = `${join(env.JAVA_HOME, 'bin')};${env.PATH}`
for (const k of ['ANDROID_HOME', 'NDK_HOME', 'JAVA_HOME']) if (!env[k] || !existsSync(env[k])) throw new Error(`${k} not found; install it or set it`)

const run = (cmd, cwd, opts = {}) => execSync(cmd, { cwd, env, stdio: 'inherit', ...opts })

const original = readFileSync(CARGO, 'utf8')
const forAndroid = original.replace(/crate-type = \["rlib"\]/, 'crate-type = ["staticlib", "cdylib", "rlib"]')
if (forAndroid === original) throw new Error('Cargo.toml has no crate-type = ["rlib"] line to widen')
writeFileSync(CARGO, forAndroid)
try {
  let apkBuilt = false
  // A library left from an earlier build must not pass for this one.
  rmSync(LIB, { force: true })
  try {
    // The CLI builds the library, then (with Developer Mode) links it in and runs Gradle itself.
    run('npx tauri android build --apk --target aarch64', APP)
    apkBuilt = true
  } catch (e) {
    if (!existsSync(LIB)) throw e
    console.log('build-android: the library is built; the CLI could not symlink it (no Developer Mode), so it is copied instead')
  }
  if (rustOnly && !apkBuilt) {
    console.log(`build-android: ${LIB}`)
  } else {
    if (!apkBuilt) {
      mkdirSync(JNI, { recursive: true })
      copyFileSync(LIB, join(JNI, 'libwaifufy_code_lib.so'))
      // One JVM for everything (Kotlin compiles in-process, no daemon left behind): the lightest build, since a
      // separate Kotlin daemon next to Gradle's has run a 16 GB machine out of memory.
      // By full path: cmd doesn't always look in the current folder (NoDefaultCurrentDirectoryInExePath).
      run(
        `"${join(ANDROID, 'gradlew.bat')}" assembleArm64Release -x rustBuildArm64Release -PabiList=arm64-v8a -ParchList=arm64 -PtargetList=aarch64 `
          + '-Pkotlin.compiler.execution.strategy=in-process --no-daemon --console=plain',
        ANDROID,
        { shell: true },
      )
    }
    const outDir = join(ANDROID, 'app', 'build', 'outputs', 'apk', 'arm64', 'release')
    const apk = readdirSync(outDir).find((f) => f.endsWith('.apk'))
    if (!apk) throw new Error(`no APK in ${outDir}`)
    const version = JSON.parse(readFileSync(join(TAURI, 'tauri.conf.json'), 'utf8')).version
    const dest = join(ROOT, 'build', 'android')
    mkdirSync(dest, { recursive: true })
    const target = join(dest, `Waifufy-Code-${version}-arm64${apk.includes('unsigned') ? '-unsigned' : ''}.apk`)
    copyFileSync(join(outDir, apk), target)
    console.log(`build-android: ${target}`)
  }
} finally {
  writeFileSync(CARGO, original)
}
