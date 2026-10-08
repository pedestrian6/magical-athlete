import { existsSync } from 'node:fs';
import { defineConfig } from '@playwright/test';
const systemChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const executablePath = process.env.CHROME_PATH || (process.platform === 'darwin' && existsSync(systemChrome) ? systemChrome : undefined);
export default defineConfig({testDir:'tests/browser',timeout:120000,workers:1,use:{baseURL:process.env.BASE_URL || 'http://127.0.0.1:5173',headless:true,launchOptions:{executablePath},viewport:{width:1440,height:1000},screenshot:'only-on-failure',trace:'retain-on-failure'},reporter:'list'});
