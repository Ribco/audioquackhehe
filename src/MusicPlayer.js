const { EmbedBuilder } = require('discord.js');
const config = require('../config');
const YouTube = require('./YouTube');
const Spotify = require('./Spotify');
const SoundCloud = require('./SoundCloud');
const LanguageManager = require('./LanguageManager');
const ErrorHandler = require('./ErrorHandler');
const PlayerStateManager = require('./PlayerStateManager');
const LyricsManager = require('./LyricsManager');

class MusicPlayer {
    constructor(guild, textChannel, voiceChannel, shoukaku) {
        this.guild = guild;
        this.textChannel = textChannel;
        this.voiceChannel = voiceChannel;
        this.shoukaku = shoukaku;
        this.player = null; // Shoukaku player

        // Queue management
        this.queue = [];
        this.currentTrack = null;
        this.previousTracks = [];

        // Player settings
        this.volume = config.bot.defaultVolume;
        this.loop = false;
        this.shuffle = false;
        this.autoplay = false;
        this.paused = false;

        // Timestamps
        this.startTime = null;
        this.pausedTime = 0;
        this.currentTrackStartOffsetMs = 0;
        this.lastPlaybackPosition = 0;

        // UI Management
        this.nowPlayingMessage = null;
        this.requesterId = null;
        this.sessionId = Date.now().toString(36) + Math.random().toString(36).substr(2);

        // Lyrics
        this.currentLyrics = null;

        // Persistence
        this.stateSyncInterval = null;
        this.stateSyncIntervalMs = 5000;
        this.stateSaveTimeout = null;

        // Pause management
        this.pauseReasons = new Set();

        // Inactivity
        this.inactivityTimer = null;
        this.inactivityTimeoutMs = 2 * 60 * 1000;

        // Transition guard
        this.isTransitioning = false;
    }

    async connect() {
        try {
            const node = this.shoukaku.options.nodeResolver(this.shoukaku.nodes);
            if (!node) throw new Error('No Lavalink nodes available');

            this.player = await node.joinChannel({
                guildId: this.guild.id,
                channelId: this.voiceChannel.id,
                shardId: this.guild.shardId || 0,
                deaf: true
            });

            this.player.on('start', () => {
                this.startTime = Date.now();
                this.paused = false;
            });

            this.player.on('end', () => {
                setTimeout(() => this.handleTrackEnd('idle').catch(console.error), 100);
            });

            this.player.on('error', (error) => {
                console.error('❌ Lavalink player error:', error);
                this.handleTrackEnd('error').catch(console.error);
            });

            this.player.on('closed', () => {
                if (this.currentTrack && !this.paused) {
                    this.connect().then(() => this.play(null, this.lastPlaybackPosition)).catch(console.error);
                }
            });

            return true;
        } catch (error) {
            console.error('❌ Failed to connect to voice channel:', error.message);
            throw error;
        }
    }

    disconnect() {
        if (this.player) {
            this.player.connection.disconnect();
            this.player = null;
        }
    }

    async addTrack(query, requestedBy, platform = 'auto') {
        try {
            let tracks = [];

            if (platform === 'auto') {
                platform = this.detectPlatform(query);
            }

            switch (platform) {
                case 'youtube':
                    tracks = await YouTube.search(query, 1, this.guild.id);
                    break;
                case 'spotify':
                    if (Spotify.isSpotifyURL(query)) {
                        tracks = await Spotify.getFromURL(query, this.guild.id);
                    } else {
                        tracks = await Spotify.search(query, 1, 'track', this.guild.id);
                    }
                    break;
                case 'soundcloud':
                    tracks = await SoundCloud.search(query, 1, this.guild.id);
                    break;
                default:
                    tracks = await YouTube.search(query, 1, this.guild.id);
            }

            if (!tracks || tracks.length === 0) {
                const errorMsg = await LanguageManager.getTranslation(this.guild.id, 'musicplayer.no_results_found');
                return { success: false, message: errorMsg };
            }

            const addedTracks = [];
            const wasIdle = !this.currentTrack;

            for (const track of tracks.slice(0, config.bot.maxPlaylistSize)) {
                track.requestedBy = requestedBy;
                track.addedAt = Date.now();

                if (this.currentTrack) {
                    this.queue.push(track);
                } else {
                    this.currentTrack = track;
                }
                addedTracks.push(track);
            }

            if (wasIdle) {
                this.currentTrack = addedTracks[0];
                await this.play(null, 0);
            }

            await this.persistState('queue-update');
            return {
                success: true,
                tracks: addedTracks,
                isPlaylist: tracks.length > 1,
                position: this.queue.length
            };

        } catch (error) {
            const errorMsg = await LanguageManager.getTranslation(this.guild.id, 'musicplayer.error_adding_track');
            return { success: false, message: errorMsg };
        }
    }

