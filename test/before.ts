import { rimraf } from 'rimraf'
import { mkdirp } from 'mkdirp'

// remove the dir before test run, but leave the log there after
// it's useful to look at when tests go weird.
await rimraf('.test-service')
await mkdirp('.test-service/daemon')
