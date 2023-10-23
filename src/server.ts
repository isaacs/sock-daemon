import { Serializable } from 'node:child_process'
import { unlinkSync, writeFileSync } from 'node:fs'
import { readFile, stat, unlink } from 'node:fs/promises'
import { connect, createServer, Server } from 'node:net'
import { resolve } from 'node:path'
import { onExit } from 'signal-exit'
import { socketPostMessage } from 'socket-post-message'
import { reportReady } from './report-ready.js'

const cwd = process.cwd()
const isWindows = process.platform === 'win32'

export interface MessageBase extends Record<string, Serializable> {
  id: string
}

export interface SockDaemonServerOptions {
  idleTimeout?: number
  connectionTimeout?: number
}

export abstract class SockDaemonServer<
  Request extends MessageBase = MessageBase,
  Response extends MessageBase = MessageBase
> {
  #name: string
  #server?: Server
  #connectionTimeout: number = 1000
  #idleTimeout: number = 1000 * 60 * 60
  #idleTimer?: NodeJS.Timeout
  #path: string
  #socketFile: string
  #pidFile: string
  #didOnExit = false

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
    this.#socketFile = resolve(this.#path, 'socket')
    if (isWindows) {
      this.#socketFile = resolve('//pipe/?', this.#socketFile)
    }
    this.#pidFile = resolve(this.#path, 'pid')
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

  #idleTick() {
    if (!this.#idleTimeout) return
    if (this.#idleTimer) clearTimeout(this.#idleTimer)
    this.#idleTimer = setTimeout(() => this.close())
    this.#idleTimer.unref()
  }

  close() {
    if (!this.#server) return
    this.#server.close()
    this.#server = undefined
    try {
      unlinkSync(this.#pidFile)
    } catch {}
  }

  isMessage(msg: any): msg is MessageBase {
    return (
      !!msg &&
      typeof msg === 'object' &&
      !Array.isArray(msg) &&
      typeof msg.id === 'string'
    )
  }

  isRequest?: (msg: any) => msg is Request

  /**
   * Method that receives Request objects and returns a
   * Response object to be sent over the socket to the client.
   */
  abstract handle(
    msg: Request
  ):
    | (Omit<Response, 'id'> & { id?: string })
    | Promise<Omit<Response, 'id'> & { id?: string }>

  async #checkForOtherDaemon() {
    const [sockExists, pidExists] = await Promise.all([
      stat(this.#socketFile)
        .then(st => st.isSocket())
        .catch(() => false),
      stat(this.#pidFile)
        .then(st => st.isFile())
        .catch(() => false),
    ])

    if (sockExists && pidExists) {
      // send a PING to verify it's running.
      // if not, we take over.
      await new Promise<void>(res => {
        const conn = connect(this.#socketFile)
        const messageHost = socketPostMessage(conn)
        conn.setTimeout(10)
        conn.on('error', () => {
          conn.destroy()
          res()
        })
        conn.on('timeout', () => {
          conn.destroy()
          res()
        })
        const id = `${this.#name}-daemon-${process.pid}`
        messageHost.postMessage({ id, PING: 'PING' })
        messageHost.on(
          'message',
          (msg: { id: string; PING: string }) => {
            if (msg.id === id && msg.PING === 'PONG') {
              reportReady('ALREADY RUNNING')
              process.exit()
            }
          }
        )
        conn.on('data', () => {
          conn.destroy()
          res()
        })
      })

      const formerPid = await readFile(this.#pidFile, 'utf8')
        .then(s => Number(s))
        .catch(() => undefined)
      if (typeof formerPid === 'number') {
        const signal = sockExists ? 'SIGHUP' : 'SIGTERM'
        let sigRes: boolean = false
        try {
          sigRes = process.kill(formerPid, signal)
        } catch {}
        if (sockExists && sigRes) {
          await new Promise<void>(r => setTimeout(r, 100))
          try {
            process.kill(formerPid, 'SIGTERM')
          } catch {}
        }
      }
    }

    if (sockExists) await unlink(this.#socketFile).catch(() => {})
  }

  /**
   * Check if a daemon server is already running for this cwd/name,
   * and if so, gracefully exit.
   * Otherwise, start up the server and write process id to the pidFile
   */
  async listen() {
    const originalStackTraceLimit = Error.stackTraceLimit
    Error.stackTraceLimit = 0
    try {
      await this.#checkForOtherDaemon()
      writeFileSync(this.#pidFile, String(process.pid))
      this.#server = createServer(conn => {
        this.#idleTick()
        const messageHost = socketPostMessage(conn)
        if (this.#connectionTimeout) {
          conn.setTimeout(this.#connectionTimeout)
        }
        messageHost.on('message', async msg => {
          this.#idleTick()
          if (!this.isMessage(msg)) return
          // internal PING message from another daemon process
          if (msg.PING === 'PING' && Object.keys(msg).length === 2) {
            messageHost.postMessage({ id: msg.id, PING: 'PONG' })
            return
          }
          if (this.isRequest && !this.isRequest(msg)) {
            return
          }
          messageHost.postMessage({
            ...(await this.handle(msg as Request)),
            id: msg.id,
          })
        })
        conn.on('timeout', () => conn.destroy())
        conn.on('error', er => {
          console.error(er)
          conn.destroy()
        })
      })
      this.#server.listen(this.#socketFile, () => {
        reportReady('READY')
        // convenience while testing.
        if (process.stdin.isTTY && process.stdout.isTTY) {
          console.log('press ^D to exit gracefully')
          process.openStdin()
          process.stdin.on('end', () => this.close())
        }
      })
      if (!this.#didOnExit) {
        onExit(() => this.close())
        this.#didOnExit = true
      }
    } finally {
      Error.stackTraceLimit = originalStackTraceLimit
    }
  }
}
