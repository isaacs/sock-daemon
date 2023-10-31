# sock-daemon

A utility for creating a daemon process that listens on a socket,
and a client that talks to it.

Handles automatically starting the daemon service (but only one
of them), logging to a file, and serializing messages over a
domain socket on unix systems or named pipe on Windows.

<img src="https://raw.githubusercontent.com/isaacs/sock-daemon/main/sock-daemon.svg" alt="two cartoon socks with devil tails and horns" height="320" width="320">

## USAGE

Install with npm

```
npm install sock-daemon
```

There are two parts of this, the daemon script that listens on a
socket, and the client that connects to it.

The daemon is smart enough to only instantiate a single copy of
itself. The client knows how to connect to it, and knows how to
spin up an instance of the daemon if it's not already running.

To do this, the server daemon and the client need to both know
the name that they'll use for the socket, and the client needs to
know the location of the daemon script.

The type stuff is clearly only required when you are using
TypeScript, but it is a nice check to ensure that the server and
client are speaking the same language.

For example, you can create a service like this, defining a
client and server implementation:

```ts
// index.mjs
import {
  SockDaemonServer as Server,
  SockDaemonClient as Client,
} from 'sock-daemon'
import type { MessageBase } from 'sock-daemon'

export const serviceName = 'my-service'

// This must be an object that extends MessageBase
export interface Request extends MessageBase {
  // put your application specific types here for requests
  foo: string
}

export interface Response extends MessageBase {
  // put your application specific types here for responses
  bar: string
}

// create my application specific server to handle requests
export class MyServiceServer extends Server<Request, Response> {
  // check here to ensure that the request is valid
  // anything that fails this will be logged and
  isRequest(msg: any): msg is Request {
    return super.isMessage(msg) && typeof msg.foo === 'string'
  }

  // must override this static property to set the service name
  // the socket, pidFile, and log will be found in
  // .{service-name}/daemon/... in the current working dir
  static get serviceName() {
    return serviceName
  }

  // get a request, return a response.
  // must return either Response or Promise<Response>
  async handle(msg: Request) {
    // stderr will be written to ./.my-service/daemon/log when
    // spawned automatically by the client.
    console.error('got request', msg)
    // must return a response with the same ID we got in the
    // request, to handle replayed or out of order messages
    return {
      id: msg.id,
      bar: 'bar: ' + msg.foo,
    }
  }
}

export class MyServiceClient extends Client<Request, Response> {
  // this must match what's defined in the daemon server
  static get serviceName() {
    return serviceName
  }

  // the path to the node script that starts the daemon
  // either a URL or a file path.
  static get daemonScript() {
    return new URL('./daemon.mjs', import.meta.url)
  }

  // optional, validate that a response is valid
  // if this returns false, the request promise will reject
  isResponse(msg: any): msg is Response {
    return super.isMessage(msg) && typeof msg.bar === 'string'
  }

  // define whatever methods you like here, but they all need to
  // eventually call super.request() to send the actual request.
  // the argument to super.request() MUST NOT include an id, that
  // is managed by the SockDaemonClient base class.
  async fooIntoBar(foo: string) {
    const { bar } = await super.request({ foo })
    return bar
  }
}
```

Create the `daemon.mjs` script like this:

```ts
import { MyServiceServer } from './index.mjs'

// instantiate the server daemon. Options are optional,
// shown here with their default values.
const server = new MyServiceServer({
  // how long in ms should the daemon stick around if it hasn't
  // seen any requests? Defaults to 1 hour
  idleTimeout: 1000 * 60 * 60,

  // how long should a connection be allowed to persist, if it
  // has not made any requests? Defaults to 1 second
  connectionTimeout: 1000,
})

server.listen()
```

And then using the client in a program somewhere:

```ts
import { MyServiceClient as Client } from 'my-service'

const client = new Client()
// starts the daemon, if it's not already running
const result = await client.fooIntoBar('input string')
// returns: "bar: input string"
```

## API

See the above example for most of it, or look at the
[typedocs](https://isaacs.github.io/sock-daemon)

## Caveats

- Note that your Daemon and Client classes need to override the
  static `serviceName` getter to a matching value, and the Client
  needs to override the static `daemonScript` to a reference to
  the node program that will run the service.
- The `daemonScript` will be passed to node with the
  `process.execArgv` provided to the main client program, but no
  other arguments.
- This will work best if your messages can be as small as
  possible, to save on serialization costs. If you have to do
  some large amount of work, it's often faster to write the
  result to a file, and have the `Response` report the filename.
- To my knowledge, this module is not responsible for anyone's
  [missing socks](https://en.uncyclopedia.co/wiki/Sock_demon),
  but please post an issue if you find this is not the case.
