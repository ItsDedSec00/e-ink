// Web-Oberflaeche des Add-ons (laeuft ueber HA-Ingress -> Panel in der Seitenleiste,
// von HA authentifiziert, keine IP/kein Port noetig). Zeigt: Live-Vorschau des
// gerenderten eInk-Panels, iCloud-Erinnerungen-Einrichtung (2FA) und Status.
//
// WICHTIG: ALLE URLs im Client sind RELATIV (kein fuehrender "/"), weil die Seite
// hinter dem Ingress-Basispfad /api/hassio_ingress/<token>/ ausgeliefert wird.
// Relative Pfade funktionieren so sowohl via Ingress als auch am direkten :8080-Port.
export const APP_HTML = `<!doctype html>
<html lang="de"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>eInk Dashboard</title>
<style>
 :root { color-scheme: light dark; }
 * { box-sizing: border-box; }
 body { margin:0; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
   background:#f2f3f5; color:#1c1c1e; padding:18px; }
 .wrap { max-width:860px; margin:0 auto; display:flex; flex-direction:column; gap:16px; }
 h1 { font-size:22px; margin:2px 0 0; }
 .sub { color:#6b6b70; font-size:13px; margin:0 0 4px; }
 .card { background:#fff; border-radius:16px; box-shadow:0 4px 20px rgba(0,0,0,.07); padding:20px; }
 .card h2 { font-size:14px; margin:0 0 14px; letter-spacing:.6px; color:#6b6b70; }
 .preview-box { background:#e9ebee; border-radius:10px; padding:10px; text-align:center; overflow:auto; }
 .preview-box img { max-width:100%; height:auto; border-radius:6px; box-shadow:0 1px 4px rgba(0,0,0,.2); background:#fff; }
 .row { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
 .btn { font-size:14px; font-weight:600; padding:9px 15px; border:0; border-radius:10px; cursor:pointer; background:#0a84ff; color:#fff; }
 .btn.ghost { background:transparent; color:#0a84ff; }
 .btn:disabled { opacity:.5; cursor:default; }
 .muted { color:#8a8a8f; font-size:13px; }
 .grid { display:grid; grid-template-columns:1fr auto; gap:9px 18px; font-size:14px; align-items:center; }
 .pill { display:inline-block; font-size:12px; font-weight:600; padding:2px 10px; border-radius:20px; }
 .ok { background:#dcf5e4; color:#137a3a; }
 .off { background:#eceef0; color:#8a8a8f; }
 .warn { background:#ffe9c7; color:#8a5a00; }
 form { margin:0; }
 input#code { width:100%; font-size:28px; letter-spacing:11px; text-align:center; padding:12px;
   border:2px solid #d0d3d7; border-radius:12px; margin:6px 0 12px; background:#fbfbfc; font-variant-numeric:tabular-nums; }
 input#code:focus { outline:none; border-color:#0a84ff; }
 .msg { min-height:18px; font-size:14px; margin-top:8px; }
 .msg.err { color:#d11; }
 code { background:#eef0f2; padding:1px 6px; border-radius:5px; font-size:13px; }
 .spin { display:inline-block; width:13px; height:13px; border:2px solid #c9ccd1; border-top-color:#0a84ff;
   border-radius:50%; animation:r .8s linear infinite; vertical-align:-2px; margin-right:6px; }
 @keyframes r { to { transform:rotate(360deg); } }
 @media (prefers-color-scheme: dark){
   body{background:#000;color:#f2f2f7;} .card{background:#1c1c1e;box-shadow:none;}
   .sub,.muted,.card h2{color:#98989f;} .preview-box{background:#0c0c0d;}
   input#code{background:#2c2c2e;border-color:#38383a;color:#fff;} code{background:#2c2c2e;} .off{background:#2c2c2e;color:#98989f;}
 }
</style>
</head><body>
<div class="wrap">
  <div>
    <h1>eInk Dashboard</h1>
    <p class="sub">Vorschau, Status und iCloud-Einrichtung.</p>
  </div>

  <div class="card">
    <h2>VORSCHAU</h2>
    <div class="preview-box"><img id="preview" alt="eInk-Vorschau" width="800" height="480"></div>
    <div class="row" style="margin-top:12px">
      <button class="btn" id="refresh" type="button">Aktualisieren</button>
      <span class="muted" id="previewNote"></span>
    </div>
  </div>

  <div class="card">
    <h2>iCLOUD-ERINNERUNGEN</h2>
    <div id="remStatus"><span class="spin"></span>Pr&uuml;fe Status &hellip;</div>
    <form id="remForm" style="display:none">
      <input id="code" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]*" placeholder="000000" aria-label="6-stelliger Code">
      <div class="row">
        <button class="btn" id="remSubmit" type="submit">Best&auml;tigen</button>
        <button class="btn ghost" id="remResend" type="button">Neuen Code anfordern</button>
      </div>
    </form>
    <div id="remMsg" class="msg"></div>
  </div>

  <div class="card">
    <h2>STATUS</h2>
    <div class="grid" id="statusGrid"><span class="muted">L&auml;dt &hellip;</span></div>
    <p class="muted" id="espHint" style="margin:14px 0 0"></p>
  </div>
</div>
<script>
 var key = new URLSearchParams(location.search).get('key');
 function withParams(p, extra){ var a=[]; if(key)a.push('key='+encodeURIComponent(key)); if(extra)a.push(extra); return a.length ? p+(p.indexOf('?')>=0?'&':'?')+a.join('&') : p; }

 // --- Vorschau ---
 var previewImg = document.getElementById('preview');
 function refreshPreview(){ document.getElementById('previewNote').textContent='Rendere …'; previewImg.src = withParams('eink.png','t='+Date.now()); }
 previewImg.addEventListener('load', function(){ document.getElementById('previewNote').textContent=''; });
 previewImg.addEventListener('error', function(){ document.getElementById('previewNote').textContent='Vorschau konnte nicht geladen werden.'; });
 document.getElementById('refresh').addEventListener('click', refreshPreview);

 // --- Status ---
 function pill(on,onText,offText,warn){ return '<span class="pill '+(on?'ok':(warn?'warn':'off'))+'">'+(on?onText:offText)+'</span>'; }
 function loadStatus(){
   fetch(withParams('status'), {cache:'no-store'}).then(function(r){return r.json();}).then(function(s){
     var src = s.sources || {};
     function line(label,html){ return '<div>'+label+'</div><div style="text-align:right">'+html+'</div>'; }
     var rows='';
     rows += line('Daten', s.mock===true ? pill(false,'','Mock-Daten',true) : (s.mock===false ? pill(true,'Live','') : pill(false,'','—')));
     rows += line('Stripe (Umsatz)', pill(!!src.stripe,'aktiv','—'));
     rows += line('App 1 (Nutzer/Server)', pill(!!src.app1,'aktiv','—'));
     rows += line('Kalender', pill(!!src.calendar,'aktiv','—'));
     rows += line('Erinnerungen', pill(!!src.remindersConfigured,'aktiv','—'));
     if(s.reminders!=null) rows += line('Erinnerungen sichtbar', String(s.reminders));
     if(s.cacheAgeSec!=null) rows += line('Daten-Alter', s.cacheAgeSec+' s');
     document.getElementById('statusGrid').innerHTML = rows;
     document.getElementById('espHint').innerHTML = 'ESP32 l&auml;dt <code>/eink.bin</code> auf Port <b>8080</b>' + (s.einkKeySet ? ' (mit <code>?key=…</code>)' : '') + '.';
   }).catch(function(){ document.getElementById('statusGrid').innerHTML='<span class="muted">Status nicht verf&uuml;gbar.</span>'; });
 }

 // --- iCloud-Erinnerungen (2FA) ---
 var remStatus=document.getElementById('remStatus'), remForm=document.getElementById('remForm'),
     codeEl=document.getElementById('code'), remMsg=document.getElementById('remMsg'),
     remSubmit=document.getElementById('remSubmit'), remResend=document.getElementById('remResend');
 function setRemMsg(t,cls){ remMsg.textContent=t||''; remMsg.className='msg '+(cls||''); }
 function renderRem(st){
   if(!st){ remStatus.textContent='Keine Antwort vom Server.'; return; }
   if(st.state==='need_code'){
     remStatus.innerHTML='Ein <b>6-stelliger Code</b> wurde an deine Apple-Ger&auml;te gesendet. Gib ihn ein.';
     remForm.style.display='block'; codeEl.value=''; codeEl.focus();
   } else if(st.state==='authenticated'){
     var extra = st.trusted===false ? ' <span style="color:#d11">(Device-Trust nicht gesetzt.)</span>' : '';
     remStatus.innerHTML='✅ <b>Eingerichtet.</b> Erinnerungen erscheinen nach dem n&auml;chsten Refresh.'+extra;
     remForm.style.display='none';
   } else if(st.state==='no_password'){
     remStatus.innerHTML='Bitte im <b>Configuration</b>-Tab <code>icloud_apple_id</code> + <code>icloud_apple_password</code> setzen, Add-on neu starten, dann diese Seite neu laden.';
     remForm.style.display='none';
   } else {
     remStatus.textContent='Fehler: '+(st.message||'unbekannt'); remForm.style.display='none';
   }
 }
 function loadRem(fresh){
   remStatus.innerHTML='<span class="spin"></span>Verbinde mit iCloud &hellip;'; remForm.style.display='none'; setRemMsg('');
   fetch(withParams('setup/state', fresh?'fresh=1':''), {cache:'no-store'}).then(function(r){return r.json();}).then(renderRem).catch(function(e){ remStatus.textContent='Netzwerkfehler: '+e; });
 }
 remForm.addEventListener('submit', function(ev){ ev.preventDefault();
   var code=(codeEl.value||'').replace(/[^0-9]/g,''); if(code.length!==6){ setRemMsg('Bitte 6 Ziffern eingeben.','err'); return; }
   setRemMsg('Prüfe Code …',''); remSubmit.disabled=true;
   fetch(withParams('setup/code'), {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:code})})
     .then(function(r){return r.json();}).then(function(res){ remSubmit.disabled=false;
       if(res.ok){ setRemMsg(''); renderRem({state:'authenticated',trusted:res.trusted}); loadStatus(); }
       else setRemMsg(res.message||'Code abgelehnt.','err');
     }).catch(function(e){ remSubmit.disabled=false; setRemMsg('Netzwerkfehler: '+e,'err'); });
 });
 remResend.addEventListener('click', function(){ loadRem(true); });

 refreshPreview(); loadStatus(); loadRem(false);
</script>
</body></html>`
