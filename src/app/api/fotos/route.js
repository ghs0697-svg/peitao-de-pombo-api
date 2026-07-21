import { requireAuth, jsonRes, preflight } from '@/lib/auth';
import { google } from 'googleapis';
import { Readable } from 'node:stream';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/**
 * Backup das fotos de acompanhamento do aluno no Google Drive.
 * O app guarda local (IndexedDB) e sobe cada foto pra cá; aqui organiza no Drive:
 *   [PEITAO_FOTOS_FOLDER_ID] / "Nome do Aluno (email)" / "DD-MM-AAAA" / frente|costas|ladoD|ladoE.jpg
 *
 * Env vars no Vercel (projeto peitao-de-pombo-api):
 *   GOOGLE_CREDS_JSON        -> JSON da service account (mesma do metodogh serve)
 *   PEITAO_FOTOS_FOLDER_ID   -> id da pasta-raiz (criada pelo GH e compartilhada com a SA como Editor)
 * Sem essas duas vars, o endpoint responde 503 not_configured (o app deixa a foto pendente).
 *
 * A purga automática (apagar > 4 meses) fica em /api/fotos/purge (cron diário).
 */

const ANGLES = { frente: 'frente', costas: 'costas', ladoD: 'ladoD', ladoE: 'ladoE' };

function getDrive() {
  const cid = process.env.GDRIVE_CLIENT_ID;
  const csec = process.env.GDRIVE_CLIENT_SECRET;
  const rtok = process.env.GDRIVE_REFRESH_TOKEN;
  const root = process.env.PEITAO_FOTOS_FOLDER_ID;
  if (!cid || !csec || !rtok || !root) return null;
  // OAuth do próprio GH (drive.file): sobe pra Drive dele, sem o limite de cota de service account.
  const oauth2 = new google.auth.OAuth2(cid, csec);
  oauth2.setCredentials({ refresh_token: rtok });
  return { drive: google.drive({ version: 'v3', auth: oauth2 }), root };
}

async function findOrCreateFolder(drive, name, parentId) {
  const safe = String(name).replace(/'/g, "\\'");
  const q = `mimeType='application/vnd.google-apps.folder' and name='${safe}' and '${parentId}' in parents and trashed=false`;
  const r = await drive.files.list({ q, fields: 'files(id)', pageSize: 1 });
  if (r.data.files && r.data.files[0]) return r.data.files[0].id;
  const c = await drive.files.create({
    requestBody: { name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] },
    fields: 'id',
  });
  return c.data.id;
}

export async function OPTIONS(req) { return preflight(req); }

export async function POST(req) {
  const auth = await requireAuth(req);
  if (auth.error) return jsonRes(req, { error: auth.error, code: auth.code }, { status: auth.status });

  const d = getDrive();
  if (!d) return jsonRes(req, { ok: false, error: 'not_configured' }, { status: 503 });

  let body;
  try { body = await req.json(); } catch (e) { return jsonRes(req, { error: 'json inválido' }, { status: 400 }); }

  const angle = String(body.angle || '');
  if (!ANGLES[angle]) return jsonRes(req, { error: 'ângulo inválido' }, { status: 400 });

  const m = /^data:image\/(?:jpe?g|png);base64,(.+)$/.exec(String(body.dataUrl || ''));
  if (!m) return jsonRes(req, { error: 'imagem inválida' }, { status: 400 });
  const buf = Buffer.from(m[1], 'base64');
  if (!buf.length || buf.length > 6 * 1024 * 1024) return jsonRes(req, { error: 'imagem fora do tamanho' }, { status: 413 });

  const date = /^\d{2}-\d{2}-\d{4}$/.test(String(body.date || '')) ? body.date : null;
  if (!date) return jsonRes(req, { error: 'data inválida' }, { status: 400 });

  try {
    const nome = (auth.user && auth.user.name) ? String(auth.user.name).slice(0, 80) : auth.email;
    const alunoFolder = `${nome} (${auth.email})`;
    const alunoId = await findOrCreateFolder(d.drive, alunoFolder, d.root);
    const dateId = await findOrCreateFolder(d.drive, date, alunoId);
    const fname = `${angle}.jpg`;

    // re-upload do mesmo ângulo/dia: substitui
    const ex = await d.drive.files.list({ q: `name='${fname}' and '${dateId}' in parents and trashed=false`, fields: 'files(id)', pageSize: 1 });
    if (ex.data.files && ex.data.files[0]) {
      await d.drive.files.delete({ fileId: ex.data.files[0].id }).catch(() => {});
    }
    await d.drive.files.create({
      requestBody: { name: fname, parents: [dateId] },
      media: { mimeType: 'image/jpeg', body: Readable.from(buf) },
      fields: 'id',
    });
    return jsonRes(req, { ok: true });
  } catch (e) {
    console.error('fotos upload error:', e?.message || e);
    return jsonRes(req, { ok: false, error: 'upload_failed' }, { status: 500 });
  }
}
