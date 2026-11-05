'use strict';
const fs = require('fs');
const path = require('path');
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const { makeLayer } = require('./kit/record');
const parked = require('./parked');
const { LongPolling } = require('./signalr');
const L = require('./game_logic');

const W = 1600, H = 520;
const DEFAULT_SERVER_URL = 'https://penky.solefir.app/hub/game';
const RANKS = { 6: '6', 7: '7', 8: '8', 9: '9', 10: '10', 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };
const SUITS = { Hearts: 'hearts', Diamonds: 'diamonds', Clubs: 'clubs', Spades: 'spades' };
const SUIT_COLOR = { Hearts: '#df4050', Diamonds: '#df4050', Clubs: '#182622', Spades: '#182622' };
const RULES = [
    'GOAL. Get rid of every card in your hand and both Penky piles. The last player with cards loses.',
    'SETUP. 2-6 players use a 36-card deck. Rank order: 6, 7, 8, 9, 10, J, Q, K, A. Each player gets two face-down piles and one face-up card.',
    'STAGE 1: DEALING. At the start of your turn, before drawing, you must move your top card to an opponent if it fits. If it fits several opponents, choose the first in turn order. Repeat while possible.',
    'Draw a card. If it is one rank higher than an opponent\'s top card, place it on them and draw again. Suit does not matter; a six can be placed on an ace. If it fits no opponent, place it on your own pile. Continue drawing only if it is one rank higher than your top card.',
    'The suit of the deck\'s last card is trump. Spades are never trump: if the last card is a spade, use the last non-spade card before it. Whoever draws the final card plays first in Stage 2.',
    'STAGE 2: PLAY. Each player takes their pile into their hand. Any card can start an empty table. The next player beats the top card with a higher card of the same suit or a trump. A six beats an ace of its suit. Spades can only be beaten by spades.',
    'If you cannot or do not want to beat, take the lowest card from the table. The turn passes to the next player, who beats the top card. When the table is empty, any card can be played. When the number of cards on the table equals the number of players in the round, the round closes; whoever played the last card goes next.',
    'FOULS. There are no hints; players track the rules themselves. In Stage 1, fouls are counted. At the start of Stage 2, every other player gives the offender as many cards as their foul count. In Stage 2, every other player immediately gives one card for an illegal move.',
    'After a foul, you may give any card. The lowest non-trump cards are highlighted as suggestions only. Given cards are face-down; only the giver and recipient know them.',
    'PENKY PILES AND ENDING. If your hand runs out mid-round, wait until the round ends, then take your piles. If you close the round with the last card, take your piles immediately. If you have no cards or piles left, you are out.',
    'BOTS. The host can add bots to empty seats. Easy often plays randomly; Medium is more careful; Hard remembers exposed cards and avoids fouls.',
];

function readProfile(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return {}; }
}

function suitMark(cv, suit, x, y, size, color) {
    const r = size / 4;
    if (suit === 'Diamonds') cv.quad([[x, y - size / 2], [x + r, y], [x, y + size / 2], [x - r, y]], color);
    else if (suit === 'Hearts') {
        cv.circle(x - r / 2, y - r / 2, r / 2, color);
        cv.circle(x + r / 2, y - r / 2, r / 2, color);
        cv.quad([[x - r, y - r / 4], [x + r, y - r / 4], [x, y + size / 2], [x, y + size / 2]], color);
    } else if (suit === 'Clubs') {
        cv.circle(x, y - r / 2, r / 2, color);
        cv.circle(x - r / 2, y + r / 4, r / 2, color);
        cv.circle(x + r / 2, y + r / 4, r / 2, color);
        cv.fillRect(x - 2, y + r / 4, 4, size / 3, color);
    } else {
        cv.quad([[x, y - size / 2], [x + r, y + r / 3], [x, y + r / 8], [x - r, y + r / 3]], color);
        cv.quad([[x - r, y + r / 3], [x + r, y + r / 3], [x, y - size / 8], [x, y + size / 2]], color);
        cv.fillRect(x - 2, y + r / 3, 4, size / 6, color);
    }
}

