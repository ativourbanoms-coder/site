export const config = { runtime: 'nodejs' };

export default async function handler(req, res) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'RESEND_API_KEY ausente' });
    return;
  }

  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };

  const listRes = await fetch('https://api.resend.com/domains', { headers });
  const list = await listRes.json();
  let domain = (list.data || []).find((d) => d.name === 'ativourbano.com');

  if (!domain) {
    const createRes = await fetch('https://api.resend.com/domains', {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'ativourbano.com' }),
    });
    domain = await createRes.json();
    res.status(200).json({ created: true, domain });
    return;
  }

  const getRes = await fetch(`https://api.resend.com/domains/${domain.id}`, { headers });
  const full = await getRes.json();
  res.status(200).json({ created: false, domain: full });
}
