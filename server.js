const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1);

const allowedOrigins = new Set([
  'https://ubverse.us',
  'https://www.ubverse.us',
  'https://afeefurrahman.github.io',
  'http://localhost:3000',
  'http://localhost:5500',
  'http://127.0.0.1:5500'
]);

app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.has(origin)) {
      return callback(null, true);
    }
    return callback(new Error('Not allowed by CORS'));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type']
}));

app.use(express.json({ limit: '20kb' }));

const DATABASE_URL = process.env.DATABASE_URL || '';

if (!DATABASE_URL) {
  console.warn('⚠️ DATABASE_URL is missing. Region Matcher and shared Mood Tracker will be unavailable.');
}

const pool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: process.env.NODE_ENV === 'production'
        ? { rejectUnauthorized: false }
        : false
    })
  : null;

async function initializeDatabase() {
  if (!pool) return;

  await pool.query(`
    CREATE TABLE IF NOT EXISTS students (
      id BIGSERIAL PRIMARY KEY,
      name VARCHAR(80) NOT NULL,
      country VARCHAR(80) NOT NULL,
      country_key VARCHAR(80) NOT NULL,
      ubit VARCHAR(120) UNIQUE NOT NULL,
      phone VARCHAR(30),
      share_phone BOOLEAN NOT NULL DEFAULT FALSE,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS students_country_key_idx
    ON students(country_key)
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS moods (
      id BIGSERIAL PRIMARY KEY,
      mood VARCHAR(20) NOT NULL,
      submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  console.log('✅ Database tables ready');
}

function normalizeCountry(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function requireDatabase(res) {
  if (pool) return true;

  res.status(503).json({
    error: 'Shared data is not configured yet. Add DATABASE_URL to the Render environment.'
  });

  return false;
}

async function getMoodCounts() {
  const result = await pool.query(`
    SELECT mood, COUNT(*)::int AS count
    FROM moods
    WHERE submitted_at >= CURRENT_DATE
      AND submitted_at < CURRENT_DATE + INTERVAL '1 day'
    GROUP BY mood
  `);

  const counts = {
    Amazing: 0,
    Good: 0,
    Okay: 0,
    'Not Great': 0,
    Tough: 0
  };

  result.rows.forEach((row) => {
    if (Object.prototype.hasOwnProperty.call(counts, row.mood)) {
      counts[row.mood] = Number(row.count) || 0;
    }
  });

  return counts;
}

app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    message: 'UBverse API is running',
    databaseConfigured: Boolean(pool)
  });
});

app.get('/health', async (req, res) => {
  let databaseOk = false;

  if (pool) {
    try {
      await pool.query('SELECT 1');
      databaseOk = true;
    } catch (error) {
      console.error('Database health check failed:', error);
    }
  }

  res.json({
    status: 'ok',
    service: 'UBverse API',
    databaseConfigured: Boolean(pool),
    databaseOk
  });
});

// -------------------------
// REGION MATCHER
// -------------------------
app.post('/api/register', async (req, res) => {
  if (!requireDatabase(res)) return;

  try {
    const name = String(req.body.name || '').trim();
    const country = String(req.body.country || '').trim();
    const ubit = String(req.body.ubit || '').trim().toLowerCase();
    const phone = String(req.body.phone || '').trim();
    const sharePhone = Boolean(req.body.sharePhone);

    if (!name || !country || !ubit) {
      return res.status(400).json({
        error: 'Name, country, and UBIT email are required.'
      });
    }

    if (name.length > 80 || country.length > 80 || ubit.length > 120 || phone.length > 30) {
      return res.status(400).json({
        error: 'One or more fields are too long.'
      });
    }

    if (!ubit.endsWith('@buffalo.edu')) {
      return res.status(400).json({
        error: 'A valid @buffalo.edu email address is required.'
      });
    }

    if (sharePhone && !phone) {
      return res.status(400).json({
        error: 'Enter a phone number or disable phone sharing.'
      });
    }

    const countryKey = normalizeCountry(country);

    await pool.query(`
      INSERT INTO students (
        name,
        country,
        country_key,
        ubit,
        phone,
        share_phone,
        updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, NOW())
      ON CONFLICT (ubit)
      DO UPDATE SET
        name = EXCLUDED.name,
        country = EXCLUDED.country,
        country_key = EXCLUDED.country_key,
        phone = EXCLUDED.phone,
        share_phone = EXCLUDED.share_phone,
        updated_at = NOW()
    `, [
      name,
      country,
      countryKey,
      ubit,
      phone || null,
      sharePhone
    ]);

    res.json({
      success: true,
      message: 'Registration saved successfully.'
    });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({
      error: 'Could not save the registration.'
    });
  }
});

app.get('/api/students', async (req, res) => {
  if (!requireDatabase(res)) return;

  try {
    const country = String(req.query.country || '').trim();

    if (!country) {
      return res.status(400).json({
        error: 'Country is required.'
      });
    }

    const countryKey = normalizeCountry(country);

    const result = await pool.query(`
      SELECT
        name,
        country,
        ubit,
        CASE WHEN share_phone THEN phone ELSE NULL END AS phone,
        share_phone AS "sharePhone"
      FROM students
      WHERE country_key = $1
      ORDER BY updated_at DESC, name ASC
      LIMIT 100
    `, [countryKey]);

    res.json({
      students: result.rows
    });
  } catch (error) {
    console.error('Student search error:', error);
    res.status(500).json({
      error: 'Could not search student listings.'
    });
  }
});

// -------------------------
// SHARED MOOD TRACKER
// -------------------------
app.get('/api/moods', async (req, res) => {
  if (!requireDatabase(res)) return;

  try {
    const counts = await getMoodCounts();
    res.json({ counts });
  } catch (error) {
    console.error('Mood results error:', error);
    res.status(500).json({
      error: 'Could not load mood results.'
    });
  }
});

app.post('/api/mood', async (req, res) => {
  if (!requireDatabase(res)) return;

  try {
    const mood = String(req.body.mood || '').trim();

    const allowedMoods = new Set([
      'Amazing',
      'Good',
      'Okay',
      'Not Great',
      'Tough'
    ]);

    if (!allowedMoods.has(mood)) {
      return res.status(400).json({
        error: 'Invalid mood.'
      });
    }

    await pool.query(
      'INSERT INTO moods (mood) VALUES ($1)',
      [mood]
    );

    const counts = await getMoodCounts();

    res.json({
      success: true,
      counts
    });
  } catch (error) {
    console.error('Mood submission error:', error);
    res.status(500).json({
      error: 'Could not submit mood.'
    });
  }
});

// -------------------------
// OPTIONAL GEMINI CHAT
// -------------------------
const geminiApiKey = process.env.GEMINI_API_KEY || '';
const geminiModel = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

const aiPromise = geminiApiKey
  ? import('@google/genai').then(({ GoogleGenAI }) =>
      new GoogleGenAI({ apiKey: geminiApiKey })
    )
  : Promise.resolve(null);

app.post('/api/chat', async (req, res) => {
  try {
    const ai = await aiPromise;

    if (!ai) {
      return res.status(503).json({
        error: 'AI chat is not configured.'
      });
    }

    const message = String(req.body.message || '').trim();

    if (!message) {
      return res.status(400).json({
        error: 'Please enter a message.'
      });
    }

    const response = await ai.models.generateContent({
      model: geminiModel,
      contents: message
    });

    const reply = String(response.text || '').trim();

    res.json({
      reply: reply || 'Sorry, I could not generate a response.'
    });
  } catch (error) {
    console.error('Chat error:', error);
    res.status(500).json({
      error: 'The AI service could not respond.'
    });
  }
});

app.use((req, res) => {
  res.status(404).json({
    error: 'Route not found'
  });
});

app.use((error, req, res, next) => {
  console.error('Server error:', error);
  res.status(500).json({
    error: 'Internal server error'
  });
});

initializeDatabase()
  .then(() => {
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`✅ UBverse API running on port ${PORT}`);
    });
  })
  .catch((error) => {
    console.error('❌ Database initialization failed:', error);
    process.exit(1);
  });
