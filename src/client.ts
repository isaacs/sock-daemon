import { spawn } from 'child_process'
import { constants, openSync } from 'fs'
import { mkdirp } from 'mkdirp'
import { connect, Socket } from 'net'
import { resolve } from 'path'
import { message, Reader } from 'socket-post-message'
import { fileURLToPath } from 'url'
import { isPong, ping, Ping } from './ping.js'
import type { MessageBase } from './server.js'

const pid = process.pid
let clientID = 0
const isWindows = process.platform === 'win32'

/**
 * Class representing a single request from the SockDaemonClient
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
  response?: Response
  request: Request
  promise: Promise<Response>
  id: string

  constructor(
    request: Request,
    signal: AbortSignal | undefined,
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

  resolve(r: Response) {
    /* c8 ignore next */
    if (!this.#resolve) return
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

  #didPing = false
  #ping?: Ping
  #pingTimer?: NodeJS.Timeout

  constructor() {
    const svc = (this.constructor as typeof SockDaemonClient)
      .serviceName
    this.#path = resolve(`.${svc}/daemon`)
    this.#socket = resolve(this.#path, 'socket')
    /* c8 ignore start */
    if (isWindows) {
      this.#socket = resolve('//?/pipe/' + this.#socket)
    }
    /* c8 ignore stop */
    this.#logFile = resolve(this.#path, 'log')
    this.#pidFile = resolve(this.#path, 'pid')
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
  get connection() {
    return this.#connection
  }

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
    msg: Omit<Request, 'id'> & { id?: string },
    signal?: AbortSignal
  ): Promise<Response> {
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
    if (!this.#connected) {
      /* c8 ignore next */
      if (!this.#connection?.connecting) this.#connect()
    } else {
      const [head, body] = message(request)
      this.#connection!.write(head)
      this.#connection!.write(body)
    }
    return cr.promise
  }

  async #connect() {
    await mkdirp(this.#path)
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
        const { daemonScript } = this
          .constructor as typeof SockDaemonClient
        /* c8 ignore start */
        const s =
          typeof daemonScript === 'object' ||
          daemonScript.startsWith('file://')
            ? fileURLToPath(daemonScript)
            : daemonScript
        /* c8 ignore stop */
        const ea = process.execArgv
        const d = spawn(process.execPath, [...ea, s], {
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
        })
        /* c8 ignore start */
        d.stderr?.on('data', c => process.stderr.write(c))
        /* c8 ignore stop */
        d.stdout!.on('data', () => this.#connect())
      }
    })
  }

  #onData(chunk: Buffer) {
    for (const msg of this.#reader!.write(chunk)) {
      if (this.#ping && isPong(msg, this.#ping)) {
        this.#didPing = true
        clearTimeout(this.#pingTimer)
        /* c8 ignore next */
      } else if (isPong(msg)) continue
      const valid = this.isResponse(msg)
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
