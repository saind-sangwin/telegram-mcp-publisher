const CHANNEL_ID_PATTERN = /^(?:@[A-Za-z0-9_]{5,32}|-?\d{1,20})$/;

function normalizeName(value) {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function validateName(rawName) {
  if (typeof rawName !== "string") throw new Error("Channel names must be strings.");
  const name = rawName.trim().replace(/\s+/g, " ");
  if (!name || name.length > 80) {
    throw new Error("Each channel name must contain 1-80 characters.");
  }
  return name;
}

function validateChannelId(rawId, name) {
  const id = String(rawId).trim();
  if (!CHANNEL_ID_PATTERN.test(id)) {
    throw new Error(
      `Channel ${name} must use a Telegram @username or numeric chat ID.`,
    );
  }
  return id;
}

export function telegramChannelRegistry(env = process.env) {
  const rawRegistry = env.TELEGRAM_CHANNELS_JSON?.trim();
  const legacyChannelId = env.TELEGRAM_CHANNEL_ID?.trim();
  const requestedDefault = env.TELEGRAM_DEFAULT_CHANNEL?.trim();
  let channels = [];

  if (rawRegistry) {
    let parsed;
    try {
      parsed = JSON.parse(rawRegistry);
    } catch {
      throw new Error("TELEGRAM_CHANNELS_JSON must be valid JSON.");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(
        'TELEGRAM_CHANNELS_JSON must be an object such as {"News":"@channel"}.',
      );
    }

    channels = Object.entries(parsed).map(([rawName, rawId]) => {
      const name = validateName(rawName);
      return { name, id: validateChannelId(rawId, name) };
    });
    if (!channels.length) throw new Error("TELEGRAM_CHANNELS_JSON cannot be empty.");
  } else {
    if (!legacyChannelId) {
      throw new Error("TELEGRAM_CHANNELS_JSON or TELEGRAM_CHANNEL_ID is not configured.");
    }
    const name = validateName(requestedDefault || "default");
    channels = [{ name, id: validateChannelId(legacyChannelId, name) }];
  }

  const channelsByName = new Map();
  const channelIds = new Set();
  for (const channel of channels) {
    const key = normalizeName(channel.name);
    if (channelsByName.has(key)) {
      throw new Error(`Channel name ${channel.name} is duplicated.`);
    }
    if (channelIds.has(channel.id)) {
      throw new Error(`Telegram channel ID ${channel.id} is configured more than once.`);
    }
    channelsByName.set(key, channel);
    channelIds.add(channel.id);
  }

  let defaultChannel = null;
  if (requestedDefault) {
    defaultChannel = channelsByName.get(normalizeName(requestedDefault)) ?? null;
    if (!defaultChannel) {
      throw new Error(
        `TELEGRAM_DEFAULT_CHANNEL does not match a configured channel: ${requestedDefault}.`,
      );
    }
  } else if (channels.length === 1) {
    defaultChannel = channels[0];
  } else if (legacyChannelId) {
    defaultChannel =
      channels.find((channel) => channel.id === legacyChannelId) ?? null;
  }

  return { channels, channelsByName, defaultChannel };
}

export function listTelegramChannels(env = process.env) {
  const registry = telegramChannelRegistry(env);
  return registry.channels.map((channel) => ({
    name: channel.name,
    isDefault: registry.defaultChannel?.name === channel.name,
  }));
}

export function resolveTelegramChannels(requestedNames, env = process.env) {
  const registry = telegramChannelRegistry(env);
  if (!requestedNames?.length) {
    if (!registry.defaultChannel) {
      throw new Error(
        "No default Telegram channel is configured. Pass channels explicitly or set TELEGRAM_DEFAULT_CHANNEL.",
      );
    }
    return [registry.defaultChannel];
  }

  const resolved = [];
  const usedNames = new Set();
  for (const rawName of requestedNames) {
    const name = validateName(rawName);
    const key = normalizeName(name);
    const channel = registry.channelsByName.get(key);
    if (!channel) {
      const available = registry.channels.map((item) => item.name).join(", ");
      throw new Error(`Unknown Telegram channel ${name}. Available channels: ${available}.`);
    }
    if (usedNames.has(key)) throw new Error(`Telegram channel ${channel.name} is duplicated.`);
    usedNames.add(key);
    resolved.push(channel);
  }
  return resolved;
}

export { CHANNEL_ID_PATTERN };
