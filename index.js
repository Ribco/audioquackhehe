/**
 * AudioQuack Music Bot + Dashboard - index.js
 * npm install discord.js discord-player discord-player-youtubei ffmpeg-static youtube-dl-exec dotenv express express-session ws
 *
 * ENV VARS:
 *   DISCORD_TOKEN       - Bot token
 *   CLIENT_ID           - Application client ID
 *   CLIENT_SECRET       - Application client secret (for OAuth)
 *   REDIRECT_URI        - e.g. http://localhost:3000/auth/callback
 *   SESSION_SECRET      - Any random string
 *   PORT                - Dashboard port (default 3000)
 *   YT_COOKIES          - Netscape YouTube cookie string
 */

import "dotenv/config";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  Client, GatewayIntentBits, REST, Routes,
  SlashCommandBuilder, EmbedBuilder, ActivityType,
} from "discord.js";
import { Player, useQueue, useMainPlayer } from "discord-player";
import { YoutubeiExtractor } from "discord-player-youtubei";
import express from "express";
import session from "express-session";
import { WebSocketServer } from "ws";
import { createServer } from "http";

import { createRequire } from "module";
const require = createRequire(import.meta.url);
import crypto from "crypto";
globalThis.crypto = crypto;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Config ───────────────────────────────────────────────────────────────────

const DISCORD_TOKEN   = process.env.DISCORD_TOKEN;
const CLIENT_ID       = process.env.CLIENT_ID;
const CLIENT_SECRET   = process.env.CLIENT_SECRET;
const REDIRECT_URI    = process.env.REDIRECT_URI || "https://audioquack.qzz.io/auth/callback";
const SESSION_SECRET  = process.env.SESSION_SECRET || "audioquack-secret";
const PORT            = process.env.PORT || 5113;
const YT_COOKIES = fs.readFileSync("./cookies.txt", "utf-8");

if (!DISCORD_TOKEN)  throw new Error("Missing DISCORD_TOKEN");
if (!CLIENT_ID)      throw new Error("Missing CLIENT_ID");
if (!CLIENT_SECRET)  throw new Error("Missing CLIENT_SECRET");

// ─── Slash Commands ───────────────────────────────────────────────────────────

const commands = [
  new SlashCommandBuilder().setName("play").setDescription("Play a song from YouTube")
    .addStringOption(o => o.setName("query").setDescription("Song name or URL").setRequired(true)),
  new SlashCommandBuilder().setName("skip").setDescription("Skip the current track"),
  new SlashCommandBuilder().setName("stop").setDescription("Stop and clear the queue"),
  new SlashCommandBuilder().setName("pause").setDescription("Pause the current track"),
  new SlashCommandBuilder().setName("resume").setDescription("Resume playback"),
  new SlashCommandBuilder().setName("queue").setDescription("Show the queue"),
  new SlashCommandBuilder().setName("nowplaying").setDescription("Show now playing"),
  new SlashCommandBuilder().setName("volume").setDescription("Set volume (0-150)")
    .addIntegerOption(o => o.setName("level").setDescription("0-150").setRequired(true).setMinValue(0).setMaxValue(150)),
  new SlashCommandBuilder().setName("loop").setDescription("Set loop mode")
    .addStringOption(o => o.setName("mode").setDescription("Loop mode").setRequired(true)
      .addChoices(
        { name: "Off", value: "0" }, { name: "Track", value: "1" },
        { name: "Queue", value: "2" }, { name: "Autoplay", value: "3" }
      )),
  new SlashCommandBuilder().setName("shuffle").setDescription("Shuffle the queue"),
  new SlashCommandBuilder().setName("remove").setDescription("Remove track by position")
    .addIntegerOption(o => o.setName("position").setDescription("Position (1-based)").setRequired(true).setMinValue(1)),
  new SlashCommandBuilder().setName("seek").setDescription("Seek in current track")
    .addStringOption(o => o.setName("time").setDescription("mm:ss or seconds").setRequired(true)),
  new SlashCommandBuilder().setName("lyrics").setDescription("Get lyrics")
    .addStringOption(o => o.setName("query").setDescription("Song name (optional)").setRequired(false)),
  new SlashCommandBuilder().setName("disconnect").setDescription("Disconnect bot from voice"),
].map(c => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
  console.log("Registering slash commands...");
  await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
  console.log("Slash commands registered.");
}

