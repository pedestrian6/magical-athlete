import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import type { RoomView } from '../../src/session/protocol';

test.setTimeout(120_000);
async function client(browser: Browser, baseURL: string) {
  const context = await browser.newContext({ baseURL, viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  const rooms: RoomView[] = [];
  page.on('websocket', socket => socket.on('framereceived', frame => {
    const data = String(frame.payload);
    if(!data.startsWith('42')) return;
    try { const message = JSON.parse(data.slice(2)); if(message[0] === 'room') rooms.push(message[1]); } catch { /* Engine.IO control frame */ }
  }));
  return { context, page, rooms };
}
async function create(page: Page) {
  await page.goto('/'); await page.getByTestId('online-mode').click();
  await page.getByLabel('联机昵称').fill('星星'); await page.getByRole('button', { name: /^2\s*人$/ }).click();
  await page.getByTestId('online-create').click();
  const recovery = await page.getByTestId('recovery-code').innerText();
  await page.getByRole('button', { name: '我已保存，进入房间 →' }).click();
  await expect(page.getByTestId('room-lobby')).toBeVisible();
  return { code: new URL(page.url()).searchParams.get('room')!, recovery };
}
async function join(page: Page, code: string) {
  await page.goto(`/?room=${code}`); await page.getByLabel('联机昵称').fill('月亮');
  await page.getByTestId('online-join').click(); await expect(page.getByTestId('recovery-code')).toBeVisible();
  await page.getByRole('button', { name: '我已保存，进入房间 →' }).click();
  await expect(page.getByTestId('room-lobby')).toBeVisible();
}
async function waitRevision(pages: Page[], revision: string | null) {
  for(const page of pages) {
    await expect.poll(() => page.getByTestId('game').getAttribute('data-revision')).not.toBe(revision);
    await expect(page.locator('.connection-state')).toHaveText('已连接 · 服务端自动保存');
  }
}

test('好友联机：两个独立浏览器私密选角、刷新恢复并完成四场', async ({ browser, baseURL }) => {
  const a = await client(browser, baseURL!), b = await client(browser, baseURL!);
  const errors: string[] = []; [a.page,b.page].forEach(page => page.on('pageerror', error => errors.push(error.message)));
  try {
    const { code } = await create(a.page); await join(b.page, code);
    await a.page.screenshot({ path: 'tmp/online-lobby-1280.png', fullPage: true });
    await a.page.getByTestId('room-ready').click(); await b.page.getByTestId('room-ready').click();
    await a.page.getByTestId('room-start').click();
    const pages = [a.page,b.page];
    for(const page of pages) { await expect(page.getByTestId('game')).toBeVisible(); await page.getByLabel('动画速度').selectOption('off'); }
    let refreshed = false, testedPrivacy = false, testedReconnect = false;
    for(let step = 0; step < 1800; step++) {
      const phase = await a.page.getByTestId('game').getAttribute('data-phase');
      if(phase === 'gameEnd') break;
      const revision = await a.page.getByTestId('game').getAttribute('data-revision');
      if(phase === 'draft') {
        for(const page of pages) { const card = page.locator('[data-testid^="draft-card-"]').first(); if(await card.isEnabled()) { await card.click(); break; } }
      } else if(phase === 'selection') {
        // Both players can choose on their own screens, without same-machine curtains.
        for(const page of pages) { await expect(page.getByTestId('handoff')).toHaveCount(0); const cards = page.locator('[data-testid^="select-card-"]'); await cards.nth(0).click(); await cards.nth(1).click(); }
        await a.page.getByTestId('confirm-selection').click(); await expect(a.page.getByTestId('selection-locked')).toBeVisible();
        if(!testedPrivacy) {
          await expect(b.page.getByTestId('confirm-selection')).toBeEnabled();
          const latest = b.rooms.at(-1)!; expect(latest.game?.selections[0]).toBeUndefined();
          for(const secret of ['rng','deck','queue','chainSeen','processedActions']) expect(latest.game).not.toHaveProperty(secret);
          expect(latest.game?.id).not.toMatch(/^game-\d+$/); testedPrivacy = true;
        }
        if(!refreshed) {
          await a.page.reload(); await expect(a.page.getByTestId('selection-locked')).toBeVisible(); await a.page.getByLabel('动画速度').selectOption('off'); refreshed = true;
        }
        await b.page.getByTestId('confirm-selection').click();
        for(const page of pages) await expect(page.getByTestId('game')).toHaveAttribute('data-phase', 'reveal');
      } else if(phase === 'reveal' || phase === 'raceEnd') {
        const id = phase === 'reveal' ? 'reveal-race' : 'next-race';
        for(const page of pages) if(await page.getByTestId(id).isEnabled()) { await page.getByTestId(id).click(); break; }
      } else if(phase === 'race') {
        if(!testedReconnect) {
          await a.page.getByLabel('动画速度').selectOption('normal'); await b.page.getByLabel('动画速度').selectOption('fast');
          await b.context.setOffline(true); await expect(b.page.locator('.connection-state')).toHaveClass(/offline/);
          await expect(b.page.locator('[data-testid="roll"]:enabled, [data-testid^="choice-"]:enabled')).toHaveCount(0);
          await b.context.setOffline(false); await expect(b.page.locator('.connection-state')).toHaveClass(/connected/);
          await expect(b.page.getByTestId('game')).toHaveAttribute('data-revision', revision!);
        }
        let operated = false;
        for(const page of pages) {
          const choices = page.locator('[data-testid^="choice-"]:enabled');
          if(await choices.count()) {
            const skip = page.getByTestId('choice-skip'), keep = page.getByTestId('choice-keep');
            await (await skip.count() && await skip.isEnabled() ? skip : await keep.count() && await keep.isEnabled() ? keep : choices.first()).click(); operated = true; break;
          }
          const continuation = page.getByRole('button', { name: '继续结算 →', exact: true });
          if(await continuation.count() && await continuation.isEnabled()) { await continuation.click(); operated = true; break; }
          const roll = page.getByTestId('roll'); if(await roll.count() && await roll.isEnabled()) { await roll.click(); operated = true; break; }
        }
        expect(operated, 'Exactly one seated player should have a legal action').toBe(true);
      } else throw new Error(`Unexpected phase ${phase}`);
      await waitRevision(pages, revision);
      if(phase === 'race' && !testedReconnect) {
        // The same authoritative action may animate at different local speeds.
        for(const page of pages) await expect(page.getByTestId('game')).toHaveAttribute('data-animating', 'false');
        const snapshotA = a.rooms.at(-1)!.game!, snapshotB = b.rooms.at(-1)!.game!;
        expect(snapshotA.racers).toEqual(snapshotB.racers); expect(snapshotA.players).toEqual(snapshotB.players);
        await a.page.screenshot({ path: 'tmp/online-race-1280.png', fullPage: true });
        for(const page of pages) await page.getByLabel('动画速度').selectOption('off');
        testedReconnect = true;
      }
    }
    for(const page of pages) {
      await expect(page.getByTestId('game-over')).toBeVisible(); await expect(page.getByRole('alert')).toHaveCount(0);
      await expect(page.locator('.online-turn-notice')).toHaveText('比赛已完成');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    expect(await a.page.locator('.final-ranking').innerText()).toBe(await b.page.locator('.final-ranking').innerText());
    expect(errors).toEqual([]);
    await a.page.screenshot({ path: 'tmp/online-finish-1280.png', fullPage: true });
  } finally { await a.context.close(); await b.context.close(); }
});

test('恢复码换电脑使旧设备和旧码失效，新标签替换操作端', async ({ browser, baseURL }) => {
  const original = await client(browser, baseURL!), replacement = await client(browser, baseURL!);
  let third: BrowserContext | null = null;
  try {
    const { code, recovery } = await create(original.page);
    await replacement.page.goto(`/?room=${code}`); await replacement.page.getByRole('button', { name: '找回座位', exact: true }).click();
    await replacement.page.getByLabel('个人恢复码', { exact: true }).fill(recovery); await replacement.page.getByTestId('online-recover').click();
    const renewed = await replacement.page.getByTestId('recovery-code').innerText(); expect(renewed).not.toBe(recovery);
    await replacement.page.getByRole('button', { name: '我已保存，进入房间 →' }).click();
    await expect(original.page.locator('.connection-state')).toHaveClass(/revoked/); await expect(original.page.getByTestId('room-ready')).toBeDisabled();
    const secondTab = await replacement.context.newPage(); await secondTab.goto(`/?room=${code}`);
    await expect(secondTab.getByTestId('room-ready')).toBeEnabled(); await expect(replacement.page.locator('.connection-state')).toHaveClass(/revoked/);
    await secondTab.getByTestId('room-ready').click(); await expect(secondTab.getByTestId('room-ready')).toHaveText('取消准备');
    third = await browser.newContext({ baseURL });
    await third.request.get('/api/session'); const response = await third.request.post(`/api/rooms/${code}/recover`, { data: { recoveryCode: recovery }, headers: { Origin: baseURL! } });
    expect(response.status()).toBe(403); expect((await response.json()).code).toBe('AUTH');
  } finally { await original.context.close(); await replacement.context.close(); await third?.close(); }
});
