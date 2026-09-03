import { createHash } from "node:crypto";

const TELEGRAM_MESSAGE_LIMIT = 4096;
const TELEGRAM_CAPTION_LIMIT = 1024;
const TELEGRAM_RICH_MESSAGE_LIMIT = 32_768;
const TELEGRAM_RICH_MEDIA_LIMIT = 50;

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function escapeAttribute(value) {
  return escapeHtml(value).replaceAll('"', "&quot;");
}

function safeLink(rawUrl) {
  const url = rawUrl.trim();
  if (/^(https?:\/\/|tg:\/\/|mailto:)/i.test(url)) return url;
  return null;
}

function convertInline(markdown) {
  const tokens = [];
  const save = (html) => {
    const marker = `\uE000${tokens.length}\uE001`;
    tokens.push(html);
    return marker;
  };

  let text = markdown;

  text = text.replace(/`([^`\n]+)`/g, (_match, code) =>
    save(`<code>${escapeHtml(code)}</code>`),
  );

  text = text.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_match, label, rawUrl) => {
    const url = safeLink(rawUrl);
    const escapedLabel = escapeHtml(label);
    if (!url) return escapedLabel;
    return save(`<a href="${escapeAttribute(url)}">${escapedLabel}</a>`);
  });

  text = escapeHtml(text);
  text = text.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>");
  text = text.replace(/__([^_\n]+)__/g, "<b>$1</b>");
  text = text.replace(/~~([^~\n]+)~~/g, "<s>$1</s>");
  text = text.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<i>$2</i>");

  for (let index = 0; index < tokens.length; index += 1) {
    text = text.replaceAll(`\uE000${index}\uE001`, tokens[index]);
  }

  return text;
}

function stripWritingWrapper(text) {
  const writingMatch = text.match(
    /:::writing\{[^\n]*\}\s*\n([\s\S]*?)\n:::(?:\s|$)/i,
  );
  if (writingMatch) return writingMatch[1];

  const fencedMatch = text.match(/^\s*```(?:markdown)?\s*\n([\s\S]*?)\n```\s*$/i);
  if (fencedMatch) return fencedMatch[1];

  return text;
}

export function normalizeDigest(source) {
  if (typeof source !== "string" || !source.trim()) {
    throw new Error("Digest markdown is empty.");
  }

  let text = source.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  text = stripWritingWrapper(text);

  const sourcesHeading = /^#{1,6}\s+Источники\s+для\s+проверки\s*$/im;
  const sourcesIndex = text.search(sourcesHeading);
  if (sourcesIndex >= 0) text = text.slice(0, sourcesIndex);

  text = text
    .replace(/cite[^]*/g, "")
    .replace(/^:::.*$/gm, "")
    .replace(/^```(?:markdown)?\s*$/gim, "")
    .replace(/^```\s*$/gm, "")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (!text) throw new Error("No publishable digest was found.");
  return text;
}

function htmlToVisibleText(html) {
  return html
    .replace(/<[^>]+>/g, "")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&amp;", "&");
}

export function formatDigest(source) {
  const markdown = normalizeDigest(source);
  const html = markdown
    .split("\n")
    .map((line) => {
      const withoutHeading = line.replace(/^#{1,6}\s+/, "");
      return convertInline(withoutHeading);
    })
    .join("\n");

  const visibleCharacters = htmlToVisibleText(html).length;
  if (visibleCharacters > TELEGRAM_MESSAGE_LIMIT) {
    throw new Error(
      `Telegram allows at most ${TELEGRAM_MESSAGE_LIMIT} characters in one message; this digest has ${visibleCharacters}. Shorten it before publishing.`,
    );
  }

  const sha256 = createHash("sha256").update(html, "utf8").digest("hex");
  return {
    markdown,
    html,
    sha256,
    visibleCharacters,
    remainingCharacters: TELEGRAM_MESSAGE_LIMIT - visibleCharacters,
  };
}

function normalizeImage(image, index) {
  if (!image || typeof image !== "object" || Array.isArray(image)) {
    throw new Error(`Image ${index + 1} must be an object.`);
  }

  const id = image.id?.trim();
  if (!id || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
    throw new Error(
      `Image ${index + 1} id must contain 1-64 letters, digits, underscores, or hyphens.`,
    );
  }

  const source = image.source?.trim();
  if (!source) throw new Error(`Image ${id} source is empty.`);
  if (source.length > 2048) throw new Error(`Image ${id} source is too long.`);

  if (/^mcp-upload:[a-f0-9]{48}\.(?:jpg|png|webp)$/.test(source)) {
    // Opaque reference returned by upload_image. It is resolved only inside the
    // publisher and is never fetched by Telegram.
  } else if (/^[a-z][a-z0-9+.-]*:/i.test(source)) {
    let url;
    try {
      url = new URL(source);
    } catch {
      throw new Error(
        `Image ${id} source must be an upload_image reference, HTTPS URL, or Telegram file_id.`,
      );
    }
    if (url.protocol !== "https:") {
      throw new Error(`Image ${id} URL must use HTTPS.`);
    }
  } else if (!/^[A-Za-z0-9_-]{10,}$/.test(source)) {
    throw new Error(
      `Image ${id} source must be an upload_image reference, HTTPS URL, or Telegram file_id.`,
    );
  }

  const caption = image.caption?.trim() || null;
  if (caption && Array.from(caption).length > 1024) {
    throw new Error(`Image ${id} caption is longer than 1024 characters.`);
  }

  return {
    id,
    source,
    ...(caption ? { caption } : {}),
    spoiler: image.spoiler === true,
  };
}

export function normalizeImages(images = []) {
  if (!Array.isArray(images)) throw new Error("Images must be an array.");
  if (images.length > TELEGRAM_RICH_MEDIA_LIMIT) {
    throw new Error(
      `Telegram allows at most ${TELEGRAM_RICH_MEDIA_LIMIT} images in one rich message.`,
    );
  }

  const normalized = images.map(normalizeImage);
  const ids = new Set();
  for (const image of normalized) {
    if (ids.has(image.id)) throw new Error(`Image id ${image.id} is duplicated.`);
    ids.add(image.id);
  }
  return normalized;
}

function escapeRichCaption(value) {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", " ");
}

function renderRichImages(markdown, images) {
  let rendered = markdown;
  const knownIds = new Set(images.map((image) => image.id));
  const placeholderPattern = /\{\{image:([A-Za-z0-9_-]+)\}\}/g;

  rendered = rendered.replace(placeholderPattern, (_match, id) => {
    const image = images.find((candidate) => candidate.id === id);
    if (!image) throw new Error(`Rich Markdown references unknown image id ${id}.`);
    const caption = image.caption ? ` "${escapeRichCaption(image.caption)}"` : "";
    return `![](tg://photo?id=${id}${caption})`;
  });

  const referencedIds = [
    ...rendered.matchAll(/tg:\/\/photo\?id=([A-Za-z0-9_-]{1,64})/g),
  ].map((match) => match[1]);
  for (const id of referencedIds) {
    if (!knownIds.has(id)) {
      throw new Error(`Rich Markdown references unknown image id ${id}.`);
    }
  }

  for (const id of knownIds) {
    const count = referencedIds.filter((referencedId) => referencedId === id).length;
    if (count === 0) {
      throw new Error(`Image ${id} is not placed in the Rich Markdown. Add {{image:${id}}}.`);
    }
    if (count > 1) {
      throw new Error(`Image ${id} is placed more than once in the Rich Markdown.`);
    }
  }

  return rendered;
}

