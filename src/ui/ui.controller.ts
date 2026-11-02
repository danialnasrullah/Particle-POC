import { Controller, Get, Header } from '@nestjs/common';

/**
 * Local test page for the POC: enter demographics, register + pull, watch status, view parsed data.
 * Inline HTML so there is no static-file setup. Not part of the merge into the main app.
 */
@Controller()
export class UiController {
  @Get()
  @Header('Content-Type', 'text/html; charset=utf-8')
  index(): string {
    return PAGE;
  }
}

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Particle POC</title>
<style>
  body{font:14px system-ui,sans-serif;max-width:760px;margin:24px auto;padding:0 16px;color:#222}
  h1{font-size:18px} fieldset{border:1px solid #ddd;padding:12px;margin:0 0 12px}
  label{display:block;margin:6px 0 2px;font-size:12px;color:#555}
  input,select{width:100%;padding:6px;box-sizing:border-box}
  .row{display:grid;grid-template-columns:1fr 1fr;gap:8px} .row3{display:grid;grid-template-columns:2fr 1fr 1fr;gap:8px}
  button{padding:8px 14px;cursor:pointer} #log{white-space:pre-wrap;background:#f6f6f6;padding:8px;min-height:40px}
  table{border-collapse:collapse;width:100%;margin:8px 0} td,th{border:1px solid #ddd;padding:4px 6px;text-align:left;font-size:12px}
  .err{color:#b00020} .poc{color:#666}
  .call summary{cursor:pointer;font:12px ui-monospace,monospace} .call.bad summary{color:#b00020}
  .call pre{margin:2px 0 6px 18px;padding:4px 6px;background:#fff;border:1px solid #e3e3e3;font-size:11px;white-space:pre-wrap;word-break:break-all}
</style></head>
<body>
<h1>Particle POC: patient data pull</h1>
<form id="f">
  <fieldset><legend>IDs</legend>
    <div class="row">
      <div><label>Practice ID</label><input name="practiceId" required></div>
      <div><label>elevAID patient ID (new one each load)</label><input name="elevaidId" required></div>
    </div>
    <label>Requested by (clinician id)</label><input name="requestedBy" value="dr-test" required>
  </fieldset>
  <fieldset><legend>Demographics (prefilled with the Particle sandbox test patient)</legend>
    <div class="row">
      <div><label>First name</label><input name="firstName" value="Elvira" required></div>
      <div><label>Last name</label><input name="lastName" value="Valadez-Nucleus" required></div>
    </div>
    <div class="row">
      <div><label>Date of birth</label><input name="dob" type="date" value="1970-12-26" required></div>
      <div><label>Sex at birth</label><select name="genderAtBirth"><option>F</option><option>M</option></select></div>
    </div>
    <label>Address line (optional)</label><input name="line">
    <div class="row3">
      <div><label>City</label><input name="city" value="Boston" required></div>
      <div><label>State (2 letters)</label><input name="state" value="MA" maxlength="2" required></div>
      <div><label>ZIP</label><input name="zip" value="02215" required></div>
    </div>
    <label><input type="checkbox" name="subscribeMonitoring" style="width:auto"> Subscribe to Signal monitoring</label>
  </fieldset>
  <button>Register &amp; pull records</button>
</form>
<h2 style="font-size:15px">Progress</h2>
<p style="font-size:12px;color:#666;margin:0 0 6px">Grey lines are this page calling the POC. Lines starting <b>Particle</b> are the POC calling Particle; click one to see what was sent and what came back.</p>
<div id="log"></div>
<div id="out"></div>
<script>
const f = document.getElementById('f'), log = document.getElementById('log'), out = document.getElementById('out');
f.practiceId.value = '11111111-1111-4111-8111-111111111111';
f.elevaidId.value = crypto.randomUUID();
const say = (msg, cls) => { const d = document.createElement('div'); d.textContent = new Date().toLocaleTimeString() + '  ' + msg; if (cls) d.className = cls === true ? 'err' : cls; log.appendChild(d); };

// quiet: skip logging the page's own background polls.
async function api(method, path, body, quiet) {
  const res = await fetch(path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  if (!quiet) say('POC  ' + method + ' ' + path + '  -> ' + res.status, 'poc');
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data.code || res.status) + ': ' + (data.detail || data.message || 'request failed') + (data.errors ? ' (' + data.errors.join('; ') + ')' : ''));
  return data;
}

// Particle calls made by the POC for this patient, fetched from the sandbox-only call log.
let lastSeq = 0, startedAt = '', callsFailed = false;
async function drainCalls(base) {
  let calls;
  try { calls = await api('GET', base + '/particle-calls', undefined, true); }
  catch (err) { if (!callsFailed) say('Could not load Particle calls: ' + err.message, true); callsFailed = true; return; }
  for (const c of calls) {
    if (c.seq <= lastSeq || c.at < startedAt) continue;
    lastSeq = c.seq;
    const d = document.createElement('details'), s = document.createElement('summary');
    d.className = 'call' + (c.status === null || c.status >= 400 ? ' bad' : '');
    s.textContent = new Date(c.at).toLocaleTimeString() + '  Particle  ' + c.method + ' ' + c.path + '  -> ' + (c.status ?? 'unreachable') + '  (' + c.ms + ' ms)';
    const pre = document.createElement('pre');
    pre.textContent = (c.request ? 'Sent: ' + c.request + '\\n\\n' : '') + 'Received: ' + c.response;
    d.append(s, pre); log.appendChild(d);
  }
}

f.onsubmit = async (e) => {
  e.preventDefault(); log.textContent = ''; out.textContent = '';
  lastSeq = 0; callsFailed = false; startedAt = new Date().toISOString();
  const v = Object.fromEntries(new FormData(f));
  const ref = { practiceId: v.practiceId, elevaidId: v.elevaidId };
  const base = '/particle-records/practices/' + ref.practiceId + '/patients/' + ref.elevaidId;
  try {
    const reg = await api('POST', '/particle-records/patients', { ...ref,
      firstName: v.firstName, lastName: v.lastName, dob: v.dob, genderAtBirth: v.genderAtBirth,
      address: { city: v.city, state: v.state.toUpperCase(), zip: v.zip, ...(v.line ? { lines: [v.line] } : {}) },
      subscribeMonitoring: !!v.subscribeMonitoring, requestedBy: v.requestedBy });
    await drainCalls(base);
    say('Registered. Particle patient id ' + reg.particlePatientId + (reg.monitoringSubscribed ? ' (monitoring on)' : ''));
    const pull = await api('POST', '/particle-records/pull', { ...ref, requestedBy: v.requestedBy });
    say('Pull ' + pull.status);
    poll(base);
  } catch (err) { say(err.message, true); }
};

async function poll(base) {
  let last = '';
  for (;;) {
    await new Promise(r => setTimeout(r, 3000));
    let s;
    try { s = await api('GET', base + '/status', undefined, true); } catch (err) { say(err.message, true); return; }
    await drainCalls(base);
    const q = s.query || {};
    const line = 'Query ' + q.status + (q.lastRawState ? ' (Particle: ' + q.lastRawState + ')' : '') + (q.terminalReason ? ' - ' + q.terminalReason : '');
    if (line !== last) { say(line); last = line; }
    if (['COMPLETE','NO_DATA','FAILED','STALLED'].includes(q.status)) {
      if (q.status === 'COMPLETE') show(await api('GET', base + '/parsed'));
      return;
    }
  }
}

function table(title, rows, cols) {
  if (!rows || !rows.length) return;
  const h = document.createElement('h3'); h.style.fontSize = '14px'; h.textContent = title + ' (' + rows.length + ')'; out.appendChild(h);
  const t = document.createElement('table'), tr = t.insertRow();
  cols.forEach(([label]) => { const th = document.createElement('th'); th.textContent = label; tr.appendChild(th); });
  rows.slice(0, 50).forEach(r => { const row = t.insertRow(); cols.forEach(([, fn]) => { row.insertCell().textContent = fn(r) ?? ''; }); });
  out.appendChild(t);
}

function show(p) {
  const d = p.clinicalData, day = x => x ? String(x).slice(0, 10) : '';
  table('Problems', d.problems, [['Name', r => r.display], ['Status', r => r.clinicalStatus], ['Code', r => r.code && r.code.value], ['Onset', r => day(r.onsetDate)]]);
  table('Medications', d.medications, [['Name', r => r.display], ['Dose', r => r.dosage], ['Status', r => r.status], ['Start', r => day(r.startDate)]]);
  table('Labs', d.labs, [['Test', r => r.display], ['Value', r => [r.value, r.unit].filter(Boolean).join(' ')], ['Status', r => r.status], ['Date', r => day(r.effectiveDate)]]);
  table('Allergies', d.allergies, [['Allergy', r => r.display], ['Reaction', r => r.reaction], ['Status', r => r.status]]);
  table('Encounters', d.encounters, [['Type', r => r.type], ['Start', r => day(r.periodStart)], ['End', r => day(r.periodEnd)]]);
  table('Care transitions', p.extras.transitions, [['Status', r => r.status], ['Setting', r => r.setting], ['Facility', r => r.facilityName], ['When', r => day(r.statusDateTime)]]);
  table('AI outputs (AI-generated, review before use)', p.extras.aiOutputs, [['Type', r => r.type], ['Citations', r => r.citations.length], ['Text', r => (r.text || '').slice(0, 160)]]);
  const det = document.createElement('details'), sum = document.createElement('summary'), pre = document.createElement('pre');
  sum.textContent = 'All counts + raw parsed JSON'; pre.textContent = JSON.stringify(p, null, 2); det.append(sum, pre); out.appendChild(det);
}
</script>
</body></html>`;
