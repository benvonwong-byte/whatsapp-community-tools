# WhatsApp Community Tools — Complete Replication Guide

> A comprehensive guide to understanding, setting up, configuring, customizing, and deploying every component of this platform.

---

## Table of Contents

1. [What This Is](#1-what-this-is)
2. [Architecture Overview](#2-architecture-overview)
3. [Prerequisites](#3-prerequisites)
4. [Quick Start (5 Minutes)](#4-quick-start-5-minutes)
5. [Environment Variables — Complete Reference](#5-environment-variables--complete-reference)
6. [WhatsApp Authentication](#6-whatsapp-authentication)
7. [App Modules — Deep Dive](#7-app-modules--deep-dive)
   - [7a. Events App](#7a-events-app)
   - [7b. Friends App](#7b-friends-app)
   - [7c. Metacrisis App](#7c-metacrisis-app)
   - [7d. Relationship App](#7d-relationship-app)
   - [7e. Recording App](#7e-recording-app)
   - [7f. Calls App](#7f-calls-app)
8. [Database Schema](#8-database-schema)
9. [API Reference](#9-api-reference)
10. [Frontend Dashboards](#10-frontend-dashboards)
11. [Authentication & Security](#11-authentication--security)
12. [Scheduling & Background Jobs](#12-scheduling--background-jobs)
13. [Deployment Options](#13-deployment-options)
    - [13a. Local Development](#13a-local-development)
    - [13b. Docker](#13b-docker)
    - [13c. Railway](#13c-railway)
    - [13d. Firebase Hosting (Frontend Only)](#13d-firebase-hosting-frontend-only)
14. [Customization Guide](#14-customization-guide)
15. [Troubleshooting](#15-troubleshooting)
16. [Project File Map](#16-project-file-map)

---

## 1. What This Is

This is a self-hosted platform that connects to your WhatsApp account (via WhatsApp Web) and provides six integrated tools for community management and personal relationship tracking:

| App | What It Does |
|-----|-------------|
| **Events** | Scrapes event announcements from WhatsApp groups using AI, builds a searchable calendar |
| **Friends** | Tracks your personal network — message frequency, initiation balance, neglected contacts |
| **Metacrisis** | Monitors a community group chat — daily digests, link curation, topic trends, weekly summaries |
| **Relationship** | Analyzes a private 1:1 chat using Gottman/Perel communication frameworks, sends daily insights |
| **Recording** | Transcribes in-person conversations with speaker diarization |
| **Calls** | Records and transcribes phone/video calls with speaker identification |

**Key design choices:**
- All data stays local (SQLite database on your machine/server)
- No external database — everything is a single `events.db` file
- AI powered by Google Gemini 2.5 Flash (cheap, fast, great at structured extraction)
- Voice transcription via AssemblyAI
- Frontend is vanilla HTML/JS/CSS — no build step, no React, no bundler
- Backend is TypeScript/Express compiled to plain Node.js

---

## 2. Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                     Your Browser                             │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐       │
│  │  Events   │ │ Friends  │ │Metacrisis│ │Relation- │ ...   │
│  │Dashboard  │ │Dashboard │ │Dashboard │ │  ship    │       │
│  └────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬─────┘       │
│       │             │            │             │             │
└───────┼─────────────┼────────────┼─────────────┼─────────────┘
        │  REST API   │            │             │
        ▼             ▼            ▼             ▼
┌─────────────────────────────────────────────────────────────┐
│                    Express Server (:3000)                     │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │              WhatsApp Web.js Client                    │   │
│  │         (Puppeteer → headless Chromium)                │   │
│  │                                                        │   │
│  │  Connects to WhatsApp Web, receives all messages       │   │
│  │  in real-time, can send messages on your behalf        │   │
│  └─────────────────────┬────────────────────────────────┘   │
│                         │                                    │
│    ┌────────────────────┼────────────────────────┐          │
│    │ Message Router — fans out to all sub-apps:   │          │
│    │                                              │          │
│    │  → Events:      groups with >10 members      │          │
│    │  → Friends:     private chats + small groups  │          │
│    │  → Metacrisis:  specific named group          │          │
│    │  → Relationship: specific named 1:1 chat      │          │
│    └──────────────────────────────────────────────┘          │
│                                                              │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐                  │
│  │ Gemini AI │  │AssemblyAI│  │ Airtable │                  │
│  │ (extract) │  │(transcri)│  │  (sync)  │                  │
│  └──────────┘  └──────────┘  └──────────┘                  │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │              SQLite Database (events.db)               │   │
│  │   events · friends · metacrisis · relationship         │   │
│  └──────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

**Message flow:**
1. WhatsApp Web.js receives every message (yours and others') via Puppeteer
2. Messages are routed to sub-app handlers based on chat name/type
3. Events app buffers messages (max 20 or 5 minutes), then sends batches to Gemini for extraction
4. Each sub-app stores relevant data in its own SQLite tables
5. Frontend dashboards poll the API for display

---

## 3. Prerequisites

### Required

| Dependency | Version | Why |
|-----------|---------|-----|
| **Node.js** | 20+ | Runtime (uses ES2022 features) |
| **npm** | 9+ | Package management |
| **Chromium** or **Chrome** | Any recent | WhatsApp Web.js uses Puppeteer to drive a headless browser |
| **Gemini API Key** | — | Free at [aistudio.google.com/apikey](https://aistudio.google.com/apikey). Powers all AI extraction. |
| **WhatsApp Account** | — | The account you'll link to the server |

### Optional (per feature)

| Dependency | For What |
|-----------|----------|
| **AssemblyAI API Key** | Voice note transcription (Relationship app) + call/recording transcription |
| **Airtable API Key** | Syncing extracted events to an Airtable base |
| **Docker** | Containerized deployment |

### System Requirements

- **RAM:** ~512MB idle, ~1GB under load (Chromium is the main consumer)
- **Disk:** ~200MB for node_modules + Chromium cache. Database grows with usage (~1MB per 1000 events)
- **Network:** Persistent internet connection (WhatsApp Web requires it)
- **OS:** macOS, Linux, or Windows with WSL. Docker works on all.

---

## 4. Quick Start (5 Minutes)

```bash
# 1. Clone the repo
git clone https://github.com/benvonwong-byte/whatsapp-community-tools.git
cd whatsapp-community-tools

# 2. Install dependencies
npm install

# 3. Create your environment file
cp .env.example .env

# 4. Edit .env — at minimum, set these:
#    GEMINI_API_KEY=your-key-here
#    ADMIN_PASSWORD=pick-a-password
#    ADMIN_EMAIL=your@email.com

# 5. Start in development mode
npm run dev
```

**On first launch:**
1. A QR code will appear in the terminal
2. Open WhatsApp on your phone → Settings → Linked Devices → Link a Device
3. Scan the QR code
4. Once connected, the server starts processing messages
5. Open `http://localhost:3000` in your browser
6. Log in with your admin email + password

**That's it.** The Events app starts working immediately — it will backfill recent messages from your WhatsApp groups and extract any events it finds.

---

## 5. Environment Variables — Complete Reference

Create a `.env` file in the project root. Here is every variable the system reads:

### Core (Required)

| Variable | Default | Description |
|----------|---------|-------------|
| `GEMINI_API_KEY` | *(none — required)* | Google Gemini API key. Get free at [aistudio.google.com/apikey](https://aistudio.google.com/apikey) |
| `PORT` | `3000` | HTTP server port |

### Authentication

| Variable | Default | Description |
|----------|---------|-------------|
| `ADMIN_TOKEN` | *(auto-generated)* | Bearer token for API auth. Auto-generated as 32-byte hex if empty. Set explicitly for stable deployments. |
| `ADMIN_EMAIL` | `admin@example.com` | Email for the login form |
| `ADMIN_PASSWORD` | `change-me` | Password for the login form. **Change this.** |
| `GUEST_USERNAME` | `Guest` | Username for guest/read-only access |
| `GUEST_PASSWORD` | *(empty = disabled)* | Guest password. Leave empty to disable guest login. |
| `GUEST_TOKEN` | *(auto-generated)* | Guest bearer token |

### WhatsApp Config

| Variable | Default | Description |
|----------|---------|-------------|
| `ALLOWED_PRIVATE_CHATS` | *(empty)* | Comma-separated list of private chat names to monitor for events. Example: `jane doe,john smith` |

### Relationship App

| Variable | Default | Description |
|----------|---------|-------------|
| `RELATIONSHIP_CHAT_NAME` | *(empty)* | WhatsApp contact name to monitor (must match exactly as shown in WhatsApp) |
| `RELATIONSHIP_PARTNER_NAME` | `Partner` | How the other person is labeled in the dashboard |
| `RELATIONSHIP_SELF_NAME` | `Me` | How you are labeled in the dashboard |
| `ASSEMBLYAI_API_KEY` | *(empty)* | Required for voice note transcription. Get at [assemblyai.com](https://www.assemblyai.com) |
| `GROQ_API_KEY` | *(empty)* | Currently unused (legacy). Can be left empty. |

### Metacrisis App

| Variable | Default | Description |
|----------|---------|-------------|
| `METACRISIS_CHAT_NAME` | *(empty)* | WhatsApp group name to monitor |
| `METACRISIS_ANNOUNCEMENT_CHAT` | *(empty)* | Where to push daily/weekly digests |
| `METACRISIS_ADJACENT_EVENTS_CHAT` | *(empty)* | Where to push event recommendations |
| `SENDER_NAME_OVERRIDES` | `{}` | JSON string mapping WhatsApp IDs to display names. Example: `{"12345@lid":"Jane Doe"}` |

### Airtable Sync (Optional)

| Variable | Default | Description |
|----------|---------|-------------|
| `AIRTABLE_API_KEY` | *(empty)* | Airtable personal access token |
| `AIRTABLE_BASE_ID` | *(empty)* | Airtable base ID (starts with `app`) |
| `AIRTABLE_TABLE_ID` | *(empty)* | Airtable table ID (starts with `tbl`) |

### Scheduling

| Variable | Default | Description |
|----------|---------|-------------|
| `ANALYSIS_HOUR` | `0` | Hour (0-23) when daily relationship analysis runs. In server's timezone (locked to `America/New_York`). |

### Storage

| Variable | Default | Description |
|----------|---------|-------------|
| `DB_PATH` | `./events.db` | SQLite database file path |
| `AUTH_DIR` | `./.auth` | WhatsApp session storage directory |

### iMessage Bridge (Advanced)

| Variable | Default | Description |
|----------|---------|-------------|
| `IMESSAGE_SYNC_KEY` | *(empty)* | Shared secret for the iMessage bridge service |

---

## 6. WhatsApp Authentication

The system uses [whatsapp-web.js](https://github.com/pedroslopez/whatsapp-web.js) which automates WhatsApp Web via Puppeteer. Here's how authentication works:

### First-Time Setup

1. Start the server (`npm run dev` or `npm start`)
2. Watch the terminal — a QR code will be printed
3. On your phone: WhatsApp → Settings → Linked Devices → Link a Device
4. Scan the QR code from the terminal
5. Wait for "Client is ready!" message

### Session Persistence

- Sessions are saved to `AUTH_DIR` (default: `.auth/`)
- On restart, the session is restored automatically (no re-scan needed)
- If the session expires or gets invalidated (e.g., you log out on your phone), you'll need to re-scan

### QR Code via Web Interface

If you can't see the terminal (e.g., running on a remote server):
1. Log in to the web dashboard as admin
2. Navigate to the Events dashboard
3. Click the QR code button in the admin panel
4. The QR code will display in the browser

### Troubleshooting Auth

| Problem | Solution |
|---------|----------|
| QR code doesn't appear | Chromium may not be installed. Check `PUPPETEER_EXECUTABLE_PATH` or install Chrome/Chromium. |
| Session expired | Delete `.auth/` directory and restart to get a fresh QR code |
| "UNPAIRED" error | Your WhatsApp phone logged out the linked device. Re-scan. |
| Repeated disconnects | Check internet stability. The system auto-reconnects with exponential backoff (5s → 2min, 10 attempts). |

### Important Notes

- **One account per instance.** WhatsApp only allows one Web session per linked device. If you open WhatsApp Web in a browser, the server's session will disconnect.
- **Phone must stay online.** WhatsApp Web requires the phone to have an internet connection (this is a WhatsApp limitation, not ours).
- **Message access:** The system can see all messages in all your chats. It filters to only process the chats you configure.

---

## 7. App Modules — Deep Dive

### 7a. Events App

**Purpose:** Automatically extract structured event data from WhatsApp group messages using AI.

**How it works:**
1. Monitors all WhatsApp groups with >10 participants (configurable, also watches `ALLOWED_PRIVATE_CHATS`)
2. Buffers incoming messages (max 20 messages or 5 minutes, whichever comes first)
3. Sends batches to Gemini 2.5 Flash with a structured prompt
4. Gemini extracts: event name, date, start/end times, location, description, URL, category
5. Events are deduplicated by hashing `name + date + location`
6. Stored in SQLite, optionally synced to Airtable

**Event Categories:**

| ID | Name | Description |
|----|------|-------------|
| `somatic` | Somatic & Embodiment | Tantra, breathwork, somatic experiencing |
| `dance_movement` | Dance & Movement | Ecstatic dance, contact improv, 5Rhythms |
| `systems_metacrisis` | Systems & Metacrisis | Metacrisis, systems thinking, complexity |
| `environment` | Environment & Sustainability | Climate action, regenerative practices |
| `social_impact` | Social Impact & Community | Civic engagement, mutual aid, activism |
| `learning` | Learning & Knowledge | Lectures, salons, book clubs, panels |
| `skills` | Skills & Workshops | Hands-on workshops, masterclasses |
| `multiday` | Multi-day Immersive | Retreats, intensives, residencies |
| `conference` | Conferences & Summits | Large-scale gatherings, forums |
| `online` | Online & Zoom | Virtual events, webinars, livestreams |

**Customizing categories:** Edit `src/categories.ts`. Each category has an `id`, `name`, `description`, and `keywords` array that the AI uses for classification.

**Event Link Enrichment:**
When a message contains URLs from known event platforms (Eventbrite, Luma, Partiful), the system fetches the full page content and includes it in the AI prompt for more accurate extraction.

**Smart Backfill:**
On startup (and reconnection), the system automatically backfills messages since the last extracted event. It calculates the gap and fetches the appropriate history (capped at 30 days).

**Verification:**
After extraction, events can be verified by re-fetching URLs and cross-checking dates. Triggered manually via the dashboard.

**Airtable Sync:**
If configured, events are automatically synced to an Airtable base on creation and deletion. The Airtable schema should have columns matching the event fields: `Name`, `Date`, `Start Time`, `End Time`, `Location`, `Description`, `URL`, `Category`, `Source`.

---

### 7b. Friends App

**Purpose:** Track your personal network — who you talk to, how often, who's initiating, and who you're neglecting.

**What it monitors:**
- All private 1:1 chats (except the relationship chat)
- Small groups (2-6 participants)
- Excludes: broadcasts, announcement groups, groups >6 people

**Features:**

| Feature | Description |
|---------|-------------|
| **Contact Activity** | Messages per day, week, month. Last seen timestamps. |
| **Initiation Balance** | Who starts conversations more — you or them? (50/50 is ideal) |
| **Response Time** | How quickly each person typically replies |
| **Quality Score** | 0-100 composite score based on frequency, consistency, and initiation balance |
| **Neglected Contacts** | People you haven't talked to in configurable time windows |
| **AI Tagging** | Gemini auto-generates tags from conversation content (topics, interests, locations) |
| **Tiers** | Organize contacts into priority tiers (e.g., Close Friends, Acquaintances) |
| **Bulk Messaging** | Send WhatsApp messages to multiple contacts with media attachments |
| **Bot Detection** | Identifies and hides automated/bot contacts |

**Tag Extraction:**
Every 60 minutes, the system runs tag extraction on recent messages. Gemini analyzes conversation snippets and suggests tags like topics discussed, shared interests, geographic locations, and emotional tone.

**Database tables:**
- `friends_chats` — Chat metadata
- `friends_contacts` — Contact info + quality scores
- `friends_messages` — All messages with character counts
- `friends_voice_notes` — Voice note transcriptions
- `friends_tags` — AI-generated tag taxonomy
- `friends_contact_tags` — Tag-to-contact assignments with confidence scores
- `friends_tiers` — Customizable tier system
- `friends_groups` — Contact grouping

---

### 7c. Metacrisis App

**Purpose:** Monitor a community group chat — curate shared links, generate daily/weekly digests, track discussion topics.

**What it monitors:**
- A single named WhatsApp group (`METACRISIS_CHAT_NAME`)

**Features:**

| Feature | Description |
|---------|-------------|
| **Message Capture** | Stores all messages with sender identification |
| **Link Extraction** | Automatically extracts and categorizes URLs shared in chat |
| **Link Scraping** | Fetches metadata (title, description, category) for each shared URL using Gemini |
| **Daily Digest** | AI-generated summary of the day's conversation: who said what, general reaction, recommendations |
| **Weekly Summary** | Comprehensive weekly wrap-up with notable quotes and topic analysis |
| **Topic Trending** | Tracks topic mentions and sentiment over time (weekly/monthly/quarterly views) |
| **Leaderboard** | Top message contributors |
| **Quick Link Sharer** | Paste any URL → AI scrapes metadata → builds WhatsApp-formatted message → push to group |
| **Weekly Composer** | Assemble a curated weekly update from selected links and summaries |

**Push Targets:**
The app can push formatted messages to three destinations:
1. **Community Chat** — the monitored group itself
2. **Announcement Chat** — a separate broadcast/announcement channel
3. **Adjacent Events Chat** — a group focused on related events

**Daily Schedule:**
- **9:00 AM** — Daily digest generated and optionally pushed
- **Sunday midnight** — Weekly summary generated

**Quick Link Sharer Flow:**
1. Paste a URL in the dashboard
2. Backend fetches the page, extracts metadata (og:tags, JSON-LD, embedded data)
3. Gemini classifies it (article/video/event/podcast) and extracts event details if applicable
4. Editable fields: title, date, time, location, description
5. Preview shows WhatsApp-formatted message with bold title, emojis, and link
6. One-click push to community or adjacent events group

---

### 7d. Relationship App

**Purpose:** Analyze communication patterns in a 1:1 relationship using evidence-based frameworks from couples therapy research.

**What it monitors:**
- A single private WhatsApp chat (`RELATIONSHIP_CHAT_NAME`)
- Text messages and voice notes (transcribed via AssemblyAI)
- In-person conversations (via the Recording app)

**Analysis Frameworks:**

| Framework | What It Measures |
|-----------|-----------------|
| **Gottman Four Horsemen** | Criticism, Contempt, Stonewalling, Defensiveness (lower = better) |
| **Gottman Positives** | Fondness & Admiration, Turning Toward bids, Repair Attempts (higher = better) |
| **Esther Perel Dimensions** | Curiosity, Playfulness, Autonomy vs. Togetherness |
| **Emotional Bank Account** | Ratio of emotional deposits to withdrawals |
| **Bids for Connection** | How often each person turns toward/away/against the other's bids |
| **Pursue-Withdraw** | Dynamic pattern identification in conflict |

**Daily Analysis:**
At `ANALYSIS_HOUR` (default: midnight), Gemini analyzes all messages from the past 24 hours and generates:
- Overall health score (0-100)
- Scores for each framework dimension
- Notable quotes from each person
- Multi-window recommendations (next 24h, 48h, 7 days)
- Emotion detection for each person

**Daily Updates:**
At a configurable hour (default: 5 PM EST), a formatted summary is sent directly to the WhatsApp chat. Update frequency is configurable: daily, every other day, twice weekly, weekly, or biweekly.

**Voice Note Transcription:**
When a voice note is received, the system:
1. Downloads the audio from WhatsApp
2. Sends it to AssemblyAI's `universal-3-pro` model
3. Stores the transcript alongside the message
4. Includes it in the next analysis

**Import Options:**
- **WhatsApp Export:** Upload a WhatsApp chat export (.txt) — the parser handles the format automatically
- **iMessage Bridge:** Sync messages from macOS Messages app (requires separate bridge script)
- **In-Person Recording:** Record and transcribe face-to-face conversations with speaker labels

---

### 7e. Recording App

**Purpose:** Record and transcribe in-person conversations with speaker identification.

**How it works:**
1. Open `/recording.html` in your browser
2. Grant microphone access
3. Click Record — the browser captures audio via Web Audio API
4. When done, click Stop
5. Audio is uploaded to the server, sent to AssemblyAI for transcription
6. Speaker diarization identifies different speakers
7. You assign speaker roles (Self/Partner) to each detected speaker
8. Transcript is saved to the Relationship store for inclusion in daily analysis

**Technical details:**
- Supports formats: WebM, MP4, MPEG, OGG, WAV, M4A, AAC
- Max file size: 50MB
- Uses AssemblyAI `universal-3-pro` model
- Speaker diarization included automatically
- Pitch-based speaker identification assists in labeling

---

### 7f. Calls App

**Purpose:** Record and transcribe phone calls, Zoom meetings, FaceTime, and other calls.

**How it works:**
1. Open `/calls.html`
2. Select audio source (microphone only, or system audio + microphone)
3. Optionally select a contact from your Friends list
4. Start recording
5. When done, audio is transcribed with multi-speaker diarization
6. Name each detected speaker
7. Call metadata stored: title, type, duration, contact, transcript

**Supported call types:** Phone, Zoom, Google Meet, FaceTime, Discord, and custom.

**Call history features:**
- Paginated list of all recorded calls
- Search across transcripts
- Edit speaker names, titles, and contact associations post-recording
- Full transcript viewer with speaker labels and timestamps

---

## 8. Database Schema

The app uses a single SQLite file (`events.db` by default) with tables for each module.

### Events Tables

```sql
-- Extracted events
CREATE TABLE events (
  hash TEXT PRIMARY KEY,               -- SHA256(name|date|location)
  name TEXT NOT NULL,
  date TEXT NOT NULL,                   -- YYYY-MM-DD
  start_time TEXT,                      -- HH:MM
  end_time TEXT,                        -- HH:MM
  end_date TEXT,                        -- YYYY-MM-DD (multi-day events)
  location TEXT,
  description TEXT DEFAULT '',
  url TEXT,
  category TEXT NOT NULL,
  source_chat TEXT,                     -- WhatsApp group name
  source_message_id TEXT,
  source_text TEXT DEFAULT '',          -- Original message text
  favorited INTEGER DEFAULT 0,
  airtable_record_id TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Prevent re-processing
CREATE TABLE processed_messages (
  message_id TEXT PRIMARY KEY,
  chat_name TEXT NOT NULL,
  body TEXT DEFAULT '',
  timestamp INTEGER NOT NULL,
  processed_at TEXT DEFAULT (datetime('now'))
);

-- Blocked groups (won't extract events from these)
CREATE TABLE blocked_groups (
  chat_name TEXT PRIMARY KEY,
  blocked_at TEXT DEFAULT (datetime('now'))
);
```

### Friends Tables

```sql
CREATE TABLE friends_chats (
  chat_id TEXT PRIMARY KEY,
  chat_name TEXT,
  is_group INTEGER DEFAULT 0,
  participant_count INTEGER DEFAULT 0,
  monitored INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE friends_contacts (
  id TEXT PRIMARY KEY,
  name TEXT,
  first_seen TEXT,
  last_seen TEXT,
  notes TEXT DEFAULT '',
  tier_id INTEGER,
  hidden INTEGER DEFAULT 0,
  is_bot INTEGER DEFAULT 0
);

CREATE TABLE friends_messages (
  id TEXT PRIMARY KEY,
  chat_id TEXT,
  sender_id TEXT,
  sender_name TEXT,
  timestamp INTEGER,
  is_from_me INTEGER DEFAULT 0,
  message_type TEXT DEFAULT 'text',
  char_count INTEGER DEFAULT 0,
  body TEXT DEFAULT ''
);

CREATE TABLE friends_voice_notes (
  id TEXT PRIMARY KEY,
  contact_id TEXT,
  chat_id TEXT,
  transcript TEXT,
  duration_estimate INTEGER,
  timestamp INTEGER,
  is_from_me INTEGER DEFAULT 0
);

CREATE TABLE friends_tags (id INTEGER PRIMARY KEY, name TEXT UNIQUE, created_at TEXT);
CREATE TABLE friends_contact_tags (contact_id TEXT, tag_id INTEGER, confidence REAL, last_seen TEXT, mention_count INTEGER);
CREATE TABLE friends_tiers (id INTEGER PRIMARY KEY, name TEXT, color TEXT, sort_order INTEGER, is_default INTEGER DEFAULT 0);
CREATE TABLE friends_groups (id INTEGER PRIMARY KEY, name TEXT, color TEXT, sort_order INTEGER);

CREATE TABLE call_recordings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id TEXT,
  title TEXT,
  call_type TEXT DEFAULT 'phone',
  duration_seconds INTEGER,
  transcript_text TEXT,
  utterances_json TEXT,
  speaker_map_json TEXT,
  assemblyai_id TEXT,
  audio_captured INTEGER DEFAULT 0,
  status TEXT DEFAULT 'completed',
  error_message TEXT,
  recorded_at TEXT DEFAULT (datetime('now'))
);
```

### Metacrisis Tables

```sql
CREATE TABLE metacrisis_messages (
  id TEXT PRIMARY KEY,
  sender TEXT,
  sender_name TEXT,
  body TEXT,
  timestamp INTEGER,
  processed INTEGER DEFAULT 0
);

CREATE TABLE metacrisis_links (
  url TEXT PRIMARY KEY,
  title TEXT,
  category TEXT,
  sender_name TEXT,
  message_id TEXT,
  timestamp INTEGER,
  description TEXT,
  event_date TEXT,
  event_location TEXT
);

CREATE TABLE metacrisis_summaries (
  date TEXT,
  type TEXT,                            -- 'daily' or 'weekly'
  summary TEXT,
  key_topics_json TEXT,
  recommendations_json TEXT,
  who_said_what_json TEXT,
  message_count INTEGER,
  pushed INTEGER DEFAULT 0,
  PRIMARY KEY (date, type)
);

CREATE TABLE metacrisis_events (
  url TEXT PRIMARY KEY,
  name TEXT, date TEXT, start_time TEXT, end_time TEXT,
  location TEXT, description TEXT,
  source_message_id TEXT,
  status TEXT DEFAULT 'pending'
);

CREATE TABLE metacrisis_topics (topic TEXT, date TEXT, mention_count INTEGER, sentiment TEXT);
CREATE TABLE metacrisis_settings (key TEXT PRIMARY KEY, value TEXT);
```

### Relationship Tables

```sql
CREATE TABLE relationship_messages (
  id TEXT PRIMARY KEY,
  speaker TEXT NOT NULL,                -- 'self' or 'partner'
  body TEXT DEFAULT '',
  transcript TEXT DEFAULT '',           -- For voice notes
  timestamp INTEGER NOT NULL,
  type TEXT DEFAULT 'text',             -- 'text', 'voice', 'media'
  source TEXT DEFAULT 'whatsapp',       -- 'whatsapp', 'in-person', 'import'
  analyzed INTEGER DEFAULT 0
);

CREATE TABLE relationship_analyses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  metrics_json TEXT,                    -- Full analysis JSON blob
  summary TEXT,
  message_count INTEGER DEFAULT 0,
  voice_minutes REAL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);
```

### Backup

The database is a single file. To back up:
```bash
cp events.db events-backup-$(date +%Y%m%d).db
```

Or use the admin API:
```bash
curl -H "Authorization: Bearer YOUR_TOKEN" http://localhost:3000/api/export > backup.json
```

---

## 9. API Reference

All endpoints are prefixed with the server URL (default: `http://localhost:3000`).

### Authentication

Most endpoints require a Bearer token. Include it as:
- Header: `Authorization: Bearer YOUR_ADMIN_TOKEN`
- Query param: `?token=YOUR_ADMIN_TOKEN`

To get a token programmatically:
```bash
curl -X POST http://localhost:3000/api/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@example.com","password":"your-password"}'
# Returns: { "token": "your-admin-token", "role": "admin" }
```

### Public Endpoints (No Auth)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/status` | Server time + WhatsApp connection status |
| `GET` | `/api/events` | All extracted events |
| `GET` | `/api/events/category/:cat` | Events filtered by category |
| `GET` | `/api/events/favorites` | Favorited events only |
| `GET` | `/api/events/recent?limit=N` | Latest N events (max 50) |
| `GET` | `/api/events/group/:chatName` | Events from a specific WhatsApp group |
| `GET` | `/api/backfill-status` | Backfill progress (percentage) |
| `GET` | `/api/stats` | Dashboard statistics |
| `GET` | `/api/categories` | Event category list |

### Admin Endpoints (Require Auth)

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/login` | Email/password → token (rate limited: 10/15min) |
| `GET` | `/api/qr` | WhatsApp QR code for linking |
| `GET` | `/api/logs` | Last 200 server log entries |
| `POST` | `/api/backfill?hours=N&force=true` | Trigger message backfill |
| `POST` | `/api/verify-all` | Verify all event dates via AI |
| `POST` | `/api/dedup` | AI-powered duplicate detection |
| `POST` | `/api/search` | Semantic search across events |
| `DELETE` | `/api/events/:hash` | Delete an event |
| `POST` | `/api/events/:hash/favorite` | Toggle favorite |
| `GET/POST` | `/api/groups/blocked` | List/block/unblock groups |
| `POST` | `/api/airtable-sync` | Sync events to Airtable |
| `GET` | `/api/export` | Export all data as JSON |
| `POST` | `/api/import` | Import data from backup |
| `GET` | `/api/disk-usage` | Storage breakdown |
| `POST` | `/api/cleanup?dry=true` | Database VACUUM + cache cleanup |

### Friends Endpoints (`/api/friends/`)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/dashboard` | Full dashboard data (cached) |
| `GET` | `/contacts` | List contacts (with tier/tag/search filters) |
| `GET` | `/contacts/:id` | Contact details |
| `GET` | `/contacts/:id/activity` | Activity timeline |
| `GET` | `/contacts/:id/messages` | Message history |
| `GET` | `/neglected` | Contacts you haven't talked to recently |
| `GET` | `/top-friends` | Most active contacts |
| `GET` | `/tags` | All tags |
| `POST` | `/tags/extract` | Run AI tag extraction |
| `GET` | `/tiers` | Tier list |
| `POST` | `/contacts/:id/tier` | Assign tier |
| `POST` | `/send` | Send WhatsApp message |
| `POST` | `/backfill` | Backfill message history |

### Metacrisis Endpoints (`/api/metacrisis/`)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/stats` | Message/link/summary counts |
| `GET` | `/summaries?days=N&type=daily\|weekly` | Get summaries |
| `GET` | `/links?category=X&limit=N` | Get curated links |
| `GET` | `/topics?period=week\|month\|quarter` | Topic trends |
| `GET` | `/leaderboard?limit=N` | Top contributors |
| `GET` | `/events` | Upcoming events from links |
| `POST` | `/daily-digest` | Generate today's digest |
| `POST` | `/summarize` | Generate weekly summary |
| `POST` | `/scrape-url` | Scrape a URL for quick sharing |
| `POST` | `/push-to-chat` | Push message to community chat |
| `POST` | `/push-to-adjacent` | Push to adjacent events chat |
| `POST` | `/push-weekly` | Push composed weekly update |
| `POST` | `/backfill` | Backfill 2 weeks of messages |

### Relationship Endpoints (`/api/relationship/`)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/dashboard?days=N` | Full dashboard with analysis history |
| `POST` | `/analyze` | Trigger manual analysis |
| `GET` | `/analyze-status` | Analysis progress |
| `POST` | `/backfill` | Backfill older messages |
| `GET` | `/messages?date=YYYY-MM-DD` | Messages for a specific day |
| `DELETE` | `/messages/:id` | Delete a message |
| `POST` | `/import` | Import WhatsApp export file |
| `POST` | `/send-update` | Send update to chat now |
| `GET` | `/settings` | Current settings |
| `POST` | `/settings` | Update settings |
| `POST` | `/chat` | AI chat about the relationship |

### Recording Endpoints (`/api/recording/`)

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/transcribe` | Upload audio → get transcript with speaker labels |
| `POST` | `/save-transcript` | Save labeled transcript to relationship store |

### Calls Endpoints (`/api/calls/`)

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/transcribe` | Upload call audio → transcribe |
| `POST` | `/save` | Save call recording with metadata |
| `GET` | `/` | List recordings (paginated) |
| `GET` | `/:id` | Get single call with full transcript |
| `PUT` | `/:id/title` | Update title |
| `PUT` | `/:id/speakers` | Update speaker map |
| `PUT` | `/:id/contact` | Change associated contact |
| `DELETE` | `/:id` | Delete call |

---

## 10. Frontend Dashboards

All dashboards are served as static HTML/JS from the `public/` directory. No build step required.

### Hub (`/hub.html`)
Central navigation page with cards linking to all six dashboards.

### Events Dashboard (`/index.html` or `/`)
- **Calendar view** with category color-coding
- **List view** with sorting and search
- **Category filter** tabs
- **Favorites** management
- **Admin panel**: backfill trigger, QR code display, verify/dedup operations, group blocking, server logs
- **Keyboard shortcuts**: `1-4` for tab switching, `j/k` navigation, `f` to favorite, `/` to search

### Friends Dashboard (`/friends.html`)
- **Contact list** with search, tier filters, and quality scores
- **Activity charts** showing message frequency over time
- **Neglected contacts** view with configurable time windows
- **Tag browser** with AI-generated taxonomy
- **Contact details** modal with message history, notes, and activity timeline
- **Bulk messaging** with media attachment support
- **Network graph** visualization

### Metacrisis Dashboard (`/metacrisis.html`)
- **Quick Link Sharer** at the top (paste URL → AI scrape → format → push)
- **Daily/weekly digest** viewer with push-to-chat buttons
- **Link library** with category filtering
- **Topic trending** charts (weekly/monthly/quarterly)
- **Leaderboard** of top contributors
- **Weekly composer** for assembling curated updates
- **Settings** panel for push schedules

### Relationship Dashboard (`/relationship.html`)
- **Health score** trend chart with configurable date ranges (7/30/90 days, all-time)
- **Framework breakdowns**: Four Horsemen, Positives, Perel dimensions
- **Bids for connection** tracking
- **Emotional bank account** visualization
- **Message browser** by date
- **Notable quotes** from each person
- **Recommendations** (24h, 48h, 7d action items)
- **Settings**: update frequency, partner names
- **Import tools**: WhatsApp export, backfill, manual entry

### Recording Page (`/recording.html`)
- **Waveform visualizer** during recording
- **Timer display** with real-time duration
- **Speaker assignment** modal after transcription
- **Transcript viewer** with speaker labels

### Calls Page (`/calls.html`)
- **Audio source selector** (mic only vs. system + mic)
- **Contact picker** from Friends list
- **Call type selector** (phone, Zoom, Meet, etc.)
- **Recording controls** with level meter
- **Call history** with pagination and search
- **Full transcript viewer** per call

### Design System

The UI uses a consistent dark theme defined in `public/style.css`:

| Variable | Value | Usage |
|----------|-------|-------|
| `--bg` | `#0f0f0f` | Page background |
| `--surface` | `#1a1a1a` | Card/section background |
| `--surface2` | `#242424` | Input/nested surface |
| `--border` | `#2a2a2a` | Borders |
| `--text` | `#e8e8e8` | Primary text |
| `--text-dim` | `#888` | Secondary text |
| `--accent` | `#f39c12` | Primary accent (amber) |
| `--green` | `#00b894` | Success/positive |
| `--red` | `#e74c3c` | Error/negative |

---

## 11. Authentication & Security

### Token-Based Auth

The system uses bearer tokens for API authentication:

```
Authorization: Bearer YOUR_ADMIN_TOKEN
```

**How tokens are generated:**
- If `ADMIN_TOKEN` is set in `.env`, that value is used
- If empty, a random 32-byte hex string is generated on startup and printed to logs
- For stable deployments (Docker, Railway), set `ADMIN_TOKEN` explicitly so it survives restarts

**Timing-safe comparison:** All token checks use SHA-256 hash comparison to prevent timing attacks.

### Two-Level Access

| Role | Access |
|------|--------|
| **Admin** | Full read/write access to all endpoints |
| **Guest** | Read-only access to events + some dashboard data |

### Security Headers

The Express server sets these headers on all responses:
- `Content-Security-Policy` — Restricts script/style sources
- `X-Frame-Options: DENY` — Prevents clickjacking
- `X-Content-Type-Options: nosniff`
- `Strict-Transport-Security` — Forces HTTPS (when behind a proxy)

### Rate Limiting

| Endpoint | Limit |
|----------|-------|
| `POST /api/login` | 10 attempts per 15 minutes |
| `POST /api/metacrisis/scrape-url` | 10 per 60 seconds |
| `POST /api/metacrisis/push-*` | 5 per 60 seconds |

### SSRF Protection

URL scraping endpoints validate that target URLs:
- Use only `http:` or `https:` protocols
- Don't resolve to private/reserved IP ranges (127.x, 10.x, 172.16-31.x, 192.168.x, 169.254.x, ::1, fe80:)
- Are less than 2048 characters

### Best Practices

1. **Always change `ADMIN_PASSWORD`** from the default
2. **Set `ADMIN_TOKEN` explicitly** in production for stability
3. **Keep `.env` out of git** (it's gitignored by default)
4. **Rotate API keys** if you ever expose them accidentally
5. **Use HTTPS** in production (via reverse proxy like Nginx/Caddy)

---

## 12. Scheduling & Background Jobs

All times are in **Eastern Time** (`America/New_York`) — the server's timezone is locked at startup.

### Scheduled Tasks

| Task | Schedule | Description |
|------|----------|-------------|
| Daily relationship analysis | `ANALYSIS_HOUR` (default: midnight) | Analyze past 24h of messages with Gottman/Perel frameworks |
| Relationship update send | Configurable (default: 5 PM) | Send formatted summary to WhatsApp chat |
| Auto-analysis | Every 30 minutes | Re-analyze if new messages arrived since last analysis |
| Metacrisis daily digest | 9:00 AM | Generate AI summary of yesterday's conversation |
| Metacrisis weekly summary | Sunday midnight | Weekly wrap-up with notable quotes |
| Friends tag extraction | Every 60 minutes | AI-powered tag suggestions from recent messages |
| Cache cleanup | Sunday 3:00 AM | Clear Chromium browser cache directories |
| Watchdog | Every 2 hours | Re-schedules daily tasks if they haven't fired |

### Watchdog System

A reliability mechanism that monitors scheduled tasks:
- Checks every 2 hours whether the daily analysis and update tasks have executed
- If they haven't run within 2 hours of their scheduled time, re-schedules them
- Prevents missed tasks due to timer drift or system sleep

### Message Buffering

Real-time WhatsApp messages are buffered before processing:
- **Buffer size:** 20 messages max
- **Buffer timeout:** 5 minutes
- Whichever threshold is hit first triggers a flush
- On graceful shutdown, the buffer is flushed immediately

---

## 13. Deployment Options

### 13a. Local Development

```bash
# Install dependencies
npm install

# Create and configure .env
cp .env.example .env
# Edit .env with your API keys

# Start in dev mode (auto-reloads on file changes)
npm run dev

# Or build and run production mode
npm run build
npm start
```

**Dev mode uses `tsx`** which runs TypeScript directly without a build step. Changes to `src/` files are picked up automatically.

### 13b. Docker

```bash
# Build the image
docker build -t whatsapp-tools .

# Run with persistent storage
docker run -d \
  --name whatsapp-tools \
  -p 3000:3000 \
  -v whatsapp-data:/data \
  --env-file .env \
  -e DB_PATH=/data/events.db \
  -e AUTH_DIR=/data/.auth \
  whatsapp-tools
```

**Docker Compose example:**

```yaml
version: '3.8'
services:
  whatsapp-tools:
    build: .
    ports:
      - "3000:3000"
    volumes:
      - whatsapp-data:/data
    env_file: .env
    environment:
      - DB_PATH=/data/events.db
      - AUTH_DIR=/data/.auth
    restart: unless-stopped

volumes:
  whatsapp-data:
```

**Important Docker notes:**
- The Dockerfile installs system Chromium (~200MB) — this is required for WhatsApp Web.js
- Mount `/data` as a volume so your database and WhatsApp session persist across container restarts
- First launch requires QR scan — use `docker logs -f whatsapp-tools` to see the QR code, or use the web QR endpoint
- Use `restart: unless-stopped` so the container auto-recovers from crashes

### 13c. Railway

Railway is a cloud PaaS that works well for this project:

1. **Create a Railway project** and connect your GitHub repo
2. **Set environment variables** in the Railway dashboard (all from `.env.example`)
3. **Add a volume** mounted at `/data` for persistent storage
4. **Set these extra env vars:**
   ```
   DB_PATH=/data/events.db
   AUTH_DIR=/data/.auth
   ```
5. Railway auto-detects the `Dockerfile` and builds/deploys
6. First deploy: check logs for QR code, or use the web QR endpoint

**Railway tips:**
- Use a persistent volume (not ephemeral storage) or you'll lose your DB and auth session on each deploy
- Set `ADMIN_TOKEN` explicitly so it doesn't change on restart
- The free tier may have memory limits — Chromium needs ~512MB

### 13d. Firebase Hosting (Frontend Only)

You can host the static frontend on Firebase (or any static host) and point it at a backend running elsewhere:

1. **Set the API base URL** in `public/shared.js` — look for the `apiBase` configuration
2. **Deploy to Firebase:**
   ```bash
   npm install -g firebase-tools
   firebase init hosting  # Set public directory to "public"
   firebase deploy
   ```
3. **CORS:** The backend's Express server includes CORS headers. You may need to adjust the allowed origins in `src/server.ts` to match your Firebase URL.

**Note:** The backend still needs to run somewhere (Railway, Docker, VPS) for WhatsApp connectivity and API endpoints. Firebase hosting only serves the static HTML/JS/CSS.

---

## 14. Customization Guide

### Change Event Categories

Edit `src/categories.ts`:

```typescript
{
  id: "your_category",           // URL-safe lowercase ID
  name: "Your Category Name",    // Display name
  googleColorId: "5",            // Google Calendar color (1-11)
  description: "What this covers", // Used by AI for classification
  keywords: ["keyword1", "keyword2"] // Helps AI classify correctly
}
```

After changing, rebuild (`npm run build`) and restart.

### Change the AI Model

The app uses `gemini-2.5-flash` by default. To change:
1. Find `getModel()` calls in `src/apps/*/summarizer.ts`, `src/apps/*/analyzer.ts`, `src/extractor.ts`
2. Change the model name (e.g., `gemini-2.5-pro` for higher quality, slower/pricier)

### Customize the Relationship Analysis Prompt

The full analysis prompt is in `src/apps/relationship/analyzer.ts` in the `buildAnalysisPrompt()` function. You can:
- Add or remove framework dimensions
- Change scoring criteria
- Add custom metrics
- Modify the JSON output schema

### Customize Metacrisis Digests

The daily/weekly summary prompts are in `src/apps/metacrisis/summarizer.ts`. Modify the prompt to change what gets included in digests.

### Add a New Sub-App

1. Create `src/apps/yourapp/handler.ts` — message handler
2. Create `src/apps/yourapp/store.ts` — database tables
3. Create `src/apps/yourapp/routes.ts` — API endpoints
4. Register in `src/index.ts` — add to message router
5. Mount routes in `src/server.ts`
6. Create `public/yourapp.html` and `public/yourapp.js` — dashboard

### Change the Timezone

The server is locked to Eastern Time. To change:
1. Edit `src/index.ts` line 1: `process.env.TZ = "Your/Timezone"`
2. Restart

### Customize the Frontend Theme

Edit CSS variables at the top of `public/style.css`:
```css
:root {
  --bg: #0f0f0f;
  --surface: #1a1a1a;
  --accent: #f39c12;
  /* ... */
}
```

---

## 15. Troubleshooting

### WhatsApp Issues

| Problem | Solution |
|---------|----------|
| QR code not appearing | Check that Chromium is installed. Run `which chromium` or `which google-chrome`. Set `PUPPETEER_EXECUTABLE_PATH` if needed. |
| "Error: Navigation timeout" | Chromium can't connect to WhatsApp Web. Check internet connectivity. |
| Session keeps expiring | Delete `.auth/` and re-scan. If on Docker, make sure the volume is persistent. |
| Messages not being captured | Verify the group has >10 participants (for events) or the chat name matches exactly (for relationship/metacrisis). |
| "UNPAIRED" or "UNPAIRED_IDLE" | Your phone disconnected the linked device. Open WhatsApp → Linked Devices and re-link. |

### Database Issues

| Problem | Solution |
|---------|----------|
| "SQLITE_BUSY" | Another process has the DB locked. Stop other instances. |
| Database corrupted | Restore from backup. Run `sqlite3 events.db "PRAGMA integrity_check"` to verify. |
| DB file growing large | Use the admin cleanup endpoint: `POST /api/cleanup`. This runs VACUUM and prunes old message bodies. |

### AI/API Issues

| Problem | Solution |
|---------|----------|
| "GEMINI_API_KEY is required" | Set `GEMINI_API_KEY` in your `.env` file. |
| Gemini rate limit errors | The free tier has limits. Wait a minute, or upgrade to a paid tier. |
| Poor event extraction | Check `src/categories.ts` — the AI uses category descriptions for classification. Better descriptions = better results. |
| AssemblyAI failures | Check your API key. The `universal-3-pro` model requires a paid AssemblyAI plan. |

### Deployment Issues

| Problem | Solution |
|---------|----------|
| Port already in use | Change `PORT` in `.env` or kill the existing process. |
| Docker out of memory | Chromium needs ~512MB. Increase container memory limit. |
| Persistent data lost | Mount a Docker volume at `/data` and set `DB_PATH=/data/events.db`. |
| TypeScript build errors | Run `npx tsc --noEmit` to see errors. Check Node version (need 20+). |

---

## 16. Project File Map

```
whatsapp-community-tools/
│
├── .env.example                     # Template for all environment variables
├── .gitignore                       # Excludes .env, .auth/, *.db, node_modules/
├── Dockerfile                       # Production container with Chromium
├── .dockerignore                    # Keeps Docker context small
├── package.json                     # Dependencies and scripts
├── tsconfig.json                    # TypeScript configuration (ES2022, strict)
│
├── src/                             # Backend source (TypeScript)
│   ├── index.ts                     # Entry point: startup, scheduler, message routing
│   ├── server.ts                    # Express app: routes, middleware, static serving
│   ├── config.ts                    # All config loaded from .env with defaults
│   ├── store.ts                     # Core SQLite store (events + processed messages)
│   ├── whatsapp.ts                  # WhatsApp Web.js client: auth, reconnection, buffering
│   ├── extractor.ts                 # Gemini AI event extraction from message batches
│   ├── verifier.ts                  # Event date verification via URL re-fetch
│   ├── categories.ts                # Event category definitions with keywords
│   ├── airtable.ts                  # Airtable sync (create/update/delete records)
│   ├── dev-server.ts                # Development server entry point
│   │
│   ├── middleware/
│   │   └── auth.ts                  # Token auth middleware (admin + guest levels)
│   │
│   ├── utils/
│   │   ├── base-store.ts            # SQLite base class with migrations
│   │   ├── progress.ts              # Progress tracking for long-running operations
│   │   └── transcription.ts         # AssemblyAI transcription helpers
│   │
│   └── apps/
│       ├── friends/
│       │   ├── handler.ts           # Message capture for private chats
│       │   ├── store.ts             # Friends DB: contacts, messages, tags, tiers
│       │   ├── routes.ts            # Dashboard API, contact management, bulk send
│       │   ├── metrics.ts           # Quality scores, initiation balance, frequency
│       │   └── tagger.ts            # Gemini-powered tag extraction
│       │
│       ├── metacrisis/
│       │   ├── handler.ts           # Group message capture + URL extraction
│       │   ├── store.ts             # Metacrisis DB: messages, links, summaries, topics
│       │   ├── routes.ts            # Digest API, link scraping, push-to-chat
│       │   └── summarizer.ts        # Gemini AI: digests, scraping, classification
│       │
│       ├── relationship/
│       │   ├── handler.ts           # 1:1 chat capture + voice transcription
│       │   ├── store.ts             # Relationship DB: messages, analyses
│       │   ├── routes.ts            # Dashboard API, import, chat, settings
│       │   ├── analyzer.ts          # Gottman/Perel analysis via Gemini
│       │   └── updater.ts           # Daily/weekly update formatting + send
│       │
│       ├── recording/
│       │   └── routes.ts            # Audio upload, transcription, save-to-relationship
│       │
│       └── calls/
│           └── routes.ts            # Call recording, transcription, history
│
├── public/                          # Frontend (static HTML/JS/CSS — no build step)
│   ├── hub.html                     # Navigation hub to all dashboards
│   ├── index.html                   # Events dashboard (calendar, list, search)
│   ├── app.js                       # Events frontend logic
│   ├── friends.html                 # Friends dashboard
│   ├── friends.js                   # Friends frontend logic
│   ├── metacrisis.html              # Metacrisis dashboard
│   ├── metacrisis.js                # Metacrisis frontend logic
│   ├── relationship.html            # Relationship dashboard
│   ├── relationship.js              # Relationship frontend logic
│   ├── recording.html               # In-person recording page
│   ├── calls.html                   # Call recording page
│   ├── calls-recorder.js            # Call recording frontend logic
│   ├── shared.js                    # Shared utilities (auth, fetch, formatting)
│   └── style.css                    # Global dark theme design system
│
└── scripts/                         # Optional utilities
    ├── imessage-bridge.js           # Bridge service for syncing iMessages
    └── imessage-sync.js             # iMessage sync client
```

---

## License

MIT — see `package.json`.

---

*Built with WhatsApp Web.js, Google Gemini, AssemblyAI, Express, better-sqlite3, and vanilla frontend. No frameworks were harmed in the making of this project.*