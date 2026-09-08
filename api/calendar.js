import { cors, feedKey, notConfigured, store } from "./_store.js";

/**
 * The subscription URL. A calendar app polls this on its own schedule, which
 * is the whole point: once it is subscribed the reader never exports a file
 * again, and deadlines added on either device turn up here on the next poll.
 *
 * It is read-only and keyed by the feed token, which is a one-way hash of the
 * sync code. Someone holding this URL can see the calendar and nothing else.
 */
export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== "GET") {
    res.statusCode = 405;
    return res.end("Method not allowed");
  }

  const live = store();
  if (!live) return notConfigured(res);

  const url = new URL(req.url, "http://localhost");
  // Calendar apps are happier with a URL that ends in .ics, so the token may
  // arrive either as ?feed=<token> or as the last path segment.
  const fromPath = url.pathname.replace(/^.*\//, "").replace(/\.ics$/i, "");
  const token = (url.searchParams.get("feed") || fromPath || "").trim();

  if (!/^[a-f0-9]{32}$/.test(token)) {
    res.statusCode = 400;
    return res.end("That is not a Remembre calendar address.");
  }

  let text = null;
  try {
    text = await live.get(feedKey(token));
  } catch (err) {
    console.error("calendar read failed:", err);
    res.statusCode = 502;
    return res.end("The calendar store did not answer.");
  }

  // An unknown or not-yet-pushed feed is an empty calendar rather than a 404:
  // a subscription that 404s tends to get switched off by the calendar app.
  const body = text || [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Remembre//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "X-WR-CALNAME:Remembre",
    "END:VCALENDAR",
    "",
  ].join("\r\n");

  res.statusCode = 200;
  res.setHeader("Content-Type", "text/calendar; charset=utf-8");
  res.setHeader("Content-Disposition", 'inline; filename="remembre.ics"');
  // Long enough that a polling calendar is not hammering the store, short
  // enough that a deadline added this morning is there this afternoon.
  res.setHeader("Cache-Control", "public, max-age=300, s-maxage=300");
  res.end(body);
}
