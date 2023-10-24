import t from 'tap'
import * as CLIENT from '../src/client.js'
import * as INDEX from '../src/index.js'
import * as SERVER from '../src/server.js'

// just import the type to verify it works
const rs: INDEX.ReadyState = 'READY'
//@ts-expect-error
const rbad: INDEX.ReadyState = 'nope'
rs
rbad

t.strictSame(
  INDEX,
  Object.assign(Object.create(null), {
    ...CLIENT,
    ...SERVER,
  })
)
