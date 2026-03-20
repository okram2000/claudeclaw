/**
 * CalDAV calendar integration via tsdav.
 * Supports Nextcloud, Google Calendar (via CalDAV), iCloud, and any RFC 4791 server.
 */

import type { DAVCalendar, DAVCalendarObject } from "tsdav";

export interface CalendarConfig {
  url: string;
  username: string;
  password: string;
}

export interface CalEvent {
  uid: string;
  summary: string;
  description?: string;
  location?: string;
  start: Date;
  end: Date;
  allDay: boolean;
  recurrenceRule?: string;
  /** Raw ICS VCALENDAR string */
  ics: string;
  /** CalDAV object URL for updates/deletes */
  href?: string;
  /** CalDAV etag for conflict detection */
  etag?: string;
}

export interface NewEventInput {
  summary: string;
  description?: string;
  location?: string;
  start: Date;
  end: Date;
  allDay?: boolean;
  recurrenceRule?: string;
  /** IANA timezone name, e.g. "America/New_York" */
  timezone?: string;
  reminders?: number[]; // minutes before event
}

// ---------------------------------------------------------------------------
// ICS helpers
// ---------------------------------------------------------------------------

function generateUid(): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `${Date.now()}-${rand}@claudeclaw`;
}

function formatIcsDate(date: Date, allDay: boolean, timezone?: string): string {
  if (allDay) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    return `${y}${m}${d}`;
  }

  if (timezone) {
    // Local time with TZID
    const pad = (n: number) => String(n).padStart(2, "0");
    return [
      date.getFullYear(),
      pad(date.getMonth() + 1),
      pad(date.getDate()),
      "T",
      pad(date.getHours()),
      pad(date.getMinutes()),
      pad(date.getSeconds()),
    ].join("");
  }

  // UTC
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

function dateProperty(
  prop: "DTSTART" | "DTEND",
  date: Date,
  allDay: boolean,
  timezone?: string
): string {
  if (allDay) return `${prop};VALUE=DATE:${formatIcsDate(date, true)}`;
  if (timezone) return `${prop};TZID=${timezone}:${formatIcsDate(date, false, timezone)}`;
  return `${prop}:${formatIcsDate(date, false)}`;
}

function buildIcs(input: NewEventInput, uid = generateUid()): string {
  const now = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const tz = input.timezone;
  const allDay = input.allDay ?? false;

  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//ClaudeClaw//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${now}`,
    `DTCREATED:${now}`,
    dateProperty("DTSTART", input.start, allDay, tz),
    dateProperty("DTEND", input.end, allDay, tz),
    `SUMMARY:${escapeIcs(input.summary)}`,
  ];

  if (input.description) lines.push(`DESCRIPTION:${escapeIcs(input.description)}`);
  if (input.location) lines.push(`LOCATION:${escapeIcs(input.location)}`);
  if (input.recurrenceRule) lines.push(`RRULE:${input.recurrenceRule}`);

  if (input.reminders && input.reminders.length > 0) {
    for (const minutes of input.reminders) {
      lines.push(
        "BEGIN:VALARM",
        "ACTION:DISPLAY",
        `DESCRIPTION:Reminder`,
        `TRIGGER:-PT${minutes}M`,
        "END:VALARM"
      );
    }
  }

  lines.push("END:VEVENT", "END:VCALENDAR");
  return lines.join("\r\n") + "\r\n";
}

function escapeIcs(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
}

function unescapeIcs(value: string): string {
  return value.replace(/\\n/g, "\n").replace(/\\,/g, ",").replace(/\\;/g, ";").replace(/\\\\/g, "\\");
}

// ---------------------------------------------------------------------------
// ICS parser — minimal VEVENT extraction
// ---------------------------------------------------------------------------

