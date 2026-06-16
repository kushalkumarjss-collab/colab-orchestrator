const express = require('express');
const { spawn, exec } = require('child_process');
const util = require('util');
const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const cors = require('cors');
require('dotenv').config();
const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, '..')));

// Configuration
const API_SECRET = process.env.API_SECRET || "kushalkumarjthegreat";
const MAX_SESSIONS = parseInt(process.env.MAX_SESSIONS) || 2;
const SESSION_TIMEOUT = 3 * 60 * 60 * 1000; // 3 hours
const EXECUTION_TIMEOUT = 7200; // 2 hours
const MAX_CODE_SIZE = 3*1024 * 1024; // 1MB
const COMPLETED_EXECUTIONS_TTL = 10 * 60 * 1000; // 5 minutes
const POLL_INTERVAL = 15000; // 15 seconds

// Session folders base directory
const SESSIONS_BASE_DIR = path.join(os.tmpdir(), 'colab_sessions');

// Colab binary configuration
let COLAB_BINARY = 'colab';
let USE_PYTHON_MODULE = false;

// Find colab binary recursively
async function findColabBinaryRecursive() {
    const { execSync } = require('child_process');
    console.log('🔍 Searching for colab binary...');
    
    try {
        const whichPath = execSync('which colab 2>/dev/null || echo ""', { encoding: 'utf8', timeout: 5000 }).trim();
        if (whichPath && whichPath !== '') {
            console.log(`✅ Found colab via which: ${whichPath}`);
            return whichPath;
        }
    } catch(e) {}

    try {
        const pipPath = execSync('pip3 show google-colab-cli | grep Location | cut -d" " -f2', { encoding: 'utf8', timeout: 5000 }).trim();
        if (pipPath) {
            console.log(`📦 pip location: ${pipPath}`);
            const possibleBinary = `${pipPath}/colab_cli/__main__.py`;
            if (require('fs').existsSync(possibleBinary)) {
                console.log(`✅ Found colab via pip: ${possibleBinary}`);
                return 'python3';
            }
        }
    } catch(e) {}

    const searchPaths = [
        '/opt/render/.local/bin',
        '/usr/local/bin', 
        '/usr/bin',
        '/opt/render/project/.local/bin',
        '/home/render/.local/bin',
        '/opt/render/project/src/.local/bin'
    ];
    
    for (const searchPath of searchPaths) {
        try {
            const result = execSync(`find ${searchPath} -name "colab" -type f 2>/dev/null | head -1`, { encoding: 'utf8', timeout: 10000 }).trim();
            if (result && result !== '') {
                console.log(`✅ Found colab via recursive search: ${result}`);
                try {
                    execSync(`chmod +x "${result}"`, { stdio: 'ignore' });
                } catch(e) {}
                return result;
            }
        } catch(e) {}
    }

    const existingBinary = path.join(__dirname, 'colab');
    if (require('fs').existsSync(existingBinary)) {
        try {
            const content = require('fs').readFileSync(existingBinary, 'utf8').slice(0, 200);
            if (content.includes('python') || content.includes('#!/')) {
                console.log(`✅ Existing binary is a Python script, using python3 -m colab_cli`);
                return 'python3';
            }
        } catch(e) {}
    }

    console.warn('⚠️ colab binary not found, will use python3 -m colab_cli');
    return 'python3';
}

// Initialize colab binary
async function initColabBinary() {
    const binary = await findColabBinaryRecursive();
    if (binary === 'python3') {
        USE_PYTHON_MODULE = true;
        COLAB_BINARY = 'python3';
        console.log(`🔧 Using Python module: ${COLAB_BINARY} -m colab_cli`);
    } else {
        COLAB_BINARY = binary;
        USE_PYTHON_MODULE = false;
        console.log(`🔧 Using colab binary: ${COLAB_BINARY}`);
    }
}

