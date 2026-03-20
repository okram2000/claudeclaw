---
name: home
description: >
  Control smart home devices via Home Assistant. Use when user asks about lights,
  climate, thermostat, switches, sensors, covers/blinds, media players, or scenes.
  Trigger phrases: "turn on/off the lights", "set temperature", "home status",
  "what's my home doing", "activate scene", "/home", "turn off living room",
  "dim the lights", "open/close blinds", "what temperature is it", "how warm is it",
  "play/pause media", "smart home", "home assistant", "all lights off".
---

# Smart Home Control

Control and query Home Assistant smart home devices. Parse `$ARGUMENTS` to determine
what the user wants to do.

## What you can do

- **Status overview** — list all devices grouped by domain with their current states
- **Lights** — turn on/off, toggle, dim (brightness 0–255), change color temperature
- **Climate** — read current temperature, set target temperature, change HVAC mode
- **Switches / input booleans** — turn on/off/toggle
- **Covers / blinds** — open, close, stop, toggle
- **Media players** — turn on/off, play/pause, set volume
- **Scenes** — activate by name or entity_id
- **Sensors** — read current value (temperature, humidity, power, etc.)
- **Entity search** — find entities by partial name when exact ID is unknown

## How to use the Home Assistant client

The HA client is available via `src/homeassistant.ts`. Import and use it like this:

```typescript
import { getSettings } from "./src/config";
import {
  checkConnection, getAllStates, getState, getStatusSummary,
  turnOn, turnOff, toggleEntity, setTemperature, setHvacMode,
  activateScene, setVolume, controlCover, getHistory, findEntity,
  getEntitiesByDomain, callService,
} from "./src/homeassistant";

const { homeassistant: config } = getSettings();
// config = { baseUrl, token, defaultEntities, enabled }
```

## Common command patterns

### `/home status` or "home status"
Call `getStatusSummary(config)` and display the result.

### `/home lights` or "show me the lights"
Call `getEntitiesByDomain(config, "light")` and list all lights with their state,
brightness %, and friendly name.

### `/home climate` or "check the thermostat"
Call `getEntitiesByDomain(config, "climate")` and show each entity's state,
current temperature, target temperature, and HVAC mode.

### `/home <entity> on` / `/home <entity> off` / `/home <entity> toggle`
Use `findEntity(config, <entity>)` to locate the entity, then call
`turnOn`, `turnOff`, or `toggleEntity` accordingly.

### `/home scene <name>` or "activate scene <name>"
Use `findEntity(config, <name>)` filtered to `scene.` entities,
then call `activateScene(config, entityId)`.

### Natural language like "turn off the living room lights"
Parse the intent, use `findEntity(config, "living room")` or
`getEntitiesByDomain(config, "light")` filtered by friendly name,
then call the appropriate service.

### "set temperature to 22" / "set thermostat to 68°F"
Find the climate entity with `getEntitiesByDomain(config, "climate")`,
then call `setTemperature(config, entityId, temperature)`.

### "dim the kitchen lights to 50%"
Convert 50% → brightness 128 (0-255 scale), find entity, call
`turnOn(config, entityId, { brightness: 128 })`.

## Error handling

- Always wrap HA calls in try/catch — if HA is unreachable, report clearly
- Check `config.enabled` and warn if Home Assistant is not configured
- If entity lookup returns null, suggest the user check the entity name

## Configuration reminder

Home Assistant must be configured in `.claude/claudeclaw/settings.json`:
```json
{
  "homeassistant": {
    "enabled": true,
    "baseUrl": "http://homeassistant.local:8123",
    "token": "your-long-lived-access-token",
    "defaultEntities": []
  }
}
```

Tokens are created at: HA Profile → Long-Lived Access Tokens.
