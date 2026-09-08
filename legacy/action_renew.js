const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const http = require('http');

const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;

// --- 辅助函数：转义 Telegram Markdown v1 特殊字符 ---
function escapeMarkdown(text) {
    return text.replace(/([_*`\[])/g, '\\$1');
}

// --- 辅助函数：发送 Telegram（图文合并为一条消息） ---
async function sendTelegramMessage(message, imagePath = null) {
    if (!TG_BOT_TOKEN || !TG_CHAT_ID) return;
    try {
        if (imagePath && fs.existsSync(imagePath)) {
            const FormData = require('form-data');
            const form = new FormData();
            form.append('chat_id', TG_CHAT_ID);
            form.append('photo', fs.createReadStream(imagePath));
            form.append('caption', message);
            form.append('parse_mode', 'Markdown');
            await axios.post(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendPhoto`, form, {
                headers: form.getHeaders()
            });
            console.log('[Telegram] Photo with caption sent.');
        } else {
            await axios.post(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
                chat_id: TG_CHAT_ID,
                text: message,
                parse_mode: 'Markdown'
            });
            console.log('[Telegram] Message sent.');
        }
    } catch (e) {
        console.error('[Telegram] Failed to send:', e.message);
    }
}

chromium.use(stealth);

const CHROME_PATH = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const DEBUG_PORT = 9222;
const VIEWPORT_WIDTH = 1280;
const VIEWPORT_HEIGHT = 720;
const RENEW_MAX_ATTEMPTS = 3;
process.env.NO_PROXY = 'localhost,127.0.0.1';

const HTTP_PROXY = process.env.HTTP_PROXY;
let PROXY_CONFIG = null;

if (HTTP_PROXY) {
    try {
        const proxyUrl = new URL(HTTP_PROXY);
        PROXY_CONFIG = {
            server: `${proxyUrl.protocol}//${proxyUrl.hostname}:${proxyUrl.port}`,
            username: proxyUrl.username ? decodeURIComponent(proxyUrl.username) : undefined,
            password: proxyUrl.password ? decodeURIComponent(proxyUrl.password) : undefined
        };
        console.log(`[代理] 检测到配置: 服务器=${PROXY_CONFIG.server}, 认证=${PROXY_CONFIG.username ? '是' : '否'}`);
    } catch (e) {
        console.error('[代理] HTTP_PROXY 格式无效。');
        process.exit(1);
    }
}

// --- 注入脚本：Hook Shadow DOM 获取 Turnstile 坐标 ---
const INJECTED_SCRIPT = `
(function() {
    if (window.self === window.top) return;
    try {
        function getRandomInt(min, max) {
            return Math.floor(Math.random() * (max - min + 1)) + min;
        }
        let screenX = getRandomInt(800, 1200);
        let screenY = getRandomInt(400, 600);
        Object.defineProperty(MouseEvent.prototype, 'screenX', { value: screenX });
        Object.defineProperty(MouseEvent.prototype, 'screenY', { value: screenY });
    } catch (e) { }

    try {
        const originalAttachShadow = Element.prototype.attachShadow;
        Element.prototype.attachShadow = function(init) {
            const shadowRoot = originalAttachShadow.call(this, init);
            if (shadowRoot) {
                const checkAndReport = () => {
                    const checkbox = shadowRoot.querySelector('input[type="checkbox"]');
                    if (checkbox) {
                        const rect = checkbox.getBoundingClientRect();
                        if (rect.width > 0 && rect.height > 0 && window.innerWidth > 0 && window.innerHeight > 0) {
                            const xRatio = (rect.left + rect.width / 2) / window.innerWidth;
                            const yRatio = (rect.top + rect.height / 2) / window.innerHeight;
                            window.__turnstile_data = { xRatio, yRatio };
                            return true;
                        }
                    }
                    return false;
                };
                if (!checkAndReport()) {
                    const observer = new MutationObserver(() => {
                        if (checkAndReport()) observer.disconnect();
                    });
                    observer.observe(shadowRoot, { childList: true, subtree: true });
                }
            }
            return shadowRoot;
        };
    } catch (e) {
        console.error('[注入] Hook attachShadow 失败:', e);
    }
})();
`;

