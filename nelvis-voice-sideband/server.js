// NELVIS Voice Sideband - service serveur proprietaire.
// Controle des appels OpenAI Realtime SIP : ouverture du sideband WebSocket
// serveur-a-serveur, envoi de la salutation (response.create), maintien de la
// connexion pendant l'appel, fermeture propre a la fin.
//
// Totalement independant de l'application Base44 NELVIS Voice.
// Aucune dependance a Render, Koyeb, Railway, Vapi, Twilio ou n8n.
//
// Secrets : OPENAI_API_KEY et SIDEBAND_SECRET ne sont JAMAIS exposes dans les
// logs, dans les reponses HTTP ni dans le frontend. Ils restent cote serveur.

import 'dotenv/config';
import express from 'express';
import WebSocket from 'ws';
import crypto from 'node:crypto';

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------

const OPENAI_REALTIME_WS_BASE = 'wss://api.openai.com/v1/realtime';
const HANDSHAKE_TIMEOUT_MS = 10000;
const GREETING_INSTRUCTIONS =
  'Dis immédiatement : Bonjour, vous êtes bien chez NELVIS. Comment puis-je vous aider ?';

// ---------------------------------------------------------------------------
// Configuration et verification des variables d'environnement
// ---------------------------------------------------------------------------

const REQUIRED_ENV = ['OPENAI_API_KEY', 'OPENAI_PROJECT_ID', 'SIDEBAND_SECRET'];
const missingEnv = REQUIRED_ENV.filter((name) => !process.env[name] || !String(process.env[name]).trim());
if (missingEnv.length > 0) {
  console.error(
    JSON.stringify({ level: 'error', event: 'SIDEBAND_BOOT_MISSING_ENV', missing: missingEnv })
  );
  process.exit(1);
}

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_PROJECT_ID = process.env.OPENAI_PROJECT_ID;
const SIDEBAND_SECRET = process.env.SIDEBAND_SECRET;
const PORT = Number(process.env.PORT || 10000);

// ---------------------------------------------------------------------------
// Journalisation structuree sans secrets
// ---------------------------------------------------------------------------

// Toute valeur contenant un secret (cle API, secret sideband) est remplacee.
// Les cles sensibles sont masquees recursivement.
const SENSITIVE_KEY = /(authorization|api[-_]?key|secret|token|password)/i;
const secretValues = [OPENAI_API_KEY, SIDEBAND_SECRET].filter(
  (value) => typeof value === 'string' && value.length > 3
);

function scrubString(value) {
  let out = String(value);
  for (const secret of secretValues) {
    out = out.split(secret).join('[redacted]');
  }
  if (out.length > 500) {
    out = `${out.slice(0, 500)}...[truncated]`;
  }
  return out;
}

function scrubValue(value, depth = 0) {
  if (depth > 6 || value === null || value === undefined) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => scrubValue(item, depth + 1));
  }
  if (typeof value === 'object') {
    const masked = {};
    for (const [key, val] of Object.entries(value)) {
      masked[key] = SENSITIVE_KEY.test(key) ? '[redacted]' : scrubValue(val, depth + 1);
    }
    return masked;
  }
  if (typeof value === 'string') {
    return scrubString(value);
  }
  return value;
}

function log(level, event, data) {
  console.log(
    JSON.stringify({ ts: new Date().toISOString(), level, event, ...(scrubValue(data || {}) || {}) })
  );
}

// ---------------------------------------------------------------------------
// Comparaison a temps constant pour l'authentification interne
// ---------------------------------------------------------------------------

function safeEqual(a, b) {
  const bufferA = Buffer.from(String(a));
  const bufferB = Buffer.from(String(b));
  if (bufferA.length !== bufferB.length) {
    crypto.timingSafeEqual(bufferA, bufferA); // temps constant meme si longueurs differentes
    return false;
  }
  return crypto.timingSafeEqual(bufferA, bufferB);
}

// ---------------------------------------------------------------------------
// Gestion des sessions sideband (isolation par call_id, plusieurs appels simultanes)
// ---------------------------------------------------------------------------

const sessions = new Map(); // call_id -> { callId, ws, state, startedAt, eventCount }

