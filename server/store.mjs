import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

export const hashPassword = (password, salt = randomBytes(16).toString('hex')) => `${salt}:${scryptSync(password, salt, 64).toString('hex')}`
export function checkPassword(password, hash) {
  try { const [salt, value] = hash.split(':'); const actual = scryptSync(password, salt, 64); const expected = Buffer.from(value, 'hex'); return actual.length === expected.length && timingSafeEqual(actual, expected) } catch { return false }
}
export function createStore(dir) {
  mkdirSync(dir, { recursive: true })
  const keyPath = join(dir, '.encryption-key')
  if (!existsSync(keyPath)) writeFileSync(keyPath, randomBytes(32), { mode: 0o600, flag: 'wx' })
  const key = readFileSync(keyPath)
  const db = new DatabaseSync(join(dir, 'weekly-log.sqlite'))
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL, password TEXT NOT NULL, role TEXT NOT NULL, profile TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS invites (token TEXT PRIMARY KEY, created_by TEXT NOT NULL, expires INTEGER NOT NULL, used_by TEXT);
    CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, config TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS secrets (name TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS analyses (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), project_id TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS registrations (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, project_id TEXT NOT NULL, analysis_id TEXT NOT NULL, fingerprint TEXT NOT NULL UNIQUE, task TEXT NOT NULL, commit_ids TEXT NOT NULL, state TEXT NOT NULL, notion_id TEXT, notion_url TEXT, verification TEXT, error TEXT, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS commit_claims (project_id TEXT NOT NULL, parent_id TEXT NOT NULL, commit_hash TEXT NOT NULL, registration_id TEXT NOT NULL REFERENCES registrations(id), PRIMARY KEY(project_id,parent_id,commit_hash));
  `)
  const getSecret = name => {
    const row = db.prepare('SELECT value FROM secrets WHERE name=?').get(name)
    if (!row) return ''
    const [iv, tag, payload] = row.value.split('.')
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'hex'))
    decipher.setAuthTag(Buffer.from(tag, 'hex'))
    return Buffer.concat([decipher.update(Buffer.from(payload, 'hex')), decipher.final()]).toString('utf8')
  }
  const setSecret = (name, value) => {
    if (!value) { db.prepare('DELETE FROM secrets WHERE name=?').run(name); return }
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv)
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
    db.prepare('INSERT OR REPLACE INTO secrets(name,value) VALUES (?,?)').run(name, `${iv.toString('hex')}.${cipher.getAuthTag().toString('hex')}.${encrypted.toString('hex')}`)
  }
  return { db, getSecret, setSecret, close: () => db.close() }
}