// ─── Discord Client ───────────────────────────────────────────────────────────

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
  ],
});

// ─── Player ───────────────────────────────────────────────────────────────────

const player = new Player(client, { skipFFmpeg: false });

await player.extractors.register(YoutubeiExtractor, {
  streamOptions: { useClient: "IOS" },
});
console.log("YoutubeiExtractor registered.");
console.log("Cookies loaded:", YT_COOKIES ? "YES" : "NO");

// ─── WebSocket broadcast helper ───────────────────────────────────────────────

let wss;
function broadcast(guildId, data) {
  if (!wss) return;
  const msg = JSON.stringify({ guildId, ...data });
  wss.clients.forEach(ws => {
    if (ws.readyState === 1 && (!ws.guildId || ws.guildId === guildId)) {
      ws.send(msg);
    }
  });
}

function getQueueState(guildId) {
  const queue = useQueue(guildId);
  if (!queue) return { playing: false, track: null, tracks: [], volume: 80, loop: 0, paused: false };
  return {
    playing: queue.isPlaying(),
    paused: queue.node.isPaused(),
    track: queue.currentTrack ? {
      title: queue.currentTrack.title,
      url: queue.currentTrack.url,
      duration: queue.currentTrack.duration,
      thumbnail: queue.currentTrack.thumbnail,
      requestedBy: String(queue.currentTrack.requestedBy),
    } : null,
    tracks: queue.tracks.toArray().slice(0, 20).map((t, i) => ({
      position: i + 1,
      title: t.title,
      url: t.url,
      duration: t.duration,
      thumbnail: t.thumbnail,
    })),
    volume: queue.node.volume,
    loop: queue.repeatMode,
  };
}

// ─── Player Events ────────────────────────────────────────────────────────────

player.events.on("playerStart", (queue, track) => {
  const ch = queue.metadata?.channel;
  if (ch) {
    ch.send({ embeds: [
      new EmbedBuilder().setColor(0xf5a623).setTitle("Now Playing")
        .setDescription("**[" + track.title + "](" + track.url + ")**")
        .addFields(
          { name: "Duration", value: track.duration, inline: true },
          { name: "Requested by", value: String(track.requestedBy), inline: true },
        )
        .setThumbnail(track.thumbnail)
    ]});
  }
  broadcast(queue.guild.id, { type: "STATE_UPDATE", state: getQueueState(queue.guild.id) });
});

player.events.on("audioTrackAdd", (queue, track) => {
  const ch = queue.metadata?.channel;
  if (ch) ch.send({ embeds: [new EmbedBuilder().setColor(0x4a90e2).setDescription("Added **[" + track.title + "](" + track.url + ")** to the queue")] });
  broadcast(queue.guild.id, { type: "STATE_UPDATE", state: getQueueState(queue.guild.id) });
});

player.events.on("disconnect",   (queue) => { queue.metadata?.channel?.send("Disconnected from voice."); broadcast(queue.guild.id, { type: "STATE_UPDATE", state: getQueueState(queue.guild.id) }); });
player.events.on("emptyChannel", (queue) => { queue.metadata?.channel?.send("Voice channel empty, leaving."); broadcast(queue.guild.id, { type: "STATE_UPDATE", state: getQueueState(queue.guild.id) }); });
player.events.on("emptyQueue",   (queue) => { queue.metadata?.channel?.send("Queue finished!"); broadcast(queue.guild.id, { type: "STATE_UPDATE", state: getQueueState(queue.guild.id) }); });

