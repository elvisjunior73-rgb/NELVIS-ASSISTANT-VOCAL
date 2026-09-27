# NELVIS Voice Sideband

Service serveur propriétaire permettant de contrôler les appels **OpenAI Realtime SIP** :
ouverture d'une connexion **sideband WebSocket serveur-à-serveur** vers OpenAI,
envoi immédiat de la salutation (`response.create`), maintien de la connexion
pendant toute la durée de l'appel et fermeture propre à la fin.

Service **Node.js autonome** (Node.js 20+, Express, `ws`), destiné à être installé
sur un VPS Hetzner (Ubuntu 24.04, systemd, Nginx).
Aucune dépendance à Render, Koyeb, Railway, Vapi, Twilio ou n8n.

---

## Architecture

```
Zadarma
  → OpenAI Realtime SIP
  → Webhook Base44 (openaiWebhook)
  → POST /v1/realtime/calls/{call_id}/accept   (acceptation, inchangée)
  → POST https://<ce-service>/sideband/start   (call_id transmis, non bloquant)
  → Sideband NELVIS (ce projet)
      → wss://api.openai.com/v1/realtime?call_id={call_id}
         (Authorization: Bearer OPENAI_API_KEY, OpenAI-Project)
      → response.create  →  voix NELVIS
```

Le point d'entrée `/sideband/start` répond immédiatement : l'échec éventuel du
sideband ne fait jamais échouer l'acceptation SIP déjà réussie.

## Endpoints

| Méthode | Chemin | Authentification | Réponse |
|---|---|---|---|
| `GET` | `/` | aucune | `{ "service": "nelvis-voice-sideband", "status": "ok" }` |
| `GET` | `/health` | aucune | statut, uptime, sessions actives/connectées |
| `POST` | `/sideband/start` | `Authorization: Bearer SIDEBAND_SECRET` | `{ "status": "starting", "call_id": "rtc_..." }` (ou `already_active` si la session existe déjà) |

Corps attendu par `/sideband/start` :

```json
{ "call_id": "rtc_..." }
```

Comportement déclenché :

1. vérification du `SIDEBAND_SECRET` (comparaison à temps constant) ;
2. validation du `call_id` ;
3. ouverture de `wss://api.openai.com/v1/realtime?call_id={call_id}` avec les
   en-têtes `Authorization: Bearer OPENAI_API_KEY` et `OpenAI-Project` ;
4. à l'ouverture : envoi immédiat de
   `{ "type": "response.create", "response": { "instructions": "Dis immédiatement : Bonjour, vous êtes bien chez NELVIS. Comment puis-je vous aider ?" } }` ;
5. maintien de la connexion pendant l'appel, événements journalisés ;
6. fermeture propre à la réception de `session.closed` ou à l'arrêt du service.

## Garanties techniques

- **Node.js 20+**, ESM, dépendances : `express`, `ws`, `dotenv`.
- **Écoute sur le port interne 10000** (configurable via `PORT`).
- **Plusieurs appels simultanés** : sessions isolées par `call_id` (Map) — une
  erreur sur une session n'arrête ni le serveur ni les autres appels.
- **Timeout de connexion OpenAI** : 10 secondes (handshake).
- **Pas de double connexion** : un `call_id` déjà actif renvoie `already_active`.
- **Fermeture propre** : `session.closed` → fermeture code 1000 ; `SIGTERM`/`SIGINT`
  → fermeture de toutes les sessions puis arrêt du serveur HTTP.
- **Logs sans secrets** : toute occurrence de la clé API ou du `SIDEBAND_SECRET`
  est masquée (`[redacted]`), clés sensibles filtrées récursivement, valeurs
  tronquées à 500 caractères.
- **Sécurité HTTP** : corps JSON limité à 10 Ko, aucune stack trace en réponse,
  en-tête `x-powered-by` désactivé, 401 sur authentification invalide.

## Variables d'environnement

| Variable | Obligatoire | Description |
|---|---|---|
| `OPENAI_API_KEY` | oui | Clé API OpenAI du projet du trunk (jamais exposée) |
| `OPENAI_PROJECT_ID` | oui | En-tête `OpenAI-Project` obligatoire |
| `SIDEBAND_SECRET` | oui | Secret d'authentification interne (`openssl rand -hex 32`) |
| `PORT` | non | Port d'écoute, défaut `10000` |

Aucune vraie clé ne figure dans ce dépôt : `.env.example` contient uniquement
des valeurs vides, `.gitignore` exclut `.env`.

---

## 1. Lancement local

```bash
cd nelvis-voice-sideband
cp .env.example .env
# renseigner OPENAI_API_KEY, OPENAI_PROJECT_ID, SIDEBAND_SECRET dans .env

npm install
npm start
```

