import { NextResponse } from 'next/server';
import { getKV, normEmail } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Admin/debug endpoint: sobrescreve flags da purchase + user de um email específico.
 * Permite DOWNGRADE (diferente do webhook que só faz upgrade — política "nunca tira flag").
 *
 * Uso:
 *   GET /api/admin/setflags?secret=XXX&email=foo@bar.com&upsell=0&lifetime=0&ergo1=0&ergo2=0&pept=0
 *   GET /api/admin/setflags?secret=XXX&email=foo@bar.com&upsell=1&reactivate=1
 *
 * Param `secret`: usa HOTMART_WEBHOOK_SECRET (já configurado no Vercel).
 * Param `reactivate=1`: também reativa conta cancelada (status='paid' / user.status='active').
 * Cada flag aceita "0" (false), "1" (true), ou ausente (mantém atual).
 */
export async function GET(req) {
  const url = new URL(req.url);
  const expected = process.env.HOTMART_WEBHOOK_SECRET || '';
  const provided = url.searchParams.get('secret') || '';
  if (!expected || provided !== expected) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  const email = normEmail(url.searchParams.get('email') || '');
  if (!email) return NextResponse.json({ ok: false, error: 'email obrigatório' }, { status: 400 });

  const kv = await getKV();
  const purchase = await kv.get(`peitao:purchase:${email}`);
  if (!purchase) {
    return NextResponse.json({ ok: false, error: 'purchase não encontrada pra esse email' }, { status: 404 });
  }

  const applyFlag = (key) => {
    const v = url.searchParams.get(key);
    if (v === '0') purchase[key] = false;
    else if (v === '1') purchase[key] = true;
  };
  applyFlag('upsell');
  applyFlag('lifetime');
  applyFlag('ergo1');
  applyFlag('ergo2');
  applyFlag('pept');

  if (url.searchParams.get('reactivate') === '1') {
    purchase.status = 'paid';
    delete purchase.cancelledAt;
  }

  await kv.set(`peitao:purchase:${email}`, purchase);

  // Sincroniza no user
  const userRec = await kv.get(`peitao:user:${email}`);
  if (userRec) {
    userRec.upsell = !!purchase.upsell;
    userRec.lifetime = !!purchase.lifetime;
    userRec.ergo1 = !!purchase.ergo1;
    userRec.ergo2 = !!purchase.ergo2;
    userRec.pept = !!purchase.pept;
    if (url.searchParams.get('reactivate') === '1') {
      userRec.status = 'active';
      delete userRec.cancelledAt;
    }
    await kv.set(`peitao:user:${email}`, userRec);
  }

  return NextResponse.json({
    ok: true,
    email,
    flags: {
      upsell: !!purchase.upsell,
      lifetime: !!purchase.lifetime,
      ergo1: !!purchase.ergo1,
      ergo2: !!purchase.ergo2,
      pept: !!purchase.pept,
    },
    status: purchase.status,
  });
}
