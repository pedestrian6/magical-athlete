import { test, expect, type Page } from '@playwright/test';

// Explicit opt-in: normal test runs must never create public rooms.
test.skip(process.env.PUBLIC_SMOKE !== '1', 'Set PUBLIC_SMOKE=1 and BASE_URL to run the deployment smoke test.');
test.setTimeout(115_000);
// Do not capture recovery codes in traces or failure screenshots.
test.use({ trace: 'off', screenshot: 'off' });

async function settled(pages: Page[], oldRevision?: string | null) {
  for(const page of pages) {
    await expect(page.getByTestId('game')).toBeVisible();
    if(oldRevision !== undefined) await expect.poll(() => page.getByTestId('game').getAttribute('data-revision')).not.toBe(oldRevision);
    await expect(page.locator('.connection-state')).toHaveText('已连接 · 服务端自动保存');
  }
  await expect.poll(async () => (await pages[0].getByTestId('game').getAttribute('data-revision')) === (await pages[1].getByTestId('game').getAttribute('data-revision'))).toBe(true);
}

async function publicBoard(page: Page) {
  return page.evaluate(() => ({
    revision: document.querySelector('[data-testid="game"]')?.getAttribute('data-revision'),
    phase: document.querySelector('[data-testid="game"]')?.getAttribute('data-phase'),
    pawns: [...document.querySelectorAll<HTMLElement>('[data-pawn]')].map(pawn => ({ id: pawn.dataset.pawn, space: pawn.closest('[data-testid^="space-"]')?.getAttribute('data-testid') })).sort((a,b) => String(a.id).localeCompare(String(b.id))),
    scores: [...document.querySelectorAll('.player-row .score')].map(el => el.textContent),
  }));
}

test('公网部署冒烟：两人同步、同时选角、刷新与断线恢复并关闭测试房间', async ({ browser, baseURL }) => {
  expect(process.env.BASE_URL, 'Explicit BASE_URL is required for deployment smoke tests').toBeTruthy();
  const contexts = await Promise.all([0,1].map(() => browser.newContext({ baseURL, viewport: { width: 1280, height: 720 } })));
  const pages = await Promise.all(contexts.map(context => context.newPage()));
  const [host, guest] = pages;
  pages.forEach(page => {
    page.setDefaultTimeout(12_000);
    // Public TLS/DNS navigation can take longer than an in-page action.
    page.setDefaultNavigationTimeout(30_000);
  });
  let code: string | null = null;
  try {
    await host.goto('/'); await host.getByTestId('online-mode').click();
    await host.getByLabel('联机昵称').fill('部署验证甲'); await host.getByRole('button', { name: /^2\s*人$/ }).click();
    await host.getByTestId('online-create').click();
    // Dismiss without reading, copying, downloading, or logging the recovery code.
    await host.getByRole('button', { name: '我已保存，进入房间 →' }).click();
    await expect(host.getByTestId('room-lobby')).toBeVisible();
    code = new URL(host.url()).searchParams.get('room'); expect(code).toBeTruthy();
    await guest.goto(`/?room=${code}`); await guest.getByLabel('联机昵称').fill('部署验证乙');
    await guest.getByTestId('online-join').click(); await guest.getByRole('button', { name: '我已保存，进入房间 →' }).click();
    await expect(guest.getByTestId('room-lobby')).toBeVisible();
    await Promise.all(pages.map(page => page.getByTestId('room-ready').click()));
    await host.getByTestId('room-start').click(); await settled(pages);
    await Promise.all(pages.map(page => page.getByLabel('动画速度').selectOption('off')));

    for(let turn = 0; turn < 40 && await host.getByTestId('game').getAttribute('data-phase') === 'draft'; turn++) {
      const revision = await host.getByTestId('game').getAttribute('data-revision');
      let picked = false;
      for(const page of pages) {
        const card = page.locator('[data-testid^="draft-card-"]:enabled').first();
        if(await card.count()) { await card.click(); picked = true; break; }
      }
      expect(picked, 'One seated player must own the draft action').toBe(true);
      await settled(pages, revision);
    }
    for(const page of pages) {
      await expect(page.getByTestId('game')).toHaveAttribute('data-phase', 'selection');
      await expect(page.getByTestId('handoff')).toHaveCount(0);
      const cards = page.locator('[data-testid^="select-card-"]'); await cards.nth(0).click(); await cards.nth(1).click();
    }
    await Promise.all(pages.map(page => page.getByTestId('confirm-selection').click()));
    for(const page of pages) await expect(page.getByTestId('game')).toHaveAttribute('data-phase', 'reveal');
    await host.getByTestId('reveal-race').click(); await settled(pages);
    for(const page of pages) await expect(page.getByTestId('game')).toHaveAttribute('data-phase', 'race');

    const revision = await host.getByTestId('game').getAttribute('data-revision');
    let operated = false;
    for(const page of pages) {
      const choices = page.locator('[data-testid^="choice-"]:enabled');
      if(await choices.count()) { await choices.first().click(); operated = true; break; }
      const roll = page.locator('[data-testid="roll"]:enabled');
      if(await roll.count()) { await roll.click(); operated = true; break; }
      const continuation = page.getByRole('button', { name: '继续结算 →', exact: true });
      if(await continuation.count() && await continuation.isEnabled()) { await continuation.click(); operated = true; break; }
    }
    expect(operated, 'An authenticated player must be able to perform the authoritative action').toBe(true);
    await settled(pages, revision); expect(await publicBoard(host)).toEqual(await publicBoard(guest));
    const savedBoard = await publicBoard(host);

    await host.reload(); await settled(pages); expect(await publicBoard(host)).toEqual(savedBoard);
    await contexts[1].setOffline(true); await expect(guest.locator('.connection-state')).toHaveClass(/offline/);
    await expect(guest.locator('[data-testid="roll"]:enabled, [data-testid^="choice-"]:enabled')).toHaveCount(0);
    await contexts[1].setOffline(false); await settled(pages); expect(await publicBoard(guest)).toEqual(savedBoard);
    for(const page of pages) await expect(page.getByRole('alert')).toHaveCount(0);
  } finally {
    try {
      await Promise.all(contexts.map(context => context.setOffline(false)));
      // A failed later assertion must not leave the public test room open.
      code ??= new URL(host.url()).searchParams.get('room');
      if(code) {
        let closed = false;
        for(const page of pages) {
          const close = page.getByRole('button', { name: '结束房间', exact: true });
          if(await close.count()) {
            const dismiss = page.getByRole('button', { name: '我已保存，进入房间 →' });
            if(await dismiss.count()) await dismiss.click();
            page.once('dialog', dialog => dialog.accept()); await close.click();
            await expect(page.getByRole('heading', { name: '房间已结束', exact: true })).toBeVisible();
            closed = true; break;
          }
        }
        expect(closed, `Test room ${code} must be closed by its host`).toBe(true);
      }
    } finally { await Promise.all(contexts.map(context => context.close())); }
  }
});
