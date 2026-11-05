# LifeLine Agent

**Treat first. The Agent holds the money.**

LifeLine Agent helps patients in Nigeria who are told "pay first before we touch you".
A doctor raises an emergency request, the family pays any amount in Naira through a shared link,
the money is locked in a Stellar escrow, the lab is told to start right away, blood donors are
alerted, and the hospital is paid automatically when the work is done.

## Run it

You need Node.js 18 or newer.

```bash
npm install
npm start            # tries the Stellar testnet, falls back to simulated if it can't reach it
# or
npm run start:simulated   # force offline mode (good backup for Demo Day Wi-Fi)
```

Open http://localhost:3000 and follow the **Demo guide** tab.

The first time it runs on the testnet it funds its own account with Friendbot and loads the sample
cases (about a minute; a banner shows while it loads). Press **Reset demo** to start clean.

Settings (environment variables, all optional): `PORT` (default 3000), `PUBLIC_URL` (the address
put in pay links, e.g. an ngrok URL so phones can open them), `HORIZON_URL`.

To let people open the pay link on their phones during the demo, expose the app, e.g.
`npx ngrok http 3000`, then restart with the ngrok address:

```powershell
# Windows PowerShell
$env:PUBLIC_URL="https://<your-ngrok-host>"; npm start
```
```bash
# macOS / Linux
PUBLIC_URL=https://<your-ngrok-host> npm start
```

## What is real and what is simulated

| Part | Status |
|---|---|
| Stellar escrow + money movement | **Real on Stellar testnet** when reachable (header shows `STELLAR TESTNET · LIVE` and every step links to stellar.expert). Falls back to **simulated** (transactions are still built and signed, just not submitted) when offline. |
| x402 pay link | **Real protocol flow**: HTTP 402 → payment requirements → `X-PAYMENT` header → verify → settle on Stellar → `X-PAYMENT-RESPONSE`. Hand-built for Stellar (no official x402 Stellar SDK used). |
| Naira card / bank transfer | **Simulated.** No card is charged. In production this is Paystack/Flutterwave plus a licensed NGN anchor. |
| SMS / WhatsApp / lab and donor alerts | **Simulated.** Shown in the "Messages sent" tab. |
| Weekly reminders | Real timer (checks every minute, sends once a week). The "Send this week's reminders now" button fast-forwards for the demo. |
| Data | Saved in `data/db.json`. Custodial testnet keys in `data/stellar-keys.json` (testnet only, never use for real money). |

## How the money moves

1. One **LifeLine anchor** account issues a Naira token, `NGN` (1 NGN token = ₦1).
2. Each request gets its **own escrow account** (created and funded by the anchor, with an NGN trustline).
3. When a family member pays in Naira, the on-ramp signs a Stellar payment of NGN tokens from the anchor
   into that escrow. That signed transaction is the x402 payment. The Agent verifies and submits it.
4. When the lab marks the work **DONE**, the Agent pays everything in escrow to the **hospital's account**.
   Payments made later (on a payment plan) go to escrow and are forwarded to the hospital straight away.

Families never see Stellar: no wallet, no account, no crypto. The server holds all keys (custodial).

## What the Agent does at each step (simple English)

**1. Doctor creates the request.** The doctor types the patient's name, hospital, family phone,
what test or blood is needed, the blood group and the total in Naira. From here the Agent takes over.

**2. Agent sets up the bill.** It opens a locked savings box (escrow) on Stellar just for this
patient. It makes a payment link and texts it to the family. The lab now sees the patient as
**WAITING FOR PAYMENT**.

**3. Agent finds blood.** If blood is needed, say O+, the Agent looks through the donor list, keeps
only O+ donors within 15 km of the hospital, closest first, and sends each one an urgent alert.
When a donor replies YES, the Agent tells the lab and the family that a donor is coming.

**4. Family pays, small-small.** Anyone with the link can pay any amount, by card or transfer, in
Naira. Mum can pay ₦30,000 now, an uncle ₦20,000 later, until it's full. The progress bar fills up
and everybody can see who has paid.

**5. Agent holds the money.** The money does not go to the hospital yet. The Agent locks it in the
escrow box and shows **HELD IN ESCROW**. This protects the family: the hospital only gets it after
the work is done.

**6. Agent tells the lab to start now.** The moment the first naira lands, the Agent alerts the lab:
**DEPOSIT RECEIVED - START NOW**. When the full amount is in: **PAID - START NOW**. Nobody waits for
the whole bill before treatment starts.

**7. Lab works.** The lab presses Start test, uploads the result, and when treatment is finished,
marks it **DONE**.

**8. Agent pays the hospital.** As soon as the lab says DONE, the Agent moves the money from escrow
to the hospital and shows **RELEASED TO HOSPITAL**, with a Stellar receipt anyone can check.

**9. Agent checks before discharge.** If the balance is ₦0, the Agent gives a **Discharge Code** and
says **SAFE TO RELEASE**. If money is still owed it says **NO CODE - Payment Incomplete**, and offers a
payment plan. The patient signs it, gets a release code and goes home.

**10. Agent follows up.** Every week the Agent texts the patient and family how much is due and the
link to pay. When the last naira is paid, it issues the final discharge code and stops the reminders.

## Project layout

- `server.js` web server and the x402 endpoint
- `agent.js` everything the Agent decides and does
- `stellar.js` all Stellar work (accounts, escrow, verify/settle, release)
- `seed-data.js` hospitals, donor register and sample cases
- `public/` dashboard (`index.html`, `app.js`) and family pay page (`pay.html`)
