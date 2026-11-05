// server.js — web server for LifeLine Agent.
const express = require('express');
const path = require('path');
const stellar = require('./stellar');
const agent = require('./agent');

const PORT = Number(process.env.PORT || 3000);
const app = express();
app.use(express.json({ limit: '6mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const wrap = (fn) => async (req, res) => {
  try { await fn(req, res); } catch (e) { res.status(400).json({ error: e.message }); }
};
const byId = (req) => {
  const r = agent.getRequest(req.params.id);
  if (!r) { const e = new Error('Request not found'); throw e; }
  return r;
};

// ---- dashboard state ----
app.get('/api/state', (req, res) => res.json(agent.snapshot()));

// ---- doctor ----
app.post('/api/requests', wrap(async (req, res) => {
  const r = await agent.createRequest(req.body);
  res.json({ id: r.id });
}));

// ---- family pay link (x402) ----
app.get('/pay/:token', (req, res) => res.sendFile(path.join(__dirname, 'public', 'pay.html')));
app.get('/api/pay/:id', wrap(async (req, res) => res.json(agent.familyView(byId(req)))));

// The x402-protected resource. No X-PAYMENT header -> HTTP 402 with payment requirements.
// With a valid X-PAYMENT header -> verify, settle on Stellar, return X-PAYMENT-RESPONSE.
app.post('/api/pay/:id/contribute', wrap(async (req, res) => {
  const r = byId(req);
  const amount = Math.round(Number(req.body.amount));
  const header = req.get('X-PAYMENT');
  if (!header) {
    return res.status(402).json({
      x402Version: 1,
      error: 'X-PAYMENT header is required',
      accepts: [agent.paymentRequirements(r, amount, `${req.protocol}://${req.get('host')}${req.originalUrl}`)],
    });
  }
  try {
    const settled = await agent.settleXPayment(r, header);
    res.set('X-PAYMENT-RESPONSE', Buffer.from(JSON.stringify(settled)).toString('base64'));
    res.json({ ok: true, settlement: settled, request: agent.familyView(r) });
  } catch (e) {
    res.status(402).json({ x402Version: 1, error: e.message, accepts: [agent.paymentRequirements(r, amount, req.originalUrl)] });
  }
}));

// SIMULATED Naira card / bank-transfer processor (stands in for Paystack/Flutterwave + an anchor).
app.post('/api/onramp/checkout', wrap(async (req, res) => {
  const r = agent.getRequest(req.body.requestId);
  if (!r) throw new Error('Request not found');
  await new Promise((ok) => setTimeout(ok, 600)); // feel like a real processor
  res.json(await agent.onrampCheckout(r, req.body));
}));

// ---- lab ----
app.post('/api/requests/:id/lab/start', wrap(async (req, res) => { agent.labStart(byId(req)); res.json({ ok: true }); }));
app.post('/api/requests/:id/lab/result', wrap(async (req, res) => { agent.labResult(byId(req), req.body); res.json({ ok: true }); }));
app.post('/api/requests/:id/lab/done', wrap(async (req, res) => { await agent.labDone(byId(req)); res.json({ ok: true }); }));
app.get('/api/requests/:id/lab/result-file', wrap(async (req, res) => {
  const f = agent.resultFile(byId(req));
  if (!f || !f.fileData) throw new Error('No file uploaded');
  const m = /^data:([^;]+);base64,(.*)$/.exec(f.fileData);
  res.type(m ? m[1] : 'application/octet-stream');
  res.set('Content-Disposition', `inline; filename="${(f.fileName || 'result').replace(/"/g, '')}"`);
  res.send(Buffer.from(m ? m[2] : '', 'base64'));
}));

// ---- donors ----
app.post('/api/donors', wrap(async (req, res) => res.json(agent.addDonor(req.body))));
app.post('/api/requests/:id/donors/rematch', wrap(async (req, res) => res.json(agent.matchDonors(byId(req)))));
app.post('/api/requests/:id/donors/:donorId/confirm', wrap(async (req, res) => {
  agent.confirmDonor(byId(req), req.params.donorId); res.json({ ok: true });
}));

// ---- discharge ----
app.post('/api/requests/:id/discharge/check', wrap(async (req, res) => res.json(agent.dischargeCheck(byId(req)))));
app.post('/api/requests/:id/discharge/plan', wrap(async (req, res) => res.json(agent.signPlan(byId(req), req.body))));
app.post('/api/reminders/run', wrap(async (req, res) => res.json({ sent: agent.runReminders({ force: true }) })));

// ---- demo ----
app.post('/api/demo/reset', wrap(async (req, res) => { agent.reset(); res.json({ ok: true }); }));

(async () => {
  const s = await stellar.init();
  console.log(`Stellar: ${s.mode.toUpperCase()}${s.reason ? ` — ${s.reason}` : ''}`);
  if (s.anchor) console.log(`LifeLine anchor account: ${s.anchor.publicKey()}`);
  agent.boot();
  setInterval(() => agent.runReminders(), 60 * 1000); // every minute: is any weekly reminder due?
  app.listen(PORT, () => console.log(`LifeLine Agent running at http://localhost:${PORT}`));
})();
