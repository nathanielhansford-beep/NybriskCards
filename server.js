const { WebSocketServer, WebSocket } = require("ws");

const wss = new WebSocketServer({
    port: process.env.PORT || 8080
});

const players = new Map();
const npcs = new Map();

function broadcast(message, exceptWs = null) {
    const payload =
        typeof message === "string"
            ? message
            : JSON.stringify(message);

    for (const client of wss.clients) {
        if (
            client !== exceptWs &&
            client.readyState === WebSocket.OPEN
        ) {
            client.send(payload);
        }
    }
}

wss.on("connection", (ws) => {
    console.log("Player connected");

    ws.isAlive = true;

    ws.on("pong", () => {
        ws.isAlive = true;
    });

    ws.on("message", (raw) => {
        try {
            const data = JSON.parse(raw.toString());

            if (data.type === "join") {
                const playerId = String(data.playerId || "");

                if (!playerId) {
                    ws.close(1008, "Missing player ID");
                    return;
                }

                ws.playerId = playerId;

                const playerState = {
                    playerId,
                    nickname: data.nickname || "Pilot",
                    x: Number(data.x) || 1600,
                    y: Number(data.y) || 1100,
                    hp: Number(data.hp) || 100,
                    maxHp: Number(data.maxHp) || 100,
                    sprite: data.sprite || "alien",
                    facingX: Number(data.facingX) || 0,
                    facingY: Number(data.facingY) || -1
                };

                players.set(playerId, {
                    ws,
                    state: playerState
                });

                // Give the joining player everyone already online.
              ws.send(JSON.stringify({
    type: "worldState",

    players: [...players.values()]
        .filter(entry => entry.ws !== ws)
        .map(entry => entry.state),

    npcs: [...npcs.values()]
}));

                // Tell everyone else about the new player.
                broadcast({
                    type: "playerJoined",
                    player: playerState
                }, ws);

                console.log(`Player ${playerId} joined the global world`);
                return;
            }

            if (!ws.playerId || !players.has(ws.playerId)) {
                return;
            }

            const entry = players.get(ws.playerId);

            if (data.type === "state") {
                entry.state = {
                    ...entry.state,
                    x: Number(data.x) || 0,
                    y: Number(data.y) || 0,
                    hp: Number(data.hp) || 0,
                    maxHp: Number(data.maxHp) || entry.state.maxHp,
                    facingX: Number(data.facingX) || 0,
                    facingY: Number(data.facingY) || -1,
                    sprite: data.sprite || entry.state.sprite
                };

                broadcast({
                    type: "state",
                    playerId: ws.playerId,
                    ...entry.state
                }, ws);

                return;
            }
 if (data.type === "npcSpawn") {
    const npcState = {
        npcId: data.npcId,
        npcFaction: data.npcFaction,
        ownerId: ws.playerId,
        x: Number(data.x) || 0,
        y: Number(data.y) || 0,
        w: Number(data.w) || 56,
        h: Number(data.h) || 56,
        hp: Number(data.hp) || 40,
        maxHp: Number(data.maxHp) || 40,
        fireCooldown: Number(data.fireCooldown) || 1800,
        speed: Number(data.speed) || 2.5,
        preferredDist: Number(data.preferredDist) || 280,
        dmg: Number(data.dmg) || 10,
        diff: Number(data.diff) || 1,
        isDefense: !!data.isDefense,
        angle: Number(data.angle) || 0,
        state: data.state || null,
        beamCharge: Number(data.beamCharge) || 0
    };

    npcs.set(npcState.npcId, npcState);

    broadcast({
        type: "npcSpawn",
        ...npcState
    }, ws);

    return;
}

if (data.type === "npcState") {
    const npc = npcs.get(data.npcId);

    if (!npc) {
        return;
    }

    // Only the client that spawned the NPC controls its movement.
    if (npc.ownerId !== ws.playerId) {
        return;
    }

    npc.x = Number(data.x) || 0;
    npc.y = Number(data.y) || 0;
    npc.hp = Math.max(0, Number(data.hp) || 0);
    npc.angle = Number(data.angle) || 0;
    npc.fireTimer = Number(data.fireTimer) || 0;
    npc.state = data.state || npc.state;
    npc.beamCharge = Number(data.beamCharge) || 0;

    broadcast({
        type: "npcState",
        npcId: npc.npcId,
        ownerId: npc.ownerId,
        x: npc.x,
        y: npc.y,
        hp: npc.hp,
        angle: npc.angle,
        fireTimer: npc.fireTimer,
        state: npc.state,
        beamCharge: npc.beamCharge
    }, ws);

    return;
}
 
         if (data.type === "npcDestroy") {
    const npc = npcs.get(data.npcId);

    if (!npc) {
        return;
    }

    npcs.delete(data.npcId);

    broadcast({
        type: "npcDestroy",
        npcId: data.npcId,
        by: ws.playerId
    });

    return;
}

            if (data.type === "fire") {
                broadcast({
                    type: "fire",
                    playerId: ws.playerId,
                    shotId: data.shotId,
                    x: data.x,
                    y: data.y,
                    angle: data.angle,
                    damage: data.damage,
                    firedAt: Date.now()
                }, ws);

                return;
            }

            if (data.type === "damage") {
                broadcast({
                    type: "damage",
                    attackerId: ws.playerId,
                    targetId: data.targetId,
                    shotId: data.shotId,
                    damage: data.damage
                }, ws);

                return;
            }

            if (data.type === "respawn") {
                entry.state.x = Number(data.x) || 1600;
                entry.state.y = Number(data.y) || 1100;
                entry.state.hp =
                    Number(data.hp) ||
                    entry.state.maxHp;

                broadcast({
                    type: "respawn",
                    playerId: ws.playerId,
                    x: entry.state.x,
                    y: entry.state.y,
                    hp: entry.state.hp
                }, ws);
            }
        } catch (error) {
            console.error("Message error:", error);
        }
    });

    ws.on("close", () => {
        const playerId = ws.playerId;

        if (playerId) {
            players.delete(playerId);

            broadcast({
                type: "playerLeft",
                playerId
            });

            console.log(`Player ${playerId} disconnected`);
        }
    });

    ws.on("error", (error) => {
        console.error("WebSocket error:", error);
    });
});

// Remove connections that disappeared without closing cleanly.
const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
        if (!ws.isAlive) {
            ws.terminate();
            continue;
        }

        ws.isAlive = false;
        ws.ping();
    }
}, 30000);

wss.on("close", () => {
    clearInterval(heartbeat);
});

console.log("Global PvP relay server running");
