// Google Sheets storage: replaces queue.json and history.csv.
// The spreadsheet has three tabs:
//   queue   - order_number | singer | song | status | timestamp
//             status is Waiting or Completed; the first Waiting row is the singer on stage
//   history - Completion Time | Order Number | Singer | Song
//   admins  - one email per row in column A (whitelist for the admin console; a header row is optional)
// The app reads/writes it as your Google account, using the refresh token saved by
// scripts/authorize.js (Google Sheets permission only; it opens just the sheet in SHEET_ID).
const { OAuth2Client } = require('google-auth-library');

const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';
// Queue fields in column order (A-E); "id" is the order_number column (a unique number per request)
const QUEUE_COLUMNS = ['id', 'singer', 'song', 'status', 'timestamp'];
const QUEUE_HEADERS = ['order_number', 'singer', 'song', 'status', 'timestamp'];
const HISTORY_COLUMNS = ['Completion Time', 'Order Number', 'Singer', 'Song'];

let client;
function getClient() {
    if (!client) {
        if (!process.env.GOOGLE_REFRESH_TOKEN) {
            throw new Error('GOOGLE_REFRESH_TOKEN is missing. Run: node scripts/authorize.js');
        }
        client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET);
        // The library swaps the refresh token for short-lived access tokens automatically
        client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
    }
    return client;
}

async function sheetsRequest(path, options = {}) {
    const res = await getClient().request({ url: `${SHEETS_API}/${process.env.SHEET_ID}${path}`, ...options });
    return res.data;
}


async function getValues(range) {
    const data = await sheetsRequest(`/values/${encodeURIComponent(range)}`);
    return data.values || [];
}

// RAW = store exactly what was typed, so a singer named "=SOMEFORMULA()" is never run as a formula
async function setValues(range, values) {
    await sheetsRequest(`/values/${encodeURIComponent(range)}?valueInputOption=RAW`, {
        method: 'PUT',
        data: { values },
    });
}

async function appendValues(range, values) {
    await sheetsRequest(`/values/${encodeURIComponent(range)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
        method: 'POST',
        data: { values },
    });
}

// Queue
async function readQueue() {
    const rows = await getValues('queue!A2:E');
    return rows
        .filter(row => row[0])
        .map(row => {
            const item = {};
            QUEUE_COLUMNS.forEach((col, i) => {
                if (row[i] !== undefined && row[i] !== '') item[col] = row[i];
            });
            return item;
        });
}

// One write (no separate clear) so each click is a single round trip to Google and the display
// never reads an empty queue in between. previousLength = rows read before the change; when the
// queue got shorter, those leftover rows are overwritten with blanks.
async function writeQueue(queue, previousLength = 0) {
    // order_number is written as a number (like the rest of the column); everything else as text
    const rows = queue.map(item => QUEUE_COLUMNS.map(col => (col === 'id' ? Number(item.id) : (item[col] ?? '').toString())));
    while (rows.length < previousLength) rows.push(QUEUE_COLUMNS.map(() => ''));
    if (rows.length === 0) return;
    await setValues(`queue!A2:E${rows.length + 1}`, rows);
}

// Adds any of the queue/history/admins tabs that are missing; returns the names it added
async function addMissingTabs() {
    const meta = await sheetsRequest('?fields=sheets.properties.title');
    // Tab names match regardless of capitals in Google Sheets ("Queue" = "queue")
    const existing = meta.sheets.map(s => s.properties.title.toLowerCase());
    const missing = ['queue', 'history', 'admins'].filter(title => !existing.includes(title));
    if (missing.length) {
        await sheetsRequest(':batchUpdate', {
            method: 'POST',
            data: { requests: missing.map(title => ({ addSheet: { properties: { title } } })) },
        });
    }
    return missing;
}

// History
async function appendHistory(timeString, orderNumber, singer, song) {
    const row = [timeString, String(orderNumber), singer, song];
    try {
        await appendValues('history!A:D', [row]);
    } catch (err) {
        // History tab was deleted or never created: recreate it with headers, then retry
        if (!(await addMissingTabs()).includes('history')) throw err;
        await setValues('history!A1:D1', [HISTORY_COLUMNS]);
        await appendValues('history!A:D', [row]);
    }
}

// Admin whitelist (cached briefly so every button click doesn't re-read the sheet)
const ADMINS_CACHE_MS = 60 * 1000;
let adminsCache = { emails: null, at: 0 };

async function getAdminEmails() {
    if (adminsCache.emails && Date.now() - adminsCache.at < ADMINS_CACHE_MS) return adminsCache.emails;
    // Every cell in column A that looks like an email, so a header row is optional
    const rows = await getValues('admins!A:A');
    const emails = rows.map(row => (row[0] || '').trim().toLowerCase()).filter(cell => cell.includes('@'));
    adminsCache = { emails, at: Date.now() };
    return emails;
}

async function isAdmin(email) {
    if (!email) return false;
    const emails = await getAdminEmails();
    return emails.includes(email.trim().toLowerCase());
}

// QR code links for the display, edited per event in the sheet:
//   venmo_url     - column A label, column B link: the "primary" row if it has a link,
//                   otherwise the "default if primary is not set" row
//   song_list_url - the link in cell A1
const LINKS_CACHE_MS = 60 * 1000; // kept short: on Netlify the CDN already caches /api/links for 5 minutes
let linksCache = { links: null, at: 0 };

const isLink = text => /^https?:\/\//i.test((text || '').trim());

async function getQrLinks() {
    if (linksCache.links && Date.now() - linksCache.at < LINKS_CACHE_MS) return linksCache.links;
    const data = await sheetsRequest(`/values:batchGet?ranges=${encodeURIComponent('venmo_url!A:B')}&ranges=${encodeURIComponent('song_list_url!A1')}`);
    const [venmoRows = [], songRows = []] = data.valueRanges.map(range => range.values || []);

    const venmoLink = labelStart => {
        const row = venmoRows.find(r => (r[0] || '').trim().toLowerCase().startsWith(labelStart));
        return row && isLink(row[1]) ? row[1].trim() : null;
    };
    const links = {
        venmoUrl: venmoLink('primary') || venmoLink('default'),
        songListUrl: isLink(songRows[0]?.[0]) ? songRows[0][0].trim() : null,
    };
    linksCache = { links, at: Date.now() };
    return links;
}

// One-time setup: add missing tabs and put headers on queue/history only where row 1 is empty
// (never overwrites existing rows; the admins tab gets no header so emails can start in row 1)
async function setupSheet() {
    const missing = await addMissingTabs();
    if ((await getValues('queue!A1:E1')).length === 0) await setValues('queue!A1:E1', [QUEUE_HEADERS]);
    if ((await getValues('history!A1:D1')).length === 0) await setValues('history!A1:D1', [HISTORY_COLUMNS]);
    return missing;
}

module.exports = {
    readQueue,
    writeQueue,
    appendHistory,
    isAdmin,
    getQrLinks,
    setupSheet,
    getValues,
    appendValues,
};
