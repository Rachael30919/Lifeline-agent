// agent.js — the LifeLine Agent. Every decision the Agent makes lives here.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const stellar = require('./stellar');
const { HOSPITALS, DONORS, SEED_REQUESTS } = require('./seed-data');

const DB_FILE = path.join(__dirname, 'data', 'db.json');
const NEARBY_KM = 15;
const WEEK_MS = 7 * 24 * 3600 * 1000;
let PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 3000}`;

let db = null;

// ---------- helpers ----------
const now = () => new Date().toISOString();
const uid = () => crypto.randomBytes(6).toString('hex');
const naira = (n) => `₦${Math.round(Number(n)).toLocaleString('en-NG')}`;
const code = (prefix) => `${prefix}-${crypto.randomBytes(2).toString('hex').toUpperCase()}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
const firstName = (s) => String(s).trim().split(/\s+/)[0];

function save() {
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}
function load() {
  try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); return true; } catch { return false; }
}

function log(r, text, tx) {
  db.log.unshift({ id: uid(), at: now(), requestId: r ? r.id : null, text, tx: tx || null });
  db.log = db.log.slice(0, 400);
}
// Outbox — SMS / WhatsApp / alerts. SIMULATED: shown on screen, not really sent.
function send(r, channel, to, toLabel, text) {
  db.messages.unshift({ id: uid(), at: now(), requestId: r ? r.id : null, channel, to, toLabel, text });
  db.messages = db.messages.slice(0, 400);
}

