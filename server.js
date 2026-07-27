const http = require("http");
const { randomUUID } = require("crypto");
const { WebSocketServer, WebSocket } = require("ws");

const port = Number(process.env.PORT) || 8080;
const players = new Map();
const challenges = new Map();
const matches = new Map();

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, players: players.size, matches: matches.size }));
    return;
  }
  res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
  res.end("Nybrisk PvP relay is online.");
});

const wss = new WebSocketServer({ server, maxPayload: 256 * 1024 });

function send(ws, message) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}

function publicPlayer(entry) {
  return {
    playerId: entry.playerId,
    nickname: entry.nickname,
    tier: entry.tier,
    wins: entry.wins,
    losses: entry.losses,
    status: entry.matchId ? "in_match" : "available"
  };
}

function broadcast(message, except = null) {
  for (const entry of players.values()) {
    if (entry.ws !== except) send(entry.ws, message);
  }
}

function broadcastRoster() {
  broadcast({
    type: "roster",
    players: [...players.values()].map(publicPlayer)
  });
}

function cleanText(value, fallback, max = 40) {
  const text = String(value || "").trim().replace(/[\u0000-\u001f]/g, "");
  return (text || fallback).slice(0, max);
}

function getPlayer(playerId) {
  return players.get(String(playerId || ""));
}

function fail(ws, code, message) {
  send(ws, { type: "error", code, message });
}

function removeChallengesFor(playerId) {
  for (const [challengeId, challenge] of challenges) {
    if (challenge.from === playerId || challenge.to === playerId) {
      const otherId = challenge.from === playerId ? challenge.to : challenge.from;
      send(getPlayer(otherId)?.ws, { type: "challengeCancelled", challengeId, playerId });
      challenges.delete(challengeId);
    }
  }
}

function leaveMatch(playerId, reason = "left") {
  const player = getPlayer(playerId);
  const matchId = player?.matchId;
  if (!matchId) return;
  const match = matches.get(matchId);
  if (match) {
    const opponentId = match.players.find(id => id !== playerId);
    const opponent = getPlayer(opponentId);
    if (opponent) {
      opponent.matchId = null;
      send(opponent.ws, { type: "opponentLeft", matchId, playerId, reason });
    }
    matches.delete(matchId);
  }
  player.matchId = null;
}