Vérifications :

```bash
curl http://localhost:10000/
curl http://localhost:10000/health

# déclenchement d'une session (call_id réel rtc_... uniquement) :
curl -X POST http://localhost:10000/sideband/start \
  -H "Authorization: Bearer $SIDEBAND_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"call_id":"rtc_EXEMPLE"}'
```

## 2. Installation sur Ubuntu 24.04 (VPS Hetzner)

```bash
# Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v   # doit afficher v20.x

# utilisateur dédié sans shell
sudo useradd --system --home /opt/nelvis-voice-sideband --shell /usr/sbin/nologin nelvis-sideband

# déploiement du projet
sudo mkdir -p /opt/nelvis-voice-sideband
sudo cp -r nelvis-voice-sideband/. /opt/nelvis-voice-sideband/
cd /opt/nelvis-voice-sideband
sudo -u nelvis-sideband npm install --omit=dev

# secrets
sudo -e /opt/nelvis-voice-sideband/.env   # renseigner les 3 secrets + PORT
sudo chown -R nelvis-sideband:nelvis-sideband /opt/nelvis-voice-sideband
sudo chmod 600 /opt/nelvis-voice-sideband/.env
```

## 3. Lancement avec systemd

Créer `/etc/systemd/system/nelvis-sideband.service` :

```ini
[Unit]
Description=NELVIS Voice Sideband
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=nelvis-sideband
Group=nelvis-sideband
WorkingDirectory=/opt/nelvis-voice-sideband
EnvironmentFile=/opt/nelvis-voice-sideband/.env
Environment=NODE_ENV=production
ExecStart=/usr/bin/node /opt/nelvis-voice-sideband/server.js
Restart=always
RestartSec=3

# durcissement
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/nelvis-voice-sideband

[Install]
WantedBy=multi-user.target
```

Puis :

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now nelvis-sideband
sudo systemctl status nelvis-sideband
sudo journalctl -u nelvis-sideband -f          # suivre les logs (sans secrets)
```

## 4. Ports

| Port | Sens | Usage |
|---|---|---|
| `10000/tcp` | interne | API HTTP du sideband — ne PAS ouvrir publiquement (proxy Nginx local `127.0.0.1:10000`) |
| `443/tcp` | sortant | `wss://api.openai.com` (obligatoire) |
| `22/tcp` | entrant | SSH |
| `80, 443/tcp` | entrant | Nginx / Let's Encrypt |

Firewall conseillé (`ufw`) : autoriser uniquement `22`, `80` et `443` en entrée.

## 5. HTTPS / Nginx — prérequis

1. **DNS** : enregistrement `A` sur un sous-domaine dédié, par exemple
   `sideband.nelvis-france.com → IP du VPS`
   (aucune modification de `www.nelvis-france.com`, MX, SPF ou DKIM).
2. **Nginx** :

```bash
sudo apt-get install -y nginx certbot python3-certbot-nginx
```

Configuration `/etc/nginx/sites-available/nelvis-sideband` :

```nginx
server {
    listen 80;
    server_name sideband.nelvis-france.com;

    location / {
        proxy_pass http://127.0.0.1:10000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 3600s;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/nelvis-sideband /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d sideband.nelvis-france.com
```

3. **Base44** (ultérieurement, après validation) : `openaiWebhook` appellera
   `https://sideband.nelvis-france.com/sideband/start` avec
   `Authorization: Bearer SIDEBAND_SECRET`. Aucune modification du webhook,
   de Zadarma, d'OpenAI ou du DNS existant tant que le sideband n'est pas validé.

## Test complet (après déploiement)

1. `curl https://sideband.nelvis-france.com/` → `{ "service": "nelvis-voice-sideband", "status": "ok" }`
2. `curl https://sideband.nelvis-france.com/health` → `status: ok`
3. `POST /sideband/start` sans `Authorization` → `401`
4. `POST /sideband/start` avec `call_id` réel (rtc_...) → `status: starting`, logs `SIDEBAND_CONNECTED` puis `SIDEBAND_GREETING_SENT`
5. Appel réel vers le numéro NELVIS → l'appelant entend la salutation puis peut dialoguer normalement.

---

## Sécurité

`OPENAI_API_KEY`, `OPENAI_PROJECT_ID` et `SIDEBAND_SECRET` restent strictement
côté serveur (fichier `.env` en permission 600, jamais versionné). Ils
n'apparaissent jamais dans les logs, les réponses HTTP, le frontend ou la ligne
de commande du process (`systemd` les charge depuis `EnvironmentFile`).