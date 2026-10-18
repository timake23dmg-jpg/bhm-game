// Picks the backend: Supabase when VITE_SUPABASE_URL is set, otherwise the
// single-browser local demo. Because the env check is resolved at build time,
// a Supabase build never ships the question bank (answers) to phones.

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY

export const BACKEND = SUPABASE_URL ? 'supabase' : 'local'

function localUserId() {
  // One identity per browser tab (so several tabs can be several players),
  // surviving reloads of that tab.
  const KEY = 'fakeout.local.userId'
  try {
    let id = sessionStorage.getItem(KEY)
    if (!id) {
      const b = new Uint8Array(8)
      crypto.getRandomValues(b)
      id = [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
      sessionStorage.setItem(KEY, id)
    }
    return id
  } catch {
    return Math.random().toString(36).slice(2)
  }
}

export async function createHostTransport() {
  let t
  if (SUPABASE_URL) {
    const { createSupabaseHostTransport } = await import('./supabaseTransport.js')
    t = createSupabaseHostTransport({ url: SUPABASE_URL, anonKey: SUPABASE_ANON_KEY })
  } else {
    const [{ createLocalHostTransport }, { default: questions }] = await Promise.all([
      import('./localTransport.js'),
      import('../../data/questions.json'),
    ])
    t = createLocalHostTransport({ userId: localUserId(), questions })
  }
  await t.init()
  return t
}

export async function createPlayerTransport() {
  let t
  if (SUPABASE_URL) {
    const { createSupabasePlayerTransport } = await import('./supabaseTransport.js')
    t = createSupabasePlayerTransport({ url: SUPABASE_URL, anonKey: SUPABASE_ANON_KEY })
  } else {
    const { createLocalPlayerTransport } = await import('./localTransport.js')
    t = createLocalPlayerTransport({ userId: localUserId() })
  }
  await t.init()
  return t
}
