// LifeLine Agent — dashboard (Doctor, Lab, Donors, Discharge, Messages).
let S = null;               // latest state from the server
let seenLog = new Set();
const ui = { labFilter: 'all', donorFilter: 'all', msgFilter: 'all', dischargeId: null, busy: false };

const $ = (s) => document.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const naira = (n) => '₦' + Math.round(Number(n || 0)).toLocaleString('en-NG');
const time = (t) => new Date(t).toLocaleString('en-NG', { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' });
const pct = (r) => Math.min(100, Math.round((r.paid / r.total) * 100));
const BLOOD = ['O+', 'O-', 'A+', 'A-', 'B+', 'B-', 'AB+', 'AB-'];

async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.style.display = 'block';
  clearTimeout(toast.h); toast.h = setTimeout(() => { t.style.display = 'none'; }, 3200);
}
async function act(fn, okMsg) {
  try { ui.busy = true; await fn(); if (okMsg) toast(okMsg); await refresh(); } catch (e) { toast('⚠ ' + e.message); } finally { ui.busy = false; }
}
function openModal(html) { $('#modal').innerHTML = html; $('#modalBg').classList.add('open'); }
function closeModal() { $('#modalBg').classList.remove('open'); }
$('#modalBg').addEventListener('click', (e) => { if (e.target.id === 'modalBg') closeModal(); });

// ---------- badges ----------
function payBadge(s) {
  const cls = { 'WAITING FOR PAYMENT': 'b-wait', 'DEPOSIT RECEIVED - START NOW': 'b-deposit', 'PAID - START NOW': 'b-paid', DONE: 'b-done' }[s] || 'b-none';
  return `<span class="badge ${cls}">${esc(s)}</span>`;
}
function escrowBadge(s) {
  const cls = { 'HELD IN ESCROW': 'b-escrow', 'RELEASED TO HOSPITAL': 'b-released' }[s] || 'b-none';
  return `<span class="badge ${cls}">${esc(s)}</span>`;
}
function workBadge(r) {
  const m = { WAITING: ['Not started', 'b-none'], STARTED: ['Test in progress', 'b-deposit'], 'RESULT UPLOADED': ['Result uploaded', 'b-paid'], DONE: ['DONE', 'b-done'] }[r.lab.status];
  return `<span class="badge ${m[1]}">${m[0]}</span>`;
}
function txLink(tx, label = 'View on Stellar') {
  if (!tx) return '';
  if (tx.explorer) return `<a href="${esc(tx.explorer)}" target="_blank" rel="noopener">${label} ↗</a>`;
  if (tx.txHash) return `<span class="badge b-sim" title="Signed Stellar transaction ${esc(tx.txHash)} (not submitted: simulated mode)">SIMULATED TX ${esc(tx.txHash.slice(0, 8))}…</span>`;
  return '';
}
function progress(r) {
  return `<div class="progress"><span style="width:${pct(r)}%"></span></div>
    <div class="row spread small" style="margin-top:.3rem"><span><span class="money">${naira(r.paid)}</span> paid of ${naira(r.total)}</span><span class="muted">${pct(r)}% · balance ${naira(r.balance)}</span></div>`;
}

// ---------- header + feed ----------
function renderHeader() {
  const st = S.stellar;
  const stellarPill = st.mode === 'testnet'
    ? '<span class="pill live" title="Escrow and payments are real Stellar testnet transactions">STELLAR TESTNET · LIVE</span>'
    : `<span class="pill sim" title="${esc(st.reason)}">STELLAR · SIMULATED</span>`;
  $('#pills').innerHTML = `${stellarPill}<span class="pill sim" title="No real card or bank charged">NAIRA CARD/TRANSFER · SIMULATED</span><span class="pill sim" title="Messages are shown on screen, not really sent">SMS & ALERTS · SIMULATED</span>`;
}
function renderFeed() {
  const items = S.log.slice(0, 60).map((l) => {
    const fresh = seenLog.size && !seenLog.has(l.id);
    return `<div class="feed-item ${fresh ? 'new' : ''}">
      <div class="t">${time(l.at)}${l.requestId ? ` · <a href="#case/${esc(l.requestId)}">${esc(l.requestId)}</a>` : ''}</div>
      <div>${esc(l.text)}</div>${l.tx ? `<div class="small">${txLink(l.tx)}</div>` : ''}</div>`;
  }).join('');
  S.log.forEach((l) => seenLog.add(l.id));
  $('#feed').innerHTML = items || '<div class="empty">Nothing yet.</div>';
}

// ---------- views ----------
const views = {};
const demoCase = () => S.requests.find((r) => !r.seeded);

views.guide = {
  render: () => `<div class="card"><div class="section-title"><div><h2>Demo Day walkthrough</h2>
      <div class="muted">Click through the whole story: a patient who would have been told "pay first" gets treated right away.</div></div></div>
      <div id="guideCase"></div><div class="steps" id="steps"></div></div>
    <div class="card"><h3>Sample cases already in the system</h3><div class="grid g3" id="guideSamples"></div></div>`,
  update() {
    const r = demoCase();
    const blood = r && r.bloodGroup;
    const steps = [
      ['Doctor creates the emergency request', 'Patient, hospital, family phone, what is needed, blood group, total in Naira.', !!r, `<a class="btn small" href="#doctor">Open Doctor form</a>`],
      ['Family pays with the link', 'Small-small, by card or transfer. Share the link so relatives chip in.', r && r.paid > 0, r ? `<a class="btn small" href="${esc(r.payLink)}" target="_blank">Open family pay link ↗</a>` : ''],
      ['Lab starts immediately', 'Money is held in escrow, so the lab is told START NOW.', r && r.lab.status !== 'WAITING', `<a class="btn small" href="#lab">Open Lab dashboard</a>`],
      ['Blood donor matched', blood ? `Agent alerted nearby ${esc(r.bloodGroup)} donors. Confirm one who replied YES.` : 'Needs a blood group on the request.', r && (blood ? r.donors.some((d) => d.status === 'CONFIRMED') : r.paid > 0), `<a class="btn small" href="#donors">See matched donors</a>`],
      ['Treatment done', 'Lab uploads the result and marks DONE.', r && r.lab.status === 'DONE', `<a class="btn small" href="#lab">Open Lab dashboard</a>`],
      ['Money released to hospital', 'Agent moves the escrow money to the hospital on Stellar.', r && r.escrow.status === 'RELEASED TO HOSPITAL', r ? `<a class="btn small" href="#case/${esc(r.id)}">Open case file</a>` : ''],
      ['Discharge code given', 'Balance zero: code + Safe To Release. Otherwise: payment plan.', r && !!(r.discharge.code || r.discharge.planCode), r ? `<a class="btn small" href="#discharge/${esc(r.id)}">Open Discharge</a>` : `<a class="btn small" href="#discharge">Open Discharge</a>`],
    ];
    const next = steps.findIndex((s) => !s[2]);
    $('#guideCase').innerHTML = r
      ? `<div class="req" onclick="location.hash='#case/${esc(r.id)}'" style="margin-bottom:1rem"><div class="row spread"><strong>Live demo case: ${esc(r.id)} · ${esc(r.patientName)}</strong>${payBadge(r.labStatus)}</div><div class="small muted" style="margin:.2rem 0 .5rem">${esc(r.hospitalShort)} · ${esc(r.need)}</div>${progress(r)}</div>`
      : `<div class="banner">Start with step 1. Tip: on the Doctor form, press <b>Fill demo patient</b>.</div>`;
    $('#steps').innerHTML = steps.map((s, i) => `<div class="step ${s[2] ? 'done' : ''} ${i === next ? 'next' : ''}">
        <div class="n">${s[2] ? '✓' : i + 1}</div><div><strong>${s[0]}</strong><div class="small muted">${s[1]}</div></div><div>${s[3]}</div></div>`).join('');
    $('#guideSamples').innerHTML = S.requests.filter((x) => x.seeded).map(caseCard).join('') || '<div class="empty">Loading…</div>';
  },
};

function caseCard(r) {
  return `<div class="req" onclick="location.hash='#case/${esc(r.id)}'">
    <div class="row spread"><strong>${esc(r.id)} · ${esc(r.patientName)}</strong></div>
    <div class="small muted" style="margin:.15rem 0 .5rem">${esc(r.hospitalShort)} · ${esc(r.need)}</div>
    ${progress(r)}<div class="row" style="margin-top:.5rem;gap:.35rem">${payBadge(r.labStatus)}${escrowBadge(r.escrow.status)}</div></div>`;
}

views.doctor = {
  render: () => `<div class="grid g2">
    <div class="card"><div class="section-title"><h2>New emergency request</h2><button class="btn small ghost" id="fillDemo" type="button">Fill demo patient</button></div>
      <form id="docForm">
        <div class="field"><label>Doctor</label><input name="doctor" placeholder="Dr. ..." required></div>
        <div class="field"><label>Patient name</label><input name="patientName" required></div>
        <div class="field"><label>Hospital</label><input name="hospital" list="hospitalList" required><datalist id="hospitalList">${S.hospitals.map((h) => `<option value="${esc(h)}">`).join('')}</datalist></div>
        <div class="field"><label>Family phone number</label><input name="familyPhone" type="tel" placeholder="0803 000 0000" required></div>
        <div class="field"><label>Test or blood needed</label><input name="need" placeholder="e.g. 2 pints of blood + crossmatch" required></div>
        <div class="grid g2" style="gap:.8rem">
          <div class="field"><label>Blood group needed</label><select name="bloodGroup"><option value="">None</option>${BLOOD.map((b) => `<option>${b}</option>`).join('')}</select></div>
          <div class="field"><label>Total amount (₦)</label><input name="total" type="number" min="100" step="100" required></div>
        </div>
        <button class="btn big" id="docSubmit" style="width:100%;justify-content:center">Create request · hand over to Agent</button>
      </form></div>
    <div class="card"><h3>What happens when you press the button</h3>
      <ol class="small" style="padding-left:1.1rem;margin:0">
        <li>The Agent opens a <b>Stellar escrow account</b> just for this patient.</li>
        <li>It makes an <b>x402 payment link</b> and texts it to the family.</li>
        <li>The lab sees the request as <b>WAITING FOR PAYMENT</b>.</li>
        <li>If blood is needed, it finds <b>matching donors nearby</b> and alerts them.</li>
      </ol>
      <h3 style="margin-top:1.2rem">Requests</h3><div class="grid" id="docList"></div></div></div>`,
  mount() {
    $('#fillDemo').onclick = () => {
      const f = $('#docForm');
      Object.entries({ doctor: 'Dr. Kelechi Obi', patientName: 'Chinedu Okafor', hospital: S.hospitals[0], familyPhone: '0803 555 0199', need: '2 pints of blood + crossmatch for emergency surgery', bloodGroup: 'O+', total: 85000 })
        .forEach(([k, v]) => { f.elements[k].value = v; });
    };
    $('#docForm').onsubmit = async (e) => {
      e.preventDefault();
      const btn = $('#docSubmit'); btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span> Agent is opening escrow on Stellar…';
      try {
        const body = Object.fromEntries(new FormData(e.target).entries());
        const { id } = await api('/api/requests', body);
        toast(`${id} created. The Agent has taken over.`);
        await refresh(); location.hash = `#case/${id}`;
      } catch (err) { toast('⚠ ' + err.message); btn.disabled = false; btn.textContent = 'Create request · hand over to Agent'; }
    };
  },
  update() { $('#docList').innerHTML = S.requests.slice(0, 6).map(caseCard).join(''); },
};

views.case = {
  render: () => '<div id="caseBody"></div>',
  update(id) {
    const r = S.requests.find((x) => x.id === id);
    if (!r) { $('#caseBody').innerHTML = '<div class="card empty">Case not found.</div>'; return; }
    const share = encodeURIComponent(`Please help pay for ${r.patientName}'s treatment at ${r.hospitalShort}. Any amount helps: ${r.payLink}`);
    const logs = S.log.filter((l) => l.requestId === r.id);
    $('#caseBody').innerHTML = `
      <div class="card"><div class="row spread"><div><div class="muted small">${esc(r.id)} · created by ${esc(r.doctor)} · ${time(r.createdAt)}</div>
        <h2>${esc(r.patientName)}</h2><div>${esc(r.hospital)}</div><div class="muted">${esc(r.need)}${r.bloodGroup ? ` · <b>${esc(r.bloodGroup)}</b> blood` : ''}</div></div>
        <div class="row">${payBadge(r.labStatus)}${escrowBadge(r.escrow.status)}</div></div>
        <div style="margin-top:1rem">${progress(r)}</div></div>
      <div class="grid g2" style="margin-top:1rem">
        <div class="card"><h3>Family pay link (x402)</h3>
          <div class="mono" style="margin-bottom:.6rem">${esc(r.payLink)}</div>
          <div class="row"><a class="btn small" href="${esc(r.payLink)}" target="_blank">Open as family ↗</a>
          <button class="btn small ghost" onclick="navigator.clipboard.writeText('${esc(r.payLink)}').then(()=>toast('Link copied'))">Copy link</button>
          <a class="btn small ghost" href="https://wa.me/?text=${share}" target="_blank">Share on WhatsApp</a></div>
          <h3 style="margin-top:1rem">Contributions (${r.payments.length})</h3>
          ${r.payments.length ? `<table><tbody>${r.payments.map((p) => `<tr><td>${esc(p.payerName)}<div class="small muted">${esc(p.method)} · ${time(p.at)}</div></td><td class="money">${naira(p.amount)}</td><td class="small">${txLink(p)}</td></tr>`).join('')}</tbody></table>` : '<div class="muted small">No payments yet.</div>'}
        </div>
        <div class="card"><h3>Escrow on Stellar</h3>
          <div style="margin-bottom:.6rem">${escrowBadge(r.escrow.status)}</div>
          <dl class="kv"><dt>Held now</dt><dd class="money">${naira(r.escrow.held)}</dd>
            <dt>Released</dt><dd class="money">${naira(r.escrow.released)}</dd>
            <dt>Escrow account</dt><dd class="mono">${esc(r.escrow.publicKey || '…')}${r.escrow.explorer ? ` <a href="${esc(r.escrow.explorer)}" target="_blank">↗</a>` : ''}</dd>
            <dt>Opened</dt><dd class="small">${txLink({ txHash: r.escrow.openTx, explorer: r.escrow.openExplorer })}</dd>
            ${r.escrow.releases.map((x) => `<dt>Release</dt><dd class="small">${naira(x.amount)} → hospital (${esc(x.why)}) ${txLink(x)}</dd>`).join('')}</dl>
          <p class="small muted" style="margin-bottom:0">Families pay in Naira. The Agent converts it to a Naira token (NGN) on Stellar and locks it in this account. Only the Agent can release it, and only after the lab marks the work DONE.</p>
        </div>
        <div class="card"><h3>Lab</h3><div class="row" style="margin-bottom:.6rem">${payBadge(r.labStatus)} ${workBadge(r)}</div>
          ${labButtons(r)}
          ${r.lab.result ? `<div class="small" style="margin-top:.7rem"><b>Result:</b> ${esc(r.lab.result.note)} ${r.lab.result.fileData ? `<a href="/api/requests/${esc(r.id)}/lab/result-file" target="_blank">${esc(r.lab.result.fileName || 'file')}</a>` : ''}</div>` : ''}</div>
        <div class="card"><h3>Blood donors</h3>${r.bloodGroup ? donorMatches(r) : '<div class="muted small">No blood requested.</div>'}</div>
        <div class="card"><h3>Discharge</h3>${dischargeSummary(r)}<div style="margin-top:.6rem"><a class="btn small" href="#discharge/${esc(r.id)}">Go to discharge</a></div></div>
        <div class="card"><h3>Agent log for this case</h3>${logs.map((l) => `<div class="feed-item"><div class="t">${time(l.at)}</div>${esc(l.text)} ${l.tx ? `<div class="small">${txLink(l.tx)}</div>` : ''}</div>`).join('')}</div>
      </div>`;
  },
};

function labButtons(r) {
  const can = r.paid > 0;
  return `<div class="row" style="gap:.4rem">
    <button class="btn small" ${can && r.lab.status === 'WAITING' ? '' : 'disabled'} onclick="labStart('${r.id}')">Start test</button>
    <button class="btn small ghost" ${['STARTED', 'RESULT UPLOADED'].includes(r.lab.status) ? '' : 'disabled'} onclick="labResultModal('${r.id}')">Upload result</button>
    <button class="btn small red" ${['STARTED', 'RESULT UPLOADED'].includes(r.lab.status) ? '' : 'disabled'} onclick="labDone('${r.id}')">Mark DONE</button></div>
    ${!can ? '<div class="small muted" style="margin-top:.4rem">Waiting for the first payment. The lab can start as soon as any deposit lands in escrow.</div>' : ''}`;
}
window.labStart = (id) => act(() => api(`/api/requests/${id}/lab/start`, {}), 'Test started');
window.labDone = (id) => {
  if (!confirm(`Mark ${id} as DONE? The Agent will release the escrow money to the hospital.`)) return;
  act(async () => { toast('Agent is releasing escrow on Stellar…'); await api(`/api/requests/${id}/lab/done`, {}); }, 'DONE. Escrow released to hospital.');
};
window.labResultModal = (id) => {
  openModal(`<h3>Upload result · ${esc(id)}</h3>
    <div class="field"><label>Result summary</label><textarea id="resNote" rows="3" placeholder="e.g. Crossmatch compatible. Hb 9.2 g/dL."></textarea></div>
    <div class="field"><label>Result file (PDF or photo, optional)</label><input type="file" id="resFile" accept="image/*,application/pdf"></div>
    <div class="row"><button class="btn" id="resSave">Upload</button><button class="btn ghost" onclick="closeModal()">Cancel</button></div>`);
  $('#resSave').onclick = async () => {
    const f = $('#resFile').files[0];
    let fileData = null;
    if (f) {
      if (f.size > 4 * 1024 * 1024) return toast('File too big (max 4 MB)');
      fileData = await new Promise((ok) => { const rd = new FileReader(); rd.onload = () => ok(rd.result); rd.readAsDataURL(f); });
    }
    const note = $('#resNote').value;
    closeModal();
    act(() => api(`/api/requests/${id}/lab/result`, { note, fileName: f && f.name, fileData }), 'Result uploaded');
  };
};

function donorMatches(r) {
  if (!r.donors.length) return `<div class="muted small">No ${esc(r.bloodGroup)} donors within 15 km yet.</div>`;
  return `<div class="small muted" style="margin-bottom:.4rem">Agent showed only <b>${esc(r.bloodGroup)}</b> donors near ${esc(r.hospitalShort)} and sent each an alert.</div>
    <table><tbody>${r.donors.map((m) => `<tr><td><b>${esc(m.donor.name)}</b><div class="small muted">${esc(m.donor.area)} · ${m.km} km · ${esc(m.donor.phone)}</div></td>
      <td><span class="badge b-red">${esc(m.donor.bloodGroup)}</span></td>
      <td>${m.status === 'CONFIRMED' ? '<span class="badge b-done">CONFIRMED · ON THE WAY</span>' : `<span class="badge b-wait">ALERT SENT</span> <button class="btn small ghost" onclick="confirmDonor('${r.id}','${m.donorId}')">Donor said YES</button>`}</td></tr>`).join('')}</tbody></table>`;
}
window.confirmDonor = (id, d) => act(() => api(`/api/requests/${id}/donors/${d}/confirm`, {}), 'Donor confirmed');

function dischargeSummary(r) {
  const d = r.discharge;
  if (d.code) return `<span class="badge b-done">SAFE TO RELEASE</span> <span class="mono">${esc(d.code)}</span>`;
  if (d.planCode) return `<span class="badge b-wait">RELEASED ON PAYMENT PLAN</span> <span class="mono">${esc(d.planCode)}</span><div class="small muted">${naira(d.plan.weekly)}/week · ${d.plan.reminders} reminder(s) sent · balance ${naira(r.balance)}</div>`;
  if (d.status === 'NO CODE - Payment Incomplete') return `<span class="badge b-red">NO CODE - Payment Incomplete</span>`;
  return '<span class="muted small">Not checked yet.</span>';
}

views.lab = {
  render: () => `<div class="card"><div class="section-title"><div><h2>Lab dashboard</h2><div class="muted small">Every request, with what the lab should do now.</div></div>
    <div class="chips" id="labChips"></div></div><div class="table-wrap"><table><thead><tr><th>Patient</th><th>Payment</th><th>Status for lab</th><th>Escrow</th><th>Actions</th></tr></thead><tbody id="labRows"></tbody></table></div></div>`,
  update() {
    const f = ui.labFilter;
    $('#labChips').innerHTML = [['all', 'All'], ['action', 'Start now'], ['waiting', 'Waiting for payment'], ['done', 'Done']]
      .map(([k, l]) => `<button class="chip ${f === k ? 'on' : ''}" onclick="ui.labFilter='${k}';views.lab.update()">${l}</button>`).join('');
    const rows = S.requests.filter((r) => f === 'all'
      || (f === 'action' && r.paid > 0 && r.lab.status !== 'DONE')
      || (f === 'waiting' && r.paid === 0) || (f === 'done' && r.lab.status === 'DONE'));
    $('#labRows').innerHTML = rows.map((r) => `<tr>
      <td><a href="#case/${esc(r.id)}"><b>${esc(r.patientName)}</b></a><div class="small muted">${esc(r.id)} · ${esc(r.hospitalShort)}</div><div class="small">${esc(r.need)}${r.bloodGroup ? ` · <b>${esc(r.bloodGroup)}</b>` : ''}</div></td>
      <td style="min-width:170px">${progress(r)}</td>
      <td>${payBadge(r.labStatus)}${r.lab.status === 'DONE' ? '' : `<div style="margin-top:.3rem">${workBadge(r)}</div>`}</td>
      <td>${escrowBadge(r.escrow.status)}</td>
      <td style="min-width:200px">${labButtons(r)}</td></tr>`).join('') || '<tr><td colspan="5" class="empty">Nothing here.</td></tr>';
  },
};

views.donors = {
  render: () => `<div class="card"><h2>Donors matched to patients</h2><div class="muted small" style="margin-bottom:.8rem">The Agent filters the register by the exact blood group needed and by distance from the hospital (15 km).</div><div id="matches"></div></div>
    <div class="grid g2" style="margin-top:1rem"><div class="card"><div class="section-title"><h3>Donor register</h3><div class="chips" id="donorChips"></div></div><div id="register"></div></div>
    <div class="card"><h3>Add a donor</h3><form id="donorForm">
      <div class="field"><label>Name</label><input name="name" required></div>
      <div class="grid g2" style="gap:.8rem"><div class="field"><label>Blood group</label><select name="bloodGroup">${BLOOD.map((b) => `<option>${b}</option>`).join('')}</select></div>
      <div class="field"><label>Area (Lagos)</label><select name="area">${['Yaba', 'Surulere', 'Ikeja', 'Lekki', 'Ikoyi', 'Mushin', 'Gbagada', 'Ajah', 'Victoria Island', 'Oshodi', 'Ikorodu', 'Festac', 'Maryland', 'Ebute-Metta', 'Ogba'].map((a) => `<option>${a}</option>`).join('')}</select></div></div>
      <div class="field"><label>Phone</label><input name="phone" type="tel"></div>
      <button class="btn">Add donor</button></form></div></div>`,
  mount() {
    $('#donorForm').onsubmit = (e) => {
      e.preventDefault();
      const body = Object.fromEntries(new FormData(e.target).entries());
      act(() => api('/api/donors', body), 'Donor added').then(() => e.target.reset());
    };
  },
  update() {
    const withBlood = S.requests.filter((r) => r.bloodGroup);
    $('#matches').innerHTML = withBlood.map((r) => `<div style="margin-bottom:1rem"><div class="row spread"><a href="#case/${esc(r.id)}"><b>${esc(r.id)} · ${esc(r.patientName)}</b></a><span>needs <span class="badge b-red">${esc(r.bloodGroup)}</span> at ${esc(r.hospitalShort)}</span></div>${donorMatches(r)}</div>`).join('') || '<div class="empty">No request needs blood yet.</div>';
    const f = ui.donorFilter;
    $('#donorChips').innerHTML = ['all', ...BLOOD].map((b) => `<button class="chip ${f === b ? 'on' : ''}" onclick="ui.donorFilter='${b}';views.donors.update()">${b === 'all' ? 'All' : b}</button>`).join('');
    const list = S.donors.filter((d) => f === 'all' || d.bloodGroup === f);
    $('#register').innerHTML = `<table><tbody>${list.map((d) => `<tr><td><b>${esc(d.name)}</b><div class="small muted">${esc(d.area)} · ${esc(d.phone)}</div></td><td><span class="badge b-red">${esc(d.bloodGroup)}</span></td><td class="small muted">${d.lastDonated ? 'last gave ' + esc(d.lastDonated) : ''}</td></tr>`).join('')}</tbody></table>`;
  },
};

views.discharge = {
  render: () => `<div class="grid g2"><div class="card"><h2>Discharge desk</h2><div class="muted small" style="margin-bottom:.8rem">Pick a patient. The Agent checks the balance before anyone leaves.</div><div class="grid" id="disList"></div></div>
    <div><div class="card" id="disDetail"></div>
    <div class="card"><div class="section-title"><h3>Payment plans & weekly reminders</h3><button class="btn small ghost" onclick="act(()=>api('/api/reminders/run',{}),'Weekly reminders sent')">Send this week's reminders now</button></div><div id="plans"></div></div></div></div>`,
  update(id) {
    if (id) ui.dischargeId = id;
    if (!ui.dischargeId && S.requests[0]) ui.dischargeId = (demoCase() || S.requests[0]).id;
    $('#disList').innerHTML = S.requests.map((r) => `<div class="req" style="${r.id === ui.dischargeId ? 'border-color:var(--brand);box-shadow:0 0 0 3px var(--brand-soft)' : ''}" onclick="location.hash='#discharge/${esc(r.id)}'">
      <div class="row spread"><b>${esc(r.id)} · ${esc(r.patientName)}</b><span class="small">balance <b>${naira(r.balance)}</b></span></div><div style="margin-top:.3rem">${dischargeSummary(r)}</div></div>`).join('');
    const r = S.requests.find((x) => x.id === ui.dischargeId);
    if (!r) { $('#disDetail').innerHTML = '<div class="empty">No patient selected.</div>'; } else {
      const d = r.discharge;
      let result = '';
      if (d.code) result = `<div class="big-status ok"><div class="small">DISCHARGE CODE</div><div class="code">${esc(d.code)}</div><div style="font-weight:800;font-size:1.2rem">✓ SAFE TO RELEASE</div><div class="small">Balance ₦0</div></div>`;
      else if (d.planCode) result = `<div class="big-status plan"><div class="small">RELEASED ON PAYMENT PLAN</div><div class="code" style="font-size:1.5rem">${esc(d.planCode)}</div><div class="small">Signed by ${esc(d.plan.signedBy)} · ${naira(d.plan.weekly)}/week · balance ${naira(r.balance)}</div></div>`;
      else if (d.status === 'NO CODE - Payment Incomplete') result = `<div class="big-status no"><div style="font-weight:900;font-size:1.3rem">✕ NO CODE - Payment Incomplete</div><div>${naira(r.balance)} is still owed.</div>
        <button class="btn" style="margin-top:.8rem" onclick="planModal('${r.id}')">Sign a payment plan to be released</button></div>`;
      $('#disDetail').innerHTML = `<div class="row spread"><div><h3>${esc(r.patientName)}</h3><div class="small muted">${esc(r.id)} · ${esc(r.hospitalShort)}</div></div>${workBadge(r)}</div>
        <div style="margin:.8rem 0">${progress(r)}</div>
        <button class="btn big" style="width:100%;justify-content:center;margin-bottom:1rem" onclick="act(()=>api('/api/requests/${r.id}/discharge/check',{}))">Agent: check payment & discharge</button>${result}`;
    }
    const plans = S.requests.filter((x) => x.discharge.plan);
    $('#plans').innerHTML = plans.map((x) => {
      const p = x.discharge.plan;
      return `<div class="feed-item"><div class="row spread"><b>${esc(x.id)} · ${esc(x.patientName)}</b>${x.balance === 0 ? '<span class="badge b-done">PAID OFF</span>' : `<span class="badge b-wait">${naira(x.balance)} left</span>`}</div>
        <div class="small muted">${naira(p.weekly)}/week · ${p.reminders} reminder(s) sent · next ${x.balance === 0 ? '—' : time(p.nextReminderAt)} · patient ${esc(p.patientPhone || '—')}, family ${esc(x.familyPhone)}</div></div>`;
    }).join('') || '<div class="muted small">No payment plans yet.</div>';
  },
};
window.planModal = (id) => {
  const r = S.requests.find((x) => x.id === id);
  openModal(`<h3>Payment plan · ${esc(r.patientName)}</h3><p class="small muted">Balance ${naira(r.balance)}. The Agent will text patient and family every week until it is paid.</p>
    <div class="field"><label>Weekly amount (₦)</label><input id="plWeekly" type="number" value="${Math.max(1000, Math.ceil(r.balance / 4 / 1000) * 1000)}"></div>
    <div class="field"><label>Patient phone</label><input id="plPhone" type="tel" placeholder="0815 000 0000"></div>
    <div class="field"><label>Patient signature (type full name)</label><input id="plSign" value="${esc(r.patientName)}" style="font-family:'Segoe Script','Brush Script MT',cursive;font-size:1.2rem"></div>
    <label class="small" style="font-weight:500"><input type="checkbox" id="plAgree" style="width:auto"> I agree to pay the balance weekly as above.</label>
    <div class="row" style="margin-top:1rem"><button class="btn" id="plSave">Sign & release</button><button class="btn ghost" onclick="closeModal()">Cancel</button></div>`);
  $('#plSave').onclick = () => {
    if (!$('#plAgree').checked) return toast('Tick the agreement box');
    const body = { weekly: $('#plWeekly').value, patientPhone: $('#plPhone').value, signedBy: $('#plSign').value };
    closeModal(); act(() => api(`/api/requests/${id}/discharge/plan`, body), 'Plan signed. Patient released.');
  };
};

views.messages = {
  render: () => `<div class="card"><div class="section-title"><div><h2>Messages the Agent sent</h2><div class="muted small">Simulated outbox: in production these go out by SMS/WhatsApp.</div></div><div class="chips" id="msgChips"></div></div><div id="msgs"></div></div>`,
  update() {
    const f = ui.msgFilter;
    $('#msgChips').innerHTML = [['all', 'All'], ['SMS', 'Family & patient SMS'], ['Lab alert', 'Lab alerts'], ['Donor alert', 'Donor alerts'], ['Lab dashboard', 'Hospital']]
      .map(([k, l]) => `<button class="chip ${f === k ? 'on' : ''}" onclick="ui.msgFilter='${k}';views.messages.update()">${l}</button>`).join('');
    $('#msgs').innerHTML = S.messages.filter((m) => f === 'all' || m.channel === f).map((m) => `<div class="msg"><div class="head"><span><span class="ch ch-${esc(m.channel.replace(/ /g, '-'))}">${esc(m.channel)}</span> to <b>${esc(m.toLabel)}</b> ${esc(m.to)}</span><span>${m.requestId ? esc(m.requestId) + ' · ' : ''}${time(m.at)}</span></div>${esc(m.text)}</div>`).join('') || '<div class="empty">No messages.</div>';
  },
};

// ---------- routing + polling ----------
let current = null;
function route() {
  const [name, arg] = (location.hash.slice(1) || 'guide').split('/');
  const v = views[name] ? name : 'guide';
  document.querySelectorAll('#tabs a').forEach((a) => a.classList.toggle('active', a.getAttribute('href') === `#${v}`));
  current = { v, arg };
  $('#main').innerHTML = (S.seeding ? '<div class="banner"><span class="spinner dark"></span> Loading sample cases' + (S.stellar.mode === 'testnet' ? ' on the Stellar testnet (about a minute)…' : '…') + '</div>' : '') + views[v].render();
  views[v].mount && views[v].mount();
  views[v].update(arg);
  window.scrollTo(0, 0);
}
async function refresh() {
  const prevSeeding = S && S.seeding;
  S = await api('/api/state');
  renderHeader(); renderFeed();
  if (!current || prevSeeding !== S.seeding) return route();
  views[current.v].update(current.arg);
}
window.addEventListener('hashchange', route);
$('#resetBtn').onclick = () => { if (confirm('Reset all demo data?')) act(async () => { await api('/api/demo/reset', {}); seenLog = new Set(); location.hash = '#guide'; }, 'Demo reset'); };

(async function start() {
  await refresh();
  setInterval(() => { if (!ui.busy && !$('#modalBg').classList.contains('open')) refresh().catch(() => {}); }, 2500);
})();
