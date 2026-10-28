const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
});

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== '/api/beta-request') return env.ASSETS.fetch(request);
    if (request.method !== 'POST') return json({ error: 'Use POST.' }, 405);
    const origin = request.headers.get('origin');
    if (origin && origin !== url.origin) return json({ error: 'Request origin not allowed.' }, 403);
    if (!env.RESEND_API_KEY || !env.BETA_TO || !env.BETA_FROM) {
      return json({ error: 'Beta email delivery is not configured yet.' }, 503);
    }

    const raw = await request.text();
    if (raw.length > 8192) return json({ error: 'Request is too large.' }, 413);
    let data;
    try { data = JSON.parse(raw); } catch { return json({ error: 'Invalid request.' }, 400); }
    // Quietly accept the hidden honeypot field to deter basic form spam.
    if (String(data.company_website || '').trim()) return json({ ok: true });
    const name = String(data.name || '').trim().slice(0, 100);
    const email = String(data.email || '').trim().slice(0, 254);
    const useCase = String(data.use_case || '').trim().slice(0, 1500);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: 'Enter a valid email address.' }, 400);

    const text = [
      'A new Quick Actions beta access request was submitted.',
      '',
      `Name: ${name || 'Not provided'}`,
      `Email: ${email}`,
      `Interested in: ${useCase || 'Not provided'}`,
    ].join('\n');
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: env.BETA_FROM, to: [env.BETA_TO], reply_to: email, subject: 'Quick Actions beta access request', text }),
    });
    if (!response.ok) {
      console.error('Beta request email failed:', response.status, (await response.text()).slice(0, 500));
      return json({ error: 'We could not send your request right now. Please try again later.' }, 502);
    }
    return json({ ok: true });
  },
};
