import { basename } from 'path'

export default t =>
  basename(t) === 'server.ts'
    ? ['src/client.ts', 'src/server.ts']
    : t.replace(/test[\\\/]/, 'src/')
