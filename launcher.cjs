/* 风声 · 启动器
   用法: node launcher.cjs        仅启动本机服务器
         node launcher.cjs share  启动服务器并开启公网临时隧道
   说明: 批处理(.cmd)在部分 Windows 上解析多字节字符会出错，
         因此 .cmd 只做纯英文壳，中文界面全部由本脚本输出。 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const MODE = process.argv[2] === 'share' ? 'share' : 'serve';
const PORT = Number(process.env.PORT || 8787);
const ROOT = __dirname;
process.title = MODE === 'share' ? '风声 · 公网分享' : '风声 · 联机服务器';
const line = '━'.repeat(35);

function ping() {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/ping', timeout: 800 }, res => {
      res.resume();
      resolve(true);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

function openBrowser(url) {
  if (process.env.FS_NO_BROWSER) return;
  spawn('cmd', ['/c', 'start', '', url], { windowsHide: true, detached: true, stdio: 'ignore' }).unref();
}

async function waitAlive(ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await ping()) return true;
    await new Promise(r => setTimeout(r, 250));
  }
  return false;
}

async function serveMode() {
  if (await ping()) {
    console.log('检测到服务器已在运行，直接打开浏览器…');
    openBrowser(`http://localhost:${PORT}`);
    return;
  }
  console.log(line);
  console.log('  风声 · 联机服务器启动中…');
  console.log('  浏览器将自动打开；本窗口保持开启即服务运行中。');
  console.log('  关闭本窗口 = 停止服务器。');
  console.log(line);
  const server = spawn(process.execPath, [path.join(ROOT, 'server.js')], { stdio: 'inherit' });
  setTimeout(() => openBrowser(`http://localhost:${PORT}`), 1200);
  server.on('exit', code => {
    console.log('\n服务器已停止运行。');
    process.exit(code ?? 0);
  });
}

async function shareMode() {
  const cf = path.join(ROOT, 'tools', 'cloudflared.exe');
  if (!fs.existsSync(cf)) {
    console.error('未找到 tools\\cloudflared.exe（公网隧道工具）。');
    console.error('请手动下载后放入 tools 文件夹并改名为 cloudflared.exe：');
    console.error('  https://github.com/cloudflare/cloudflared/releases/latest');
    process.exitCode = 1;
    return;
  }
  let server = null;
  if (await ping()) {
    console.log('本地服务器已在运行，直接建立公网隧道…');
  } else {
    console.log('本地服务器未运行，正在启动…');
    server = spawn(process.execPath, [path.join(ROOT, 'server.js')], { stdio: ['ignore', 'ignore', 'inherit'] });
    if (!(await waitAlive(8000))) {
      console.error('服务器启动失败或超时。');
      server.kill();
      process.exitCode = 1;
      return;
    }
  }
  console.log(line);
  console.log('  正在建立公网隧道（免费临时方案）…');
  console.log('  稍候本窗口会显示形如 https://xxxx.trycloudflare.com 的地址。');
  console.log('  把该地址发给好友，即可从公网加入游戏。');
  console.log('  注意：本窗口关闭或电脑关机后地址失效，重开会得到新地址。');
  console.log('  想固定地址随时可玩：见 README 的「永久部署」章节。');
  console.log(line);
  const tunnel = spawn(cf, ['tunnel', '--url', `http://localhost:${PORT}`], { stdio: 'inherit' });
  tunnel.on('exit', () => {
    console.log('\n隧道已断开。');
    if (server) server.kill();
  });
}

(MODE === 'share' ? shareMode() : serveMode()).catch(e => {
  console.error('启动失败：' + e.message);
  process.exitCode = 1;
});