player.events.on("playerError", (queue, err) => {
  console.error("Player error:", err.message);
  queue.metadata?.channel?.send("Player error: " + err.message);
});
player.events.on("error", (queue, err) => {
  console.error("Queue error:", err.message);
  queue.metadata?.channel?.send("Queue error: " + err.message);
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseTimeToMs(str) {
  if (/^\d+$/.test(str)) return parseInt(str) * 1000;
  const parts = str.split(":").map(Number);
  if (parts.length === 2) return (parts[0] * 60 + parts[1]) * 1000;
  if (parts.length === 3) return (parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000;
  return null;
}

function requireVoice(interaction) {
  if (!interaction.member?.voice?.channel) {
    interaction.reply({ content: "You must be in a voice channel.", ephemeral: true });
    return null;
  }
  return interaction.member.voice.channel;
}

function requireQueue(interaction) {
  const queue = useQueue(interaction.guildId);
  if (!queue || !queue.isPlaying()) {
    interaction.reply({ content: "Nothing is playing right now.", ephemeral: true });
    return null;
  }
  return queue;
}

// ─── Slash Command Handler ────────────────────────────────────────────────────

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const { commandName } = interaction;

if (commandName === "play") {
  const vc = requireVoice(interaction);
  if (!vc) return;

  await interaction.deferReply();

  const query = interaction.options.getString("query", true);
  const mainPlayer = useMainPlayer();

  try {
    // Try IOS extractor first
    const result = await mainPlayer.play(vc, query, {
      nodeOptions: {
        metadata: { channel: interaction.channel },
        selfDeaf: true,
        volume: 80,
        leaveOnEmpty: true,
        leaveOnEnd: true,
      },
      requestedBy: interaction.user,
      // Force IOS client
      extractorOptions: { streamOptions: { useClient: "IOS" } },
    });

    if (result.track) {
      // Normal success
      await interaction.editReply({
        embeds: [new EmbedBuilder()
          .setColor(0x4a90e2)
          .setDescription(`Queuing: **[${result.track.title}](${result.track.url})**`)
        ]
      });
    } else {
      // Somehow IOS returned no track
      throw new Error("IOS extractor failed, trying fallback...");
    }
  } catch (err) {
    console.warn("IOS extractor failed:", err.message);

    try {
      // Fallback using youtube-dl
      const ytdlPlayer = await mainPlayer.play(vc, query, {
        nodeOptions: {
          metadata: { channel: interaction.channel },
          selfDeaf: true,
          volume: 80,
          leaveOnEmpty: true,
          leaveOnEnd: true,
        },
        requestedBy: interaction.user,
        extractor: "ytdl", // force youtube-dl
      });

      if (ytdlPlayer.track) {
        await interaction.editReply({
          embeds: [new EmbedBuilder()
            .setColor(0x4a90e2)
            .setDescription(`Queuing via fallback: **[${ytdlPlayer.track.title}](${ytdlPlayer.track.url})**`)
          ]
        });
      } else {
        throw new Error("Fallback extractor also failed.");
      }
    } catch (fallbackErr) {
      console.error("Play failed:", fallbackErr);
      await interaction.editReply("❌ Could not play this track. It may be age-restricted, region-blocked, or unsupported.");
    }
  }
}
  else if (commandName === "skip") {
    const q = requireQueue(interaction); if (!q) return;
    q.node.skip();
    await interaction.reply({ embeds: [new EmbedBuilder().setColor(0x4a90e2).setDescription("Skipped.")] });
  }
  else if (commandName === "stop") {
    const q = useQueue(interaction.guildId);
    if (!q) return interaction.reply({ content: "No active queue.", ephemeral: true });
    q.delete();
    await interaction.reply({ embeds: [new EmbedBuilder().setColor(0xe74c3c).setDescription("Stopped.")] });
  }
  else if (commandName === "pause") {
    const q = requireQueue(interaction); if (!q) return;
    if (q.node.isPaused()) return interaction.reply({ content: "Already paused.", ephemeral: true });
    q.node.pause();
    broadcast(interaction.guildId, { type: "STATE_UPDATE", state: getQueueState(interaction.guildId) });
    await interaction.reply({ embeds: [new EmbedBuilder().setColor(0xf5a623).setDescription("Paused.")] });
  }
  else if (commandName === "resume") {
    const q = useQueue(interaction.guildId);
    if (!q) return interaction.reply({ content: "No active queue.", ephemeral: true });
    if (!q.node.isPaused()) return interaction.reply({ content: "Not paused.", ephemeral: true });
    q.node.resume();
    broadcast(interaction.guildId, { type: "STATE_UPDATE", state: getQueueState(interaction.guildId) });
    await interaction.reply({ embeds: [new EmbedBuilder().setColor(0x2ecc71).setDescription("Resumed.")] });
  }
  else if (commandName === "nowplaying") {
    const q = requireQueue(interaction); if (!q) return;
    const t = q.currentTrack;
    await interaction.reply({ embeds: [
      new EmbedBuilder().setColor(0xf5a623).setTitle("Now Playing")
        .setDescription("**[" + t.title + "](" + t.url + ")**")
        .addFields({ name: "Duration", value: t.duration, inline: true }, { name: "Requested by", value: String(t.requestedBy), inline: true })
        .addFields({ name: "Progress", value: q.node.createProgressBar() || "Unknown" })
        .setThumbnail(t.thumbnail)
    ]});
  }
  else if (commandName === "queue") {
    const q = useQueue(interaction.guildId);
    if (!q?.currentTrack) return interaction.reply({ content: "Nothing playing.", ephemeral: true });
    const tracks = q.tracks.toArray();
    const list = tracks.slice(0, 10).map((t, i) => "**" + (i+1) + ".** [" + t.title + "](" + t.url + ") - " + t.duration).join("\n") || "No upcoming tracks.";
    await interaction.reply({ embeds: [
      new EmbedBuilder().setColor(0x4a90e2).setTitle("Queue")
        .setDescription("**Now Playing:** [" + q.currentTrack.title + "](" + q.currentTrack.url + ")\n\n" + list)
        .setFooter({ text: tracks.length + " track(s) in queue" })
    ]});
  }
  else if (commandName === "volume") {
    const q = requireQueue(interaction); if (!q) return;
    const level = interaction.options.getInteger("level", true);
    q.node.setVolume(level);
    broadcast(interaction.guildId, { type: "STATE_UPDATE", state: getQueueState(interaction.guildId) });
    await interaction.reply({ embeds: [new EmbedBuilder().setColor(0x2ecc71).setDescription("Volume: **" + level + "%**")] });
  }
  else if (commandName === "loop") {
    const q = requireQueue(interaction); if (!q) return;
    const mode = parseInt(interaction.options.getString("mode", true));
    q.setRepeatMode(mode);
    broadcast(interaction.guildId, { type: "STATE_UPDATE", state: getQueueState(interaction.guildId) });
    await interaction.reply({ embeds: [new EmbedBuilder().setColor(0x9b59b6).setDescription("Loop: **" + ["Off","Track","Queue","Autoplay"][mode] + "**")] });
  }
  else if (commandName === "shuffle") {
    const q = requireQueue(interaction); if (!q) return;
    q.tracks.shuffle();
    broadcast(interaction.guildId, { type: "STATE_UPDATE", state: getQueueState(interaction.guildId) });
    await interaction.reply({ embeds: [new EmbedBuilder().setColor(0xe67e22).setDescription("Queue shuffled!")] });
  }
  else if (commandName === "remove") {
    const q = requireQueue(interaction); if (!q) return;
    const track = q.tracks.toArray()[interaction.options.getInteger("position", true) - 1];
    if (!track) return interaction.reply({ content: "Invalid position.", ephemeral: true });
    q.node.remove(track);
    broadcast(interaction.guildId, { type: "STATE_UPDATE", state: getQueueState(interaction.guildId) });
    await interaction.reply({ embeds: [new EmbedBuilder().setColor(0xe74c3c).setDescription("Removed **" + track.title + "**")] });
  }
  else if (commandName === "seek") {
    const q = requireQueue(interaction); if (!q) return;
    const timeStr = interaction.options.getString("time", true);
    const ms = parseTimeToMs(timeStr);
    if (ms === null) return interaction.reply({ content: "Invalid time.", ephemeral: true });
    await q.node.seek(ms);
    await interaction.reply({ embeds: [new EmbedBuilder().setColor(0x3498db).setDescription("Seeked to **" + timeStr + "**")] });
  }
  else if (commandName === "lyrics") {
    await interaction.deferReply();
    const q = useQueue(interaction.guildId);
    const searchQuery = interaction.options.getString("query") ?? q?.currentTrack?.title;
    if (!searchQuery) return interaction.editReply("No track playing.");
    try {
      const res = await fetch("https://lyrics.ovh/v1/" + encodeURIComponent(searchQuery));
      const data = await res.json();
      if (!data.lyrics) throw new Error();
      const lyrics = data.lyrics.length > 3900 ? data.lyrics.slice(0, 3900) + "\n...(truncated)" : data.lyrics;
      await interaction.editReply({ embeds: [new EmbedBuilder().setColor(0x1db954).setTitle("Lyrics - " + searchQuery).setDescription(lyrics)] });
    } catch { await interaction.editReply("Lyrics not found."); }
  }
  else if (commandName === "disconnect") {
    const q = useQueue(interaction.guildId);
    if (q) q.delete();
    broadcast(interaction.guildId, { type: "STATE_UPDATE", state: getQueueState(interaction.guildId) });
    await interaction.reply({ embeds: [new EmbedBuilder().setColor(0x95a5a6).setDescription("Disconnected.")] });
  }
});

// ─── Express Dashboard ────────────────────────────────────────────────────────

const app = express();
app.use(express.json());
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 7 * 24 * 60 * 60 * 1000 },
}));

