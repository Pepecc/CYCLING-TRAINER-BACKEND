import crypto from 'crypto'

// AES-256-GCM encryption for secrets stored at rest (Wahoo OAuth tokens).
// Stored format: "enc:v1:<iv>:<authTag>:<ciphertext>" (base64 parts).
// Values without the prefix are legacy plaintext and are returned as-is,
// so existing rows keep working and get encrypted on their next save.

const PREFIX = 'enc:v1:'

function loadKey(): Buffer | null {
  const raw = process.env.TOKEN_ENCRYPTION_KEY
  if (!raw) {
    console.warn('⚠️  TOKEN_ENCRYPTION_KEY no configurada — los tokens de Wahoo se guardan sin cifrar')
    return null
  }
  // Accept any string: derive a fixed 32-byte key from it
  return crypto.createHash('sha256').update(raw).digest()
}

const key = loadKey()

export function encryptSecret(plain: string): string {
  if (!key) return plain
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return PREFIX + [iv, tag, encrypted].map(b => b.toString('base64')).join(':')
}

export function decryptSecret(stored: string): string {
  if (!stored.startsWith(PREFIX)) return stored
  if (!key) throw new Error('Token cifrado pero TOKEN_ENCRYPTION_KEY no está configurada')
  const [iv, tag, encrypted] = stored.slice(PREFIX.length).split(':').map(p => Buffer.from(p, 'base64'))
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8')
}
