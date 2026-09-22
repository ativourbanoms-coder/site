export const config = { runtime: 'nodejs' };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_LEN = { nome: 120, email: 200, tel: 40, empreen: 120 };

// Rate limit best-effort (em memória, por instância de função — não é forte
// contra ataques distribuídos com IPs/e-mails diferentes, mas barra o abuso
// trivial de repetir o mesmo IP ou o mesmo e-mail).
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 5;
const hits = new Map();

function isRateLimited(ip) {
  const now = Date.now();
  const entry = hits.get(ip);
  if (!entry || now - entry.start > RATE_LIMIT_WINDOW_MS) {
    hits.set(ip, { start: now, count: 1 });
    return false;
  }
  entry.count += 1;
  return entry.count > RATE_LIMIT_MAX;
}

// 1 envio por e-mail dentro da janela abaixo, e nunca dois envios do mesmo
// e-mail em paralelo (evita double-submit/replay disparando 2 e-mails antes
// do primeiro terminar).
const EMAIL_LIMIT_WINDOW_MS = 24 * 60 * 60 * 1000; // 24h
const emailState = new Map(); // email -> { lastSent: number, pending: boolean }

function claimEmailSlot(email) {
  const now = Date.now();
  const state = emailState.get(email);

  if (state?.pending) {
    return 'pending';
  }
  if (state && now - state.lastSent < EMAIL_LIMIT_WINDOW_MS) {
    return 'limited';
  }

  emailState.set(email, { lastSent: state?.lastSent ?? 0, pending: true });
  return 'ok';
}

function releaseEmailSlot(email, sent) {
  const state = emailState.get(email);
  if (!state) return;
  if (sent) {
    emailState.set(email, { lastSent: Date.now(), pending: false });
  } else {
    // Falha no envio: não conta contra o limite, libera para nova tentativa.
    emailState.delete(email);
  }
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || 'unknown';
  if (isRateLimited(ip)) {
    res.status(429).json({ error: 'Muitas tentativas. Aguarde um instante e tente de novo.' });
    return;
  }

  const { nome, email, tel, empreen } = req.body || {};

  if (!nome || !email) {
    res.status(400).json({ error: 'Nome e e-mail são obrigatórios.' });
    return;
  }

  if (!EMAIL_RE.test(String(email)) || String(email).length > MAX_LEN.email) {
    res.status(400).json({ error: 'E-mail inválido.' });
    return;
  }

  if (
    String(nome).length > MAX_LEN.nome ||
    (tel && String(tel).length > MAX_LEN.tel) ||
    (empreen && String(empreen).length > MAX_LEN.empreen)
  ) {
    res.status(400).json({ error: 'Um dos campos excede o tamanho permitido.' });
    return;
  }

  const normalizedEmail = String(email).trim().toLowerCase();
  const slot = claimEmailSlot(normalizedEmail);
  if (slot === 'pending') {
    res.status(409).json({ error: 'Já existe um envio em andamento para este e-mail.' });
    return;
  }
  if (slot === 'limited') {
    res.status(429).json({ error: 'Este e-mail já enviou o formulário recentemente. Tente novamente mais tarde.' });
    return;
  }

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    releaseEmailSlot(normalizedEmail, false);
    res.status(500).json({ error: 'Configuração de e-mail ausente.' });
    return;
  }

  try {
    const resendRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'Ativo Urbano <formulario@ativourbano.com>',
        to: ['contato@ativourbano.com'],
        reply_to: email,
        subject: `Novo lead: ${String(nome).replace(/[\r\n]+/g, ' ')}`,
        html: `
          <p><strong>Nome:</strong> ${escapeHtml(nome)}</p>
          <p><strong>E-mail:</strong> ${escapeHtml(email)}</p>
          <p><strong>Telefone:</strong> ${escapeHtml(tel || 'não informado')}</p>
          <p><strong>Empreendimento:</strong> ${escapeHtml(empreen || 'não informado')}</p>
        `,
      }),
    });

    if (!resendRes.ok) {
      const errBody = await resendRes.text();
      console.error('Resend error:', errBody);
      releaseEmailSlot(normalizedEmail, false);
      res.status(502).json({ error: 'Falha ao enviar e-mail.' });
      return;
    }

    releaseEmailSlot(normalizedEmail, true);
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error(err);
    releaseEmailSlot(normalizedEmail, false);
    res.status(500).json({ error: 'Erro interno.' });
  }
}
