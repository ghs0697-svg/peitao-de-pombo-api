import { NextResponse } from 'next/server';
import { getKV, normEmail } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Webhook da Hotmart — recebe eventos de compra/reembolso/cancelamento.
 *
 * Configurar na Hotmart (em cada produto):
 *   POST https://peitao-de-pombo-api-es21.vercel.app/api/webhooks/hotmart?hottok=XXX
 *
 * Onde XXX é o valor de HOTMART_WEBHOOK_SECRET no Vercel (qualquer string secreta
 * que tu defina). Se não setar, o endpoint aceita qualquer chamada (modo permissivo).
 *
 * Eventos tratados:
 *  - PURCHASE_APPROVED / PURCHASE_COMPLETE → grava `peitao:purchase:{email}` (+ upsell/lifetime)
 *  - PURCHASE_REFUNDED / PURCHASE_CHARGEBACK / PURCHASE_CANCELED / PURCHASE_EXPIRED → revoga
 *
 * Detecção de produto via UCODE (ID alfanumérico da Hotmart no link):
 *   Peitão base:   0106022942Q  → access padrão (90 dias, sem upsell)
 *   5x + dieta:    X106025440Q  → upsell=true (libera SEMANA + DIETA)
 *   Vitalício:     H106024755Q  → lifetime=true (zera os 90 dias)
 */

// IDs Hotmart pra cada produto/oferta. Comparado contra data.product.ucode/id.
const PRODUCT_BASE      = ['0106022942', '0106022942Q'];
const PRODUCT_5X        = ['X106025440', 'X106025440Q'];
const PRODUCT_VITALICIO = ['H106024755', 'H106024755Q'];

// Códigos das ofertas (off=XXX no link) — fallback caso o ucode não case
const OFFER_5X        = ['yh12bqml'];
const OFFER_VITALICIO = ['hiziwk8x'];

const GRANT_EVENTS  = ['PURCHASE_APPROVED', 'PURCHASE_COMPLETE'];
const REVOKE_EVENTS = ['PURCHASE_REFUNDED', 'PURCHASE_CHARGEBACK', 'PURCHASE_CANCELED', 'PURCHASE_EXPIRED', 'PURCHASE_PROTEST_CLOSED'];

export async function POST(req) {
  try {
    // Auth via querystring (?hottok=XXX) ou header (x-hotmart-hottok) ou body (payload.hottok)
    const url = new URL(req.url);
    const secret = process.env.HOTMART_WEBHOOK_SECRET || '';
    const payload = await req.json().catch(() => ({}));
    const provided = url.searchParams.get('hottok')
                  || req.headers.get('x-hotmart-hottok')
                  || req.headers.get('x-hotmart-signature')
                  || payload.hottok
                  || '';
    if (secret && provided !== secret) {
      console.warn('hotmart webhook unauthorized');
      return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
    }

    console.log('hotmart webhook payload:', JSON.stringify(payload));

    const event = String(payload.event || '').toUpperCase();
    const data = payload.data || {};
    const buyer = data.buyer || {};
    const product = data.product || {};
    const purchase = data.purchase || {};
    const offer = purchase.offer || {};

    const email = normEmail(buyer.email || buyer.checkout_email || '');
    const name = buyer.name || null;

    if (!email) {
      console.warn('hotmart webhook sem email');
      return NextResponse.json({ ok: false, error: 'sem email no payload' }, { status: 400 });
    }

    // ─── Detecção de produto ───
    const ucode = String(product.ucode || '').toUpperCase();
    const productId = String(product.id || '');
    const productName = String(product.name || '').toLowerCase();
    const offerCode = String(offer.code || offer.key || '').toLowerCase();

    const matchUcode = (codes) => codes.some(c => ucode === c.toUpperCase() || productId === c);
    const matchOffer = (codes) => codes.some(c => offerCode === c.toLowerCase());

    const is5X        = matchUcode(PRODUCT_5X)        || matchOffer(OFFER_5X)
                     || /5\s*x|5x\s*\+\s*dieta|semana.*dieta/.test(productName);
    const isVitalicio = matchUcode(PRODUCT_VITALICIO) || matchOffer(OFFER_VITALICIO)
                     || /vital[ií]ci/.test(productName);

    const kv = await getKV();

    if (GRANT_EVENTS.includes(event)) {
      const existing = await kv.get(`peitao:purchase:${email}`);
      // NUNCA faz downgrade — flags só sobem
      const upsell   = is5X        || !!(existing && existing.upsell);
      const lifetime = isVitalicio || !!(existing && existing.lifetime);
      const purchaseRec = {
        email,
        name,
        status: 'paid',
        source: 'hotmart',
        upsell,
        lifetime,
        purchasedAt: existing?.purchasedAt || Date.now(),
        upsellAt:   (is5X        && !existing?.upsell)   ? Date.now() : (existing?.upsellAt   || null),
        lifetimeAt: (isVitalicio && !existing?.lifetime) ? Date.now() : (existing?.lifetimeAt || null),
        lastEvent: event,
        raw: payload,
      };
      await kv.set(`peitao:purchase:${email}`, purchaseRec);
      console.log(`✅ peitao:purchase:${email} (hotmart) — upsell:${upsell} lifetime:${lifetime} | ucode:${ucode} offer:${offerCode} nome:${productName}`);

      // Sincroniza flags no user (se já existe conta)
      const userRec = await kv.get(`peitao:user:${email}`);
      if (userRec) {
        userRec.upsell = upsell;
        userRec.lifetime = lifetime;
        await kv.set(`peitao:user:${email}`, userRec);
      }

      return NextResponse.json({ ok: true, action: 'granted', email, upsell, lifetime, source: 'hotmart' });
    }

    if (REVOKE_EVENTS.includes(event)) {
      const existingPurchase = await kv.get(`peitao:purchase:${email}`);
      if (existingPurchase) {
        existingPurchase.status = event.toLowerCase();
        existingPurchase.cancelledAt = Date.now();
        await kv.set(`peitao:purchase:${email}`, existingPurchase);
      }
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
      console.log(`🚫 peitao:user:${email} CANCELLED (hotmart event=${event})`);
      return NextResponse.json({ ok: true, action: 'cancelled', email });
    }

    console.log(`⚠ hotmart event ignorado: ${event}`);
    return NextResponse.json({ ok: true, action: 'ignored', event });
  } catch (err) {
    console.error('hotmart webhook error:', err);
    return NextResponse.json({ ok: false, error: String(err?.message || err) }, { status: 500 });
  }
}

// GET pra teste rápido — confirma que rota tá no ar
export async function GET(req) {
  return NextResponse.json({ ok: true, msg: 'Hotmart webhook endpoint ativo. Use POST.' });
}
