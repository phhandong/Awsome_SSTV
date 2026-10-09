import { createPassCalendar } from '../js/pass-calendar.js';
import { readPassSubscription } from '../js/pass-calendar-subscription.js';

// Stateless public GET endpoint. Calendar clients do not share Safari's cookies or service worker.
export function calendarResponse(request) {
  const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  if (!['GET', 'HEAD'].includes(request.method)) return new Response('Method not allowed', { status: 405, headers: { ...headers, Allow: 'GET, HEAD, OPTIONS' } });
  const url = new URL(request.url);
  if (url.searchParams.get('capabilities') === '1') {
    return new Response(request.method === 'HEAD' ? null : JSON.stringify({ service: 'awesome-sstv-pass-calendar', version: 1 }),
      { headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' } });
  }
  try {
    const calendar = createPassCalendar(readPassSubscription(url.searchParams.get('data')));
    return new Response(request.method === 'HEAD' ? null : calendar.content, { headers: { ...headers,
      'Content-Type': 'text/calendar; charset=utf-8', 'Content-Disposition': `inline; filename="${calendar.filename}"` } });
  } catch (_) {
    return new Response(request.method === 'HEAD' ? null : 'Invalid calendar subscription',
      { status: 400, headers: { ...headers, 'Content-Type': 'text/plain; charset=utf-8' } });
  }
}
