// Configuration
let API_BASE = '';

// Detect API base URL
if (window.location.port === '3000' || window.location.port === '') {
    API_BASE = window.location.origin;
} else {
    API_BASE = `${window.location.protocol}//${window.location.hostname}:3000`;
}
console.log('API Base URL:', API_BASE);

// State
let currentSessionId = null;
let currentExecutionId = null;
let pollInterval = null;
let keepAliveInterval = null;
let isPolling = false;

// DOM Elements
const apiSecretInput = document.getElementById('apiSecret');
const saveApiKeyBtn = document.getElementById('saveApiKey');
const clearApiKeyBtn = document.getElementById('clearApiKey');
const startSessionBtn = document.getElementById('startSession');
const keepAliveBtn = document.getElementById('keepAliveBtn');
const stopSessionBtn = document.getElementById('stopSession');
const runAsyncBtn = document.getElementById('runAsync');
const stopExecutionBtn = document.getElementById('stopExecution');
const clearCodeBtn = document.getElementById('clearCode');
const resetCodeBtn = document.getElementById('resetCode');
const copyOutputBtn = document.getElementById('copyOutput');
const clearOutputBtn = document.getElementById('clearOutput');
const sessionInfo = document.getElementById('sessionInfo');
const codeEditor = document.getElementById('codeEditor');
const outputDiv = document.getElementById('output');
const statusDiv = document.getElementById('status');
const execStatus = document.getElementById('execStatus');

// Example code
const EXAMPLE_CODE = `# Test Colab GPU and Python features
import torch
import sys
import time
print("=" * 50)
print("Python version:", sys.version.split()[0])
print("PyTorch version:", torch.__version__)
print("CUDA available:", torch.cuda.is_available())
if torch.cuda.is_available():
    print("GPU:", torch.cuda.get_device_name(0))
    print("GPU Count:", torch.cuda.device_count())
    print("=" * 50)
    # Simple GPU computation
    print("\\nRunning GPU computation...")
    start = time.time()
    x = torch.randn(1000, 1000).cuda()
    y = torch.randn(1000, 1000).cuda()
    z = torch.matmul(x, y)
    end = time.time()
    print(f"Matrix multiplication time: {(end-start):.3f} seconds")
else:
    print("=" * 50)
    print("\\nRunning CPU computation...")
    start = time.time()
    result = sum(range(10000000))
    end = time.time()
    print(f"Sum of 10M numbers: {result}")
    print(f"Time taken: {(end-start):.2f} seconds")
print("\\n✅ Code execution completed successfully!");`;

// Load saved API key
const savedApiKey = localStorage.getItem('apiSecret');
if (savedApiKey) {
    apiSecretInput.value = savedApiKey;
    startSessionBtn.disabled = false;
    showStatus('API key loaded from storage', 'success');
}

// Save API key
saveApiKeyBtn.addEventListener('click', () => {
    const apiKey = apiSecretInput.value.trim();
    if (apiKey) {
        localStorage.setItem('apiSecret', apiKey);
        startSessionBtn.disabled = false;
        showStatus('API key saved successfully!', 'success');
    } else {
        showStatus('Please enter a valid API key', 'error');
    }
});

// Clear API key
clearApiKeyBtn.addEventListener('click', () => {
    localStorage.removeItem('apiSecret');
    apiSecretInput.value = '';
    startSessionBtn.disabled = true;
    showStatus('API key cleared', 'info');
});

// Clear code
clearCodeBtn.addEventListener('click', () => {
    codeEditor.value = '';
    showStatus('Code cleared', 'info');
});

// Reset code to example
resetCodeBtn.addEventListener('click', () => {
    codeEditor.value = EXAMPLE_CODE;
    showStatus('Reset to example code', 'info');
});

// Copy output
copyOutputBtn.addEventListener('click', async () => {
    try {
        await navigator.clipboard.writeText(outputDiv.textContent);
        showStatus('Output copied to clipboard!', 'success');
    } catch (err) {
        showStatus('Failed to copy output', 'error');
    }
});

// Clear output
clearOutputBtn.addEventListener('click', () => {
    outputDiv.textContent = 'Output cleared.';
    showStatus('Output cleared', 'info');
});

