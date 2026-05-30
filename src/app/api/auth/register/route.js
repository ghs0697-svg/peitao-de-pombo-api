import {
  preflight, jsonRes, getKV, createSession, hashPassword, normEmail, rotateUserToken,
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
    if (password.length < 6) {
      return jsonRes(req, { error: 'Senha precisa de no mínimo 6 caracteres.' }, { status: 400 });
    }

    const kv = await getKV();

    // 1. Verifica se email comprou (purchase autorizada via webhook Greenn)
    const purchase = await kv.get(`peitao:purchase:${email}`);
    const allowList = (process.env.PEITAO_ALLOW_EMAILS || '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
    const isAllowed = !!purchase || allowList.includes(email);

    if (!isAllowed) {
      return jsonRes(req, {
        error: 'E-mail não localizado nas compras. Verifica se é o mesmo da Greenn ou fala no suporte.'
      }, { status: 403 });
    }

    // 1b. Acesso base expirado? (90 dias) — upsell é vitalício
    if (isAccessExpired(purchase)) {
      return jsonRes(req, {
        error: 'Teu acesso de 3 meses expirou. Libera o acesso vitalício pra continuar.',
        code: 'EXPIRED',
      }, { status: 403 });
    }

    // 2. Já existe conta? — login normal
    const existing = await kv.get(`peitao:user:${email}`);
    if (existing) {
      return jsonRes(req, {
        error: 'Esse e-mail já tem senha cadastrada. Use a tela de login.'
      }, { status: 409 });
    }

    // 3. Cria conta — herda os flags de upsell e lifetime da compra
    const upsell = !!(purchase && purchase.upsell);
    const lifetime = !!(purchase && purchase.lifetime);
    const passwordHash = await hashPassword(password);
    const user = {
      email,
      passwordHash,
      name: purchase?.name || null,
      status: 'active',
      upsell,
      lifetime,
      createdAt: Date.now(),
      lastLogin: Date.now(),
    };
    await kv.set(`peitao:user:${email}`, user);

    const token = await createSession(email);
    await rotateUserToken(email, token);
    return jsonRes(req, { email, token, name: user.name, upsell, lifetime, daysLeft: accessDaysLeft(purchase), daysSincePurchase: daysSincePurchase(purchase) });
  } catch (err) {
    console.error('register error:', err);
    return jsonRes(req, { error: 'Erro interno: ' + (err?.message || 'desconhecido') }, { status: 500 });
  }
}
