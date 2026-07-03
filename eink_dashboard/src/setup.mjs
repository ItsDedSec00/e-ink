// iCloud-2FA-Setup-Backend fuer die Web-UI (webui.mjs). Der Node-Server exponiert
// /setup/state + /setup/code; diese reden mit EINEM persistenten pyicloud-Bridge-
// Prozess, damit der Session-Zustand zwischen "einloggen (Apple pusht den Code)" und
// "Code absenden" erhalten bleibt (ein frischer Prozess je Schritt wuerde die
// pending-2FA-Session verlieren).
import { spawn } from 'node:child_process'
import { config } from './config.mjs'

let child = null
let buf = ''
let seq = 0
const pending = new Map()   // id -> { resolve, timer }

function ensureChild() {
  if (child) return child
  const { reminderBridgePy: py, reminderBridgeScript: script, reminderAppleId: appleId } = config
  if (!py || !script || !appleId) {
    const e = new Error('bridge_not_configured'); e.code = 'bridge_not_configured'; throw e
  }
  const c = spawn(py, [script], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ICLOUD_USERNAME: appleId, ICLOUD_REMINDER_LISTS: config.icloudReminderLists.join(',') },
  })
  child = c
  c.stdout.on('data', d => {
    buf += d
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1)
      if (!line) continue
      let resp; try { resp = JSON.parse(line) } catch { continue }
      const p = pending.get(resp.id)
      if (p) { pending.delete(resp.id); clearTimeout(p.timer); p.resolve(resp) }
    }
  })
  c.stderr.on('data', d => { for (const ln of String(d).split('\n')) if (ln.trim()) console.log('[setup-bridge]', ln.trim()) })
  const cleanup = () => {
    if (child === c) { child = null; buf = '' }
    for (const [, p] of pending) { clearTimeout(p.timer); p.resolve({ error: 'bridge_closed' }) }
    pending.clear()
  }
  c.on('close', cleanup)
  c.on('error', cleanup)
  return c
}

function resetBridge() {
  if (child) { try { child.kill() } catch { /* egal */ } child = null; buf = '' }
}

function sendOp(op, args = {}, timeoutMs = 90000) {
  let c
  try { c = ensureChild() } catch (e) { return Promise.resolve({ error: e.code || 'spawn_failed' }) }
  const id = String(++seq)
  return new Promise(resolve => {
    const timer = setTimeout(() => { pending.delete(id); resolve({ error: 'timeout' }) }, timeoutMs)
    pending.set(id, { resolve, timer })
    try { c.stdin.write(JSON.stringify({ id, op, args }) + '\n') }
    catch { clearTimeout(timer); pending.delete(id); resolve({ error: 'write_failed' }) }
  })
}

// GET /setup/state  ->  { state: 'need_code' | 'authenticated' | 'no_password' | 'error', ... }
// fresh=true killt den Bridge-Prozess vorher (neuer Login -> Apple pusht neuen Code).
export async function icloudAuthState({ fresh = false, initiate = false } = {}) {
  if (fresh) resetBridge()
  const resp = await sendOp('auth_state', { initiate })
  if (resp.error) return { state: 'error', message: humanError(resp.error) }
  return resp.result || { state: 'error', message: 'Keine Antwort der Bridge.' }
}

// POST /setup/code  ->  { ok, trusted } | { ok:false, message }
export async function icloudSubmitCode(code) {
  const resp = await sendOp('submit_2fa', { code: String(code || '') })
  if (resp.error) return { ok: false, message: humanError(resp.error) }
  const r = resp.result || {}
  if (r.trusted) resetBridge()   // Session liegt jetzt persistent in /data -> Setup-Prozess kann weg
  return { ok: true, ...r }
}

function humanError(err) {
  if (err === 'bridge_not_configured') return 'Reminder-Bridge nicht konfiguriert (Apple-ID/Passwort in den Add-on-Optionen setzen und neu starten).'
  if (err === 'timeout') return 'Zeitueberschreitung bei der Verbindung zu iCloud. Nochmal versuchen.'
  if (err === 'bridge_closed' || err === 'spawn_failed' || err === 'write_failed') return 'Interner Bridge-Fehler. Add-on-Log pruefen.'
  return String(err)
}
