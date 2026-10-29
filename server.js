const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 3000;
const DATA_FILE = path.join(__dirname, 'queue.json');
const CSV_FILE = path.join(__dirname, 'history.csv');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
// Serve .mov as video/mp4 so Chrome plays H.264 QuickTime files (Safari plays either)
app.use('/images', express.static(path.join(__dirname, 'images'), {
    setHeaders: (res, filePath) => {
        if (filePath.endsWith('.mov')) res.setHeader('Content-Type', 'video/mp4');
    }
}));

// Helper: Read queue
function readQueue() {
    if (!fs.existsSync(DATA_FILE)) {
        fs.writeFileSync(DATA_FILE, JSON.stringify([]));
    }
    const data = fs.readFileSync(DATA_FILE, 'utf8');
    return JSON.parse(data);
}

// Helper: Write queue
function writeQueue(queue) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(queue, null, 2));
}

// Helper: Append completed singer details to CSV
function appendToCSV(orderNumber, singer, song) {
    const csvHeader = 'Completion Time,Order Number,Singer,Song\n';
    
    // Create file with headers if it doesn't exist
    if (!fs.existsSync(CSV_FILE)) {
        fs.writeFileSync(CSV_FILE, csvHeader);
    }

    const timeString = new Date().toLocaleString();
    
    // Escape quotes to prevent CSV formatting issues
    const safeSinger = `"${singer.replace(/"/g, '""')}"`;
    const safeSong = `"${song.replace(/"/g, '""')}"`;

    const row = `"${timeString}",${orderNumber},${safeSinger},${safeSong}\n`;
    fs.appendFileSync(CSV_FILE, row);
}

// GET current queue
app.get('/api/queue', (req, res) => {
    res.json(readQueue());
});

// POST add singer
app.post('/api/queue/add', (req, res) => {
    const { singer, song } = req.body;
    if (!singer || !song) return res.status(400).json({ error: 'Missing fields' });

    const queue = readQueue();
    const newId = Date.now();
    const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const status = queue.length === 0 ? 'Current' : 'Waiting';

    queue.push({ id: newId, singer, song, status, timestamp });
    writeQueue(queue);
    res.json({ success: true });
});

// POST advance next singer & log completed singer to CSV
app.post('/api/queue/next', (req, res) => {
    let queue = readQueue();
    let foundCurrent = false;

    // Calculate total completed count to track performance order number (#1, #2, etc.)
    const completedCount = queue.filter(item => item.status === 'Completed').length;
    const currentOrderNumber = completedCount + 1;

    // 1. Mark current performance as completed and export to CSV
    queue = queue.map(item => {
        if (item.status === 'Current') {
            foundCurrent = true;
            // Save to CSV
            appendToCSV(currentOrderNumber, item.singer, item.song);
            return { ...item, status: 'Completed', orderNumber: currentOrderNumber };
        }
        return item;
    });

    // 2. Activate the next waiting singer
    let activated = false;
    queue = queue.map(item => {
        if (!activated && item.status === 'Waiting') {
            activated = true;
            return { ...item, status: 'Current' };
        }
        return item;
    });

    writeQueue(queue);
    res.json({ success: true });
});

// POST Move singer up/down in queue
app.post('/api/queue/move', (req, res) => {
    const { id, direction } = req.body;
    let queue = readQueue();
    
    const waitingItems = queue.filter(item => item.status === 'Waiting');
    const targetIndexInWaiting = waitingItems.findIndex(item => item.id == id);

    if (targetIndexInWaiting === -1) return res.status(400).json({ error: 'Item not found or not waiting' });

    const swapIndexInWaiting = direction === 'up' ? targetIndexInWaiting - 1 : targetIndexInWaiting + 1;

    if (swapIndexInWaiting < 0 || swapIndexInWaiting >= waitingItems.length) {
        return res.json({ success: true });
    }

    const itemToMove = waitingItems[targetIndexInWaiting];
    waitingItems[targetIndexInWaiting] = waitingItems[swapIndexInWaiting];
    waitingItems[swapIndexInWaiting] = itemToMove;

    let waitingIdx = 0;
    const newQueue = queue.map(item => {
        if (item.status === 'Waiting') {
            return waitingItems[waitingIdx++];
        }
        return item;
    });

    writeQueue(newQueue);
    res.json({ success: true });
});

// POST Remove a waiting singer from the queue
app.post('/api/queue/remove', (req, res) => {
    const { id } = req.body;
    const queue = readQueue();

    const target = queue.find(item => item.id == id && item.status === 'Waiting');
    if (!target) return res.status(400).json({ error: 'Item not found or not waiting' });

    writeQueue(queue.filter(item => item !== target));
    res.json({ success: true });
});

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