// Start session
startSessionBtn.addEventListener('click', async () => {
    const apiSecret = apiSecretInput.value.trim();
    if (!apiSecret) {
        showStatus('Please save your API key first', 'error');
        return;
    }

    startSessionBtn.disabled = true;
    startSessionBtn.textContent = 'Starting...';

    try {
        const response = await fetch(`${API_BASE}/start`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ api_secret: apiSecret })
        });
        const data = await response.json();

        if (data.success) {
            currentSessionId = data.sessionId;
            sessionInfo.innerHTML = `
                <strong>✅ Session Active</strong><br>
                Session ID: <code>${data.sessionId.substring(0, 32)}...</code><br>
                ${data.authUrl ? `🔐 Auth URL: <a href="${data.authUrl}" target="_blank">Authenticate with Google</a><br>` : ''}
                ⏰ Expires in: ${Math.floor(data.expiresIn / 1000 / 60 / 60)} hours<br>
                📡 API Base: ${API_BASE}
            `;
            sessionInfo.classList.add('active');
            runAsyncBtn.disabled = false;
            keepAliveBtn.disabled = false;
            stopSessionBtn.disabled = false;
            showStatus('✅ Session created!', 'success');
            startKeepAlive(apiSecret);
        } else {
            showStatus(`Error: ${data.error || data.message || 'Unknown error'}`, 'error');
            if (data.authUrl) {
                sessionInfo.innerHTML = `
                    🔐 Please authenticate: <a href="${data.authUrl}" target="_blank">Authenticate with Google</a>
                `;
                sessionInfo.classList.add('active');
            }
        }
    } catch (error) {
        console.error('Start error:', error);
        showStatus(`Connection error: ${error.message}`, 'error');
    } finally {
        startSessionBtn.disabled = false;
        startSessionBtn.textContent = '🎬 Start New Session';
    }
});

// Keep session alive
function startKeepAlive(apiSecret) {
    if (keepAliveInterval) clearInterval(keepAliveInterval);
    keepAliveInterval = setInterval(async () => {
        if (!currentSessionId) return;
        try {
            const response = await fetch(`${API_BASE}/keepalive`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    sessionId: currentSessionId,
                    api_secret: apiSecret
                })
            });
            const data = await response.json();
            if (data.success) {
                console.log('Keepalive sent');
            }
        } catch (error) {
            console.error('Keepalive failed:', error);
        }
    }, 120000); // Every 2 minutes
}

// Manual keepalive button
keepAliveBtn.addEventListener('click', async () => {
    const apiSecret = apiSecretInput.value.trim();
    if (!currentSessionId || !apiSecret) return;

    keepAliveBtn.disabled = true;
    keepAliveBtn.textContent = 'Pinging...';

    try {
        const response = await fetch(`${API_BASE}/keepalive`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                sessionId: currentSessionId,
                api_secret: apiSecret
            })
        });
        const data = await response.json();
        if (data.success) {
            showStatus('Session kept alive!', 'success');
            execStatus.textContent = `💓 Manual ping at ${new Date().toLocaleTimeString()}`;
        } else {
            showStatus('Keepalive failed', 'error');
        }
    } catch (error) {
        showStatus(`Keepalive error: ${error.message}`, 'error');
    } finally {
        keepAliveBtn.disabled = false;
        keepAliveBtn.textContent = '💓 Keep Alive';
    }
});

// Run async with polling
runAsyncBtn.addEventListener('click', async () => {
    const apiSecret = apiSecretInput.value.trim();
    const code = codeEditor.value.trim();

    if (!code) {
        showStatus('Please enter some code to run', 'warning');
        return;
    }

    if (!currentSessionId) {
        showStatus('Please start a session first', 'warning');
        return;
    }

    runAsyncBtn.disabled = true;
    stopExecutionBtn.disabled = false;
    outputDiv.textContent = '🔄 Starting async execution...';
    showStatus('Starting async execution...', 'info');
    execStatus.textContent = '🔄 Starting...';

    try {
        const response = await fetch(`${API_BASE}/run`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                sessionId: currentSessionId,
                code: code,
                cellNo: 1,
                api_secret: apiSecret
            })
        });
        const data = await response.json();

        if (data.status === 'processing') {
            currentExecutionId = data.executionId;
            outputDiv.textContent = `🚀 Execution started!\n📋 Execution ID: ${currentExecutionId}\n⏱️  Polling for results every ${data.pollInterval/1000} seconds...\n\nWaiting for completion...`;
            showStatus('Code running in background, polling for results...', 'info');
            execStatus.textContent = '🔄 Polling for results...';
            startPolling(apiSecret);
        } else {
            outputDiv.textContent = `Error: ${data.error || 'Unknown error'}`;
            showStatus('Failed to start execution', 'error');
            execStatus.textContent = '❌ Failed to start';
            runAsyncBtn.disabled = false;
            stopExecutionBtn.disabled = true;
        }
    } catch (error) {
        outputDiv.textContent = `Connection error: ${error.message}`;
        showStatus('Connection error', 'error');
        execStatus.textContent = '❌ Connection error';
        runAsyncBtn.disabled = false;
        stopExecutionBtn.disabled = true;
    }
});

