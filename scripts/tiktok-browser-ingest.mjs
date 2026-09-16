#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import puppeteer from 'puppeteer-core';

const inputUrl = process.argv[2];
const outDir = process.argv[3] ?? 'output/reference';
const explicitPostId = process.argv[4] ?? '';
if (!inputUrl) {
  console.error('usage: node scripts/tiktok-browser-ingest.mjs <url> [outDir] [postId]');
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
  try { await fs.access(candidate); executablePath = candidate; break; } catch {}
}
if (!executablePath) throw new Error('No Chrome/Chromium executable found');

const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
const browser = await puppeteer.launch({
  executablePath,
  headless: true,
  args: [
    '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
    '--disable-blink-features=AutomationControlled',
    '--autoplay-policy=no-user-gesture-required', '--window-size=430,932',
  ],
});

const ignoredVideo = (url) => /(?:webapp-desktop\/playback\d*\.mp4|\/download\/apk_new_|obj\/eden-.*\/download\/apk_)/i.test(url);
const unique = (values) => [...new Set(values.filter(Boolean))];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function configurePage(page) {
  await page.setViewport({ width: 430, height: 932, deviceScaleFactor: 1 });
  await page.setUserAgent(userAgent);
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9', 'Sec-CH-UA-Platform': '"Windows"' });
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
  });
}

async function inspectDom(page, postId) {
  return page.evaluate((wantedId) => {
    const videoSources = [...document.querySelectorAll('video, video source')]
      .map((node) => node.currentSrc || node.src || node.getAttribute?.('src')).filter(Boolean);
    const images = [...document.images].map((img) => ({
      src: img.currentSrc || img.src,
      width: img.naturalWidth || 0,
      height: img.naturalHeight || 0,
      alt: img.alt || '',
    })).filter((item) => item.src);

    const postMedia = { videoUrls: [], imageUrls: [], matchedObjects: 0 };
    const push = (bucket, value) => {
      if (typeof value !== 'string') return;
      const normalized = value.replaceAll('\\u002F', '/');
      if (/^https?:\/\//.test(normalized) && !bucket.includes(normalized)) bucket.push(normalized);
    };
    const matchesPost = (obj) => {
      if (!obj || typeof obj !== 'object' || Array.isArray(obj) || !wantedId) return false;
      return [obj.id, obj.itemId, obj.aweme_id, obj.awemeId]
        .some((value) => value != null && String(value) === String(wantedId));
    };
    const collectMedia = (value, key = '', depth = 0) => {
      if (depth > 20 || value == null) return;
      if (typeof value === 'string') {
        if (/playaddr|downloadaddr|play_addr|download_addr|url_list|urllist|playurl|video/i.test(key)) push(postMedia.videoUrls, value);
        if (/image|cover|origin|display_image|photo/i.test(key)) push(postMedia.imageUrls, value);
        return;
      }
      if (Array.isArray(value)) { for (const item of value) collectMedia(item, key, depth + 1); return; }
      if (typeof value === 'object') { for (const [childKey, child] of Object.entries(value)) collectMedia(child, childKey, depth + 1); }
    };
    const search = (value, depth = 0) => {
      if (depth > 25 || value == null) return;
      if (Array.isArray(value)) { for (const item of value) search(item, depth + 1); return; }
      if (typeof value !== 'object') return;
      if (matchesPost(value)) { postMedia.matchedObjects += 1; collectMedia(value); }
      for (const child of Object.values(value)) search(child, depth + 1);
    };

    for (const script of [...document.scripts]) {
      const id = script.id || '';
      if (!/__UNIVERSAL_DATA_FOR_REHYDRATION__|SIGI_STATE|NEXT_DATA/i.test(id)) continue;
      try { search(JSON.parse(script.textContent || '')); } catch {}
    }

    return {
      title: document.title,
      videoSources,
      images,
      postMedia,
      bodyText: (document.body?.innerText || '').slice(0, 20_000),
    };
  }, postId);
}

async function capture(url, label, postId) {
  const page = await browser.newPage();
  await configurePage(page);
  const mediaResponses = [];
  const jsonResponses = [];

  page.on('response', async (response) => {
    try {
      const responseUrl = response.url();
      const type = response.headers()['content-type'] ?? '';
      if ((type.startsWith('video/') || /(?:mime_type=video|video\/tos|playwm|\.mp4(?:\?|$)|\.m3u8(?:\?|$))/i.test(responseUrl)) && !ignoredVideo(responseUrl)) {
        mediaResponses.push({ url: responseUrl, type, status: response.status() });
      }
      if (type.includes('application/json') && /tiktok|aweme|item|detail|feed/i.test(responseUrl) && jsonResponses.length < 30) {
        try {
          const text = await response.text();
          if (text && text.length < 5_000_000) jsonResponses.push({ url: responseUrl, status: response.status(), text });
        } catch {}
      }
    } catch {}
  });

  let navigationError = null;
  try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 }); }
  catch (error) { navigationError = String(error?.message ?? error); }
  await sleep(10_000);
  try {
    await page.evaluate(() => {
      for (const video of document.querySelectorAll('video')) { video.muted = true; void video.play().catch(() => {}); }
    });
    await sleep(5_000);
  } catch {}

  const dom = await inspectDom(page, postId);
  const pageUrl = page.url();
  const html = await page.content();
  await fs.writeFile(path.join(outDir, `browser-${label}-page.html`), html);
  try { await page.screenshot({ path: path.join(outDir, `browser-${label}-page.png`), fullPage: true }); } catch {}
  await fs.writeFile(path.join(outDir, `browser-${label}-json-responses.json`), JSON.stringify(jsonResponses, null, 2));
  const cookies = await page.cookies();
  await page.close();

  return {
    label, requestedUrl: url, pageUrl, navigationError, title: dom.title,
    videoSources: unique(dom.videoSources).filter((item) => !ignoredVideo(item)),
    mediaResponses: mediaResponses.filter((item, index, list) => list.findIndex((other) => other.url === item.url) === index),
    postMedia: dom.postMedia,
    visibleImages: dom.images,
    bodyText: dom.bodyText,
    cookies,
  };
}

