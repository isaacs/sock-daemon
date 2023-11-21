import { spawn } from 'child_process'
import { readFileSync, statSync, utimesSync } from 'fs'
import { resolve } from 'path'
import t from 'tap'

const isWindows = process.platform === 'win32'

const onExits: (() => void)[] = []
const mockSignalExit = (fn: () => void) => onExits.push(fn)
const triggerOnExit = () => onExits.forEach(f => f())

const { StartingLock } = await t.mockImport(
  '../src/starting-lock.js',
  {
    'signal-exit': { onExit: mockSignalExit },
  }
)

t.test('acquire lock', async t => {
  const dir = t.testdir({})
  const lock = new StartingLock(dir)
  await lock.acquire()
  t.equal(statSync(resolve(dir, 'starting.lock')).isFile(), true)
  const other = new StartingLock(dir)
  await t.rejects(other.acquire())
  await lock.commit()
  t.equal(
    Number(readFileSync(resolve(dir, 'pid'), 'utf8')),
    process.pid
  )
  t.throws(() => statSync(resolve(dir, 'starting.lock')))
})

t.test('cover onExit if lock is left dangling', async t => {
  const dir = t.testdir({})
  const lock = new StartingLock(dir)
  await lock.acquire()
  t.equal(statSync(resolve(dir, 'starting.lock')).isFile(), true)
  triggerOnExit()
  t.throws(() => statSync(resolve(dir, 'starting.lock')))
})

t.test('release lock explicitly', async t => {
  const dir = t.testdir({})
  const lock = new StartingLock(dir)
  await lock.acquire()
  t.equal(statSync(resolve(dir, 'starting.lock')).isFile(), true)
  await lock.release()
  t.throws(() => statSync(resolve(dir, 'starting.lock')))
})

t.test('usurp if lock is older than 2 seconds', async t => {
  const proc = spawn(process.execPath, [
    '-e',
    'setInterval(() => {}, 10000)',
  ])
  const dir = t.testdir({ 'starting.lock': `${proc.pid}\n` })
  const exit = new Promise<{
    code: number | null
    signal: NodeJS.Signals | null
  }>(res => {
    proc.on('exit', (code, signal) => res({ code, signal }))
  })
  const old = new Date('1989-01-01')
  utimesSync(resolve(dir, 'starting.lock'), old, old)
  const lock = new StartingLock(dir)
  await lock.acquire()
  // second time is no-op, just here for coverage
  await lock.acquire()
  t.equal(
    Number(readFileSync(resolve(dir, 'starting.lock'), 'utf8')),
    process.pid
  )
  t.strictSame(
    await exit,
    isWindows
      ? { code: 1, signal: null }
      : { code: null, signal: 'SIGTERM' }
  )
})