// Run colab CLI command
async function runColabCli(args, timeout = 30000) {
    return new Promise((resolve, reject) => {
        let command;
        if (USE_PYTHON_MODULE) {
            const escapedArgs = args.map(a => `"${a.replace(/"/g, '\\"')}"`).join(' ');
            command = `${COLAB_BINARY} -m colab_cli ${escapedArgs}`;
        } else {
            const escapedArgs = args.map(a => `"${a.replace(/"/g, '\\"')}"`).join(' ');
            command = `${COLAB_BINARY} ${escapedArgs}`;
        }
        console.log(`Running: ${command}`);
        exec(command, { timeout, shell: '/bin/bash', maxBuffer: 50 * 1024 * 1024 }, (error, stdout, stderr) => {
            if (error && error.code !== 0) {
                console.error(`Command failed: ${error.message}`);
                reject({ error, stdout, stderr });
            } else {
                resolve({ stdout, stderr });
            }
        });
    });
}

// Setup Colab authentication from environment token
async function setupColabAuth() {
    if (!process.env.COLAB_AUTH_TOKEN) {
        console.warn('⚠️ COLAB_AUTH_TOKEN not found in environment');
        return false;
    }

    try {
        let rawToken = process.env.COLAB_AUTH_TOKEN.trim();
        if ((rawToken.startsWith("'") && rawToken.endsWith("'")) || 
            (rawToken.startsWith('"') && rawToken.endsWith('"'))) {
            rawToken = rawToken.slice(1, -1);
            console.log('📝 Stripped surrounding quotes from token');
        }

        const tokenData = JSON.parse(rawToken);
        console.log('✅ Parsed COLAB_AUTH_TOKEN successfully');
        
        const configDir = path.join(os.homedir(), '.config/colab-cli');
        await fs.mkdir(configDir, { recursive: true });
        await fs.writeFile(
            path.join(configDir, 'token.json'), 
            JSON.stringify(tokenData, null, 2)
        );
        console.log('✅ Written token.json');

        const sessionsConfig = {
            sessions: {},
            activeSession: null
        };
        await fs.writeFile(
            path.join(configDir, 'sessions.json'), 
            JSON.stringify(sessionsConfig, null, 2)
        );
        console.log('✅ Written sessions.json');
        return true;
    } catch (error) {
        console.error('❌ Auth setup failed:', error.message);
        return false;
    }
}

// Create session folder
async function createSessionFolder(sessionId) {
    const sessionFolder = path.join(SESSIONS_BASE_DIR, sessionId);
    await fs.mkdir(sessionFolder, { recursive: true });
    return sessionFolder;
}

// Clean up session folder
async function cleanupSessionFolder(sessionId) {
    const sessionFolder = path.join(SESSIONS_BASE_DIR, sessionId);
    try {
        await fs.rm(sessionFolder, { recursive: true, force: true });
        console.log(`✅ Cleaned up folder for session ${sessionId}`);
    } catch (error) {
        console.error(`Failed to cleanup folder for ${sessionId}:`, error.message);
    }
}

// Clean up all sessions and start fresh
async function cleanupAllSessionsAndCreateNew() {
    console.log('🧹 Cleaning up all sessions...');
    const currentSessions = Array.from(sessions.keys());
    for (const sessionId of currentSessions) {
        const session = sessions.get(sessionId);
        if (session) {
            try {
                await runColabCli(['stop', '-s', session.colabSession], 10000);
            } catch (error) {}
            await cleanupSessionFolder(sessionId);
        }
    }
    sessions.clear();
    try {
        await fs.rm(SESSIONS_BASE_DIR, { recursive: true, force: true });
        await fs.mkdir(SESSIONS_BASE_DIR, { recursive: true });
    } catch (error) {}
    console.log('✅ All sessions cleaned up');
}

// Simple API secret validation
function validateApiSecret(input) {
    if (!input) return false;
    return input === API_SECRET;
}

// Extract API secret from various locations
function extractApiSecret(req) {
    return req.body?.api_secret || 
           req.headers['api-secret'] || 
           req.headers['x-api-secret'];
}

// State management
const sessions = new Map();
const executionQueue = new Set();
const completedExecutions = new Map();
const executionProcesses = new Map(); // Track execution processes for stopping

