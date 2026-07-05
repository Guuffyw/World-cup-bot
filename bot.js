const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionsBitField } = require('discord.js');
const cron = require('node-cron');
const axios = require('axios');
const { Pool } = require('pg');
let announceInProgress = false;
require('dotenv').config();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// ─── PostgreSQL setup ─────────────────────────────────────────────────────────

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS matches (
      match_id      BIGINT PRIMARY KEY,
      home_team     TEXT NOT NULL,
      away_team     TEXT NOT NULL,
      kickoff_utc   TIMESTAMPTZ NOT NULL,
      stage         TEXT,
      outcome       CHAR(1),          -- '1', 'X', or '2' — NULL until resolved
      resolved      BOOLEAN NOT NULL DEFAULT FALSE,
      message_id    TEXT,             -- Discord message ID for the announcement
      channel_id    TEXT              -- Discord channel ID for the announcement
    );

    CREATE TABLE IF NOT EXISTS votes (
      match_id   BIGINT NOT NULL REFERENCES matches(match_id) ON DELETE CASCADE,
      user_id    TEXT   NOT NULL,
      username   TEXT   NOT NULL,
      pick       CHAR(1) NOT NULL,    -- '1', 'X', or '2'
      correct    BOOLEAN,             -- NULL until resolved
      PRIMARY KEY (match_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS leaderboard (
      user_id   TEXT PRIMARY KEY,
      username  TEXT NOT NULL,
      points    INT  NOT NULL DEFAULT 0,
      total     INT  NOT NULL DEFAULT 0   -- total predictions made
    );

    -- Add message_id / channel_id columns if upgrading from an older schema
    ALTER TABLE matches ADD COLUMN IF NOT EXISTS message_id TEXT;
    ALTER TABLE matches ADD COLUMN IF NOT EXISTS channel_id TEXT;
  `);
  console.log('✅ Database tables ready');
}

// ─── DB helpers ───────────────────────────────────────────────────────────────

async function dbUpsertMatch(match) {
  await pool.query(`
    INSERT INTO matches (match_id, home_team, away_team, kickoff_utc, stage)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (match_id) DO NOTHING
  `, [
    match.id,
    match.homeTeam.name,
    match.awayTeam.name,
    match.utcDate,
    match.stage ?? null,
  ]);
}

async function dbSaveMessageId(matchId, messageId, channelId) {
  await pool.query(
    `UPDATE matches SET message_id = $1, channel_id = $2 WHERE match_id = $3`,
    [messageId, channelId, matchId]
  );
}

async function dbSaveVote(matchId, userId, username, pick) {
  await pool.query(`
    INSERT INTO votes (match_id, user_id, username, pick)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (match_id, user_id) DO UPDATE SET pick = EXCLUDED.pick, username = EXCLUDED.username
  `, [matchId, userId, username, pick]);
}

async function dbGetVotes(matchId) {
  const res = await pool.query(
    `SELECT user_id, pick FROM votes WHERE match_id = $1`,
    [matchId]
  );
  const votes = {};
  for (const row of res.rows) votes[row.user_id] = row.pick;
  return votes;
}

async function dbResolveMatch(matchId, outcome) {
  await pool.query(
    `UPDATE matches SET outcome = $1, resolved = TRUE WHERE match_id = $2`,
    [outcome, matchId]
  );

  await pool.query(
    `UPDATE votes SET correct = (pick = $1) WHERE match_id = $2`,
    [outcome, matchId]
  );

  const voters = await pool.query(
    `SELECT user_id, username, correct FROM votes WHERE match_id = $1`,
    [matchId]
  );

  for (const row of voters.rows) {
    const pts = row.correct ? 1 : 0;
    await pool.query(`
      INSERT INTO leaderboard (user_id, username, points, total)
      VALUES ($1, $2, $3, 1)
      ON CONFLICT (user_id) DO UPDATE
        SET username = EXCLUDED.username,
            points   = leaderboard.points + $3,
            total    = leaderboard.total  + 1
    `, [row.user_id, row.username, pts]);
  }
}

async function dbGetLeaderboard(limit = 15) {
  const res = await pool.query(`
    SELECT username, points, total,
           ROUND(points::numeric / NULLIF(total, 0) * 100, 1) AS accuracy
    FROM leaderboard
    ORDER BY points DESC, accuracy DESC
    LIMIT $1
  `, [limit]);
  return res.rows;
}

// ─── In-memory active matches (restored from DB on startup) ──────────────────

const activeMatches = new Map();

async function restoreActiveMatches() {
  const res = await pool.query(`SELECT * FROM matches WHERE resolved = FALSE`);
  for (const row of res.rows) {
    const matchId = Number(row.match_id);
    const votes = await dbGetVotes(matchId);
    activeMatches.set(matchId, {
      match: {
        id: matchId,
        homeTeam: { name: row.home_team },
        awayTeam: { name: row.away_team },
        utcDate: row.kickoff_utc,
        stage: row.stage,
      },
      votes,
      messageId: row.message_id ?? null,   // ← restored from DB
      channelId: row.channel_id ?? process.env.ANNOUNCE_CHANNEL_ID,
      resolved: false,
    });
  }
  console.log(`♻️  Restored ${activeMatches.size} unresolved match(es) from DB`);
}

// ─── API config ───────────────────────────────────────────────────────────────

const FOOTBALL_API_KEY    = process.env.FOOTBALL_API_KEY;
const ANNOUNCE_CHANNEL_ID = process.env.ANNOUNCE_CHANNEL_ID;
const WC_COMPETITION_ID   = 'WC';
const API_BASE            = 'https://api.football-data.org/v4';
const API_HEADERS         = { 'X-Auth-Token': FOOTBALL_API_KEY };

// ─── API helpers ──────────────────────────────────────────────────────────────

async function fetchTodaysMatches() {
  const today = new Date().toISOString().split('T')[0];
  console.log(`📡 Fetching fixtures for ${today}`);
  const res = await axios.get(`${API_BASE}/competitions/${WC_COMPETITION_ID}/matches`, {
    headers: API_HEADERS,
    params: { dateFrom: today, dateTo: today, status: 'SCHEDULED' },
  });
  console.log(`📊 Fixtures found: ${res.data.resultSet?.count ?? 0}`);
  return res.data.matches || [];
}

async function fetchMatchResult(matchId) {
  const res = await axios.get(`${API_BASE}/matches/${matchId}`, { headers: API_HEADERS });
  return res.data || null;
}

// ─── Tally helpers ────────────────────────────────────────────────────────────

function getTally(votes) {
  const tally = { '1': [], 'X': [], '2': [] };
  for (const [userId, pick] of Object.entries(votes)) tally[pick].push(userId);
  return tally;
}

// ─── Embed / component builders ──────────────────────────────────────────────

function buildMatchEmbed(match) {
  const home    = match.homeTeam.name;
  const away    = match.awayTeam.name;
  const kickoff = new Date(match.utcDate);
  const stage   = match.stage ?? 'Unknown Stage';
  const group   = match.group ? ` — ${match.group}` : '';

  return new EmbedBuilder()
    .setColor(0xFFD700)
    .setTitle('⚽ FIFA World Cup 2026 — Match Prediction')
    .setDescription(`Cast your vote before kick-off!\n\n**1** → ${home} wins\n**X** → Draw\n**2** → ${away} wins`)
    .addFields(
      { name: '🏠 Home',     value: home,  inline: true },
      { name: '🆚',          value: 'vs',  inline: true },
      { name: '✈️ Away',     value: away,  inline: true },
      { name: '🕐 Kick-off', value: `<t:${Math.floor(kickoff.getTime() / 1000)}:F>`, inline: true },
      { name: '🏆 Stage',    value: `${stage}${group}`, inline: true },
    )
    .setFooter({ text: `Match ID: ${match.id}` })
    .setTimestamp();
}

function buildVoteTallyEmbed(match, votes) {
  const tally = getTally(votes);
  const home  = match.homeTeam?.name ?? 'Home';
  const away  = match.awayTeam?.name ?? 'Away';
  const fmt   = (users) => users.length ? users.map(id => `<@${id}>`).join(', ') : '*No votes yet*';

  return new EmbedBuilder()
    .setColor(0x2B2D31)
    .setTitle('📊 Live Vote Breakdown')
    .addFields(
      { name: `🏠 1 — ${home} Win (${tally['1'].length})`, value: fmt(tally['1']), inline: false },
      { name: `🤝 X — Draw (${tally['X'].length})`,        value: fmt(tally['X']), inline: false },
      { name: `✈️ 2 — ${away} Win (${tally['2'].length})`, value: fmt(tally['2']), inline: false },
    )
    .setFooter({ text: `Total votes: ${Object.keys(votes).length}` })
    .setTimestamp();
}

function buildVoteButtons(matchId, votes = {}) {
  const tally = getTally(votes);
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`vote_1_${matchId}`)
      .setLabel(`1 — Home Win (${tally['1'].length})`)
      .setStyle(ButtonStyle.Primary)
      .setEmoji('🏠'),
    new ButtonBuilder()
      .setCustomId(`vote_X_${matchId}`)
      .setLabel(`X — Draw (${tally['X'].length})`)
      .setStyle(ButtonStyle.Secondary)
      .setEmoji('🤝'),
    new ButtonBuilder()
      .setCustomId(`vote_2_${matchId}`)
      .setLabel(`2 — Away Win (${tally['2'].length})`)
      .setStyle(ButtonStyle.Danger)
      .setEmoji('✈️'),
  );
}

function buildResultEmbed(match, votes) {
  const home      = match.homeTeam.name;
  const away      = match.awayTeam.name;
  const homeGoals = match.score?.regularTime?.home ?? match.score?.fullTime?.home ?? 0;
  const awayGoals = match.score?.regularTime?.away ?? match.score?.fullTime?.away ?? 0;

  let outcome;
  if (homeGoals > awayGoals)        outcome = '1';
  else if (homeGoals === awayGoals) outcome = 'X';
  else                               outcome = '2';

  const outcomeLabel =
    outcome === '1' ? `${home} Win` : outcome === 'X' ? 'Draw' : `${away} Win`;

  const tally = getTally(votes);
  const fmt   = (users) => users.length ? users.map(id => `<@${id}>`).join(', ') : '*(nobody)*';

  return new EmbedBuilder()
    .setColor(outcome === '1' ? 0x3498DB : outcome === 'X' ? 0x95A5A6 : 0xE74C3C)
    .setTitle('🏆 Match Result — Predictions Resolved!')
    .addFields(
      { name: '⚽ Final Score',        value: `**${home} ${homeGoals} – ${awayGoals} ${away}**`, inline: false },
      { name: '🎯 Outcome',            value: outcomeLabel, inline: false },
      { name: '📊 Votes Cast',         value: `1: ${tally['1'].length} · X: ${tally['X'].length} · 2: ${tally['2'].length}`, inline: false },
      { name: `🏠 Voted ${home} Win`,  value: fmt(tally['1']), inline: false },
      { name: '🤝 Voted Draw',         value: fmt(tally['X']), inline: false },
      { name: `✈️ Voted ${away} Win`,  value: fmt(tally['2']), inline: false },
    )
    .setTimestamp();
}

function buildLeaderboardEmbed(rows) {
  const medals = ['🥇', '🥈', '🥉'];

  const lines = rows.map((row, i) => {
    const medal = medals[i] ?? `**${i + 1}.**`;
    const acc   = row.accuracy != null ? ` (${row.accuracy}% acc.)` : '';
    return `${medal} **${row.username}** — ${row.points} pt${row.points !== 1 ? 's' : ''}${acc} · ${row.total} picks`;
  });

  return new EmbedBuilder()
    .setColor(0xFFD700)
    .setTitle('🏆 World Cup 2026 — Prediction Leaderboard')
    .setDescription(lines.length ? lines.join('\n') : '*No predictions yet. Be the first!*')
    .setFooter({ text: '1 point awarded per correct prediction' })
    .setTimestamp();
}

// ─── Shared helper: edit the announcement message safely ─────────────────────

async function safeEditMatchMessage(entry, matchId) {
  if (!entry.messageId) {
    console.warn(`⚠️  No messageId for match ${matchId} — skipping message edit`);
    return;
  }

  try {
    const channel  = await client.channels.fetch(entry.channelId).catch(() => null);
    if (!channel)  { console.warn(`⚠️  Channel ${entry.channelId} not found`); return; }

    const original = await channel.messages.fetch(entry.messageId);
    if (!original || typeof original.edit !== 'function') {
      console.warn(`⚠️  Could not fetch editable message ${entry.messageId}`);
      return;
    }

    const updatedRow   = buildVoteButtons(matchId, entry.votes);
    const updatedTally = buildVoteTallyEmbed(entry.match, entry.votes);
    await original.edit({ embeds: [buildMatchEmbed(entry.match), updatedTally], components: [updatedRow] });
  } catch (err) {
    console.error(`⚠️  Could not update vote message for match ${matchId}:`, err.message);
  }
}

// ─── Announce today's matches ─────────────────────────────────────────────────

async function announceTodaysMatches() {
  if (announceInProgress) {
    console.log('⚠️  announceTodaysMatches already running, skipping duplicate call');
    return;
  }
  announceInProgress = true;

  try {
    console.log(`🔍 ANNOUNCE_CHANNEL_ID: ${ANNOUNCE_CHANNEL_ID}`);
    const channel = await client.channels.fetch(ANNOUNCE_CHANNEL_ID).catch(err => {
      console.error('❌ Failed to fetch channel:', err.message);
      return null;
    });
    if (!channel) return console.error('❌ Announce channel not found.');

    let matches;
    try {
      matches = await fetchTodaysMatches();
    } catch (err) {
      console.error('❌ Failed to fetch fixtures:', err.response?.data || err.message);
      channel.send(`❌ API error: ${err.response?.data?.message || err.message}`);
      return;
    }

    if (!matches.length) {
      channel.send('📅 No World Cup matches today. Check back tomorrow!');
      return;
    }

    for (const match of matches) {
      const matchId = match.id;
      const existing = activeMatches.get(matchId);

      // Already announced and has a valid Discord message — skip
      if (existing?.messageId) {
        console.log(`⏭️  Match ${matchId} already announced (messageId: ${existing.messageId}), skipping`);
        continue;
      }

      // New match not in DB yet — insert it
      if (!existing) {
        await dbUpsertMatch(match);
      }

      const votes      = existing?.votes ?? {};
      const embed      = buildMatchEmbed(match);
      const tallyEmbed = buildVoteTallyEmbed(match, votes);
      const row        = buildVoteButtons(matchId, votes);

      const msg = await channel.send({ embeds: [embed, tallyEmbed], components: [row] });

      await dbSaveMessageId(matchId, msg.id, channel.id);

      activeMatches.set(matchId, {
        match,
        votes,
        messageId: msg.id,
        channelId: channel.id,
        resolved:  false,
      });

      console.log(`✅ Announced match ${matchId}: ${match.homeTeam.name} vs ${match.awayTeam.name}`);

      const kickoff = new Date(match.utcDate).getTime();
      const delay   = kickoff + 100 * 60 * 1000 - Date.now();
      if (delay > 0) setTimeout(() => resolveMatch(matchId), delay);
      else           resolveMatch(matchId);
    }
  } finally {
    announceInProgress = false;
  }
}

// ─── Resolve a match ──────────────────────────────────────────────────────────

async function resolveMatch(matchId) {
  const entry = activeMatches.get(matchId);
  if (!entry || entry.resolved) return;

  let result;
  try {
    result = await fetchMatchResult(matchId);
  } catch (err) {
    console.error(`❌ Could not fetch result for ${matchId}:`, err.message);
    setTimeout(() => resolveMatch(matchId), 5 * 60 * 1000);
    return;
  }

  const status = result?.status;
  const label  = `${result?.homeTeam?.name ?? '?'} vs ${result?.awayTeam?.name ?? '?'}`;

  // Prefer regularTime (90-min score) if present, otherwise fall back to fullTime
  const liveHome = result?.score?.regularTime?.home ?? result?.score?.fullTime?.home;
  const liveAway = result?.score?.regularTime?.away ?? result?.score?.fullTime?.away;
  const liveScore = `${liveHome ?? '-'}-${liveAway ?? '-'}`;

  if (!['FINISHED', 'AWARDED'].includes(status)) {
    console.log(`⏳ [${matchId}] ${label} — ${liveScore} (${status}), retrying in 5 min…`);
    setTimeout(() => resolveMatch(matchId), 5 * 60 * 1000);
    return;
  }

  const homeGoals = result.score?.regularTime?.home ?? result.score?.fullTime?.home;
  const awayGoals = result.score?.regularTime?.away ?? result.score?.fullTime?.away;

  if (homeGoals == null || awayGoals == null) {
    console.log(`⏳ [${matchId}] ${label} finished but score not populated yet, retrying in 2 min…`);
    setTimeout(() => resolveMatch(matchId), 2 * 60 * 1000);
    return;
  }

  const outcome = homeGoals > awayGoals ? '1' : homeGoals === awayGoals ? 'X' : '2';

  entry.resolved = true;
  entry.match    = result;

  await dbResolveMatch(matchId, outcome);

  // Who scored points, for a clean console summary
  const voterRows = await pool.query(
    `SELECT username, correct FROM votes WHERE match_id = $1`,
    [matchId]
  );
  const winners = voterRows.rows.filter(r => r.correct).map(r => r.username);
  const winnerText = winners.length
    ? `${winners.join(', ')} +1 point${winners.length > 1 ? 's' : ''}`
    : 'no correct picks';

  console.log(`✅ Resolved match ${matchId} (${label} ${homeGoals}-${awayGoals}) — outcome: ${outcome} — ${winnerText}`);

  const channel = await client.channels.fetch(entry.channelId).catch(() => null);
  if (!channel) return;

  // Disable buttons and mark tally as final on the original message
  if (entry.messageId) {
    try {
      const original = await channel.messages.fetch(entry.messageId);
      if (original && typeof original.edit === 'function') {
        const disabledRow = new ActionRowBuilder().addComponents(
          ...buildVoteButtons(matchId, entry.votes).components.map(b =>
            ButtonBuilder.from(b.toJSON()).setDisabled(true)
          )
        );
        const closedTally = buildVoteTallyEmbed(entry.match, entry.votes)
          .setTitle('📊 Final Vote Breakdown')
          .setColor(0x57F287)
          .setFooter({ text: `Voting closed · Total votes: ${Object.keys(entry.votes).length}` });

        await original.edit({ embeds: [buildMatchEmbed(entry.match), closedTally], components: [disabledRow] });
      }
    } catch (err) {
      console.warn(`⚠️  Could not edit original message on resolve:`, err.message);
    }
  }

  const resultEmbed = buildResultEmbed(result, entry.votes);
  await channel.send({ embeds: [resultEmbed] });
}
// ─── Button interaction handler ───────────────────────────────────────────────

client.on('interactionCreate', async interaction => {
  if (!interaction.isButton()) return;

  const parts   = interaction.customId.split('_');
  const pick    = parts[1];
  const matchId = Number(parts[2]);
  const entry   = activeMatches.get(matchId);

  if (!entry) {
    return interaction.reply({ content: '❌ This match is no longer tracked.', ephemeral: true });
  }
  if (entry.resolved) {
    return interaction.reply({ content: '⏰ Voting is closed — the match has ended.', ephemeral: true });
  }

  const previous = entry.votes[interaction.user.id];
  entry.votes[interaction.user.id] = pick;

  // Persist vote to DB
  await dbSaveVote(matchId, interaction.user.id, interaction.user.username, pick);

  // Update the announcement message safely
  await safeEditMatchMessage(entry, matchId);

  const labels = { '1': '🏠 Home Win', 'X': '🤝 Draw', '2': '✈️ Away Win' };
  const msg = previous
    ? `🔄 Changed your vote from **${labels[previous]}** to **${labels[pick]}**.`
    : `✅ Voted **${labels[pick]}** for this match!`;

  await interaction.reply({ content: msg, ephemeral: true });
});

// ─── Text commands ────────────────────────────────────────────────────────────

client.on('messageCreate', async msg => {
  if (msg.author.bot) return;

  // ── Public: leaderboard ──────────────────────────────────────────────────
  if (msg.content === '!leaderboard') {
    const rows = await dbGetLeaderboard(15);
    return msg.reply({ embeds: [buildLeaderboardEmbed(rows)] });
  }

  // ── Admin-only commands ──────────────────────────────────────────────────
  const isAdmin =
    msg.member?.permissions.has(PermissionsBitField.Flags.Administrator) ||
    msg.member?.permissions.has(PermissionsBitField.Flags.ManageGuild);

  if (!isAdmin) return;

  if (msg.content === '!wc announce') {
    await msg.reply('📡 Fetching today\'s World Cup matches…');
    await announceTodaysMatches();
  }
  
if (msg.content.startsWith('!wc resolve ')) {
  console.log('Resolve command received:', msg.content);

  const id = Number(msg.content.split(' ')[2]);
  console.log('Match ID:', id);

  if (!id) {
    console.log('Invalid match ID');
    return msg.reply('Usage: `!wc resolve <matchId>`');
  }

  try {
    await msg.reply(`🔍 Resolving match ${id}…`);
    console.log('Calling resolveMatch...');
    await resolveMatch(id);
    console.log('resolveMatch completed successfully');
  } catch (err) {
    console.error('resolveMatch failed:', err);
    await msg.reply('❌ An error occurred while resolving the match.');
  }
}

  if (msg.content === '!wc test') {
    await msg.reply('📡 Testing API connection…');
    try {
      const matches = await fetchTodaysMatches();
      await msg.reply(`✅ API working! Found ${matches.length} match(es) today.`);
    } catch (err) {
      await msg.reply(`❌ API error: ${err.response?.data ? JSON.stringify(err.response.data) : err.message}`);
    }
  }

  if (msg.content.startsWith('!wc votes ')) {
    const id = Number(msg.content.split(' ')[2]);
    if (!id) return msg.reply('Usage: `!wc votes <matchId>`');
    const entry = activeMatches.get(id);
    if (!entry) return msg.reply(`❌ No active match found with ID \`${id}\`.`);
    const tallyEmbed = buildVoteTallyEmbed(entry.match, entry.votes);
    await msg.reply({ embeds: [tallyEmbed] });
  }

  if (msg.content === '!wc debug') {
    const lines = [];
    for (const [key, entry] of activeMatches.entries()) {
      lines.push(
        `key: \`${key}\` (${typeof key}) — ` +
        `${entry.match.homeTeam.name} vs ${entry.match.awayTeam.name} — ` +
        `votes: ${Object.keys(entry.votes).length} — ` +
        `messageId: ${entry.messageId ?? 'none'}`
      );
    }
    await msg.reply(lines.length ? lines.join('\n') : 'No active matches in memory.');
  }

  if (msg.content.startsWith('!wc raw ')) {
    const id = Number(msg.content.split(' ')[2]);
    if (!id) return msg.reply('Usage: `!wc raw <matchId>`');
    try {
      const result = await fetchMatchResult(id);
      await msg.reply('```json\n' + JSON.stringify(result?.score, null, 2) + '\n```');
    } catch (err) {
      await msg.reply(`❌ ${err.message}`);
    }
  }
});

// ─── Startup ──────────────────────────────────────────────────────────────────

client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  console.log(`📢 Announce channel: ${ANNOUNCE_CHANNEL_ID}`);
  console.log(`🔑 API key set: ${!!FOOTBALL_API_KEY}`);

  await initDB();
  await restoreActiveMatches();

  cron.schedule('0 7 * * *', () => {
    announceTodaysMatches();
  }, {
    timezone: 'Europe/Budapest',
  });

  announceTodaysMatches();
});

client.login(process.env.DISCORD_TOKEN);