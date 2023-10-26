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

const isWindows = process.platform === 'win32'

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
  const d1 = spawn(process.execPath, [
    ...process.execArgv,
    daemon,
    'defer test 1',
  ])
  const out1: Buffer[] = []
  d1.stdout.on('data', c => out1.push(c))
  await new Promise<void>(r => d1.stdout.once('data', () => r()))
  await new Promise<void>(r => setTimeout(r, 100))
  const d2 = spawn(process.execPath, [
    ...process.execArgv,
    daemon,
    'defer test 2',
  ])
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
  console.error('killing first daemon')
  try {
    process.kill(d1.pid!, 'SIGHUP')
  } catch {}
  try {
    process.kill(d1.pid!, 'SIGTERM')
  } catch {}
  try {
    process.kill(d2.pid!, 'SIGHUP')
  } catch {}
  try {
    process.kill(d2.pid!, 'SIGTERM')
  } catch {}
  await done
})

t.test('spin up a server and ask it a question', async t => {
  const c = new TestClient()
  const bar = await c.fooIntoBar('foo string')
  t.equal(bar, 'bar: foo string')
  // non-request message gets ignored (no-op for coverage)
  const [head, body] = message({ hello: 'world' })
  console.error(
    'writing non-request message',
    [head, body],
    !!c.connection
  )
  c.connection?.write(head)
  c.connection?.write(body)
  await new Promise<void>(r => setTimeout(r, 50))
})

t.test('kill wedged non-server process', async t => {
  const d = spawn(process.execPath, [
    '-e',
    'setInterval(() => {}, 100000); console.log("READY")',
  ])
  await new Promise<void>(r => d.stdout.on('data', () => r()))
  await new Promise<void>(r => setTimeout(r, 100))
  console.error('wedged process', d.pid)
  writeFileSync('.test-service/daemon/pid', String(d.pid))
  const exit = new Promise<{
    code: number | null
    signal: NodeJS.Signals | null
  }>(r => d.on('close', (code, signal) => r({ code, signal })))
  const c = new TestClient()
  const bar = c.fooIntoBar('foo wedge test')
  // just in case, don't hang the test forever
  setTimeout(() => {
    try {
      d.kill('SIGKILL')
    } catch {}
  }, 5000).unref()
  const response = await bar
  t.equal(response, 'bar: foo wedge test')
  console.error('got response', response)
  t.strictSame(
    await exit,
    isWindows
      ? { code: 1, signal: null }
      : { code: null, signal: 'SIGTERM' }
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
    try {
      process.on('SIGHUP', () => {})
    } catch {}
    `,
  ])
  await new Promise<void>(r => d.stdout.on('data', () => r()))
  await new Promise<void>(r => setTimeout(r, 100))
  writeFileSync('.test-service/daemon/pid', String(d.pid))
  console.error('unesponsive server started', d.pid)
  const exit = new Promise<{
    code: number | null
    signal: NodeJS.Signals | null
  }>(r => d.on('close', (code, signal) => r({ code, signal })))
  const c = new TestClient()
  const bar = c.fooIntoBar('foo unesponsive silent server')
  console.error('sent request', c.requests, bar)
  // just in case, don't hang the test forever
  setTimeout(() => {
    try {
      d.kill('SIGKILL')
    } catch {}
  }, 5000).unref()
  const response = await bar
  console.error('got response', { response })
  t.equal(response, 'bar: foo unesponsive silent server')

  t.match(
    await exit,
    isWindows
      ? { code: 1, signal: null }
      : { code: null, signal: 'SIGTERM' }
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
    try {
      process.on('SIGHUP', () => {})
    } catch {}
    `,
  ])
  await new Promise<void>(r => d.stdout.on('data', () => r()))
  await new Promise<void>(r => setTimeout(r, 100))
  writeFileSync('.test-service/daemon/pid', String(d.pid))
  console.error('writing unresponsive server started', d.pid)
  const exit = new Promise<{
    code: number | null
    signal: NodeJS.Signals | null
  }>(r => d.on('close', (code, signal) => r({ code, signal })))
  const c = new TestClient()
  const bar = c.fooIntoBar('foo unesponsive writing server')
  console.error('sent request', c.requests, bar)
  // just in case, don't hang the test forever
  setTimeout(() => {
    try {
      d.kill('SIGKILL')
    } catch {}
  }, 5000).unref()
  const response = await bar
  console.error('got response', { response })
  t.equal(response, 'bar: foo unesponsive writing server')

  t.match(
    await exit,
    isWindows
      ? { code: 1, signal: null }
      : { code: null, signal: 'SIGTERM' }
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
