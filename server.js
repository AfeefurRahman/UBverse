import express from 'express';
import 'dotenv/config';
import { GoogleGenAI } from '@google/genai';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, 'public');
const dataDir = path.join(__dirname, 'data');
const dataFile = path.join(dataDir, 'ubverse.json');

const app = express();
const port = Number(process.env.PORT) || 3000;
const geminiModel = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
const geminiApiKey = process.env.GEMINI_API_KEY || '';
const ai = geminiApiKey ? new GoogleGenAI({ apiKey: geminiApiKey }) : null;

app.disable('x-powered-by');
app.set('trust proxy', 1);

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com",
      "img-src 'self' data:",
      "frame-src https://www.google.com https://maps.google.com",
      "connect-src 'self' https://api.mymemory.translated.net",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'"
    ].join('; ')
  );
  next();
});

app.use(express.json({ limit: '24kb' }));
app.use(express.static(publicDir, {
  extensions: ['html'],
  maxAge: 0
}));

const apiHits = new Map();
function rateLimit({ windowMs, max }) {
  return (req, res, next) => {
    const key = `${req.ip}:${req.path}`;
    const now = Date.now();
    const recent = (apiHits.get(key) || []).filter((time) => now - time < windowMs);
    if (recent.length >= max) {
      return res.status(429).json({ error: 'Too many requests. Please wait a moment and try again.' });
    }
    recent.push(now);
    apiHits.set(key, recent);
    next();
  };
}

const generalApiLimit = rateLimit({ windowMs: 60_000, max: 80 });
const chatLimit = rateLimit({ windowMs: 60_000, max: 20 });
app.use('/api', generalApiLimit);

const EMPTY_DATA = { students: [], moods: [] };
let dataQueue = Promise.resolve();

async function ensureDataFile() {
  await fs.mkdir(dataDir, { recursive: true });
  try {
    await fs.access(dataFile);
  } catch {
    await fs.writeFile(dataFile, JSON.stringify(EMPTY_DATA, null, 2), 'utf8');
  }
}

async function readData() {
  await ensureDataFile();
  try {
    const raw = await fs.readFile(dataFile, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      students: Array.isArray(parsed.students) ? parsed.students : [],
      moods: Array.isArray(parsed.moods) ? parsed.moods : []
    };
  } catch (error) {
    console.error('Data read error:', error);
    return structuredClone(EMPTY_DATA);
  }
}

async function writeData(data) {
  await fs.mkdir(dataDir, { recursive: true });
  const tempFile = `${dataFile}.tmp`;
  await fs.writeFile(tempFile, JSON.stringify(data, null, 2), 'utf8');
  await fs.rename(tempFile, dataFile);
}

function updateData(mutator) {
  const operation = dataQueue.then(async () => {
    const data = await readData();
    const result = await mutator(data);
    await writeData(data);
    return result;
  });
  dataQueue = operation.catch(() => undefined);
  return operation;
}

function cleanText(value, maxLength) {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/\s+/g, ' ').slice(0, maxLength);
}

function cleanMultiline(value, maxLength) {
  if (typeof value !== 'string') return '';
  return value
    .trim()
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .slice(0, maxLength);
}

function normalizeCountry(value) {
  return cleanText(value, 80).toLocaleLowerCase('en-US');
}

function validUbitEmail(value) {
  return /^[A-Z0-9._%+-]+@buffalo\.edu$/i.test(value);
}