// Stop execution
stopExecutionBtn.addEventListener('click', async () => {
    if (!currentSessionId || !currentExecutionId) return;

    if (!confirm('⚠️ Are you sure you want to stop the current execution?\nThis will terminate the running cell.')) return;

    const apiSecret = apiSecretInput.value.trim();
    stopExecutionBtn.disabled = true;
    stopExecutionBtn.textContent = 'Stopping...';

    try {
        const response = await fetch(`${API_BASE}/stop-execution`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                sessionId: currentSessionId,
                executionId: currentExecutionId,
                api_secret: apiSecret
            })
        });
        const data = await response.json();

        if (data.success) {
            showStatus('✅ Execution stopped', 'success');
            execStatus.textContent = '⏹️ Stopped';
            outputDiv.textContent += '\n\n--- ⏹️ Execution stopped by user ---';
            
            // Clear polling
            if (pollInterval) {
                clearInterval(pollInterval);
                pollInterval = null;
            }
            isPolling = false;
            currentExecutionId = null;
            runAsyncBtn.disabled = false;
            stopExecutionBtn.disabled = true;
            
            // Update session state
            const session = sessions.get(currentSessionId);
            if (session) {
                session.status = 'ready';
                session.currentExecution = null;
                sessions.set(currentSessionId, session);
            }
        } else {
            showStatus(`Error: ${data.error}`, 'error');
        }
    } catch (error) {
        showStatus(`Error: ${error.message}`, 'error');
    } finally {
        stopExecutionBtn.disabled = false;
        stopExecutionBtn.textContent = '⏹️ Stop Execution';
    }
});

// Poll for results with incremental output
function startPolling(apiSecret) {
    if (pollInterval) clearInterval(pollInterval);
    isPolling = true;
    let attempts = 0;
    const maxAttempts = 720; // 3 hours max (15s * 720 = 3 hours)
    const startTime = Date.now();

    pollInterval = setInterval(async () => {
        attempts++;
        if (!isPolling) return;

        try {
            const response = await fetch(`${API_BASE}/status`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    sessionId: currentSessionId,
                    executionId: currentExecutionId,
                    api_secret: apiSecret
                })
            });
            const data = await response.json();

            if (data.status === 'completed') {
                clearInterval(pollInterval);
                isPolling = false;
                outputDiv.textContent = data.output || '(No output)';
                if (data.error) {
                    outputDiv.textContent += '\n\n--- Error Stream ---\n' + data.error;
                }
                showStatus(`✅ Execution completed in ${(data.executionTime / 1000).toFixed(2)} seconds`, 'success');
                execStatus.textContent = `✅ Complete (${(data.executionTime / 1000).toFixed(1)}s)`;
                runAsyncBtn.disabled = false;
                stopExecutionBtn.disabled = true;
                currentExecutionId = null;
                pollInterval = null;
            } else if (data.status === 'failed') {
                clearInterval(pollInterval);
                isPolling = false;
                outputDiv.textContent = `❌ Execution failed: ${data.error}`;
                showStatus('Execution failed', 'error');
                execStatus.textContent = '❌ Failed';
                runAsyncBtn.disabled = false;
                stopExecutionBtn.disabled = true;
                currentExecutionId = null;
                pollInterval = null;
            } else if (data.status === 'running') {
                const elapsed = (data.elapsed / 1000).toFixed(1);
                // Update output with partial results
                let outputText = `🏃 Running... (${elapsed} seconds elapsed)\nExecution ID: ${currentExecutionId}\n\n`;
                if (data.partialOutput) {
                    outputText += '--- Partial Output ---\n' + data.partialOutput;
                }
                if (data.partialError) {
                    outputText += '\n\n--- Partial Error Stream ---\n' + data.partialError;
                }
                if (!data.partialOutput && !data.partialError) {
                    outputText += 'Waiting for output...';
                }
                outputDiv.textContent = outputText;
                execStatus.textContent = `🏃 Running (${elapsed}s)`;
            }

            if (attempts >= maxAttempts) {
                clearInterval(pollInterval);
                isPolling = false;
                outputDiv.textContent = '⏰ Polling timeout - execution may still be running\nCheck session status manually.';
                showStatus('Polling timeout', 'warning');
                execStatus.textContent = '⏰ Timeout';
                runAsyncBtn.disabled = false;
                stopExecutionBtn.disabled = true;
                pollInterval = null;
            }
        } catch (error) {
            console.error('Polling error:', error);
            if (attempts >= maxAttempts) {
                clearInterval(pollInterval);
                isPolling = false;
                pollInterval = null;
            }
        }
    }, 15000); // Poll every 15 seconds
}