    async resolveTrack(track) {
        // Resolve to a YouTube URL for Lavalink
        let searchQuery;

        if (track.platform === 'youtube') {
            searchQuery = track.url;
        } else if (track.platform === 'spotify' || track.platform === 'soundcloud') {
            searchQuery = `ytsearch:${track.title} ${track.artist}`;
        } else {
            searchQuery = track.url;
        }

        const node = this.shoukaku.options.nodeResolver(this.shoukaku.nodes);
        const result = await node.rest.resolve(searchQuery);

        if (!result || !result.tracks || result.tracks.length === 0) {
            throw new Error(`No Lavalink result for: ${searchQuery}`);
        }

        return result.tracks[0];
    }

    async play(trackIndex = null, seekMs = 0) {
        try {
            if (!this.currentTrack) {
                if (this.queue.length === 0) {
                    return { success: false, message: 'No tracks in queue' };
                }
                this.currentTrack = this.queue.shift();
            }

            if (trackIndex !== null && this.queue[trackIndex]) {
                this.currentTrack = this.queue.splice(trackIndex, 1)[0];
            }

            if (!this.player) {
                await this.connect();
            }

            const lavalinkTrack = await this.resolveTrack(this.currentTrack);

            this.currentTrackStartOffsetMs = Math.max(0, seekMs);
            this.lastPlaybackPosition = this.currentTrackStartOffsetMs;
            this.pausedTime = 0;
            this.startTime = null;

            await this.player.playTrack({
                track: lavalinkTrack,
                options: {
                    startTime: Math.floor(seekMs)
                }
            });

            await this.player.setVolume(this.volume / 100);

            console.log(`▶️  Playing: ${this.currentTrack.title} (offset: ${seekMs}ms)`);

            this.startStateSync();
            await this.persistState(seekMs > 0 ? 'resume-playback' : 'play');
            this.fetchAndStartLyrics();

            return { success: true, track: this.currentTrack };

        } catch (error) {
            const errorMsg = await ErrorHandler.handle(error, this.guild.id, 'MusicPlayer.play');
            await this.handleError(error, errorMsg);
            return { success: false, message: errorMsg };
        }
    }

    pause(reason = 'manual') {
        if (!this.player) return false;
        this.pauseReasons.add(reason);
        this.player.setPaused(true);
        if (this.startTime) {
            this.pausedTime += Date.now() - this.startTime;
        }
        this.paused = true;
        this.scheduleStatePersist('pause', 0);
        return true;
    }

    resume(reason = 'manual') {
        if (!this.player) return false;
        this.pauseReasons.delete(reason);
        if (this.pauseReasons.size > 0) return false;
        this.player.setPaused(false);
        this.startTime = Date.now();
        this.paused = false;
        this.scheduleStatePersist('resume', 0);
        return true;
    }

    pauseFor(reason = null) {
        return this.pause(reason);
    }

    resumeFor(reason = null) {
        return this.resume(reason);
    }

    stop() {
        this.clearInactivityTimer(false);
        this.pauseReasons.clear();
        this.paused = false;
        this.stopStateSync();

        if (this.guild?.id) {
            PlayerStateManager.removeState(this.guild.id).catch(() => {});
        }

        this.queue = [];
        this.currentTrack = null;
        this.currentTrackStartOffsetMs = 0;
        this.lastPlaybackPosition = 0;

        if (this.player) {
            this.player.stopTrack();
        }

        this.disconnect();
    }

    skip() {
        if (!this.currentTrack) return false;
        if (this.player) this.player.stopTrack();
        return true;
    }

    previous() {
        if (this.previousTracks.length > 0) {
            if (this.currentTrack) this.queue.unshift(this.currentTrack);
            this.currentTrack = this.previousTracks.pop();
            if (this.player) this.player.stopTrack();
            this.scheduleStatePersist('previous', 0);
            return true;
        }
        return false;
    }