function drawCard(cv, x, y, w, h, card, opts) {
    const o = opts || {};
    if (!card) {
        cv.roundRect(x, y, w, h, 10, '#174640');
        cv.strokeRoundRect(x, y, w, h, 10, 2, '#60b69f');
        cv.roundRect(x + 7, y + 7, w - 14, h - 14, 7, '#215d52');
        cv.strokeRoundRect(x + 12, y + 12, w - 24, h - 24, 5, 1, '#81cbb1');
        return;
    }
    cv.roundRect(x + 2, y + 3, w, h, 9, '#00000066');
    cv.roundRect(x, y, w, h, 9, o.selected ? '#fff1cb' : '#f5f2e8');
    cv.strokeRoundRect(x, y, w, h, 9, o.selected ? 4 : 1, o.selected ? '#f0b638' : '#c9c6bb');
    const ink = SUIT_COLOR[card.suit] || '#182622';
    const rank = RANKS[card.rank] || String(card.rank);
    cv.text(rank, x + 12, y + 23, 18, ink, { font: 'bold' });
    suitMark(cv, card.suit, x + 13, y + 34, 12, ink);
    suitMark(cv, card.suit, x + w / 2, y + h / 2 + 5, 36, ink);
    cv.text(rank, x + w - 11, y + h - 10, 18, ink, { font: 'bold', align: 'right' });
}