function distanceKm(a, b) {
  const R = 6371, rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function findHospital(name) {
  const n = String(name).toLowerCase();
  return HOSPITALS.find((h) => h.name.toLowerCase() === n || n.includes(h.short.toLowerCase()))
    || { name, short: name, lat: 6.5244, lng: 3.3792 }; // unknown hospital: centre of Lagos
}

const getRequest = (id) => db.requests.find((r) => r.id === id || r.token === id);
const payLink = (r) => `${PUBLIC_URL}/pay/${r.token}`;
const balance = (r) => Math.max(0, r.total - r.paid);

function paymentStatus(r) {
  if (r.paid <= 0) return 'WAITING FOR PAYMENT';
  if (r.paid < r.total) return 'DEPOSIT RECEIVED - START NOW';
  return 'PAID - START NOW';
}
function labStatus(r) {
  if (r.lab.status === 'DONE') return 'DONE';
  return paymentStatus(r);
}

// ---------- Step 1: doctor creates a request; the Agent takes over ----------
async function createRequest(input) {
  const total = Math.round(Number(input.total));
  const required = ['patientName', 'hospital', 'familyPhone', 'need'];
  for (const k of required) if (!String(input[k] || '').trim()) throw new Error(`Please fill in ${k}`);
  if (!(total > 0)) throw new Error('Total amount must be more than ₦0');

  const hospital = findHospital(input.hospital);
  const r = {
    id: `LL-${db.counter++}`,
    token: crypto.randomBytes(5).toString('hex'),
    createdAt: now(),
    doctor: String(input.doctor || 'Duty doctor').trim(),
    patientName: input.patientName.trim(),
    hospital: hospital.name,
    hospitalShort: hospital.short,
    hospitalGeo: { lat: hospital.lat, lng: hospital.lng },
    familyPhone: input.familyPhone.trim(),
    need: input.need.trim(),
    bloodGroup: String(input.bloodGroup || '').trim().toUpperCase(),
    total,
    paid: 0,
    payments: [],
    escrow: { status: 'NO FUNDS YET', held: 0, released: 0, releases: [] },
    lab: { status: 'WAITING', events: [] },
    donors: [],
    discharge: { status: 'NOT CHECKED' },
  };
  db.requests.unshift(r);
  log(r, `Doctor ${r.doctor} created emergency request for ${r.patientName} at ${r.hospitalShort}: ${r.need}, ${naira(total)}.`);

  // Open a dedicated escrow vault on Stellar for this patient.
  const esc = await stellar.createCustodialAccount(`LifeLine escrow ${r.id}`);
  Object.assign(r.escrow, { publicKey: esc.publicKey, secret: esc.secret, openTx: esc.txHash, simulated: esc.simulated, openExplorer: esc.explorer });
  log(r, `Opened a Stellar escrow account for ${r.id}. Money paid will be held here, not sent to the hospital yet.`, esc);

  // Make the x402 pay link and send it to the family.
  log(r, `Created x402 payment link ${payLink(r)}.`);
  send(r, 'SMS', r.familyPhone, 'Family',
    `LifeLine: ${r.patientName} needs ${r.need} at ${r.hospitalShort}. Total ${naira(total)}. `
    + `Pay any amount (card or transfer) and share this link with family: ${payLink(r)}`);
  log(r, `Sent the pay link to the family on ${r.familyPhone}.`);

  // Lab sees it immediately as waiting.
  send(r, 'Lab dashboard', r.hospitalShort, 'Lab', `New request ${r.id} (${r.patientName}): ${r.need}. Status: WAITING FOR PAYMENT.`);

  if (r.bloodGroup) matchDonors(r);
  save();
  return r;
}

// ---------- Step 4: find donors ----------
function matchDonors(r) {
  const matches = db.donors
    .filter((d) => d.bloodGroup === r.bloodGroup)
    .map((d) => ({ donorId: d.id, km: Math.round(distanceKm(r.hospitalGeo, d) * 10) / 10 }))
    .filter((m) => m.km <= NEARBY_KM)
    .sort((a, b) => a.km - b.km);
  r.donors = matches.map((m) => ({ ...m, status: 'ALERTED', alertedAt: now() }));
  for (const m of matches) {
    const d = db.donors.find((x) => x.id === m.donorId);
    send(r, 'Donor alert', d.phone, d.name,
      `URGENT: ${r.bloodGroup} blood needed at ${r.hospitalShort} (${m.km} km from you) for patient ${firstName(r.patientName)}. Reply YES if you can donate today.`);
  }
  log(r, matches.length
    ? `Patient needs ${r.bloodGroup}. Found ${matches.length} ${r.bloodGroup} donor(s) within ${NEARBY_KM} km and sent each an alert.`
    : `Patient needs ${r.bloodGroup}. No ${r.bloodGroup} donors within ${NEARBY_KM} km yet. Will keep looking.`);
  return r.donors;
}

function confirmDonor(r, donorId) {
  const m = r.donors.find((x) => x.donorId === donorId);
  if (!m) throw new Error('Donor not matched to this request');
  m.status = 'CONFIRMED'; m.confirmedAt = now();
  const d = db.donors.find((x) => x.id === donorId);
  log(r, `${d.name} (${d.bloodGroup}) confirmed and is on the way to ${r.hospitalShort}.`);
  send(r, 'Lab dashboard', r.hospitalShort, 'Lab', `Donor ${d.name} (${d.bloodGroup}) confirmed for ${r.id}. Expect them shortly.`);
  send(r, 'SMS', r.familyPhone, 'Family', `Good news: a ${d.bloodGroup} blood donor (${firstName(d.name)}) is on the way for ${firstName(r.patientName)}.`);
  save();
}

function addDonor(input) {
  const { AREAS } = require('./seed-data');
  const area = AREAS[input.area] ? input.area : 'Yaba';
  const d = {
    id: `D${String(db.donors.length + 1).padStart(3, '0')}`, name: String(input.name || '').trim(),
    bloodGroup: String(input.bloodGroup || '').toUpperCase(), area, phone: String(input.phone || '').trim(),
    lat: AREAS[area][0], lng: AREAS[area][1], lastDonated: input.lastDonated || '',
  };
  if (!d.name || !d.bloodGroup) throw new Error('Name and blood group are required');
  db.donors.push(d);
  save();
  return d;
}

// ---------- Step 2: family pays (x402) ----------
// What the pay link asks for, in x402 terms.
function paymentRequirements(r, amount, resource) {
  return {
    scheme: 'exact',
    network: 'stellar-testnet',
    maxAmountRequired: Number(amount).toFixed(7),
    resource,
    description: `Contribution to ${r.id} (${r.patientName}) at ${r.hospitalShort}`,
    mimeType: 'application/json',
    payTo: r.escrow.publicKey,
    maxTimeoutSeconds: 600,
    asset: stellar.status().asset,
    extra: {
      currency: 'NGN', decimals: 7, balanceDue: balance(r),
      onramp: { url: '/api/onramp/checkout', methods: ['card', 'transfer'], simulated: true },
    },
  };
}

// Naira on-ramp (SIMULATED card/transfer processor). After "collecting" Naira it
// signs a Stellar payment of NGN tokens into escrow and returns it as an x402 X-PAYMENT.
async function onrampCheckout(r, { amount, method, payerName }) {
  amount = Math.round(Number(amount));
  if (!(amount > 0)) throw new Error('Enter an amount');
  if (amount > balance(r)) throw new Error(`Only ${naira(balance(r))} is left to pay`);
  const receiptId = `${method === 'card' ? 'CARD' : 'TRF'}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
  const xdr = await stellar.buildDepositXdr({ escrow: r.escrow.publicKey, amount, memo: `${r.id} ${receiptId}` });
  const payload = {
    x402Version: 1, scheme: 'exact', network: 'stellar-testnet',
    payload: { transaction: xdr, receiptId, payerName: String(payerName || 'Family member').slice(0, 60), method, amount },
  };
  return { receiptId, xPayment: Buffer.from(JSON.stringify(payload)).toString('base64') };
}

async function settleXPayment(r, header) {
  let p;
  try { p = JSON.parse(Buffer.from(header, 'base64').toString('utf8')); } catch { throw new Error('Bad X-PAYMENT header'); }
  const { transaction, receiptId, payerName, method, amount } = p.payload || {};
  if (r.payments.some((x) => x.receiptId === receiptId)) throw new Error('This payment was already used');
  if (amount > balance(r)) throw new Error(`Only ${naira(balance(r))} is left to pay`);
  const check = stellar.verifyDepositXdr(transaction, { escrow: r.escrow.publicKey, amount });
  if (!check.ok) throw new Error(`Payment rejected: ${check.reason}`);
  const tx = await stellar.settleDepositXdr(transaction, { escrow: r.escrow.publicKey, amount });
  await recordPayment(r, { payerName, method, amount, receiptId, tx });
  return { success: true, transaction: tx.txHash, network: 'stellar-testnet', payer: payerName, explorer: tx.explorer, simulated: tx.simulated };
}

async function recordPayment(r, { payerName, method, amount, receiptId, tx }) {
  const before = paymentStatus(r);
  r.payments.push({ id: uid(), at: now(), payerName, method, amount, receiptId, txHash: tx.txHash, explorer: tx.explorer, simulated: tx.simulated });
  r.paid += amount;
  r.escrow.held += amount;
  r.escrow.status = 'HELD IN ESCROW';
  log(r, `${payerName} paid ${naira(amount)} by ${method}. Converted to NGN tokens and locked in escrow. Paid ${naira(r.paid)} of ${naira(r.total)}.`, tx);

  const after = paymentStatus(r);
  if (after !== before && r.lab.status !== 'DONE') {
    // Step 3: tell the lab to start immediately.
    send(r, 'Lab alert', r.hospitalShort, 'Lab',
      `${after}: ${r.id} ${r.patientName}. ${naira(r.paid)} is safely in escrow. Begin ${r.need} now. Do not wait.`);
    log(r, `Alerted the lab: ${after}.`);
  }
  send(r, 'SMS', r.familyPhone, 'Family', `LifeLine: received ${naira(amount)} from ${payerName}. Paid ${naira(r.paid)} of ${naira(r.total)}. Balance ${naira(balance(r))}.`);
  if (r.discharge.plan && r.discharge.plan.patientPhone) {
    send(r, 'SMS', r.discharge.plan.patientPhone, 'Patient', `LifeLine: payment of ${naira(amount)} received. Balance ${naira(balance(r))}.`);
  }

  // Treatment already finished? Then this money goes straight on to the hospital.
  if (r.lab.status === 'DONE') await releaseEscrow(r, 'late payment');
  if (balance(r) === 0 && r.discharge.plan && !r.discharge.code) {
    r.discharge.code = code('DC');
    r.discharge.status = 'SAFE TO RELEASE';
    r.discharge.plan.completedAt = now();
    log(r, `Payment plan completed. Issued discharge code ${r.discharge.code}. Weekly reminders stopped.`);
    send(r, 'SMS', r.familyPhone, 'Family', `LifeLine: ${r.patientName}'s bill is fully paid. Thank you! Final code ${r.discharge.code}.`);
  }
  save();
}

