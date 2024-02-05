import { Serializable } from 'node:child_process'
import { unlinkSync } from 'node:fs'
import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { connect, createServer, Server } from 'node:net'
import { resolve } from 'node:path'
import { onExit } from 'signal-exit'
import { message, socketPostMessage } from 'socket-post-message'
import { isPing, isPong, ping, Pong, pong } from './ping.js'
import { reportReady } from './report-ready.js'
import { StartingLock } from './starting-lock.js'

// put undefined in the type just so that ts allows checking
// for undefined being in the set, even though it isn't there.
const socketExistCodes: Set<string | undefined> = new Set([
  'EEXIST',
  'EADDRINUSE',
])

const cwd = process.cwd()
const isWindows = process.platform === 'win32'
/* c8 ignore start */
const log = /\bSOCK-?DAEMON\b/i.test(process.env.NODE_DEBUG ?? '')
  ? (...msg: any[]) => {
      console.error(process.pid, ...msg)
    }
  : () => {}
/* c8 ignore stop */

/**
 * Object which can be serialized, and has an id string
 */
export interface MessageBase
  extends Record<string, Serializable | null | undefined> {
  id: string
}

/**
 * Options for the SockDaemonServer constructor
 */
export interface SockDaemonServerOptions {
  /**
   * Time in milliseconds before the daemon will close if no requests
   * are received. Defaults to `3_600_000` (1 hour)
   */
  idleTimeout?: number
  /**
   * Time in milliseconds before a connection will be disconnected if
   * it does not make any requests. Defaults to `1000` (1 second)
   */
  connectionTimeout?: number
}

/**
 * Extend this class to create a SockDaemonService that is used by your
 * daemonScript program to service requests.
 */
export abstract class SockDaemonServer<
  Request extends MessageBase = MessageBase,
  Response extends MessageBase = MessageBase
