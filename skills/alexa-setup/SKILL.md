---
name: alexa-setup
description: Interactive guide to configure and start the Alexa voice integration
---

# /alexa-setup — Alexa Skill Setup Guide

Help the user set up the Alexa integration for ClaudeClaw. Walk them through each step interactively.

## What you should do

1. **Check current config** — Read `.claude/claudeclaw/settings.json` and report the current `alexa` block. Tell the user which fields are set and which are missing.

2. **Guide through setup steps** — Walk the user through these steps in order:

   ### Step 1: Enable the integration
   Set `alexa.enabled = true` in settings.json. Also set `alexa.skipVerification = true` for local development (they can disable it later when production-ready).

   ### Step 2: Create an Alexa Skill
   Tell the user to:
   - Go to https://developer.amazon.com/alexa/console/ask
   - Sign in (free Amazon Developer account)
   - Click "Create Skill"
   - Name: "Claw" (or their preferred name)
   - Primary locale: English (US)
   - Model: Custom
   - Hosting: Provision your own
   - Template: Start from scratch
   - Click "Create skill"

   ### Step 3: Import the interaction model
   Tell the user to:
   - In the skill console, go to "Build" → "Interaction Model" → "JSON Editor"
   - Paste the contents of `src/alexa-skill-manifest.json` (the `interactionModel` section)
   - Click "Save Model" then "Build Model"

   ### Step 4: Start the skill server
   Tell the user to run:
   ```
   bun run src/index.ts start --trigger --alexa
   ```
   Or if just testing the Alexa endpoint standalone:
   ```
   bun run src/index.ts alexa
   ```

   ### Step 5: Set up HTTPS tunnel
   Alexa requires HTTPS. Tell the user to run one of:
   - `cloudflared tunnel --url http://localhost:3456` (recommended, free)
   - `ngrok http 3456`

   The tunnel tool will print an `https://` URL. Copy it.

   Alternatively, set `alexa.tunnelType = "cloudflared"` in settings.json and claudeclaw will start the tunnel automatically.

   ### Step 6: Configure the endpoint in Amazon Console
   Tell the user to:
   - In the Alexa skill console, go to "Build" → "Endpoint"
   - Select "HTTPS"
   - Paste the `https://` tunnel URL into "Default Region"
   - Select "My development endpoint is a sub-domain of a domain that has a wildcard certificate from a certificate authority"
   - Click "Save Endpoints"

   ### Step 7: Get the Skill ID
   Tell the user to:
   - Copy the Skill ID from the top of the endpoint page (starts with `amzn1.ask.skill.`)
   - Add it to settings.json: `alexa.skillId = "amzn1.ask.skill.YOUR-ID-HERE"`

   ### Step 8: Test the skill
   Tell the user to:
   - In the Alexa console, go to "Test" → enable "Development"
   - Type or say: "ask claw what's my status"
   - Or test on a real Echo device linked to the same Amazon account

3. **Verify it works** — After the user reports success or failure, help debug any issues by:
   - Checking the server is running on the correct port
   - Verifying the tunnel URL is HTTPS and reachable
   - Checking the skill ID matches what's in the console
   - Looking at the server logs for rejected requests

4. **Link to full guide** — Tell the user the full setup guide is at `deploy/alexa-setup-guide.md`.
