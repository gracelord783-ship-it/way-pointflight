// Minimal Flutterwave v3 client. The secret key is read from the environment on
// the server only; it is never sent to the browser.
const FLW_API = "https://api.flutterwave.com/v3";

export function flutterwaveConfigured() {
  return Boolean(process.env.FLW_SECRET_KEY);
}

async function flw<T>(path: string, init: RequestInit = {}): Promise<T> {
  const key = process.env.FLW_SECRET_KEY;
  if (!key) throw new Error("Flutterwave is not configured.");
  const response = await fetch(`${FLW_API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...(init.headers || {}) },
    signal: AbortSignal.timeout(15000),
  });
  const data = (await response.json().catch(() => ({}))) as T & { status?: string; message?: string };
  if (!response.ok || data.status !== "success") {
    console.error("Flutterwave error", response.status, data?.message);
    throw new Error("The payment provider could not process the request. Please try again.");
  }
  return data;
}

export async function createPaymentLink(input: {
  txRef: string;
  amountNaira: number;
  currency: string;
  redirectUrl: string;
  customer: { email: string; name: string };
  title: string;
  description: string;
}) {
  const data = await flw<{ data: { link: string } }>("/payments", {
    method: "POST",
    body: JSON.stringify({
      tx_ref: input.txRef,
      amount: input.amountNaira,
      currency: input.currency,
      redirect_url: input.redirectUrl,
      customer: input.customer,
      customizations: { title: input.title, description: input.description },
    }),
  });
  return data.data.link;
}

export type VerifiedTransaction = { id: number; tx_ref: string; status: string; amount: number; currency: string };

// Returns null when Flutterwave has no transaction for this reference yet
// (for example, the customer closed the checkout without paying).
export async function verifyByReference(txRef: string): Promise<VerifiedTransaction | null> {
  try {
    const data = await flw<{ data: VerifiedTransaction }>(`/transactions/verify_by_reference?tx_ref=${encodeURIComponent(txRef)}`);
    return data.data;
  } catch {
    return null;
  }
}

// Flutterwave sends the "secret hash" configured in its dashboard in the verif-hash header.
export function webhookHashValid(header: string | undefined) {
  const expected = process.env.FLW_SECRET_HASH;
  return Boolean(expected && header && header === expected);
}