// Stop session
stopSessionBtn.addEventListener('click', async () => {
    if (!confirm('⚠️ Are you sure you want to terminate this session?\nAll running code will be stopped.')) return;

    const apiSecret = apiSecretInput.value.trim();
    stopSessionBtn.disabled = true;
    stopSessionBtn.textContent = 'Terminating...';

    try {
        const response = await fetch(`${API_BASE}/session/${currentSessionId}`, {
            method: 'DELETE',
            headers: { 
                'Content-Type': 'application/json',
                'api-secret': apiSecret
            }
        });
        const data = await response.json();

        if (data.success) {
            if (keepAliveInterval) clearInterval(keepAliveInterval);
            if (pollInterval) clearInterval(pollInterval);
            isPolling = false;
            currentSessionId = null;
            currentExecutionId = null;
            sessionInfo.classList.remove('active');
            sessionInfo.innerHTML = '';
            runAsyncBtn.disabled = true;
            keepAliveBtn.disabled = true;
            stopSessionBtn.disabled = true;
            stopExecutionBtn.disabled = true;
            outputDiv.textContent = 'Session terminated. Start a new session to run code.';
            showStatus('✅ Session terminated successfully', 'success');
            execStatus.textContent = '';
        } else {
            showStatus(`Error: ${data.error}`, 'error');
        }
    } catch (error) {
        showStatus(`Error: ${error.message}`, 'error');
    } finally {
        stopSessionBtn.disabled = false;
        stopSessionBtn.textContent = '🛑 Stop Session';
    }
});

// Show status message
function showStatus(message, type) {
    statusDiv.textContent = message;
    statusDiv.className = `status ${type}`;
    setTimeout(() => {
        if (statusDiv.textContent === message) {
            statusDiv.classList.add('fade-out');
            setTimeout(() => {
                if (statusDiv.textContent === message) {
                    statusDiv.className = 'status';
                    statusDiv.textContent = '';
                    statusDiv.classList.remove('fade-out');
                }
            }, 300);
        }
    }, 5000);
}

// Set example code on load
codeEditor.value = EXAMPLE_CODE;

// Check server health on load
async function checkHealth() {
    try {
        const response = await fetch(`${API_BASE}/health`);
        const data = await response.json();
        console.log('Server health:', data);
        if (data.status === 'healthy') {
            showStatus(`✅ Connected to server at ${API_BASE}`, 'success');
        }
    } catch (error) {
        console.error('Health check failed:', error);
        showStatus(`⚠️ Cannot connect to backend at ${API_BASE}. Make sure server is running.`, 'warning');
    }
}
checkHealth();

// Auto-refresh session info every 30 seconds
setInterval(() => {
    if (currentSessionId && sessionInfo.classList.contains('active')) {
        const lastActive = new Date().toLocaleTimeString();
        const sessionText = sessionInfo.innerHTML;
        if (!sessionText.includes(`Last activity: ${lastActive}`)) {
            sessionInfo.innerHTML = sessionText.replace(
                /(Last activity:.*)?(<br>|$)/, 
                `Last activity: ${lastActive}<br>`
            );
        }
    }
}, 30000);