mgu.run({
    async start(ctx) {
        const { ui, settings, log } = ctx;
        if (!settings.get('serverUrl')) settings.set('serverUrl', DEFAULT_SERVER_URL);
        const profileFile = path.join(ctx.dataDir, 'penky.json');
        const profile = readProfile(profileFile);
        let nick = profile.nick || '';
        let roomCode = profile.lastCode || '';
        let session = profile.session || null;
        let serverUrl = settings.get('serverUrl') || DEFAULT_SERVER_URL;
        let rooms = [];
        let state = null;
        let client = null;
        let connecting = false;
        let message = 'Enter a server address to connect';
        let movingTop = false;
        let selected = '';
        let offlineUntil = {};
        let view = 'lobby';
        let keyboard = null;
        let documentScroll = 0;
        let openSheet = false;
        let busy = false;
        const speed = parked.watch(ctx, log);
        const board = makeLayer(W, H, (r) => {
            r.clear('#10231f');
            r.roundRect(24, 42, W - 48, H - 48, 22, '#17342e');
            r.strokeRoundRect(24, 42, W - 48, H - 48, 22, 2, '#315a4e');
            r.roundRect(40, 58, W - 80, H - 80, 16, '#1d4037');
            r.strokeRoundRect(40, 58, W - 80, H - 80, 16, 1, '#426b5b');
        });

        function saveProfile() {
            const data = { nick, lastCode: roomCode, session, serverUrl };
            try { fs.writeFileSync(profileFile, JSON.stringify(data)); } catch (e) { log.warn('profile save: ' + e); }
        }

        function moving() {
            return settings.get('parkedOnly') !== false && speed.moving();
        }

        function safeRun(fn) {
            return function () {
                if (moving()) { message = 'Game paused: stop the vehicle to continue'; return; }
                return fn.apply(null, arguments);
            };
        }

        function setMessage(text) {
            message = text || '';
            if (view === 'lobby' || view === 'room' || view === 'game') draw();
        }

        function connectLoop() {
            if (connecting || !serverUrl) return;
            connecting = true;
            (async () => {
                while (serverUrl) {
                    client = new LongPolling(serverUrl, ctx.dataDir);
                    client.on('State', (next) => {
                        if (state && state.room.code === next.room.code && next.version < state.version) return;
                        state = next;
                        if (next.players) {
                            offlineUntil = {};
                            next.players.forEach((p) => { if (p.offlineSecondsLeft != null) offlineUntil[p.id] = Date.now() + p.offlineSecondsLeft * 1000; });
                        }
                        if (next.phase === 'Finished') view = 'result';
                        else if (next.phase === 'WaitingForPlayers') view = 'room';
                        else view = 'game';
                        if (!next.canDraw) movingTop = false;
                        if (!L.needsMe(next) || !next.hand.some((c) => L.cardKey(c) === selected)) selected = '';
                        draw();
                    });
                    client.on('Rooms', (next) => { rooms = next || []; if (!state) draw(); });
                    client.on('Kicked', (reason) => {
                        session = null; state = null; movingTop = false; view = 'lobby';
                        saveProfile(); setMessage(reason || 'You were removed from the room');
                        client.invoke('SubscribeLobby').then((next) => { rooms = next || []; draw(); }).catch(() => {});
                    });
                    client.on('disconnected', (error) => { message = 'Disconnected: ' + error.message; draw(); });
                    client.on('connected', () => { afterConnect(); });
                    try { await client.connect(); } catch (error) { message = error.message || 'No connection'; draw(); }
                    if (!serverUrl) break;
                    await new Promise((resolve) => setTimeout(resolve, 2000));
                }
                connecting = false;
            })().catch((error) => { connecting = false; log.error('connection loop', error); });
        }

        async function afterConnect() {
            try {
                if (session) {
                    const result = await client.invoke('Rejoin', session);
                    if (result && result.error) { session = null; state = null; saveProfile(); }
                    else return;
                }
                state = null;
                rooms = await client.invoke('SubscribeLobby');
                view = 'lobby'; message = 'Connected'; draw();
            } catch (error) { message = 'Rejoin failed: ' + error.message; draw(); }
        }

        async function invoke(method) {
            const args = Array.prototype.slice.call(arguments, 1);
            if (!client || !client.connected || busy) { setMessage('Not connected to the server'); return null; }
            if (moving()) { setMessage('Game paused: stop the vehicle to continue'); return null; }
            busy = true;
            try {
                const result = await client.invoke.apply(client, [method].concat(args));
                if (typeof result === 'string' && result) setMessage(result);
                return result;
            } catch (error) { setMessage('Connection failed: ' + error.message); return null; }
            finally { busy = false; }
        }

        function openKeyboard(kind, value, done) {
            keyboard = { kind, value: value || '', done };
            view = 'keyboard';
            draw();
        }

        function finishKeyboard(ok) {
            const k = keyboard;
            keyboard = null;
            view = state ? (state.phase === 'WaitingForPlayers' ? 'room' : 'game') : 'lobby';
            if (ok && k && k.done) k.done(k.value.trim());
            draw();
        }

        function chooseNick() {
            openKeyboard('nick', nick, (value) => {
                if (!value) return setMessage('Nickname cannot be empty');
                nick = value.slice(0, 24); saveProfile(); draw();
            });
        }

        function chooseServer() {
            openKeyboard('url', serverUrl, (value) => {
                if (!/^https?:\/\//i.test(value) || value.indexOf('<') >= 0 || value.indexOf('>') >= 0) {
                    setMessage('Enter an http:// or https:// URL ending in /hub/game'); return;
                }
                serverUrl = value.replace(/\/$/, '');
                settings.set('serverUrl', serverUrl);
                session = null; state = null; saveProfile();
                if (client) client.close();
                rooms = []; view = 'lobby'; message = 'Connecting to ' + serverUrl; draw(); connectLoop();
            });
        }

        function makeSheet(title, getLines) {
            let scroll = 0;
            const sheet = {
                title,
                draw(r, t) {
                    r.clear(t.bg);
                    r.text(title, 44, 94, 34, t.text, { font: 'bold' });
                    const lines = getLines();
                    const rowH = 43, max = Math.max(0, lines.length * rowH - 390);
                    scroll = Math.max(0, Math.min(scroll, max));
                    r.clip(30, 112, W - 60, 370);
                    lines.forEach((line, i) => {
                        const y = 112 + i * rowH - scroll;
                        if (y > 100 && y < 510) r.text(L.latinize(line), 48, y + 27, 24, t.text);
                    });
                    r.noclip();
                    const x = W - 190;
                    r.roundRect(x, 58, 140, 50, 9, '#cb414e');
                    r.strokeRoundRect(x, 58, 140, 50, 9, 1, '#ee8390');
                    r.text('Close', x + 70, 91, 24, '#ffffff', { align: 'center', font: 'bold' });
                    return [{ x: x - 8, y: 52, w: 156, h: 62, act: () => 'close' }];
                },
                move(d) { scroll += d * 56; },
                scroll(dy) { scroll += dy; },
                release() {},
                press() { return 'close'; },
                back() { return 'close'; },
            };
            openSheet = ctx.sheet(sheet);
            return openSheet;
        }

        function openRules() {
            if (!makeSheet('Penky Rules', () => RULES)) { view = 'rules'; documentScroll = 0; draw(); }
        }

        function openLog() {
            if (!makeSheet('Move Log', () => state && state.log ? state.log.slice().reverse() : [])) { view = 'log'; documentScroll = 0; draw(); }
        }

        function widthOf(cv, text, size, font) {
            return cv.textWidth(text, size, { font: font || 'label' });
        }

        function fit(cv, text, max, size, font) {
            const original = L.latinize(text || '');
            let out = original;
            while (out.length > 1 && widthOf(cv, out, size, font) > max) out = out.slice(0, -1);
            return out.length < original.length ? out.slice(0, -1) + '...' : out;
        }

        function button(cv, x, y, w, h, text, run, key, primary) {
            const bg = primary ? '#cb414e' : '#2c594d';
            cv.roundRect(x, y, w, h, 9, bg);
            cv.strokeRoundRect(x, y, w, h, 9, 1, primary ? '#ee8390' : '#5a8475');
            cv.text(fit(cv, text, w - 16, 23, 'bold'), x + w / 2, y + h / 2 + 8, 23, '#ffffff', { align: 'center', font: 'bold' });
            cv.target(x, y, w, h, safeRun(run), key || text);
        }

        function targetText(cv, x, y, w, h, text, run, key) {
            cv.text(fit(cv, text, w - 12, 24), x + w / 2, y + h / 2 + 8, 24, '#eff5ec', { align: 'center' });
            cv.target(x, y, w, h, safeRun(run), key);
        }

        function drawTop(cv, t) {
            G.frame(cv, t, ['Penky'], 0, []);
            targetText(cv, 1300, 47, 105, 38, 'Rules', openRules, 'open-rules');
            targetText(cv, 1410, 47, 90, 38, 'Log', openLog, 'open-log');
            targetText(cv, 1500, 47, 70, 38, 'Menu', () => { view = 'menu'; draw(); }, 'open-menu');
        }

        function drawLobby(cv, t) {
            cv.roundRect(52, 94, 720, 340, 14, '#17342e');
            cv.roundRect(800, 94, 748, 340, 14, '#17342e');
            cv.text('Lobby', 78, 132, 30, t.text, { font: 'bold' });
            cv.text('Nickname', 80, 180, 22, t.dim);
            button(cv, 78, 192, 290, 54, nick || 'Tap to enter', chooseNick, 'nick');
            cv.text('Room code', 390, 180, 22, t.dim);
            button(cv, 390, 192, 145, 54, roomCode || '----', () => openKeyboard('code', roomCode, (v) => { roomCode = v.slice(0, 4); saveProfile(); draw(); }), 'room-code');
            button(cv, 548, 192, 184, 54, 'Join', () => joinRoom(roomCode), 'join-room', true);
            cv.text('Server URL', 80, 286, 22, t.dim);
            button(cv, 78, 298, 654, 54, serverUrl || 'Not set - enter a server address', chooseServer, 'server-url');
            cv.text(fit(cv, message, 420, 21), 338, 396, 21, t.warn || '#f0bd63');
            cv.text('Open rooms', 826, 132, 30, t.text, { font: 'bold' });
            if (!rooms.length) cv.text(client && client.connected ? 'No open rooms yet' : 'Connect to a server', 830, 190, 24, t.dim);
            rooms.slice(0, 5).forEach((room, i) => {
                const y = 150 + i * 54;
                cv.roundRect(822, y, 700, 46, 7, '#21453b');
                cv.text(fit(cv, room.name || 'Room ' + room.code, 300, 22), 842, y + 29, 22, t.text);
                cv.text(room.playerCount + '/' + room.maxPlayers, 1196, y + 29, 21, t.dim);
                cv.text(room.code, 1285, y + 29, 21, t.text, { font: 'num' });
                button(cv, 1380, y + 5, 120, 36, 'Join', () => { roomCode = room.code; joinRoom(room.code); }, 'room-' + room.code, true);
            });
            button(cv, 78, 370, 240, 50, 'Create room', createRoom, 'create-room', true);
        }

        function createRoom() {
            if (!nick.trim()) return chooseNick();
            return invoke('CreateRoom', { nick, name: null, maxPlayers: 6, isPrivate: false }).then(adoptSession);
        }

        function adoptSession(result) {
            if (!result || result.error) { if (result && result.error) setMessage(result.error); return; }
            session = { code: result.code, token: result.token };
            roomCode = result.code || roomCode;
            saveProfile();
        }

        function joinRoom(code) {
            if (!nick.trim()) return chooseNick();
            if (!/^\d{4}$/.test(code || '')) return setMessage('Room code must be four digits');
            return invoke('JoinRoom', { nick, code }).then(adoptSession);
        }

        function drawRoom(cv, t) {
            const s = state;
            cv.text('Room ' + s.room.code, 72, 124, 32, t.text, { font: 'bold' });
            cv.text(s.room.name || 'Waiting for players', 72, 158, 22, t.dim);
            const max = Math.min(6, s.players.length);
            s.players.forEach((p, i) => {
                const x = 70 + (i % 3) * 500, y = 186 + Math.floor(i / 3) * 102;
                cv.roundRect(x, y, 460, 82, 10, '#21453b');
                cv.text(fit(cv, p.nick, 320, 27, 'bold'), x + 20, y + 37, 27, p.id === s.hostId ? '#f0bd63' : t.text, { font: 'bold' });
                cv.text(p.bot ? L.BOT_LEVELS[p.bot] : (!p.isOnline ? 'Offline' : (p.id === s.hostId ? 'Host' : 'Player')), x + 20, y + 66, 20, t.dim);
                if (s.hostId === s.myId && p.id !== s.myId) button(cv, x + 350, y + 20, 92, 42, 'Remove', () => invoke('Kick', p.id), 'kick-' + p.id);
            });
            const host = s.hostId === s.myId;
            if (host) {
                button(cv, 70, 410, 170, 48, 'Easy bot', () => invoke('AddBot', 'Easy'), 'bot-easy');
                button(cv, 252, 410, 180, 48, 'Medium bot', () => invoke('AddBot', 'Medium'), 'bot-medium');
                button(cv, 444, 410, 180, 48, 'Hard bot', () => invoke('AddBot', 'Hard'), 'bot-hard');
                button(cv, 1280, 410, 250, 48, 'Start game', () => invoke('StartGame'), 'start-game', true);
            }
            button(cv, 70, 466, 140, 38, 'Leave', leaveRoom, 'leave-room');
            cv.text(message, 240, 492, 20, t.dim);
        }

        function drawSeat(cv, t, p, x, y, w, pickable) {
            const active = p.id === state.currentPlayerId;
            cv.roundRect(x, y, w, 82, 9, active ? '#345c49' : '#23463c');
            cv.strokeRoundRect(x, y, w, 82, 9, active ? 2 : 1, active ? '#edbd5b' : '#3a6556');
            if (p.handCount > 0) drawCard(cv, x + 10, y + 10, 43, 61, p.topCard, {});
            else cv.text('-', x + 30, y + 50, 24, t.dim, { align: 'center' });
            cv.text(String(p.handCount), x + 63, y + 34, 18, t.text, { font: 'num' });
            cv.text(fit(cv, p.nick, w - 92, 21, 'bold'), x + 92, y + 30, 21, t.text, { font: 'bold' });
            cv.text(fit(cv, L.seatNote(p, state, offlineUntil), w - 92, 18), x + 92, y + 57, 18, t.dim);
            if (p.fouls) cv.text('!' + p.fouls, x + w - 26, y + 26, 18, '#ee5966', { font: 'bold', align: 'center' });
            if (pickable) cv.target(x, y, w, 82, safeRun(() => selectSeat(p)), 'seat-' + p.id);
        }

        function selectSeat(player) {
            if (movingTop) { movingTop = false; return invoke('MoveTop', player.id); }
            if (state.subPhase === 'Dealing' && L.canPlaceCard(state)) return invoke('Give', player.id);
        }

        function drawSmallAction(cv, x, y, label, action, key, primary) {
            button(cv, x, y, 154, 42, label, action, key, primary);
        }

        function playCard(card) {
            const method = L.mustGive(state) ? 'GivePenalty' : 'Put';
            selected = '';
            invoke(method, card.suit, card.rank);
        }

        function drawGame(cv, t) {
            const s = state;
            const others = L.opponentsInOrder(s);
            const pickable = L.canPlaceCard(s) || (s.canDraw && movingTop);
            const seatGap = 12;
            const seatW = others.length ? Math.min(280, Math.floor((W - 100 - seatGap * (others.length - 1)) / others.length)) : 0;
            const seatsW = others.length * seatW + Math.max(0, others.length - 1) * seatGap;
            const seatsX = (W - seatsW) / 2;
            others.forEach((p, i) => drawSeat(cv, t, p, seatsX + i * (seatW + seatGap), 70, seatW, pickable));
            cv.roundRect(40, 150, W - 80, 182, 14, '#21483d');
            cv.strokeRoundRect(40, 150, W - 80, 182, 14, 1, '#3a6655');
            const status = L.latinize(L.statusInfo(s, movingTop, offlineUntil).text);
            cv.text(fit(cv, status, W - 180, 22), W / 2, 180, 22, t.text, { align: 'center' });
            if (s.subPhase === 'Dealing') {
                const cardW = 84, cardH = 118, cardY = 204, center = W / 2;
                const deckX = center - 174, drawnX = center - 42, pileX = center + 90;
                cv.text('DECK', deckX + cardW / 2, 198, 15, t.dim, { align: 'center', font: 'bold' });
                if (s.deckCount > 0) drawCard(cv, deckX, cardY, cardW, cardH, null, {});
                cv.text(String(s.deckCount), deckX + cardW / 2, 326, 16, t.text, { align: 'center', font: 'num' });
                if (s.canDraw) cv.target(deckX - 8, cardY - 5, cardW + 16, cardH + 12, safeRun(() => invoke('Draw')), 'draw');
                if (s.drawnCard) {
                    cv.text('DRAWN', drawnX + cardW / 2, 198, 15, t.dim, { align: 'center', font: 'bold' });
                    drawCard(cv, drawnX, cardY, cardW, cardH, s.drawnCard, {});
                }
                const self = L.playerById(s, s.myId);
                if (self && self.topCard) {
                    cv.text(movingTop ? 'TARGET' : 'YOUR PILE', pileX + cardW / 2, 198, 15, t.dim, { align: 'center', font: 'bold' });
                    drawCard(cv, pileX, cardY, cardW, cardH, self.topCard, {});
                    if (s.canDraw || L.canPlaceCard(s)) cv.target(pileX - 8, cardY - 5, cardW + 16, cardH + 12, safeRun(() => {
                        if (L.canPlaceCard(s)) return invoke('Give', s.myId);
                        movingTop = !movingTop; draw();
                    }), 'self-pile');
                }
                if (s.trump) {
                    const trumpX = center + 222;
                    cv.text('TRUMP', trumpX + 24, 198, 14, t.dim, { align: 'center', font: 'bold' });
                    drawCard(cv, trumpX, cardY + 25, 48, 68, s.trump, {});
                }
            } else {
                if (s.trump) {
                    cv.text('TRUMP', 94, 210, 14, t.dim, { align: 'center', font: 'bold' });
                    suitMark(cv, s.trump.suit, 94, 253, 30, SUIT_COLOR[s.trump.suit]);
                }
                const stack = s.table || [];
                const cardW = 74, cardH = 102, step = Math.min(58, Math.floor(700 / Math.max(1, stack.length)));
                const startX = W / 2 - (cardW + step * Math.max(0, stack.length - 1)) / 2;
                stack.forEach((card, i) => drawCard(cv, startX + i * step, 203, cardW, cardH, card, {}));
                cv.text('TABLE ' + stack.length + '/' + s.roundSize, W / 2, 319, 16, t.dim, { align: 'center', font: 'bold' });
                if (s.canTake && stack.length) drawSmallAction(cv, W - 220, 246, 'Take bottom', () => invoke('Take'), 'take', true);
                if (s.discardCount) cv.text('Discard ' + s.discardCount, 180, 307, 15, t.dim, { align: 'center' });
            }
            const self = L.playerById(s, s.myId);
            cv.roundRect(40, 344, W - 80, 162, 12, '#17382f');
                const hand = s.subPhase === 'Playing' ? L.sortHand(s.hand || [], s.trump && s.trump.suit) : [];
                if (hand.length) {
                    const cards = hand;
                const cardW = cards.length >= 16 ? 78 : cards.length >= 12 ? 100 : 132;
                const cardH = 132;
                const step = cards.length > 1 ? Math.min(cardW, (W - cardW - 80) / (cards.length - 1)) : 0;
                const startX = (W - (cardW + step * (cards.length - 1))) / 2;
                cv.text('YOUR HAND - ' + cards.length, 58, 364, 14, t.dim, { font: 'bold' });
                cards.forEach((card, i) => {
                    const x = startX + step * i, key = L.cardKey(card);
                    drawCard(cv, x, 369, cardW, cardH, card, { selected: selected === key });
                    if (card.suggested) cv.roundRect(x + 5, 365, cardW - 10, 4, 2, '#f0bd63');
                    cv.target(x, 368, i === cards.length - 1 ? cardW : step, 136, safeRun(() => {
                        if (settings.get('confirmMoves') && selected !== key) { selected = key; draw(); return; }
                        playCard(card);
                    }), 'card-' + key);
                });
            } else if (self) {
                cv.text('YOUR CARDS', W / 2, 402, 16, t.dim, { align: 'center', font: 'bold' });
                cv.text('In hand: ' + self.handCount + '    Penky piles: ' + self.penkyCount, W / 2, 438, 24, t.text, { align: 'center' });
            }
        }

        function drawMenu(cv, t) {
            cv.roundRect(360, 92, 880, 350, 16, '#17342e');
            cv.text('Game menu', 410, 145, 34, t.text, { font: 'bold' });
            button(cv, 410, 175, 340, 58, 'Move log', openLog, 'menu-log');
            button(cv, 770, 175, 340, 58, 'Game rules', openRules, 'menu-rules');
            button(cv, 410, 250, 340, 58, 'Set server URL', chooseServer, 'menu-server');
            button(cv, 770, 250, 340, 58, 'Change nickname', chooseNick, 'menu-nick');
            button(cv, 410, 325, 340, 58, 'Back', () => { view = state ? 'game' : 'lobby'; draw(); }, 'menu-back');
            if (state) button(cv, 770, 325, 340, 58, 'Leave room', leaveRoom, 'menu-leave', true);
        }

        function wrap(cv, text, x, y, width, size, color) {
            const words = L.latinize(text).split(' ');
            let line = '', yy = y;
            words.forEach((word) => {
                const next = line ? line + ' ' + word : word;
                if (line && widthOf(cv, next, size) > width) { cv.text(line, x, yy, size, color); yy += size + 8; line = word; }
                else line = next;
            });
            if (line) cv.text(line, x, yy, size, color);
            return yy + size + 8;
        }

        function drawDocument(cv, t, lines, title) {
            cv.text(title, 60, 112, 30, t.text, { font: 'bold' });
            let y = 150 - documentScroll;
            lines.forEach((line) => { y = wrap(cv, line, 64, y, 1460, 22, t.text) + 10; });
            cv.target(45, 445, 200, 55, safeRun(() => { view = state ? 'game' : 'lobby'; draw(); }), 'document-back');
            cv.text('Back', 145, 480, 23, t.text, { align: 'center' });
            cv.scroll = { y: 145, bar: { x: 1550, y: 150, w: 5, h: 330 } };
        }

        function drawKeyboard(cv, t) {
            const k = keyboard;
            const caption = k.kind === 'nick' ? 'Nickname' : k.kind === 'code' ? 'Room code' : 'Server URL';
            cv.roundRect(70, 92, W - 140, 370, 15, '#17342e');
            cv.text(caption, 100, 134, 30, t.text, { font: 'bold' });
            cv.roundRect(98, 151, W - 196, 50, 7, '#0f2924');
            cv.text(fit(cv, k.value || ' ', W - 230, 25), 116, 184, 25, t.text);
            const append = (value) => { k.value = (k.value + value).slice(0, k.kind === 'code' ? 4 : k.kind === 'nick' ? 24 : 180); draw(); };
            const del = () => { k.value = k.value.slice(0, -1); draw(); };
            const keys = k.kind === 'code'
                ? ['1','2','3','4','5','6','7','8','9','0']
                : k.kind === 'nick'
                    ? ['q','w','e','r','t','y','u','i','o','p','a','s','d','f','g','h','j','k','l','z','x','c','v','b','n','m',"'",' ']
                    : ['a','b','c','d','e','f','g','h','i','j','k','l','m','n','o','p','q','r','s','t','u','v','w','x','y','z','0','1','2','3','4','5','6','7','8','9','.',':','/','-','_'];
            const columns = k.kind === 'code' ? 5 : 10;
            const kw = k.kind === 'code' ? 110 : 132, kh = 44, gap = 9;
            const totalW = columns * kw + (columns - 1) * gap;
            const x0 = (W - totalW) / 2;
            keys.forEach((value, i) => {
                const col = i % columns, row = Math.floor(i / columns), x = x0 + col * (kw + gap), y = 214 + row * (kh + 7);
                if (y + kh > 424) return;
                button(cv, x, y, kw, kh, value === ' ' ? 'SPACE' : value, () => append(value), 'key-' + i);
            });
            button(cv, 98, 418, 150, 42, 'Delete', del, 'key-delete');
            button(cv, 265, 418, 150, 42, 'Clear', () => { k.value = ''; draw(); }, 'key-clear');
            button(cv, W - 428, 418, 150, 42, 'Cancel', () => finishKeyboard(false), 'key-cancel');
            button(cv, W - 258, 418, 160, 42, 'Done', () => finishKeyboard(true), 'key-done', true);
        }

        function leaveRoom() {
            const c = client;
            session = null; state = null; movingTop = false; selected = ''; view = 'lobby'; saveProfile(); draw();
            if (!c || !c.connected) return null;
            return c.invoke('LeaveRoom').then(() => c.invoke('SubscribeLobby')).then((next) => { rooms = next || []; draw(); }).catch(() => {});
        }

        function draw() {
            const t = ctx.theme(), cv = ctx.canvas(W, H).clear(t.bg);
            cv.blit(board, 0, 0);
            drawTop(cv, t);
            if (view === 'keyboard') drawKeyboard(cv, t);
            else if (view === 'menu') drawMenu(cv, t);
            else if (view === 'rules') drawDocument(cv, t, RULES, 'Penky Rules');
            else if (view === 'log') drawDocument(cv, t, state && state.log ? state.log.slice().reverse() : [], 'Move Log');
            else if (!state) drawLobby(cv, t);
            else if (view === 'room' || state.phase === 'WaitingForPlayers') drawRoom(cv, t);
            else if (state.phase === 'Finished') drawResult(cv, t);
            else drawGame(cv, t);
            if (moving() && view !== 'keyboard') {
                cv.fillRect(0, 0, W, H, '#061310cc');
                cv.roundRect(300, 194, 1000, 128, 16, '#172f29');
                cv.text('GAME PAUSED', W / 2, 244, 36, '#f0bd63', { align: 'center', font: 'bold' });
                cv.text('Vehicle is moving - resume when stopped', W / 2, 282, 24, '#ffffff', { align: 'center' });
            }
            return ui.image('MAIN_GFX', cv);
        }

        function drawResult(cv, t) {
            const s = state;
            const loser = L.playerById(s, s.loserId);
            const title = !s.loserId ? 'Game ended' : s.loserId === s.myId ? 'You are the last with cards' : (loser ? loser.nick : 'Player') + ' is the last with cards';
            cv.roundRect(230, 110, 1140, 320, 16, '#17342e');
            cv.text(fit(cv, title, 1050, 38, 'bold'), W / 2, 174, 38, s.loserId === s.myId ? '#ee5966' : t.text, { align: 'center', font: 'bold' });
            const ranked = s.players.slice().sort((a, b) => (a.place || 99) - (b.place || 99));
            ranked.forEach((p, i) => cv.text((p.place || '-') + '.  ' + fit(cv, p.nick, 250, 23) + (p.id === s.myId ? ' (you)' : ''), 490 + (i % 2) * 350, 220 + Math.floor(i / 2) * 46, 23, t.text));
            if (s.hostId === s.myId) button(cv, 410, 380, 250, 54, 'Play again', () => invoke('StartGame'), 'restart', true);
            button(cv, 700, 380, 250, 54, 'Leave room', leaveRoom, 'result-leave');
        }

        settings.onChange((key) => {
            if (key === 'serverUrl') serverUrl = settings.get('serverUrl') || '';
            draw();
        });

        ctx.onScroll((dy) => {
            if (view !== 'rules' && view !== 'log') return false;
            documentScroll = Math.max(0, documentScroll + dy);
            draw();
            return true;
        });

        ctx.loop('MAIN', 5, draw);
        draw();
        if (serverUrl) connectLoop();
    },
});