function publicationHash(value) {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

export function bindPublicationChannels(formatted, channels) {
  if (!Array.isArray(channels) || !channels.length) {
    throw new Error("At least one Telegram channel must be selected.");
  }
  const normalizedChannels = channels.map((channel) => ({
    name: channel.name,
    id: channel.id,
  }));
  return {
    ...formatted,
    contentSha256: formatted.sha256,
    channels: normalizedChannels,
    sha256: publicationHash({
      version: 3,
      contentSha256: formatted.sha256,
      channels: normalizedChannels,
    }),
  };
}

export function formatPublication({
  markdown: source,
  publicationFormat = "classic",
  images = [],
  showCaptionAboveMedia = false,
}) {
  if (!new Set(["classic", "rich"]).has(publicationFormat)) {
    throw new Error("Publication format must be classic or rich.");
  }

  const normalizedImages = normalizeImages(images);
  if (publicationFormat === "classic") {
    if (normalizedImages.length > 1) {
      throw new Error("Classic mode supports at most one cover image. Use rich mode for more images.");
    }

    const formatted = formatDigest(source);
    const characterLimit = normalizedImages.length
      ? TELEGRAM_CAPTION_LIMIT
      : TELEGRAM_MESSAGE_LIMIT;
    if (formatted.visibleCharacters > characterLimit) {
      throw new Error(
        `A classic Telegram post with a cover allows at most ${characterLimit} caption characters; this digest has ${formatted.visibleCharacters}. Use rich mode or shorten it.`,
      );
    }

    const hashPayload = {
      version: 2,
      publicationFormat,
      html: formatted.html,
      images: normalizedImages,
      showCaptionAboveMedia: normalizedImages.length ? showCaptionAboveMedia === true : false,
    };
    return {
      ...formatted,
      sha256: publicationHash(hashPayload),
      publicationFormat,
      images: normalizedImages,
      showCaptionAboveMedia: normalizedImages.length ? showCaptionAboveMedia === true : false,
      richMarkdown: null,
      characterLimit,
      remainingCharacters: characterLimit - formatted.visibleCharacters,
    };
  }

  const markdown = normalizeDigest(source);
  const richMarkdown = renderRichImages(markdown, normalizedImages);
  const visibleCharacters = Array.from(richMarkdown).length;
  if (visibleCharacters > TELEGRAM_RICH_MESSAGE_LIMIT) {
    throw new Error(
      `Telegram allows at most ${TELEGRAM_RICH_MESSAGE_LIMIT} characters in one rich message; this digest has ${visibleCharacters}.`,
    );
  }

  const hashPayload = {
    version: 2,
    publicationFormat,
    richMarkdown,
    images: normalizedImages,
  };
  return {
    markdown,
    html: "",
    richMarkdown,
    sha256: publicationHash(hashPayload),
    publicationFormat,
    images: normalizedImages,
    showCaptionAboveMedia: false,
    visibleCharacters,
    characterLimit: TELEGRAM_RICH_MESSAGE_LIMIT,
    remainingCharacters: TELEGRAM_RICH_MESSAGE_LIMIT - visibleCharacters,
  };
}

export {
  TELEGRAM_CAPTION_LIMIT,
  TELEGRAM_MESSAGE_LIMIT,
  TELEGRAM_RICH_MEDIA_LIMIT,
  TELEGRAM_RICH_MESSAGE_LIMIT,
};