    async setVolume(volume) {
        this.volume = Math.max(0, Math.min(100, volume));
        if (this.player) {
            await this.player.setVolume(this.volume / 100);
        }
        this.scheduleStatePersist('volume', 200);
        return this.volume;
    }

    shuffleQueue() {
        if (this.queue.length > 1) {
            for (let i = this.queue.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [this.queue[i], this.queue[j]] = [this.queue[j], this.queue[i]];
            }
            this.scheduleStatePersist('shuffle-queue', 200);
            return true;
        }
        return false;
    }

    setLoop(mode) {
        this.loop = mode;
        this.scheduleStatePersist('loop', 200);
        return this.loop;
    }

    setShuffle(enabled) {
        this.shuffle = enabled;
        this.scheduleStatePersist('shuffle-toggle', 200);
        return this.shuffle;
    }

    clearQueue() {
        const cleared = this.queue.length;
        this.queue = [];
        this.scheduleStatePersist('clear-queue', 0);
        return cleared;
    }

    removeFromQueue(index) {
        if (index >= 0 && index < this.queue.length) {
            const removed = this.queue.splice(index, 1)[0];
            this.scheduleStatePersist('queue-remove', 200);
            return removed;
        }
        return null;
    }

    moveInQueue(from, to) {
        if (from >= 0 && from < this.queue.length && to >= 0 && to < this.queue.length) {
            const track = this.queue.splice(from, 1)[0];
            this.queue.splice(to, 0, track);
            this.scheduleStatePersist('queue-move', 200);
            return true;
        }
        return false;
    }

    getQueue() {
        return {
            current: this.currentTrack,
            queue: this.queue,
            previous: this.previousTracks,
            totalTracks: (this.currentTrack ? 1 : 0) + this.queue.length,
            duration: this.getTotalDuration(),
        };
    }

    getTotalDuration() {
        let total = 0;
        if (this.currentTrack?.duration) total += this.currentTrack.duration;
        this.queue.forEach(t => { if (t.duration) total += t.duration; });
        return total;
    }

    getCurrentTime() {
        if (this.player) {
            return this.currentTrackStartOffsetMs + (this.player.position || 0);
        }
        if (!this.startTime) return this.currentTrackStartOffsetMs;
        if (this.paused) return this.currentTrackStartOffsetMs + this.pausedTime;
        return this.currentTrackStartOffsetMs + (Date.now() - this.startTime) + this.pausedTime;
    }

    async handleTrackEnd(reason = 'idle') {
        if (this.isTransitioning) return;
        this.isTransitioning = true;

        try {
            const finishedTrack = this.currentTrack;
            if (!finishedTrack) return;

            this.previousTracks.push(finishedTrack);

            if (this.loop === 'track') {
                await this.play(null, 0);
                return;
            }

            if (this.loop === 'queue') {
                this.queue.push(finishedTrack);
            }

            this.startTime = null;
            this.pausedTime = 0;
            this.lastPlaybackPosition = 0;
            this.currentTrackStartOffsetMs = 0;

            if (this.queue.length > 0) {
                if (this.shuffle) {
                    const randomIndex = Math.floor(Math.random() * this.queue.length);
                    this.currentTrack = this.queue.splice(randomIndex, 1)[0];
                } else {
                    this.currentTrack = this.queue.shift();
                }
                await this.play(null, 0);

                if (global.clients?.musicEmbedManager) {
                    await global.clients.musicEmbedManager.updateNowPlayingEmbed(this);
                }
                return;
            }

            if (this.autoplay) {
                await this.handleAutoplay();
                return;
            }

            this.currentTrack = null;

            if (global.clients?.musicEmbedManager) {
                await global.clients.musicEmbedManager.handlePlaybackEnd(this);
            } else {
                await this.showQueueCompleted();
            }

            this.clearInactivityTimer(false);
            if (this.guild?.id) {
                await PlayerStateManager.removeState(this.guild.id);
            }

            setTimeout(() => {
                if (this.queue.length === 0 && !this.currentTrack) {
                    this.cleanup();
                    this.guild?.client?.players?.delete(this.guild.id);
                }
            }, 10000);

        } finally {
            this.isTransitioning = false;
        }
    }

