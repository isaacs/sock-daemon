import t from 'tap'
import { isPing, isPong, ping, pong } from '../src/ping.js'

t.equal(isPing({ id: 'x', PING: 'PING', sent: 1 }), true)
t.equal(isPing({ id: 'x', PING: 'PING', y: 'z', sent: 1 }), false)
t.equal(isPing({ id: 'x', y: 'z', sent: 1 }), false)
t.equal(isPong({ id: 'x', PING: 'PONG', sent: 1, pid: 123 }), true)
t.equal(
  isPong(
    { id: 'x', PING: 'PONG', sent: 1, pid: process.pid },
    { id: 'y', PING: 'PING', sent: 1 }
  ),
  false,
  'different ids, not the same request'
)
t.equal(
  isPong(
    { id: 'x', PING: 'PONG', sent: 2, pid: process.pid },
    { id: 'x', PING: 'PING', sent: 1 }
  ),
  false,
  'different sent times, not echoed back'
)
t.strictSame(pong({ id: 'x', PING: 'PING', sent: 1 }), {
  id: 'x',
  PING: 'PONG',
  pid: process.pid,
  sent: 1,
})
t.matchOnly(ping('x'), { id: 'x', PING: 'PING', sent: Number })