// ---------- Step 3/5: lab work ----------
function labStart(r) {
  if (r.paid <= 0) throw new Error('No money in escrow yet');
  if (r.lab.status !== 'WAITING') throw new Error('Test already started');
  r.lab.status = 'STARTED'; r.lab.startedAt = now();
  r.lab.events.push({ at: now(), text: 'Test started' });
  log(r, `Lab started ${r.need} for ${r.patientName}.`);
  send(r, 'SMS', r.familyPhone, 'Family', `LifeLine: the lab has started on ${firstName(r.patientName)}. Treatment is underway.`);
  save();
}

function labResult(r, { note, fileName, fileData }) {
  if (r.lab.status === 'WAITING') throw new Error('Start the test first');
  r.lab.result = { note: String(note || '').trim(), fileName: fileName || null, fileData: fileData || null, at: now() };
  if (r.lab.status === 'STARTED') r.lab.status = 'RESULT UPLOADED';
  r.lab.events.push({ at: now(), text: `Result uploaded${fileName ? ` (${fileName})` : ''}` });
  log(r, `Lab uploaded the result for ${r.id}${fileName ? `: ${fileName}` : ''}.`);
  send(r, 'SMS', r.familyPhone, 'Family', `LifeLine: results for ${firstName(r.patientName)} are ready. The doctor will explain them.`);
  save();
}

