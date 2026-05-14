// Z-API (WhatsApp) — envio de mensagens automáticas
// Configurado via env vars: ZAPI_INSTANCE_ID, ZAPI_TOKEN, ZAPI_CLIENT_TOKEN

export async function sendWhatsApp(phone, message) {
  const instance = process.env.ZAPI_INSTANCE_ID;
  const token = process.env.ZAPI_TOKEN;
  const clientToken = process.env.ZAPI_CLIENT_TOKEN || '';

  if (!instance || !token) {
    console.warn('Z-API: env vars ZAPI_INSTANCE_ID/ZAPI_TOKEN ausentes — pulando');
    return { ok: false, skipped: true, reason: 'no-credentials' };
  }
  if (!phone) {
    return { ok: false, skipped: true, reason: 'no-phone' };
  }

  // Normaliza: só dígitos. Se não começar com 55 (Brasil), prepara
  let cleanPhone = String(phone).replace(/\D/g, '');
  if (cleanPhone.length === 11 || cleanPhone.length === 10) cleanPhone = '55' + cleanPhone;
  if (cleanPhone.length < 12) {
    console.warn('Z-API: phone inválido após normalização:', phone, '→', cleanPhone);
    return { ok: false, skipped: true, reason: 'invalid-phone', phone };
  }

  const url = `https://api.z-api.io/instances/${instance}/token/${token}/send-text`;
  const headers = { 'Content-Type': 'application/json' };
  if (clientToken) headers['Client-Token'] = clientToken;

  // DIAGNÓSTICO: confirma que env vars chegaram no runtime
  console.log('Z-API config:', {
    hasInstance: !!instance,
    instanceLen: instance?.length,
    hasToken: !!token,
    tokenLen: token?.length,
    hasClientToken: !!clientToken,
    clientTokenLen: clientToken?.length,
    clientTokenPrefix: clientToken ? clientToken.slice(0, 4) + '...' : 'NONE',
    phoneToSend: cleanPhone,
  });

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ phone: cleanPhone, message }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error('Z-API erro HTTP', res.status, data);
      return { ok: false, status: res.status, data };
    }
    console.log('Z-API enviado pra', cleanPhone, ':', data?.id || data?.messageId || 'ok');
    return { ok: true, data };
  } catch (err) {
    console.error('Z-API fetch fail:', err);
    return { ok: false, error: String(err?.message || err) };
  }
}

export function buildWelcomeMessage({ name, email }) {
  const firstName = (name || '').trim().split(/\s+/)[0];
  const greeting = firstName ? `E aí, ${firstName}!` : 'E aí, atleta!';
  return [
    `${greeting} 🔥`,
    '',
    'Bem-vindo ao *Peitão de Pombo* — método GH.',
    '',
    'Pra começar agora:',
    '1️⃣ Abre o app: https://app.peitaodepombo.com.br',
    `2️⃣ Clica em *Primeiro acesso? Criar senha*`,
    `3️⃣ Usa esse e-mail: *${email}*`,
    '4️⃣ Cria tua senha (mín 6 caracteres)',
    '5️⃣ Faz a calculadora rápida (1 min) e bora treinar',
    '',
    'Qualquer dúvida me chama aqui mesmo no WhatsApp.',
    '',
    '— GH Scheuermann',
    '@gh.scheuermann'
  ].join('\n');
}
