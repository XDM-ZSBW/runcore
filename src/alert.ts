/**
 * Outbound alerting for Core MCP — email via Resend, SMS via Twilio.
 * Uses raw HTTP fetch (no SDK dependencies).
 */

export interface AlertResult {
  sent: boolean;
  channel: "email" | "sms";
  error?: string;
}

/** Send an email via Resend API. */
export async function sendEmail(
  subject: string,
  body: string,
): Promise<AlertResult> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.CORE_ALERT_EMAIL_FROM;
  const to = process.env.CORE_ALERT_EMAIL_TO;

  if (!apiKey || !from || !to) {
    return { sent: false, channel: "email", error: "Missing RESEND_API_KEY, CORE_ALERT_EMAIL_FROM, or CORE_ALERT_EMAIL_TO" };
  }

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from, to: [to], subject, text: body }),
    });

    if (!res.ok) {
      const text = await res.text();
      return { sent: false, channel: "email", error: `Resend ${res.status}: ${text}` };
    }
    return { sent: true, channel: "email" };
  } catch (err) {
    return { sent: false, channel: "email", error: String(err) };
  }
}

/** Send an SMS via Twilio API. */
export async function sendSms(
  message: string,
  toNumber?: string,
): Promise<AlertResult> {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_WHATSAPP_NUMBER; // reuse as SMS sender
  const to = toNumber ?? process.env.BRIEFING_SMS_TO?.split(",")[0]?.trim();

  if (!sid || !token || !from || !to) {
    return { sent: false, channel: "sms", error: "Missing TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_WHATSAPP_NUMBER, or BRIEFING_SMS_TO" };
  }

  try {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`;
    const params = new URLSearchParams({ From: from, To: to, Body: message });
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": "Basic " + Buffer.from(`${sid}:${token}`).toString("base64"),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });

    if (!res.ok) {
      const text = await res.text();
      return { sent: false, channel: "sms", error: `Twilio ${res.status}: ${text}` };
    }
    return { sent: true, channel: "sms" };
  } catch (err) {
    return { sent: false, channel: "sms", error: String(err) };
  }
}

/** Send alert via all available channels. Returns results for each attempt. */
export async function sendAlert(
  subject: string,
  body: string,
): Promise<AlertResult[]> {
  const results: AlertResult[] = [];

  // Try email first (more detail), then SMS (faster)
  results.push(await sendEmail(subject, body));
  results.push(await sendSms(`[Core] ${subject}: ${body.slice(0, 140)}`));

  return results;
}
