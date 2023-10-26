import { TestDaemon } from './test-service.js'
new TestDaemon().listen()
console.error('daemon listening', process.argv[2])
