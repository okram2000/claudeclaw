# Alexa Skill Setup Guide

This guide walks you through creating and deploying a ClaudeClaw Alexa skill so you can talk to Claw on any Echo device.

## Overview

The Alexa integration works by:
1. Running a local HTTP server (default port 3456) that handles Alexa Skill requests
2. Exposing that server via an HTTPS tunnel (Alexa requires HTTPS with a valid cert)
3. Linking the tunnel URL to your Alexa Skill in the Amazon Developer Console

**Invocation:** "Alexa, ask claw [your question]"

---

## Prerequisites

- An Amazon account (free developer account at developer.amazon.com)
- An Echo device or the Alexa simulator (both work)
- A tunnel tool: `cloudflared` (recommended) or `ngrok`

---

## Step 1: Enable the Alexa Integration

Edit `.claude/claudeclaw/settings.json` and add/update the `alexa` block:

```json
{
  "alexa": {
    "enabled": true,
    "port": 3456,
    "skillId": "",
    "allowedUserIds": [],
    "skipVerification": true,
    "tunnelType": "cloudflared"
  }
}
```

> **Note:** `skipVerification: true` is fine during development. Set it to `false` once you have your skill ID configured and everything working.

---

## Step 2: Create the Alexa Skill

1. Go to **https://developer.amazon.com/alexa/console/ask** and sign in
2. Click **Create Skill**
3. Fill in:
   - **Skill name:** Claw (or whatever you prefer)
   - **Primary locale:** English (US)
   - **Model:** Custom
   - **Hosting:** Provision your own
4. Click **Next**, choose **Start from scratch** template
5. Click **Create skill**

You'll land on the skill build dashboard.

---

## Step 3: Import the Interaction Model

1. In the left sidebar, click **Interaction Model** → **JSON Editor**
2. Open `src/alexa-skill-manifest.json` from this project
3. Copy the entire `interactionModel` object (the value of the `"interactionModel"` key)
4. Paste it into the JSON Editor, replacing any existing content
5. Click **Save Model**
6. Click **Build Model** and wait for it to complete (usually 30–60 seconds)

**Sample utterances included:**
- "ask claw {Query}"
- "tell claw {Query}"
- "what's your status"
- "are you online"
- "help"

---

## Step 4: Start the Local Server

Start the ClaudeClaw daemon with the Alexa flag:

```bash
bun run src/index.ts start --trigger --alexa
```

Or start the Alexa server standalone:

```bash
bun run src/index.ts alexa
```

You should see:
```
Alexa skill endpoint listening on http://0.0.0.0:3456
  [WARNING] Signature verification disabled — do NOT use in production
  Skill ID: (not configured)
```

---

## Step 5: Create an HTTPS Tunnel

Alexa requires a publicly accessible **HTTPS** endpoint. Use a tunnel tool:

### Option A: cloudflared (recommended — free, no account needed)

```bash
# Install
brew install cloudflared
# or: curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o cloudflared && chmod +x cloudflared

# Start tunnel
cloudflared tunnel --url http://localhost:3456
```

cloudflared will print something like:
```
https://random-words.trycloudflare.com
```

Copy that URL.

**Auto-start with daemon:** Set `alexa.tunnelType = "cloudflared"` in settings.json and claudeclaw will start the tunnel automatically.

### Option B: ngrok

```bash
# Install
brew install ngrok

# Start tunnel
ngrok http 3456
```

ngrok shows a `Forwarding` line with an `https://` URL. Copy it.

**Auto-start with daemon:** Set `alexa.tunnelType = "ngrok"` in settings.json.

---

## Step 6: Configure the Skill Endpoint

1. In the Alexa Developer Console, go to **Build** → **Endpoint**
2. Select **HTTPS**
3. In **Default Region**, paste your `https://` tunnel URL
4. Under **SSL certificate type**, select:
   > "My development endpoint is a sub-domain of a domain that has a wildcard certificate from a certificate authority"
5. Click **Save Endpoints**

---

## Step 7: Note Your Skill ID

1. At the top of the **Endpoint** page you'll see your **Skill ID** (format: `amzn1.ask.skill.xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`)
2. Copy it and add it to settings.json:

```json
{
  "alexa": {
    "skillId": "amzn1.ask.skill.YOUR-SKILL-ID-HERE",
    "skipVerification": false
  }
}
```

Setting the skill ID enables verification that requests actually come from your skill (not random internet traffic).

---

## Step 8: Test with the Alexa Simulator

1. In the Alexa Developer Console, go to **Test**
2. Set the dropdown to **Development**
3. In the text input, type: `ask claw what's my status`
4. You should hear/see Claw's response

Try more:
- "ask claw to help me write a commit message"
- "ask claw what time is it"
- "ask claw are you running"

---

## Step 9: Test on a Real Echo Device

1. Make sure your Echo device is signed in to the **same Amazon account** as your developer account
2. Go to your Alexa app → **Skills & Games** → **Your Skills** → **Dev tab**
3. Your "Claw" skill should appear — enable it if needed
4. Say: **"Alexa, ask claw what's my status"**

---

## Troubleshooting

### "Skill response was a bad request"
- The skill server isn't running, or the tunnel URL changed
- Check the server is running on port 3456
- Verify the tunnel URL in the endpoint config matches the current tunnel

### "I wasn't able to reach the requested skill"
- The endpoint URL is wrong or the tunnel has stopped
- Restart the tunnel and update the endpoint URL in the Alexa console

### Timeout errors ("I'm having trouble reaching your skill")
- Claude Code is taking too long to respond
- Progressive responses should extend the timeout — check that your network allows outbound requests to `api.amazonalexa.com`
- For very slow responses, consider using a faster model

### Signature verification failures (403 in logs)
- Set `alexa.skipVerification = true` during development
- Once your skill ID is set and it's working, set it back to `false`

### Request rejected: skill ID mismatch
- Your skill ID in settings.json doesn't match the one in the Amazon console
- Copy the exact skill ID from the Endpoint page

---

## Production Setup (Optional)

For a permanent, stable setup:

1. **Use a static domain** instead of a tunnel (e.g., a home server with Dynamic DNS)
2. **Get a TLS certificate** from Let's Encrypt (`certbot`)
3. **Run behind nginx** or `caddy` as a reverse proxy:
   ```nginx
   server {
     listen 443 ssl;
     server_name your-domain.com;
     ssl_certificate /etc/letsencrypt/live/your-domain.com/fullchain.pem;
     ssl_certificate_key /etc/letsencrypt/live/your-domain.com/privkey.key;
     location / {
       proxy_pass http://localhost:3456;
       proxy_set_header Host $host;
     }
   }
   ```
4. Set `alexa.skipVerification = false` (signature verification enabled)
5. Select "My development endpoint has a certificate from a trusted certificate authority" in the Alexa console

---

## Quick Reference

| Setting | Description | Example |
|---------|-------------|---------|
| `alexa.enabled` | Enable the Alexa server | `true` |
| `alexa.port` | Local server port | `3456` |
| `alexa.skillId` | Alexa Skill ID from console | `amzn1.ask.skill.xxx` |
| `alexa.allowedUserIds` | Restrict to specific Alexa users (empty = all) | `["amzn1.ask.account.xxx"]` |
| `alexa.skipVerification` | Skip request signature check (dev only) | `false` |
| `alexa.tunnelType` | Auto-start tunnel | `"cloudflared"` |

Start daemon: `bun run src/index.ts start --trigger --alexa`

Standalone server: `bun run src/index.ts alexa`
