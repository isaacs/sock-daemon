// Utility to take a mutex lock on starting the daemon server,
// used to prevent thundering herd issues when a lot of clients
// all attempt to start daemons at the same moment.

import { unlinkSync } from 'fs'
import {
  FileHandle,
  open,
  readFile,
  rename,
  stat,
  unlink,
} from 'fs/promises'
import { dirname, resolve } from 'path'
import { rimraf } from 'rimraf'
import { onExit } from 'signal-exit'

const locks = new Set<StartingLock>()
onExit(() => {
  for (const lock of locks) {
    try {
      locks.delete(lock)
      unlinkSync(lock.path)
      /* c8 ignore next */
    } catch {}
  }
})

export class StartingLock {
  path: string
  handle?: FileHandle
  acquired: boolean = false

  constructor(path: string) {
    this.path = resolve(path, 'starting.lock')
  }

  async acquire() {
    if (this.acquired) return

    try {
      this.handle = await open(this.path, 'wx')
    } catch (er) {
      /* c8 ignore start */
      if ((er as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw er
      }
      /* c8 ignore stop */

      // should never keep the lock for longer than 2 seconds, so if it's
      // younger than that, it's probably valid, so get out of here.
      if (Date.now() - Number((await stat(this.path)).mtime) < 2000) {
        throw er
      }
      const n = Number(await readFile(this.path, 'utf8'))
      // if the lock is just garbage, unlink it
      // this may fail if two try to do it in parallel
      await unlink(this.path)
      if (n) process.kill(n, 'SIGTERM')
      this.handle = await open(this.path, 'wx')
    }
    // write our pid to the file, and then verify that it's our pid
    // why verify? because another process might have deleted it,
    // AFTER we deleted a stale lock and created ours exclusively.
    await this.handle.write(Buffer.from(String(process.pid) + '\n'))
    await this.handle.close()
    const verify = await readFile(this.path, 'utf8')
    /* c8 ignore start */
    if (verify !== `${process.pid}\n`) {
      throw Object.assign(new Error('failed to acquire lock'), {
        expect: `${process.pid}\n`,
        actual: verify,
      })
    }
    /* c8 ignore stop */
    this.acquired = true
    locks.add(this)
  }

  async release() {
    if (this.acquired) {
      await rimraf(this.path)
    }
    this.acquired = false
    locks.delete(this)
  }

  async commit() {
    if (this.acquired) {
      await rename(this.path, resolve(dirname(this.path), 'pid'))
    }
    this.acquired = false
    locks.delete(this)
  }
}
