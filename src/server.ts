import { mkdirp } from 'mkdirp'
import { Serializable } from 'node:child_process'
import { unlinkSync } from 'node:fs'
import { readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { connect, createServer, Server } from 'node:net'
import { resolve } from 'node:path'
import { onExit } from 'signal-exit'
import { message, socketPostMessage } from 'socket-post-message'
import { isPing, isPong, ping, Pong, pong } from './ping.js'
import { reportReady } from './report-ready.js'

const cwd = process.cwd()
const isWindows = process.platform === 'win32'

export interface MessageBase
  extends Record<string, Serializable | null | undefined> {
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
  #socket: string
  #pidFile: string
  #logFile: string
  #mtimeFile: string
  #didOnExit = false
  #daemonScript?: string

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
    this.#daemonScript =
      process.env[`SOCK_DAEMON_SCRIPT_${this.#name}`]
  }

  get idleTimeout() {
    return this.#idleTimeout
  }
  get connectionTimeout() {
    return this.#connectionTimeout
  }
  get path() {
    return this.#path
  }
  get socket() {
    return this.#socket
  }
  get logFile() {
    return this.#logFile
  }
  get pidFile() {
    return this.#pidFile
  }
  get mtimeFile() {
    return this.#mtimeFile
  }
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

  #idleTick() {
    /* c8 ignore next */
    if (!this.#idleTimeout) return
    if (this.#idleTimer) clearTimeout(this.#idleTimer)
    this.#idleTimer = setTimeout(
      () => this.close(),
      this.#idleTimeout
    )
    this.#idleTimer.unref()
  }

  close() {
    /* c8 ignore next */
    if (!this.#server) return
    console.error('close server')
    this.#server.close()
    this.#server = undefined
    try {
      unlinkSync(this.#pidFile)
      /* c8 ignore next */
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

  // we know that the socket exists, because we got an EADDRINUSE
  // try to ping the server, and if it's valid, exit.
  async #checkForOtherDaemon() {
    console.error('check for other daemon')
    const pidExists = await stat(this.#pidFile)
      .then(st => st.isFile())
      .catch(() => false)

    if (pidExists) {
      // send a ping to verify it's running.
      // if not, we take over.
      await new Promise<void>(res => {
        const conn = connect(this.#socket)
        const messageHost = socketPostMessage(conn)
        /* c8 ignore start */
        conn.on('error', er => {
          console.error('other daemon check error', er)
          conn.destroy()
          res()
        })
        conn.on('timeout', () => {
          console.error('other daemon check timeout')
          conn.destroy()
          res()
        })
        messageHost.on('error', er => {
          console.error('other daemon check mh error', er)
          conn.destroy()
          res()
        })
        /* c8 ignore stop */
        conn.setTimeout(50)
        const id = `${this.#name}-daemon-${process.pid}`
        const p = ping(id)
        messageHost.postMessage(p)
        messageHost.on('message', (msg: Pong) => {
          if (isPong(msg, p)) {
            reportReady('ALREADY RUNNING')
            process.exit()
          }
          /* c8 ignore start */
          conn.destroy()
          res()
          /* c8 ignore stop */
        })
        // if we get a data event that is not pong, that's a failure
        conn.on('data', () => {
          conn.destroy()
          res()
        })
        conn.on('close', () => {
          conn.destroy()
          res()
        })
        /* c8 ignore start */
        conn.on('end', () => {
          conn.destroy()
          res()
        })
        /* c8 ignore start */
      })
    }
    await this.#killFormerPid('SIGHUP')
    await unlink(this.#socket).catch(() => {})
  }

  /**
   * Check if a daemon server is already running for this cwd/name,
   * and if so, gracefully exit.
   * Otherwise, start up the server and write process id to the pidFile
   */
  async listen() {
    console.error('listen')
    await mkdirp(this.#path)
    // if we have a script filename, and the mtimeFile is present,
    // and mtimeFile does not match the mtime of the script filename,
    // then we MUST restart.
    if (this.#daemonScript) {
      const [mtimeExpect, mtimeActual] = await Promise.all([
        readFile(this.#mtimeFile)
          .then(s => Number(s) || undefined)
          .catch(() => undefined),
        stat(this.#daemonScript)
          .then(st => Number(st.mtime))
          .catch(undefined),
      ])
      if (mtimeExpect && mtimeActual && mtimeExpect !== mtimeActual) {
        await this.#killFormerPid('SIGHUP')
      }
    }

    const server = createServer(conn => {
      this.#idleTick()
      const messageHost = socketPostMessage(conn)
      if (this.#connectionTimeout) {
        conn.setTimeout(this.#connectionTimeout)
      }
      messageHost.on('message', async msg => {
        this.#idleTick()
        if (isPing(msg)) {
          // write pongs as a single data write
          const [phead, pbody] = message(pong(msg))
          conn.write(Buffer.concat([phead, pbody]))
          return
        }
        if (!this.isRequest(msg)) return
        messageHost.postMessage({
          ...(await this.handle(msg as Request)),
          id: msg.id,
        })
      })
      /* c8 ignore start */
      conn.on('timeout', () => conn.destroy())
      conn.on('error', er => {
        console.error('connection error on server', er)
        conn.destroy()
      })
      /* c8 ignore stop */
    })

    server.on('error', async er => {
      await this.#onServerError(server, er)
    })

    server.listen(this.#socket, () => this.#onListen(server))

    if (!this.#didOnExit) {
      onExit(() => this.close())
      this.#didOnExit = true
    }
  }

  async #onServerError(server: Server, er: Error) {
    console.error('server error event', er)
    if ((er as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      await this.#checkForOtherDaemon()
      server.listen(this.#socket, () => this.#onListen(server))
      /* c8 ignore start */
    } else {
      throw er
    }
    /* c8 ignore stop */
  }

  async #killFormerPid(sig = 'SIGTERM') {
    const formerPid = await readFile(this.#pidFile, 'utf8')
      // ignore empty pid file
      /* c8 ignore start */
      .then(s => (s ? Number(s) : undefined))
      /* c8 ignore stop */
      .catch(() => undefined)
    if (formerPid && typeof formerPid === 'number') {
      console.error('kill former pid', formerPid)
      // platform-specific stuff here
      /* c8 ignore start */
      const signal = !isWindows ? sig : 'SIGTERM'
      let sigRes: boolean = false
      try {
        sigRes = process.kill(formerPid, signal)
      } catch {}
      if (signal === 'SIGHUP' && sigRes) {
        await new Promise<void>(r => setTimeout(r, 50))
        try {
          process.kill(formerPid, 'SIGTERM')
        } catch {}
      }
      /* c8 ignore stop */
    }
  }

  async #onListen(server: Server) {
    console.error('daemon listening', process.pid)
    this.#server = server
    server.removeAllListeners('error')
    await this.#killFormerPid()
    await Promise.all([
      writeFile(this.#pidFile, String(process.pid)),
      this.#daemonScript
        ? stat(this.#daemonScript)
            .then(st =>
              writeFile(this.#mtimeFile, String(Number(st.mtime)))
            )
            .catch(() => {})
        : undefined,
    ])
    reportReady('READY')
    console.error('daemon ready')
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
