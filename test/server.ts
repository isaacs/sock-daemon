import { spawn } from 'child_process'
import { readFileSync, writeFileSync } from 'fs'
import { resolve } from 'path'
import { rimraf } from 'rimraf'
import { message } from 'socket-post-message'
import t from 'tap'
import { fileURLToPath } from 'url'
import { SockDaemonClient } from '../src/client.js'
import { SockDaemonServer } from '../src/server.js'
import { TestClient, TestDaemon } from './fixtures/test-service.js'

const daemon = fileURLToPath(
  new URL('./fixtures/daemon.mts', import.meta.url)
)
const socketPath =
  (process.platform === 'win32' ? '\\\\?\\pipe\\' : '') +
  resolve('.test-service/daemon/socket')

const shutdown = async () => {
  try {
    process.kill(
      Number(readFileSync('.test-service/daemon/pid', 'utf8')),
      'SIGHUP'
    )
  } catch {}
  await new Promise<void>(r => setTimeout(r, 100))
  try {
    process.kill(
      Number(readFileSync('.test-service/daemon/pid', 'utf8')),
      'SIGKILL'
    )
  } catch {}
  await rimraf('.test-service/daemon/pid')
}
t.beforeEach(() => shutdown())
t.afterEach(() => shutdown())

t.test('instantiate server', t => {
  const server = new TestDaemon({
    idleTimeout: 6969,
    connectionTimeout: 420,
  })
  const {
    path,
    idleTimeout,
    connectionTimeout,
    socket,
    logFile,
    pidFile,
  } = server
  t.equal(idleTimeout, 6969)
  t.equal(connectionTimeout, 420)
  t.equal(socket, socketPath)
  t.equal(path, resolve('.test-service/daemon'))
  t.equal(logFile, resolve('.test-service/daemon/log'))
  t.equal(pidFile, resolve('.test-service/daemon/pid'))
  t.equal(server.server, undefined)
  t.end()
})

t.test('instantiate client', t => {
  const client = new TestClient()
  const {
    path,
    socket,
    logFile,
    pidFile,
    connection,
    connected,
    requests,
  } = client
  t.equal(socket, socketPath)
  t.equal(path, resolve('.test-service/daemon'))
  t.equal(logFile, resolve('.test-service/daemon/log'))
  t.equal(pidFile, resolve('.test-service/daemon/pid'))
  t.equal(connection, undefined)
  t.equal(connected, false)
  t.strictSame(requests, [])
  t.end()
})

t.test('spin up daemon, then defer to running daemon', async t => {
  const d1 = spawn(process.execPath, [...process.execArgv, daemon])
  const out1: Buffer[] = []
  d1.stdout.on('data', c => out1.push(c))
  await new Promise<void>(r => d1.stdout.once('data', () => r()))
  await new Promise<void>(r => setTimeout(r, 100))
  const d2 = spawn(process.execPath, [...process.execArgv, daemon])
  const out2: Buffer[] = []
  d2.stdout.on('data', c => out2.push(c))
  await new Promise<void>(r => d2.stdout.once('data', () => r()))
  const done = Promise.all([
    new Promise<void>(r => d1.once('close', () => r())),
    new Promise<void>(r => d2.once('close', () => r())),
  ])
  await new Promise<void>(r => setTimeout(r, 100))
  t.equal(Buffer.concat(out1).toString('utf8').trim(), 'READY')
  t.equal(
    Buffer.concat(out2).toString('utf8').trim(),
    'ALREADY RUNNING'
  )
  try {
    process.kill(d1.pid!, 'SIGHUP')
  } catch {}
  await done
})

t.test('spin up a server and ask it a question', async t => {
  const c = new TestClient()
  const bar = await c.fooIntoBar('foo string')
  t.equal(bar, 'bar: foo string')
  t.test('ignore non-request message (no-op for coverage)', t => {
    const [head, body] = message({ id: 'hello, world' })
    c.connection?.write(head)
    c.connection?.write(body)
    t.end()
  })
})

t.test('kill wedged non-server process', async t => {
  const d = spawn(process.execPath, [
    '-e',
    'setInterval(() => {}, 100000); console.log("READY")',
  ])
  writeFileSync('.test-service/daemon/pid', String(d.pid))
  await new Promise<void>(r => d.stdout.on('data', () => r()))
  const c = new TestClient()
  const bar = await c.fooIntoBar('foo string')
  t.equal(bar, 'bar: foo string')
  // just in case, don't hang the test forever
  setTimeout(() => d.kill('SIGKILL'))
  t.equal(
    await new Promise<NodeJS.Signals | null>(r =>
      d.on('close', (_, signal) => r(signal))
    ),
    'SIGTERM'
  )
})

t.test('kill server process that fails ping', async t => {
  const d = spawn(process.execPath, [
    '-e',
    `
    server = require('net').createServer(c => {})
    server.listen(${JSON.stringify(
      socketPath
    )}, () => console.log('READY'))
    process.on('SIGHUP', () => {})
    `,
  ])
  await new Promise<void>(r => d.stdout.on('data', () => r()))
  writeFileSync('.test-service/daemon/pid', String(d.pid))
  const c = new TestClient()
  const bar = await c.fooIntoBar('foo string')
  t.equal(bar, 'bar: foo string')
  // just in case, don't hang the test forever
  setTimeout(() => d.kill('SIGKILL'))
  t.match(
    await new Promise<NodeJS.Signals | null>(r =>
      d.on('close', (_, signal) => r(signal))
    ),
    /SIG(TERM|KILL)/
  )
})

t.test('kill server process that fails ping but writes', async t => {
  const d = spawn(process.execPath, [
    '-e',
    `
    server = require('net').createServer(c => c.write('hello'))
    server.listen(${JSON.stringify(
      socketPath
    )}, () => console.log('READY'))
    process.on('SIGHUP', () => {})
    `,
  ])
  await new Promise<void>(r => d.stdout.on('data', () => r()))
  writeFileSync('.test-service/daemon/pid', String(d.pid))
  const c = new TestClient()
  const bar = await c.fooIntoBar('foo string')
  t.equal(bar, 'bar: foo string')
  // just in case, don't hang the test forever
  setTimeout(() => d.kill('SIGKILL'))
  t.match(
    await new Promise<NodeJS.Signals | null>(r =>
      d.on('close', (_, signal) => r(signal))
    ),
    /SIG(TERM|KILL)/
  )
})

t.test('base class stuff', t => {
  const s = SockDaemonServer.prototype
  t.equal(s.isRequest({ id: 'x' }), true)
  t.throws(() => SockDaemonServer.serviceName)

  const c = SockDaemonClient.prototype
  t.equal(c.isResponse({ id: 'x' }), true)
  t.throws(() => SockDaemonClient.serviceName)
  t.throws(() => SockDaemonClient.daemonScript)
  t.end()
})

t.test('abort request', async t => {
  const c = new TestClient()
  // make one request to do ping and verify connection
  t.equal(
    await c.fooIntoBar('foo', new AbortController().signal),
    'bar: foo'
  )
  const ac = new AbortController()
  const p = c.request({ foo: 'first' }, ac.signal)
  const p2 = c.request({ foo: 'second' })
  ac.abort(new Error('testing'))
  c.clear()
  await Promise.all([t.rejects(p), t.rejects(p2)])
  c.clear()
  c.disconnect()
})