// Cleanup completed executions periodically
setInterval(() => {
    const now = Date.now();
    for (const [execId, data] of completedExecutions.entries()) {
        if (now - data.completedAt > COMPLETED_EXECUTIONS_TTL) {
            completedExecutions.delete(execId);
        }
    }
}, 60 * 1000);

function generateSessionId() {
    return crypto.randomBytes(32).toString('hex');
}

// Execute code with streaming output capture
async function executeCodeInColab(sessionId, cellNo, code, executionId) {
    const session = sessions.get(sessionId);
    if (!session) throw new Error('Session not found');

    const startedAt = Date.now();
    let process = null;
    
    try {
        if (Buffer.byteLength(code, 'utf8') > MAX_CODE_SIZE) {
            throw new Error(`Code exceeds ${MAX_CODE_SIZE} bytes`);
        }

        // Save code to session folder
        const sessionFolder = path.join(SESSIONS_BASE_DIR, sessionId);
        const codeFile = path.join(sessionFolder, `code_${cellNo}.py`);
        await fs.writeFile(codeFile, code, 'utf8');

        // Execute using stdin piping
        const escapedCode = code
            .replace(/\\/g, '\\\\')
            .replace(/`/g, '\\`')
            .replace(/\$/g, '\\$')
            .replace(/"/g, '\\"');

        let command;
        if (USE_PYTHON_MODULE) {
            command = `echo "${escapedCode}" | python3 -m colab_cli exec -s ${session.colabSession} --timeout ${EXECUTION_TIMEOUT}`;
        } else {
            command = `echo "${escapedCode}" | ${COLAB_BINARY} exec -s ${session.colabSession} --timeout ${EXECUTION_TIMEOUT}`;
        }

        // Store process reference for stop functionality
        process = exec(command, { 
            timeout: EXECUTION_TIMEOUT * 1000, 
            maxBuffer: 50 * 1024 * 1024,
            shell: '/bin/bash'
        });

        // Store process reference
        executionProcesses.set(executionId, process);

        // Capture output incrementally
        let stdout = '';
        let stderr = '';
        let hasOutput = false;

        process.stdout.on('data', (data) => {
            const chunk = data.toString();
            stdout += chunk;
            hasOutput = true;
            
            // Update session with partial output for polling
            const currentSession = sessions.get(sessionId);
            if (currentSession && currentSession.currentExecution?.executionId === executionId) {
                currentSession.currentExecution.partialOutput = stdout;
                currentSession.currentExecution.partialError = stderr;
                sessions.set(sessionId, currentSession);
            }
        });

        process.stderr.on('data', (data) => {
            const chunk = data.toString();
            stderr += chunk;
            hasOutput = true;
            
            const currentSession = sessions.get(sessionId);
            if (currentSession && currentSession.currentExecution?.executionId === executionId) {
                currentSession.currentExecution.partialOutput = stdout;
                currentSession.currentExecution.partialError = stderr;
                sessions.set(sessionId, currentSession);
            }
        });

        // Wait for process to complete
        const result = await new Promise((resolve, reject) => {
            process.on('close', (code) => {
                if (code !== 0) {
                    reject({ error: new Error(`Process exited with code ${code}`), stdout, stderr });
                } else {
                    resolve({ stdout, stderr });
                }
            });
            
            process.on('error', (err) => {
                reject({ error: err, stdout, stderr });
            });
        });

        const completedAt = Date.now();
        const output = { 
            status: 'completed', 
            output: result.stdout || '(No output)', 
            error: result.stderr || '',
            startedAt, 
            completedAt,
            executionTime: completedAt - startedAt
        };
        
        completedExecutions.set(executionId, output);
        executionProcesses.delete(executionId);

        const updatedSession = sessions.get(sessionId);
        if (updatedSession && updatedSession.currentExecution?.executionId === executionId) {
            updatedSession.currentExecution = null;
            updatedSession.status = 'ready';
            sessions.set(sessionId, updatedSession);
        }

        return output;
    } catch (error) {
        const completedAt = Date.now();
        const failureResult = {
            status: 'failed',
            output: error.stdout || '',
            error: error.stderr || error.message || String(error),
            startedAt,
            completedAt,
            executionTime: completedAt - startedAt
        };
        completedExecutions.set(executionId, failureResult);
        executionProcesses.delete(executionId);

        const updatedSession = sessions.get(sessionId);
        if (updatedSession && updatedSession.currentExecution?.executionId === executionId) {
            updatedSession.currentExecution = null;
            updatedSession.status = 'ready';
            sessions.set(sessionId, updatedSession);
        }
        throw error;
    }
}

// Stop execution
async function stopExecution(sessionId, executionId) {
    const session = sessions.get(sessionId);
    if (!session) {
        throw new Error('Session not found');
    }

    const process = executionProcesses.get(executionId);
    if (process) {
        process.kill('SIGINT'); // Send Ctrl+C equivalent
        executionProcesses.delete(executionId);
        
        // Update session status
        session.currentExecution = null;
        session.status = 'ready';
        sessions.set(sessionId, session);
        
        return { success: true, message: 'Execution stopped' };
    } else {
        // Check if already completed
        if (completedExecutions.has(executionId)) {
            return { success: true, message: 'Execution already completed' };
        }
        throw new Error('Execution process not found');
    }
}

async function backgroundExecution(sessionId, cellNo, code, executionId) {
    const execKey = `${sessionId}_${cellNo}`;
    if (executionQueue.has(execKey)) return;
    
    executionQueue.add(execKey);
    try {
        await executeCodeInColab(sessionId, cellNo, code, executionId);
    } catch (error) {
        console.error(`Background error:`, error.message);
    } finally {
        executionQueue.delete(execKey);
    }
}

// ============= API ENDPOINTS =============

app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        activeSessions: sessions.size,
        maxSessions: MAX_SESSIONS,
        completedExecutions: completedExecutions.size,
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        colabBinary: COLAB_BINARY,
        usePythonModule: USE_PYTHON_MODULE,
        hasAuthToken: !!process.env.COLAB_AUTH_TOKEN
    });
});