> {
  #name: string
  #server?: Server
  #connectionTimeout: number = 1_000
  #idleTimeout: number = 60 * 60 * 1000
  #idleTimer?: NodeJS.Timeout
  #path: string
  #socket: string
  #pidFile: string
  #logFile: string
  #mtimeFile: string
  #didOnExit = false
  #daemonScript?: string
  #startingLock: StartingLock

  constructor(options: SockDaemonServerOptions = {}) {
    this.#name = (
      this.constructor as typeof SockDaemonServer
    ).serviceName
    if (typeof options.connectionTimeout === 'number') {
      this.#connectionTimeout = options.connectionTimeout
    }
    if (typeof options.idleTimeout === 'number') {
      this.#idleTimeout = options.idleTimeout
    }
    this.#path = resolve(cwd, `.${this.#name}`, 'daemon')
    this.#socket = resolve(this.#path, 'socket')
    /* c8 ignore start */
    if (isWindows) {
      this.#socket = resolve('//?/pipe/' + this.#socket)
    }
    /* c8 ignore stop */
    this.#mtimeFile = resolve(this.#path, 'mtime')
    this.#pidFile = resolve(this.#path, 'pid')
    this.#logFile = resolve(this.#path, 'log')
    this.#startingLock = new StartingLock(this.#path)
    this.#daemonScript =
      process.env[`SOCK_DAEMON_SCRIPT_${this.#name}`]
  }

  /**
   * Time in milliseconds before the daemon will close if no requests
   * are received. Defaults to `3_600_000` (1 hour)
   */
  get idleTimeout() {
    return this.#idleTimeout
  }

  /**
   * Time in milliseconds before a connection will be disconnected if
   * it does not make any requests. Defaults to `1000` (1 second)
   */
  get connectionTimeout() {
    return this.#connectionTimeout
  }

  /**
   * The folder where this daemon service stores stuff
   */
  get path() {
    return this.#path
  }

  /**
   * Path to the socket used by this service
   */
  get socket() {
    return this.#socket
  }

  /**
   * Path where daemon logs are written
   */
  get logFile() {
    return this.#logFile
  }

  /**
   * File containing the daemon process ID
   */
  get pidFile() {
    return this.#pidFile
  }

  /**
   * File containing the numeric mtime of the daemon script, so that it
   * can be restarted on change.
   */
  get mtimeFile() {
    return this.#mtimeFile
  }

  /**
   * When listening, the net.Server object
   */
  get server() {
    return this.#server
  }

  /**
   * The name of the service. Must match the value set in the
   * SockDaemonClient class that connects to this service.
   */
  static get serviceName(): string {
    throw new Error(
      `${this.constructor.name} class must define static 'serviceName' getter`
    )
  }

  #idleTick(n = this.#idleTimeout) {
    /* c8 ignore next */
    if (this.#idleTimer) clearTimeout(this.#idleTimer)
    /* c8 ignore next */
    if (!this.#idleTimeout) return
    this.#idleTimer = setTimeout(() => this.close(), n)
    this.#idleTimer.unref()
  }

  /**
   * Stop listening for requests and close the socket.
   */
  close() {
    /* c8 ignore next */
    if (!this.#server) return
    log('close server')
    this.#server.close()
    this.#server = undefined
    try {
      unlinkSync(this.#pidFile)
      /* c8 ignore next */
    } catch {}
  }

  /**
   * Check if the supplied object is a MessageBase
   */
  isMessage(msg: any): msg is MessageBase {
    return (
      !!msg &&
      typeof msg === 'object' &&
      !Array.isArray(msg) &&
      typeof msg.id === 'string'
    )
  }

  isRequest(msg: any): msg is Request {
    return this.isMessage(msg)
  }

  /**
   * Method that receives Request objects and returns a
   * Response object to be sent over the socket to the client.
   */
  abstract handle(
    msg: Request
  ):
    | (Omit<Response, 'id'> & { id?: string })
    | Promise<Omit<Response, 'id'> & { id?: string }>

  /**
   * Check if a daemon server is already running for this cwd/name,
   * and if so, gracefully exit.
   * Otherwise, start up the server and write process id to the pidFile
   */
  async listen(): Promise<void> {
    await mkdir(this.#path, { recursive: true })
    try {
      await this.#startingLock.acquire()
      return this.#listen()
      /* c8 ignore start */
    } catch {
      return this.#tryConnect(1000)
    }
    /* c8 ignore stop */
  }

  // try to listen, and if we get an EEXIST or EADDRINUSE, then
  // connect and ping. If the ping fails, usurp.
  async #listen() {
    // impossible by design
    /* c8 ignore start */
    if (!this.#startingLock.acquired) {
      throw new Error('#listen() called without first acquiring lock')
    }
    /* c8 ignore stop */

    // if we don't get some kind of request in the first 10 seconds,
    // just close, probably a thundering herd issue.
    this.#idleTick(10_000)

    const server = createServer(conn => {
      const messageHost = socketPostMessage(conn)
      if (this.#connectionTimeout) {
        conn.setTimeout(this.#connectionTimeout)
      }
      messageHost.on('message', async msg => {
        if (isPing(msg)) {
          // pings don't count towards idle timeout
          // write pongs as a single data write
          const [phead, pbody] = message(pong(msg))
          conn.write(Buffer.concat([phead, pbody]))
          return
        }
        this.#idleTick()
        if (!this.isRequest(msg)) return
        messageHost.postMessage({
          ...(await this.handle(msg as Request)),
          id: msg.id,
        })
      })
      /* c8 ignore start */
      conn.on('timeout', () => conn.destroy())
      messageHost.on('error', () => conn.destroy())
      conn.on('error', () => conn.destroy())
      /* c8 ignore stop */
    })

    server.on('error', er => this.#onServerError(er))
    server.listen(this.#socket, () => this.#onListen(server))

    if (!this.#didOnExit) {
      onExit(() => this.close())
      this.#didOnExit = true
    }
  }

  async #onServerError(er: Error) {
    const { code } = er as NodeJS.ErrnoException
    if (socketExistCodes.has(code)) {
      log('listen failed', code)
      return this.#tryConnect(500)
      /* c8 ignore start */
    } else {
      log('server error event', er.message, {
        ...er,
      })
      throw er
    }
    /* c8 ignore stop */
  }

  // AWAIT_PEER state. Try connection for n ms, if it fails, usurp
  async #tryConnect(n: number) {
    // try for n ms to connect to the socket
    // if it fails, usurp
    let end = performance.now() + n
    let deferring = false
    do {
      await new Promise<void>(res => {
        const conn = connect(this.#socket)
        const destroy = () => {
          conn.destroy()
          res()
        }
        const breakLoop = () => {
          end = -1
          destroy()
        }
        const messageHost = socketPostMessage(conn)

        conn.setTimeout(
          Math.max(Math.floor(end - performance.now()), 50)
        )
        const id = `${this.#name}-daemon-${process.pid}`
        const p = ping(id)
        messageHost.postMessage(p)
        messageHost.on('message', (msg: Pong) => {
          if (isPong(msg, p)) {
            const pid = msg.pid
            log('deferring to daemon on', pid)
            reportReady('ALREADY RUNNING')
            deferring = true
            /* c8 ignore start */
            return this.#startingLock
              .release()
              .then(() => process.exit())
          }
          /* c8 ignore stop */
          log('not pong, abort connect')
          breakLoop()
        })

        // if we get a data event that is not pong, that's a failure
        conn.on('data', breakLoop)

        conn.on('error', destroy)
        conn.on('timeout', destroy)
        messageHost.on('error', destroy)
        conn.on('end', destroy)
        conn.on('close', destroy)
      })
      /* c8 ignore next */
    } while (performance.now() < end && !deferring)
    if (deferring) return
    // if we get here, it means we must usurp
    log('failed to connect')
    return await this.#usurp()
  }

  async #usurp(): Promise<void> {
    try {
      // there should only be one usurper
      await this.#startingLock.acquire()
      /* c8 ignore start */
    } catch {}

    // race condition, this is tested, but flaky to hit precisely
    /* c8 ignore start */
    if (!this.#startingLock.acquired) {
      log('usurp: lock not acquired')
      return this.#tryConnect(1000)
    }
    /* c8 ignore stop */

    log('usurp: lock acquired')
    await readFile(this.#pidFile, 'utf8')
      .then(s => process.kill(Number(s), 'SIGTERM'))
      .catch(log)
    log('usurp: read pidfile and killed')
    await Promise.all(
      [this.#socket, this.#pidFile].map(async f =>
        unlink(f).catch(log)
      )
    )
    log('usurp: unlinked socket and pidfile')
    return this.#listen()
  }

  async #onListen(server: Server) {
    log('daemon listening')
    this.#server = server
    server.removeAllListeners('error')
    reportReady('READY')

    if (this.#daemonScript) {
      try {
        const st = await stat(this.#daemonScript)
        await writeFile(
          this.#mtimeFile,
          String(Number(st.mtime)) + '\n'
        )
        /* c8 ignore next */
      } catch {}
    }
    await this.#startingLock.commit()

    // convenience while testing.
    /* c8 ignore start */
    if (process.stdin.isTTY && process.stdout.isTTY) {
      console.log('press ^D to exit gracefully')
      process.openStdin()
      process.stdin.on('end', () => this.close())
    }
    /* c8 ignore stop */
  }
}
