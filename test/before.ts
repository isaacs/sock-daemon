import { rimraf } from 'rimraf'

// remove the dir before test run, but leave the log there after
// it's useful to look at when tests go weird.
rimraf('.test-service')
