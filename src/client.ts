import { spawn } from 'child_process'
import { constants, openSync } from 'fs'
import { mkdir, readFile, stat, unlink } from 'fs/promises'
import { connect, Socket } from 'net'
import { resolve } from 'path'
import { message, Reader } from 'socket-post-message'
import { fileURLToPath } from 'url'
import { isPing, isPong, ping, Ping, Pong } from './ping.js'
import type { MessageBase } from './server.js'

const pid = process.pid
let clientID = 0
const isWindows = process.platform === 'win32'

/**
 * Class representing a single request from the SockDaemonClient
 *
 * Created by {@link SockDaemonClient#request}
 *
 * @internal
 */
export class ClientRequest<
  Request extends MessageBase,
  Response extends MessageBase
> {
  #resolve?: (r: Response) => void
  #reject?: (er: any) => void
  #signal?: AbortSignal
  #onAbort: (er: any) => void
  #onFinish: () => void
  /**
   * The response returned by the Daemon, if resolved
   */
  response?: Response
  /**
   * The request sent to the Daemon
   */
  request: Request
  /**
   * Promise which resolves when the response is received
   */
  promise: Promise<Response>
  /**
   * Message ID request/response
   */
  id: string

  constructor(
    /**
     * Request to be sent
     */
    request: Request,
    /**
     * Signal to abort the request
     */
    signal: AbortSignal | undefined,
    /**
     * Called on either success or failure
     */
    onFinish: () => void
  ) {
    this.request = request
    this.id = request.id
    this.promise = new Promise<Response>((resolve, reject) => {
      this.#resolve = resolve
      this.#reject = reject
    })
    this.#signal = signal
    this.#onAbort = (er: any) => this.reject(er)
    this.#onFinish = onFinish
    signal?.addEventListener('abort', this.#onAbort)
  }

  /**
   * Cancel the request and fail the promise
   */
  reject(er: any) {
    /* c8 ignore next */
    if (!this.#reject) return
    this.#onFinish()
    const reject = this.#reject
    this.#reject = undefined
    this.#resolve = undefined
    this.#signal?.removeEventListener('abort', this.#onAbort)
    reject(er)
  }

  /**
   * Resolve the request with a response
   */
  resolve(r: Response) {
    /* c8 ignore next */
    if (!this.#resolve) return
    const q = this.request
    if (isPing(q) && isPong(r, q)) {
      Object.assign(r, { duration: performance.now() - q.sent })
    }
    this.#onFinish()
    const resolve = this.#resolve
    this.response = r
    this.#resolve = undefined
    this.#reject = undefined
    this.#signal?.removeEventListener('abort', this.#onAbort)
    resolve(r)
  }
}

/**
 * Options provided to SockDaemonClient constructor
 */
export interface SockDaemonClientOptions {
  /**
   * The execArgv used when spawning the daemonScript. Defaults to []
   */
  execArgv?: string[]
  /**
   * Set `debug: true` to start daemon in debug logging mode
   */
  debug?: boolean
}

/**
 * Override this class to create a Client that can talk to the
 * SockDaemonServer you've created.
 *
 * Note that the static `serviceName` and `daemonScript` getters
 * MUST be defined on the extended class, referencing the service
 * name and location of the daemon script.
 */
export abstract class SockDaemonClient<
  Request extends MessageBase = MessageBase,
  Response extends MessageBase = MessageBase
> {
  #connected: boolean = false
  #connection?: Socket
  #reader?: Reader
  #clientID = `${pid}-${clientID++}`
  #msgID = 0
  #requests = new Map<string, ClientRequest<Request, Response>>()
  #path: string
  #socket: string
  #logFile: string
  #pidFile: string
  #mtimeFile: string
  #serviceName: string
  #daemonScript: string

  #didPing = false
  #ping?: Ping
  #pingTimer?: NodeJS.Timeout
  #execArgv: string[]
  #debug: boolean

  constructor({
    debug = false,
    execArgv = [],
  }: SockDaemonClientOptions = {}) {
    this.#execArgv = execArgv
    this.#debug = debug
    this.#serviceName = (
      this.constructor as typeof SockDaemonClient
    ).serviceName
    this.#path = resolve(`.${this.#serviceName}/daemon`)
    this.#socket = resolve(this.#path, 'socket')
    const { daemonScript } = this
      .constructor as typeof SockDaemonClient
    /* c8 ignore start */
    const s =
      typeof daemonScript === 'object' ||
      daemonScript.startsWith('file://')
        ? fileURLToPath(daemonScript)
        : daemonScript
    /* c8 ignore stop */
    this.#daemonScript = s
    /* c8 ignore start */
    if (isWindows) {
      this.#socket = resolve('//?/pipe/' + this.#socket)
    }
    /* c8 ignore stop */
    this.#logFile = resolve(this.#path, 'log')
    this.#pidFile = resolve(this.#path, 'pid')
    this.#mtimeFile = resolve(this.#path, 'mtime')
  }

  /**
   * Send a PING message to the server. This can be useful when you want
   * to start the daemon, without making any specific request.
   */
  async ping(): Promise<Pong & { duration: number }> {
    return await this.request(ping())
  }

  /**
   * Kill the server, if it is running.
   *
   * Attempts to send a SIGHUP to allow for graceful shutdown, but this
   * is not possible on Windows.
   */
  async kill() {
    const ps = await readFile(this.#pidFile, 'utf8').catch(
      () => undefined
    )
    this.disconnect()
    if (!ps) return
    const { stackTraceLimit } = Error
    Error.stackTraceLimit = 0
    let sigRes: boolean = false
    /* c8 ignore start */
    if (!isWindows) {
      try {
        sigRes = process.kill(Number(ps), 'SIGHUP')
      } catch {}
    }
    if (isWindows || sigRes) {
      try {
        sigRes = process.kill(Number(ps), 'SIGTERM')
      } catch {}
    }
    /* c8 ignore stop */
    Error.stackTraceLimit = stackTraceLimit
    if (sigRes) {
      await new Promise<void>(r => setTimeout(r, 50))
    }
  }

  /**
   * The name of the service. Must match the value set in the
   * SockDaemonServer class this talks to.
   */
  static get serviceName(): string {
    throw new Error(
      `${this.constructor.name} class must define static 'serviceName' getter`
    )
  }
  /**
   * The location of the daemon script that starts up the
   * SockDaemonServer service that this client talks to.
   */
  static get daemonScript(): string | URL {
    throw new Error(
      `${this.constructor.name} class must define static 'daemonScript' getter`
    )
  }

  /**
   * The execArgv that is used when spawning the daemon script.
   */
  get execArgv() {
    return this.#execArgv
  }

  /**
   * List of current pending requests
   */
  get requests() {
    return [...this.#requests.values()]
  }

  /**
   * True if currently connected to the daemon service
   */
  get connected() {
    return this.#connected
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
   * Path where the daemonScript mtime is written
   */
  get mtimeFile() {
    return this.#mtimeFile
  }

  /**
   * File containing the daemon process ID
   */
  get pidFile() {
    return this.#pidFile
  }

  /**
   * True if the client is currently connected
   */
  get connection() {
    return this.#connection
  }

  /**
   * Returns true if the object is a {@link MessageBase}
   */
  isMessage(msg: any): msg is MessageBase {
    return (
      !!msg &&
      typeof msg === 'object' &&
      !Array.isArray(msg) &&
      typeof msg.id === 'string'
    )
  }

  /**
   * Set to check that a response is valid
   */
  isResponse(msg: any): msg is Response {
    return this.isMessage(msg)
  }

  /**
   * Send a request. The `id` property is made optional, because it will
   * be overridden anyway by a generated message ID. Starts the daemon
   * script automatically if not already running, and connects if needed.
   *
   * If an AbortSignal is provided, then the request will be dropped on
   * an abort signal, and the promise rejected with the abort reason, if
   * it has not already been resolved.
   */
  async request(
    msg: Omit<Ping, 'id'>,
    signal?: AbortSignal
  ): Promise<Pong & { duration: number }>
  async request(
    msg: Omit<Request, 'id'>,
    signal?: AbortSignal
  ): Promise<Response>
  async request(
    msg: (Omit<Request, 'id'> & { id?: string }) | Omit<Ping, 'id'>,
    signal?: AbortSignal
  ): Promise<Response | (Pong & { duration: number })> {
    this.#connection?.ref()
    const id = `${this.#clientID}-${this.#msgID++}`
    const request = { ...msg, id } as Request
    const cr = new ClientRequest<Request, Response>(
      request,
      signal,
      () => {
        this.#requests.delete(id)
        if (!this.#requests.size) this.#connection?.unref()
      }
    )
    this.#requests.set(id, cr)
    this.#checkMtime().then(() => {
      if (!this.#requests.has(id)) return
      if (!this.#connected) {
        /* c8 ignore next */
        if (!this.#connection?.connecting) this.#connect()
      } else {
        const [head, body] = message(request)
        this.#connection!.write(head)
        this.#connection!.write(body)
      }
    })
    return await cr.promise
  }

  #mtimeCheckP?: Promise<boolean>
  async #checkMtime(): Promise<boolean> {
    if (this.#mtimeCheckP) return this.#mtimeCheckP
    let resolve!: (b: boolean) => void
    this.#mtimeCheckP = new Promise<boolean>(r => (resolve = r))
    const [mtimeExpect, mtimeActual] = await Promise.all([
      readFile(this.#mtimeFile)
        /* c8 ignore next */
        .then(s => Number(s) || undefined)
        .catch(() => undefined),
      stat(this.#daemonScript)
        .then(st => Number(st.mtime))
        .catch(undefined),
    ])
    if (mtimeExpect && mtimeActual && mtimeExpect !== mtimeActual) {
      await Promise.all([
        unlink(this.#mtimeFile).catch(() => {}),
        this.kill(),
      ])
      resolve(true)
      this.#mtimeCheckP = undefined
      return true
    } else {
      resolve(false)
      this.#mtimeCheckP = undefined
      return false
    }
  }

  async #connect() {
    await Promise.all([
      mkdir(this.#path, { recursive: true }),
      this.#checkMtime(),
    ])
    this.#reader = new Reader()
    const connection = connect(this.#socket, () => {
      this.#connected = true
      if (!this.#didPing) {
        const id = `${this.#clientID}-${this.#msgID++}`
        this.#ping = ping(id)
        const [phead, pbody] = message(this.#ping)
        connection.write(phead)
        connection.write(pbody)
        clearTimeout(this.#pingTimer)
        this.#pingTimer = setTimeout(() => {
          connection.emit(
            'error',
            Object.assign(new Error('ping timeout'), {
              code: 'ENOENT',
            })
          )
        }, 100)
      }

      // replay any pending requests
      for (const cr of this.#requests.values()) {
        const [head, body] = message(cr.request)
        this.#connection?.write(head)
        this.#connection?.write(body)
      }
    })
    this.#connection = connection
    connection.on('data', c => {
      /* c8 ignore next */
      if (connection !== this.#connection) return
      this.#onData(c)
    })
    connection.on('close', () => {
      /* c8 ignore next */
      if (connection !== this.#connection) return
      this.disconnect()
    })
    connection.on('error', (er: NodeJS.ErrnoException) => {
      /* c8 ignore next */
      if (connection !== this.#connection) return
      this.disconnect()
      if (er.code === 'ENOENT') {
        // start daemon
        const ea = this.#execArgv
        const d = spawn(
          process.execPath,
          [...ea, this.#daemonScript],
          {
            env: {
              ...process.env,
              /* c8 ignore start */
              ...(this.#debug && {
                NODE_DEBUG: `${
                  process.env.NODE_DEBUG
                    ? process.env.NODE_DEBUG + ','
                    : ''
                }SOCK-DAEMON`,
              }),
              /* c8 ignore stop */
              [`SOCK_DAEMON_SCRIPT_${this.#serviceName}`]:
                this.#daemonScript,
            },
            stdio: [
              'ignore',
              'pipe',
              //'inherit',
              //'pipe',
              openSync(
                this.#logFile,
                constants.O_APPEND |
                  constants.O_CREAT |
                  constants.O_WRONLY
              ),
            ],
            detached: true,
          }
        )
        /* c8 ignore start */
        d.stderr?.on('data', c => process.stderr.write(c))
        /* c8 ignore stop */
        d.stdout!.on('data', () => {
          this.#connect()
          ;(d.stdout as Socket)?.unref?.()
        })
        d.unref()
      }
    })
  }

  #onData(chunk: Buffer) {
    for (const msg of this.#reader!.write(chunk)) {
      if (this.#ping && isPong(msg, this.#ping)) {
        this.#didPing = true
        clearTimeout(this.#pingTimer)
      }
      const valid = this.isResponse(msg) || isPong(msg)
      /* c8 ignore next */
      if (!valid) continue
      const cr = this.#requests.get(msg.id)
      if (cr) {
        cr.resolve(msg as Response)
      }
    }
  }

  /**
   * Immediately disconnect from the server. Pending requests will be
   * replayed on the next connection, unless clear() is called.
   */
  disconnect() {
    this.#connected = false
    this.#connection?.unref()
    this.#connection?.destroy()
    this.#connection = undefined
    this.#reader = undefined
  }

  /**
   * Drop all pending requests
   */
  clear() {
    for (const [id, cr] of this.#requests) {
      cr.reject(new Error(`request ${id} aborted`))
    }
  }
}
