// Headless smoke check over CDP: expects the app started with
// --remote-debugging-port=9222. Prints the rendered state and saves screenshots.
// Usage: node tools/smoke.js [port]
'use strict';

const fs = require('fs');
const path = require('path');

const PORT = process.argv[2] || '9222';

async function main() {
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = targets.find((target) => target.type === 'page');
  if (!page) throw new Error(`No hay pagina Electron en ${PORT}.`);

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let nextId = 0;
  const pending = new Map();
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    }
  });
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });

  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });

  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'evaluation failed');
    return result.result.value;
  };

  const state = await evaluate(`JSON.stringify({
    title: document.title,
    view: document.querySelector('#view-title').textContent,
    count: document.querySelector('#count').textContent,
    cards: document.querySelectorAll('.card').length,
    nav: [...document.querySelectorAll('#nav .nav-item')].map((n) => n.textContent.replace(/\\s+/g, ' ').trim()),
    admin: document.querySelector('#admin-pill').textContent,
    banner: !document.querySelector('#admin-banner').hidden,
    firstCard: document.querySelector('.card h3') ? document.querySelector('.card h3').textContent : null
  })`);
  console.log('STATE', state);

  const shot1 = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(__dirname, '..', '_analysis', 'smoke-optimize.png'), Buffer.from(shot1.data, 'base64'));

  const categoryState = await evaluate(`(async () => {
    const item = [...document.querySelectorAll('#nav .nav-item')].find((n) => n.textContent.includes('Rendimiento FPS'));
    if (!item) return 'sin categoria';
    item.click();
    await new Promise((r) => setTimeout(r, 150));
    return JSON.stringify({
      view: document.querySelector('#view-title').textContent,
      count: document.querySelector('#count').textContent,
      cards: document.querySelectorAll('.card').length
    });
  })()`);
  console.log('CATEGORY', categoryState);

  const shot2 = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(__dirname, '..', '_analysis', 'smoke-category.png'), Buffer.from(shot2.data, 'base64'));

  const backupsState = await evaluate(`(async () => {
    const item = [...document.querySelectorAll('#nav .nav-item')].find((n) => n.textContent.includes('Backups'));
    item.click();
    await new Promise((r) => setTimeout(r, 250));
    return JSON.stringify({
      visible: !document.querySelector('#view-backups').hidden,
      applied: document.querySelectorAll('#applied-list .list-row').length,
      backups: document.querySelectorAll('#backup-list .list-row').length,
      undoDisabled: document.querySelector('#undo-all').disabled
    });
  })()`);
  console.log('BACKUPS', backupsState);

  const shot3 = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(__dirname, '..', '_analysis', 'smoke-backups.png'), Buffer.from(shot3.data, 'base64'));

  // A warned tweak must open the confirm modal without applying anything
  // (we cancel), and the warning must be visible.
  const tags = await evaluate(`(async () => {
    const cat = [...document.querySelectorAll('#nav .nav-item')].find((n) => n.textContent.includes('Windows') && !n.textContent.includes('Custom'));
    cat.click();
    await new Promise((r) => setTimeout(r, 150));
    const card = [...document.querySelectorAll('.card')].find((c) => c.textContent.includes('Desactivar todas las notificaciones'));
    if (!card) return 'sin tarjeta';
    const out = [...card.querySelectorAll('.tag')].map((t) => t.textContent);
    card.querySelector('button').click();
    await new Promise((r) => setTimeout(r, 150));
    return JSON.stringify(out);
  })()`);
  const shot4 = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(__dirname, '..', '_analysis', 'smoke-modal.png'), Buffer.from(shot4.data, 'base64'));

  const modalState = await evaluate(`JSON.stringify({
    tags: ${tags},
    modalOpen: !document.querySelector('#modal').hidden,
    title: document.querySelector('#modal-title').textContent,
    warning: document.querySelector('.modal-warning') ? document.querySelector('.modal-warning').textContent : null
  })`);
  await evaluate(`document.querySelector('#modal-cancel').click()`);
  console.log('MODAL', modalState);

  const transientState = await evaluate(`(async () => {
    const cat = [...document.querySelectorAll('#nav .nav-item')].find((n) => n.textContent.includes('BIOS y drivers'));
    cat.click();
    await new Promise((r) => setTimeout(r, 150));
    const card = [...document.querySelectorAll('.card')].find((c) => c.textContent.includes('Descargar drivers de NVIDIA'));
    if (!card) return 'sin tarjeta';
    return JSON.stringify({
      button: card.querySelector('button').textContent,
      tags: [...card.querySelectorAll('.tag')].map((t) => t.textContent)
    });
  })()`);
  console.log('TRANSIENT', transientState);

  // Hover detail and toast styles.
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 460, y: 380 });
  await new Promise((resolve) => setTimeout(resolve, 300));
  const shot5 = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(__dirname, '..', '_analysis', 'smoke-hover.png'), Buffer.from(shot5.data, 'base64'));

  await evaluate(`toast('Ajuste aplicado correctamente.', 'info'); toast('No se pudo aplicar: permisos insuficientes.', 'error')`);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const shot6 = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(__dirname, '..', '_analysis', 'smoke-toast.png'), Buffer.from(shot6.data, 'base64'));

  const filtersState = await evaluate(`(async () => {
    [...document.querySelectorAll('#nav .nav-item')].find((n) => n.textContent.includes('Todos los ajustes')).click();
    await new Promise((r) => setTimeout(r, 120));
    const input = document.querySelector('#search');
    input.value = 'dns';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 120));
    const searched = { count: document.querySelector('#count').textContent, cards: document.querySelectorAll('.card').length };
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const select = document.querySelector('#risk-filter');
    select.value = 'riesgoso';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 120));
    const risky = { count: document.querySelector('#count').textContent, cards: document.querySelectorAll('.card').length };
    select.value = 'all';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return JSON.stringify({ searched, risky });
  })()`);
  console.log('FILTERS', filtersState);

  const uiState = await evaluate(`(async () => {
    const banner = document.querySelector('#admin-banner');
    const wasHidden = banner.hidden;
    banner.hidden = true;
    const hiddenDisplay = getComputedStyle(banner).display;
    banner.hidden = wasHidden;

    const firstCard = document.querySelector('.card');
    const cardId = firstCard.dataset.id;
    renderGrid({ focusTweakId: cardId });
    const focusedCard = document.activeElement && document.activeElement.closest('.card')
      ? document.activeElement.closest('.card').dataset.id
      : null;

    renderGrid();
    const noAnimation = !document.querySelector('#grid').classList.contains('grid-animate');
    renderGrid({ animate: true });
    const animation = document.querySelector('#grid').classList.contains('grid-animate');

    const category = [...document.querySelectorAll('#nav .nav-item')]
      .find((n) => n.textContent.includes('Windows') && !n.textContent.includes('Custom'));
    category.click();
    await new Promise((r) => setTimeout(r, 120));
    const navFocus = document.activeElement ? document.activeElement.getAttribute('aria-current') : null;

    return JSON.stringify({ hiddenDisplay, focusedCard, cardId, noAnimation, animation, navFocus });
  })()`);
  console.log('UI', uiState);

  ws.close();
}

main().catch((error) => { console.error(error); process.exit(1); });
