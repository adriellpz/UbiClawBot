const ALLOWED_FROM = /adriellpz@gmail\.com/i;

/** Skip Gmail hook agent runs unless the sender is adriellpz@gmail.com. */
export default function gmailFromAdrielOnly(ctx) {
  const from = ctx?.payload?.messages?.[0]?.from ?? "";
  if (!ALLOWED_FROM.test(from)) return null;
}
