import { test, expect } from '@playwright/test';
test('本机多人：招募、私密交接、四场、刷新恢复、导入导出',async({page})=>{
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('/');await expect(page.getByRole('heading',{name:'准备开赛'})).toBeVisible();
 await page.screenshot({path:'tmp/home-1440.png',fullPage:true});
 await page.getByRole('button',{name:/^3\s*人$/}).click();
 await page.getByTestId('start-game').click();
 await page.getByLabel('动画速度').selectOption('off');
 let n=0;
 while(await page.getByTestId('game').getAttribute('data-phase')==='draft'){
  await page.locator('[data-testid^="draft-card-"]').first().click();if(++n>20)throw new Error('招募未结束');
 }
 await expect(page.getByTestId('handoff')).toBeVisible();
 await page.screenshot({path:'tmp/handoff.png',fullPage:true});
 await page.getByTestId('handoff-continue').click();
 const selected=await page.locator('[data-testid^="select-card-"]').first().getAttribute('data-testid');
 await page.locator('[data-testid^="select-card-"]').first().click();await page.getByTestId('confirm-selection').click();
 await expect(page.getByTestId('handoff')).toBeVisible();
 await expect(page.getByText('已自动保存',{exact:true})).toBeVisible();
 await page.reload();await page.getByTestId('resume-game').click();await page.getByLabel('动画速度').selectOption('off');await expect(page.getByTestId('handoff')).toBeVisible();
 let moves=0,shot=false;
 while(moves++<2000){
  const phase=await page.getByTestId('game').getAttribute('data-phase');
  if(phase==='gameEnd')break;
  if(phase==='selection'){
   await page.getByTestId('handoff-continue').click();await page.locator('[data-testid^="select-card-"]').first().click();await page.getByTestId('confirm-selection').click();
  }else if(phase==='reveal'){await page.getByTestId('reveal-race').click();}
  else if(phase==='raceEnd'){await page.getByTestId('next-race').click();}
  else if(phase==='race'){
   if(!shot){await page.screenshot({path:'tmp/board-1440.png',fullPage:true});shot=true;}
   const choices=page.locator('[data-testid^="choice-"]');
   if(await choices.count()){
    const skip=page.getByTestId('choice-skip'),keep=page.getByTestId('choice-keep');
    await (await skip.count()?skip:await keep.count()?keep:choices.first()).click();
   }else if(await page.getByRole('button',{name:'继续结算 →',exact:true}).count())await page.getByRole('button',{name:'继续结算 →',exact:true}).click();
   else await page.getByTestId('roll').click();
  }else throw new Error(`Unexpected phase ${phase}`);
 }
 await expect(page.getByTestId('game-over')).toBeVisible();await expect(page.getByRole('alert')).toHaveCount(0);
 await expect(page.getByText('已自动保存',{exact:true})).toBeVisible();
 const dl=page.waitForEvent('download');await page.getByRole('button',{name:'保存比赛记录',exact:true}).click();const download=await dl;await download.saveAs('tmp/browser-save.json');
 page.once('dialog',dialog=>dialog.accept());await page.getByTestId('import-file').setInputFiles('tmp/browser-save.json');await expect(page.getByTestId('game-over')).toBeVisible();
 await page.screenshot({path:'tmp/results.png',fullPage:true});
 expect(errors).toEqual([]);
});
test('1280×720 布局与图库不溢出',async({page})=>{
 await page.setViewportSize({width:1280,height:720});await page.goto('/');await page.screenshot({path:'tmp/home-1280.png',fullPage:true});
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
 await page.getByRole('button',{name:'角色图鉴 36'}).click();await expect(page.getByRole('dialog',{name:'角色图鉴'})).toBeVisible();
 await expect(page.locator('.gallery .racer-card')).toHaveCount(36);await page.getByLabel('搜索角色').fill('Alchemist');await expect(page.locator('.gallery .racer-card')).toHaveCount(1);
});

test('技能待决刷新恢复、实际棋子动画与骰子保留',async({page})=>{
 const {createGame}=await import('../../src/game/engine');
 const {exportGame}=await import('../../src/session/storage');
 const s=createGame({names:['甲','乙','丙'],seed:1});
 const ids=['alchemist','twin','coach'];
 s.phase='race';s.firstPlayer=0;s.market=[];s.deck=s.deck.filter(id=>!ids.includes(id));s.draftOrder=[];s.draftIndex=0;s.rng=1;
 s.players.forEach((p,i)=>{p.team=[ids[i]];p.used=[ids[i]];});s.selections={0:['alchemist'],1:['twin'],2:['coach']};
 s.racers=ids.map((id,i)=>({id,playerId:i,position:i?10:0,tripped:false,finished:null,eliminated:false,power:id,eggBonus:false}));s.turnOrder=ids;s.events=[];
 s.turn={actor:'alchemist',number:1,stage:'ready',rolled:null,startPosition:0,rollCount:0,usedMerchants:[],modifiers:0,nextOverride:[]};
 await page.goto('/');await page.getByTestId('import-file').setInputFiles({name:'test-save.json',mimeType:'application/json',buffer:Buffer.from(exportGame(s))});
 await page.setViewportSize({width:1280,height:720});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:'tmp/board-1280.png',fullPage:true});
 await page.getByLabel('动画速度').selectOption('off');await page.getByTestId('roll').click();
 await expect(page.getByTestId('choice-yes')).toBeVisible();await expect(page.getByText('已自动保存',{exact:true})).toBeVisible();
 await page.reload();await page.getByTestId('resume-game').click();await expect(page.getByTestId('choice-yes')).toBeVisible();
 await page.getByLabel('动画速度').selectOption('normal');await page.getByTestId('choice-yes').click();
 await expect.poll(()=>page.evaluate(()=>document.querySelector('[data-pawn="alchemist"]')?.getAnimations().length??0),{timeout:5000,intervals:[30]}).toBeGreaterThan(0);
 await expect(page.getByTestId('roll')).toBeEnabled();await expect(page.getByTestId('space-4').locator('[data-pawn="alchemist"]')).toHaveCount(1);
 await expect(page.getByRole('img',{name:'骰子 1 点'})).toBeVisible();
});
