// Helpers de auth + CORS para o backend Peitão de Pombo
import { NextResponse } from 'next/server';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';

// CORS — libera o app frontend
const ALLOWED_ORIGINS = [
  'https://app.peitaodepombo.com.br',
  'http://app.peitaodepombo.com.br',
  'https://peitaodepombo.com.br',
  'http://peitaodepombo.com.br',
  'https://ghs0697-svg.github.io',
  'http://localhost:3000',
  'http://localhost:5500',
  'http://127.0.0.1:5500',
];

export function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
  };
}

export function withCors(req, response) {
  const origin = req.headers.get('origin') || '';
  const headers = corsHeaders(origin);
  for (const [k, v] of Object.entries(headers)) response.headers.set(k, v);
  return response;
}

export function preflight(req) {
  return withCors(req, new NextResponse(null, { status: 204 }));
}

export function jsonRes(req, body, init = {}) {
  return withCors(req, NextResponse.json(body, init));
}

// KV
export async function getKV() {
  const mod = await import('@vercel/kv');
  return mod.kv;
}

// Sessões — token aleatório guardado em KV
const SESSION_TTL = 60 * 60 * 24 * 30; // 30 dias

export function genToken() {
  return crypto.randomBytes(32).toString('base64url');
}

export async function createSession(email) {
  const kv = await getKV();
  const token = genToken();
  await kv.set(`peitao:session:${token}`, email, { ex: SESSION_TTL });
  return token;
}

export async function emailFromToken(token) {
  if (!token) return null;
  const kv = await getKV();
  return await kv.get(`peitao:session:${token}`);
}

export async function destroySession(token) {
  if (!token) return;
  const kv = await getKV();
  await kv.del(`peitao:session:${token}`);
}

// Bcrypt
export async function hashPassword(pwd) {
  return bcrypt.hash(pwd, 10);
}
export async function verifyPassword(pwd, hash) {
  if (!hash) return false;
  return bcrypt.compare(pwd, hash);
}

// Email normalize
export function normEmail(e) {
  return String(e || '').trim().toLowerCase();
}

// ─── Expiração de acesso ───
// Base (R$29,90) → acesso por 90 dias desde a compra.
// Upsell (+R$19,90) → vitalício, nunca expira.
export const ACCESS_DAYS_BASE = 90;
const MS_PER_DAY = 1000 * 60 * 60 * 24;

export function daysSince(ts) {
  if (!ts) return 0;
  const t = typeof ts === 'number' ? ts : new Date(ts).getTime();
  if (!t || isNaN(t)) return 0;
  return Math.floor((Date.now() - t) / MS_PER_DAY);
}

// Dias restantes de acesso. Upsell → null (vitalício). Base → nº de dias (pode ser negativo).
export function accessDaysLeft(purchase) {
  if (!purchase) return null;            // allowlist / sem compra → não expira
  if (purchase.upsell) return null;      // vitalício
  return ACCESS_DAYS_BASE - daysSince(purchase.purchasedAt);
}

export function isAccessExpired(purchase) {
  const left = accessDaysLeft(purchase);
  return left !== null && left <= 0;
}

// Auth gate — usa header Authorization: Bearer <token>
// Verifica:
//  1. token bate com session na KV
//  2. token === user.currentToken (single session)
//  3. user.status !== 'cancelled'
//  4. acesso base (90 dias) não expirou — upsell é vitalício
// Retorna { email, token, user, purchase } se OK; { error, status, code } se falhou.
export async function requireAuth(req) {
  const auth = req.headers.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) return { error: 'Sessão inválida', status: 401 };

  const email = await emailFromToken(token);
  if (!email) return { error: 'Sessão expirada', status: 401 };

  const kv = await getKV();
  const user = await kv.get(`peitao:user:${email}`);
  if (!user) return { error: 'Conta não encontrada', status: 401 };

  // Single session: o token usado tem que ser o atual
  if (user.currentToken && user.currentToken !== token) {
    return { error: 'Sessão expirada (login em outro dispositivo)', status: 401 };
  }

  // Status check
  if (user.status === 'cancelled') {
    return { error: 'Conta cancelada (reembolso/cancelamento). Fala no suporte.', status: 403, code: 'CANCELLED' };
  }

  // Expiração de acesso (base 90 dias; upsell vitalício)
  const purchase = await kv.get(`peitao:purchase:${email}`);
  if (isAccessExpired(purchase)) {
    return {
      error: 'Teu acesso de 3 meses expirou. Libera o acesso vitalício pra continuar.',
      status: 403, code: 'EXPIRED', email, user, purchase,
    };
  }

  return { email, token, user, purchase };
}

// Substitui o currentToken do user — invalida sessão anterior
export async function rotateUserToken(email, newToken) {
  const kv = await getKV();
  const user = (await kv.get(`peitao:user:${email}`)) || {};
  // Apaga sessão antiga (best-effort)
  if (user.currentToken && user.currentToken !== newToken) {
    await kv.del(`peitao:session:${user.currentToken}`).catch(() => {});
  }
  user.currentToken = newToken;
  user.lastLogin = Date.now();
  await kv.set(`peitao:user:${email}`, user);
}