async function labDone(r) {
  if (r.lab.status === 'WAITING') throw new Error('Start the test first');
  if (r.lab.status === 'DONE') throw new Error('Already done');
  r.lab.status = 'DONE'; r.lab.doneAt = now();
  r.lab.events.push({ at: now(), text: 'Treatment marked DONE' });
  log(r, `Lab marked treatment DONE for ${r.id}.`);
  await releaseEscrow(r, 'treatment done');
  save();
}

// ---------- Step 6: release escrow to the hospital ----------
async function releaseEscrow(r, why) {
  const amount = r.escrow.held;
  if (amount <= 0) return null;
  const hospital = await stellar.hospitalAccount(r.hospital);
  const tx = await stellar.releaseFromEscrow({ escrowSecret: r.escrow.secret, hospital: hospital.publicKey, amount, memo: `${r.id} release` });
  r.escrow.held = 0;
  r.escrow.released += amount;
  r.escrow.status = 'RELEASED TO HOSPITAL';
  r.escrow.hospitalAccount = hospital.publicKey;
  r.escrow.releases.push({ at: now(), amount, txHash: tx.txHash, explorer: tx.explorer, simulated: tx.simulated, why });
  log(r, `Released ${naira(amount)} from escrow to ${r.hospitalShort} (${why}).`, tx);
  send(r, 'Lab dashboard', r.hospitalShort, 'Hospital accounts', `${naira(amount)} for ${r.id} has been released to your account.`);
  return tx;
}

// ---------- Step 7: discharge ----------
function dischargeCheck(r) {
  const bal = balance(r);
  r.discharge.checkedAt = now();
  if (bal === 0) {
    if (!r.discharge.code) {
      r.discharge.code = code('DC');
      log(r, `Discharge check: balance is ₦0. Issued discharge code ${r.discharge.code}. SAFE TO RELEASE.`);
      send(r, 'SMS', r.familyPhone, 'Family', `LifeLine: ${r.patientName} is cleared to go home. Discharge code ${r.discharge.code}.`);
    }
    r.discharge.status = 'SAFE TO RELEASE';
  } else if (r.discharge.plan) {
    r.discharge.status = 'RELEASED ON PAYMENT PLAN';
  } else {
    r.discharge.status = 'NO CODE - Payment Incomplete';
    log(r, `Discharge check: ${naira(bal)} still owed. NO CODE. Offered a payment plan.`);
  }
  save();
  return { status: r.discharge.status, code: r.discharge.code || null, balance: bal };
}

function signPlan(r, { signedBy, patientPhone, weekly }) {
  const bal = balance(r);
  weekly = Math.round(Number(weekly));
  if (bal === 0) throw new Error('Nothing owed, no plan needed');
  if (!String(signedBy || '').trim()) throw new Error('Patient must sign (type full name)');
  if (!(weekly > 0)) throw new Error('Enter a weekly amount');
  const weeks = Math.ceil(bal / weekly);
  r.discharge.plan = {
    signedBy: signedBy.trim(), patientPhone: String(patientPhone || '').trim(), weekly, weeks,
    balanceAtSigning: bal, signedAt: now(), nextReminderAt: new Date(Date.now() + WEEK_MS).toISOString(), reminders: 0,
  };
  r.discharge.planCode = code('PLAN');
  r.discharge.status = 'RELEASED ON PAYMENT PLAN';
  log(r, `${signedBy} signed a payment plan: ${naira(weekly)} per week for ${weeks} week(s). Issued release code ${r.discharge.planCode}. Weekly reminders scheduled.`);
  const msg = `LifeLine: ${r.patientName} released on a payment plan. ${naira(weekly)} weekly, ${naira(bal)} left. Pay anytime: ${payLink(r)}`;
  if (r.discharge.plan.patientPhone) send(r, 'SMS', r.discharge.plan.patientPhone, 'Patient', msg);
  send(r, 'SMS', r.familyPhone, 'Family', msg);
  save();
  return r.discharge;
}

