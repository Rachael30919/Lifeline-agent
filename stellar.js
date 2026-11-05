// stellar.js — all Stellar work happens here, on the server.
// Families never see Stellar. The server holds custodial keys for:
//   * the LifeLine "anchor" (issues a Naira token, NGN, 1 token = ₦1)
//   * one escrow account per emergency request
//   * one account per hospital
// If the Stellar testnet can't be reached, it falls back to SIMULATED mode
// (transactions are still built and signed for real, just not submitted).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  Horizon, Keypair, Asset, Operation, TransactionBuilder, Networks, Memo, Account, BASE_FEE,
} = require('@stellar/stellar-sdk');

const HORIZON_URL = process.env.HORIZON_URL || 'https://horizon-testnet.stellar.org';
const FRIENDBOT_URL = process.env.FRIENDBOT_URL || 'https://friendbot.stellar.org';
const PASSPHRASE = Networks.TESTNET;
const KEYS_FILE = path.join(__dirname, 'data', 'stellar-keys.json');

const server = new Horizon.Server(HORIZON_URL);
const state = { mode: 'starting', reason: '', anchor: null, asset: null };
let simSeq = 1000n;

// Every transaction from the anchor goes through one queue so sequence numbers never clash.
let queue = Promise.resolve();
function enqueue(fn) {
  const p = queue.then(fn, fn);
  queue = p.catch(() => {});
  return p;
}