app.post('/start', async (req, res) => {
    const apiSecret = extractApiSecret(req);
    if (!validateApiSecret(apiSecret)) {
        return res.status(401).json({ error: 'Invalid API secret' });
    }

    if (sessions.size >= MAX_SESSIONS) {
        console.log(`Max sessions (${MAX_SESSIONS}) reached, cleaning up all sessions...`);
        await cleanupAllSessionsAndCreateNew();
    }

    const sessionId = generateSessionId();
    const colabSessionName = `colab_${sessionId.substring(0, 12)}`;

    try {
        await createSessionFolder(sessionId);
        await runColabCli(['new', '--gpu', 'T4', '-s', colabSessionName], 60000);
        
        sessions.set(sessionId, {
            colabSession: colabSessionName,
            createdAt: Date.now(),
            lastActivity: Date.now(),
            status: 'ready',
            currentExecution: null,
            folder: path.join(SESSIONS_BASE_DIR, sessionId)
        });

        res.json({
            success: true,
            sessionId: sessionId,
            authUrl: null,
            expiresIn: SESSION_TIMEOUT,
            message: 'Session created successfully'
        });
    } catch (error) {
        console.error('Session creation failed:', error.message);
        await cleanupSessionFolder(sessionId);
        
        const child = spawn(COLAB_BINARY, USE_PYTHON_MODULE ? ['-m', 'colab_cli', 'new', '--gpu', 'T4', '-s', colabSessionName] : ['new', '--gpu', 'T4', '-s', colabSessionName]);
        let authUrl = null;
        let outputBuffer = '';
        const timeout = setTimeout(() => {
            if (!authUrl) {
                child.kill();
                res.status(500).json({ 
                    error: 'Failed to create session', 
                    details: 'Authentication required or token expired'
                });
            }
        }, 10000);

        const handleOutput = (data) => {
            outputBuffer += data.toString();
            const match = outputBuffer.match(/https:\/\/accounts\.google\.com\/o\/oauth2\/auth[^\s]+/);
            if (match && !authUrl) {
                authUrl = match[0].split('"')[0].split("'")[0].split('\n')[0];
                clearTimeout(timeout);
                child.kill();
                res.json({
                    success: false,
                    needsAuth: true,
                    authUrl: authUrl,
                    message: 'Please authenticate with Google'
                });
            }
        };

        child.stdout.on('data', handleOutput);
        child.stderr.on('data', handleOutput);
        child.on('error', (err) => {
            clearTimeout(timeout);
            if (!authUrl) {
                res.status(500).json({ error: 'Failed to create session', details: err.message });
            }
        });
    }
});

