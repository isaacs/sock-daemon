export type Ping = {
  id: string
  PING: 'PING'
  sent: number
}

export type Pong = Omit<Ping, 'PING'> & {
  PING: 'PONG'
  pid: number
}

export const pong = (ping: Ping): Pong => ({
  ...ping,
  PING: 'PONG',
  pid: process.pid,
})

export function ping(): Omit<Ping, 'id'>
export function ping(id: string): Ping
export function ping(id?: string): Ping | Omit<Ping, 'id'> {
  return {
    ...(id && { id }),
    PING: 'PING',
    sent: performance.now(),
  }
}

export const isPong = (msg: any, ping?: Ping): msg is Pong =>
  !!msg &&
  typeof msg === 'object' &&
  !Array.isArray(msg) &&
  (ping === undefined
    ? typeof msg.id === 'string'
    : msg.id === ping.id) &&
  (ping === undefined
    ? typeof msg.sent === 'number'
    : msg.sent === ping.sent) &&
  msg.PING === 'PONG' &&
  typeof msg.pid === 'number' &&
  Object.keys(msg).length === 4

export const isPing = (msg: any): msg is Ping =>
  !!msg &&
  typeof msg === 'object' &&
  !Array.isArray(msg) &&
  typeof msg.id === 'string' &&
  msg.PING === 'PING' &&
  typeof msg.sent === 'number' &&
  Object.keys(msg).length === 3
