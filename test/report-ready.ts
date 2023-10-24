import t from 'tap'
import { reportReady } from '../src/report-ready.js'
const logs = t.capture(console, 'log').args
reportReady('READY')
reportReady('ALREADY RUNNING')
//@ts-expect-error
reportReady('yolo')

t.strictSame(logs(), [['READY'], ['ALREADY RUNNING'], ['yolo']])
