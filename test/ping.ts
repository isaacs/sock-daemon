import t from 'tap'
import { isPing, isPong, ping, pong } from '../src/ping.js'

t.equal(isPing({ id: 'x', PING: 'PING' }), true)
t.equal(isPing({ id: 'x', PING: 'PING', y: 'z' }), false)
t.equal(isPing({ id: 'x', y: 'z' }), false)
t.equal(isPong({ id: 'x', PING: 'PONG' }), true)
t.equal(
  isPong({ id: 'x', PING: 'PONG' }, { id: 'y', PING: 'PING' }),
  false
)
t.strictSame(pong({ id: 'x', PING: 'PING' }), {
  id: 'x',
  PING: 'PONG',
})
t.strictSame(ping('x'), { id: 'x', PING: 'PING' })
