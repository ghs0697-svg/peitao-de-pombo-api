import { NextResponse } from 'next/server';
import { getKV, normEmail } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Admin endpoint pra GH autorizar/revogar email manualmente.
 * Útil quando webhook Greenn ainda não funciona, ou pra contas de cortesia/teste.
 *
 * GET /api/admin/grant?email=foo@bar.com&secret=XXX → autoriza (só base, 90 dias)
 * GET /api/admin/grant?email=foo@bar.com&secret=XXX&upsell=1 → + libera semana+dieta
 * GET /api/admin/grant?email=foo@bar.com&secret=XXX&lifetime=1 → + acesso vitalício (zera os 90 dias)
 * GET /api/admin/grant?email=foo@bar.com&secret=XXX&action=revoke → revoga
 * GET /api/admin/grant?email=foo@bar.com&secret=XXX&action=check → inspeciona
 */
export async function GET(req) {
  const url = new URL(req.url);
  const secret = process.env.ADMIN_SECRET || '';
  const provided = url.searchParams.get('secret') || '';
  if (!secret || provided !== secret) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  const email = normEmail(url.searchParams.get('email') || '');
  const action = url.searchParams.get('action') || 'grant';
  if (!email) return NextResponse.json({ ok: false, error: 'email obrigatório' }, { status: 400 });

  const kv = await getKV();

  if (action === 'check') {
    const purchase = await kv.get(`peitao:purchase:${email}`);
    const user = await kv.get(`peitao:user:${email}`);
    return NextResponse.json({
      ok: true,
      email,
      purchase: purchase ? { status: purchase.status, name: purchase.name, upsell: !!purchase.upsell, lifetime: !!purchase.lifetime, purchasedAt: purchase.purchasedAt, cancelledAt: purchase.cancelledAt } : null,
      user: user ? { status: user.status || 'active', name: user.name, upsell: !!user.upsell, lifetime: !!user.lifetime, createdAt: user.createdAt, lastLogin: user.lastLogin, hasToken: !!user.currentToken } : null,
      hasAccess: !!purchase && (!user || user.status !== 'cancelled')
    });
  }

  if (action === 'revoke') {
    await kv.del(`peitao:purchase:${email}`);
    await kv.del(`peitao:user:${email}`);
    return NextResponse.json({ ok: true, action: 'revoked', email });
  }

  // grant — autoriza. upsell=1 libera semana+dieta · lifetime=1 zera a expiração
  const wantUpsell = url.searchParams.get('upsell') === '1';
  const wantLifetime = url.searchParams.get('lifetime') === '1';
  const existing = await kv.get(`peitao:purchase:${email}`);
  const upsell = wantUpsell || !!(existing && existing.upsell);
  const lifetime = wantLifetime || !!(existing && existing.lifetime);
  await kv.set(`peitao:purchase:${email}`, {
    email,
    name: url.searchParams.get('name') || existing?.name || null,
    status: 'manual_grant',
    upsell,
    lifetime,
    purchasedAt: existing?.purchasedAt || Date.now(),
  });
  // Se já tem conta, sincroniza os flags
  const userRec = await kv.get(`peitao:user:${email}`);
  if (userRec) {
    userRec.upsell = upsell;
    userRec.lifetime = lifetime;
    await kv.set(`peitao:user:${email}`, userRec);
  }
  return NextResponse.json({ ok: true, action: 'granted', email, upsell, lifetime });
}
