/**
 * Transactional email through Resend, the sender DeepSpace's site already used when
 * RESEND_API_KEY was set. Failures log Resend's message, never the recipient.
 */
export function createResendSender(options: { apiKey: string; from: string; fetch?: typeof fetch }) {
  const fetcher = options.fetch ?? fetch;
  return async (message: { to: string; subject: string; text: string }): Promise<void> => {
    const res = await fetcher("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${options.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: options.from, ...message }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 300);
      console.error(`[site] resend send failed (${res.status}): ${detail}`);
      throw new Error("email send failed");
    }
  };
}
