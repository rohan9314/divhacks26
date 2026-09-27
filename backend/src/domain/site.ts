/**
 * Website accounts (plansaroundus.tech). Two-factor sign-in, the same rules
 * the Node agent's website API used, now stored in DeepSpace:
 *
 *   1. email a 6-digit code        2. trade it for a short-lived challenge
 *   3. text a code over iMessage   4. verify it → account + session token
 *
 * The iMessage code is queued in notification_outbox; the Photon agent
 * delivers it. Codes, challenges and sessions are stored only as hashes.
 * These accounts are separate from DeepSpace's built-in sign-in.
 */

import { findAll, findOne, insert, patch, ServiceError, tryInsert, type Store } from './store'

export const CODE_TTL_MS = 10 * 60 * 1000
export const CHALLENGE_TTL_MS = 15 * 60 * 1000
export const RESEND_COOLDOWN_MS = 30 * 1000
export const MAX_SENDS_PER_HOUR = 100
export const MAX_ATTEMPTS = 1000
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000
const HOUR = 60 * 60 * 1000

export type Budget = 'free' | 'low' | 'medium' | 'high'
export type VoiceReplies = 'match' | 'always' | 'off'

export interface SitePreferences {
  name: string
  homeNeighborhood?: string
  dietary: string[]
  budget?: Budget
  doesntDrink: boolean
  voiceReplies: VoiceReplies
}

export interface SiteUser {
  phone: string
  email: string
  createdAt: string
  onboardedAt?: string
  preferences?: SitePreferences
  xrplAddress?: string
}

/** What the website sees: masked contact details, never the raw number or address. */
export interface PublicSiteUser {
  phone: string
  email: string
  onboarded: boolean
  preferences: SitePreferences | null
  wallet: { status: 'none' } | { status: 'ready'; xrplAddress: string }
}

export interface SiteDeps {
  store: Store
  /** HMAC key for codes (SITE_AUTH_SECRET). */
  secret: string
  maxUsers: number
  sendEmailCode(email: string, code: string): Promise<void>
  now?: () => number
}

/** US numbers only for now: "(917) 782-4515" → "+19177824515". */
export function normalizeUsPhone(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const digits = raw.replace(/\D/g, '')
  const ten = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits
  if (!/^[2-9]\d{2}[2-9]\d{6}$/.test(ten)) return null
  return `+1${ten}`
}

export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const email = raw.trim().toLowerCase()
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return null
  return email
}

export const maskPhone = (phone: string) => `+1 •••-•••-${phone.slice(-4)}`
export const maskEmail = (email: string) => {
  const [local = '', domain = ''] = email.split('@')
  return `${local.slice(0, 1)}•••@${domain}`
}

const encoder = new TextEncoder()
const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')

export async function sha256Hex(value: string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', encoder.encode(value)))
}

async function hmacHex(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return hex(await crypto.subtle.sign('HMAC', key, encoder.encode(value)))
}

