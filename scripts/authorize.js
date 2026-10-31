// One-time: let the app use your Google account to edit the karaoke sheet.
//   node scripts/authorize.js
// - opens Google's consent screen in your browser (sign in with an account that can edit the sheet)
// - SHEET_ID set in .env: uses that existing sheet (checks it opens)
// - SHEET_ID empty: creates "Karaoke-App-Annie-yyyy-mm-dd hh:mi:ss" in your Drive and saves SHEET_ID
// - saves GOOGLE_REFRESH_TOKEN into .env
const fs = require('fs');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { OAuth2Client } = require('google-auth-library');

const root = path.join(__dirname, '..');
const envFile = path.join(root, '.env');
try { process.loadEnvFile(envFile); } catch { /* no .env file */ }

const PORT = 3005;
const REDIRECT_URI = `http://localhost:${PORT}/oauth2callback`;
// spreadsheets = read/edit your Google Sheets (needed to open a sheet you created yourself);
// openid + email = show which account was used
const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const SCOPES = [SHEETS_SCOPE, 'openid', 'email'];

// Replace KEY=... in .env, or add it if missing
function saveToEnv(key, value) {
    let text = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : '';
    const line = `${key}=${value}`;
    const pattern = new RegExp(`^${key}=.*$`, 'm');
    text = pattern.test(text) ? text.replace(pattern, line) : `${text.replace(/\n?$/, '\n')}${line}\n`;
    fs.writeFileSync(envFile, text);
}

// e.g. "Karaoke-App-Annie-2026-10-30 21:15:07" in the venue's time zone (sv-SE formats as yyyy-mm-dd hh:mi:ss)
function newSheetTitle() {
    const stamp = new Date().toLocaleString('sv-SE', { timeZone: process.env.TIME_ZONE || undefined });
    return `Karaoke-App-Annie-${stamp}`;
}

// Creates a spreadsheet with the queue/history/admins tabs; returns its ID
async function createSheet(client, title) {
    const res = await client.request({
        url: 'https://sheets.googleapis.com/v4/spreadsheets',
        method: 'POST',
        data: {
            properties: { title },
            sheets: ['queue', 'history', 'admins'].map(name => ({ properties: { title: name } })),
        },
    });
    return res.data.spreadsheetId;
}

// Returns the sheet's title, or throws with a readable reason
async function openSheet(client, sheetId) {
    try {
        const res = await client.request({ url: `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}?fields=properties.title` });
        return res.data.properties.title;
    } catch (err) {
        const status = err.response?.status;
        if (status === 404) throw new Error(`No sheet found with SHEET_ID ${sheetId}. Check the ID in .env.`);
        if (status === 403) throw new Error('This Google account cannot open the sheet. Sign in with the account that owns it, or share the sheet with this account as Editor.');
        throw err;
    }
}

async function main() {
    const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, SHEET_ID } = process.env;
    if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
        throw new Error('Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env first');
    }

    const client = new OAuth2Client(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, REDIRECT_URI);
    const state = crypto.randomBytes(16).toString('hex');
    const authUrl = client.generateAuthUrl({
        access_type: 'offline', // ask for a refresh token
        prompt: 'consent',      // always return one, even if authorized before
        scope: SCOPES,
        state,
    });

    // Wait for Google to redirect back to http://localhost:3005/oauth2callback?code=...
    const code = await new Promise((resolve, reject) => {
        const server = http.createServer((req, res) => {
            const url = new URL(req.url, REDIRECT_URI);
            if (url.pathname !== '/oauth2callback') { res.writeHead(404).end(); return; }
            const ok = url.searchParams.get('state') === state && url.searchParams.get('code');
            res.writeHead(ok ? 200 : 400, { 'Content-Type': 'text/plain' })
                .end(ok ? 'Authorized! You can close this tab and go back to the terminal.' : 'Authorization failed.');
            server.close();
            ok ? resolve(url.searchParams.get('code')) : reject(new Error(url.searchParams.get('error') || 'Invalid response'));
        });
        server.listen(PORT, () => {
            console.log('Opening Google sign-in in your browser. If it does not open, visit:\n' + authUrl + '\n');
            if (process.platform === 'darwin') spawn('open', [authUrl], { stdio: 'ignore' });
        });
    });

    const { tokens } = await client.getToken(code);
    if (!tokens.refresh_token) throw new Error('Google did not return a refresh token. Run the script again.');
    // Google's consent screen lets people untick permissions; the Sheets one is required
    if (!(tokens.scope || '').includes(SHEETS_SCOPE)) {
        throw new Error('The Google Sheets permission was not granted. Run the script again and tick the box for ' +
            '"See, edit, create, and delete all your Google Sheets spreadsheets".');
    }
    client.setCredentials(tokens);

    const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: GOOGLE_CLIENT_ID });
    console.log(`Signed in as ${ticket.getPayload().email}`);

    if (SHEET_ID) {
        // Only save the token once we know it can open the sheet
        const title = await openSheet(client, SHEET_ID);
        console.log(`Opened sheet "${title}": https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit`);
    } else {
        const title = newSheetTitle();
        const sheetId = await createSheet(client, title);
        saveToEnv('SHEET_ID', sheetId);
        console.log(`Created sheet "${title}": https://docs.google.com/spreadsheets/d/${sheetId}/edit`);
        console.log('Saved SHEET_ID to .env');
    }

    saveToEnv('GOOGLE_REFRESH_TOKEN', tokens.refresh_token);
    console.log('Saved GOOGLE_REFRESH_TOKEN to .env');

    console.log('\nNext: node scripts/setup-sheet.js your.email@gmail.com');
    console.log('For Netlify, copy GOOGLE_REFRESH_TOKEN and SHEET_ID from .env into Site settings → Environment variables.');
}

main().catch(err => {
    console.error('Authorization failed:', err.message);
    process.exit(1);
});