function buffaloDate(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function moodSummary(moods, day = buffaloDate()) {
  const counts = { Amazing: 0, Good: 0, Okay: 0, 'Not Great': 0, Tough: 0 };
  for (const entry of moods) {
    if (entry.day === day && Object.hasOwn(counts, entry.mood)) counts[entry.mood] += 1;
  }
  return {
    day,
    counts,
    total: Object.values(counts).reduce((sum, count) => sum + count, 0)
  };
}

function cleanChatHistory(history) {
  if (!Array.isArray(history)) return [];
  const cleaned = [];
  let expectedRole = 'user';

  for (const item of history.slice(-16)) {
    if (!item || item.role !== expectedRole || !Array.isArray(item.parts)) continue;
    const text = cleanMultiline(item.parts[0]?.text, 2000);
    if (!text) continue;
    cleaned.push({ role: item.role, parts: [{ text }] });
    expectedRole = expectedRole === 'user' ? 'model' : 'user';
  }

  // A previous conversation should end with a model response before a new user turn.
  if (cleaned.at(-1)?.role === 'user') cleaned.pop();
  return cleaned.slice(-12);
}

app.get('/health', (req, res) => {
  res.json({ ok: true, chatConfigured: Boolean(ai) });
});

app.post('/api/chat', chatLimit, async (req, res) => {
  if (!ai) {
    return res.status(503).json({
      error: 'AI chat is not configured yet. Add GEMINI_API_KEY to your .env file and restart the server.'
    });
  }

  const message = cleanMultiline(req.body?.message, 1200);
  if (!message) return res.status(400).json({ error: 'Please enter a message.' });

  try {
    const contents = [
      ...cleanChatHistory(req.body?.history),
      { role: 'user', parts: [{ text: message }] }
    ];

    const response = await ai.models.generateContent({
      model: geminiModel,
      contents,
      config: {
        systemInstruction:
          'You are UB GlobalPal, a friendly campus companion inside the student project UBverse. Help international students with everyday life at the University at Buffalo and in Buffalo, New York. Use plain text, not Markdown. Be concise and practical. Never pretend to be an official UB office or guarantee that a campus policy is current. For policies, immigration, health, safety, legal, or financial matters, clearly suggest verifying with the appropriate official source. If you are uncertain, say so rather than inventing facts.'
      }
    });

    const reply = cleanMultiline(response.text, 6000);
    if (!reply) return res.status(502).json({ error: 'The AI did not return a response. Please try again.' });
    res.json({ reply });
  } catch (error) {
    console.error('Gemini error:', error);
    res.status(502).json({ error: 'The AI service is unavailable right now. Please try again shortly.' });
  }
});

app.post('/api/register', async (req, res) => {
  const name = cleanText(req.body?.name, 80);
  const country = cleanText(req.body?.country, 80);
  const email = cleanText(req.body?.ubit, 120).toLowerCase();
  const phone = cleanText(req.body?.phone, 30);
  const consent = req.body?.consent === true;
  const sharePhone = req.body?.sharePhone === true;

  if (!name || !country || !email) {
    return res.status(400).json({ error: 'Name, country, and UBIT email are required.' });
  }
  if (!validUbitEmail(email)) {
    return res.status(400).json({ error: 'Please use a valid @buffalo.edu email address.' });
  }
  if (!consent) {
    return res.status(400).json({ error: 'You must agree to share your listing before registering.' });
  }

  try {
    const saved = await updateData((data) => {
      const now = new Date().toISOString();
      const existing = data.students.find((student) => student.email === email);
      if (existing) {
        Object.assign(existing, {
          name,
          country,
          countryKey: normalizeCountry(country),
          phone,
          sharePhone: Boolean(phone && sharePhone),
          updatedAt: now
        });
        return { updated: true };
      }
      data.students.push({
        id: crypto.randomUUID(),
        name,
        country,
        countryKey: normalizeCountry(country),
        email,
        phone,
        sharePhone: Boolean(phone && sharePhone),
        createdAt: now,
        updatedAt: now
      });
      return { updated: false };
    });

    res.status(saved.updated ? 200 : 201).json({
      message: saved.updated ? 'Your UBverse listing was updated.' : 'You are registered in the UBverse matcher.'
    });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Could not save your registration right now.' });
  }
});

app.get('/api/students', async (req, res) => {
  const countryKey = normalizeCountry(req.query.country);
  if (!countryKey) return res.status(400).json({ error: 'Enter a country to search.' });

  try {
    const data = await readData();
    const students = data.students
      .filter((student) => student.countryKey === countryKey)
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
      .slice(0, 50)
      .map((student) => ({
        name: student.name,
        country: student.country,
        email: student.email,
        phone: student.sharePhone ? student.phone : ''
      }));

    res.json({ students });
  } catch (error) {
    console.error('Student search error:', error);
    res.status(500).json({ error: 'Could not search students right now.' });
  }
});

app.get('/api/moods', async (req, res) => {
  try {
    const data = await readData();
    res.json(moodSummary(data.moods));
  } catch (error) {
    console.error('Mood read error:', error);
    res.status(500).json({ error: 'Could not load campus mood right now.' });
  }
});

app.post('/api/mood', async (req, res) => {
  const allowedMoods = new Set(['Amazing', 'Good', 'Okay', 'Not Great', 'Tough']);
  const mood = cleanText(req.body?.mood, 20);
  const voterId = cleanText(req.body?.voterId, 100);
  if (!allowedMoods.has(mood)) return res.status(400).json({ error: 'Choose a valid mood.' });
  if (!voterId) return res.status(400).json({ error: 'A browser voting ID is required.' });

  const day = buffaloDate();
  const voterHash = crypto.createHash('sha256').update(voterId).digest('hex');

  try {
    const result = await updateData((data) => {
      // Keep only the latest 45 days of submissions to keep the demo data file small.
      const cutoff = Date.now() - 45 * 24 * 60 * 60 * 1000;
      data.moods = data.moods.filter((entry) => {
        const timestamp = Date.parse(entry.createdAt || '');
        return Number.isFinite(timestamp) && timestamp >= cutoff;
      });

      const duplicate = data.moods.some((entry) => entry.day === day && entry.voterHash === voterHash);
      if (!duplicate) {
        data.moods.push({
          id: crypto.randomUUID(),
          mood,
          day,
          voterHash,
          createdAt: new Date().toISOString()
        });
      }
      return { duplicate, summary: moodSummary(data.moods, day) };
    });

    if (result.duplicate) {
      return res.status(409).json({
        error: 'You already submitted a mood today from this browser.',
        ...result.summary
      });
    }
    res.status(201).json({ message: 'Mood submitted. Thank you!', ...result.summary });
  } catch (error) {
    console.error('Mood submission error:', error);
    res.status(500).json({ error: 'Could not submit your mood right now.' });
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'API route not found.' });
  res.status(404).sendFile(path.join(publicDir, 'index.html'));
});

await ensureDataFile();
app.listen(port, () => {
  console.log(`UBverse running at http://localhost:${port}`);
  if (!ai) console.warn('GEMINI_API_KEY is missing: the site will run, but AI chat will be disabled.');
});
