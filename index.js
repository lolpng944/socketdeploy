const fs = require("fs");
const axios = require("axios");
const socketIO = require("socket.io");
const Limiter = require("limiter").RateLimiter;
const express = require("express");

const app = express();
const server = require("http").createServer(app);
const io = socketIO(server);

const globalChatPlayers = new Map();
let nextGlobalPlayerId = 1;

const connectionRate = 1;
const connectionBurst = 5;
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

function containsBadWords(message) {
  const lowercasedMessage = message.toLowerCase();
  return badWords.some((badWord) => lowercasedMessage.includes(badWord));
}

async function joinGlobalChat(socket, token) {
  return new Promise(async (resolve, reject) => {
    try {
      const expectedOrigin = "tw-editor://.";
      const response = await axios.get(
        `https://wllhh5-3000.csb.app/verify-token/${token}`,
        {
          headers: {
            Origin: expectedOrigin,
          },
        },
      );

      if (response.data.message) {
        const playerId = response.data.message;

        if (globalChatPlayers.has(playerId)) {
          socket.disconnect(4003, "Duplicate player ID");
          reject("Duplicate player ID");
          return;
        }

        globalChatPlayers.set(playerId, { socket });

        socket.emit("chat", { type: "chat", messages: chatHistory });

        resolve({ playerId });
      } else {
        socket.disconnect(4001, "Invalid token");
        reject("Invalid token");
      }
    } catch (error) {
      console.error("Error verifying token:", error);
      socket.disconnect(4000, "Token verification error");
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

  io.emit("chat", { type: "chat", messages: chatHistory });
}

io.on("connection", (socket) => {
  const token = socket.handshake.query.token;

  if (!allowedOrigins.includes(socket.handshake.headers.origin)) {
    socket.disconnect(4004, "Unauthorized origin");
    return;
  }

  if (tokenBucket.tryRemoveTokens(1)) {
    joinGlobalChat(socket, token)
      .then((result) => {
        if (result) {
          console.log("Joined global chat:", result);

          socket.on("chat", (data) => {
            if (data.type === "chat") {
              broadcastGlobal(result.playerId, data.message);
            }
          });

          socket.on("disconnect", () => {
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
      "Connection rate-limited. Too many connections in a short period."
    );
    socket.disconnect(
      4002,
      "Connection rate-limited. Too many connections in a short period."
    );
  }
});

const PORT = process.env.PORT || 3000;
const allowedOrigins = [
  "https://slcount.netlify.app",
  "https://slgame.netlify.app",
  "https://serve.gamejolt.net",
  "https://html-classic.itch.zone",
  "tw-editor://.",
  "https://turbowarp.org",
  "http://serve.gamejolt.net",
];

server.listen(PORT, () => {
  console.log(`Server is listening on port ${PORT}`);
});
