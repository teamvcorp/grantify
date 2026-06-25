import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import type { ScryptOptions } from 'node:crypto'

/**
 * Password hashing with Node's built-in scrypt — no third-party dependency.
 *
 * Why scrypt: it's a memory-hard KDF available in Node core, so we avoid pulling
 * in a native bcrypt/argon2 build (which complicates serverless deploys). Argon2id
 * would be marginally preferable, but scrypt with these parameters is well within
 * OWASP guidance and ships with the runtime.
 *
 * SECURITY:
 *  - Per-password random salt (16 bytes).
 *  - Parameters are stored *inside* the hash string, so cost can be raised later
 *    without breaking existing hashes (verify reads the params from the stored value).
 *  - Comparison is constant-time (timingSafeEqual) to avoid leaking via timing.
 *  - This module is server-only. Never import it into a client component.
 */

/**
 * Promise wrapper around scrypt that preserves the `options` argument (the
 * promisified built-in drops the options overload in its type signature).
 */
function scryptAsync(
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, options, (err, derivedKey) => {
      if (err) reject(err)
      else resolve(derivedKey)
    })
  })
}

// Tunable cost. N must be a power of 2. memory ≈ 128 * N * r bytes (~33 MB here),
// so maxmem is raised above the 32 MB default to leave headroom.
const N = 32768 // 2^15 CPU/memory cost
const R = 8 // block size
const P = 1 // parallelization
const KEYLEN = 64
const SALT_BYTES = 16
const MAXMEM = 64 * 1024 * 1024

/** Produce a self-describing hash string: `scrypt$N$r$p$salt$hash` (salt/hash base64). */
export async function hashPassword(plain: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES)
  const derived = (await scryptAsync(plain, salt, KEYLEN, {
    N,
    r: R,
    p: P,
    maxmem: MAXMEM,
  })) as Buffer
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${derived.toString('base64')}`
}

/**
 * Verify a plaintext password against a stored hash string. Returns false (never
 * throws) on any malformed/unknown stored value so callers can treat it as a
 * failed login rather than a 500.
 */
export async function verifyPassword(
  plain: string,
  stored: string | null | undefined
): Promise<boolean> {
  if (!stored) return false
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false

  const [, nStr, rStr, pStr, saltB64, hashB64] = parts
  const n = Number(nStr)
  const r = Number(rStr)
  const p = Number(pStr)
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) {
    return false
  }

  let salt: Buffer
  let expected: Buffer
  try {
    salt = Buffer.from(saltB64, 'base64')
    expected = Buffer.from(hashB64, 'base64')
  } catch {
    return false
  }

  let derived: Buffer
  try {
    derived = (await scryptAsync(plain, salt, expected.length, {
      N: n,
      r,
      p,
      maxmem: MAXMEM,
    })) as Buffer
  } catch {
    return false
  }

  // Lengths must match before timingSafeEqual (it throws on mismatch).
  return derived.length === expected.length && timingSafeEqual(derived, expected)
}
