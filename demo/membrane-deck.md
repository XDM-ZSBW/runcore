# Your Data Stays Yours — Even When AI Doesn't

## The Privacy Membrane: protection by architecture, not policy

---

# The Problem

Every AI assistant sees everything you type.

Your phone number. Your address. Your SSN. Your medical records. Your passwords.

It all goes to the cloud. It all hits the model. It all becomes training data — or a breach waiting to happen.

**You shouldn't have to choose between AI and privacy.**

---

# What If the AI Never Saw Your Real Data?

The Privacy Membrane sits between you and the LLM.

It replaces sensitive values with typed placeholders before anything leaves your machine.

The AI works on the placeholders. Your real data never leaves.

When the response comes back, placeholders are restored — only for you.

---

# How It Works

**You type:**
> My phone number is 213-555-1212 and my email is bryant@herrmangroup.com

**The LLM sees:**
> My phone number is <<PHONE_0>> and my email is <<EMAIL_0>>

**The LLM responds:**
> Got it — I've noted <<PHONE_0>> and <<EMAIL_0>> for critical contacts.

**You see:**
> Got it — I've noted 213-555-1212 and bryant@herrmangroup.com for critical contacts.

The AI never knew. You never noticed.

---

# Privacy Seals: Blurred by Default

In the chat UI, detected sensitive data is automatically blurred.

Phone numbers, emails, SSNs, credit cards, addresses — all sealed on sight.

Not the whole message. Just the sensitive part.

**Hover to reveal.** Your data is there. It's just not on display.

*[Screenshot: 02-pii-blurred-chat.png]*

---

# Hover to Reveal

Move your mouse over a blurred value to see it.

Move away and it blurs again.

No toggle. No mode. No extra clicks. Just hover.

*[Screenshot: 03-pii-hover-reveal.png]*

---

# The Data Tab: Audit What the LLM Sees

The right-side Data tab shows the exact messages the LLM receives — after redaction.

Every placeholder. Every redaction count. In real time.

You don't trust that the membrane works. You verify.

*[Screenshot: 04-data-tab-redacted.png]*

---

# Multi-Pattern Detection

The membrane catches 27+ pattern types automatically:

**PII:** Phone, email, SSN, credit card, address, DOB, passport, driver's license

**PHI (HIPAA):** Medical record numbers, NPI, DEA numbers, Medicare/Medicaid IDs, prescription IDs, medical codes

**Credentials:** API keys, bearer tokens, AWS keys, private keys, GitHub tokens, Slack tokens

All detected by pattern. No configuration needed. No lists to maintain.

*[Screenshot: 05-multi-pii-blurred.png]*

---

# What Happened With the Address

We typed a real street address. The Data tab showed it redacted — <<ADDRESS_0>>.

But the LLM responded with full property details: bedrooms, price, school district.

**The membrane view was cosmetic. The real request went through unprotected.**

We found this by auditing the Data tab. We fixed it the same day.

The Data tab isn't decoration. It's your proof.

---

# The Fix: Direct Enforcement

Before (broken):
- Membrane preview showed redacted values (cosmetic)
- Actual request relied on a network intercept that silently failed
- LLM received real data

After (shipped):
- Membrane applies directly to the message array before streaming
- No network intercept dependency
- What the Data tab shows IS what the LLM gets

**The audit surface caught the gap. Architecture fixed it.**

---

# Three Layers of Protection

| Layer | What it does | Status |
|-------|-------------|--------|
| **Pattern** | Regex-based detection of 27+ PII/PHI/credential types | Shipped |
| **List** | CSV exact-match for names, org-specific terms | Roadmap |
| **NER** | Local ML model for natural language entities | Roadmap |

Pattern catches structured data (SSN, phone, card numbers).
List catches known values (employee names, internal project codes).
NER catches everything else (addresses in prose, medical conditions in sentences).

Each layer adds coverage. All three together close the gap.

---

# What This Means for You

**Use any AI model safely.** OpenRouter, Anthropic, OpenAI — the membrane protects the wire regardless of provider.

**Your data stays on your disk.** The brain is local. The membrane is local. The LLM gets sanitized fragments.

**Audit everything.** The Data tab shows what left your machine. No trust required.

**No configuration.** Privacy seals appear automatically. The membrane activates at startup. You type normally.

---

# Protection by Architecture

We don't ask providers to promise they won't train on your data.

We don't rely on terms of service or opt-out forms.

We make it architecturally impossible for the LLM to see your real data.

**That's the difference between policy and architecture.**

---

# Try It

```
npx runcore
```

Open your browser. Type a phone number. Watch it blur.

Open the Data tab. See what the LLM sees.

**Your data. Your machine. Your rules.**

runcore.sh
