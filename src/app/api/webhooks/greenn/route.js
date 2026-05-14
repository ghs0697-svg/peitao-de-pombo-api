import { NextResponse } from 'next/server';
import { getKV, normEmail } from '@/lib/auth';
import { sendWhatsApp, buildWelcomeMessage } from '@/lib/zapi';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Webhook do Greenn — recebe eventos de compra/reembolso/cancelamento.
 *
 * Configurar na Greenn: POST https://peitao-de-pombo-api.vercel.app/api/webhooks/greenn?secret=XXX
 * (sem CORS — Greenn faz request server-to-server)
 *
 * Ações tratadas:
 *  - compra aprovada → grava `peitao:purchase:{email}`
 *  - reembolso/cancelamento → REMOVE `peitao:purchase:{email}` e `peitao:user:{email}` (revoga acesso)
 *
 * O payload exato da Greenn varia por integração. Tentamos múltiplos formatos.
 */
export async function POST(req) {
  try {
    // Auth via querystring ou header
    const url = new URL(req.url);
    const secret = process.env.GREENN_WEBHOOK_SECRET || '';
    const provided = url.searchParams.get('secret') || req.headers.get('x-webhook-secret') || '';
    if (secret && provided !== secret) {
      console.warn('greenn webhook unauthorized');
      return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
    }

    const payload = await req.json().catch(() => ({}));
    console.log('greenn webhook payload:', JSON.stringify(payload));

    // Procura recursiva por chave "email" em qualquer profundidade do objeto
    function findKey(obj, key) {
      if (!obj || typeof obj !== 'object') return null;
      for (const k of Object.keys(obj)) {
        if (k.toLowerCase() === key.toLowerCase() && typeof obj[k] === 'string' && obj[k]) return obj[k];
      }
      for (const k of Object.keys(obj)) {
        if (typeof obj[k] === 'object') {
          const r = findKey(obj[k], key);
          if (r) return r;
        }
      }
      return null;
    }

    // Email: tenta caminhos conhecidos primeiro, depois fallback recursivo
    const email = normEmail(
      payload.email ||
      payload.customer_email ||
      payload.buyer?.email ||
      payload.customer?.email ||
      payload.client?.email ||
      payload.data?.customer?.email ||
      payload.data?.buyer?.email ||
      payload.sale?.client?.email ||
      payload.sale?.customer?.email ||
      payload.sale?.buyer?.email ||
      findKey(payload, 'email') ||
      ''
    );
    const name =
      payload.name ||
      payload.customer_name ||
      payload.buyer?.name ||
      payload.customer?.name ||
      payload.client?.name ||
      payload.data?.customer?.name ||
      payload.data?.buyer?.name ||
      payload.sale?.client?.name ||
      payload.sale?.customer?.name ||
      payload.sale?.buyer?.name ||
      findKey(payload, 'name') ||
      null;
    // Status: prioriza currentStatus / sale.status (formato Greenn) sobre event
    const status = String(
      payload.currentStatus ||
      payload.sale?.status ||
      payload.data?.status ||
      payload.status ||
      payload.event ||
      payload.type ||
      'unknown'
    ).toLowerCase();

    if (!email) {
      console.warn('greenn webhook sem email');
      return NextResponse.json({ ok: false, error: 'sem email no payload' }, { status: 400 });
    }

    const kv = await getKV();

    // Eventos que CONCEDEM acesso
    const grantStatuses = ['paid','approved','aprovado','succeeded','completed','complete','sale_approved','order_approved','purchase_approved','active'];
    // Eventos que REVOGAM acesso
    const revokeStatuses = ['refunded','reembolso','chargeback','canceled','cancelled','cancelado','expired','disputed'];

    // ─── Detecção do que a compra inclui ───
    // upsell   → produto "5x + dieta"  → libera abas SEMANA + DIETA
    // lifetime → order bump "acesso vitalício" → zera os 90 dias de expiração (atrelado à CONTA)
    // Detecta por NOME de produto/oferta/bump no payload + override por env (IDs exatos).
    function collectNames(obj, acc = []) {
      if (!obj || typeof obj !== 'object') return acc;
      for (const k of Object.keys(obj)) {
        const v = obj[k];
        if (typeof v === 'string' && v && /name|nome|tit|offer|oferta|product|produto|bump|plan/i.test(k)) {
          acc.push(v.toLowerCase());
        } else if (v && typeof v === 'object') collectNames(v, acc);
      }
      return acc;
    }
    function collectIds(obj, acc = []) {
      if (!obj || typeof obj !== 'object') return acc;
      for (const k of Object.keys(obj)) {
        const v = obj[k];
        if ((typeof v === 'string' || typeof v === 'number') && /(product|produto|offer|oferta|bump|plan)_?id/i.test(k)) {
          acc.push(String(v));
        } else if (v && typeof v === 'object') collectIds(v, acc);
      }
      return acc;
    }
    function detectFlags(p) {
      const nameStr = collectNames(p).join(' | ');
      const ids = collectIds(p);
      const env = (n) => (process.env[n] || '').split(',').map(s => s.trim()).filter(Boolean);
      const ids5x = env('PEITAO_PRODUCT_5X_IDS');
      const idsLife = env('PEITAO_LIFETIME_IDS');

      const upsell =
        ids.some(i => ids5x.includes(i)) ||
        /\b5\s*x\b|cinco dias|resto do corpo|5x\s*\+\s*dieta|completo da semana/.test(nameStr);
      const lifetime =
        ids.some(i => idsLife.includes(i)) ||
        /vital[ií]ci|lifetime|para sempre|pra sempre|acesso total/.test(nameStr);

      return { upsell, lifetime, nameStr };
    }

    if (grantStatuses.some(s => status.includes(s))) {
      const det = detectFlags(payload);
      const existing = await kv.get(`peitao:purchase:${email}`);
      // NUNCA faz downgrade: flags só sobem. Aluno pode comprar base agora e upsell/vitalício depois.
      const upsell   = det.upsell   || !!(existing && existing.upsell);
      const lifetime = det.lifetime || !!(existing && existing.lifetime);
      const purchase = {
        email,
        name,
        status,
        upsell,
        lifetime,
        purchasedAt: existing?.purchasedAt || Date.now(),
        upsellAt:   (det.upsell   && !existing?.upsell)   ? Date.now() : (existing?.upsellAt   || null),
        lifetimeAt: (det.lifetime && !existing?.lifetime) ? Date.now() : (existing?.lifetimeAt || null),
        raw: payload, // guarda raw pra debug
      };
      await kv.set(`peitao:purchase:${email}`, purchase);
      console.log(`✅ peitao:purchase:${email} — upsell:${upsell} lifetime:${lifetime} | nomes: ${det.nameStr}`);

      // Se o user já existe, sincroniza os flags na conta dele
      const userRec = await kv.get(`peitao:user:${email}`);
      if (userRec) {
        userRec.upsell = upsell;
        userRec.lifetime = lifetime;
        await kv.set(`peitao:user:${email}`, userRec);
      }

      // Dispara WhatsApp de boas-vindas (best-effort — não bloqueia a resposta)
      const phone =
        findKey(payload, 'phone') ||
        findKey(payload, 'cellphone') ||
        findKey(payload, 'whatsapp') ||
        findKey(payload, 'mobile') ||
        findKey(payload, 'celular') ||
        findKey(payload, 'telefone') ||
        '';
      if (phone) {
        const welcome = buildWelcomeMessage({ name, email });
        const wppResult = await sendWhatsApp(phone, welcome);
        console.log('WhatsApp boas-vindas:', wppResult.ok ? 'enviado' : 'falhou', wppResult);
      } else {
        console.warn(`Sem phone no payload pra ${email} — WhatsApp não enviado`);
      }

      return NextResponse.json({ ok: true, action: 'granted', email, upsell, lifetime, phone: phone ? '***' : null });
    }

    if (revokeStatuses.some(s => status.includes(s))) {
      // Marca purchase como cancelada
      const existingPurchase = await kv.get(`peitao:purchase:${email}`);
      if (existingPurchase) {
        existingPurchase.status = status;
        existingPurchase.cancelledAt = Date.now();
        await kv.set(`peitao:purchase:${email}`, existingPurchase);
      }
      // Marca user como cancelled + revoga sessão (mantém pra histórico/legal)
      const existingUser = await kv.get(`peitao:user:${email}`);
      if (existingUser) {
        existingUser.status = 'cancelled';
        existingUser.cancelledAt = Date.now();
        if (existingUser.currentToken) {
          await kv.del(`peitao:session:${existingUser.currentToken}`).catch(() => {});
          existingUser.currentToken = null;
        }
        await kv.set(`peitao:user:${email}`, existingUser);
      }
      console.log(`🚫 peitao:user:${email} CANCELLED (status=${status})`);
      return NextResponse.json({ ok: true, action: 'cancelled', email });
    }

    console.log(`⚠ status desconhecido: ${status}`);
    return NextResponse.json({ ok: true, action: 'ignored', status });
  } catch (err) {
    console.error('greenn webhook error:', err);
    return NextResponse.json({ ok: false, error: String(err?.message || err) }, { status: 500 });
  }
}

// GET pra teste rápido — confirma que rota tá no ar
export async function GET(req) {
  return NextResponse.json({ ok: true, msg: 'Greenn webhook endpoint ativo. Use POST.' });
}
