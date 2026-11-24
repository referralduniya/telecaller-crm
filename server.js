const express = require('express');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const XLSX = require('xlsx');
const ExcelJS = require('exceljs');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-render-settings';
const upload = multer({ storage: multer.memoryStorage() });

// ---------- DATABASE (works with TiDB Cloud / any MySQL) ----------
const db = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'test',
    ssl: process.env.DB_SSL === 'true' ? { minVersion: 'TLSv1.2', rejectUnauthorized: true } : undefined,
    enableKeepAlive: true,
    waitForConnections: true,
    connectionLimit: 5
});

// Wrap async routes so errors return JSON instead of crashing the server
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch((e) => {
    console.error(e);
    res.status(500).json({ error: e.message || 'Server error' });
});

// ---------- AUTO SETUP: tables + test users ----------
async function setupDatabase() {
    await db.query(`CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        email VARCHAR(100) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        role ENUM('super_user','manager','agent') NOT NULL,
        created_by INT NULL,
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);
    await db.query(`CREATE TABLE IF NOT EXISTS leads (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        phone VARCHAR(20) NOT NULL,
        salary VARCHAR(50),
        assigned_to INT NULL,
        uploaded_by INT NOT NULL,
        status ENUM('Pending','Connected','Off','Interested','Not Interested','Callback') DEFAULT 'Pending',
        final_revert TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )`);
    await db.query(`CREATE TABLE IF NOT EXISTS call_logs (
        id INT AUTO_INCREMENT PRIMARY KEY,
        lead_id INT NOT NULL,
        agent_id INT NOT NULL,
        call_status ENUM('Connected','Off','Interested','Not Interested','Callback') NOT NULL,
        final_revert TEXT,
        duration_seconds INT DEFAULT 0,
        called_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);
    await db.query(`CREATE TABLE IF NOT EXISTS agent_sessions (
        id INT AUTO_INCREMENT PRIMARY KEY,
        agent_id INT NOT NULL,
        login_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        logout_time TIMESTAMP NULL
    )`);

    const seed = async (name, email, password, role) => {
        const [r] = await db.query('SELECT id FROM users WHERE email = ?', [email]);
        if (r.length) return;
        const hash = await bcrypt.hash(password, 10);
        await db.query('INSERT INTO users (name,email,password_hash,role) VALUES (?,?,?,?)', [name, email, hash, role]);
        console.log(`Created ${role}: ${email}`);
    };
    await seed('Super User', process.env.SUPER_EMAIL || 'super@test.com', process.env.SUPER_PASSWORD || 'Super@123', 'super_user');
    if (process.env.SEED_DEMO !== 'false') {
        await seed('Test Manager', 'manager@test.com', 'Manager@123', 'manager');
        await seed('Test Agent', 'agent@test.com', 'Agent@123', 'agent');
    }
}

// ---------- AUTH ----------
const auth = (roles = []) => (req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        if (roles.length && !roles.includes(decoded.role)) {
            return res.status(403).json({ error: 'Forbidden' });
        }
        req.user = decoded;
        next();
    } catch {
        res.status(401).json({ error: 'Invalid token' });
    }
};

app.get('/api/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

app.post('/api/login', wrap(async (req, res) => {
    const { email, password } = req.body;
    const [rows] = await db.query('SELECT * FROM users WHERE email = ? AND is_active = TRUE', [email]);
    const user = rows[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
        return res.status(401).json({ error: 'Invalid credentials' });
    }
    if (user.role === 'agent') {
        await db.query('INSERT INTO agent_sessions (agent_id) VALUES (?)', [user.id]);
    }
    const token = jwt.sign({ id: user.id, role: user.role, name: user.name }, JWT_SECRET, { expiresIn: '12h' });
    res.json({ token, role: user.role, name: user.name });
}));

// ---------- USERS ----------
app.post('/api/users', auth(['super_user', 'manager']), wrap(async (req, res) => {
    const { name, email, password, role } = req.body;
    if (!name || !email || !password || !['manager', 'agent'].includes(role)) {
        return res.status(400).json({ error: 'Name, email, password and role (manager/agent) required' });
    }
    if (req.user.role === 'manager' && role !== 'agent') {
        return res.status(403).json({ error: 'Managers can only create Agents' });
    }
    const hash = await bcrypt.hash(password, 10);
    try {
        await db.query(
            'INSERT INTO users (name, email, password_hash, role, created_by) VALUES (?, ?, ?, ?, ?)',
            [name, email, hash, role, req.user.id]
        );
    } catch (e) {
        if (e.code === 'ER_DUP_ENTRY') return res.status(400).json({ error: 'Email already exists' });
        throw e;
    }
    res.json({ message: `${role} created successfully` });
}));

app.get('/api/users', auth(['super_user', 'manager']), wrap(async (req, res) => {
    const [rows] = await db.query('SELECT id, name, email, role, created_at FROM users ORDER BY id');
    res.json(rows);
}));

// ---------- LEADS ----------
app.post('/api/leads/upload', auth(['super_user', 'manager']), upload.single('file'), wrap(async (req, res) => {
    const { agent_id } = req.body;
    if (!req.file) return res.status(400).json({ error: 'Please choose a file' });
    if (!agent_id) return res.status(400).json({ error: 'Agent ID required' });
    const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet);
    if (!rows.length) return res.status(400).json({ error: 'File is empty' });

    const values = rows.map(r => [
        r.Name || r.name || 'Unknown',
        String(r.Number || r.number || r.Phone || r.phone || ''),
        String(r.Salary || r.salary || ''),
        agent_id,
        req.user.id
    ]);
    await db.query('INSERT INTO leads (name, phone, salary, assigned_to, uploaded_by) VALUES ?', [values]);
    res.json({ message: `${values.length} leads uploaded and assigned.` });
}));

