// Local server: serves the app and uses one CSV file per class (in ./data) as the database.
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const MAX_POINTS = 30;
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const PDFJS_DIR = path.join(ROOT, 'node_modules', 'pdfjs-dist', 'build');
const PDFLIB_DIR = path.join(ROOT, 'node_modules', 'pdf-lib', 'dist');
const DATA_DIR = path.join(ROOT, 'data');
const LEGACY_CSV = path.join(ROOT, 'students.csv');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.map': 'application/json',
};

// ---------- CSV helpers ----------

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  text = text.replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(f => f.trim() !== ''));
}

function csvField(v) {
  const s = String(v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function clampPoints(n) {
  n = Math.round(Number(n) || 0);
  return Math.max(0, Math.min(MAX_POINTS, n));
}

// ---------- Classes (one CSV file each) ----------

function validClassName(name) {
  name = String(name || '').trim().replace(/\s+/g, ' ');
  if (!name || name.length > 80) return null;
  if (/[\\/:*?"<>|\x00-\x1f]/.test(name) || name.startsWith('.') || name.endsWith('.')) return null;
  return name;
}

function classFile(name) {
  return path.join(DATA_DIR, name + '.csv');
}

function listClasses() {
  return fs.readdirSync(DATA_DIR)
    .filter(f => f.toLowerCase().endsWith('.csv'))
    .map(f => f.slice(0, -4))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

function findClass(name) {
  return listClasses().find(c => c.toLowerCase() === name.toLowerCase()) || null;
}

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (listClasses().length) return;
  // First run after upgrading: move the old single students.csv into the classes folder.
  if (fs.existsSync(LEGACY_CSV)) fs.renameSync(LEGACY_CSV, classFile('My Class'));
  else saveStudents(classFile('My Class'), []);
}

function loadStudents(file) {
  const rows = parseCsv(fs.readFileSync(file, 'utf8'));
  if (!rows.length) return [];
  const header = rows[0].map(h => h.trim().toLowerCase());
  const hasHeader = header.includes('name');
  const idCol = hasHeader ? header.indexOf('id') : -1;
  const nameCol = hasHeader ? header.indexOf('name') : 0;
  const ptsCol = hasHeader ? header.indexOf('points') : 1;
  const srCol = hasHeader ? header.indexOf('srcode') : -1;
  const data = hasHeader ? rows.slice(1) : rows;

  const students = [];
  const used = new Set();
  let nextId = 1;
  for (const r of data) {
    const name = (r[nameCol] || '').trim();
    if (!name) continue;
    let id = idCol >= 0 ? parseInt(r[idCol], 10) : NaN;
    if (!Number.isInteger(id) || id < 1 || used.has(id)) id = NaN;
    const srcode = srCol >= 0 ? (r[srCol] || '').trim() : '';
    students.push({ id, srcode, name, points: clampPoints(ptsCol >= 0 ? r[ptsCol] : 0) });
    if (!Number.isNaN(id)) used.add(id);
  }
  // Assign ids to rows that were missing one (e.g. names typed straight into Excel).
  for (const s of students) {
    if (Number.isNaN(s.id)) {
      while (used.has(nextId)) nextId++;
      s.id = nextId;
      used.add(nextId);
    }
  }
  return students;
}

function saveStudents(file, students) {
  const lines = ['id,srcode,name,points'];
  for (const s of students) lines.push([s.id, csvField(s.srcode || ''), csvField(s.name), s.points].join(','));
  const tmp = file + '.tmp';
  // BOM so Excel reads names like "AÑONUEVO" as UTF-8.
  fs.writeFileSync(tmp, '﻿' + lines.join('\r\n') + '\r\n', 'utf8');
  fs.renameSync(tmp, file);
}

// ---------- Attendance (one CSV per class: a row per student, a column per date) ----------

const ATT_DIR = path.join(DATA_DIR, 'attendance');
const ATT_STATUSES = ['P', 'L', 'A', 'E']; // Present, Late, Absent, Excused
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function attendanceFile(cls) {
  return path.join(ATT_DIR, cls + '.csv');
}

// Returns { dates: [...sorted], rows: Map(id -> { id, srcode, name, marks: {date: status} }) }
function loadAttendance(cls) {
  const file = attendanceFile(cls);
  const rows = new Map();
  let dates = [];
  if (fs.existsSync(file)) {
    const csv = parseCsv(fs.readFileSync(file, 'utf8'));
    if (csv.length) {
      const header = csv[0].map(h => h.trim());
      const lower = header.map(h => h.toLowerCase());
      const idCol = lower.indexOf('id');
      const srCol = lower.indexOf('srcode');
      const nameCol = lower.indexOf('name');
      const dateCols = header.map((h, i) => (DATE_RE.test(h) ? i : -1)).filter(i => i >= 0);
      dates = dateCols.map(i => header[i]);
      for (const r of csv.slice(1)) {
        const id = parseInt(r[idCol], 10);
        if (!Number.isInteger(id)) continue;
        const marks = {};
        for (const i of dateCols) {
          const v = (r[i] || '').trim().toUpperCase();
          if (ATT_STATUSES.includes(v)) marks[header[i]] = v;
        }
        rows.set(id, { id, srcode: srCol >= 0 ? r[srCol] || '' : '', name: nameCol >= 0 ? r[nameCol] || '' : '', marks });
      }
    }
  }
  return { dates, rows };
}

function saveAttendance(cls, att, students) {
  // Current roster first (fresh names/srcodes), then removed students so their history is kept.
  const out = [];
  for (const s of students) {
    out.push({ id: s.id, srcode: s.srcode || '', name: s.name, marks: att.rows.get(s.id)?.marks || {} });
  }
  for (const r of att.rows.values()) {
    if (!students.some(s => s.id === r.id)) out.push(r);
  }
  // Only dates that still have at least one mark (clearing a mistaken day removes its column).
  const dates = [...new Set(out.flatMap(r => Object.keys(r.marks)))].sort();
  const lines = [['id', 'srcode', 'name', ...dates].join(',')];
  for (const r of out) {
    lines.push([r.id, csvField(r.srcode), csvField(r.name), ...dates.map(d => r.marks[d] || '')].join(','));
  }
  fs.mkdirSync(ATT_DIR, { recursive: true });
  const file = attendanceFile(cls);
  fs.writeFileSync(file + '.tmp', '﻿' + lines.join('\r\n') + '\r\n', 'utf8');
  fs.renameSync(file + '.tmp', file);
}

function attendanceSummary(att, students, date) {
  const day = {};
  const totals = {};
  for (const s of students) {
    const marks = att.rows.get(s.id)?.marks || {};
    if (marks[date]) day[s.id] = marks[date];
    const t = { P: 0, L: 0, A: 0, E: 0 };
    for (const v of Object.values(marks)) t[v]++;
    totals[s.id] = t;
  }
  const dates = [...new Set([...att.rows.values()].flatMap(r => Object.keys(r.marks)))].sort();
  return { date, dates, day, totals };
}

// ---------- HTTP helpers ----------

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
      if (data.length > 1e6) { reject(new Error('Body too large')); req.destroy(); }
    });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function serveFile(res, baseDir, relPath) {
  const filePath = path.normalize(path.join(baseDir, relPath));
  if (!filePath.startsWith(baseDir)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(filePath, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(buf);
  });
}

// ---------- API ----------

async function handleApi(req, res, url) {
  // /api/classes[/:class[/students[/:id[/points]]]]
  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  if (parts[1] !== 'classes') return sendJson(res, 404, { error: 'Not found' });
  const badName = 'Invalid class name (avoid \\ / : * ? " < > |)';

  // Read the body before touching any CSV so each request's load->modify->save runs
  // synchronously and concurrent clicks can't overwrite each other.
  const body = req.method === 'POST' || req.method === 'PATCH' ? await readBody(req) : {};
  ensureDataDir();

  // GET /api/classes
  if (parts.length === 2 && req.method === 'GET') {
    return sendJson(res, 200, { classes: listClasses() });
  }

  // POST /api/classes  { name, copyFrom? }  – copyFrom copies the names with 0 points
  if (parts.length === 2 && req.method === 'POST') {
    const name = validClassName(body.name);
    if (!name) return sendJson(res, 400, { error: badName });
    if (findClass(name)) return sendJson(res, 409, { error: `A class named "${name}" already exists` });
    let students = [];
    if (body.copyFrom) {
      const src = findClass(validClassName(body.copyFrom) || '');
      if (!src) return sendJson(res, 404, { error: 'Class to copy from not found' });
      students = loadStudents(classFile(src)).map(s => ({ ...s, points: 0 }));
    }
    saveStudents(classFile(name), students);
    return sendJson(res, 201, { name, classes: listClasses() });
  }

  const cls = findClass(validClassName(parts[2]) || '');
  if (!cls) return sendJson(res, 404, { error: 'Class not found' });
  const file = classFile(cls);

  // PATCH /api/classes/:class  { name }  – rename
  if (parts.length === 3 && req.method === 'PATCH') {
    const name = validClassName(body.name);
    if (!name) return sendJson(res, 400, { error: badName });
    const clash = findClass(name);
    if (clash && clash !== cls) return sendJson(res, 409, { error: `A class named "${name}" already exists` });
    fs.renameSync(file, classFile(name));
    if (fs.existsSync(attendanceFile(cls))) fs.renameSync(attendanceFile(cls), attendanceFile(name));
    return sendJson(res, 200, { name, classes: listClasses() });
  }

  // GET  /api/classes/:class/attendance?date=YYYY-MM-DD
  // POST /api/classes/:class/attendance  { date, id, status }   status '' clears the mark
  //                                      { date, allUnmarked: 'P' } marks everyone not yet marked
  if (parts[3] === 'attendance' && parts.length === 4) {
    const students = loadStudents(file);
    const date = String((req.method === 'GET' ? url.searchParams.get('date') : body.date) || '');
    if (!DATE_RE.test(date)) return sendJson(res, 400, { error: 'Invalid date' });
    const att = loadAttendance(cls);
    if (req.method === 'POST') {
      const setMark = (id, status) => {
        const row = att.rows.get(id) || { id, srcode: '', name: '', marks: {} };
        if (status) row.marks[date] = status;
        else delete row.marks[date];
        att.rows.set(id, row);
      };
      if (body.allUnmarked !== undefined) {
        if (!ATT_STATUSES.includes(body.allUnmarked)) return sendJson(res, 400, { error: 'Invalid status' });
        for (const s of students) {
          if (!att.rows.get(s.id)?.marks[date]) setMark(s.id, body.allUnmarked);
        }
      } else {
        const id = parseInt(body.id, 10);
        const status = String(body.status || '').toUpperCase();
        if (!students.some(s => s.id === id)) return sendJson(res, 404, { error: 'Student not found' });
        if (status && !ATT_STATUSES.includes(status)) return sendJson(res, 400, { error: 'Invalid status' });
        setMark(id, status);
      }
      saveAttendance(cls, att, students);
    } else if (req.method !== 'GET') {
      return sendJson(res, 405, { error: 'Method not allowed' });
    }
    return sendJson(res, 200, attendanceSummary(att, students, date));
  }

  if (parts[3] !== 'students') return sendJson(res, 404, { error: 'Not found' });
  const students = loadStudents(file);
  const id = parts[4] ? parseInt(parts[4], 10) : null;
  const action = parts[5] || null;

  // GET .../students
  if (req.method === 'GET' && parts.length === 4) {
    return sendJson(res, 200, { maxPoints: MAX_POINTS, students });
  }

  // POST .../students  { name }
  if (req.method === 'POST' && parts.length === 4) {
    const name = String(body.name || '').trim();
    if (!name) return sendJson(res, 400, { error: 'Name is required' });
    const student = { id: students.reduce((m, s) => Math.max(m, s.id), 0) + 1, srcode: String(body.srcode || '').trim(), name, points: 0 };
    students.push(student);
    saveStudents(file, students);
    return sendJson(res, 201, student);
  }

  // POST .../students/reset-all
  if (req.method === 'POST' && parts[4] === 'reset-all') {
    students.forEach(s => { s.points = 0; });
    saveStudents(file, students);
    return sendJson(res, 200, { maxPoints: MAX_POINTS, students });
  }

  const student = students.find(s => s.id === id);
  if (!student) return sendJson(res, 404, { error: 'Student not found' });

  // POST .../students/:id/points  { delta } or { set }
  if (req.method === 'POST' && action === 'points') {
    student.points = clampPoints(body.set !== undefined ? body.set : student.points + Number(body.delta || 0));
    saveStudents(file, students);
    return sendJson(res, 200, student);
  }

  // PATCH .../students/:id  { name }
  if (req.method === 'PATCH' && !action) {
    const name = String(body.name || '').trim();
    if (!name) return sendJson(res, 400, { error: 'Name is required' });
    student.name = name;
    saveStudents(file, students);
    return sendJson(res, 200, student);
  }

  // DELETE .../students/:id
  if (req.method === 'DELETE' && !action) {
    saveStudents(file, students.filter(s => s.id !== id));
    return sendJson(res, 200, { ok: true });
  }

  return sendJson(res, 405, { error: 'Method not allowed' });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (url.pathname.startsWith('/pdfjs/')) return serveFile(res, PDFJS_DIR, url.pathname.slice('/pdfjs/'.length));
    if (url.pathname.startsWith('/pdflib/')) return serveFile(res, PDFLIB_DIR, url.pathname.slice('/pdflib/'.length));
    const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
    return serveFile(res, PUBLIC_DIR, rel);
  } catch (err) {
    console.error(err);
    sendJson(res, 500, { error: err.message });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  ensureDataDir();
  console.log(`Jas in Time running at http://localhost:${PORT}`);
  console.log(`Class files: ${DATA_DIR}`);
});
