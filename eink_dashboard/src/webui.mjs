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
    <button class="btn" id="remSignin" type="button" style="display:none;margin-top:12px">Mit iCloud anmelden &amp; Code anfordern</button>
    <form id="remForm" style="display:none">
      <input id="code" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]*" placeholder="000000" aria-label="6-stelliger Code">
      <div class="row">
        <button class="btn" id="remSubmit" type="submit">Best&auml;tigen</button>
        <button class="btn ghost" id="remResend" type="button">Neuen Code anfordern</button>
      </div>
    </form>
    <div id="remMsg" class="msg"></div>
    <p class="muted" id="remHint" style="margin:12px 0 0;display:none">Apple sendet den Code an deine Trusted Devices. <b>Nicht mehrfach hintereinander anfordern</b> &ndash; zu viele Versuche l&ouml;sen einen Apple-Cooldown (503) aus.</p>
  </div>

  <div class="card">
    <h2>STATUS</h2>
    <div class="grid" id="statusGrid"><span class="muted">L&auml;dt &hellip;</span></div>
    <p class="muted" id="espHint" style="margin:14px 0 0"></p>
  </div>

  <div class="card">
    <h2>FENSTER-SENSOREN</h2>
    <div id="winStatus"><span class="spin"></span>Lade HA-Sensoren &hellip;</div>
    <div id="winList" style="display:none; max-height:280px; overflow:auto; margin:6px 0 0"></div>
    <div class="row" id="winActions" style="display:none; margin-top:12px">
      <button class="btn" id="winSave" type="button">Auswahl speichern</button>
      <span class="muted" id="winSaved"></span>
    </div>
    <p class="muted" style="margin:12px 0 0">Ausgew&auml;hlte Kontakte f&auml;rben den &bdquo;Fenster&ldquo;-Streifen rot, sobald einer offen ist.</p>
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
 // WICHTIG: der Login (der Apples 2FA-Code pusht) wird NUR auf Klick ausgeloest
 // (initiate=1), nie automatisch beim Laden. Sonst summieren sich die Versuche und
 // Apple sperrt mit 503 (Cooldown). Ein Klick = genau ein Code.
 var remStatus=document.getElementById('remStatus'), remForm=document.getElementById('remForm'),
     codeEl=document.getElementById('code'), remMsg=document.getElementById('remMsg'),
     remSubmit=document.getElementById('remSubmit'), remResend=document.getElementById('remResend'),
     remSignin=document.getElementById('remSignin'), remHint=document.getElementById('remHint');
 var remBusy=false;
 function setRemMsg(t,cls){ remMsg.textContent=t||''; remMsg.className='msg '+(cls||''); }
 function showRem(which){ // 'idle' | 'code' | 'none'
   remSignin.style.display = which==='idle' ? 'inline-block' : 'none';
   remForm.style.display   = which==='code' ? 'block' : 'none';
   remHint.style.display   = (which==='idle'||which==='code') ? 'block' : 'none';
 }
 function renderRem(st){
   if(!st){ remStatus.textContent='Keine Antwort vom Server.'; showRem('none'); return; }
   if(st.state==='idle'){
     remStatus.innerHTML='Noch nicht verbunden. Zum Aktivieren anmelden &ndash; Apple sendet dann <b>einmalig</b> einen Code an deine Ger&auml;te.';
     showRem('idle');
   } else if(st.state==='need_code'){
     remStatus.innerHTML='Ein <b>6-stelliger Code</b> wurde an deine Apple-Ger&auml;te gesendet. Gib ihn ein.';
     showRem('code'); codeEl.value=''; codeEl.focus();
   } else if(st.state==='authenticated'){
     var extra = st.trusted===false ? ' <span style="color:#d11">(Device-Trust nicht gesetzt.)</span>' : '';
     remStatus.innerHTML='✅ <b>Eingerichtet.</b> Erinnerungen erscheinen nach dem n&auml;chsten Refresh.'+extra;
     showRem('none');
   } else if(st.state==='no_password'){
     remStatus.innerHTML='Bitte im <b>Configuration</b>-Tab <code>icloud_apple_id</code> + <code>icloud_apple_password</code> setzen, Add-on neu starten, dann diese Seite neu laden.';
     showRem('none');
   } else {
     remStatus.textContent='Fehler: '+(st.message||'unbekannt'); showRem('none');
   }
 }
 function loadRem(opts){
   opts = opts || {};
   if(remBusy) return; remBusy=true; remSignin.disabled=true; remResend.disabled=true;
   var extras=[]; if(opts.fresh) extras.push('fresh=1'); if(opts.initiate) extras.push('initiate=1');
   remStatus.innerHTML='<span class="spin"></span>'+(opts.initiate?'Verbinde mit iCloud &hellip;':'Pr&uuml;fe Status &hellip;');
   showRem('none'); setRemMsg('');
   fetch(withParams('setup/state', extras.join('&')), {cache:'no-store'})
     .then(function(r){return r.json();})
     .then(function(st){ remBusy=false; remSignin.disabled=false; remResend.disabled=false; renderRem(st); })
     .catch(function(e){ remBusy=false; remSignin.disabled=false; remResend.disabled=false; remStatus.textContent='Netzwerkfehler: '+e; });
 }
 remSignin.addEventListener('click', function(){ loadRem({initiate:true}); });
 remResend.addEventListener('click', function(){ loadRem({initiate:true, fresh:true}); });
 remForm.addEventListener('submit', function(ev){ ev.preventDefault();
   var code=(codeEl.value||'').replace(/[^0-9]/g,''); if(code.length!==6){ setRemMsg('Bitte 6 Ziffern eingeben.','err'); return; }
   setRemMsg('Prüfe Code …',''); remSubmit.disabled=true;
   fetch(withParams('setup/code'), {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:code})})
     .then(function(r){return r.json();}).then(function(res){ remSubmit.disabled=false;
       if(res.ok){ setRemMsg(''); renderRem({state:'authenticated',trusted:res.trusted}); loadStatus(); }
       else setRemMsg(res.message||'Code abgelehnt.','err');
     }).catch(function(e){ remSubmit.disabled=false; setRemMsg('Netzwerkfehler: '+e,'err'); });
 });

 // --- Fenster-Sensoren (Auswahl) ---
 var winStatus=document.getElementById('winStatus'), winList=document.getElementById('winList'),
     winActions=document.getElementById('winActions'), winSave=document.getElementById('winSave'),
     winSaved=document.getElementById('winSaved');
 function esc(s){ return String(s).replace(/[&<>"]/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]; }); }
 function loadWindows(){
   winStatus.style.display=''; winStatus.innerHTML='<span class="spin"></span>Lade HA-Sensoren …';
   winList.style.display='none'; winActions.style.display='none';
   fetch(withParams('windows'), {cache:'no-store'}).then(function(r){return r.json();}).then(function(d){
     if(!d || !Array.isArray(d.candidates)){ winStatus.textContent='HA nicht erreichbar (homeassistant_api aktiv? Add-on neu gestartet?).'; return; }
     if(!d.candidates.length){ winStatus.textContent='Keine binary_sensor-Entitäten in HA gefunden.'; return; }
     var sel={}; (d.selected||[]).forEach(function(id){ sel[id]=true; });
     winStatus.style.display='none';
     winList.innerHTML = d.candidates.map(function(c){
       var open = c.open ? ' <span class="pill warn">offen</span>' : '';
       var dc = c.deviceClass ? ' <span class="muted">('+esc(c.deviceClass)+')</span>' : '';
       return '<label style="display:flex;align-items:center;gap:9px;padding:6px 2px;cursor:pointer">'
         + '<input type="checkbox" value="'+esc(c.id)+'"'+(sel[c.id]?' checked':'')+' style="width:18px;height:18px">'
         + '<span style="flex:1">'+esc(c.name)+dc+open+'</span></label>';
     }).join('');
     winList.style.display='block'; winActions.style.display='flex';
   }).catch(function(e){ winStatus.textContent='Netzwerkfehler: '+e; });
 }
 winSave.addEventListener('click', function(){
   var ids = Array.prototype.slice.call(winList.querySelectorAll('input:checked')).map(function(i){ return i.value; });
   winSave.disabled=true; winSaved.textContent='Speichere …';
   fetch(withParams('windows'), {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({selected:ids})})
     .then(function(r){return r.json();}).then(function(res){ winSave.disabled=false;
       winSaved.textContent = (res && res.ok) ? ('Gespeichert ('+(res.selected?res.selected.length:0)+').') : 'Fehler beim Speichern.';
       refreshPreview(); loadStatus();
     }).catch(function(e){ winSave.disabled=false; winSaved.textContent='Netzwerkfehler: '+e; });
 });

 refreshPreview(); loadStatus(); loadRem({}); loadWindows();
</script>
</body></html>`
