import { createIcons, Eye, EyeOff, X } from 'lucide';
import { DEFAULT_DAV_URL } from './webdav-workspace.js';

export function createWebdavDialog({ connect, disconnect, reveal, forget, previous }) {
  const dialog = document.createElement('dialog');
  dialog.className = 'webdav-dialog';
  dialog.setAttribute('aria-label', '连接 WebDAV');
  dialog.innerHTML = `<form>
    <header><h2>连接 WebDAV</h2><button type="button" name="close" aria-label="关闭"><i data-lucide="x"></i></button></header>
    <label>目录地址<input name="url" type="url" placeholder="${DEFAULT_DAV_URL}" autocomplete="url"></label>
    <label>用户名<input name="username" autocomplete="username"></label>
    <label>密码<span class="dav-password"><input name="password" type="password" autocomplete="off"><button type="button" name="showPassword" aria-label="显示密码" title="显示密码"><i data-lucide="eye"></i></button></span></label>
    <div class="dav-options"><label><input name="remember" type="checkbox">保存密码（服务端加密）</label><label><input name="autoLogin" type="checkbox">自动登录与重连</label></div>
    <label class="dav-http"><input name="allowHttp" type="checkbox">允许 HTTP 明文连接（含账号密码）</label>
    <output role="status"></output>
    <footer><button type="button" name="disconnect">断开连接</button><button type="submit">连接</button></footer>
  </form>`;
  document.body.append(dialog);
  const form = dialog.querySelector('form'), status = dialog.querySelector('output');
  form.elements.url.value = previous?.url || '';
  form.elements.username.value = previous?.username || '';
  const fields = form.elements;
  fields.remember.checked = Boolean(previous?.remember);
  fields.autoLogin.checked = Boolean(previous?.autoLogin && previous?.remember);
  fields.autoLogin.disabled = !fields.remember.checked;
  fields.password.placeholder = previous?.remember ? '已保存，留空使用已保存密码' : '应用密码';
  const icons = () => createIcons({ icons: { Eye, EyeOff, X } });
  icons();
  let busy = false;
  form.elements.close.onclick = () => { if (!busy) dialog.close(); };
  dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
  fields.remember.onchange = async () => {
    fields.autoLogin.disabled = !fields.remember.checked;
    if (fields.remember.checked) return;
    const wasAutomatic = fields.autoLogin.checked;
    fields.autoLogin.checked = false;
    busy = true;
    const controls = [...form.querySelectorAll('button,input')];
    controls.forEach(control => { control.disabled = true; });
    try {
      await forget(); previous = {};
      fields.password.placeholder = '应用密码';
      status.textContent = '已移除保存的密码并关闭自动登录';
    } catch (error) {
      fields.remember.checked = true; fields.autoLogin.checked = wasAutomatic;
      status.textContent = error.message;
    } finally {
      busy = false; controls.forEach(control => { control.disabled = false; });
      fields.autoLogin.disabled = !fields.remember.checked;
    }
  };
  fields.showPassword.onclick = async () => {
    try {
      if (!fields.password.value && previous?.remember && fields.password.type === 'password') fields.password.value = (await reveal({ url: fields.url.value || DEFAULT_DAV_URL, username: fields.username.value })).password;
      const visible = fields.password.type === 'password';
      fields.password.type = visible ? 'text' : 'password';
      fields.showPassword.setAttribute('aria-label', visible ? '隐藏密码' : '显示密码');
      fields.showPassword.title = visible ? '隐藏密码' : '显示密码';
      fields.showPassword.innerHTML = `<i data-lucide="${visible ? 'eye-off' : 'eye'}"></i>`; icons();
    } catch (error) { status.textContent = error.message; }
  };
  form.elements.disconnect.onclick = async () => {
    try { await disconnect(); dialog.close(); } catch (error) { status.textContent = error.message; }
  };
  form.onsubmit = async event => {
    event.preventDefault();
    if (busy) return;
    const url = form.elements.url.value.trim() || DEFAULT_DAV_URL;
    if (new URL(url).protocol === 'http:' && !form.elements.allowHttp.checked) { status.textContent = 'HTTP会明文传输账号和文件，请确认或改用HTTPS'; return; }
    const config = { url, username: fields.username.value.trim(), password: fields.password.value, remember: fields.remember.checked, autoLogin: fields.autoLogin.checked };
    busy = true;
    const controls = [...form.querySelectorAll('button,input')];
    controls.forEach(control => { control.disabled = true; });
    status.textContent = '正在连接并读取目录…';
    try {
      await connect(config);
      form.elements.password.value = '';
      dialog.close();
    } catch (error) { status.textContent = error.message; }
    finally { busy = false; controls.forEach(control => { control.disabled = false; }); fields.autoLogin.disabled = !fields.remember.checked; }
  };
  dialog.addEventListener('close', () => { form.elements.password.value = ''; dialog.remove(); });
  dialog.showModal();
  return dialog;
}
