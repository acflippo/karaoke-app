const express = require('express');
const path = require('path');

// Local development: load settings from .env (on Netlify they come from Site settings → Environment variables)
try { process.loadEnvFile(path.join(__dirname, '.env')); } catch { /* no .env file */ }

const { readQueue, writeQueue, appendHistory, isAdmin, getQrLinks } = require('./lib/sheets');
const { verifyGoogleToken, setSessionCookie, clearSessionCookie, requireAdmin, touchSession } = require('./lib/auth');
const { purgeCache } = require('@netlify/functions');

const app = express();
const PORT = 3000;
const MAX_FIELD_LENGTH = 100;

app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(__dirname, 'public')));
// Serve .mov as video/mp4 so Chrome plays H.264 QuickTime files (Safari plays either)
app.use('/images', express.static(path.join(__dirname, 'images'), {
    setHeaders: (res, filePath) => {
        if (filePath.endsWith('.mov')) res.setHeader('Content-Type', 'video/mp4');
    }
}));

// Current time as "2026/11/30, 11:12:06 AM" in the venue's time zone (Netlify servers run on UTC)
function sheetTimestamp() {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
        timeZone: process.env.TIME_ZONE || undefined,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true,
    }).formatToParts(new Date()).map(p => [p.type, p.value]));
    return `${parts.year}/${parts.month}/${parts.day}, ${parts.hour}:${parts.minute}:${parts.second} ${parts.dayPeriod}`;
}

// The singer on stage is the first Waiting row ("Current" is still honored for older rows);
// everyone else who is Waiting is up next, in sheet order
function onStage(queue) {
    return queue.find(item => item.status === 'Current') || queue.find(item => item.status === 'Waiting');
}
function upNext(queue) {
    const current = onStage(queue);
    return queue.filter(item => item.status === 'Waiting' && item !== current);
}

// Display screen caching: Netlify's CDN answers the display's polls from its cache, so they don't
// run this function or read the sheet. Every admin change clears the cached queue, so the display
// picks it up on its next poll. Locally (node server.js) nothing is cached and these do nothing.
const QUEUE_CACHE_TAG = 'display-queue';
const QUEUE_CACHE_SECONDS = 60; // safety net: the display refreshes at least this often even if a clear fails
const LINKS_CACHE_SECONDS = 5 * 60; // QR links rarely change; sheet edits show up within about 5 minutes

function cacheForDisplay(res, tag, seconds) {
    res.set({
        'Cache-Control': 'public, max-age=0, must-revalidate', // browsers always ask the CDN
        'Netlify-CDN-Cache-Control': `public, durable, s-maxage=${seconds}`,
        'Netlify-Cache-Tag': tag,
    });
}

// Netlify allows 2 clears every 5 seconds, so quick clicks (Up, Up, Up) may need one retry
async function refreshDisplay(req) {
    const token = req.lambdaContext?.clientContext?.custom?.purge_api_token;
    if (!token) return;
    for (const delayMs of [0, 2500]) {
        await new Promise(resolve => setTimeout(resolve, delayMs));
        try {
            return await purgeCache({ tags: [QUEUE_CACHE_TAG], token });
        } catch (err) {
            console.error('Clearing the display cache failed:', err.message);
        }
    }
}

const api = express.Router();

// ---------- Login ----------

// Public settings the login page needs
api.get('/config', (req, res) => {
    res.json({ googleClientId: process.env.GOOGLE_CLIENT_ID });
});

// Sign in with a Google ID token; only emails in the "admins" tab are allowed
api.post('/auth/google', async (req, res) => {
    let email;
    try {
        email = await verifyGoogleToken(req.body.credential);
    } catch {
        return res.status(401).json({ error: 'Google sign-in could not be verified' });
    }
    if (!(await isAdmin(email))) {
        return res.status(403).json({ error: `${email} is not on the admin list` });
    }
    setSessionCookie(req, res, email);
    res.json({ email });
});

api.post('/auth/logout', (req, res) => {
    clearSessionCookie(res);
    res.json({ success: true });
});

api.get('/auth/me', requireAdmin, (req, res) => {
    res.json({ email: req.adminEmail });
});

// The admin console reports clicks here; restarts the idle sign-out timer
api.post('/auth/activity', requireAdmin, touchSession);

// ---------- QR code links ----------

// GET Venmo and song list links from the sheet (public: the display shows them as QR codes).
// Cached on the CDN for up to LINKS_CACHE_SECONDS.
api.get('/links', async (req, res) => {
    const links = await getQrLinks();
    cacheForDisplay(res, 'display-links', LINKS_CACHE_SECONDS);
    res.json(links);
});

// ---------- Queue ----------

// GET current queue (public: the display screen reads this without signing in).
// Served from the CDN cache until an admin change clears it (see refreshDisplay).
api.get('/queue', async (req, res) => {
    const queue = await readQueue();
    cacheForDisplay(res, QUEUE_CACHE_TAG, QUEUE_CACHE_SECONDS);
    res.json(queue);
});

