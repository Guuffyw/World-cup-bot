# ⚽ World Cup 2026 Discord Betting Bot

A Discord bot that announces today's FIFA World Cup 2026 matches and lets your server vote on the outcome in classic **1 / X / 2** format (Home Win / Draw / Away Win). When the match ends, it automatically reveals who predicted correctly.

---

## Features

- 📅 **Daily announcements** at 08:00 — every World Cup match for the day gets its own embed
- 🗳️ **1X2 voting** via interactive buttons (one vote per user, changeable before kick-off)
- 🏆 **Automatic result resolution** — fetches the final score ~10 min after full time
- 📢 **Winner/loser reveal** — mentions all correct and incorrect predictors
- 🔒 **Ephemeral vote confirmations** — only the voter sees their confirmation

---

## Setup

### 1. Prerequisites

- Node.js **18+**
- A [Discord application & bot token](https://discord.com/developers/applications)
- A free [API-Football](https://www.api-football.com/) account (free tier: 100 req/day — plenty)

### 2. Install

```bash
npm install
```

### 3. Configure

Copy `.env.example` to `.env` and fill in the values:

```bash
cp .env.example .env
```

| Variable | Description |
|---|---|
| `DISCORD_TOKEN` | Your bot token from the Discord Developer Portal |
| `ANNOUNCE_CHANNEL_ID` | The channel where match announcements are posted |
| `FOOTBALL_API_KEY` | Your key from api-football.com |

### 4. Invite the bot

In the Discord Developer Portal → OAuth2 → URL Generator, select:
- **Scopes:** `bot`, `applications.commands`
- **Bot Permissions:** `Send Messages`, `Embed Links`, `Read Message History`

### 5. Run

```bash
npm start
```

---

## Admin Commands

These commands require the **Manage Server** permission.

| Command | Description |
|---|---|
| `!wc announce` | Immediately announce today's matches (useful for testing) |
| `!wc resolve <matchId>` | Force-resolve a specific match by its fixture ID |

---

## How It Works

```
08:00 every day
    └─ Fetch today's World Cup fixtures (League 1, Season 2026)
        └─ For each match → post embed + 3 vote buttons
            └─ Users click 🏠 1 / 🤝 X / ✈️ 2 (can change vote)
                └─ ~100 min after kick-off → poll API for final score
                    └─ If FT/AET/PEN → resolve & post result embed
                        └─ Buttons disabled, winners & losers mentioned
```

---

## Notes

- Votes are stored **in-memory** — they reset if the bot restarts. For production use, swap `activeMatches` (Map) with a database like SQLite or Redis.
- The football API free tier resets at midnight UTC. 100 requests/day is more than enough for a World Cup schedule.
- World Cup 2026 group stage runs **June 11 – July 2, 2026**.
