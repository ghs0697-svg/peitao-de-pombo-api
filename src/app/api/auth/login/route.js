import {
  preflight, jsonRes, getKV, createSession, verifyPassword, normEmail, rotateUserToken,
  isAccessExpired, accessDaysLeft, daysSincePurchase
} from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function OPTIONS(req) { return preflight(req); }

export async function POST(req) {
  try {
    const { email: rawEmail, password } = await req.json();
    const email = normEmail(rawEmail);

    if (!email || !password) {
      return jsonRes(req, { error: 'E-mail e senha obrigatórios.' }, { status: 400 });
    }

    const kv = await getKV();
    const user = await kv.get(`peitao:user:${email}`);
    if (!user) {
      return jsonRes(req, { error: 'E-mail ou senha incorretos.' }, { status: 401 });
    }

    if (user.status === 'cancelled') {
      return jsonRes(req, { error: 'Conta cancelada (reembolso/cancelamento). Fala no suporte.' }, { status: 403 });
    }

    const ok = await verifyPassword(password, user.passwordHash);
    if (!ok) {
      return jsonRes(req, { error: 'E-mail ou senha incorretos.' }, { status: 401 });
    }

    // Expiração de acesso: base expira em 90 dias, upsell é vitalício
    const purchase = await kv.get(`peitao:purchase:${email}`);
    if (isAccessExpired(purchase)) {
      return jsonRes(req, {
        error: 'Teu acesso de 3 meses expirou. Libera o acesso vitalício pra continuar.',
        code: 'EXPIRED',
      }, { status: 403 });
    }

    // Single session: gera novo token e mata o anterior
    const token = await createSession(email);
    await rotateUserToken(email, token);

    // Re-sincroniza upsell/lifetime com a compra (caso tenha comprado o bump depois)
    const upsell = !!((purchase && purchase.upsell) || user.upsell);
    const lifetime = !!((purchase && purchase.lifetime) || user.lifetime);
    const daysLeft = accessDaysLeft(purchase);
    const daysSince = daysSincePurchase(purchase);

    return jsonRes(req, { email, token, name: user.name || null, upsell, lifetime, daysLeft, daysSincePurchase: daysSince });
  } catch (err) {
    console.error('login error:', err);
    return jsonRes(req, { error: 'Erro interno: ' + (err?.message || 'desconhecido') }, { status: 500 });
  }
}
