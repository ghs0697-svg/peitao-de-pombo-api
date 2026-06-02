import {
  preflight, jsonRes, getKV, createSession, hashPassword, normEmail, rotateUserToken,
  isAccessExpired, accessDaysLeft, daysSincePurchase
} from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function OPTIONS(req) { return preflight(req); }

/**
 * Redefinir senha — mesmo nível de confiança do "Primeiro acesso":
 * basta o e-mail estar nas compras (ou na allowlist). Cria senha nova,
 * mata a sessão antiga (single session) e devolve token novo.
 *
 * POST { email, password }
 */
export async function POST(req) {
  try {
    const { email: rawEmail, password } = await req.json();
    const email = normEmail(rawEmail);

    if (!email || !password) {
      return jsonRes(req, { error: 'E-mail e senha obrigatórios.' }, { status: 400 });
    }
    if (password.length < 6) {
      return jsonRes(req, { error: 'Senha precisa de no mínimo 6 caracteres.' }, { status: 400 });
    }

    const kv = await getKV();

    // 1. E-mail comprou? (purchase via webhook Greenn ou allowlist)
    const purchase = await kv.get(`peitao:purchase:${email}`);
    const allowList = (process.env.PEITAO_ALLOW_EMAILS || '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
    const isAllowed = !!purchase || allowList.includes(email);

    if (!isAllowed) {
      return jsonRes(req, {
        error: 'E-mail não localizado nas compras. Verifica se é o mesmo da Greenn ou fala no suporte.'
      }, { status: 403 });
    }

    // 2. Acesso base expirado? (90 dias) — upsell é vitalício
    if (isAccessExpired(purchase)) {
      return jsonRes(req, {
        error: 'Teu acesso de 3 meses expirou. Libera o acesso vitalício pra continuar.',
        code: 'EXPIRED',
      }, { status: 403 });
    }

    // 3. Conta cancelada?
    const existing = await kv.get(`peitao:user:${email}`);
    if (existing?.status === 'cancelled') {
      return jsonRes(req, { error: 'Conta cancelada (reembolso/cancelamento). Fala no suporte.' }, { status: 403 });
    }

    // 4. Grava senha nova — mantém dados, troca só o hash
    const upsell = !!((purchase && purchase.upsell) || existing?.upsell);
    const lifetime = !!((purchase && purchase.lifetime) || existing?.lifetime);
    const passwordHash = await hashPassword(password);
    const user = {
      ...(existing || {}),
      email,
      passwordHash,
      name: existing?.name || purchase?.name || null,
      status: 'active',
      upsell,
      lifetime,
      createdAt: existing?.createdAt || Date.now(),
      lastLogin: Date.now(),
    };
    await kv.set(`peitao:user:${email}`, user);

    // Single session: token novo, mata o anterior
    const token = await createSession(email);
    await rotateUserToken(email, token);

    const ebooks = {
      ergo1: !!((purchase && purchase.ergo1) || existing?.ergo1),
      ergo2: !!((purchase && purchase.ergo2) || existing?.ergo2),
      pept:  !!((purchase && purchase.pept)  || existing?.pept),
    };
    return jsonRes(req, { email, token, name: user.name, upsell, lifetime, ebooks, daysLeft: accessDaysLeft(purchase), daysSincePurchase: daysSincePurchase(purchase) });
  } catch (err) {
    console.error('reset error:', err);
    return jsonRes(req, { error: 'Erro interno: ' + (err?.message || 'desconhecido') }, { status: 500 });
  }
}