    async handleAutoplay() {
        if (!this.autoplay || typeof this.autoplay !== 'string') return;

        try {
            const genreKeywords = {
                pop: ['top pop songs', 'pop hits official'],
                rock: ['rock music official', 'rock songs 2024'],
                hiphop: ['hip hop music', 'rap songs official'],
                electronic: ['edm music', 'house music official'],
                random: ['music official video', 'top songs 2024']
            };

            const keywords = genreKeywords[this.autoplay] || genreKeywords.random;
            const randomKeyword = keywords[Math.floor(Math.random() * keywords.length)];
            const results = await YouTube.search(randomKeyword, 10, this.guild.id);

            if (!results || results.length === 0) return;

            const filtered = results.filter(t => t.duration >= 30 && t.duration <= 600);
            if (filtered.length === 0) return;

            const randomTrack = filtered[Math.floor(Math.random() * filtered.length)];
            randomTrack.requestedBy = this.guild.members.me.user;
            randomTrack.addedAt = Date.now();

            this.currentTrack = randomTrack;
            await this.play(null, 0);

            if (global.clients?.musicEmbedManager) {
                await global.clients.musicEmbedManager.updateNowPlayingEmbed(this);
            }
        } catch (error) {
            console.error('❌ Autoplay error:', error.message);
        }
    }

    async handleError(error, userMessage = null) {
        if (this.queue.length > 0) {
            if (userMessage && this.textChannel) {
                await this.textChannel.send(userMessage).catch(() => {});
            }
            this.currentTrack = this.queue.shift();
            await this.play(null, 0);
        } else {
            this.currentTrack = null;
            const msg = userMessage || await LanguageManager.getTranslation(this.guild.id, 'musicplayer.error_playlist_stopped');
            if (this.textChannel) {
                await this.textChannel.send(msg).catch(() => {});
            }
        }
    }

    detectPlatform(query) {
        if (query.includes('youtube.com') || query.includes('youtu.be')) return 'youtube';
        if (query.includes('spotify.com')) return 'spotify';
        if (query.includes('soundcloud.com')) return 'soundcloud';
        if (query.match(/^https?:\/\/.*\.(mp3|wav|ogg|flac|m4a|aac|opus|webm|mp4)$/i)) return 'direct';
        return 'youtube';
    }

    getPlatformEmoji(platform) {
        const emojis = { youtube: '🔴', spotify: '🟢', soundcloud: '🟠', direct: '🔗' };
        return emojis[platform] || '🎵';
    }

    startInactivityTimer() {
        if (this.inactivityTimer) return;
        this.pauseFor('alone');
        this.inactivityTimer = setTimeout(async () => {
            this.inactivityTimer = null;
            const channel = this.guild.channels.cache.get(this.voiceChannel?.id);
            const hasListeners = channel ? channel.members.filter(m => !m.user.bot).size > 0 : false;

            if (hasListeners) {
                this.resumeFor('alone');
                if (global.clients?.musicEmbedManager) {
                    await global.clients.musicEmbedManager.updateNowPlayingEmbed(this);
                }
                return;
            }

            this.pauseReasons.clear();
            this.queue = [];
            this.currentTrack = null;

            try {
                if (global.clients?.musicEmbedManager) {
                    await global.clients.musicEmbedManager.handlePlaybackEnd(this);
                }
                await this.persistState('inactivity-timeout');
            } finally {
                this.cleanup();
                this.guild?.client?.players?.delete(this.guild.id);
            }
        }, Math.max(this.inactivityTimeoutMs, 0));
    }

    clearInactivityTimer(shouldResume = true) {
        if (this.inactivityTimer) {
            clearTimeout(this.inactivityTimer);
            this.inactivityTimer = null;
        }
        if (shouldResume) {
            this.resumeFor('alone');
        } else {
            this.pauseReasons.delete('alone');
        }
    }

    async showQueueCompleted() {
        if (!this.nowPlayingMessage || !this.textChannel) return;
        try {
            const completedTitle = await LanguageManager.getTranslation(this.guild.id, 'musicplayer.queue_completed');
            const completedDesc = await LanguageManager.getTranslation(this.guild.id, 'musicplayer.queue_completed_desc');
            const embed = new EmbedBuilder()
                .setTitle(completedTitle)
                .setDescription(completedDesc)
                .setColor('#00ff00')
                .setTimestamp();
            await this.nowPlayingMessage.edit({ embeds: [embed], components: [] });
        } catch {
            this.nowPlayingMessage = null;
        }
    }

