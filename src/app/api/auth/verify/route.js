import { preflight, jsonRes, requireAuth, accessDaysLeft } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function OPTIONS(req) { return preflight(req); }

export async function GET(req) {
  const auth = await requireAuth(req);
  if (auth.error) {
    return jsonRes(req, { ok: false, error: auth.error, code: auth.code || null }, { status: auth.status });
  }
  // requireAuth já trouxe a purchase e validou expiração
  const purchase = auth.purchase;
  const upsell = !!((purchase && purchase.upsell) || auth.user?.upsell);
  const daysLeft = accessDaysLeft(purchase);
  return jsonRes(req, {
    ok: true,
    email: auth.email,
    status: auth.user?.status || 'active',
    upsell,
    daysLeft,
  });
}
