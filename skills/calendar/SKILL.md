---
name: calendar
description: >
  Manage calendar events via CalDAV: view today's agenda, see the week ahead,
  add events, update events, and delete events. Works with Nextcloud, iCloud,
  Google Calendar (via CalDAV), and any RFC 4791 server. Trigger phrases
  include "calendar today", "what's on today", "my schedule", "calendar week",
  "this week", "add event", "create event", "schedule meeting",
  "/calendar today", "/calendar week", "/calendar add", "what do I have",
  "upcoming events", "delete event", "cancel event".
---

# Calendar Integration

Manage calendar events via CalDAV (Nextcloud, Google, iCloud, etc.).

## Setup

Calendar must be configured in `.claude/claudeclaw/settings.json`:
```json
{
  "integrations": {
    "calendar": {
      "url": "https://nextcloud.example.com/remote.php/dav",
      "username": "user",
      "password": "app-password"
    }
  }
}
```

For Google Calendar CalDAV: `https://www.google.com/calendar/dav/<email>/events`
For iCloud: `https://caldav.icloud.com/`

## Commands

Use `$ARGUMENTS` to determine intent:

### /calendar today
Show today's events.
- Call `listUpcomingEvents(config, 1)` from `src/integrations/calendar.ts`
- Filter for events that overlap with today
- Display each event with `formatEvent(ev)`
- If no events: "Nothing on your calendar today."

### /calendar week
Show the next 7 days of events.
- Call `listUpcomingEvents(config, 7)`
- Group events by day
- Display with day headers and `formatEvent(ev)` for each

### /calendar add <summary> on <date> [at <time>] [to <end-time>] [details]
Create a new event.
- Parse the summary, date, start time, end time from arguments
- If no end time: default to 1 hour after start
- If no time given: create an all-day event
- Detect location ("at <place>"), description, and recurrence patterns
- Call `createEvent(config, input)`
- Confirm with event details

### /calendar list [days]
List upcoming events for N days (default 7).
- Call `listUpcomingEvents(config, days)`
- Display grouped by day

### /calendar delete <event-summary-or-uid>
Delete an event.
- First call `listUpcomingEvents(config, 30)` to find matching events
- Ask for confirmation if multiple matches
- Call `deleteEvent(config, href, etag)`
- Confirm deletion

### /calendar calendars
List available calendars.
- Call `listCalendars(config)`
- Display: name, URL, color

## Date parsing tips
- "today" → `new Date()`
- "tomorrow" → add 1 day
- "next Monday" → find next Monday
- "2pm" → 14:00 local time
- "for 2 hours" → set end = start + 2h
- All-day if no time specified

## Notes
- Always load config from settings: `getSettings().integrations?.calendar`
- Skip gracefully if calendar config is missing: inform user to configure it
- Use timezone from `getSettings().timezone` for date display
- Recurring events: show RRULE description (e.g. "weekly on Monday")
