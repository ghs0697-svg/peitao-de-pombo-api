import { NextResponse } from 'next/server';
import { google } from 'googleapis';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Purga automática das fotos de acompanhamento com mais de 4 meses.
 * Roda por cron (ver vercel.json). Varre a pasta-raiz do Peitão, entra em cada aluno,
 * e apaga as pastas de DATA (DD-MM-AAAA) mais velhas que 120 dias.
 *
 * Auth: header do cron da Vercel (x-vercel-cron) OU Authorization: Bearer CRON_SECRET.
 */

const MAX_AGE_DAYS = 120; // 4 meses (fecha o ciclo de 3 meses + folga)

function getDrive() {
  const cid = process.env.GDRIVE_CLIENT_ID;
  const csec = process.env.GDRIVE_CLIENT_SECRET;
  const rtok = process.env.GDRIVE_REFRESH_TOKEN;
  const root = process.env.PEITAO_FOTOS_FOLDER_ID;
  if (!cid || !csec || !rtok || !root) return null;
  const oauth2 = new google.auth.OAuth2(cid, csec);
  oauth2.setCredentials({ refresh_token: rtok });
  return { drive: google.drive({ version: 'v3', auth: oauth2 }), root };
}

function parseBR(s) {
  const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(String(s || ''));
  if (!m) return null;
  const dt = new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
  return isNaN(dt.getTime()) ? null : dt;
}

export async function GET(req) {
  const secret = process.env.CRON_SECRET;
  const authHeader = req.headers.get('authorization') || '';
  const ok = req.headers.get('x-vercel-cron') || (secret && authHeader === 'Bearer ' + secret);
  if (!ok) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const d = getDrive();
  if (!d) return NextResponse.json({ ok: false, error: 'not_configured' }, { status: 503 });

  const cutoff = Date.now() - MAX_AGE_DAYS * 86400000;
  let scanned = 0, deleted = 0;
  try {
    const alunos = await d.drive.files.list({
      q: `mimeType='application/vnd.google-apps.folder' and '${d.root}' in parents and trashed=false`,
      fields: 'files(id)', pageSize: 1000,
    });
    for (const al of (alunos.data.files || [])) {
      const dates = await d.drive.files.list({
        q: `mimeType='application/vnd.google-apps.folder' and '${al.id}' in parents and trashed=false`,
        fields: 'files(id,name)', pageSize: 1000,
      });
      for (const df of (dates.data.files || [])) {
        scanned++;
        const dt = parseBR(df.name);
        if (dt && dt.getTime() < cutoff) {
          await d.drive.files.delete({ fileId: df.id }).catch(() => {});
          deleted++;
        }
      }
    }
    console.log(`fotos purge: ${scanned} pastas-data varridas, ${deleted} apagadas (> ${MAX_AGE_DAYS}d)`);
    return NextResponse.json({ ok: true, scanned, deleted });
  } catch (e) {
    console.error('fotos purge error:', e?.message || e);
    return NextResponse.json({ ok: false, error: String(e?.message || e) }, { status: 500 });
  }
}
