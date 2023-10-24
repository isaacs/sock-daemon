export type Ping = {
  id: string
  PING: 'PING'
}

export type Pong = {
  id: string
  PING: 'PONG'
}

export const pong = (ping: Ping): Pong => ({ ...ping, PING: 'PONG' })
export const ping = (id: string): Ping => ({ id, PING: 'PING' })

export const isPong = (msg: any, ping?: Ping): msg is Pong =>
  !!msg &&
  typeof msg === 'object' &&
  !Array.isArray(msg) &&
  (ping === undefined
    ? typeof msg.id === 'string'
    : msg.id === ping.id) &&
  msg.PING === 'PONG' &&
  Object.keys(msg).length === 2

export const isPing = (msg: any): msg is Ping =>
  !!msg &&
  typeof msg === 'object' &&
  !Array.isArray(msg) &&
  typeof msg.id === 'string' &&
  msg.PING === 'PING' &&
  Object.keys(msg).length === 2
