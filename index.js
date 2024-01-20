const WebSocket = require("ws");
const http = require("http");
const fs = require("fs");
const axios = require("axios");
const Limiter = require("limiter").RateLimiter;
const keeper = require('./keeper.js');

const server = http.createServer();
const wss = new WebSocket.Server({ noServer: true });

const globalChatPlayers = new Map();
let nextGlobalPlayerId = 1;

const connectionRate = 1;
const connectionBurst = 5;
const tokenBucket = new Limiter({
  tokensPerInterval: connectionRate,
  interval: "sec",
  maxBurst: connectionBurst,
});

const messageRate = 1; // Allow one message per second
const messageBurst = 1; // Allow one message immediately, additional messages are rate-limited
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

function containsBadWords(message) {
  const lowercasedMessage = message.toLowerCase();
  return badWords.some((badWord) => lowercasedMessage.includes(badWord));
}

async function joinGlobalChat(ws, token) {
  return new Promise(async (resolve, reject) => {
    try {
      const expectedOrigin = "tw-editor://.";
      const response = await axios.get(
        `https://4gy7dw-3000.csb.app/verify-token/${token}`,
        {
          headers: {
            Origin: expectedOrigin,
          },
        },
      );

      if (response.data.message) {
        const playerId = response.data.message;

        // Check if the player ID already exists
        if (globalChatPlayers.has(playerId)) {
          ws.close(4003, "Duplicate player ID");
          reject("Duplicate player ID");
          return;
        }

        globalChatPlayers.set(playerId, { ws });

        // Send the entire chat history to the new connection
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

  // Convert message to string
  const messageString = String(message);

  if (!messageString.trim()) {
    console.error("Empty message");
    return;
  }

  // Check if the message length exceeds the limit
  if (messageString.length > maxMessageLength) {
    console.error("Message too long:", messageString);
    return;
  }

  // Check if the message sending rate limit is exceeded
  if (!messageTokenBucket.tryRemoveTokens(1)) {
    console.error("Message rate limit exceeded:", messageString);
    return;
  }

  const containsBad = containsBadWords(messageString);

  // Replace bad words with asterisks if the message contains any
  let filteredMessage = messageString;
  if (containsBad) {
    filteredMessage = "***";
  }

  const limitedMessage = filteredMessage.substring(0, maxMessageLength);

  const timestamp = new Date().toLocaleTimeString(); // Get the current time as a timestamp

  // Add the new message to the chat history
  const newMessage = {
    id: chatHistory.length + 1,
    timestamp: timestamp,
    playerId: playerId,
    message: limitedMessage,
  };

  chatHistory.push(newMessage);

  // Trim the chat history to keep only the last 'maxMessages' messages
  if (chatHistory.length > maxMessages) {
    chatHistory.splice(0, chatHistory.length - maxMessages);
  }

  for (const [id, player] of globalChatPlayers) {
    player.ws.send(JSON.stringify({ type: "chat", messages: chatHistory }));
  }
}

wss.on("connection", (ws, req) => {
  const token = req.url.slice(1);

  // Check if the request origin is allowed
  if (!allowedOrigins.includes(req.headers.origin)) {
    ws.close(4004, "Unauthorized origin");
    return;
  }

  if (tokenBucket.tryRemoveTokens(1)) {
    joinGlobalChat(ws, token)
      .then((result) => {
        if (result) {
          console.log("Joined global chat:", result);

          ws.on("message", (message) => {
            const data = JSON.parse(message);
            if (data.type === "chat") {
              broadcastGlobal(result.playerId, data.message);
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
      });
  } else {
    console.log(
      "Connection rate-limited. Too many connections in a short period.",
    );
    ws.close(
      4002,
      "Connection rate-limited. Too many connections in a short period.",
    );
  }
});

server.on("upgrade", (request, socket, head) => {
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit("connection", ws, request);
  });
});

const PORT = process.env.PORT || 3000;
const allowedOrigins = [
  "https://slcount.netlify.app",
    "https://slgame.netlify.app",
    "https://serve.gamejolt.net",
    "http://serve.gamejolt.net",
]; // Add your allowed origins

server.listen(PORT, () => {
  console.log(`Server is listening on port ${PORT}`);
}); 