function parseIcsDate(value: string): { date: Date; allDay: boolean } {
  // DATE-only: YYYYMMDD
  if (/^\d{8}$/.test(value)) {
    const y = Number(value.slice(0, 4));
    const m = Number(value.slice(4, 6)) - 1;
    const d = Number(value.slice(6, 8));
    return { date: new Date(y, m, d), allDay: true };
  }

  // DATE-TIME: YYYYMMDDTHHMMSSZ or YYYYMMDDTHHMMSS (local)
  const m = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (m) {
    const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${m[7] || ""}`;
    return { date: new Date(iso), allDay: false };
  }

  return { date: new Date(value), allDay: false };
}

export function parseIcsEvent(ics: string): Omit<CalEvent, "href" | "etag"> | null {
  const veventMatch = ics.match(/BEGIN:VEVENT([\s\S]*?)END:VEVENT/);
  if (!veventMatch) return null;

  const block = veventMatch[1];

  // Unfold long lines (RFC 5545 line folding: \r\n + whitespace)
  const unfolded = block.replace(/\r?\n[ \t]/g, "");
  const lines = unfolded.split(/\r?\n/);

  const props: Record<string, string> = {};
  for (const line of lines) {
    const sep = line.indexOf(":");
    if (sep < 0) continue;
    // Strip parameters: e.g. DTSTART;TZID=America/NY → key = DTSTART
    const rawKey = line.slice(0, sep);
    const key = rawKey.split(";")[0].toUpperCase();
    const val = line.slice(sep + 1).trim();
    props[key] = val;
  }

  const uid = props["UID"] ?? generateUid();
  const summary = unescapeIcs(props["SUMMARY"] ?? "(no title)");
  const description = props["DESCRIPTION"] ? unescapeIcs(props["DESCRIPTION"]) : undefined;
  const location = props["LOCATION"] ? unescapeIcs(props["LOCATION"]) : undefined;
  const rrule = props["RRULE"];

  const dtstart = props["DTSTART"] ?? "";
  const dtend = props["DTEND"] ?? props["DUE"] ?? "";

  const { date: start, allDay } = parseIcsDate(dtstart);
  const { date: end } = dtend ? parseIcsDate(dtend) : { date: new Date(start.getTime() + 3600_000) };

  return { uid, summary, description, location, start, end, allDay, recurrenceRule: rrule, ics };
}

// ---------------------------------------------------------------------------
// DAV client factory (lazy import so missing dep doesn't break the module)
// ---------------------------------------------------------------------------

async function makeClient(config: CalendarConfig) {
  const { createDAVClient } = await import("tsdav");
  return createDAVClient({
    serverUrl: config.url,
    credentials: { username: config.username, password: config.password },
    authMethod: "Basic",
    defaultAccountType: "caldav",
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Fetch upcoming events within the next `days` days (default 7). */
export async function listUpcomingEvents(
  config: CalendarConfig,
  days = 7
): Promise<CalEvent[]> {
  const client = await makeClient(config);
  const calendars: DAVCalendar[] = await client.fetchCalendars();

  const now = new Date();
  const rangeEnd = new Date(now.getTime() + days * 86_400_000);
  const events: CalEvent[] = [];

  for (const calendar of calendars) {
    let objects: DAVCalendarObject[];
    try {
      objects = await client.fetchCalendarObjects({
        calendar,
        timeRange: { start: now.toISOString(), end: rangeEnd.toISOString() },
      });
    } catch {
      continue;
    }

    for (const obj of objects) {
      const ics = obj.data as string;
      if (!ics) continue;
      const parsed = parseIcsEvent(ics);
      if (!parsed) continue;
      events.push({
        ...parsed,
        ics,
        href: obj.url,
        etag: obj.etag,
      });
    }
  }

  events.sort((a, b) => a.start.getTime() - b.start.getTime());
  return events;
}

/** List all available calendars. */
export async function listCalendars(
  config: CalendarConfig
): Promise<Array<{ displayName: string; url: string; color?: string }>> {
  const client = await makeClient(config);
  const calendars: DAVCalendar[] = await client.fetchCalendars();
  return calendars.map((c) => {
    const name = typeof c.displayName === "string" ? c.displayName : c.url;
    return {
      displayName: name,
      url: c.url,
      color: (c as Record<string, unknown>)["apple-calendar-color"] as string | undefined,
    };
  });
}

/** Create a new calendar event. Returns the created event. */
export async function createEvent(
  config: CalendarConfig,
  input: NewEventInput,
  calendarUrl?: string
): Promise<CalEvent> {
  const client = await makeClient(config);
  const calendars: DAVCalendar[] = await client.fetchCalendars();

  const calendar = calendarUrl
    ? calendars.find((c) => c.url === calendarUrl)
    : calendars[0];

  if (!calendar) throw new Error("No calendar found.");

  const uid = generateUid();
  const ics = buildIcs(input, uid);
  const objectUrl = `${calendar.url.replace(/\/$/, "")}/${uid}.ics`;

  await client.createCalendarObject({
    calendar,
    filename: `${uid}.ics`,
    iCalString: ics,
  });

  return {
    uid,
    summary: input.summary,
    description: input.description,
    location: input.location,
    start: input.start,
    end: input.end,
    allDay: input.allDay ?? false,
    recurrenceRule: input.recurrenceRule,
    ics,
    href: objectUrl,
  };
}

/** Update an existing event (identified by href/etag). */
export async function updateEvent(
  config: CalendarConfig,
  href: string,
  etag: string | undefined,
  input: Partial<NewEventInput> & { uid: string; existingIcs: string }
): Promise<void> {
  const client = await makeClient(config);

  // Merge new fields into existing ICS by rebuilding it
  const existing = parseIcsEvent(input.existingIcs);
  const merged: NewEventInput = {
    summary: input.summary ?? existing?.summary ?? "",
    description: input.description ?? existing?.description,
    location: input.location ?? existing?.location,
    start: input.start ?? existing?.start ?? new Date(),
    end: input.end ?? existing?.end ?? new Date(),
    allDay: input.allDay ?? existing?.allDay,
    recurrenceRule: input.recurrenceRule ?? existing?.recurrenceRule,
    timezone: input.timezone,
    reminders: input.reminders,
  };

  const updatedIcs = buildIcs(merged, input.uid);

  await client.updateCalendarObject({
    calendarObject: {
      url: href,
      etag: etag ?? "",
      data: updatedIcs,
    },
  });
}

/** Delete a calendar event by its CalDAV href. */
export async function deleteEvent(
  config: CalendarConfig,
  href: string,
  etag?: string
): Promise<void> {
  const client = await makeClient(config);
  await client.deleteCalendarObject({
    calendarObject: {
      url: href,
      etag: etag ?? "",
      data: "",
    },
  });
}

// ---------------------------------------------------------------------------
// Formatting helpers (useful for skill prompts)
// ---------------------------------------------------------------------------

/** Format an event for display in chat. */
export function formatEvent(ev: CalEvent): string {
  const dateStr = ev.allDay
    ? ev.start.toLocaleDateString()
    : `${ev.start.toLocaleString()} – ${ev.end.toLocaleTimeString()}`;

  const lines = [`**${ev.summary}**`, `📅 ${dateStr}`];
  if (ev.location) lines.push(`📍 ${ev.location}`);
  if (ev.description) lines.push(`📝 ${ev.description.slice(0, 200)}`);
  if (ev.recurrenceRule) lines.push(`🔁 Recurring`);
  return lines.join("\n");
}