app.get('/api/agent/leads', auth(['agent']), wrap(async (req, res) => {
    const [leads] = await db.query(
        "SELECT * FROM leads WHERE assigned_to = ? ORDER BY (status = 'Pending') DESC, id DESC",
        [req.user.id]
    );
    res.json(leads);
}));

app.post('/api/agent/call-log', auth(['agent']), wrap(async (req, res) => {
    const { lead_id, call_status, final_revert, duration_seconds } = req.body;
    await db.query(
        'INSERT INTO call_logs (lead_id, agent_id, call_status, final_revert, duration_seconds) VALUES (?, ?, ?, ?, ?)',
        [lead_id, req.user.id, call_status, final_revert, duration_seconds || 0]
    );
    await db.query('UPDATE leads SET status = ?, final_revert = ? WHERE id = ?', [call_status, final_revert, lead_id]);
    res.json({ message: 'Call logged successfully' });
}));

// ---------- LIVE STATUS (for Super User / Manager) ----------
app.get('/api/live/status', auth(['super_user', 'manager']), wrap(async (req, res) => {
    const [agents] = await db.query(`
        SELECT u.id, u.name,
               (SELECT MAX(login_time) FROM agent_sessions s WHERE s.agent_id = u.id) AS last_login,
               (SELECT MAX(called_at) FROM call_logs c WHERE c.agent_id = u.id) AS last_call,
               (SELECT COUNT(*) FROM call_logs c WHERE c.agent_id = u.id AND DATE(c.called_at) = CURDATE()) AS calls_today,
               (SELECT COALESCE(ROUND(SUM(duration_seconds)/60,1),0) FROM call_logs c WHERE c.agent_id = u.id AND DATE(c.called_at) = CURDATE()) AS talk_mins_today,
               (SELECT COUNT(*) FROM leads l WHERE l.assigned_to = u.id AND l.status = 'Pending') AS pending_leads
        FROM users u WHERE u.role = 'agent' ORDER BY u.id`);
    const [recent] = await db.query(`
        SELECT u.name AS agent_name, l.name AS lead_name, l.phone, c.call_status, c.duration_seconds,
               DATE_FORMAT(c.called_at, '%Y-%m-%d %H:%i:%s') AS called_at
        FROM call_logs c JOIN users u ON c.agent_id = u.id JOIN leads l ON c.lead_id = l.id
        ORDER BY c.id DESC LIMIT 20`);
    res.json({ agents, recent });
}));

// ---------- EXCEL REPORT ----------
app.get('/api/reports/export', auth(['super_user', 'manager']), wrap(async (req, res) => {
    const workbook = new ExcelJS.Workbook();

    const detailSheet = workbook.addWorksheet('Call Details');
    detailSheet.columns = [
        { header: 'Lead Name', key: 'lead_name', width: 20 },
        { header: 'Number', key: 'phone', width: 15 },
        { header: 'Salary', key: 'salary', width: 12 },
        { header: 'Agent Name', key: 'agent_name', width: 18 },
        { header: 'Status', key: 'call_status', width: 15 },
        { header: 'Final Revert', key: 'final_revert', width: 30 },
        { header: 'Call Time', key: 'called_at', width: 22 }
    ];
    const [details] = await db.query(`
        SELECT l.name AS lead_name, l.phone, l.salary, u.name AS agent_name,
               c.call_status, c.final_revert, DATE_FORMAT(c.called_at, '%Y-%m-%d %H:%i:%s') AS called_at
        FROM call_logs c
        JOIN leads l ON c.lead_id = l.id
        JOIN users u ON c.agent_id = u.id
        ORDER BY c.called_at DESC`);
    detailSheet.addRows(details);

    const hourlySheet = workbook.addWorksheet('Hourly Timeline');
    hourlySheet.columns = [
        { header: 'Agent Name', key: 'agent_name', width: 20 },
        { header: 'Date & Hour', key: 'hour_slot', width: 20 },
        { header: 'Total Calls', key: 'total_calls', width: 12 },
        { header: 'Connected', key: 'connected_calls', width: 12 },
        { header: 'Off / Switched Off', key: 'off_calls', width: 18 },
        { header: 'Interested', key: 'interested_calls', width: 12 },
        { header: 'Talk Time (Mins)', key: 'talk_mins', width: 16 }
    ];
    const [hourly] = await db.query(`
        SELECT u.name AS agent_name,
               DATE_FORMAT(c.called_at, '%Y-%m-%d %H:00') AS hour_slot,
               COUNT(*) AS total_calls,
               SUM(c.call_status = 'Connected') AS connected_calls,
               SUM(c.call_status = 'Off') AS off_calls,
               SUM(c.call_status = 'Interested') AS interested_calls,
               ROUND(SUM(c.duration_seconds) / 60, 2) AS talk_mins
        FROM call_logs c
        JOIN users u ON c.agent_id = u.id
        GROUP BY u.id, u.name, hour_slot
        ORDER BY hour_slot DESC`);
    hourlySheet.addRows(hourly);

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=Telecalling_Report.xlsx');
    await workbook.xlsx.write(res);
    res.end();
}));

// ---------- START ----------
const PORT = process.env.PORT || 5000;
setupDatabase()
    .then(() => app.listen(PORT, () => console.log(`CRM Server running on port ${PORT}`)))
    .catch((e) => { console.error('Database setup failed:', e.message); process.exit(1); });