app.post('/keepalive', async (req, res) => {
    const apiSecret = extractApiSecret(req);
    if (!validateApiSecret(apiSecret)) {
        return res.status(401).json({ error: 'Invalid API secret' });
    }

    const { sessionId } = req.body;
    if (!sessionId) {
        return res.status(400).json({ error: 'sessionId required' });
    }

    const session = sessions.get(sessionId);
    if (!session) {
        return res.status(404).json({ error: 'Session not found' });
    }

    try {
        await runColabCli(['sessions'], 10000);
        session.lastActivity = Date.now();
        sessions.set(sessionId, session);
        res.json({ success: true, message: 'Session kept alive' });
    } catch (error) {
        res.status(500).json({ error: 'Keepalive failed', details: error.message });
    }
});

// Run endpoint - always async
app.post('/run', async (req, res) => {
    const apiSecret = extractApiSecret(req);
    if (!validateApiSecret(apiSecret)) {
        return res.status(401).json({ error: 'Invalid API secret' });
    }

    const { sessionId, code, cellNo } = req.body;
    if (!sessionId || !code || cellNo === undefined) {
        return res.status(400).json({ error: 'Missing required fields: sessionId, code, cellNo' });
    }

    const session = sessions.get(sessionId);
    if (!session) {
        return res.status(404).json({ error: 'Session not found' });
    }

    if (session.status === 'busy') {
        return res.status(409).json({ 
            error: 'Session busy',
            currentExecution: session.currentExecution
        });
    }

    const executionId = crypto.randomBytes(16).toString('hex');
    const validCellNo = parseInt(cellNo, 10);

    session.status = 'busy';
    session.lastActivity = Date.now();
    session.currentExecution = {
        executionId: executionId,
        cellNo: validCellNo,
        startedAt: Date.now(),
        status: 'running',
        partialOutput: '',
        partialError: ''
    };
    sessions.set(sessionId, session);

    // Start background execution
    backgroundExecution(sessionId, validCellNo, code, executionId);

    res.json({
        status: 'processing',
        sessionId: sessionId,
        executionId: executionId,
        pollInterval: POLL_INTERVAL,
        message: 'Code execution started. Poll /status for results.'
    });
});