// Weekly reminders. Runs on a timer; the "Send this week's reminders" button forces one round for the demo.
function runReminders({ force = false } = {}) {
  let sent = 0;
  for (const r of db.requests) {
    const p = r.discharge.plan;
    if (!p || balance(r) === 0) continue;
    if (!force && new Date(p.nextReminderAt) > new Date()) continue;
    p.reminders += 1;
    p.nextReminderAt = new Date(Date.now() + WEEK_MS).toISOString();
    const due = Math.min(p.weekly, balance(r));
    const text = `LifeLine reminder (week ${p.reminders}): ${naira(due)} is due for ${r.patientName}'s bill at ${r.hospitalShort}. Balance ${naira(balance(r))}. Pay: ${payLink(r)}`;
    if (p.patientPhone) send(r, 'SMS', p.patientPhone, 'Patient', text);
    send(r, 'SMS', r.familyPhone, 'Family', text);
    log(r, `Sent weekly reminder #${p.reminders} to patient and family (${naira(due)} due).`);
    sent += 1;
  }
  if (sent) save();
  return sent;
}

// ---------- state for the UI ----------
function publicRequest(r) {
  const { escrow, lab, ...rest } = r;
  const { secret, ...esc } = escrow;
  const { result, ...labRest } = lab;
  return {
    ...rest,
    escrow: { ...esc, explorer: esc.publicKey ? stellar.accountExplorer(esc.publicKey) : null },
    lab: { ...labRest, result: result ? { ...result, fileData: result.fileData ? 'yes' : null } : null },
    payLink: payLink(r), balance: balance(r), paymentStatus: paymentStatus(r), labStatus: labStatus(r),
    donors: r.donors.map((m) => ({ ...m, donor: db.donors.find((d) => d.id === m.donorId) })),
  };
}

function familyView(r) {
  return {
    id: r.id, patientName: r.patientName, hospital: r.hospitalShort, need: r.need, bloodGroup: r.bloodGroup,
    total: r.total, paid: r.paid, balance: balance(r), escrowStatus: r.escrow.status, labStatus: r.lab.status,
    payments: r.payments.map((p) => ({ at: p.at, payerName: p.payerName, amount: p.amount, method: p.method })),
    donorsAlerted: r.donors.length, donorsConfirmed: r.donors.filter((d) => d.status === 'CONFIRMED').length,
  };
}

function snapshot() {
  return {
    stellar: stellar.status(),
    simulated: { onramp: true, sms: true, stellar: !stellar.live() },
    seeding: db.seeding || false,
    requests: db.requests.map(publicRequest),
    donors: db.donors,
    messages: db.messages.slice(0, 150),
    log: db.log.slice(0, 150),
    hospitals: HOSPITALS.map((h) => h.name),
  };
}

// ---------- demo data ----------
async function reset() {
  db = { counter: 1001, mode: stellar.status().mode, requests: [], donors: DONORS.map((d) => ({ ...d })), messages: [], log: [], seeding: true };
  log(null, 'Demo data reset. Loading the donor register and sample cases.');
  save();
  try {
    for (const s of SEED_REQUESTS) {
      const r = await createRequest(s.input);
      r.seeded = true;
      for (const [payerName, amount, method] of s.payments) {
        const { xPayment } = await onrampCheckout(r, { amount, method, payerName });
        await settleXPayment(r, xPayment);
      }
      if (s.labStart) labStart(r);
      if (s.labResult) labResult(r, { note: s.labResult });
      if (s.labDone) await labDone(r);
      if (r.donors.length) confirmDonor(r, r.donors[0].donorId);
      if (s.discharge === 'code') dischargeCheck(r);
      else if (s.discharge) { dischargeCheck(r); signPlan(r, s.discharge); runReminders({ force: true }); }
    }
    log(null, 'Sample cases ready. Create a new request on the Doctor screen to run the live demo.');
  } catch (e) {
    log(null, `Problem while loading sample cases: ${e.message}`);
  }
  db.seeding = false;
  save();
}

function boot() {
  // Fresh start, or the Stellar mode changed (simulated vs testnet): rebuild demo data.
  if (!load() || db.seeding || db.mode !== stellar.status().mode) reset(); // runs in the background
}

module.exports = {
  boot, reset, snapshot, getRequest, createRequest, confirmDonor, addDonor, matchDonors,
  paymentRequirements, onrampCheckout, settleXPayment, familyView,
  labStart, labResult, labDone, dischargeCheck, signPlan, runReminders,
  resultFile: (r) => r.lab.result,
  setPublicUrl: (u) => { PUBLIC_URL = u; },
};