// Serve dashboard HTML
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "dashboard.html"));
});

// Auth middleware
function requireAuth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: "Unauthorized" });
  next();
}

// Discord OAuth2 login
app.get("/auth/login", (req, res) => {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: "identify guilds",
  });
  res.redirect("https://discord.com/api/oauth2/authorize?" + params);
});

app.get("/auth/callback", async (req, res) => {
  const { code } = req.query;
  if (!code) return res.redirect("/?error=no_code");

  try {
    // Exchange code for token
    const tokenRes = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
      }),
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) throw new Error("No access token");

    // Fetch user info
    const userRes = await fetch("https://discord.com/api/users/@me", {
      headers: { Authorization: "Bearer " + tokenData.access_token },
    });
    const user = await userRes.json();

    // Fetch user guilds
    const guildsRes = await fetch("https://discord.com/api/users/@me/guilds", {
      headers: { Authorization: "Bearer " + tokenData.access_token },
    });
    const guilds = await guildsRes.json();

    req.session.user = {
      id: user.id,
      username: user.username,
      discriminator: user.discriminator,
      avatar: user.avatar
        ? "https://cdn.discordapp.com/avatars/" + user.id + "/" + user.avatar + ".png"
        : "https://cdn.discordapp.com/embed/avatars/0.png",
      guilds: guilds.filter(g => g.icon || g.name), // filter valid guilds
    };

    res.redirect("/");
  } catch (err) {
    console.error("OAuth error:", err);
    res.redirect("/?error=oauth_failed");
  }
});

