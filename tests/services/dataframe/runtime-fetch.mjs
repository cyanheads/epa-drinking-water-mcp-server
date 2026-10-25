/** @fileoverview Synthetic outbound EPA boundary for the real stdio runtime. */
globalThis.fetch = async (input) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (
    url.origin !== 'https://data.epa.gov' ||
    !url.pathname.startsWith('/dmapservice/sdwis.violation/')
  )
    throw new Error(`Unexpected outbound request: ${url.href}`);
  return Response.json([
    { pwsid: 'WA1234567', violation_id: 'fixture-violation' },
    { pwsid: 'WA1234567', violation_id: 'second-violation' },
  ]);
};
