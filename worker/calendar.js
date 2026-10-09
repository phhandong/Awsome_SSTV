import { calendarResponse } from '../scripts/calendar-feed.mjs';

export default {
  fetch(request) {
    if (new URL(request.url).pathname !== '/calendar/pass.ics') {
      return new Response('Not found', { status: 404 });
    }
    return calendarResponse(request);
  }
};