app.get("/auth/logout", (req, res) => {
  req.session.destroy();
  res.redirect("/");
});

// ─── API Routes ───────────────────────────────────────────────────────────────

app.get("/api/me", requireAuth, (req, res) => {
  res.json(req.session.user);
});

app.get("/api/guilds", requireAuth, (req, res) => {
  const userGuilds = req.session.user.guilds;
  const botGuildIds = new Set(client.guilds.cache.map(g => g.id));

  const guilds = userGuilds.map(g => ({
    id: g.id,
    name: g.name,
    icon: g.icon
      ? "https://cdn.discordapp.com/icons/" + g.id + "/" + g.icon + ".png"
      : null,
    hasBot: botGuildIds.has(g.id),
    isAdmin: (BigInt(g.permissions) & BigInt(0x8)) === BigInt(0x8),
  }));

  res.json(guilds);
});

app.get("/api/guild/:guildId/state", requireAuth, (req, res) => {
  const { guildId } = req.params;
  const userGuildIds = req.session.user.guilds.map(g => g.id);
  if (!userGuildIds.includes(guildId)) return res.status(403).json({ error: "Forbidden" });

  const guild = client.guilds.cache.get(guildId);
  if (!guild) return res.status(404).json({ error: "Bot not in this server" });

  res.json(getQueueState(guildId));
});