// GET current queue for the admin console (signed-in only: a 401 here, e.g. after the idle
// timeout or signing out in another tab, tells the console to stop polling)
api.get('/admin/queue', requireAdmin, async (req, res) => {
    res.json(await readQueue());
});

// POST add singer
api.post('/queue/add', requireAdmin, async (req, res) => {
    const singer = typeof req.body.singer === 'string' ? req.body.singer.trim() : '';
    const song = typeof req.body.song === 'string' ? req.body.song.trim() : '';
    if (!singer || !song) return res.status(400).json({ error: 'Missing fields' });
    if (singer.length > MAX_FIELD_LENGTH || song.length > MAX_FIELD_LENGTH) {
        return res.status(400).json({ error: `Singer and song must be ${MAX_FIELD_LENGTH} characters or less` });
    }

    const queue = await readQueue();
    const newQueue = [...queue, { id: Date.now(), singer, song, status: 'Waiting', timestamp: sheetTimestamp() }];
    await writeQueue(newQueue, queue.length);
    await refreshDisplay(req);
    res.json({ success: true, queue: newQueue });
});

// POST advance next singer & log completed singer to the history tab
api.post('/queue/next', requireAdmin, async (req, res) => {
    const queue = await readQueue();
    const current = onStage(queue);
    if (!current) return res.json({ success: true, queue });

    // Performance number for the history tab (#1, #2, etc.)
    const orderNumber = queue.filter(item => item.status === 'Completed').length + 1;

    // Mark them Completed; the next Waiting row is now on stage.
    // The history row and the queue are saved at the same time (one wait instead of two).
    const newQueue = queue.map(item => (item === current ? { ...item, status: 'Completed' } : item));
    await Promise.all([
        appendHistory(sheetTimestamp(), orderNumber, current.singer, current.song),
        writeQueue(newQueue, queue.length),
    ]);
    await refreshDisplay(req);
    res.json({ success: true, queue: newQueue });
});

// POST Move singer up/down in queue
api.post('/queue/move', requireAdmin, async (req, res) => {
    const { id, direction } = req.body;
    let queue = await readQueue();

    // Only singers up next can move; the singer on stage stays put
    const current = onStage(queue);
    const waitingItems = upNext(queue);
    const targetIndexInWaiting = waitingItems.findIndex(item => item.id == id);

    if (targetIndexInWaiting === -1) return res.status(400).json({ error: 'Item not found or not waiting' });

    const swapIndexInWaiting = direction === 'up' ? targetIndexInWaiting - 1 : targetIndexInWaiting + 1;

    if (swapIndexInWaiting < 0 || swapIndexInWaiting >= waitingItems.length) {
        return res.json({ success: true, queue });
    }

    const itemToMove = waitingItems[targetIndexInWaiting];
    waitingItems[targetIndexInWaiting] = waitingItems[swapIndexInWaiting];
    waitingItems[swapIndexInWaiting] = itemToMove;

    let waitingIdx = 0;
    const newQueue = queue.map(item => {
        if (item.status === 'Waiting' && item !== current) {
            return waitingItems[waitingIdx++];
        }
        return item;
    });

    await writeQueue(newQueue, queue.length);
    await refreshDisplay(req);
    res.json({ success: true, queue: newQueue });
});

// POST Remove a waiting singer from the queue
api.post('/queue/remove', requireAdmin, async (req, res) => {
    const { id } = req.body;
    const queue = await readQueue();

    // The singer on stage can't be removed (use Next Singer)
    const target = upNext(queue).find(item => item.id == id);
    if (!target) return res.status(400).json({ error: 'Item not found or not waiting' });

    const newQueue = queue.filter(item => item !== target);
    await writeQueue(newQueue, queue.length);
    await refreshDisplay(req);
    res.json({ success: true, queue: newQueue });
});

// Same routes locally (/api/...) and on Netlify (/.netlify/functions/api/...)
app.use(['/api', '/.netlify/functions/api'], api);

// Errors (e.g. Google Sheets unreachable): log the details, return a generic message
app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
});

module.exports = app;

// Run as a normal server with `node server.js` (Netlify imports the app instead)
if (require.main === module) {
    const server = app.listen(PORT, () => {
        console.log(`🎤 Karaoke app running locally!`);
        console.log(`👉 Laptop View: http://localhost:${PORT}`);
        console.log(`👉 iPad View: http://<YOUR-LAPTOP-IP>:${PORT}`);
    });

    // Graceful shutdown on Ctrl+C
    process.on('SIGINT', () => {
        console.log('\n🛑 Shutting down karaoke server gracefully...');
        server.close(() => {
            console.log('✅ Server closed. All connections closed.');
            process.exit(0);
        });
        // Drop idle keep-alive connections (e.g. an open display screen) so close() finishes promptly
        server.closeAllConnections();
    });
}
