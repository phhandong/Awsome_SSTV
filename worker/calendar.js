import { calendarResponse } from '../scripts/calendar-feed.mjs';

export default {
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname !== '/calendar/pass.ics') {
      return new Response('Not found', { status: 404 });
    }
    // Some webcal clients initially use HTTP. Preserve the event query while upgrading to TLS.
    if (url.protocol === 'http:') {
      url.protocol = 'https:';
      return new Response(null, { status: 301, headers: { Location: url.href, 'Cache-Control': 'no-store' } });
    }
    return calendarResponse(request);
  }
};
