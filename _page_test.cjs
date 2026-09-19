"use strict";
const puppeteer = require('puppeteer-core');

const URL = process.argv[2] || 'http://localhost:8765';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const WAIT_MS = Number(process.env.WAIT_MS || 30000);

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--mute-audio'],
    defaultViewport: { width: 1600, height: 900 },
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text().slice(0, 200)); });

  await page.goto(URL, { waitUntil: 'networkidle2', timeout: 45000 });
  await new Promise((r) => setTimeout(r, WAIT_MS));

  const report = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('#grid .card')];
    return {
      cards: cards.map((c) => ({
        name: c.querySelector('.name') && c.querySelector('.name').textContent,
        badge: c.querySelector('.badge') && c.querySelector('.badge').textContent,
        overlayShown: c.querySelector('.overlay') ? c.querySelector('.overlay').classList.contains('show') : null,
        hasIframe: !!c.querySelector('.video iframe'),
      })),
      syncChip: document.getElementById('syncChip') && document.getElementById('syncChip').textContent,
      apiReady: !!(window.YT && window.YT.Player),
      dbg: (window.__dbg && window.__dbg.events) || [],
      docHeight: document.documentElement.scrollHeight,
      viewport: window.innerHeight,
      fitsViewport: document.documentElement.scrollHeight <= window.innerHeight + 2,
    };
  });

  console.log(JSON.stringify(report, null, 2));
  console.log('--- errors ---');
  console.log(errors.length ? errors.join('\n') : '(none)');
  await page.screenshot({ path: '_page_result.png' });
  await browser.close();
})().catch((e) => { console.error('TEST FAIL', e.message); process.exit(1); });
