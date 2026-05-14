import { preflight, jsonRes, requireAuth, getKV } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function OPTIONS(req) { return preflight(req); }

export async function GET(req) {
  const auth = await requireAuth(req);
  if (auth.error) return jsonRes(req, { ok: false, error: auth.error }, { status: auth.status });
  // Re-sincroniza upsell com a compra (aluno pode ter comprado o bump depois)
  const kv = await getKV();
  const purchase = await kv.get(`peitao:purchase:${auth.email}`);
  const upsell = !!((purchase && purchase.upsell) || auth.user?.upsell);
  return jsonRes(req, { ok: true, email: auth.email, status: auth.user?.status || 'active', upsell });
}
