"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const http_1 = __importDefault(require("http"));
const ws_1 = require("ws");
const app = (0, express_1.default)();
const PORT = process.env.PORT || 8765;
// Middleware
app.use((0, cors_1.default)({ origin: '*' }));
app.use(express_1.default.json({ limit: '50mb' }));
app.use(express_1.default.urlencoded({ extended: true, limit: '50mb' }));
// Capture In-Memory Storage: ChannelId -> Items[]
const captureQueues = new Map();
function getQueueData(channelId = 'default-board') {
    const normalized = channelId.trim().toUpperCase() || 'DEFAULT-BOARD';
    if (!captureQueues.has(normalized)) {
        captureQueues.set(normalized, { lastActive: Date.now(), items: [] });
    }
    const data = captureQueues.get(normalized);
    data.lastActive = Date.now();
    return data;
}
function getQueue(channelId = 'default-board') {
    return getQueueData(channelId).items;
}
// Clean up inactive rooms older than 24 hours to prevent memory leaks
setInterval(() => {
    const now = Date.now();
    const ONE_DAY = 24 * 60 * 60 * 1000;
    for (const [channelId, data] of captureQueues.entries()) {
        if (now - data.lastActive > ONE_DAY && data.items.length === 0) {
            captureQueues.delete(channelId);
        }
    }
}, 60 * 60 * 1000);
// Root landing page for browser / cloud status checks
app.get('/', (_req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html>
      <head>
        <title>⚡ FigDrop Cloud Relay</title>
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #FAFAFA; color: #1E1E1E; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
          .card { background: #FFFFFF; border: 1px solid #E5E5E5; border-radius: 8px; padding: 28px 36px; box-shadow: 0 4px 12px rgba(0,0,0,0.05); text-align: center; max-width: 420px; }
          .badge { display: inline-block; background: #ECFDF5; color: #10B981; font-weight: 600; font-size: 12px; padding: 4px 10px; border-radius: 9999px; border: 1px solid #A7F3D0; margin-bottom: 12px; }
          h1 { font-size: 20px; margin: 0 0 8px 0; }
          p { font-size: 13px; color: #6B7280; margin: 0; line-height: 1.5; }
        </style>
      </head>
      <body>
        <div class="card">
          <div class="badge">● Cloud Relay Online</div>
          <h1>⚡ FigDrop Sync Server</h1>
          <p>Ready for Chrome Extension & FigJam Widget room connections.</p>
        </div>
      </body>
    </html>
  `);
});
// Health check endpoint for uptime monitors and cloud pingers
app.get('/health', (_req, res) => {
    let totalPending = 0;
    captureQueues.forEach((data) => {
        totalPending += data.items.filter((i) => i.status === 'pending').length;
    });
    res.json({
        status: 'online',
        name: 'FigDrop Cloud Relay Server',
        activeRooms: captureQueues.size,
        totalPendingItems: totalPending,
        connectedSockets: wss.clients.size,
        timestamp: Date.now()
    });
});
// Ingest capture from Chrome Extension
app.post('/api/capture', async (req, res) => {
    try {
        const { imageUrl, dataUrl, sourceUrl, pageTitle = 'Web Inspiration', domain = 'web', channelId = 'DEFAULT-BOARD', width, height, altText } = req.body;
        if (!imageUrl && !dataUrl) {
            return res.status(400).json({ error: 'Missing imageUrl or dataUrl' });
        }
        let finalDataUrl = dataUrl;
        if (!finalDataUrl && imageUrl && !imageUrl.startsWith('data:')) {
            try {
                const response = await fetch(imageUrl, {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36'
                    }
                });
                if (response.ok) {
                    const contentType = response.headers.get('content-type') || 'image/jpeg';
                    const arrayBuffer = await response.arrayBuffer();
                    const base64 = Buffer.from(arrayBuffer).toString('base64');
                    finalDataUrl = `data:${contentType};base64,${base64}`;
                }
            }
            catch (err) {
                console.warn('Backend image fetch fallback failed:', err);
            }
        }
        const normalizedChannel = (channelId || 'DEFAULT-BOARD').trim().toUpperCase();
        const item = {
            id: `cap_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
            imageUrl: imageUrl || '',
            dataUrl: finalDataUrl || undefined,
            sourceUrl: sourceUrl || '',
            pageTitle: pageTitle || 'Web Capture',
            domain: domain || (sourceUrl ? new URL(sourceUrl).hostname : 'web'),
            timestamp: Date.now(),
            width,
            height,
            altText,
            channelId: normalizedChannel,
            status: 'pending'
        };
        const queue = getQueue(normalizedChannel);
        queue.push(item);
        // Broadcast to connected FigJam widgets via WebSocket
        broadcast(normalizedChannel, {
            type: 'CAPTURE_ADDED',
            channelId: normalizedChannel,
            item,
            pendingCount: queue.filter((i) => i.status === 'pending').length,
            timestamp: Date.now()
        });
        console.log(`[⚡ Ingested] ${item.id} from ${item.domain} -> Room: "${normalizedChannel}" (Queue: ${queue.length})`);
        return res.status(201).json({
            status: 'success',
            item,
            pendingCount: queue.filter((i) => i.status === 'pending').length
        });
    }
    catch (err) {
        console.error('[❌ Capture Error]', err);
        return res.status(500).json({ error: err?.message || 'Failed to process capture' });
    }
});
// Get pending captures for a room code (used by FigJam Widget)
app.get('/api/captures', (req, res) => {
    const channelId = (req.query.channelId || 'DEFAULT-BOARD').trim().toUpperCase();
    const status = req.query.status;
    const queue = getQueue(channelId);
    const filtered = status ? queue.filter((item) => item.status === status) : queue;
    return res.json({
        channelId,
        count: filtered.length,
        items: filtered
    });
});
// Mark captures as synced / clear queue once dropped onto FigJam canvas
app.post('/api/captures/synced', (req, res) => {
    const channelId = (req.body.channelId || 'DEFAULT-BOARD').trim().toUpperCase();
    const ids = req.body.ids || [];
    const queue = getQueue(channelId);
    if (ids.length > 0) {
        const idSet = new Set(ids);
        const updated = queue.filter((item) => !idSet.has(item.id));
        captureQueues.get(channelId).items = updated;
    }
    else {
        captureQueues.get(channelId).items = [];
    }
    const remaining = getQueue(channelId);
    // Broadcast to extension and widget
    broadcast(channelId, {
        type: 'QUEUE_CLEARED',
        channelId,
        pendingCount: 0,
        timestamp: Date.now()
    });
    console.log(`[✨ Synced & Cleared] Captures in "${channelId}" cleared. Remaining: ${remaining.length}`);
    return res.json({ status: 'success', channelId, remainingCount: remaining.length });
});
// Image Proxy to solve CORS for FigJam / canvas downloads
app.get('/api/proxy-image', async (req, res) => {
    try {
        const targetUrl = req.query.url;
        if (!targetUrl) {
            return res.status(400).send('Missing url parameter');
        }
        const response = await fetch(targetUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36'
            }
        });
        if (!response.ok) {
            return res.status(response.status).send(`Failed to fetch image: ${response.statusText}`);
        }
        const contentType = response.headers.get('content-type') || 'image/jpeg';
        res.setHeader('Content-Type', contentType);
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
        res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
        res.setHeader('Cache-Control', 'public, max-age=86400');
        const arrayBuffer = await response.arrayBuffer();
        return res.send(Buffer.from(arrayBuffer));
    }
    catch (err) {
        return res.status(500).send(err?.message || 'Proxy error');
    }
});
// Create HTTP & WebSocket Server
const server = http_1.default.createServer(app);
const wss = new ws_1.WebSocketServer({ server });
wss.on('connection', (ws, req) => {
    const url = new URL(req.url || '/', `http://localhost:${PORT}`);
    const channelId = (url.searchParams.get('channelId') || 'DEFAULT-BOARD').trim().toUpperCase();
    ws.channelId = channelId;
    console.log(`[🔌 Client Connected] Room: "${channelId}" (Active sockets: ${wss.clients.size})`);
    // Send initial queue state immediately
    const queue = getQueue(channelId);
    ws.send(JSON.stringify({
        type: 'STATUS_UPDATE',
        channelId,
        pendingCount: queue.filter((i) => i.status === 'pending').length,
        items: queue.filter((i) => i.status === 'pending'),
        timestamp: Date.now()
    }));
    ws.on('message', (messageRaw) => {
        try {
            const data = JSON.parse(messageRaw.toString());
            if (data.type === 'SUBSCRIBE' && data.channelId) {
                const normalized = data.channelId.trim().toUpperCase();
                ws.channelId = normalized;
                const currentQueue = getQueue(normalized);
                ws.send(JSON.stringify({
                    type: 'STATUS_UPDATE',
                    channelId: normalized,
                    pendingCount: currentQueue.filter((i) => i.status === 'pending').length,
                    items: currentQueue.filter((i) => i.status === 'pending'),
                    timestamp: Date.now()
                }));
            }
        }
        catch { }
    });
    ws.on('close', () => {
        // disconnected
    });
});
function broadcast(channelId, payload) {
    const normalized = channelId.trim().toUpperCase();
    const raw = JSON.stringify(payload);
    wss.clients.forEach((client) => {
        if (client.readyState === ws_1.WebSocket.OPEN && client.channelId === normalized) {
            client.send(raw);
        }
    });
}
server.listen(PORT, () => {
    console.log(`
  ┌────────────────────────────────────────────────────────┐
  │  ⚡ FIGDROP CLOUD RELAY ONLINE                          │
  │  ----------------------------------------------------  │
  │  • Port:           ${PORT}                                │
  │  • Health Check:   http://localhost:${PORT}/health        │
  │  • Multi-User:     Isolated Room Code Protocol Active   │
  └────────────────────────────────────────────────────────┘
  `);
});