const postId = explicitPostId || (inputUrl.match(/\/video\/(\d+)/)?.[1] ?? '');
const attempts = [];
attempts.push(await capture(inputUrl, 'full', postId));

let candidateVideoUrls = unique(attempts.flatMap((attempt) => [
  ...attempt.videoSources,
  ...attempt.mediaResponses.map((item) => item.url),
  ...attempt.postMedia.videoUrls,
])).filter((url) => /^https?:\/\//.test(url) && !ignoredVideo(url));

if (!candidateVideoUrls.length && postId) {
  attempts.push(await capture(`https://www.tiktok.com/embed/v2/${postId}`, 'embed', postId));
  candidateVideoUrls = unique(attempts.flatMap((attempt) => [
    ...attempt.videoSources,
    ...attempt.mediaResponses.map((item) => item.url),
    ...attempt.postMedia.videoUrls,
  ])).filter((url) => /^https?:\/\//.test(url) && !ignoredVideo(url));
}

const result = { inputUrl, postId, attempts, candidateVideoUrls };
await fs.writeFile(path.join(outDir, 'browser-result.json'), JSON.stringify(result, null, 2));

async function download(url, destination, attempt, minimumBytes = 50_000) {
  try {
    const cookieHeader = attempt.cookies.map(({ name, value }) => `${name}=${value}`).join('; ');
    const response = await fetch(url, {
      redirect: 'follow',
      headers: { 'user-agent': userAgent, 'referer': attempt.pageUrl, 'cookie': cookieHeader, 'accept': '*/*' },
    });
    if (!response.ok) return false;
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length < minimumBytes) return false;
    await fs.writeFile(destination, bytes);
    return true;
  } catch { return false; }
}

let videoSaved = false;
for (const url of candidateVideoUrls.slice(0, 25)) {
  const attempt = attempts.find((candidate) => candidate.videoSources.includes(url) || candidate.mediaResponses.some((item) => item.url === url) || candidate.postMedia.videoUrls.includes(url)) ?? attempts.at(-1);
  if (await download(url, path.join(outDir, 'reference.browser'), attempt)) { videoSaved = true; break; }
}

let imageCount = 0;
if (!videoSaved) {
  const imageCandidates = unique(attempts.flatMap((attempt) => [
    ...attempt.postMedia.imageUrls,
    ...attempt.visibleImages.filter((item) => item.width >= 500 && item.height >= 500).map((item) => item.src),
  ])).filter((url) => /^https?:\/\//.test(url) && !url.startsWith('data:'));

  for (const url of imageCandidates.slice(0, 30)) {
    const attempt = attempts.find((candidate) => candidate.postMedia.imageUrls.includes(url) || candidate.visibleImages.some((item) => item.src === url)) ?? attempts.at(-1);
    const destination = path.join(imageDir, `image_${String(imageCount + 1).padStart(3, '0')}.jpg`);
    if (await download(url, destination, attempt, 10_000)) imageCount += 1;
  }
}

await browser.close();
console.log(JSON.stringify({ postId, videoSaved, imageCount, candidateVideoCount: candidateVideoUrls.length, attempts: attempts.map(({ label, pageUrl, title, postMedia }) => ({ label, pageUrl, title, matchedPostObjects: postMedia.matchedObjects })) }, null, 2));
