import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

// Persistent credentials are an optional server concern, never browser state.

function protect(value, decrypt = false) {
  if (process.platform !== 'win32') return Promise.reject(new Error('当前保存密码仅支持Windows用户加密存储；其它平台仍可临时连接'));
  const script = `$ErrorActionPreference='Stop'; [void][Reflection.Assembly]::LoadWithPartialName('System.Security'); [Console]::InputEncoding=[Text.Encoding]::UTF8; [Console]::OutputEncoding=[Text.Encoding]::UTF8; $v=[Console]::In.ReadToEnd(); ` + (decrypt
    ? '[Console]::Write([Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($v),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)))'
    : '[Console]::Write([Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($v),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)))');
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.resume();
    const timer = setTimeout(() => { child.kill(); reject(new Error('密码存储超时')); }, 10000);
    child.on('error', () => { clearTimeout(timer); reject(new Error('无法使用Windows密码加密服务')); });
    child.on('close', code => { clearTimeout(timer); code === 0 ? resolve(output.trim()) : reject(new Error('无法读取密码：请使用原Windows账户或重新保存')); });
    child.stdin.on('error', () => {});
    child.stdin.end(value);
  });
}

export function createCredentialStore(file = path.join(homedir(), '.writide', 'webdav.dpapi')) {
  let queue = Promise.resolve();
  return {
    async read() {
      await queue;
      try { return JSON.parse(await protect(await readFile(file, 'utf8'), true)); }
      catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    },
    write(value) {
      const operation = queue.then(async () => {
        if (!value) { await rm(file, { force: true }); return; }
        const encrypted = await protect(JSON.stringify(value));
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file + '.tmp', encrypted, { mode: 0o600 });
        await rename(file + '.tmp', file);
      });
      queue = operation.catch(() => {});
      return operation;
    },
  };
}
