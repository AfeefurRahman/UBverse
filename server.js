const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// -----------------------------------
// Render / proxy configuration
// -----------------------------------
app.set('trust proxy', 1);

// -----------------------------------
// CORS
// -----------------------------------
const allowedOrigins = [
  'https://ubverse.us',
  'https://www.ubverse.us',
  'https://afeefurrahman.github.io',
  'http://localhost:3000',
  'http://localhost:5500',
  'http://127.0.0.1:5500'
];

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no Origin header, such as Render health checks
      if (!origin) {
        return callback(null, true);
      }

      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      console.warn(`Blocked CORS request from: ${origin}`);
      return callback(new Error('Not allowed by CORS'));
    },
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type']
  })
);

app.use(express.json({ limit: '20kb' }));

// -----------------------------------
// Gemini configuration
// -----------------------------------
const geminiApiKey = process.env.GEMINI_API_KEY || '';
const geminiModel = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

/*
  @google/genai is an ES module.

  This dynamic import allows your existing CommonJS
  server.js to use it without changing your whole
  project to "type": "module".
*/
const aiPromise = geminiApiKey
  ? import('@google/genai').then(({ GoogleGenAI }) => {
      console.log('✅ Gemini AI configured');
      return new GoogleGenAI({
        apiKey: geminiApiKey
      });
    })
  : Promise.resolve(null);

aiPromise.catch((error) => {
  console.error('❌ Could not initialize Gemini:', error);
});

if (!geminiApiKey) {
  console.warn(
    '⚠️ GEMINI_API_KEY is missing. The server will run, but AI chat will be disabled.'
  );
}

// -----------------------------------
// Basic rate limiting
// -----------------------------------
const requestsByIp = new Map();

function chatLimit(req, res, next) {
  const now = Date.now();
  const windowMs = 10 * 60 * 1000; // 10 minutes
  const maxRequests = 30;

  const ip = req.ip || 'unknown';

  let requests = requestsByIp.get(ip) || [];

  requests = requests.filter(
    (timestamp) => now - timestamp < windowMs
  );

  if (requests.length >= maxRequests) {
    return res.status(429).json({
      error: 'Too many chat requests. Please wait a few minutes and try again.'
    });
  }

  requests.push(now);
  requestsByIp.set(ip, requests);

  next();
}

// Clean old rate-limit records periodically
setInterval(() => {
  const now = Date.now();
  const windowMs = 10 * 60 * 1000;

  for (const [ip, timestamps] of requestsByIp.entries()) {
    const recent = timestamps.filter(
      (timestamp) => now - timestamp < windowMs
    );

    if (recent.length === 0) {
      requestsByIp.delete(ip);
    } else {
      requestsByIp.set(ip, recent);
    }
  }
}, 10 * 60 * 1000).unref();

// -----------------------------------
// Root route
// -----------------------------------
app.get('/', (req, res) => {
  res.status(200).json({
    status: 'ok',
    message: 'UBverse API is running'
  });
});

// -----------------------------------
// Health check
// -----------------------------------
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    service: 'UBverse API',
    aiConfigured: Boolean(geminiApiKey)
  });
});

// -----------------------------------
// Chat API
// -----------------------------------
app.post('/api/chat', chatLimit, async (req, res) => {
  try {
    const ai = await aiPromise;

    if (!ai) {
      return res.status(503).json({
        error:
          'AI chat is not configured yet. Add GEMINI_API_KEY to the server environment.'
      });
    }

    const message =
      typeof req.body.message === 'string'
        ? req.body.message.trim()
        : '';

    if (!message) {
      return res.status(400).json({
        error: 'Please enter a message.'
      });
    }

    if (message.length > 1200) {
      return res.status(400).json({
        error: 'Message is too long. Please keep it under 1200 characters.'
      });
    }

    // -----------------------------------
    // Sanitize conversation history
    // -----------------------------------
    const incomingHistory = Array.isArray(req.body.history)
      ? req.body.history
      : [];

    const history = incomingHistory
      .slice(-12)
      .filter(
        (item) =>
          item &&
          (item.role === 'user' || item.role === 'model') &&
          Array.isArray(item.parts)
      )
      .map((item) => ({
        role: item.role,
        parts: item.parts
          .filter(
            (part) =>
              part &&
              typeof part.text === 'string' &&
              part.text.trim()
          )
          .map((part) => ({
            text: part.text.slice(0, 4000)
          }))
      }))
      .filter((item) => item.parts.length > 0);

    // -----------------------------------
    // Create Gemini chat
    // -----------------------------------
    const chat = ai.chats.create({
      model: geminiModel,

      history,

      config: {
        systemInstruction: `
You are UB GlobalPal, the AI assistant for UBverse.

UBverse is a student-built project for international students
at the University at Buffalo.

Help students with:
- everyday life at UB
- Buffalo basics
- cultural adjustment
- food and dining questions
- general campus questions
- American customs
- meeting people and adjusting to college life

Keep answers friendly, clear, concise, and practical.

Do not claim that you are an official University at Buffalo
representative.

For official UB policies, immigration matters, academic rules,
deadlines, financial matters, or emergencies, remind the student
to verify the information through the appropriate official UB
resource.

Respond in plain text. Avoid Markdown unless the user specifically
asks for formatted output.
        `.trim()
      }
    });

    // -----------------------------------
    // Send message
    // -----------------------------------
    const response = await chat.sendMessage({
      message
    });

    const reply =
      typeof response.text === 'string'
        ? response.text.trim()
        : '';

    if (!reply) {
      return res.status(502).json({
        error: 'The AI returned an empty response. Please try again.'
      });
    }

    return res.status(200).json({
      reply
    });
  } catch (error) {
    console.error('❌ Gemini chat error:', error);

    return res.status(500).json({
      error: 'The AI service could not respond. Please try again shortly.'
    });
  }
});

// -----------------------------------
// API 404
// -----------------------------------
app.use((req, res) => {
  res.status(404).json({
    error: 'Route not found'
  });
});

// -----------------------------------
// Error handler
// -----------------------------------
app.use((error, req, res, next) => {
  console.error('Server error:', error);

  res.status(500).json({
    error: 'Internal server error'
  });
});

// -----------------------------------
// Start server
// -----------------------------------
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ UBverse API running on port ${PORT}`);
  console.log(`🤖 Gemini model: ${geminiModel}`);

  if (geminiApiKey) {
    console.log('✅ GEMINI_API_KEY detected');
  } else {
    console.log('⚠️ GEMINI_API_KEY not detected');
  }
});
