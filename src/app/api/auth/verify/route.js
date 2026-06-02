import { preflight, jsonRes, requireAuth, accessDaysLeft, daysSincePurchase } from '@/lib/auth';

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
  const lifetime = !!((purchase && purchase.lifetime) || auth.user?.lifetime);
  const ebooks = {
    ergo1: !!((purchase && purchase.ergo1) || auth.user?.ergo1),
    ergo2: !!((purchase && purchase.ergo2) || auth.user?.ergo2),
    pept:  !!((purchase && purchase.pept)  || auth.user?.pept),
  };
  const daysLeft = accessDaysLeft(purchase);
  const daysSince = daysSincePurchase(purchase);
  return jsonRes(req, {
    ok: true,
    email: auth.email,
    status: auth.user?.status || 'active',
    upsell,
    lifetime,
    ebooks,
    daysLeft,
    daysSincePurchase: daysSince,
  });
}
