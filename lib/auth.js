// Login with Google + signed session cookie.
// 1. The login page gets an ID token from Google Sign-In and posts it to /api/auth/google.
// 2. We verify the token with Google, check the email is in the "admins" tab, and set a
//    session cookie signed with SESSION_SECRET (HttpOnly, SameSite=Strict, Secure on HTTPS).
// 3. Every admin action re-checks the cookie and the whitelist (see requireAdmin).
// 4. The session also ends after IDLE_MINUTES with no clicks on the admin console. The console
//    reports activity to /api/auth/activity (see touchSession); queue polling doesn't count,
//    so an unattended display screen stops on its own.
const crypto = require('crypto');
const { OAuth2Client } = require('google-auth-library');
const { isAdmin } = require('./sheets');

const COOKIE_NAME = 'karaoke_session';
const SESSION_HOURS = 12;
const IDLE_MINUTES = 60; // sign out after this long with no clicks on the admin console

const googleClient = new OAuth2Client();

function getSecret() {
    const secret = process.env.SESSION_SECRET;
    if (!secret || secret.length < 32) throw new Error('SESSION_SECRET must be set (32+ characters)');
    return secret;
}

function sign(payload) {
    return crypto.createHmac('sha256', getSecret()).update(payload).digest('base64url');
}

// exp = hard limit from sign-in; active = last admin console click (refreshed by touchSession)
function createSessionToken(email, exp) {
    const payload = Buffer.from(JSON.stringify({ email, exp, active: Date.now() })).toString('base64url');
    return `${payload}.${sign(payload)}`;
}

// Returns { email, exp, idle }, or null if the token is missing, tampered with, or expired.
// idle = true when there were no admin console clicks for IDLE_MINUTES.
function readSessionToken(token) {
    if (!token || !token.includes('.')) return null;
    const [payload, signature] = token.split('.');
    const expected = Buffer.from(sign(payload));
    const actual = Buffer.from(signature || '');
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;
    try {
        const { email, exp, active } = JSON.parse(Buffer.from(payload, 'base64url').toString());
        if (!(exp > Date.now())) return null;
        return { email, exp, idle: !(Date.now() - active < IDLE_MINUTES * 60 * 1000) };
    } catch {
        return null;
    }
}

function getCookie(req, name) {
    const cookies = req.headers.cookie || '';
    const match = cookies.split(';').map(c => c.trim()).find(c => c.startsWith(`${name}=`));
    return match ? decodeURIComponent(match.slice(name.length + 1)) : null;
}

function isHttps(req) {
    return req.secure || req.headers['x-forwarded-proto'] === 'https';
}

// exp: keep an existing session's 12-hour limit; omitted at sign-in to start a new one
function setSessionCookie(req, res, email, exp = Date.now() + SESSION_HOURS * 60 * 60 * 1000) {
    res.cookie(COOKIE_NAME, createSessionToken(email, exp), {
        httpOnly: true,
        sameSite: 'strict',
        secure: isHttps(req), // always true on Netlify; false on http://localhost
        maxAge: exp - Date.now(),
        path: '/',
    });
}

function clearSessionCookie(res) {
    res.clearCookie(COOKIE_NAME, { path: '/' });
}

// Verifies a Google Sign-In ID token and returns the verified Gmail address
async function verifyGoogleToken(idToken) {
    const ticket = await googleClient.verifyIdToken({
        idToken,
        audience: process.env.GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();
    if (!payload.email || !payload.email_verified) throw new Error('Google account email is not verified');
    return payload.email.toLowerCase();
}

// Express middleware: only signed-in, whitelisted admins get through
async function requireAdmin(req, res, next) {
    try {
        const session = readSessionToken(getCookie(req, COOKIE_NAME));
        if (!session) return res.status(401).json({ error: 'Please sign in' });
        if (session.idle) {
            clearSessionCookie(res);
            return res.status(401).json({ error: 'Signed out after no activity', idle: true });
        }
        // Re-check the whitelist so removing someone from the "admins" tab locks them out within a minute
        if (!(await isAdmin(session.email))) {
            clearSessionCookie(res);
            return res.status(403).json({ error: 'This account is not allowed' });
        }
        req.adminEmail = session.email;
        req.sessionExp = session.exp;
        next();
    } catch (err) {
        next(err);
    }
}

// Route handler (after requireAdmin): a click on the admin console restarts the idle timer.
// Keeps the original 12-hour limit from sign-in.
function touchSession(req, res) {
    setSessionCookie(req, res, req.adminEmail, req.sessionExp);
    res.json({ success: true });
}

module.exports = {
    verifyGoogleToken,
    setSessionCookie,
    clearSessionCookie,
    requireAdmin,
    touchSession,
};
