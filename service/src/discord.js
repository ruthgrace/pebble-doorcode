const API = "https://discord.com/api/v10";

export class DiscordError extends Error {
  constructor(status, message) {
    super(`Discord ${status}: ${message}`);
    this.name = "DiscordError";
    this.status = status;
  }
}

export function createDiscordClient({ clientId, clientSecret, botToken, fetchImpl = fetch }) {
  async function call(path, init = {}) {
    const res = await fetchImpl(API + path, init);
    if (!res.ok) {
      let message = res.statusText;
      try {
        const body = await res.json();
        if (body && body.message) message = body.message;
      } catch {}
      throw new DiscordError(res.status, message);
    }
    return res.json();
  }

  return {
    authorizeUrl(redirectUri, state) {
      const u = new URL("https://discord.com/oauth2/authorize");
      u.searchParams.set("client_id", clientId);
      u.searchParams.set("redirect_uri", redirectUri);
      u.searchParams.set("response_type", "code");
      u.searchParams.set("scope", "identify");
      u.searchParams.set("state", state);
      return u.toString();
    },

    async exchangeCode(code, redirectUri) {
      const body = new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
      }).toString();
      const json = await call("/oauth2/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      });
      return json.access_token;
    },

    getMe(accessToken) {
      return call("/users/@me", { headers: { Authorization: `Bearer ${accessToken}` } });
    },

    listGuildChannels(guildId) {
      return call(`/guilds/${guildId}/channels`, { headers: { Authorization: `Bot ${botToken}` } });
    },

    getChannel(channelId) {
      return call(`/channels/${channelId}`, { headers: { Authorization: `Bot ${botToken}` } });
    },
  };
}