function randomToken(bytes = 32): string {
  const buf = crypto.getRandomValues(new Uint8Array(bytes))
  return btoa(String.fromCharCode(...buf)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function sixDigits(): string {
  // Rejection sampling keeps every code equally likely.
  const limit = Math.floor(0xffffffff / 1_000_000) * 1_000_000
  let n: number
  do n = crypto.getRandomValues(new Uint32Array(1))[0]!
  while (n >= limit)
  return String(n % 1_000_000).padStart(6, '0')
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

interface CodeRow {
  key: string
  hash: string
  expiresAt: number
  attempts: number
  sends: unknown
}

const BUDGETS = new Set<Budget>(['free', 'low', 'medium', 'high'])
const VOICE = new Set<VoiceReplies>(['match', 'always', 'off'])

export function parsePreferences(input: unknown): SitePreferences | null {
  if (!input || typeof input !== 'object') return null
  const raw = input as Record<string, unknown>
  const name = typeof raw.name === 'string' ? raw.name.trim().slice(0, 40) : ''
  if (!name) return null
  const text = (value: unknown, max: number) =>
    typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined
  const dietary = Array.isArray(raw.dietary)
    ? [
        ...new Set(
          raw.dietary
            .filter((d): d is string => typeof d === 'string')
            .map((d) => d.trim().slice(0, 30))
            .filter(Boolean),
        ),
      ].slice(0, 10)
    : []
  const budget = BUDGETS.has(raw.budget as Budget) ? (raw.budget as Budget) : undefined
  const voiceReplies = VOICE.has(raw.voiceReplies as VoiceReplies) ? (raw.voiceReplies as VoiceReplies) : 'match'
  const homeNeighborhood = text(raw.homeNeighborhood, 60)
  return {
    name,
    ...(homeNeighborhood && { homeNeighborhood }),
    dietary,
    ...(budget && { budget }),
    doesntDrink: raw.doesntDrink === true,
    voiceReplies,
  }
}

function readPreferences(value: unknown): SitePreferences | undefined {
  const parsed = typeof value === 'string' ? safeJson(value) : value
  return parsePreferences(parsed) ?? undefined
}

/** JSON columns can come back as a string or an already-parsed array. */
function numberArray(value: unknown): number[] {
  const parsed = typeof value === 'string' ? safeJson(value) : value
  return Array.isArray(parsed) ? parsed.map(Number).filter(Number.isFinite) : []
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}

export function publicUser(user: SiteUser): PublicSiteUser {
  return {
    phone: maskPhone(user.phone),
    email: maskEmail(user.email),
    onboarded: Boolean(user.onboardedAt),
    preferences: user.preferences ?? null,
    wallet: user.xrplAddress ? { status: 'ready', xrplAddress: user.xrplAddress } : { status: 'none' },
  }
}

export function createSite(deps: SiteDeps) {
  const { store } = deps
  const now = deps.now ?? Date.now

  async function userRow(phone: string) {
    const row = await findOne<SiteUser & { preferences?: unknown }>(store, 'site_users', { phone })
    return row ? { recordId: row.recordId, user: { ...row.data, preferences: readPreferences(row.data.preferences) } as SiteUser } : null
  }

  async function userCount(): Promise<number> {
    return (await findAll(store, 'site_users', {}, 1000)).length
  }

  /** Issue and deliver a code under `key`, with a resend cooldown and an hourly cap. */
  async function issueCode(key: string, deliver: (code: string) => Promise<void>): Promise<void> {
    const t = now()
    const existing = await findOne<CodeRow>(store, 'site_codes', { key })
    const recent = numberArray(existing?.data.sends).filter((at) => t - at < HOUR).sort((a, b) => a - b)
    if (recent.length >= MAX_SENDS_PER_HOUR) throw new ServiceError('rate_limited', 'Too many codes. Try again later.')
    if (recent.length && t - recent[recent.length - 1]! < RESEND_COOLDOWN_MS) {
      throw new ServiceError('rate_limited', 'Wait a moment before asking for another code.')
    }
    const code = sixDigits()
    const data = { key, hash: await hmacHex(deps.secret, `${key}:${code}`), expiresAt: t + CODE_TTL_MS, attempts: 0, sends: [...recent, t] }
    const recordId = existing ? existing.recordId : await insert(store, 'site_codes', data)
    if (existing) await patch(store, 'site_codes', recordId, data)
    try {
      await deliver(code)
    } catch {
      // A send that never arrived shouldn't count toward the cooldown or hourly cap.
      await patch(store, 'site_codes', recordId, { hash: '', expiresAt: 0, sends: recent })
      throw new ServiceError('send_failed', "Couldn't send the code. Try again.")
    }
  }

  /** Check and consume a code. */
  async function checkCode(key: string, rawCode: unknown): Promise<void> {
    const code = typeof rawCode === 'string' ? rawCode.replace(/\D/g, '') : ''
    const pending = await findOne<CodeRow>(store, 'site_codes', { key })
    if (!pending || !pending.data.hash) throw new ServiceError('no_code', 'Ask for a code first.')
    if (now() > Number(pending.data.expiresAt)) throw new ServiceError('expired', 'That code expired. Ask for a new one.')
    const attempts = Number(pending.data.attempts ?? 0)
    if (attempts >= MAX_ATTEMPTS) throw new ServiceError('too_many_attempts', 'Too many tries. Ask for a new code.')
    const expected = await hmacHex(deps.secret, `${key}:${code}`)
    if (code.length !== 6 || !constantTimeEqual(expected, pending.data.hash)) {
      await patch(store, 'site_codes', pending.recordId, { attempts: attempts + 1 })
      if (attempts + 1 >= MAX_ATTEMPTS) throw new ServiceError('too_many_attempts', 'Too many tries. Ask for a new code.')
      throw new ServiceError('wrong_code', "That code isn't right.")
    }
    // Keep the send history for rate limiting; clear the code so it can't be reused.
    await patch(store, 'site_codes', pending.recordId, { hash: '', attempts: 0, expiresAt: 0 })
  }

  async function challengeEmail(challenge: unknown): Promise<{ email: string; recordId: string } | null> {
    if (typeof challenge !== 'string' || !challenge) return null
    const row = await findOne<{ email: string; expiresAt: number }>(store, 'site_challenges', {
      tokenHash: await sha256Hex(challenge),
    })
    return row && Number(row.data.expiresAt) >= now() ? { email: row.data.email, recordId: row.recordId } : null
  }

  /** The email and phone must be new, or already belong to the same account. */
  async function pairingError(email: string, phone: string): Promise<'account_mismatch' | 'full' | null> {
    const byPhone = await userRow(phone)
    const byEmail = await findOne<SiteUser>(store, 'site_users', { email })
    if (byPhone && byPhone.user.email !== email) return 'account_mismatch'
    if (byEmail && byEmail.data.phone !== phone) return 'account_mismatch'
    if (!byPhone && (await userCount()) >= deps.maxUsers) return 'full'
    return null
  }

  async function assertPairing(email: string, phone: string) {
    const error = await pairingError(email, phone)
    if (error === 'full') throw new ServiceError('full', 'The beta is full.')
    if (error) throw new ServiceError('account_mismatch', 'That email and number belong to different accounts.')
  }

  return {
    async stats() {
      return { spotsTaken: Math.min(await userCount(), deps.maxUsers), spotsTotal: deps.maxUsers }
    },

    /** Step 1: email a code. */
    async startEmail(rawEmail: unknown): Promise<{ ok: true }> {
      const email = normalizeEmail(rawEmail)
      if (!email) throw new ServiceError('invalid_email', 'Enter a valid email.')
      await issueCode(`email:${email}`, (code) => deps.sendEmailCode(email, code))
      return { ok: true }
    },

    /** Step 2: trade the emailed code for a challenge token. */
    async verifyEmail(rawEmail: unknown, rawCode: unknown): Promise<{ challenge: string }> {
      const email = normalizeEmail(rawEmail)
      if (!email) throw new ServiceError('invalid_email', 'Enter a valid email.')
      await checkCode(`email:${email}`, rawCode)
      const challenge = randomToken()
      await insert(store, 'site_challenges', {
        tokenHash: await sha256Hex(challenge),
        email,
        expiresAt: now() + CHALLENGE_TTL_MS,
      })
      return { challenge }
    },

    /** Step 3: queue an iMessage code, only with a verified email that fits this number. */
    async startPhone(challenge: unknown, rawPhone: unknown): Promise<{ ok: true }> {
      const phone = normalizeUsPhone(rawPhone)
      if (!phone) throw new ServiceError('invalid_phone', 'Enter a US mobile number.')
      const verified = await challengeEmail(challenge)
      if (!verified) throw new ServiceError('challenge_expired', 'Start again with your email.')
      await assertPairing(verified.email, phone)
      await issueCode(`phone:${phone}`, async (code) => {
        await insert(store, 'notification_outbox', {
          userId: `site:${phone}`,
          channel: 'imessage',
          externalId: phone,
          body: `${code} is your plansaroundus sign-in code. It expires in 10 minutes. If you didn't ask for it, ignore this text.`,
          status: 'pending',
          attempts: 0,
        })
      })
      return { ok: true }
    },

    /** Step 4: verify the iMessage code, create the account if new, and start a session. */
    async verifyPhone(challenge: unknown, rawPhone: unknown, rawCode: unknown) {
      const phone = normalizeUsPhone(rawPhone)
      if (!phone) throw new ServiceError('invalid_phone', 'Enter a US mobile number.')
      const verified = await challengeEmail(challenge)
      if (!verified) throw new ServiceError('challenge_expired', 'Start again with your email.')
      // Re-checked: someone may have taken the last spot since the code was sent.
      await assertPairing(verified.email, phone)
      await checkCode(`phone:${phone}`, rawCode)
      await patch(store, 'site_challenges', verified.recordId, { expiresAt: 0 })
      let row = await userRow(phone)
      if (!row) {
        await tryInsert(store, 'site_users', { phone, email: verified.email, createdAt: new Date(now()).toISOString() })
        row = await userRow(phone)
      }
      if (!row) throw new ServiceError('server_error', 'Could not create the account.')
      const token = randomToken()
      await insert(store, 'site_sessions', { tokenHash: await sha256Hex(token), phone, expiresAt: now() + SESSION_TTL_MS })
      return { token, user: publicUser(row.user) }
    },

    /** The signed-in user for a bearer token, or null. */
    async session(token: string | undefined): Promise<SiteUser | null> {
      if (!token) return null
      const found = await findOne<{ phone: string; expiresAt: number }>(store, 'site_sessions', {
        tokenHash: await sha256Hex(token),
      })
      if (!found || Number(found.data.expiresAt) < now()) return null
      return (await userRow(found.data.phone))?.user ?? null
    },

    async signOut(token: string): Promise<void> {
      const found = await findOne(store, 'site_sessions', { tokenHash: await sha256Hex(token) })
      if (found) await patch(store, 'site_sessions', found.recordId, { expiresAt: 0 })
    },

    async savePreferences(phone: string, input: unknown): Promise<SitePreferences> {
      const prefs = parsePreferences(input)
      if (!prefs) throw new ServiceError('invalid_preferences', 'Add your first name.')
      const row = await userRow(phone)
      if (!row) throw new ServiceError('unauthorized', 'Sign in again.')
      await patch(store, 'site_users', row.recordId, {
        preferences: prefs,
        onboardedAt: row.user.onboardedAt ?? new Date(now()).toISOString(),
      })
      return prefs
    },

    /** Queue the "say hi" iMessage that opens the chat with the agent. */
    async startChat(user: SiteUser): Promise<void> {
      const name = user.preferences?.name
      await insert(store, 'notification_outbox', {
        userId: `site:${user.phone}`,
        channel: 'imessage',
        externalId: user.phone,
        body: `Hi${name ? ` ${name}` : ''}! This is @agent from plansaroundus. Add me to a group chat and mention @agent when you need a plan.`,
        status: 'pending',
        attempts: 0,
      })
    },

    async recordWallet(phone: string, xrplAddress: string): Promise<void> {
      const row = await userRow(phone)
      if (!row) throw new ServiceError('unauthorized', 'Sign in again.')
      await patch(store, 'site_users', row.recordId, { xrplAddress })
    },

    /** Removes the account and ends every session for it. */
    async deleteUser(phone: string): Promise<void> {
      const row = await userRow(phone)
      if (row) await store.remove('site_users', row.recordId)
      for (const session of await findAll(store, 'site_sessions', { phone })) {
        await patch(store, 'site_sessions', session.recordId, { expiresAt: 0 })
      }
    },

    /** Waitlist for when all spots are taken. Requires a verified email. */
    async joinWaitlist(challenge: unknown, rawPhone: unknown, rawName: unknown): Promise<{ position: number }> {
      const verified = await challengeEmail(challenge)
      if (!verified) throw new ServiceError('challenge_expired', 'Start again with your email.')
      const phone = normalizeUsPhone(rawPhone) ?? undefined
      const name = typeof rawName === 'string' ? rawName.trim().slice(0, 60) : undefined
      await tryInsert(store, 'site_waitlist', {
        email: verified.email,
        ...(phone && { phone }),
        ...(name && { name }),
        at: new Date(now()).toISOString(),
      })
      const all = await findAll<{ email: string; at: string }>(store, 'site_waitlist', {}, 1000)
      all.sort((a, b) => a.data.at.localeCompare(b.data.at))
      return { position: all.findIndex((row) => row.data.email === verified.email) + 1 }
    },
  }
}

export type Site = ReturnType<typeof createSite>
