// iCloud-2FA-Setup ueber eine kleine Web-UI (Ersatz fuer `docker exec`/SSH in den
// Container). Der Node-Server exponiert /setup (HTML) + /setup/state + /setup/code.
// Diese reden mit EINEM persistenten pyicloud-Bridge-Prozess, damit der Session-
// Zustand zwischen "einloggen (Apple pusht den Code)" und "Code absenden" erhalten
// bleibt (ein frischer Prozess je Schritt wuerde die 2FA-Session verlieren).
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
export async function icloudAuthState({ fresh = false } = {}) {
  if (fresh) resetBridge()
  const resp = await sendOp('auth_state', {})
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

export const SETUP_HTML = `<!doctype html>
<html lang="de"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>eInk · iCloud-Erinnerungen einrichten</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #f2f3f5; color: #1c1c1e; padding: 20px; }
  .card { width: 100%; max-width: 440px; background: #fff; border-radius: 16px;
    box-shadow: 0 6px 30px rgba(0,0,0,.10); padding: 28px 26px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { color: #6b6b70; font-size: 13px; margin: 0 0 20px; }
  #status { font-size: 15px; line-height: 1.5; margin-bottom: 18px; }
  #status code { background: #eef0f2; padding: 1px 6px; border-radius: 5px; font-size: 13px; }
  form { display: none; }
  input[type=text] { width: 100%; font-size: 30px; letter-spacing: 12px; text-align: center;
    padding: 14px 10px; border: 2px solid #d0d3d7; border-radius: 12px; margin-bottom: 14px;
    font-variant-numeric: tabular-nums; background: #fbfbfc; }
  input[type=text]:focus { outline: none; border-color: #0a84ff; }
  button { width: 100%; font-size: 16px; font-weight: 600; padding: 13px; border: 0;
    border-radius: 12px; cursor: pointer; }
  #submit { background: #0a84ff; color: #fff; }
  #submit:disabled { opacity: .5; cursor: default; }
  #resend { display: none; margin-top: 12px; background: transparent; color: #0a84ff; font-weight: 500; }
  .msg { min-height: 18px; margin-top: 12px; font-size: 14px; }
  .msg.err { color: #d11; }
  .spin { display: inline-block; width: 14px; height: 14px; border: 2px solid #c9ccd1;
    border-top-color: #0a84ff; border-radius: 50%; animation: r 0.8s linear infinite; vertical-align: -2px; margin-right: 7px; }
  @keyframes r { to { transform: rotate(360deg); } }
  @media (prefers-color-scheme: dark) {
    body { background: #000; color: #f2f2f7; }
    .card { background: #1c1c1e; box-shadow: none; }
    .sub { color: #98989f; }
    #status code { background: #2c2c2e; }
    input[type=text] { background: #2c2c2e; border-color: #38383a; color: #fff; }
  }
</style>
</head><body>
  <div class="card">
    <h1>iCloud-Erinnerungen</h1>
    <p class="sub">Einmalige 2-Faktor-Anmeldung fuer das eInk-Dashboard.</p>
    <div id="status"><span class="spin"></span>Verbinde mit iCloud &hellip;</div>
    <form id="form">
      <input id="code" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="6"
             pattern="[0-9]*" placeholder="000000" aria-label="6-stelliger Code">
      <button id="submit" type="submit">Best&auml;tigen</button>
    </form>
    <button id="resend" type="button">Neuen Code anfordern</button>
    <div id="msg" class="msg"></div>
  </div>
<script>
  var key = new URLSearchParams(location.search).get('key');
  function q(p){ return key ? p + (p.indexOf('?') >= 0 ? '&' : '?') + 'key=' + encodeURIComponent(key) : p; }
  var statusEl = document.getElementById('status');
  var formEl = document.getElementById('form');
  var codeEl = document.getElementById('code');
  var msgEl = document.getElementById('msg');
  var resendBtn = document.getElementById('resend');
  var submitBtn = document.getElementById('submit');

  function setMsg(t, cls){ msgEl.textContent = t || ''; msgEl.className = 'msg ' + (cls || ''); }

  function render(st){
    if (!st){ statusEl.textContent = 'Keine Antwort vom Server.'; return; }
    if (st.state === 'need_code'){
      statusEl.innerHTML = 'Ein <b>6-stelliger Code</b> wurde an deine Apple-Ger&auml;te (iPhone/iPad/Mac) gesendet. Gib ihn hier ein.';
      formEl.style.display = 'block';
      resendBtn.style.display = 'block';
      codeEl.value = ''; codeEl.focus();
    } else if (st.state === 'authenticated'){
      var extra = st.trusted === false ? ' <span style="color:#d11">(Device-Trust nicht gesetzt – evtl. bald erneut n&ouml;tig.)</span>' : '';
      statusEl.innerHTML = '✅ <b>Eingerichtet.</b> Die Erinnerungen erscheinen nach dem n&auml;chsten Refresh (ein paar Minuten).' + extra;
      formEl.style.display = 'none';
      resendBtn.style.display = 'none';
    } else if (st.state === 'no_password'){
      statusEl.innerHTML = 'Bitte zuerst im <b>Configuration</b>-Tab des Add-ons <code>icloud_apple_id</code> und <code>icloud_apple_password</code> setzen, das Add-on <b>neu starten</b> und diese Seite neu laden.';
      formEl.style.display = 'none';
      resendBtn.style.display = 'none';
    } else {
      statusEl.textContent = 'Fehler: ' + (st.message || 'unbekannt');
      formEl.style.display = 'none';
      resendBtn.style.display = 'none';
    }
  }

  function load(fresh){
    statusEl.innerHTML = '<span class="spin"></span>Verbinde mit iCloud &hellip;';
    formEl.style.display = 'none'; resendBtn.style.display = 'none'; setMsg('');
    fetch(q('/setup/state' + (fresh ? '?fresh=1' : '')), { cache: 'no-store' })
      .then(function(r){ return r.json(); }).then(render)
      .catch(function(e){ statusEl.textContent = 'Netzwerkfehler: ' + e; });
  }

  formEl.addEventListener('submit', function(ev){
    ev.preventDefault();
    var code = (codeEl.value || '').replace(/[^0-9]/g, '');
    if (code.length !== 6){ setMsg('Bitte 6 Ziffern eingeben.', 'err'); return; }
    setMsg('Prüfe Code …', ''); submitBtn.disabled = true;
    fetch(q('/setup/code'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: code }) })
      .then(function(r){ return r.json(); }).then(function(res){
        submitBtn.disabled = false;
        if (res.ok){ setMsg(''); render({ state: 'authenticated', trusted: res.trusted }); }
        else { setMsg(res.message || 'Code abgelehnt.', 'err'); }
      }).catch(function(e){ submitBtn.disabled = false; setMsg('Netzwerkfehler: ' + e, 'err'); });
  });

  resendBtn.addEventListener('click', function(){ load(true); });
  load(false);
</script>
</body></html>`
