# UBverse

UBverse is a student-built campus companion for international students at the University at Buffalo. It includes five tools:

1. **UB GlobalPal** — AI chat assistant powered by the Gemini API.
2. **Translator** — browser translation using MyMemory.
3. **Cultural Places Map** — Google Maps search by cultural region.
4. **Region Matcher** — shared student listings by country.
5. **Campus Mood Tracker** — one anonymous browser vote per day with aggregate results.

> UBverse is a student project and is not an official University at Buffalo website or service.

## Main fixes in this version

- Uses consistent lowercase filenames so Linux/production hosting does not break `styles.css`, `translator.html`, `region.html`, or `mood.html` links.
- Serves `index.html` at `/` instead of accidentally opening the chat page.
- Static frontend files are isolated in `public/` so backend source/data are not exposed by `express.static()`.
- Replaced the shut-down Gemini preview model with a configurable stable model and migrated the code to the current `@google/genai` SDK.
- The website still loads even when `GEMINI_API_KEY` is missing; only the chat feature is disabled.
- Fixed malformed/missing HTML closing tags and invalid nested link/button markup.
- Added mobile-safe navigation and responsive layouts.
- Removed the dark-map inversion filter that made Google Maps labels/colors unreliable.
- Replaced the watermarked map graphic with an original local SVG icon.
- Prevented chat and Region Matcher XSS by inserting untrusted text with `textContent` instead of `innerHTML`.
- Added input validation, request-size limits, basic API rate limiting, security headers, and safer chat-history handling.
- Region Matcher now uses the server instead of losing all listings whenever a page refreshes.
- Mood Tracker now aggregates server-side submissions instead of calling one browser's `localStorage` the "campus mood".
- Added clear labels and percentages to mood bars.
- Added privacy/disclaimer text where user contact information or third-party services are involved.
- Fixed homepage copy from "Four" tools to five and corrected several accessibility issues.

## Requirements

- Node.js 20+ recommended
- A Gemini API key for the Chat page

## Setup

```bash
npm install
cp .env.example .env
```

Open `.env` and set:

```env
GEMINI_API_KEY=your_real_key_here
GEMINI_MODEL=gemini-3.6-flash
PORT=3000
```

Then start the app:

```bash
npm start
```

Open:

```text
http://localhost:3000
```

For development with automatic server restart:

```bash
npm run dev
```

## Project structure

```text
ubverse-fixed/
├── .env.example
├── .gitignore
├── package.json
├── README.md
├── server.js
├── data/
│   └── .gitkeep
└── public/
    ├── index.html
    ├── chat.html
    ├── translator.html
    ├── map.html
    ├── region.html
    ├── mood.html
    ├── styles.css
    └── images...
```

The server creates `data/ubverse.json` automatically. That file is intentionally ignored by Git because it can contain student listings and mood submission metadata.

## API routes

- `GET /health`
- `POST /api/chat`
- `POST /api/register`
- `GET /api/students?country=Bangladesh`
- `POST /api/mood`
- `GET /api/moods`

## Data/storage note

This version uses a small JSON file because it keeps the project easy to run without setting up a database. It serializes writes and writes atomically, which is fine for a classroom/demo deployment.

For a real multi-server production deployment, move Region Matcher and Mood Tracker data to PostgreSQL or another managed database. An ephemeral hosting filesystem can be erased during redeploys/restarts.

## Privacy/security notes

- Do **not** commit `.env` or API keys.
- Region Matcher requires an explicit consent checkbox before listing a student's name and UBIT email.
- Phone numbers are optional and shown only when the user opts in.
- There is no UB authentication or identity verification in this demo, so do not treat Region Matcher listings as verified identities.
- The translator sends entered text to the MyMemory translation service. Avoid sensitive text.
- The AI chatbot is not an official source for UB policy, immigration, health, safety, legal, or financial decisions.

## Deployment

A Node host should run:

```bash
npm install
npm start
```

Set `GEMINI_API_KEY`, `GEMINI_MODEL`, and `PORT` as environment variables in the host's secret/configuration system.