wss.on("connection", ws => {
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });

  ws.on("message", raw => {
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch {
      fail(ws, "BAD_JSON", "Message must be valid JSON.");
      return;
    }

    if (data.type === "join") {
      const playerId = cleanText(data.playerId, "", 128);
      if (!playerId) return ws.close(1008, "Missing player ID");

      const previous = getPlayer(playerId);
      if (previous && previous.ws !== ws) previous.ws.close(4001, "Signed in elsewhere");

      ws.playerId = playerId;
      players.set(playerId, {
        ws,
        playerId,
        nickname: cleanText(data.nickname, "Sagemon"),
        tier: cleanText(data.tier, "Unranked", 20),
        wins: Math.max(0, Number(data.wins) || 0),
        losses: Math.max(0, Number(data.losses) || 0),
        matchId: null
      });
      send(ws, {
        type: "joined",
        playerId,
        players: [...players.values()].filter(entry => entry.playerId !== playerId).map(publicPlayer)
      });
      broadcastRoster();
      return;
    }

    const player = getPlayer(ws.playerId);
    if (!player) return fail(ws, "NOT_JOINED", "Join before sending game messages.");

    if (data.type === "profile") {
      player.nickname = cleanText(data.nickname, player.nickname);
      player.tier = cleanText(data.tier, player.tier, 20);
      player.wins = Math.max(0, Number(data.wins) || 0);
      player.losses = Math.max(0, Number(data.losses) || 0);
      broadcastRoster();
      return;
    }

    if (data.type === "challenge") {
      const target = getPlayer(data.targetId);
      if (!target || target.playerId === player.playerId) return fail(ws, "PLAYER_UNAVAILABLE", "That player is no longer available.");
      if (player.matchId || target.matchId) return fail(ws, "PLAYER_BUSY", "One of the players is already in a match.");
      const duplicate = [...challenges.values()].some(challenge =>
        (challenge.from === player.playerId && challenge.to === target.playerId) ||
        (challenge.from === target.playerId && challenge.to === player.playerId)
      );
      if (duplicate) return fail(ws, "CHALLENGE_EXISTS", "A challenge is already pending.");

      const challengeId = randomUUID();
      const challenge = { challengeId, from: player.playerId, to: target.playerId, createdAt: Date.now() };
      challenges.set(challengeId, challenge);
      send(target.ws, { type: "challengeReceived", challengeId, from: publicPlayer(player) });
      send(ws, { type: "challengeSent", challengeId, to: publicPlayer(target) });
      return;
    }

    if (data.type === "challengeResponse") {
      const challenge = challenges.get(String(data.challengeId || ""));
      if (!challenge || challenge.to !== player.playerId) return fail(ws, "CHALLENGE_EXPIRED", "That challenge is no longer available.");
      challenges.delete(challenge.challengeId);
      const challenger = getPlayer(challenge.from);
      if (!challenger) return fail(ws, "PLAYER_UNAVAILABLE", "The challenger disconnected.");

      if (!data.accepted) {
        send(challenger.ws, { type: "challengeDeclined", challengeId: challenge.challengeId, by: publicPlayer(player) });
        send(ws, { type: "challengeClosed", challengeId: challenge.challengeId });
        return;
      }

      if (player.matchId || challenger.matchId) return fail(ws, "PLAYER_BUSY", "One of the players is already in a match.");
      const matchId = randomUUID();
      const firstPlayerId = Math.random() < 0.5 ? challenger.playerId : player.playerId;
      const match = { matchId, players: [challenger.playerId, player.playerId], firstPlayerId, createdAt: Date.now() };
      matches.set(matchId, match);
      challenger.matchId = matchId;
      player.matchId = matchId;
      send(challenger.ws, { type: "matchStarted", matchId, opponent: publicPlayer(player), firstPlayerId });
      send(player.ws, { type: "matchStarted", matchId, opponent: publicPlayer(challenger), firstPlayerId });
      broadcastRoster();
      return;
    }

    if (data.type === "matchAction" || data.type === "matchState") {
      const match = matches.get(player.matchId);
      if (!match || data.matchId !== match.matchId) return fail(ws, "MATCH_NOT_FOUND", "Match is no longer active.");
      const opponentId = match.players.find(id => id !== player.playerId);
      send(getPlayer(opponentId)?.ws, {
        type: data.type,
        matchId: match.matchId,
        from: player.playerId,
        sequence: Math.max(0, Number(data.sequence) || 0),
        payload: data.payload ?? null
      });
      return;
    }

    if (data.type === "matchEnd") {
      const matchId = player.matchId;
      if (!matchId) return;
      const match = matches.get(matchId);
      const opponentId = match?.players.find(id => id !== player.playerId);
      send(getPlayer(opponentId)?.ws, { type: "matchEnded", matchId, by: player.playerId, result: data.result || null });
      leaveMatch(player.playerId, "match_end");
      broadcastRoster();
      return;
    }

    if (data.type === "leaveMatch") {
      leaveMatch(player.playerId, "left");
      broadcastRoster();
    }
  });

  ws.on("close", () => {
    const playerId = ws.playerId;
    if (!playerId || getPlayer(playerId)?.ws !== ws) return;
    removeChallengesFor(playerId);
    leaveMatch(playerId, "disconnected");
    players.delete(playerId);
    broadcastRoster();
  });

  ws.on("error", error => console.error("WebSocket error:", error));
});

const heartbeat = setInterval(() => {
  const cutoff = Date.now() - 60_000;
  for (const [challengeId, challenge] of challenges) {
    if (challenge.createdAt < cutoff) {
      send(getPlayer(challenge.from)?.ws, { type: "challengeExpired", challengeId });
      send(getPlayer(challenge.to)?.ws, { type: "challengeExpired", challengeId });
      challenges.delete(challengeId);
    }
  }
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 30_000);

wss.on("close", () => clearInterval(heartbeat));
server.listen(port, () => console.log(`Nybrisk PvP relay listening on ${port}`));
