/** Popup for DSH Browser Control: big status hero, config tucked under 高级. */
'use strict';

const $ = (id) => document.getElementById(id);

const STATE_TEXT = {
	open: '已连接',
	connecting: '连接中…',
	idle: '未连接',
};
const STATE_SUB = {
	open: () => '桥接服务运行中，随时听候调用',
	connecting: () => '正在与 dsh 桥接服务握手',
	idle: () => '没连上桥接服务：确认 dsh 在跑、插件已装（装上即默认开启）',
};

function render(status) {
	const ring = $('ring');
	ring.className = `ring ${status.state}`;
	$('state').textContent = STATE_TEXT[status.state] ?? status.state;
	$('hello').textContent = status.helloInfo
		? `${status.helloInfo.name} ${status.helloInfo.version}`
		: (STATE_SUB[status.state]?.() ?? '');
	if (document.activeElement !== $('port')) $('port').value = status.cfg.port ?? 9777;
	if (document.activeElement !== $('token')) $('token').value = status.cfg.token;
	$('auto').checked = Boolean(status.cfg.autoConnect);
	const connected = status.state === 'open';
	const btn = $('reconnect');
	btn.textContent = connected ? '断开连接' : (status.state === 'connecting' ? '连接中…' : '立即连接');
	btn.classList.toggle('danger', connected);
	btn.dataset.connected = String(connected);
	const locked = status.locked === true;
	const lock = $('lock');
	lock.textContent = locked ? '已锁定' : '锁定';
	lock.classList.toggle('locked', locked);
	const hint = $('lockhint');
	hint.textContent = locked
		? '已冻结：扩展会拒绝模型的全部浏览器操作（连接保持）。点「已锁定」解除。'
		: '锁定 = 冻结模型的全部浏览器操作，连接不断。解锁只能在这里点。';
	hint.className = locked ? 'lockhint on' : 'lockhint';
	const errorBox = $('error');
	errorBox.textContent = status.lastError ?? '';
	errorBox.className = errorBox.textContent.length > 0 ? 'error show' : 'error';
}

async function refresh() {
	try {
		render(await chrome.runtime.sendMessage({ type: 'bridgeStatus' }));
	} catch (err) {
		const box = $('error');
		box.textContent = `扩展未响应: ${err.message}`;
		box.className = 'error show';
	}
}

$('reconnect').addEventListener('click', async () => {
	const connected = $('reconnect').dataset.connected === 'true';
	await chrome.runtime.sendMessage({ type: connected ? 'disconnect' : 'reconnect' });
	setTimeout(refresh, 600);
});

// Single click: opening the popup is already a deliberate user gesture, and a
// panic switch that needs a second click is a panic switch with a delay.
$('lock').addEventListener('click', async () => {
	const locked = $('lock').textContent === '已锁定';
	await chrome.runtime.sendMessage({ type: 'lockSet', locked: !locked });
	refresh();
});

$('openStatus').addEventListener('click', async () => {
	const port = Number($('port').value) || 9777;
	await chrome.tabs.create({ url: `http://127.0.0.1:${port}/` });
	window.close();
});

$('gear').addEventListener('click', () => {
	const panel = $('advanced');
	const opening = !panel.classList.contains('open');
	panel.classList.toggle('open', opening);
	$('gear').textContent = opening ? '高级 ▴' : '高级 ▾';
});

$('save').addEventListener('click', async () => {
	await chrome.storage.local.set({
		port: Number($('port').value) || 9777,
		token: $('token').value.trim(),
		autoConnect: $('auto').checked,
	});
	await chrome.runtime.sendMessage({ type: 'reconnect' });
	setTimeout(refresh, 600);
});

$('ver').textContent = chrome.runtime.getManifest().version;
refresh();
setInterval(refresh, 1500);
