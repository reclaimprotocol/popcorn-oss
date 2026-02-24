const WebSocket = require('ws');

const url = process.argv[2];
const iterations = parseInt(process.argv[3]) || 50;

if (!url) {
    console.error('Usage: node benchmark_cdp.js <cdp-url> [iterations]');
    console.error('Example: node benchmark_cdp.js ws://localhost:9222/devtools/browser/... 100');
    process.exit(1);
}

console.log(`Connecting to ${url}...`);

const connectionStartTime = process.hrtime.bigint();
const ws = new WebSocket(url);

ws.on('error', (err) => {
    console.error('WebSocket Error:', err);
    process.exit(1);
});

let currentId = 1;
let startTime = 0;
let latencies = [];
let pending = false;
let connectionTimeMs = 0;

ws.on('open', () => {
    const elapsed = process.hrtime.bigint() - connectionStartTime;
    connectionTimeMs = Number(elapsed) / 1_000_000;
    console.log(`Connected in ${connectionTimeMs.toFixed(2)} ms. Starting ${iterations} iterations of Browser.getVersion...`);
    sendNext();
});

ws.on('message', (data) => {
    const response = JSON.parse(data.toString());

    if (response.id === currentId && pending) {
        const elapsed = process.hrtime.bigint() - startTime;
        // convert from nanoseconds to milliseconds
        const latencyMs = Number(elapsed) / 1_000_000;
        latencies.push(latencyMs);
        pending = false;

        if (currentId < iterations) {
            currentId++;
            sendNext();
        } else {
            finish();
        }
    }
});

function sendNext() {
    pending = true;
    startTime = process.hrtime.bigint();
    ws.send(JSON.stringify({
        id: currentId,
        method: 'Browser.getVersion'
    }));
}

function finish() {
    ws.close();

    latencies.sort((a, b) => a - b);
    const min = latencies[0];
    const max = latencies[latencies.length - 1];
    const avg = latencies.reduce((a, b) => a + b, 0) / latencies.length;
    const p95 = latencies[Math.floor(latencies.length * 0.95)];

    console.log('\n--- Latency Benchmark Results ---');
    console.log(`Connection Time: ${connectionTimeMs.toFixed(2)} ms`);
    console.log(`Command Round-Trip Latency (over ${iterations} iterations):`);
    console.log(`  Min:  ${min.toFixed(2)} ms`);
    console.log(`  Max:  ${max.toFixed(2)} ms`);
    console.log(`  Avg:  ${avg.toFixed(2)} ms`);
    console.log(`  p95:  ${p95.toFixed(2)} ms`);
}
