import { preflight, jsonRes, requireAuth, destroySession } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function OPTIONS(req) { return preflight(req); }

export async function POST(req) {
  const { token } = await requireAuth(req);
  await destroySession(token);
  return jsonRes(req, { ok: true });
}
