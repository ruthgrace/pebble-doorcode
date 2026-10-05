import http from "node:http";
import { createApp } from "./app.js";
import { openStore } from "./store.js";
import { createDiscordClient } from "./discord.js";

function env(name, fallback) {
  const raw = process.env[name];
  const v = raw === undefined || raw === "" ? fallback : raw;
  if (v === undefined) {
    console.error(`Missing required environment variable ${name}`);
    process.exit(1);
  }
  return v;
}

const config = {
  baseUrl: env("BASE_URL").replace(/\/$/, ""),
  guildId: env("DISCORD_GUILD_ID"),
  clientId: env("DISCORD_CLIENT_ID"),
  clientSecret: env("DISCORD_CLIENT_SECRET"),
  botToken: env("DISCORD_BOT_TOKEN"),
  dbPath: env("DB_PATH", "./doorcode.sqlite"),
  port: Number(env("PORT", "8787")),
};

if (!config.baseUrl.startsWith("https://")) {
  console.error("BASE_URL must start with https://");
  process.exit(1);
}
if (!Number.isInteger(config.port) || config.port <= 0) {
  console.error("PORT must be a positive integer");
  process.exit(1);
}

const store = openStore(config.dbPath);
const discord = createDiscordClient(config);
const server = http.createServer(createApp({ ...config, store, discord }));

server.listen(config.port, "127.0.0.1", () => {
  console.log(`doorcode service listening on 127.0.0.1:${config.port}`);
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    server.close(() => {
      store.close();
      process.exit(0);
    });
  });
}