function startSession(callId) {
  const existing = sessions.get(callId);
  if (
    existing &&
    (existing.ws.readyState === WebSocket.CONNECTING || existing.ws.readyState === WebSocket.OPEN)
  ) {
    return { status: 'already_active' };
  }

  const url = `${OPENAI_REALTIME_WS_BASE}?call_id=${encodeURIComponent(callId)}`;
  const ws = new WebSocket(url, {
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      'OpenAI-Project': OPENAI_PROJECT_ID
    },
    handshakeTimeout: HANDSHAKE_TIMEOUT_MS
  });

  const session = { callId, ws, state: 'connecting', startedAt: Date.now(), eventCount: 0 };
  sessions.set(callId, session);

  ws.on('open', () => {
    session.state = 'connected';
    log('info', 'SIDEBAND_CONNECTED', { call_id: callId });
    const greeting = {
      type: 'response.create',
      response: { instructions: GREETING_INSTRUCTIONS }
    };
    ws.send(JSON.stringify(greeting), (error) => {
      if (error) {
        log('error', 'SIDEBAND_GREETING_SEND_ERROR', { call_id: callId, message: error.message });
        return;
      }
      log('info', 'SIDEBAND_GREETING_SENT', { call_id: callId });
    });
  });

  ws.on('message', (raw) => {
    session.eventCount += 1;
    let parsed = null;
    let eventType = 'unknown';
    try {
      parsed = JSON.parse(raw.toString());
      eventType = (parsed && parsed.type) || 'unknown';
    } catch (parseError) {
      eventType = 'invalid_json';
    }
    log('info', 'SIDEBAND_EVENT', { call_id: callId, event_type: eventType });

    if (eventType === 'response.done') {
      log('info', 'SIDEBAND_RESPONSE_DONE', { call_id: callId, event_count: session.eventCount });
    }
    if (eventType === 'error' && parsed && parsed.error) {
      log('error', 'SIDEBAND_OPENAI_ERROR', {
        call_id: callId,
        error: scrubValue(parsed.error)
      });
    }
    if (eventType === 'session.closed') {
      log('info', 'SIDEBAND_CALL_ENDED', { call_id: callId, event_count: session.eventCount });
      closeSession(callId, 'session.closed');
    }
  });

  ws.on('close', (code, reason) => {
    session.state = 'closed';
    sessions.delete(callId);
    log('info', 'SIDEBAND_CLOSED', {
      call_id: callId,
      code,
      reason: reason ? reason.toString().slice(0, 200) : '',
      duration_s: Math.round((Date.now() - session.startedAt) / 1000),
      event_count: session.eventCount
    });
  });

  ws.on('error', (error) => {
    log('error', 'SIDEBAND_WS_ERROR', { call_id: callId, message: scrubString(error.message) });
  });

  return { status: 'starting' };
}

function closeSession(callId, reason) {
  const session = sessions.get(callId);
  if (!session) {
    return;
  }
  try {
    session.ws.close(1000, String(reason).slice(0, 100));
  } catch (error) {
    log('warn', 'SIDEBAND_CLOSE_ERROR', { call_id: callId, message: scrubString(error.message) });
  }
}

// ---------------------------------------------------------------------------
// API HTTP Express
// ---------------------------------------------------------------------------

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '10kb' }));

// Authentification interne par secret serveur (Bearer SIDEBAND_SECRET)
function requireSidebandAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token || !safeEqual(token, SIDEBAND_SECRET)) {
    log('warn', 'SIDEBAND_AUTH_REJECTED', { path: req.path });
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

app.get('/', (req, res) => {
  res.json({ service: 'nelvis-voice-sideband', status: 'ok' });
});

app.get('/health', (req, res) => {
  const connected = [...sessions.values()].filter((s) => s.state === 'connected').length;
  res.json({
    status: 'ok',
    service: 'nelvis-voice-sideband',
    uptime_seconds: Math.floor(process.uptime()),
    active_sessions: sessions.size,
    connected_sessions: connected
  });
});

// POST /sideband/start - declenche l'ouverture du sideband pour un appel.
// Non bloquant : la connexion WebSocket s'ouvre en arriere-plan, la reponse
// HTTP est immediate (l'acceptation SIP deja reussie ne doit jamais echouer
// a cause du sideband).
app.post('/sideband/start', requireSidebandAuth, (req, res) => {
  const callId = req.body ? req.body.call_id : undefined;
  if (typeof callId !== 'string' || callId.trim().length < 3 || callId.length > 200) {
    return res.status(400).json({ error: 'invalid call_id' });
  }
  const result = startSession(callId.trim());
  log('info', 'SIDEBAND_START_REQUESTED', { call_id: callId.trim(), result: result.status });
  res.status(200).json({ status: result.status, call_id: callId.trim() });
});

app.use((req, res) => {
  res.status(404).json({ error: 'not found' });
});

// Gestionnaire d'erreurs final : jamais de stack trace ni de secret en reponse
// eslint-disable-next-line no-unused-vars
app.use((error, req, res, next) => {
  log('error', 'SIDEBAND_HTTP_ERROR', { path: req.path, message: scrubString(error.message || 'unknown') });
  res.status(500).json({ error: 'internal error' });
});

const server = app.listen(PORT, '0.0.0.0', () => {
  log('info', 'SIDEBAND_LISTENING', { port: PORT });
});

// ---------------------------------------------------------------------------
// Arret propre : fermeture de toutes les sessions sideband puis du serveur HTTP
// ---------------------------------------------------------------------------

let shuttingDown = false;

function shutdown(signal) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  log('info', 'SIDEBAND_SHUTDOWN', { signal, active_sessions: sessions.size });
  for (const session of sessions.values()) {
    try {
      session.ws.close(1000, 'server shutdown');
    } catch (error) {
      // fermeture deja effectuee : ignorer
    }
  }
  server.close(() => process.exit(0));
  // Filet de securite : sortir meme si des connexions HTTP trainent
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));