    serializeTrack(track) {
        if (!track) return null;
        const requester = track.requestedBy || null;
        return {
            id: track.id || null,
            title: track.title || null,
            url: track.url || null,
            duration: Number(track.duration) || null,
            thumbnail: track.thumbnail || null,
            artist: track.artist || null,
            platform: track.platform || null,
            youtubeUrl: track.youtubeUrl || null,
            isLive: track.isLive || false,
            addedAt: track.addedAt || Date.now(),
            requesterId: requester?.id || track.requesterId || null,
            requesterTag: requester?.tag || track.requesterTag || null,
        };
    }

    deserializeTrack(data) {
        if (!data) return null;
        const track = {
            id: data.id || null,
            title: data.title || null,
            url: data.url || null,
            duration: Number(data.duration) || null,
            thumbnail: data.thumbnail || null,
            artist: data.artist || null,
            platform: data.platform || null,
            youtubeUrl: data.youtubeUrl || null,
            isLive: Boolean(data.isLive),
            addedAt: data.addedAt || Date.now(),
        };
        if (data.requesterId) {
            const cachedMember = this.guild?.members?.cache?.get?.(data.requesterId) || null;
            track.requestedBy = cachedMember || { id: data.requesterId, tag: data.requesterTag || data.requesterId };
            track.requesterId = data.requesterId;
            track.requesterTag = data.requesterTag || null;
        }
        return track;
    }

    serializeState() {
        if (!this.guild?.id) return null;
        return {
            guildId: this.guild.id,
            voiceChannelId: this.voiceChannel?.id || null,
            textChannelId: this.textChannel?.id || null,
            currentTrack: this.serializeTrack(this.currentTrack),
            queue: this.queue.map(t => this.serializeTrack(t)).filter(Boolean),
            previousTracks: this.previousTracks.slice(-10).map(t => this.serializeTrack(t)).filter(Boolean),
            volume: this.volume,
            loop: this.loop,
            shuffle: this.shuffle,
            autoplay: this.autoplay,
            paused: this.paused,
            pauseReasons: Array.from(this.pauseReasons || []),
            playbackPositionMs: this.getCurrentTime() || 0,
            currentTrackStartOffsetMs: this.currentTrackStartOffsetMs || 0,
            lastPlaybackPosition: this.lastPlaybackPosition || 0,
            requesterId: this.requesterId || null,
            nowPlayingMessageId: this.nowPlayingMessage?.id || null,
            nowPlayingChannelId: this.nowPlayingMessage?.channelId || this.textChannel?.id || null,
            sessionId: this.sessionId,
            updatedAt: Date.now()
        };
    }

    async restoreFromState(state) {
        if (!state || !this.guild?.id) return;
        this.stopStateSync();
        this.pauseReasons = new Set();

        this.volume = typeof state.volume === 'number' ? state.volume : this.volume;
        this.loop = state.loop ?? false;
        this.shuffle = state.shuffle ?? false;
        this.autoplay = state.autoplay ?? false;
        this.requesterId = state.requesterId || this.requesterId;
        this.previousTracks = (state.previousTracks || []).map(s => this.deserializeTrack(s)).filter(Boolean);
        this.queue = (state.queue || []).map(s => this.deserializeTrack(s)).filter(Boolean);
        this.currentTrack = this.deserializeTrack(state.currentTrack) || null;

        if (!this.currentTrack && this.queue.length > 0) {
            this.currentTrack = this.queue.shift();
        }

        let resumeMs = Math.max(0, Number(state.playbackPositionMs) || 0);
        const trackDurationMs = this.currentTrack?.duration ? Number(this.currentTrack.duration) * 1000 : null;
        if (trackDurationMs && resumeMs > Math.max(trackDurationMs - 2000, 0)) resumeMs = 0;

        this.currentTrackStartOffsetMs = Math.max(Number(state.currentTrackStartOffsetMs) || 0, 0);
        this.lastPlaybackPosition = resumeMs;
        this.paused = false;

        if (!this.player) {
            await this.connect();
        }

        if (!this.currentTrack) {
            await PlayerStateManager.removeState(this.guild.id);
            return;
        }

        await this.play(null, resumeMs);

        const embedManager = global.clients?.musicEmbedManager;
        if (embedManager && this.textChannel) {
            try {
                const embed = await embedManager.createNowPlayingEmbed(this, this.currentTrack, this.guild.id);
                const buttons = await embedManager.createControlButtons(this);
                let msg = null;
                if (state.nowPlayingMessageId) {
                    msg = await this.textChannel.messages.fetch(state.nowPlayingMessageId).catch(() => null);
                }
                if (msg) {
                    await msg.edit({ embeds: [embed], components: buttons });
                    this.nowPlayingMessage = msg;
                } else {
                    this.nowPlayingMessage = await this.textChannel.send({ embeds: [embed], components: buttons });
                }
            } catch (error) {
                console.error('❌ Failed to rebuild now playing embed:', error?.message);
            }
        }

        this.scheduleStatePersist('restored', 1000);
    }

