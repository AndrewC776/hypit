#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import puppeteer from 'puppeteer-core';

const inputUrl = process.argv[2];
const outDir = process.argv[3] ?? 'output/reference';
if (!inputUrl) {
  console.error('usage: node scripts/tiktok-browser-ingest.mjs <url> [outDir]');
  process.exit(2);
}

await fs.mkdir(outDir, { recursive: true });
const imageDir = path.resolve(path.dirname(outDir), 'browser-images');
await fs.mkdir(imageDir, { recursive: true });

const chromeCandidates = [
  process.env.CHROME_BIN,
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);
let executablePath = null;
for (const candidate of chromeCandidates) {
  try {
    await fs.access(candidate);
    executablePath = candidate;
    break;
  } catch {}
}
if (!executablePath) throw new Error('No Chrome/Chromium executable found');

const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
const browser = await puppeteer.launch({
  executablePath,
  headless: true,
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-blink-features=AutomationControlled',
    '--autoplay-policy=no-user-gesture-required',
    '--window-size=430,932',
  ],
});

const page = await browser.newPage();
await page.setViewport({ width: 430, height: 932, deviceScaleFactor: 1 });
await page.setUserAgent(userAgent);
await page.setExtraHTTPHeaders({
  'Accept-Language': 'en-US,en;q=0.9',
  'Sec-CH-UA-Platform': '"Windows"',
});
await page.evaluateOnNewDocument(() => {
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
});

const mediaResponses = [];
const jsonResponses = [];
page.on('response', async (response) => {
  try {
    const url = response.url();
    const headers = response.headers();
    const type = headers['content-type'] ?? '';
    if (
      type.startsWith('video/') ||
      /(?:mime_type=video|video\/tos|playwm|playAddr|\.mp4(?:\?|$)|\.m3u8(?:\?|$))/i.test(url)
    ) {
      mediaResponses.push({ url, type, status: response.status() });
    }
    if (
      type.includes('application/json') &&
      /tiktok|aweme|item|detail|feed/i.test(url) &&
      jsonResponses.length < 20
    ) {
      try {
        const text = await response.text();
        if (text && text.length < 5_000_000) jsonResponses.push({ url, status: response.status(), text });
      } catch {}
    }
  } catch {}
});

let navigationError = null;
try {
  await page.goto(inputUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
} catch (error) {
  navigationError = String(error?.message ?? error);
}

await new Promise((resolve) => setTimeout(resolve, 12_000));

try {
  await page.evaluate(() => {
    const video = document.querySelector('video');
    if (video) {
      video.muted = true;
      void video.play().catch(() => {});
    }
  });
  await new Promise((resolve) => setTimeout(resolve, 5_000));
} catch {}

const pageUrl = page.url();
const dom = await page.evaluate(() => {
  const videoSources = [...document.querySelectorAll('video, video source')]
    .map((node) => node.currentSrc || node.src || node.getAttribute?.('src'))
    .filter(Boolean);
  const images = [...document.images]
    .map((img) => ({
      src: img.currentSrc || img.src,
      width: img.naturalWidth || 0,
      height: img.naturalHeight || 0,
      alt: img.alt || '',
    }))
    .filter((item) => item.src);

  const embeddedMedia = { videoUrls: [], imageUrls: [] };
  const seen = new Set();
  const push = (bucket, value) => {
    if (typeof value !== 'string' || !/^https?:\/\//.test(value) || seen.has(value)) return;
    seen.add(value);
    bucket.push(value.replaceAll('\\u002F', '/'));
  };
  const walk = (value, key = '', depth = 0) => {
    if (depth > 20 || value == null) return;
    if (typeof value === 'string') {
      if (/playaddr|downloadaddr|play_addr|download_addr|video/i.test(key) && /https?:/.test(value)) push(embeddedMedia.videoUrls, value);
      if (/image|cover|origin|url_list|urllist/i.test(key) && /https?:/.test(value)) push(embeddedMedia.imageUrls, value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item, key, depth + 1);
      return;
    }
    if (typeof value === 'object') {
      for (const [childKey, child] of Object.entries(value)) walk(child, childKey, depth + 1);
    }
  };
  for (const script of [...document.scripts]) {
    const id = script.id || '';
    if (!/__UNIVERSAL_DATA_FOR_REHYDRATION__|SIGI_STATE|NEXT_DATA/i.test(id)) continue;
    const text = script.textContent || '';
    try { walk(JSON.parse(text)); } catch {}
  }

  return {
    title: document.title,
    videoSources,
    images,
    embeddedMedia,
    bodyText: (document.body?.innerText || '').slice(0, 20_000),
  };
});

const html = await page.content();
await fs.writeFile(path.join(outDir, 'browser-page.html'), html);
try {
  await page.screenshot({ path: path.join(outDir, 'browser-page.png'), fullPage: true });
} catch {}
await fs.writeFile(path.join(outDir, 'browser-json-responses.json'), JSON.stringify(jsonResponses, null, 2));

const result = {
  inputUrl,
  pageUrl,
  navigationError,
  title: dom.title,
  videoSources: [...new Set(dom.videoSources)],
  mediaResponses: mediaResponses.filter((item, index, list) => list.findIndex((other) => other.url === item.url) === index),
  embeddedMedia: dom.embeddedMedia,
  visibleImages: dom.images,
  bodyText: dom.bodyText,
};
await fs.writeFile(path.join(outDir, 'browser-result.json'), JSON.stringify(result, null, 2));

const cookies = await page.cookies();
const cookieHeader = cookies.map(({ name, value }) => `${name}=${value}`).join('; ');
const candidateUrls = [...new Set([
  ...result.videoSources,
  ...result.mediaResponses.map((item) => item.url),
  ...result.embeddedMedia.videoUrls,
])].filter((url) => /^https?:\/\//.test(url) && !url.startsWith('blob:'));

async function download(url, destination, minimumBytes = 50_000) {
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      headers: {
        'user-agent': userAgent,
        'referer': pageUrl,
        'cookie': cookieHeader,
        'accept': '*/*',
      },
    });
    if (!response.ok) return false;
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length < minimumBytes) return false;
    await fs.writeFile(destination, bytes);
    return true;
  } catch {
    return false;
  }
}

let videoSaved = false;
for (let i = 0; i < Math.min(candidateUrls.length, 20); i++) {
  const url = candidateUrls[i];
  if (await download(url, path.join(outDir, 'reference.browser'))) {
    videoSaved = true;
    break;
  }
}

let imageCount = 0;
if (!videoSaved) {
  const imageCandidates = [...new Set([
    ...result.embeddedMedia.imageUrls,
    ...result.visibleImages
      .filter((item) => item.width >= 300 && item.height >= 300)
      .map((item) => item.src),
  ])].filter((url) => /^https?:\/\//.test(url) && !url.startsWith('data:'));

  for (const url of imageCandidates.slice(0, 30)) {
    const next = imageCount + 1;
    const destination = path.join(imageDir, `image_${String(next).padStart(3, '0')}.jpg`);
    if (await download(url, destination, 10_000)) imageCount = next;
  }
}

await browser.close();
console.log(JSON.stringify({ pageUrl, videoSaved, imageCount, candidateVideoCount: candidateUrls.length, title: dom.title }, null, 2));
