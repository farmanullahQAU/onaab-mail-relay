import http from 'node:http';
import nodemailer from 'nodemailer';

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

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

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

        const attachments = Array.isArray(body.attachments) ? [...body.attachments] : [];
        if (html && (html.includes('cid:onaab-logo-dark') || html.includes('https://onaab.com/brand/onaab-logo-dark.png')) && !attachments.some(a => a.cid === 'onaab-logo-dark')) {
          attachments.push({
            filename: 'onaab-logo.png',
            path: 'https://onaab.com/brand/onaab-logo-dark.png',
            cid: 'onaab-logo-dark',
          });
        }

        // Replace remote logo URL with CID inline reference for clients
        const processedHtml = html ? html.replace('https://onaab.com/brand/onaab-logo-dark.png', 'cid:onaab-logo-dark') : html;

        const info = await transporter.sendMail({
          from: from || `ONAAB <${SMTP_USER}>`,
          to,
          replyTo: replyTo || SMTP_USER,
          subject,
          text: text || '',
          html: processedHtml || text,
          attachments,
        });

        console.log(`[Relay] Dispatched email to ${to} (Message ID: ${info.messageId})`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, messageId: info.messageId, recipient: to }));
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
