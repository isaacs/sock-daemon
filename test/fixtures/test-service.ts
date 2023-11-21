import {
  MessageBase,
  SockDaemonClient as Client,
  SockDaemonServer as Server,
} from '../../src/index.js'

export interface Request extends MessageBase {
  foo: string
}

export interface Response extends MessageBase {
  bar: string
}

export class TestDaemon extends Server<Request, Response> {
  isRequest(msg: any): msg is Request {
    return super.isMessage(msg) && typeof msg.foo === 'string'
  }

  static get serviceName() {
    return 'test-service'
  }

  handle(msg: Request) {
    console.error('server handling request', msg)
    return {
      id: msg.id,
      bar: 'bar: ' + msg.foo,
    }
  }
}

export class TestClient extends Client<Request, Response> {
  constructor({ debug = false } = {}) {
    super({ execArgv: process.execArgv, debug })
  }
  static get serviceName() {
    return 'test-service'
  }
  static get daemonScript() {
    return new URL('daemon.mts', import.meta.url)
  }
  isResponse(msg: any): msg is Response {
    return this.isMessage(msg) && typeof msg.bar === 'string'
  }
  async fooIntoBar(foo: string, signal?: AbortSignal) {
    const { bar } = await super.request({ foo }, signal)
    return bar
  }
}