function loadKeys() {
  try { return JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8')); } catch { return {}; }
}
function saveKeys(k) {
  fs.mkdirSync(path.dirname(KEYS_FILE), { recursive: true });
  fs.writeFileSync(KEYS_FILE, JSON.stringify(k, null, 2));
}
const keys = loadKeys();

const timeout = (p, ms, what) => Promise.race([
  p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} timed out`)), ms)),
]);

async function init() {
  if (!keys.anchor) { keys.anchor = Keypair.random().secret(); saveKeys(keys); }
  state.anchor = Keypair.fromSecret(keys.anchor);
  state.asset = new Asset('NGN', state.anchor.publicKey());

  if (process.env.STELLAR_MODE === 'simulated' || process.argv.includes('--simulated')) {
    state.mode = 'simulated'; state.reason = 'Started in simulated mode';
    return state;
  }
  try {
    try {
      await timeout(server.loadAccount(state.anchor.publicKey()), 10000, 'Horizon');
    } catch (e) {
      const notFound = e && (e.name === 'NotFoundError' || (e.response && e.response.status === 404));
      if (!notFound) throw e;
      // First run: fund the anchor account with free testnet XLM.
      const r = await timeout(fetch(`${FRIENDBOT_URL}?addr=${state.anchor.publicKey()}`), 30000, 'Friendbot');
      if (!r.ok) throw new Error(`Friendbot returned ${r.status}`);
    }
    state.mode = 'testnet';
  } catch (e) {
    state.mode = 'simulated';
    state.reason = `Stellar testnet unreachable (${e.message})`;
  }
  return state;
}

function status() {
  return {
    mode: state.mode,
    reason: state.reason,
    network: 'Stellar testnet',
    anchor: state.anchor && state.anchor.publicKey(),
    asset: state.asset && `NGN:${state.asset.getIssuer()}`,
  };
}

const live = () => state.mode === 'testnet';
const fakeHash = () => crypto.randomBytes(32).toString('hex');
const explorer = (hash) => (live() ? `https://stellar.expert/explorer/testnet/tx/${hash}` : null);
const fmt = (n) => Number(n).toFixed(7);

async function anchorAccount() {
  if (live()) return server.loadAccount(state.anchor.publicKey());
  simSeq += 1n;
  return new Account(state.anchor.publicKey(), simSeq.toString());
}

function describeError(e) {
  const codes = e && e.response && e.response.data && e.response.data.extras && e.response.data.extras.result_codes;
  return codes ? JSON.stringify(codes) : (e && e.message) || String(e);
}

// Create a custodial account (escrow or hospital) that can hold NGN tokens.
async function createCustodialAccount(memoText) {
  const kp = Keypair.random();
  if (!live()) {
    return { publicKey: kp.publicKey(), secret: kp.secret(), txHash: fakeHash(), simulated: true, explorer: null };
  }
  return enqueue(async () => {
    const acc = await anchorAccount();
    const tx = new TransactionBuilder(acc, { fee: BASE_FEE, networkPassphrase: PASSPHRASE })
      .addOperation(Operation.createAccount({ destination: kp.publicKey(), startingBalance: '3' }))
      .addOperation(Operation.changeTrust({ asset: state.asset, source: kp.publicKey() }))
      .addMemo(Memo.text(memoText.slice(0, 28)))
      .setTimeout(180)
      .build();
    tx.sign(state.anchor, kp);
    try {
      const res = await server.submitTransaction(tx);
      return { publicKey: kp.publicKey(), secret: kp.secret(), txHash: res.hash, simulated: false, explorer: explorer(res.hash) };
    } catch (e) { throw new Error(`Stellar createAccount failed: ${describeError(e)}`); }
  });
}

async function hospitalAccount(name) {
  keys.hospitals = keys.hospitals || {};
  const k = `${state.mode}:${name}`;
  if (!keys.hospitals[k]) {
    const acc = await createCustodialAccount(`LifeLine hospital`);
    keys.hospitals[k] = { publicKey: acc.publicKey, secret: acc.secret, txHash: acc.txHash };
    saveKeys(keys);
  }
  return keys.hospitals[k];
}

// x402 step 1 — the Naira on-ramp converts ₦ into NGN tokens by signing
// (not yet submitting) a payment from the anchor into the request's escrow.
async function buildDepositXdr({ escrow, amount, memo }) {
  const build = async () => {
    const acc = await anchorAccount();
    const tx = new TransactionBuilder(acc, { fee: BASE_FEE, networkPassphrase: PASSPHRASE })
      .addOperation(Operation.payment({ destination: escrow, asset: state.asset, amount: fmt(amount) }))
      .addMemo(Memo.text(memo.slice(0, 28)))
      .setTimeout(600)
      .build();
    tx.sign(state.anchor);
    return tx.toXDR();
  };
  return live() ? enqueue(build) : build();
}

// x402 step 2 — the facilitator checks the signed payment matches what was asked for.
function verifyDepositXdr(xdr, { escrow, amount }) {
  let tx;
  try { tx = TransactionBuilder.fromXDR(xdr, PASSPHRASE); } catch { return { ok: false, reason: 'Invalid transaction XDR' }; }
  const op = tx.operations && tx.operations[0];
  if (!op || op.type !== 'payment') return { ok: false, reason: 'Not a payment' };
  if (op.destination !== escrow) return { ok: false, reason: 'Payment is not going to this request\'s escrow' };
  if (op.asset.getCode() !== 'NGN' || op.asset.getIssuer() !== state.anchor.publicKey()) return { ok: false, reason: 'Wrong asset' };
  if (Number(op.amount) !== Number(amount)) return { ok: false, reason: 'Amount mismatch' };
  const hash = tx.hash();
  const signed = tx.signatures.some((s) => state.anchor.verify(hash, typeof s.signature === 'function' ? s.signature() : s.signature));
  if (!signed) return { ok: false, reason: 'Not signed by the LifeLine on-ramp' };
  return { ok: true, tx };
}

// x402 step 3 — settle: put the payment on the Stellar ledger.
async function settleDepositXdr(xdr, params) {
  const tx = TransactionBuilder.fromXDR(xdr, PASSPHRASE);
  if (!live()) return { txHash: Buffer.from(tx.hash()).toString('hex'), simulated: true, explorer: null };
  return enqueue(async () => {
    try {
      const res = await server.submitTransaction(tx);
      return { txHash: res.hash, simulated: false, explorer: explorer(res.hash) };
    } catch (e) {
      // If another payment used the sequence number first, rebuild once and retry.
      if (describeError(e).includes('tx_bad_seq')) {
        const acc = await anchorAccount();
        const again = new TransactionBuilder(acc, { fee: BASE_FEE, networkPassphrase: PASSPHRASE })
          .addOperation(Operation.payment({ destination: params.escrow, asset: state.asset, amount: fmt(params.amount) }))
          .addMemo(tx.memo)
          .setTimeout(180)
          .build();
        again.sign(state.anchor);
        const res = await server.submitTransaction(again);
        return { txHash: res.hash, simulated: false, explorer: explorer(res.hash) };
      }
      throw new Error(`Stellar settlement failed: ${describeError(e)}`);
    }
  });
}

// Release: escrow pays the hospital.
async function releaseFromEscrow({ escrowSecret, hospital, amount, memo }) {
  if (!live()) return { txHash: fakeHash(), simulated: true, explorer: null };
  const kp = Keypair.fromSecret(escrowSecret);
  try {
    const acc = await server.loadAccount(kp.publicKey());
    const tx = new TransactionBuilder(acc, { fee: BASE_FEE, networkPassphrase: PASSPHRASE })
      .addOperation(Operation.payment({ destination: hospital, asset: state.asset, amount: fmt(amount) }))
      .addMemo(Memo.text(memo.slice(0, 28)))
      .setTimeout(180)
      .build();
    tx.sign(kp);
    const res = await server.submitTransaction(tx);
    return { txHash: res.hash, simulated: false, explorer: explorer(res.hash) };
  } catch (e) { throw new Error(`Stellar release failed: ${describeError(e)}`); }
}

module.exports = {
  init, status, live, createCustodialAccount, hospitalAccount,
  buildDepositXdr, verifyDepositXdr, settleDepositXdr, releaseFromEscrow,
  accountExplorer: (pub) => (live() ? `https://stellar.expert/explorer/testnet/account/${pub}` : null),
};
