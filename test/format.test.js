import test from "node:test";
import assert from "node:assert/strict";
import {
  bindPublicationChannels,
  formatDigest,
  formatPublication,
  normalizeDigest,
} from "../src/format.js";

const sample = `Intro that must not be published.

:::writing{variant="social_post" id="53827"}
☕️ **В TON запустили LamboSwapi — трейдинг прямо внутри Telegram**

Команды **Wen Lambo и swap.coffee** запустили @swapi.

🟠 Код \`scam\` и [ссылка](https://t.me/swapi).

#Новости #News
:::

### Источники для проверки

Служебный текст. citeturn1view0`;

test("extracts only the social post", () => {
  const normalized = normalizeDigest(sample);
  assert.match(normalized, /^☕️/);
  assert.doesNotMatch(normalized, /Intro/);
  assert.doesNotMatch(normalized, /Источники/);
  assert.doesNotMatch(normalized, /cite/);
});

test("converts digest markdown to Telegram HTML", () => {
  const result = formatDigest(sample);
  assert.match(result.html, /<b>В TON запустили/);
  assert.match(result.html, /<code>scam<\/code>/);
  assert.match(result.html, /<a href="https:\/\/t\.me\/swapi">ссылка<\/a>/);
  assert.match(result.sha256, /^[a-f0-9]{64}$/);
  assert.ok(result.visibleCharacters < 4096);
});

test("rejects an oversized one-message digest", () => {
  assert.throws(() => formatDigest("я".repeat(4097)), /at most 4096/);
});

test("does not create unsafe Telegram links", () => {
  const result = formatDigest("[click](javascript:alert(1))");
  assert.doesNotMatch(result.html, /<a /);
  assert.match(result.html, /click\)/);
});

test("formats a classic post with one cover and binds it to the preview hash", () => {
  const first = formatPublication({
    markdown: "**Короткая новость**",
    images: [{ id: "cover", source: "https://cdn.example/one.jpg" }],
  });
  const second = formatPublication({
    markdown: "**Короткая новость**",
    images: [{ id: "cover", source: "https://cdn.example/two.jpg" }],
  });

  assert.equal(first.publicationFormat, "classic");
  assert.equal(first.characterLimit, 1024);
  assert.equal(first.images[0].source, "https://cdn.example/one.jpg");
  assert.notEqual(first.sha256, second.sha256);
});

test("rejects a classic cover caption over 1024 characters", () => {
  assert.throws(
    () =>
      formatPublication({
        markdown: "я".repeat(1025),
        images: [{ id: "cover", source: "https://cdn.example/cover.jpg" }],
      }),
    /classic Telegram post with a cover allows at most 1024/,
  );
});

test("preserves Rich Markdown and places explicit images", () => {
  const result = formatPublication({
    publicationFormat: "rich",
    markdown: "# Заголовок\n\n{{image:cover}}\n\n| A | B |\n|---|---|\n| 1 | 2 |",
    images: [
      {
        id: "cover",
        source: "https://cdn.example/cover.jpg",
        caption: "Обложка",
        spoiler: true,
      },
    ],
  });

  assert.equal(result.publicationFormat, "rich");
  assert.match(result.richMarkdown, /^# Заголовок/);
  assert.match(
    result.richMarkdown,
    /!\[\]\(tg:\/\/photo\?id=cover "Обложка"\)/,
  );
  assert.match(result.richMarkdown, /\| A \| B \|/);
  assert.equal(result.characterLimit, 32768);
  assert.match(result.sha256, /^[a-f0-9]{64}$/);
});

test("allows a rich article longer than a classic message", () => {
  const result = formatPublication({
    publicationFormat: "rich",
    markdown: `# Заголовок\n\n${"я".repeat(5000)}`,
  });
  assert.ok(result.visibleCharacters > 4096);
});

test("rejects unplaced, unknown, duplicate, and insecure rich images", () => {
  assert.throws(
    () =>
      formatPublication({
        publicationFormat: "rich",
        markdown: "Текст без изображения",
        images: [{ id: "cover", source: "https://cdn.example/cover.jpg" }],
      }),
    /not placed/,
  );
  assert.throws(
    () =>
      formatPublication({
        publicationFormat: "rich",
        markdown: "{{image:missing}}",
      }),
    /unknown image id/,
  );
  assert.throws(
    () =>
      formatPublication({
        publicationFormat: "rich",
        markdown: "{{image:cover}}\n{{image:cover}}",
        images: [{ id: "cover", source: "https://cdn.example/cover.jpg" }],
      }),
    /more than once/,
  );
  assert.throws(
    () =>
      formatPublication({
        markdown: "Текст",
        images: [{ id: "cover", source: "http://private.example/cover.jpg" }],
      }),
    /must use HTTPS/,
  );
});

test("does not mistake an inner rich code block for an outer wrapper", () => {
  const result = formatPublication({
    publicationFormat: "rich",
    markdown: "# До\n\n```js\nconsole.log('ok')\n```\n\nПосле",
  });
  assert.match(result.richMarkdown, /^# До/);
  assert.match(result.richMarkdown, /После$/);
});

test("binds exact target channels to the preview hash", () => {
  const formatted = formatPublication({ markdown: "Один и тот же текст" });
  const main = bindPublicationChannels(formatted, [
    { name: "News", id: "@demo_news" },
  ]);
  const both = bindPublicationChannels(formatted, [
    { name: "News", id: "@demo_news" },
    { name: "News test", id: "-100222" },
  ]);
  assert.equal(main.contentSha256, both.contentSha256);
  assert.notEqual(main.sha256, both.sha256);
});
