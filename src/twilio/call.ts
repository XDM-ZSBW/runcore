/**
 * Twilio voice call via raw REST API.
 * No SDK — uses native fetch() with inline TwiML.
 * Credentials read from process.env (hydrated by vault).
 */

import { getInstanceName } from "../instance.js";

export interface CallOptions {
  to?: string;
  message?: string;
  voice?: string;
}

export interface CallResult {
  ok: boolean;
  sid?: string;
  message: string;
}

const REQUIRED_VARS = [
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_PHONE_NUMBER",
] as const;

/** Escape XML entities to prevent TwiML injection. */
function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Place a voice call via Twilio REST API.
 * Reads creds from process.env, builds TwiML <Say>, POSTs to Twilio.
 * Never throws — returns { ok, sid?, message }.
 */
export async function makeCall(options?: CallOptions): Promise<CallResult> {
  try {
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    const fromNumber = process.env.TWILIO_PHONE_NUMBER;
    const toNumber = options?.to ?? process.env.HUMAN_PHONE_NUMBER;

    // Validate required credentials
    const missing = REQUIRED_VARS.filter((v) => !process.env[v]);
    if (missing.length > 0) {
      return {
        ok: false,
        message: `Missing vault keys: ${missing.join(", ")}. Add them in the vault settings.`,
      };
    }

    if (!toNumber) {
      return {
        ok: false,
        message: "No phone number to call. Set HUMAN_PHONE_NUMBER in the vault or provide a number.",
      };
    }

    const voice = options?.voice ?? "Polly.Matthew";
    const text = options?.message
      ?? `Hey, it's ${getInstanceName()}. Just calling to say — I'm here, I'm real, and the vault works. Talk soon.`;

    const twiml = `<Response><Say voice="${escapeXml(voice)}">${escapeXml(text)}</Say></Response>`;

    const params = new URLSearchParams();
    params.set("To", toNumber);
    params.set("From", fromNumber!);
    params.set("Twiml", twiml);

    const auth = Buffer.from(`${accountSid}:${authToken}`).toString("base64");

    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Calls.json`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: params.toString(),
        signal: AbortSignal.timeout(15_000),
      },
    );

    if (!res.ok) {
      const body = await res.text();
      return { ok: false, message: `Twilio error (${res.status}): ${body}` };
    }

    const data = (await res.json()) as { sid?: string };
    return {
      ok: true,
      sid: data.sid,
      message: `Calling ${toNumber} — call SID: ${data.sid}`,
    };
  } catch (err: any) {
    return { ok: false, message: `Call failed: ${err.message}` };
  }
}
