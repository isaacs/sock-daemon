import { spawn } from 'child_process'
import { constants, openSync } from 'fs'
import { connect, Socket } from 'net'
import { resolve } from 'path'
import { message, Reader } from 'socket-post-message'
import { fileURLToPath } from 'url'
import type { MessageBase } from './server.js'

const pid = process.pid
let clientID = 0

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
  response?: Response
  request: Request
  promise: Promise<Response>
  id: string

  constructor(request: Request, signal?: AbortSignal) {
    this.request = request
    this.id = request.id
    this.promise = new Promise<Response>((resolve, reject) => {
      this.#resolve = resolve
      this.#reject = reject
    })
    this.#signal = signal
    this.#onAbort = (er: any) => this.reject(er)
    signal?.addEventListener('abort', this.#onAbort)
  }

  reject(er: any) {
    if (!this.#reject) return
    const reject = this.#reject
    this.#reject = undefined
    this.#resolve = undefined
    this.#signal?.removeEventListener('abort', this.#onAbort)
    reject(er)
  }

  resolve(r: Response) {
    if (!this.#resolve) return
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
  #socket?: Socket
  #reader?: Reader
  #clientID = `${pid}-${clientID++}`
  #msgID = 0
  #requests = new Map<string, ClientRequest<Request, Response>>()
  #path: string
  #socketFile: string
  #logFile: string

  constructor() {
    const svc = (this.constructor as typeof SockDaemonClient)
      .serviceName
    this.#path = resolve(`.${svc}/daemon`)
    this.#socketFile = resolve(this.#path, 'sock')
    this.#logFile = resolve(this.#path, 'log')
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
  isResponse?: (msg: any) => msg is Response

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
    this.#socket?.ref()
    const id = `${this.#clientID}-${this.#msgID++}`
    const request = { ...msg, id } as Request
    const cr = new ClientRequest<Request, Response>(request, signal)
    this.#requests.set(id, cr)
    if (!this.#connected) {
      if (!this.#socket?.connecting) this.#connect()
    } else {
      const [head, body] = message(request)
      this.#socket!.write(head)
      this.#socket!.write(body)
    }
    return cr.promise
  }

  #connect() {
    this.#reader = new Reader()
    this.#socket = connect(this.#socketFile, () => {
      this.#connected = true
      // replay any pending requests
      for (const cr of this.#requests.values()) {
        const [head, body] = message(cr.request)
        this.#socket?.write(head)
        this.#socket?.write(body)
      }
    })
    this.#socket.on('data', c => this.#onData(c))
    this.#socket.on('close', () => this.disconnect())
    this.#socket.on('error', (er: NodeJS.ErrnoException) => {
      this.disconnect()
      if (er.code === 'ENOENT') {
        // start daemon
        const { daemonScript } = this
          .constructor as typeof SockDaemonClient
        const s =
          typeof daemonScript === 'object' ||
          daemonScript.startsWith('file://')
            ? fileURLToPath(daemonScript)
            : daemonScript
        const ea = process.execArgv
        const d = spawn(process.execPath, [...ea, s], {
          stdio: [
            'ignore',
            'pipe',
            openSync(
              this.#logFile,
              constants.O_APPEND |
                constants.O_CREAT |
                constants.O_WRONLY
            ),
          ],
          detached: true,
        })
        d.stdout!.on('data', () => this.#connect())
      }
    })
  }

  #onData(chunk: Buffer) {
    for (const msg of this.#reader!.write(chunk)) {
      const valid = (this.isResponse || this.isMessage)(msg)
      if (!valid) continue
      const cr = this.#requests.get(msg.id)
      if (cr) {
        this.#requests.delete(msg.id)
        cr.resolve(msg as Response)
      }
    }
    if (!this.#requests.size) this.#socket?.unref()
  }

  /**
   * Immediately disconnect from the server. Pending requests will be
   * replayed on the next connection, unless clear() is called.
   */
  disconnect() {
    this.#socket?.destroy()
    this.#socket = undefined
    this.#reader = undefined
  }

  /**
   * Drop all pending requests
   */
  clear() {
    for (const [id, cr] of this.#requests) {
      cr.reject(new Error(`request ${id} aborted`))
      this.#requests.delete(id)
    }
  }
}
