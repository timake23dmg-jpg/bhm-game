// Builds the game and publishes dist/ to the repo's gh-pages branch, which
// GitHub Pages serves at https://<user>.github.io/<repo>/.
//
//   npm run deploy:pages
//
// The Supabase URL/key come from your local .env at build time (they are
// public by design; RLS protects the data). .env itself is never committed.

import { execFileSync } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const dist = join(root, 'dist')
// npm is a .cmd shim on Windows and needs a shell; git must NOT go through one
// (the shell would split arguments like the commit message).
const run = (cmd, args, cwd = root) =>
  execFileSync(cmd, args, { cwd, stdio: 'inherit', shell: cmd === 'npm' && process.platform === 'win32' })
const out = (cmd, args, cwd = root) => execFileSync(cmd, args, { cwd, encoding: 'utf8' }).trim()

if (!existsSync(join(root, '.env'))) {
  console.error('No .env found: the build would run in local demo mode. Copy .env.example to .env first.')
  process.exit(1)
}

const remote = out('git', ['remote', 'get-url', 'origin'])
run('npm', ['run', 'build'])

// GitHub Pages runs Jekyll by default, which would hide some files.
writeFileSync(join(dist, '.nojekyll'), '')

// Publish dist/ as a fresh single-commit gh-pages branch.
run('git', ['init', '-q'], dist)
run('git', ['checkout', '-q', '-B', 'gh-pages'], dist)
run('git', ['add', '-A'], dist)
run('git', ['-c', 'user.name=' + out('git', ['config', 'user.name']), '-c', 'user.email=' + out('git', ['config', 'user.email']),
  'commit', '-q', '-m', 'Deploy Fakeout build'], dist)
run('git', ['push', '-f', remote, 'gh-pages'], dist)
console.log('\nPublished to gh-pages. GitHub Pages updates within a minute or two.')
