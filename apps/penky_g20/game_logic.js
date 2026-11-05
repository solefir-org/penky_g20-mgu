'use strict';

const SUIT_ORDER = ['Spades', 'Hearts', 'Clubs', 'Diamonds'];
const BOT_LEVELS = { Easy: 'Easy', Medium: 'Medium', Hard: 'Hard' };
const LATIN_FROM_CYRILLIC = {
    1025: 'Yo', 1028: 'Ye', 1030: 'I', 1031: 'Yi', 1038: 'U',
    1040: 'A', 1041: 'B', 1042: 'V', 1043: 'G', 1044: 'D', 1045: 'E', 1046: 'Zh', 1047: 'Z',
    1048: 'I', 1049: 'Y', 1050: 'K', 1051: 'L', 1052: 'M', 1053: 'N', 1054: 'O', 1055: 'P',
    1056: 'R', 1057: 'S', 1058: 'T', 1059: 'U', 1060: 'F', 1061: 'Kh', 1062: 'Ts', 1063: 'Ch',
    1064: 'Sh', 1065: 'Shch', 1066: '', 1067: 'Y', 1068: '', 1069: 'E', 1070: 'Yu', 1071: 'Ya',
    1072: 'a', 1073: 'b', 1074: 'v', 1075: 'g', 1076: 'd', 1077: 'e', 1078: 'zh', 1079: 'z',
    1080: 'i', 1081: 'y', 1082: 'k', 1083: 'l', 1084: 'm', 1085: 'n', 1086: 'o', 1087: 'p',
    1088: 'r', 1089: 's', 1090: 't', 1091: 'u', 1092: 'f', 1093: 'kh', 1094: 'ts', 1095: 'ch',
    1096: 'sh', 1097: 'shch', 1098: '', 1099: 'y', 1100: '', 1101: 'e', 1102: 'yu', 1103: 'ya',
    1105: 'yo', 1108: 'ye', 1110: 'i', 1111: 'yi', 1118: 'u', 1168: 'G', 1169: 'g',
};

function latinize(value) {
    let result = '';
    String(value == null ? '' : value).split('').forEach((character) => {
        const code = character.charCodeAt(0);
        if (Object.prototype.hasOwnProperty.call(LATIN_FROM_CYRILLIC, code)) result += LATIN_FROM_CYRILLIC[code];
        else if (code < 128) result += character;
        else if (/\s/.test(character)) result += ' ';
    });
    return result.replace(/\s+/g, ' ').trim();
}

function playerById(state, id) {
    return state && state.players ? state.players.find((p) => p.id === id) || null : null;
}

function opponentsInOrder(state) {
    if (!state || !state.players) return [];
    const index = state.players.findIndex((p) => p.id === state.myId);
    if (index < 0) return state.players.slice();
    return state.players.slice(index + 1).concat(state.players.slice(0, index));
}

function isWaitingForPenky(player, state) {
    return !!player && state.subPhase === 'Playing' && player.place == null && player.handCount === 0;
}

function mustGive(state) {
    return !!(state && state.penalty && state.penalty.waitingFor.indexOf(state.myId) >= 0);
}

function canMove(state) {
    return !!state && state.currentPlayerId === state.myId && !state.penalty;
}

function canPlaceCard(state) {
    return !!state && state.subPhase === 'Dealing' && canMove(state) && !!state.drawnCard;
}

function needsMe(state) {
    return !!state && state.phase === 'InProgress' && (mustGive(state) || canMove(state));
}

function seatNote(player, state, offlineUntil, now) {
    if (player.place != null && state.phase === 'InProgress') return player.place + ' place';
    if (offlineUntil && offlineUntil[player.id] > (now || Date.now())) return 'Offline';
    if (state.penalty && state.penalty.waitingFor.indexOf(player.id) >= 0) return 'Giving a card';
    if (state.penalty && state.penalty.violatorId === player.id) return 'Fouled';
    if (isWaitingForPenky(player, state)) return 'Waiting';
    if (player.id === state.currentPlayerId) return 'Playing';
    return player.bot ? (BOT_LEVELS[player.bot] || String(player.bot)) : '';
}

function cardsText(count) { return count === 1 ? 'card' : 'cards'; }

function penaltyStatus(state) {
    const penalty = state.penalty;
    const violator = playerById(state, penalty.violatorId);
    if (!violator) return { text: 'Dealing out foul cards', kind: 'wait' };
    const owedBy = (id) => penalty.waitingFor.filter((giver) => giver === id).length;
    if (mustGive(state)) return {
        text: 'Foul by ' + violator.nick + ': give ' + owedBy(state.myId) + ' ' + cardsText(owedBy(state.myId)), kind: 'mine',
    };
    const givers = [];
    const seen = Object.create(null);
    penalty.waitingFor.forEach((id) => {
        if (seen[id]) return;
        seen[id] = true;
        const giver = playerById(state, id);
        if (!giver) return;
        givers.push(giver.nick + (owedBy(id) > 1 ? ' x' + owedBy(id) : '') + (!giver.isOnline ? ' (offline)' : ''));
    });
    return {
        text: (violator.id === state.myId ? 'Your foul' : 'Foul by ' + violator.nick) +
            '. Waiting for cards from: ' + givers.join(', '), kind: 'wait',
    };
}

function statusInfo(state, movingTop, offlineUntil, now) {
    if (!state || state.phase !== 'InProgress') return { text: '' };
    const self = playerById(state, state.myId);
    if (!self) return { text: '' };
    if (self.place != null) return { text: 'You are out in ' + self.place + ' place. Wait for the round to end.' };
    if (state.penalty) return penaltyStatus(state);
    if (isWaitingForPenky(self, state)) return { text: 'Out of cards. You will pick up your piles when the round ends.' };
    const current = playerById(state, state.currentPlayerId);
    const until = current && offlineUntil && offlineUntil[current.id];
    if (until && until > (now || Date.now())) {
        return { text: current.nick + ' is disconnected. Waiting ' + Math.ceil((until - (now || Date.now())) / 1000) + ' sec.', kind: 'wait' };
    }
    if (!canMove(state)) return { text: state.subPhase === 'Dealing' && state.drawnCard ? current.nick + ' is drawing a card...' : 'Turn: ' + (current ? current.nick : 'opponent') };
    if (state.subPhase === 'Dealing') {
        if (state.canDraw && movingTop) return { text: 'Choose an opponent', kind: 'mine' };
        if (state.canDraw) return { text: 'Your turn: draw a card or move your top card', kind: 'mine' };
        return { text: 'Choose where to place the card', kind: 'mine' };
    }
    return { text: state.table.length ? 'Your turn: beat the top card or take the bottom card' : 'Your turn: play any card', kind: 'mine' };
}

function sortHand(hand, trumpSuit) {
    const suitValue = (suit) => suit === trumpSuit ? 10 : SUIT_ORDER.indexOf(suit);
    return (hand || []).slice().sort((a, b) => suitValue(a.suit) - suitValue(b.suit) || a.rank - b.rank);
}

function cardKey(card) {
    return card.suit + '-' + card.rank;
}

module.exports = {
    BOT_LEVELS, latinize, playerById, opponentsInOrder, isWaitingForPenky, mustGive, canMove,
    canPlaceCard, needsMe, seatNote, penaltyStatus, statusInfo, sortHand, cardKey,
};