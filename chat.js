const WebSocket = require("ws");
const http = require("http");
const fs = require("fs");
const axios = require("axios");
const Limiter = require("limiter").RateLimiter;

const server = http.createServer();
const wss = new WebSocket.Server({ noServer: true, proxy: true }); //clientTracking: true (enable default user count by wss

const globalChatPlayers = new Map();
let nextGlobalPlayerId = 1;

const connectionRate = 1;
const connectionBurst = 1;
const tokenBucket = new Limiter({
  tokensPerInterval: connectionRate,
  interval: "sec",
  maxBurst: connectionBurst,
});

const messageRate = 1;
const messageBurst = 1;
const messageTokenBucket = new Limiter({
  tokensPerInterval: messageRate,
  interval: "sec",
  maxBurst: messageBurst,
});

const maxMessages = 4;
const chatHistory = [];

const badWordsFilePath = "badwords.txt";
const badWords = fs
  .readFileSync(badWordsFilePath, "utf-8")
  .split("\n")
  .map((word) => word.trim())
  .filter(Boolean);

const allowedOrigins = [
  "https://slcount.netlify.app",
  "https://slgame.netlify.app",
  "https://serve.gamejolt.net",
  "http://serve.gamejolt.net",
  "https://html-classic.itch.zone",
  "tw-editor://.",
];

function isValidOrigin(origin) {
  // Trim leading and trailing spaces, and remove leading and trailing commas before checking
  const trimmedOrigin = origin.trim().replace(/(^,)|(,$)/g, '');
  return allowedOrigins.includes(trimmedOrigin);
}

function containsBadWords(message) {
  const lowercasedMessage = message.toLowerCase();
  return badWords.some((badWord) => lowercasedMessage.includes(badWord));
}

async function joinGlobalChat(ws, token) {
  return new Promise(async (resolve, reject) => {
    try {
      const expectedOrigin = "tw-editor://.";
      const response = await axios.get(
        `https://liquemgames-api.netlify.app/verify-token/${token}`,
        {
          headers: {
            Origin: expectedOrigin,
          },
        },
      );

      if (response.data.message) {
        const playerId = response.data.message;

        if (globalChatPlayers.has(playerId)) {
          ws.close(4003, "Duplicate player ID");
          reject("Duplicate player ID");
          return;
        }

        globalChatPlayers.set(playerId, { ws });

        ws.send(JSON.stringify({ type: "chat", messages: chatHistory }));

        resolve({ playerId });
      } else {
        ws.close(4001, "Invalid token");
        reject("Invalid token");
      }
    } catch (error) {
      console.error("Error verifying token:", error);
      ws.close(4000, "Token verification error");
      reject("Token verification error");
    }
  });
}

function broadcastGlobal(playerId, message) {
  const maxMessageLength = 100;

  const messageString = String(message);

  if (!messageString.trim()) {
    console.error("Empty message");
    return;
  }

  if (messageString.length > maxMessageLength) {
    console.error("Message too long:", messageString);
    return;
  }

  if (!messageTokenBucket.tryRemoveTokens(1)) {
    console.error("Message rate limit exceeded:", messageString);
    return;
  }

  const containsBad = containsBadWords(messageString);

  let filteredMessage = messageString;
  if (containsBad) {
    filteredMessage = "***";
  }

  const limitedMessage = filteredMessage.substring(0, maxMessageLength);

  const timestamp = new Date().toLocaleTimeString();

  const newMessage = {
    id: chatHistory.length + 1,
    timestamp: timestamp,
    playerId: playerId,
    message: limitedMessage,
  };

  chatHistory.push(newMessage);

  if (chatHistory.length > maxMessages) {
    chatHistory.splice(0, chatHistory.length - maxMessages);
  }

  for (const [id, player] of globalChatPlayers) {
    player.ws.send(JSON.stringify({ type: "chat", messages: chatHistory }));
  }
}

function cleanUpClosedConnections() {
  for (const [playerId, player] of globalChatPlayers) {
    if (player.ws.readyState === WebSocket.CLOSED) {
      globalChatPlayers.delete(playerId);
    }
  }
}

wss.on("connection", (ws, req) => {
  const token = req.url.slice(1);

   const origin = req.headers['sec-websocket-origin'] || req.headers.origin;
  console.log(origin);

  if (!isValidOrigin(origin)) {
    ws.close(4004, "Unauthorized origin");
    return;
  }

  if (tokenBucket.tryRemoveTokens(1)) {
    joinGlobalChat(ws, token)
      .then((result) => {
        if (result) {
          console.log("Joined global chat:", result);

          ws.on("message", (message) => {
            try {
              const data = JSON.parse(message);
              if (data.type === "chat") {
                broadcastGlobal(result.playerId, data.message);
              }
            } catch (error) {
              console.error("Error parsing message:", error);
            }
          });

          ws.on("close", () => {
            globalChatPlayers.delete(result.playerId);
          });
        } else {
          console.error("Failed to join global chat:", result);
        }
      })
      .catch((error) => {
        console.error("Error joining global chat:", error);
        ws.close(4005, "Internal Server Error");
      })
      .finally(() => {
        cleanUpClosedConnections();
      });
  } else {
    console.log("Connection rate-limited. Too many connections in a short period.");
    ws.close(4002, "Connection rate-limited. Too many connections in a short period.");
  }
});

server.on("upgrade", (request, socket, head) => {
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit("connection", ws, request);
  });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`Server is listening on port ${PORT}`);
});