async function checkProxy() {
    if (!PROXY_CONFIG) return true;
    console.log('[代理] 正在验证代理连接...');
    try {
        const axiosConfig = {
            proxy: {
                protocol: 'http',
                host: new URL(PROXY_CONFIG.server).hostname,
                port: parseInt(new URL(PROXY_CONFIG.server).port, 10),
            },
            timeout: 10000
        };
        if (PROXY_CONFIG.username && PROXY_CONFIG.password) {
            axiosConfig.proxy.auth = {
                username: PROXY_CONFIG.username,
                password: PROXY_CONFIG.password
            };
        }
        await axios.get('https://1.1.1.1', axiosConfig);
        console.log('[代理] 连接成功！');
        return true;
    } catch (error) {
        console.error(`[代理] 连接失败: ${error.message}`);
        return false;
    }
}

function checkPort(port) {
    return new Promise((resolve) => {
        const req = http.get(`http://localhost:${port}/json/version`, (res) => {
            res.resume();
            resolve(true);
        });
        req.on('error', () => resolve(false));
        req.setTimeout(3000, () => {
            req.destroy();
            resolve(false);
        });
    });
}

async function launchChrome() {
    console.log('检查 Chrome 是否已在端口 ' + DEBUG_PORT + ' 上运行...');
    if (await checkPort(DEBUG_PORT)) {
        console.log('Chrome 已开启。');
        return;
    }
    console.log(`正在启动 Chrome (路径: ${CHROME_PATH})...`);
    const args = [
        `--remote-debugging-port=${DEBUG_PORT}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-gpu',
        `--window-size=${VIEWPORT_WIDTH},${VIEWPORT_HEIGHT}`,
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--user-data-dir=/tmp/chrome_user_data',
        '--disable-dev-shm-usage'
    ];
    if (PROXY_CONFIG) {
        args.push(`--proxy-server=${PROXY_CONFIG.server}`);
        args.push('--proxy-bypass-list=<-loopback>');
    }
    const chrome = spawn(CHROME_PATH, args, {
        detached: true,
        stdio: 'ignore'
    });
    chrome.unref();
    console.log('正在等待 Chrome 初始化...');
    for (let i = 0; i < 20; i++) {
        if (await checkPort(DEBUG_PORT)) break;
        await new Promise(r => setTimeout(r, 1000));
    }
    if (!await checkPort(DEBUG_PORT)) {
        throw new Error('Chrome 启动失败');
    }
}

async function configurePageViewport(page) {
    try {
        await page.setViewportSize({ width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT });
        console.log(`[视口] 已设置为 ${VIEWPORT_WIDTH}x${VIEWPORT_HEIGHT}`);
    } catch (e) {
        console.log('[视口] 设置失败:', e.message);
    }
}

async function saveViewportScreenshot(page, imagePath) {
    await page.screenshot({ path: imagePath, fullPage: true });
}

function maskUsernameForLog(username) {
    const value = String(username || '').trim();
    if (!value) return '(empty)';

    const atIndex = value.indexOf('@');
    if (atIndex <= 1) {
        if (value.length <= 3) return `${value[0] || '*'}**`;
        return `${value.slice(0, 1)}***${value.slice(-1)}`;
    }

    const name = value.slice(0, atIndex);
    const domain = value.slice(atIndex + 1);
    const maskedName = name.length <= 2 ? `${name[0] || '*'}*` : `${name.slice(0, 2)}***`;
    return `${maskedName}@${domain}`;
}

function getUsers() {
    try {
        if (process.env.USERS_JSON) {
            const parsed = JSON.parse(process.env.USERS_JSON);
            let rawUsers = [];

            if (Array.isArray(parsed)) {
                rawUsers = parsed;
            } else if (parsed && Array.isArray(parsed.users)) {
                rawUsers = parsed.users;
            } else if (parsed && typeof parsed === 'object' && (parsed.username || parsed.password)) {
                rawUsers = [parsed];
            }

            const users = [];
            const seenUsernames = new Set();

            for (const entry of rawUsers) {
                if (!entry || typeof entry !== 'object') {
                    console.log('[用户配置] 跳过无效条目: 非对象。');
                    continue;
                }

                const username = String(entry.username || entry.email || '').trim();
                const password = String(entry.password || '').trim();

                if (!username || !password) {
                    console.log(`[用户配置] 跳过无效条目: username/password 不完整 (${maskUsernameForLog(username)})`);
                    continue;
                }

                const dedupeKey = username.toLowerCase();
                if (seenUsernames.has(dedupeKey)) {
                    console.log(`[用户配置] 跳过重复账号: ${maskUsernameForLog(username)}`);
                    continue;
                }

                seenUsernames.add(dedupeKey);
                users.push({ username, password });
            }

            console.log(`[用户配置] USERS_JSON 原始条目 ${rawUsers.length}，有效用户 ${users.length}`);
            if (users.length > 0) {
                console.log(`[用户配置] 本次执行账号: ${users.map((user) => maskUsernameForLog(user.username)).join(', ')}`);
            }

            return users;
        }
    } catch (e) {
        console.error('解析 USERS_JSON 环境变量错误:', e);
    }
    return [];
}

// --- 核心辅助：通过 CDP 派发鼠标点击事件 ---
async function dispatchCdpClick(page, x, y) {
    const client = await page.context().newCDPSession(page);
    try {
        await client.send('Input.dispatchMouseEvent', {
            type: 'mousePressed',
            x: x,
            y: y,
            button: 'left',
            clickCount: 1
        });
        await new Promise(r => setTimeout(r, 50 + Math.random() * 100)); // 模拟人手点击延迟
        await client.send('Input.dispatchMouseEvent', {
            type: 'mouseReleased',
            x: x,
            y: y,
            button: 'left',
            clickCount: 1
        });
        console.log(`>> CDP 坐标 (${x.toFixed(2)}, ${y.toFixed(2)}) 点击已发送。`);
        return true;
    } catch (e) {
        console.log('>> CDP 点击失败:', e.message);
        return false;
    } finally {
        await client.detach().catch(() => {});
    }
}

// ==========================================
// ========== 1. TURNSTILE 专区 (登录用) ========
// ==========================================
async function attemptTurnstileCdp(page) {
    const frames = page.frames();
    for (const frame of frames) {
        try {
            const data = await frame.evaluate(() => window.__turnstile_data).catch(() => null);
            if (data) {
                console.log('>> 发现 Turnstile 数据。比例:', data);
                await frame.evaluate(() => { window.__turnstile_data = null; }).catch(() => {});
                const iframeElement = await frame.frameElement();
                if (!iframeElement) continue;
                const box = await iframeElement.boundingBox();
                if (!box) continue;
                const clickX = box.x + (box.width * data.xRatio);
                const clickY = box.y + (box.height * data.yRatio);
                return await dispatchCdpClick(page, clickX, clickY);
            }
        } catch (e) { }
    }
    return false;
}

async function checkTurnstileSuccess(page) {
    try {
        const hasResponseToken = await page.locator('input[name="cf-turnstile-response"], textarea[name="cf-turnstile-response"]').evaluateAll(elements => {
            return elements.some(el => el.value && el.value.trim().length > 0);
        });
        if (hasResponseToken) return true;
    } catch (e) { }

    const frames = page.frames();
    for (const f of frames) {
        if (f.url().includes('cloudflare')) {
            try {
                if (await f.getByText('Success!', { exact: false }).isVisible({ timeout: 500 })) return true;
            } catch (e) { }
        }
    }
    return false;
}

async function hasTurnstileFrame(page) {
    try {
        const count = await page.locator('iframe[src*="challenges.cloudflare.com"], iframe[src*="turnstile"]').count();
        return count > 0;
    } catch (e) {
        return false;
    }
}

async function solveTurnstileIfPresent(page, stageName = "登录", maxAttempts = 10, waitAfterClick = 5000) {
    console.log(`[${stageName}] 开始检测 Cloudflare Turnstile...`);
    let sawTurnstile = false;
    for (let i = 0; i < maxAttempts; i++) {
        if (await hasTurnstileFrame(page)) sawTurnstile = true;

        if (await checkTurnstileSuccess(page)) {
            console.log(`[${stageName}] ✅ Turnstile 已通过验证。`);
            return true;
        }

        const clicked = await attemptTurnstileCdp(page);
        if (clicked) {
            sawTurnstile = true;
            console.log(`[${stageName}] 已点击 Turnstile，等待验证结果 (${waitAfterClick}ms)...`);
            await page.waitForTimeout(waitAfterClick);

            if (await checkTurnstileSuccess(page)) {
                console.log(`[${stageName}] ✅ Turnstile 验证通过！`);
                return true;
            }
            console.log(`[${stageName}] ⚠️ 点击后验证未通过，继续重试...`);
        }
        if (i < maxAttempts - 1) await page.waitForTimeout(1000);
    }
    if (!sawTurnstile) {
        console.log(`[${stageName}] 未检测到 Turnstile。`);
        return true;
    }
    console.log(`[${stageName}] 检测到 Turnstile，但未能通过验证。`);
    return false;
}


// ==========================================
// ========== 2. ALTCHA 专区 (Renew用) =========
// ==========================================
async function getAltchaStatus(page) {
    try {
        return await page.evaluate(() => {
            const normalize = (value) => {
                if (value == null) return '';
                return String(value).trim();
            };

            const widget = document.querySelector('altcha-widget');
            const altchaInputs = Array.from(document.querySelectorAll('input[name="altcha"], textarea[name="altcha"], input[name*="altcha" i], textarea[name*="altcha" i]'));
            const firstFilledInput = altchaInputs.find((input) => normalize(input.value).length > 0);
            const shadowRoot = widget ? widget.shadowRoot : null;
            const checkbox = shadowRoot ? shadowRoot.querySelector('input[type="checkbox"], [role="checkbox"]') : null;

            const stateProp = normalize(widget ? widget.state : '');
            const stateAttr = normalize(widget ? widget.getAttribute('state') : '');
            const valueProp = normalize(widget ? widget.value : '');
            const valueAttr = normalize(widget ? widget.getAttribute('value') : '');
            const hiddenInputValue = normalize(firstFilledInput ? firstFilledInput.value : '');
            const checkboxChecked = checkbox && typeof checkbox.checked === 'boolean' ? checkbox.checked : null;
            const ariaChecked = normalize(checkbox ? checkbox.getAttribute('aria-checked') : '');
            const busyAttr = normalize(widget ? widget.getAttribute('aria-busy') : '');
            const state = stateProp || stateAttr || '';
            const isSolved = state === 'verified' || valueProp.length > 0 || valueAttr.length > 0 || hiddenInputValue.length > 0;
            const isVerifying = !isSolved && (
                state === 'verifying' ||
                state === 'processing' ||
                state === 'working' ||
                checkboxChecked === true ||
                ariaChecked === 'true' ||
                busyAttr === 'true'
            );

            return {
                exists: !!widget || altchaInputs.length > 0,
                solved: isSolved,
                isVerifying,
                state: state || 'unknown',
                hasShadowRoot: !!shadowRoot,
                checkboxChecked,
                ariaChecked,
                valueLength: Math.max(valueProp.length, valueAttr.length),
                hiddenInputLength: hiddenInputValue.length,
                busy: busyAttr === 'true'
            };
        });
    } catch (e) {
        return {
            exists: false,
            solved: false,
            isVerifying: false,
            state: 'error',
            hasShadowRoot: false,
            checkboxChecked: null,
            ariaChecked: '',
            valueLength: 0,
            hiddenInputLength: 0,
            busy: false
        };
    }
}

function formatAltchaStatus(status) {
    const checkedText = status.checkboxChecked === null ? 'unknown' : String(status.checkboxChecked);
    const ariaChecked = status.ariaChecked || 'n/a';
    return `state=${status.state}, solved=${status.solved}, verifying=${status.isVerifying}, shadow=${status.hasShadowRoot}, checked=${checkedText}, ariaChecked=${ariaChecked}, valueLen=${status.valueLength}, hiddenLen=${status.hiddenInputLength}, busy=${status.busy}`;
}

async function checkAltchaSuccess(page) {
    const status = await getAltchaStatus(page);
    return status.solved;
}

async function attemptAltchaClick(page, currentStatus = null) {
    try {
        const altchaWidget = page.locator('altcha-widget').first();
        if (await altchaWidget.count() > 0) {

            const status = currentStatus || await getAltchaStatus(page);
            if (status.solved) return false;
            if (status.isVerifying) {
                console.log(`>> ALTCHA 正在验证中，跳过重复点击。${formatAltchaStatus(status)}`);
                return false;
            }

            await page.waitForTimeout(500);
            await altchaWidget.scrollIntoViewIfNeeded().catch(() => {});

            let boxInfo = await page.evaluate(() => {
                const widget = document.querySelector('altcha-widget');
                if (!widget) return null;

                const pickClickTarget = (root) => {
                    if (!root) return null;
                    return root.querySelector('input[type="checkbox"], [role="checkbox"], label, button');
                };

                if (widget.shadowRoot) {
                    const target = pickClickTarget(widget.shadowRoot);
                    if (target) {
                        const rect = target.getBoundingClientRect();
                        return { x: rect.left, y: rect.top, width: rect.width, height: rect.height, isExact: true, tagName: target.tagName };
                    }
                }

                const lightDomTarget = pickClickTarget(widget);
                if (lightDomTarget) {
                    const rect = lightDomTarget.getBoundingClientRect();
                    return { x: rect.left, y: rect.top, width: rect.width, height: rect.height, isExact: true, tagName: lightDomTarget.tagName };
                }

                const rect = widget.getBoundingClientRect();
                return { x: rect.left, y: rect.top, width: rect.width, height: rect.height, isExact: false, tagName: widget.tagName };
            });

            if (boxInfo && boxInfo.width > 0 && boxInfo.height > 0) {
                let clickX, clickY;
                if (boxInfo.isExact) {
                    clickX = boxInfo.x + boxInfo.width / 2;
                    clickY = boxInfo.y + boxInfo.height / 2;
                    console.log(`>> 发现 ALTCHA 内部点击目标 <${boxInfo.tagName}>，精确计算坐标: (${clickX.toFixed(2)}, ${clickY.toFixed(2)})`);
                } else {
                    clickX = boxInfo.x + Math.min(25, Math.max(12, boxInfo.width * 0.15));
                    clickY = boxInfo.y + boxInfo.height / 2;
                    console.log(`>> 未获取内部复选框，使用估算坐标: (${clickX.toFixed(2)}, ${clickY.toFixed(2)})`);
                }

                await dispatchCdpClick(page, clickX, clickY);

                await page.evaluate(() => {
                    const widget = document.querySelector('altcha-widget');
                    if (widget && widget.shadowRoot) {
                        const cb = widget.shadowRoot.querySelector('input[type="checkbox"]');
                        if (cb && !cb.checked) {
                            cb.click();
                        }
                    }
                });

                return true;
            } else {
                console.log('>> 找到了 ALTCHA 元素，但获取不到有效大小，跳过点击。');
            }
        }
    } catch (e) {
        console.log('>> 尝试查找 ALTCHA 时出错:', e.message);
    }
    return false;
}

async function solveAltchaIfPresent(page, stageName = "Renew阶段", maxAttempts = 15, waitAfterClick = 8000) {
    console.log(`[${stageName}] 开始检测 ALTCHA Captcha...`);
    let sawAltcha = false;

    const startedAt = Date.now();
    const totalWaitBudget = Math.max(waitAfterClick * maxAttempts, waitAfterClick);
    let clickAttempts = 0;
    let lastStatusText = '';

    while (Date.now() - startedAt < totalWaitBudget) {
        const status = await getAltchaStatus(page);
        if (status.exists) sawAltcha = true;

        const statusText = formatAltchaStatus(status);
        if (status.exists && statusText !== lastStatusText) {
            console.log(`[${stageName}] ALTCHA 状态: ${statusText}`);
            lastStatusText = statusText;
        }

        if (status.solved) {
            console.log(`[${stageName}] ✅ ALTCHA 已通过验证。`);
            return true;
        }

        if (!status.exists) {
            await page.waitForTimeout(1000);
            continue;
        }

        if (status.isVerifying) {
            await page.waitForTimeout(1000);
            continue;
        }

        if (clickAttempts >= maxAttempts) {
            console.log(`[${stageName}] 已达到 ALTCHA 最大点击次数 (${maxAttempts})，继续等待最终结果...`);
            await page.waitForTimeout(1000);
            continue;
        }

        const clicked = await attemptAltchaClick(page, status);
        if (!clicked) {
            await page.waitForTimeout(1000);
            continue;
        }

        clickAttempts += 1;
        console.log(`[${stageName}] 已点击 ALTCHA，等待 PoW 哈希计算完成 (${waitAfterClick}ms)，当前点击 ${clickAttempts}/${maxAttempts}...`);

        const clickStartedAt = Date.now();
        let observedVerification = false;

        while (Date.now() - clickStartedAt < waitAfterClick) {
            await page.waitForTimeout(1000);

            const followupStatus = await getAltchaStatus(page);
            if (followupStatus.exists) sawAltcha = true;

            const followupText = formatAltchaStatus(followupStatus);
            if (followupStatus.exists && followupText !== lastStatusText) {
                console.log(`[${stageName}] ALTCHA 状态: ${followupText}`);
                lastStatusText = followupText;
            }

            if (followupStatus.solved) {
                console.log(`[${stageName}] ✅ ALTCHA 验证通过 (PoW 计算完成)！`);
                return true;
            }

            if (followupStatus.isVerifying) {
                observedVerification = true;
                continue;
            }

            if (!observedVerification && Date.now() - clickStartedAt >= 2500) {
                console.log(`[${stageName}] ⚠️ 点击后未观察到 ALTCHA 进入 verifying 状态，准备重新尝试点击...`);
                break;
            }
        }
    }

    if (!sawAltcha) {
        console.log(`[${stageName}] 弹窗中未检测到 ALTCHA 组件。`);
        return true;
    }

    const finalStatus = await getAltchaStatus(page);
    console.log(`[${stageName}] 检测到 ALTCHA，但在 ${Math.ceil((Date.now() - startedAt) / 1000)} 秒内未能通过验证。最终状态: ${formatAltchaStatus(finalStatus)}`);
    return false;
}

// ==========================================
// =============== 主循环执行 =================
// ==========================================
(async () => {
    const users = getUsers();
    if (users.length === 0) {
        console.log('未在 process.env.USERS_JSON 中找到用户');
        process.exit(1);
    }

    if (PROXY_CONFIG) {
        if (!await checkProxy()) process.exit(1);
    }

    await launchChrome();

    console.log(`正在连接 Chrome...`);
    let browser;
    for (let k = 0; k < 5; k++) {
        try {
            browser = await chromium.connectOverCDP(`http://localhost:${DEBUG_PORT}`);
            console.log('连接成功！');
            break;
        } catch (e) {
            console.log(`连接尝试 ${k + 1} 失败。2秒后重试...`);
            await new Promise(r => setTimeout(r, 2000));
        }
    }
    if (!browser) process.exit(1);

    const context = browser.contexts()[0];
    if (!context) {
        console.error('无法获取浏览器上下文，退出。');
        await browser.close();
        process.exit(1);
    }
    let page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();
    page.setDefaultTimeout(60000);
    await configurePageViewport(page);

    // --- 代理认证处理 ---
    if (PROXY_CONFIG && PROXY_CONFIG.username) {
        console.log('[代理] 设置认证拦截...');
        await context.route('**/*', (route) => {
            route.continue({
                headers: {
                    ...route.request().headers(),
                    'Proxy-Authorization': 'Basic ' + Buffer.from(`${PROXY_CONFIG.username}:${PROXY_CONFIG.password}`).toString('base64')
                }
            });
        });
    }

    await page.addInitScript(INJECTED_SCRIPT);

    for (let i = 0; i < users.length; i++) {
        const user = users[i];
        console.log(`\n=== 正在处理用户 ${i + 1}/${users.length} ===`);

        try {
            if (page.isClosed()) {
                page = await context.newPage();
                await page.addInitScript(INJECTED_SCRIPT);
            }

            // 1. 先确保已登出，再访问登录页
            console.log('确保已登出...');
            if (page.url().includes('dashboard')) {
                await page.goto('https://dashboard.katabump.com/auth/logout');
                await page.waitForTimeout(2000);
            }
            await page.goto('https://dashboard.katabump.com/auth/login');
            await page.waitForTimeout(2000);
            
            // 如果访问登录页后被重定向到 dashboard，说明还有 session，先 logout
            if (page.url().includes('dashboard') && !page.url().includes('login')) {
                console.log('Session 仍然有效，正在登出...');
                await page.goto('https://dashboard.katabump.com/auth/logout');
                await page.waitForTimeout(2000);
                await page.goto('https://dashboard.katabump.com/auth/login');
                await page.waitForTimeout(2000);
            }
            
            await page.waitForTimeout(3000); 

            // ➡️ 【登录阶段专属】：解决 Turnstile
            await solveTurnstileIfPresent(page, "登录阶段", 10, 5000);

            console.log('正在输入凭据...');
            try {
                const emailInput = page.getByRole('textbox', { name: 'Email' });
                await emailInput.waitFor({ state: 'visible', timeout: 5000 });
                await emailInput.fill(user.username);
                
                const pwdInput = page.getByRole('textbox', { name: 'Password' });
                await pwdInput.fill(user.password);
                
                await page.waitForTimeout(500);
                await page.getByRole('button', { name: 'Login', exact: true }).click();

                // 检查登录错误
                try {
                    const errorMsg = page.getByText('Incorrect password or no account');
                    if (await errorMsg.isVisible({ timeout: 3000 })) {
                        console.error(`   >> ❌ 登录失败: 账号或密码错误`);
                        const failPhotoDir = path.join(process.cwd(), 'screenshots');
                        if (!fs.existsSync(failPhotoDir)) fs.mkdirSync(failPhotoDir, { recursive: true });
                        const failSafe = user.username.replace(/[^a-z0-9]/gi, '_');
                        const failScreenshot = path.join(failPhotoDir, `${failSafe}_login_fail.png`);
                        try { await saveViewportScreenshot(page, failScreenshot); } catch (e) {}
                        await sendTelegramMessage(`❌ *${escapeMarkdown(user.username)}*\n登录失败: 账号或密码错误`, failScreenshot);
                        continue;
                    }
                } catch (e) { }

            } catch (e) {
                console.log('登录操作遇到异常 (可能是已经登录或超时):', e.message);
            }

            // 2. 登录后的操作
            console.log('正在寻找 "See" 链接...');
            try {
                await page.getByRole('link', { name: 'See' }).first().waitFor({ timeout: 15000 });
                await page.waitForTimeout(1000);
                await page.getByRole('link', { name: 'See' }).first().click();
            } catch (e) {
                console.log('未找到 "See" 按钮 (可能登录未成功或界面变动)。');
                continue;
            }

            // 3. Renew 逻辑
            let renewSuccess = false;
            let renewFailureReason = `续期失败，${RENEW_MAX_ATTEMPTS}次尝试均未成功`;
            for (let attempt = 1; attempt <= RENEW_MAX_ATTEMPTS; attempt++) {
                if (page.url().includes('login')) {
                    console.log('页面被重定向到登录页，退出 Renew 循环。');
                    break;
                }

                console.log(`\n[尝试 ${attempt}/${RENEW_MAX_ATTEMPTS}] 正在寻找 Renew 按钮...`);
                const renewBtn = page.getByRole('button', { name: 'Renew', exact: true }).first();
                
                try { await renewBtn.waitFor({ state: 'visible', timeout: 5000 }); } catch (e) { }

                if (await renewBtn.isVisible()) {
                    await renewBtn.click();
                    console.log('Renew 按钮已点击。等待模态框...');

                    // 定位弹窗
                    const modal = page.locator('.modal-content, [role="dialog"]').filter({ hasText: 'Renew' }).first();
                    
                    try { await modal.waitFor({ state: 'visible', timeout: 5000 }); } catch (e) {
                        console.log('模态框未出现？重试中...');
                        continue;
                    }

                    // 晃动鼠标
                    try {
                        const box = await modal.boundingBox();
                        if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 5 });
                    } catch (e) { }

                    const confirmBtn = modal.getByRole('button', { name: 'Renew', exact: true });
                    if (await confirmBtn.isVisible()) {
                        
                        const photoDir = path.join(process.cwd(), 'screenshots');
                        if (!fs.existsSync(photoDir)) fs.mkdirSync(photoDir, { recursive: true });
                        const safeUsername = user.username.replace(/[^a-z0-9]/gi, '_');
                        const captchaScreenshotName = `${safeUsername}_ALTCHA_${attempt}.png`;
                        try {
                            await saveViewportScreenshot(page, path.join(photoDir, captchaScreenshotName));
                            console.log(`   >> 弹窗截图已保存: ${captchaScreenshotName}`);
                        } catch (e) {
                            console.log('   >> 截图失败:', e.message);
                        }
                        
                        // ➡️ 【Renew阶段专属】：只处理 ALTCHA Captcha，给 8 秒等待它的 PoW 后台计算
                        const altchaOk = await solveAltchaIfPresent(page, "Renew弹窗", 15, 8000);

                        if (!altchaOk) {
                            renewFailureReason = `续期失败，Renew 阶段 ALTCHA 未通过（已重试 ${RENEW_MAX_ATTEMPTS} 次）`;
                            console.log('   >> ALTCHA 未通过，跳过确认按钮并刷新重试...');
                            await page.reload();
                            await page.waitForTimeout(3000);
                            if (page.url().includes('login')) {
                                console.log('   >> 刷新后被重定向到登录页，退出。');
                                break;
                            }
                            continue;
                        }

                        console.log('   >> 点击弹窗中的 Renew 确认按钮...');
                        await confirmBtn.click();

                        let hasCaptchaError = false;
                        try {
                            const startVerifyTime = Date.now();
                            while (Date.now() - startVerifyTime < 3000) {
                                if (await page.getByText('Please complete the captcha to continue').isVisible()) {
                                    console.log('   >> ⚠️ 错误: "Please complete the captcha".');
                                    hasCaptchaError = true;
                                    break;
                                }
                                const notTimeLoc = page.getByText("You can't renew your server yet");
                                if (await notTimeLoc.isVisible()) {
                                    const text = await notTimeLoc.innerText().catch(() => '');
                                    const match = text.match(/as of\s+(.*?)\s+\(/);
                                    let dateStr = match ? match[1] : 'Unknown Date';
                                    console.log(`   >> ⏳ 暂无法续期 (还没到时间)。下次可续期: ${dateStr}`);
                                    renewSuccess = true;

                                    const skipScreenshot = path.join(photoDir, `${safeUsername}_skip.png`);
                                    let modalClosed = false;
                                    try {
                                        const closeBtn = modal.getByLabel('Close');
                                        if (await closeBtn.isVisible()) {
                                            await closeBtn.click();
                                            await modal.waitFor({ state: 'hidden', timeout: 3000 }).catch(() => {});
                                            await page.waitForTimeout(500);
                                            modalClosed = !await modal.isVisible().catch(() => false);
                                        }
                                    } catch (e) {}

                                    if (!modalClosed) {
                                        console.log('   >> Renew 弹窗未能完全关闭，使用当前页面状态截图。');
                                    }

                                    try { await saveViewportScreenshot(page, skipScreenshot); } catch (e) {}
                                    await sendTelegramMessage(`⏳ *${escapeMarkdown(user.username)}*\n暂无法续期，下次可续期时间: ${dateStr}`, skipScreenshot);
                                    break;
                                }
                                await page.waitForTimeout(200);
                            }
                        } catch (e) { }

                        if (renewSuccess) break;

                        if (hasCaptchaError) {
                            renewFailureReason = `续期失败，Renew 阶段 ALTCHA 未通过（已重试 ${RENEW_MAX_ATTEMPTS} 次）`;
                            console.log('   >> 验证码未通过，刷新页面重试...');
                            await page.reload();
                            await page.waitForTimeout(3000);
                            if (page.url().includes('login')) {
                                console.log('   >> 刷新后被重定向到登录页，退出。');
                                break;
                            }
                            continue;
                        }

                        await page.waitForTimeout(2000);
                        if (!await modal.isVisible()) {
                            console.log('   >> ✅ Renew successful!');
                            const successScreenshot = path.join(photoDir, `${safeUsername}_success.png`);
                            try { await saveViewportScreenshot(page, successScreenshot); } catch (e) {}
                            await sendTelegramMessage(`✅ *${escapeMarkdown(user.username)}*\n续期成功！`, successScreenshot);
                            renewSuccess = true;
                            break;
                        } else {
                            console.log('   >> 模态框未关闭，刷新重试...');
                            await page.reload();
                            await page.waitForTimeout(3000);
                            if (page.url().includes('login')) {
                                console.log('   >> 刷新后被重定向到登录页，退出。');
                                break;
                            }
                            continue;
                        }
                    } else {
                        await page.reload();
                        await page.waitForTimeout(3000);
                        if (page.url().includes('login')) {
                            console.log('   >> 刷新后被重定向到登录页，退出。');
                            break;
                        }
                        continue;
                    }
                } else {
                    console.log('未找到 Renew 按钮 (可能已结束)。');
                    break;
                }
            } 

            if (!renewSuccess) {
                console.log('   >> ❌ Renew 全部尝试失败。');
                const failDir = path.join(process.cwd(), 'screenshots');
                if (!fs.existsSync(failDir)) fs.mkdirSync(failDir, { recursive: true });
                const failSafe = user.username.replace(/[^a-z0-9]/gi, '_');
                const failScreenshot = path.join(failDir, `${failSafe}_renew_fail.png`);
                try { await saveViewportScreenshot(page, failScreenshot); } catch (e) {}
                await sendTelegramMessage(`❌ *${escapeMarkdown(user.username)}*\n${renewFailureReason}`, failScreenshot);
            }

        } catch (err) {
            console.error(`Error processing user:`, err);
        }

        const photoDir = path.join(process.cwd(), 'screenshots');
        if (!fs.existsSync(photoDir)) fs.mkdirSync(photoDir, { recursive: true });
        const safeUsername = user.username.replace(/[^a-z0-9]/gi, '_');
        try {
            await saveViewportScreenshot(page, path.join(photoDir, `${safeUsername}.png`));
        } catch (e) {}

        console.log(`用户处理完成\n`);
    }

    console.log('完成。');
    await browser.close();
    process.exit(0);
})();
