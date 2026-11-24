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

const JWT_SECRET = process.env.JWT_SECRET || 'YOUR_STRONG_SECRET_KEY';
const upload = multer({ storage: multer.memoryStorage() });

const db = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || 'YOUR_DB_PASSWORD',
    database: process.env.DB_NAME || 'telecaller_crm'
});

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

app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    const [rows] = await db.query('SELECT * FROM users WHERE email = ?', [email]);
    const user = rows[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
        return res.status(401).json({ error: 'Invalid credentials' });
    }
    if (user.role === 'agent') {
        await db.query('INSERT INTO agent_sessions (agent_id) VALUES (?)', [user.id]);
    }
    const token = jwt.sign({ id: user.id, role: user.role, name: user.name }, JWT_SECRET, { expiresIn: '12h' });
    res.json({ token, role: user.role, name: user.name });
});

app.post('/api/users', auth(['super_user', 'manager']), async (req, res) => {
    const { name, email, password, role } = req.body;
    if (req.user.role === 'manager' && role !== 'agent') {
        return res.status(403).json({ error: 'Managers can only create Agents' });
    }
    const hash = await bcrypt.hash(password, 10);
    await db.query(
        'INSERT INTO users (name, email, password_hash, role, created_by) VALUES (?, ?, ?, ?, ?)',
        [name, email, hash, role, req.user.id]
    );
    res.json({ message: `${role} created successfully` });
});

app.post('/api/leads/upload', auth(['super_user', 'manager']), upload.single('file'), async (req, res) => {
    const { agent_id } = req.body;
    const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet);

    const values = rows.map(r => [
        r.Name || r.name || 'Unknown',
        String(r.Number || r.number || r.Phone || ''),
        String(r.Salary || r.salary || ''),
        agent_id,
        req.user.id
    ]);

    await db.query(
        'INSERT INTO leads (name, phone, salary, assigned_to, uploaded_by) VALUES ?',
        [values]
    );
    res.json({ message: `${values.length} leads uploaded and assigned.` });
});

app.get('/api/agent/leads', auth(['agent']), async (req, res) => {
    const [leads] = await db.query(
        'SELECT * FROM leads WHERE assigned_to = ? ORDER BY status = "Pending" DESC, id DESC',
        [req.user.id]
    );
    res.json(leads);
});

app.post('/api/agent/call-log', auth(['agent']), async (req, res) => {
    const { lead_id, call_status, final_revert, duration_seconds } = req.body;
    await db.query(
        'INSERT INTO call_logs (lead_id, agent_id, call_status, final_revert, duration_seconds) VALUES (?, ?, ?, ?, ?)',
        [lead_id, req.user.id, call_status, final_revert, duration_seconds || 0]
    );
    await db.query(
        'UPDATE leads SET status = ?, final_revert = ? WHERE id = ?',
        [call_status, final_revert, lead_id]
    );
    res.json({ message: 'Call logged successfully' });
});

app.get('/api/reports/export', auth(['super_user', 'manager']), async (req, res) => {
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
        ORDER BY c.called_at DESC
    `);
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
        GROUP BY u.id, hour_slot
        ORDER BY hour_slot DESC
    `);
    hourlySheet.addRows(hourly);

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=Telecalling_Report.xlsx');
    await workbook.xlsx.write(res);
    res.end();
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`CRM Server running on port ${PORT}`));