    async persistState(reason = 'manual', immediate = false) {
        try {
            if (!this.guild?.id) return;
            if (immediate && this.pendingStateSave) {
                clearTimeout(this.pendingStateSave);
                this.pendingStateSave = null;
            }
            if (!this.currentTrack && this.queue.length === 0) {
                await PlayerStateManager.removeState(this.guild.id);
                return;
            }
            const state = this.serializeState();
            if (!state) {
                await PlayerStateManager.removeState(this.guild.id);
                return;
            }
            state.reason = reason;
            await PlayerStateManager.saveState(this.guild.id, state);
        } catch (error) {
            console.error(`❌ Failed to persist state:`, error.message);
        }
    }

    startStateSync() {
        if (this.stateSyncInterval) return;
        this.stateSyncInterval = setInterval(() => {
            if (!this.guild?.id) return;
            if (!this.currentTrack && this.queue.length === 0) return;
            this.persistState('interval').catch(() => {});
        }, this.stateSyncIntervalMs);
    }

    stopStateSync() {
        if (this.stateSyncInterval) {
            clearInterval(this.stateSyncInterval);
            this.stateSyncInterval = null;
        }
        this.cancelStateSave();
    }

    cancelStateSave() {
        if (this.stateSaveTimeout) {
            clearTimeout(this.stateSaveTimeout);
            this.stateSaveTimeout = null;
        }
    }

    scheduleStatePersist(reason = 'update', delay = 200) {
        this.cancelStateSave();
        this.stateSaveTimeout = setTimeout(() => {
            this.stateSaveTimeout = null;
            this.persistState(reason).catch(() => {});
        }, Math.max(delay, 0));
    }

    async fetchAndStartLyrics() {
        try {
            if (!this.currentTrack) return;
            this.currentLyrics = await LyricsManager.fetchLyrics(this.currentTrack);
            if (this.currentLyrics?.plain && global.clients?.musicEmbedManager && this.nowPlayingMessage) {
                await global.clients.musicEmbedManager.updateNowPlayingEmbed(this).catch(() => {});
            }
        } catch (error) {
            console.error('❌ Failed to fetch lyrics:', error.message);
            this.currentLyrics = null;
        }
    }

    hasLyrics() {
        return Boolean(this.currentLyrics?.plain);
    }

    formatDuration(seconds) {
        const totalSeconds = Math.floor(Number(seconds) || 0);
        const minutes = Math.floor(totalSeconds / 60);
        const remainingSeconds = totalSeconds % 60;
        return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
    }

    getStatus() {
        return {
            connected: !!this.player,
            playing: this.player && !this.paused,
            paused: this.paused,
            queue: this.queue.length,
            volume: this.volume,
            loop: this.loop,
            shuffle: this.shuffle,
            currentTrack: this.currentTrack,
            voiceChannel: this.voiceChannel?.name,
            textChannel: this.textChannel?.name,
        };
    }

    cleanup(isShutdown = false) {
        try {
            this.clearInactivityTimer(false);
            this.stopStateSync();

            if (isShutdown && this.guild?.id) {
                this.persistState('shutdown').catch(() => {});
            } else if (this.guild?.id) {
                PlayerStateManager.removeState(this.guild.id).catch(() => {});
            }

            this.queue = [];
            this.currentTrack = null;
            this.previousTracks = [];
            this.startTime = null;
            this.pausedTime = 0;
            this.nowPlayingMessage = null;
            this.requesterId = null;
            this.pauseReasons.clear();
            this.paused = false;
            this.isTransitioning = false;
            this.lastPlaybackPosition = 0;
            this.currentTrackStartOffsetMs = 0;

            this.disconnect();
        } catch (error) {
            console.error('❌ Error during cleanup:', error);
        }
    }

    destroy() {
        if (this.player) this.player.stopTrack();
        this.disconnect();
    }
}

module.exports = MusicPlayer;