// Stop execution endpoint
app.post('/stop-execution', async (req, res) => {
    const apiSecret = extractApiSecret(req);
    if (!validateApiSecret(apiSecret)) {
        return res.status(401).json({ error: 'Invalid API secret' });
    }

    const { sessionId, executionId } = req.body;
    if (!sessionId || !executionId) {
        return res.status(400).json({ error: 'Missing required fields: sessionId, executionId' });
    }

    try {
        const result = await stopExecution(sessionId, executionId);
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/status', async (req, res) => {
    const apiSecret = extractApiSecret(req);
    if (!validateApiSecret(apiSecret)) {
        return res.status(401).json({ error: 'Invalid API secret' });
    }

    const { sessionId, executionId } = req.body;
    if (!sessionId || !executionId) {
        return res.status(400).json({ error: 'Missing required fields: sessionId, executionId' });
    }

    // Check if completed
    if (completedExecutions.has(executionId)) {
        const record = completedExecutions.get(executionId);
        return res.json({
            status: record.status,
            output: record.output,
            error: record.error,
            executionTime: record.executionTime
        });
    }

    const session = sessions.get(sessionId);
    if (!session) {
        return res.status(404).json({ error: 'Session not found' });
    }

    const execution = session.currentExecution;
    if (execution && execution.executionId === executionId) {
        // Return partial output if available
        return res.json({
            status: 'running',
            elapsed: Date.now() - execution.startedAt,
            partialOutput: execution.partialOutput || '',
            partialError: execution.partialError || ''
        });
    }

    res.json({ 
        status: 'not_found',
        message: 'Execution not found or already completed'
    });
});

app.post('/status/ack', async (req, res) => {
    const apiSecret = extractApiSecret(req);
    if (!validateApiSecret(apiSecret)) {
        return res.status(401).json({ error: 'Invalid API secret' });
    }

    const { executionId } = req.body;
    if (executionId && completedExecutions.has(executionId)) {
        completedExecutions.delete(executionId);
        res.json({ success: true, message: 'Acknowledged' });
    } else {
        res.json({ success: false, message: 'Execution not found' });
    }
});

app.delete('/session/:sessionId', async (req, res) => {
    const apiSecret = extractApiSecret(req);
    if (!validateApiSecret(apiSecret)) {
        return res.status(401).json({ error: 'Invalid API secret' });
    }

    const { sessionId } = req.params;
    const session = sessions.get(sessionId);
    if (!session) {
        return res.status(404).json({ error: 'Session not found' });
    }

    try {
        await runColabCli(['stop', '-s', session.colabSession], 30000);
        await cleanupSessionFolder(sessionId);
        sessions.delete(sessionId);
        res.json({ success: true, message: 'Session terminated' });
    } catch (error) {
        await cleanupSessionFolder(sessionId);
        sessions.delete(sessionId);
        res.json({ 
            success: true, 
            warning: 'Session removed from tracking, but may still exist remotely' 
        });
    }
});

// Cleanup idle sessions
async function cleanupIdleSessions() {
    const now = Date.now();
    let cleaned = 0;
    for (const [sessionId, session] of sessions.entries()) {
        if (now - session.lastActivity > SESSION_TIMEOUT && session.status !== 'busy') {
            try {
                await runColabCli(['stop', '-s', session.colabSession], 10000);
                await cleanupSessionFolder(sessionId);
                cleaned++;
            } catch (error) {}
            sessions.delete(sessionId);
        }
    }
    if (cleaned > 0) {
        console.log(`Cleaned up ${cleaned} idle sessions`);
    }
    setTimeout(cleanupIdleSessions, 60 * 60 * 1000);
}

// Initialize and start
async function init() {
    await initColabBinary();
    await fs.mkdir(SESSIONS_BASE_DIR, { recursive: true });
    await setupColabAuth();
    setTimeout(cleanupIdleSessions, 60 * 60 * 1000);

    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
        console.log(`\n🚀 Colab Orchestrator running on port ${PORT}`);
        console.log(`📁 Static files from: ${path.join(__dirname, '..')}`);
        console.log(`📁 Sessions folder: ${SESSIONS_BASE_DIR}`);
        console.log(`🔧 Colab binary: ${COLAB_BINARY} ${USE_PYTHON_MODULE ? '(-m colab_cli)' : ''}`);
        console.log(`📊 Max sessions: ${MAX_SESSIONS}`);
        console.log(`🔐 API Secret: ${API_SECRET !== 'kushalkumarjthegreat' ? '✅ Custom' : '⚠️ Default'}`);
        console.log(`🔑 Colab Auth: ${process.env.COLAB_AUTH_TOKEN ? '✅ Token configured' : '⚠️ No token'}`);
        console.log(`⏰ Session timeout: ${SESSION_TIMEOUT / 1000 / 60 / 60} hours`);
        console.log(`⏱️  Execution timeout: ${EXECUTION_TIMEOUT / 60} minutes`);
        console.log(`\n🌐 Open: http://localhost:${PORT}`);
        console.log(`🔑 API Secret: ${API_SECRET}\n`);
    });
}

init();
