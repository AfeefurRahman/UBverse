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
      if (!origin) return callback(null, true);

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
    service: 'UBverse API'
  });
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
});
