import { parseTicketStream } from '../src/ticket-events.mjs';
import { renderTextTimeline } from '../src/render-text.mjs';
import { SAMPLES } from './lib/sample-tickets.mjs';
const parsed = parseTicketStream(SAMPLES[1].doc, { source: 'blocked' });
process.stdout.write(renderTextTimeline(parsed, { width: 100, color: false }));