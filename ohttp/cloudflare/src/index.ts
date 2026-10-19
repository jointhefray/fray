import { connect } from 'cloudflare:sockets';
import { createWorker } from './worker.js';

export default createWorker(connect);
