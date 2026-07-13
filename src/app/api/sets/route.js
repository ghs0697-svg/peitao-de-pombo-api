import { preflight, jsonRes, getKV, requireAuth } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Backup das cargas do aluno (grade de séries kg/placa/reps por semana).
 *
 * O app salva offline-first no localStorage e sincroniza pra cá em background.
 * Aqui é o backup por CONTA: se o aluno trocar de celular ou limpar o navegador,
 * o app restaura tudo no próximo login.
 *
 * Estrutura no KV:
 *   peitao:sets:{email}      -> { [key]: [{kg,pl,reps}, ...] }   snapshot (última versão de cada chave)
 *   peitao:sets:log:{email}  -> lista append-only [{ts, key, sets}]  1 registro por save, nunca sobrescreve
 *
 * key = mesmo sufixo do localStorage: "<ctxKey>_w<semana>_e<idx>[ _sub ]"
 *   ex: "peito_1.0_w3_e2" ou "semana_2.0_1_w5_e4_sub"
 *
 * GET  /api/sets           -> { ok, sets: {key: [...]} }        (restore no login)
 * POST /api/sets           -> body { key, sets } (1 chave)      (sync do save)
 *                              ou { entries: {key: sets, ...} } (bulk, migração inicial)
 * Auth: Bearer token (mesma sessão do app). Sem token/expirado -> 401/403 padrão.
 */

const MAX_KEY_LEN = 120;
const MAX_SETS = 12;
const MAX_ENTRIES_BULK = 400;
const LOG_MAX = 3000;   // teto do log por aluno (aparados os mais antigos)

// Campos aceitos por item: séries de carga (kg/pl/reps) e medição da Régua (cm/lado/frente)
const ITEM_FIELDS = ['kg', 'pl', 'reps', 'cm', 'lado', 'frente'];
function cleanSets(arr) {
  if (!Array.isArray(arr)) return null;
  return arr.slice(0, MAX_SETS).map(s => {
    const o = {};
    for (const f of ITEM_FIELDS) o[f] = String((s && s[f]) || '').slice(0, 8);
    return o;
  });
}
function validKey(k) {
  return typeof k === 'string' && k.length > 0 && k.length <= MAX_KEY_LEN && /^[\w.\-]+$/.test(k);
}

export async function OPTIONS(req) { return preflight(req); }

export async function GET(req) {
  const auth = await requireAuth(req);
  if (auth.error) return jsonRes(req, { error: auth.error, code: auth.code }, { status: auth.status });
  const kv = await getKV();
  const sets = (await kv.get(`peitao:sets:${auth.email}`)) || {};
  return jsonRes(req, { ok: true, sets });
}

export async function POST(req) {
  const auth = await requireAuth(req);
  if (auth.error) return jsonRes(req, { error: auth.error, code: auth.code }, { status: auth.status });
  const email = auth.email;

  let body;
  try { body = await req.json(); } catch (e) {
    return jsonRes(req, { error: 'JSON inválido' }, { status: 400 });
  }

  // Normaliza: single {key, sets} ou bulk {entries}
  let entries = {};
  if (body && body.entries && typeof body.entries === 'object') {
    const keys = Object.keys(body.entries).slice(0, MAX_ENTRIES_BULK);
    for (const k of keys) {
      if (!validKey(k)) continue;
      const c = cleanSets(body.entries[k]);
      if (c) entries[k] = c;
    }
  } else if (body && validKey(body.key)) {
    const c = cleanSets(body.sets);
    if (c) entries[body.key] = c;
  }
  const keys = Object.keys(entries);
  if (!keys.length) return jsonRes(req, { error: 'nada válido pra salvar (key/sets ou entries)' }, { status: 400 });

  const kv = await getKV();

  // Snapshot: merge por chave (última versão vence)
  const snapKey = `peitao:sets:${email}`;
  const snap = (await kv.get(snapKey)) || {};
  for (const k of keys) snap[k] = entries[k];
  await kv.set(snapKey, snap);

  // Log append-only: 1 registro por save (auditoria; recuperação de "carga sumiu")
  const logKey = `peitao:sets:log:${email}`;
  const ts = Date.now();
  try {
    for (const k of keys) {
      await kv.rpush(logKey, JSON.stringify({ ts, key: k, sets: entries[k] }));
    }
    const len = await kv.llen(logKey);
    if (len > LOG_MAX) await kv.ltrim(logKey, len - LOG_MAX, -1);
  } catch (e) {
    console.error('sets log error (snapshot ok):', e?.message || e);
  }

  return jsonRes(req, { ok: true, saved: keys.length });
}
