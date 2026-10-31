// One-time setup for the Google Sheet:
//   node scripts/setup-sheet.js you@gmail.com
// - creates the "queue", "history" and "admins" tabs with header rows
// - adds the given email(s) to the admins whitelist
// - imports queue.json and history.csv (if present) into empty tabs
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
try { process.loadEnvFile(path.join(root, '.env')); } catch { /* no .env file */ }

const { setupSheet, readQueue, writeQueue, getValues, appendValues } = require('../lib/sheets');

// Minimal CSV line parser for history.csv ("quoted, fields" with "" escapes)
function parseCsvLine(line) {
    const fields = [];
    let field = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (inQuotes) {
            if (ch === '"' && line[i + 1] === '"') { field += '"'; i++; }
            else if (ch === '"') inQuotes = false;
            else field += ch;
        } else if (ch === '"') inQuotes = true;
        else if (ch === ',') { fields.push(field); field = ''; }
        else field += ch;
    }
    fields.push(field);
    return fields;
}

async function main() {
    const created = await setupSheet();
    console.log(created.length ? `Created tabs: ${created.join(', ')}` : 'All tabs already exist');

    // Admin emails from the command line
    const newAdmins = process.argv.slice(2).map(e => e.trim().toLowerCase()).filter(Boolean);
    if (newAdmins.length) {
        const existing = (await getValues('admins!A:A')).map(r => (r[0] || '').trim().toLowerCase());
        const toAdd = newAdmins.filter(e => !existing.includes(e));
        if (toAdd.length) await appendValues('admins!A:A', toAdd.map(e => [e]));
        console.log(`Admins added: ${toAdd.join(', ') || '(already listed)'}`);
    }

    // Import queue.json into an empty queue tab
    const queueFile = path.join(root, 'queue.json');
    if (fs.existsSync(queueFile) && (await readQueue()).length === 0) {
        const queue = JSON.parse(fs.readFileSync(queueFile, 'utf8'));
        await writeQueue(queue);
        console.log(`Imported ${queue.length} queue rows from queue.json`);
    }

    // Import history.csv into an empty history tab
    const historyFile = path.join(root, 'history.csv');
    if (fs.existsSync(historyFile) && (await getValues('history!A2:A')).length === 0) {
        const lines = fs.readFileSync(historyFile, 'utf8').split('\n').slice(1).filter(l => l.trim());
        if (lines.length) await appendValues('history!A:D', lines.map(parseCsvLine));
        console.log(`Imported ${lines.length} history rows from history.csv`);
    }

    console.log('Sheet is ready.');
}

main().catch(err => {
    console.error('Setup failed:', err.message);
    process.exit(1);
});
