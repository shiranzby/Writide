import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

// Persistent credentials are an optional server concern, never browser state.

function protectWindows(value, decrypt = false) {
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

async function writePrivateFile(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, value, { mode: 0o600 });
  try { await rename(temporary, file); }
  catch (error) {
    if (!['EEXIST', 'EPERM'].includes(error.code)) throw error;
    await rm(file, { force: true });
    await rename(temporary, file);
  }
}

async function portableKey(keyFile) {
  try {
    const key = Buffer.from((await readFile(keyFile, 'utf8')).trim(), 'base64');
    if (key.length !== 32) throw new Error('密钥长度无效');
    return key;
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('无法读取WebDAV密码加密密钥');
    const key = randomBytes(32);
    await writePrivateFile(keyFile, key.toString('base64'));
    return key;
  }
}

async function protectPortable(value, keyFile, decrypt = false) {
  try {
    const key = await portableKey(keyFile);
    if (!decrypt) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return JSON.stringify({ version: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') });
    }
    const payload = JSON.parse(value);
    if (payload.version !== 1) throw new Error('版本无效');
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(payload.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(payload.data, 'base64')), decipher.final()]).toString('utf8');
  } catch (error) { throw new Error(decrypt ? '无法解密已保存的WebDAV密码，请重新保存' : '无法加密保存WebDAV密码'); }
}

export function createCredentialStore(file = path.join(homedir(), '.writide', process.platform === 'win32' ? 'webdav.dpapi' : 'webdav.enc'), options = {}) {
  const platform = options.platform || process.platform;
  const keyFile = options.keyFile || `${file}.key`;
  let queue = Promise.resolve();
  return {
    async read() {
      await queue;
      try {
        const encrypted = await readFile(file, 'utf8');
        const plain = platform === 'win32' ? await protectWindows(encrypted, true) : await protectPortable(encrypted, keyFile, true);
        return JSON.parse(plain);
      }
      catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    },
    write(value) {
      const operation = queue.then(async () => {
        if (!value) { await rm(file, { force: true }); return; }
        const encrypted = platform === 'win32'
          ? await protectWindows(JSON.stringify(value))
          : await protectPortable(JSON.stringify(value), keyFile);
        await writePrivateFile(file, encrypted);
      });
      queue = operation.catch(() => {});
      return operation;
    },
  };
}