// Control endpoints
async function guildControl(req, res, action) {
  const { guildId } = req.params;
  const userGuildIds = req.session.user.guilds.map(g => g.id);
  if (!userGuildIds.includes(guildId)) return res.status(403).json({ error: "Forbidden" });

  const guild = client.guilds.cache.get(guildId);
  if (!guild) return res.status(404).json({ error: "Bot not in this server" });

  try {
    await action(guildId, req.body);
    broadcast(guildId, { type: "STATE_UPDATE", state: getQueueState(guildId) });
    res.json({ ok: true, state: getQueueState(guildId) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

app.post("/api/guild/:guildId/skip",    requireAuth, (req, res) => guildControl(req, res, (gid) => { const q = useQueue(gid); if (q) q.node.skip(); }));
app.post("/api/guild/:guildId/pause",   requireAuth, (req, res) => guildControl(req, res, (gid) => { const q = useQueue(gid); if (q && !q.node.isPaused()) q.node.pause(); }));
app.post("/api/guild/:guildId/resume",  requireAuth, (req, res) => guildControl(req, res, (gid) => { const q = useQueue(gid); if (q && q.node.isPaused()) q.node.resume(); }));
app.post("/api/guild/:guildId/stop",    requireAuth, (req, res) => guildControl(req, res, (gid) => { const q = useQueue(gid); if (q) q.delete(); }));
app.post("/api/guild/:guildId/shuffle", requireAuth, (req, res) => guildControl(req, res, (gid) => { const q = useQueue(gid); if (q) q.tracks.shuffle(); }));
app.post("/api/guild/:guildId/volume",  requireAuth, (req, res) => guildControl(req, res, (gid, body) => { const q = useQueue(gid); if (q) q.node.setVolume(Math.min(150, Math.max(0, parseInt(body.level) || 80))); }));
app.post("/api/guild/:guildId/loop",    requireAuth, (req, res) => guildControl(req, res, (gid, body) => { const q = useQueue(gid); if (q) q.setRepeatMode(parseInt(body.mode) || 0); }));
app.post("/api/guild/:guildId/remove",  requireAuth, (req, res) => guildControl(req, res, (gid, body) => {
  const q = useQueue(gid);
  if (q) {
    const track = q.tracks.toArray()[parseInt(body.position) - 1];
    if (track) q.node.remove(track);
  }
}));

// ─── HTTP + WebSocket Server ──────────────────────────────────────────────────

const server = createServer(app);
wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws, req) => {
  console.log("WebSocket client connected");
  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === "SUBSCRIBE" && msg.guildId) {
        ws.guildId = msg.guildId;
        ws.send(JSON.stringify({ type: "STATE_UPDATE", guildId: msg.guildId, state: getQueueState(msg.guildId) }));
      }
    } catch {}
  });
  ws.on("close", () => console.log("WebSocket client disconnected"));
});

server.listen(PORT, () => {
  console.log("Dashboard running at http://localhost:" + PORT);
});

// ─── Bot Ready ────────────────────────────────────────────────────────────────

client.once("ready", async () => {
  console.log("Logged in as " + client.user.tag);
  client.user.setActivity("audioquack.qzz.io - Dashboard in BETA", { type: ActivityType.Listening });
  await registerCommands();
});

client.login(DISCORD_TOKEN);
