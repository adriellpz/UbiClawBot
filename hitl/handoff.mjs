export async function hitlHandoff({
  liveUrl,
  jobContext,
  telegram,
  registry,
  domPoller,
  pollIntervalMs = 2000,
  pollTimeoutMs = 60_000,
}) {
  const { company, role } = jobContext;

  let externalResolve;
  const completionPromise = new Promise((res) => { externalResolve = res; });

  const n = registry.assign({ company, role, liveUrl, resolve: externalResolve });

  const msg = `HITL #${n}: ${company} / ${role} → ${liveUrl}`;
  await telegram.send(msg);

  const deadline = Date.now() + pollTimeoutMs;
  while (Date.now() < deadline) {
    const done = await domPoller();
    if (done) {
      registry.resolve(n);
      await completionPromise;
      return;
    }
    if (pollIntervalMs > 0) await sleep(pollIntervalMs);
  }

  await telegram.send(`⚠️ HITL #${n} still waiting — reply '${n} done' when finished`);
  await completionPromise;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
