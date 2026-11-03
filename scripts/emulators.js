// Starts the Firestore emulator for local development (npm run emulators).
// - Data persists in ./data/firestore: imported on start, exported on exit (Ctrl+C).
// - The emulator needs Java 21+: if the default `java` is older, a newer JDK is looked up
//   in JAVA_HOME and the usual install folders.
const { spawn, spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const MIN_JAVA = 21
const DATA_DIR = path.join(__dirname, '..', 'data', 'firestore')

function javaMajor(javaBin) {
  const res = spawnSync(javaBin, ['-version'], { encoding: 'utf8' })
  const match = /version "(\d+)(?:\.(\d+))?/.exec(`${res.stderr}${res.stdout}`)
  if (!match) return 0
  return match[1] === '1' ? Number(match[2]) : Number(match[1])  // "1.8" → 8
}

function findJavaHome() {
  if (javaMajor('java') >= MIN_JAVA) return null   // default java is fine
  const exe = process.platform === 'win32' ? 'java.exe' : 'java'
  const candidates = []
  if (process.env.JAVA_HOME) candidates.push(process.env.JAVA_HOME)
  const roots = process.platform === 'win32'
    ? ['C:\\Program Files\\Java', 'C:\\Program Files\\Eclipse Adoptium', 'C:\\Program Files\\Microsoft']
    : ['/usr/lib/jvm', '/Library/Java/JavaVirtualMachines']
  for (const root of roots) {
    if (!fs.existsSync(root)) continue
    for (const dir of fs.readdirSync(root)) {
      candidates.push(path.join(root, dir), path.join(root, dir, 'Contents', 'Home'))
    }
  }
  const found = candidates
    .map(home => ({ home, major: fs.existsSync(path.join(home, 'bin', exe)) ? javaMajor(path.join(home, 'bin', exe)) : 0 }))
    .filter(c => c.major >= MIN_JAVA)
    .sort((a, b) => b.major - a.major)[0]
  if (!found) {
    console.error(`✗ El emulador de Firestore necesita Java ${MIN_JAVA} o superior. Instálalo (p. ej. Temurin ${MIN_JAVA}) o define JAVA_HOME.`)
    process.exit(1)
  }
  return found.home
}

const env = { ...process.env }
const javaHome = findJavaHome()
if (javaHome) {
  env.JAVA_HOME = javaHome
  env.PATH = `${path.join(javaHome, 'bin')}${path.delimiter}${env.PATH ?? env.Path ?? ''}`
  delete env.Path
  console.log(`☕ Java para el emulador: ${javaHome}`)
}

fs.mkdirSync(DATA_DIR, { recursive: true })
// Relative path (cwd = backend root): with shell: true an absolute path with spaces would be split
const dataArg = 'data/firestore'
const args = ['emulators:start', '--only', 'firestore', '--export-on-exit', dataArg]
if (fs.existsSync(path.join(DATA_DIR, 'firebase-export-metadata.json'))) args.push('--import', dataArg)

const child = spawn('firebase', args, { env, stdio: 'inherit', shell: process.platform === 'win32', cwd: path.join(__dirname, '..') })
child.on('exit', code => process.exit(code ?? 0))
// Ctrl+C reaches the firebase process directly (same console); keep this one alive until it exports
process.on('SIGINT', () => {})
