import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import nodemailer from 'nodemailer';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const LOCAL_LOGO_PATH = path.resolve(__dirname, '../assets/onaab-logo.png');

const RELAY_SECRET = process.env.RELAY_SECRET || 'onaab-secure-smtp-relay-2026-secret-key';
const SMTP_USER = process.env.SMTP_USER || 'hello@onaab.com';
const SMTP_PASS = process.env.SMTP_PASSWORD || 'MCCgeE8t2$A3;eN';
const SMTP_HOST = process.env.SMTP_HOST || 'smtp.hostinger.com';
const SMTP_PORT = Number(process.env.SMTP_PORT || 465);

const transporter = nodemailer.createTransport({
  host: SMTP_HOST,
  port: SMTP_PORT,
  secure: SMTP_PORT === 465,
  auth: {
    user: SMTP_USER,
    pass: SMTP_PASS,
  },
  tls: {
    rejectUnauthorized: true,
  },
});

/**
 * Safely fetch a remote image and return buffer + content type.
 * Used to convert remote images to inline CID attachments so Gmail
 * never flags the email with "Images in this message are hidden".
 */
async function fetchImageBuffer(url, timeoutMs = 3500) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ONAABMailer/1.0)' },
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const arrayBuffer = await res.arrayBuffer();
    const contentType = res.headers.get('content-type') || 'image/jpeg';
    return { buffer: Buffer.from(arrayBuffer), contentType };
  } catch (err) {
    console.warn('[Relay] Failed to fetch inline image:', url, err.message);
    return null;
  }
}

export async function handleRequest(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Health check
  if (req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'ONAAB Hostinger SMTP Relay', uptime: process.uptime() }));
    return;
  }

  if (req.method === 'POST') {
    let bodyRaw = '';
    req.on('data', chunk => { bodyRaw += chunk; });
    req.on('end', async () => {
      try {
        const body = JSON.parse(bodyRaw || '{}');
        const authHeader = req.headers.authorization || '';
        const providedSecret = body.secret || (authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '');

        if (providedSecret !== RELAY_SECRET) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized relay access' }));
          return;
        }

        const { to, subject, html, text, from, replyTo } = body;
        if (!to || !subject || (!html && !text)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing required fields: to, subject, html/text' }));
          return;
        }

        let processedHtml = html || '';
        const attachments = Array.isArray(body.attachments) ? [...body.attachments] : [];

        // 1. Process ONAAB Logo as inline CID attachment
        const hasLogoReference = processedHtml.includes('cid:onaab-logo-dark') || 
                                 processedHtml.includes('onaab-logo-dark.png');
        if (hasLogoReference && !attachments.some(a => a.cid === 'onaab-logo-dark')) {
          if (fs.existsSync(LOCAL_LOGO_PATH)) {
            attachments.push({
              filename: 'onaab-logo.png',
              path: LOCAL_LOGO_PATH,
              cid: 'onaab-logo-dark',
              contentDisposition: 'inline',
            });
          } else {
            attachments.push({
              filename: 'onaab-logo.png',
              path: 'https://onaab.com/brand/onaab-logo-dark.png',
              cid: 'onaab-logo-dark',
              contentDisposition: 'inline',
            });
          }
          processedHtml = processedHtml.replace(/https?:\/\/onaab\.com\/brand\/onaab-logo-dark\.png/g, 'cid:onaab-logo-dark');
        }

        // 2. Inlining remote item images as CID attachments to eliminate external tracking warnings
        // Matches all <img ... src="http..." ...>
        const imgSrcRegex = /<img([^>]*?)src=["'](https?:\/\/[^"']+)["']([^>]*?)>/gi;
        const matches = [...processedHtml.matchAll(imgSrcRegex)];
        let imgIndex = 0;

        for (const match of matches) {
          const fullImgTag = match[0];
          const beforeSrc = match[1];
          const rawUrl = match[2];
          const afterSrc = match[3];

          // Skip if already a cid: image or the logo
          if (rawUrl.startsWith('cid:') || rawUrl.includes('onaab-logo-dark')) {
            continue;
          }

          // Optimize Unsplash image dimensions for tiny fast email thumbnail
          let fetchUrl = rawUrl;
          if (fetchUrl.includes('images.unsplash.com')) {
            fetchUrl = fetchUrl.replace(/w=\d+/, 'w=160').replace(/h=\d+/, 'h=200');
            if (!fetchUrl.includes('w=')) fetchUrl += '&w=160&h=200&fit=crop';
          }

          imgIndex++;
          const cidName = `item-img-${imgIndex}`;
          const fetched = await fetchImageBuffer(fetchUrl, 3500);

          if (fetched) {
            attachments.push({
              filename: `item-${imgIndex}.jpg`,
              content: fetched.buffer,
              contentType: fetched.contentType,
              cid: cidName,
              contentDisposition: 'inline',
            });
            const replacement = `<img${beforeSrc}src="cid:${cidName}"${afterSrc}>`;
            processedHtml = processedHtml.replace(fullImgTag, replacement);
          } else {
            // Fallback placeholder badge if remote image cannot be fetched
            const placeholder = `<div style="width: 54px; height: 68px; background: #f3ede2; border-radius: 4px; display: inline-block; vertical-align: middle; text-align: center; border: 1px solid #e7e5e4; line-height: 68px; font-size: 10px; color: #b85338; font-weight: bold; letter-spacing: 1px;">ONAAB</div>`;
            processedHtml = processedHtml.replace(fullImgTag, placeholder);
          }
        }

        const messageId = `<${Date.now()}.${Math.random().toString(36).substring(2, 9)}@onaab.com>`;

        const info = await transporter.sendMail({
          from: from || `"ONAAB" <${SMTP_USER}>`,
          sender: SMTP_USER,
          to,
          replyTo: replyTo || SMTP_USER,
          subject,
          text: text || '',
          html: processedHtml || text,
          messageId,
          attachments,
          headers: {
            'X-Mailer': 'ONAAB Store Transactional Mailer 1.0',
            'Auto-Submitted': 'auto-generated',
            'X-Auto-Response-Suppress': 'All',
            'List-Unsubscribe': `<mailto:${SMTP_USER}?subject=Unsubscribe>`,
            'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
          },
        });

        console.log(`[Relay] Dispatched email to ${to} (Message ID: ${info.messageId}) with ${attachments.length} inline attachments`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, messageId: info.messageId, recipient: to, attachmentsCount: attachments.length }));
      } catch (err) {
        console.error('[Relay] Error sending email:', err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
}

// Vercel serverless default export
export default handleRequest;

// Standalone Node.js server (Render, Railway, Docker, or local)
const PORT = process.env.PORT || 3000;
if (process.env.NODE_ENV !== 'test' && !process.env.VERCEL) {
  const server = http.createServer(handleRequest);
  server.listen(PORT, () => {
    console.log(`[ONAAB Relay] Running on port ${PORT}`);
  });
}
