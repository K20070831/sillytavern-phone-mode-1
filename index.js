(async function () {
    await new Promise(r => setTimeout(r, 1000));

    const SAVE_LIMIT = 60, CONTEXT_LIMIT = 20, BIDIRECTIONAL_LIMIT = 20, MAX_BIDIRECTIONAL = 5;
    const BIDIRECTIONAL_KEY = 'PHONE_SMS_MEMORY', VOICE_MAX_SEC = 60, MODEL_VISIBLE_ROWS = 4, MAX_GROUP_MEMBERS = 16; 
    const BI_INJECT_DEPTH = 2;
    const POPOVER_SUPPORTED = typeof HTMLElement !== 'undefined' && HTMLElement.prototype.hasOwnProperty('popover');
    const GROUP_COLORS = [
        { bg: '#e9e9eb', text: '#000' },     // 默认灰
        { bg: '#b8e6c8', text: '#1b4332' },  // 薄荷绿
        { bg: '#f5d0d0', text: '#4a2030' },  // 浅玫红
        { bg: '#d4d0f5', text: '#2d2252' },  // 薰衣草紫
        { bg: '#f5e6b8', text: '#4a3a10' },  // 暖杏黄
        { bg: '#cceef5', text: '#144652' },  // 天蓝
        { bg: '#ffd6a5', text: '#5c3200' },  // 蜜橙
        { bg: '#d0f0e8', text: '#0d3b2e' },  // 碧绿
        { bg: '#f0d4f5', text: '#3b0d52' },  // 丁香紫
        { bg: '#fce4b8', text: '#4a2800' },  // 琥珀
        { bg: '#c8dff5', text: '#0d2952' },  // 钢蓝
        { bg: '#f5d4e4', text: '#4a0d2a' },  // 樱粉
        { bg: '#d4efd4', text: '#1a3d1a' },  // 草绿
        { bg: '#f5e0c8', text: '#4a2800' },  // 桃杏
        { bg: '#c8c8f5', text: '#1a1a52' },  // 靛蓝
    ];

    // ========== IndexedDB 工具 ==========
    const PM_IDB_NAME = 'PhoneModeDB', PM_IDB_STORE = 'kv';
    let __pmIDB = null;
    const IDB_MARKER = '__idb__';

    function pmOpenIDB() {
        return new Promise(resolve => {
            if (__pmIDB) {
                // 探测连接是否还活着：尝试一次只读事务
                try {
                    __pmIDB.transaction(PM_IDB_STORE, 'readonly');
                    return resolve(__pmIDB); // 连接正常，复用
                } catch (e) {
                    // 连接已失效（iOS WebView 后台恢复常见），清除缓存重新连接
                    __pmIDB = null;
                }
            }
            try {
                const req = indexedDB.open(PM_IDB_NAME, 1);
                req.onupgradeneeded = () => {
                    const db = req.result;
                    if (!db.objectStoreNames.contains(PM_IDB_STORE)) db.createObjectStore(PM_IDB_STORE);
                };
                req.onsuccess = () => { __pmIDB = req.result; resolve(__pmIDB); };
                req.onerror = () => resolve(null);
            } catch (e) { resolve(null); }
        });
    }

    async function pmIDBSet(key, value) {
        const db = await pmOpenIDB(); if (!db) return false;
        return new Promise(r => {
            try {
                const tx = db.transaction(PM_IDB_STORE, 'readwrite');
                tx.objectStore(PM_IDB_STORE).put(value, key);
                tx.oncomplete = () => r(true);
                tx.onerror = () => r(false);
            } catch (e) { r(false); }
        });
    }

    async function pmIDBGet(key) {
        const db = await pmOpenIDB(); if (!db) return null;
        return new Promise(r => {
            try {
                const tx = db.transaction(PM_IDB_STORE, 'readonly');
                const req = tx.objectStore(PM_IDB_STORE).get(key);
                req.onsuccess = () => r(req.result ?? null);
                req.onerror = () => r(null);
            } catch (e) { r(null); }
        });
    }

    async function pmIDBDel(key) {
        const db = await pmOpenIDB(); if (!db) return;
        try {
            const tx = db.transaction(PM_IDB_STORE, 'readwrite');
            tx.objectStore(PM_IDB_STORE).delete(key);
        } catch (e) {}
    }

    function pmIsBigData(v) {
        return typeof v === 'string' && v.length > 4096 && (v.startsWith('data:') || v.startsWith('blob:'));
    }

    // ========== 短信历史双写存储 ==========
    function saveHistories() {
        pmIDBSet('ST_SMS_DATA_V2', window.__pmHistories).catch(() => {});
        try { localStorage.setItem('ST_SMS_DATA_V2', JSON.stringify(window.__pmHistories)); } catch (e) {
            console.warn('[phone-mode] localStorage 已满，短信历史仅保存在 IDB');
        }
    }

    // 修复：页面关闭/刷新时 IDB 异步写入可能来不及完成，用 beforeunload 做同步兜底
    function saveHistoriesBeforeUnload() {
        const data = window.__pmHistories;
        if (!data || !Object.keys(data).length) return;
        // 同步写 localStorage（兜底）
        try {
            localStorage.setItem('ST_SMS_DATA_V2', JSON.stringify(data));
        } catch (e) {
            // localStorage 满时做最小化备份
            try {
                const slim = {};
                for (const [storyId, contacts] of Object.entries(data)) {
                    slim[storyId] = {};
                    for (const [persona, history] of Object.entries(contacts)) {
                        slim[storyId][persona] = Array.isArray(history) ? history.slice(-10) : history;
                    }
                }
                localStorage.setItem('ST_SMS_DATA_V2', JSON.stringify(slim));
            } catch (e2) {
                console.warn('[phone-mode] beforeunload: localStorage 完全无法写入');
            }
        }
        // ✅ 新增：同时触发 IDB 异步写入，iOS 后台挂起前尽量完成
        pmIDBSet('ST_SMS_DATA_V2', data).catch(() => {});
    }

    // 避免重复加载插件时重复注册
    if (!window.__pmBeforeUnloadRegistered) {
        window.addEventListener('beforeunload', saveHistoriesBeforeUnload);
        // TT酒馆(TauriTavern) WebView 在移动端被挂起/切到后台时不触发 beforeunload，
        // 用 visibilitychange 做额外兜底，页面变为 hidden 时同步写入 localStorage
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') saveHistoriesBeforeUnload();
        });
        window.__pmBeforeUnloadRegistered = true;
    }

    async function loadHistoriesFromIDB() {
        try {
            const v = await pmIDBGet('ST_SMS_DATA_V2');
            if (!v) {
                // ✅ IDB 无数据（包括 IDB 失效返回 null 的情况），用 localStorage 兜底
                try {
                    const ls = JSON.parse(localStorage.getItem('ST_SMS_DATA_V2'));
                    if (ls && typeof ls === 'object' && Object.keys(ls).length > 0) {
                        window.__pmHistories = ls;
                        console.log('[phone-mode] IDB 无数据，已从 localStorage 恢复');
                    }
                } catch (e) {}
                return;
            }
            const parsed = typeof v === 'string' ? JSON.parse(v) : v;
            if (!parsed || typeof parsed !== 'object') return;
            const idbCount = Object.keys(parsed).length;
            if (idbCount > 0) {
                window.__pmHistories = parsed;
                try { localStorage.setItem('ST_SMS_DATA_V2', JSON.stringify(parsed)); } catch (e) {
                    console.warn('[phone-mode] localStorage 已满，仅使用 IDB 存储');
                }
                console.log('[phone-mode] 从 IndexedDB 加载了短信历史，共', idbCount, '个会话');
            }
        } catch (e) {
            // ✅ IDB 读取异常（iOS WebView 后台恢复时的典型情况），用 localStorage 兜底
            console.warn('[phone-mode] IDB 恢复失败，尝试 localStorage 兜底', e);
            try {
                const ls = JSON.parse(localStorage.getItem('ST_SMS_DATA_V2'));
                if (ls && typeof ls === 'object' && Object.keys(ls).length > 0) {
                    window.__pmHistories = ls;
                }
            } catch (e2) {}
        }
    }

    window.__pmHistories = window.__pmHistories || {};
    window.__pmConfig = window.__pmConfig || { apiUrl: '', apiKey: '', model: '', useIndependent: false };
    window.__pmProfiles = window.__pmProfiles || [];
    window.__pmBidirectional = window.__pmBidirectional || {};
    window.__pmTheme = window.__pmTheme || { preset: 'default', customRight: '', customLeft: '', borderColor: '', layout: 'standard', darkMode: 'light' };
    window.__pmBgGlobal = window.__pmBgGlobal || '';
    window.__pmBgLocal = window.__pmBgLocal || {};
    window.__pmGroupMeta = window.__pmGroupMeta || {};
    window.__pmPokeConfig = window.__pmPokeConfig || {};
    window.__pmWordyLimit = window.__pmWordyLimit || false;
    window.__pmEmojis = window.__pmEmojis || []; // [{id, name, images:[{url,desc},...]}]
    // 头像+备注数据：__pmAvatarData[会话id][联系人名/群key] = {enabled, self, other, remark, members:{成员名:url}}
    window.__pmAvatarData = window.__pmAvatarData || {};

    let __pmAvatarLoaded = false;
    async function loadAvatarData() {
        try {
            const v = await pmIDBGet('ST_SMS_AVATARS');
            window.__pmAvatarData = (v && typeof v === 'object') ? v : {};
        } catch (e) { window.__pmAvatarData = {}; }
        __pmAvatarLoaded = true;
    }
    async function saveAvatarData() {
        await pmIDBSet('ST_SMS_AVATARS', window.__pmAvatarData).catch(() => {});
    }
    function getAvatarKey() { return (isGroupChat && currentGroupKey) ? currentGroupKey : currentPersona; }
    // create=false 时只读，不写入任何数据；create=true 时确保节点存在（用于即将写入前）
    function getAvatarEntry(create) {
        const id = getStorageId(), key = getAvatarKey();
        if (!key) return null;
        if (!window.__pmAvatarData[id]) {
            if (!create) return null;
            window.__pmAvatarData[id] = {};
        }
        if (!window.__pmAvatarData[id][key]) {
            if (!create) return null;
            window.__pmAvatarData[id][key] = { enabled: false, self: '', other: '', remark: '', members: {} };
        }
        return window.__pmAvatarData[id][key];
    }
    // 备注只影响 UI 渲染，读取时按"会话id + 联系人名"查，不影响拼给 AI 的原名
    function getRemark(contactName) {
        const id = getStorageId();
        return window.__pmAvatarData[id]?.[contactName]?.remark || '';
    }
    // 根据气泡的 side/senderName 解析应显示的头像地址；返回 null 表示当前会话未开启头像显示
    function resolveAvatarUrl(side, senderName) {
        const entry = getAvatarEntry(false);
        if (!entry || !entry.enabled) return null;
        if (side === 'right') return entry.self || '';
        if (isGroupChat) return (senderName && entry.members[senderName]) || '';
        return entry.other || '';
    }
    // 头像显示开关：单聊/群聊设置页里的开关样式控件，仅切换 DOM class，实际持久化在各自的保存函数里完成
    window.__pmToggleAvatarSwitch = () => {
        document.getElementById('pm-avatar-check')?.classList.toggle('is-on');
    };
    window.__pmToggleAvatarSwitchGroup = () => {
        document.getElementById('pm-avatar-check-group')?.classList.toggle('is-on');
    };
    // 头像选择弹窗：URL 输入 或 本地相册单张选图（转 dataURL 直接设置，不建库）
    function showAvatarPicker(side, senderName) {
        const entry = getAvatarEntry(true);
        const current = side === 'right' ? entry.self : (isGroupChat ? (entry.members[senderName] || '') : entry.other);
        const urlVal = (current && !current.startsWith('data:')) ? current : '';
        makeOverlay(`
    <div class="pm-modal">
    <div class="pm-modal-header"><b>设置头像</b><span onclick="document.getElementById('pm-overlay').remove()" class="pm-modal-close">✕</span></div>
    <div style="padding:14px 16px;display:flex;flex-direction:column;gap:10px;">
        ${current ? `<img src="${escapeAttr(current)}" style="width:56px;height:56px;border-radius:50%;object-fit:cover;align-self:center;">` : ''}
        <div class="pm-cfg-label">图片URL</div>
        <input id="pm-avatar-url-input" class="pm-cfg-input" placeholder="https://..." value="${escapeAttr(urlVal)}">
        <div style="text-align:center;color:#888;font-size:12px;">— 或 —</div>
        <label style="display:flex;align-items:center;justify-content:center;gap:6px;background:#f2f2f2;border-radius:10px;padding:10px;cursor:pointer;font-size:13px;color:#555;">
            📷 从相册选择
            <input id="pm-avatar-file-input" type="file" accept="image/*" style="display:none;">
        </label>
    </div>
    <div class="pm-modal-add" style="display:flex;gap:8px;">
        ${current ? `<button id="pm-avatar-clear-btn" style="flex:1;background:#f2f2f2;color:#ff3b30;border:none;border-radius:10px;padding:10px;font-size:13px;cursor:pointer;font-weight:600;">清除</button>` : ''}
        <button id="pm-avatar-save-btn" style="flex:1;background:#007aff;color:#fff;border:none;border-radius:10px;padding:10px;font-size:13px;cursor:pointer;font-weight:600;">保存</button>
    </div>
    </div>`);
        const save = (url) => {
            const e2 = getAvatarEntry(true);
            if (side === 'right') e2.self = url;
            else if (isGroupChat) e2.members[senderName] = url;
            else e2.other = url;
            saveAvatarData();
            document.getElementById('pm-overlay')?.remove();
            renderHistoryMessages();
        };
        document.getElementById('pm-avatar-save-btn')?.addEventListener('click', () => {
            const v = document.getElementById('pm-avatar-url-input')?.value.trim() || '';
            save(v);
        });
        document.getElementById('pm-avatar-clear-btn')?.addEventListener('click', () => save(''));
        document.getElementById('pm-avatar-file-input')?.addEventListener('change', (ev) => {
            const file = ev.target.files?.[0]; if (!file) return;
            const reader = new FileReader();
            reader.onload = () => save(reader.result);
            reader.readAsDataURL(file);
        });
    }
    function makeAvatarEl(url, side, senderName) {
        const el = document.createElement(url ? 'img' : 'div');
        el.className = 'pm-avatar-img' + (url ? '' : ' pm-avatar-placeholder');
        if (url) el.src = url;
        el.title = '点击设置头像';
        el.addEventListener('click', () => showAvatarPicker(side, senderName));
        return el;
    }

    // ── 微博NPC头像组：结构照表情包（[{id,name,enabled,images:[url,...]}]），但只存 url 不需要描述 ──
    window.__pmNpcAvatars = window.__pmNpcAvatars || [];
    let __pmNpcAvLoaded = false;
    async function loadNpcAvatars() {
        try {
            const v = await pmIDBGet('ST_SMS_NPC_AVATARS');
            window.__pmNpcAvatars = Array.isArray(v) ? v : [];
        } catch (e) { window.__pmNpcAvatars = []; }
        __pmNpcAvLoaded = true;
    }
    async function saveNpcAvatars() { await pmIDBSet('ST_SMS_NPC_AVATARS', window.__pmNpcAvatars).catch(() => {}); }
    // 已启用组里的全部头像，按组顺序摊平
    function npcAvatarPool() {
        return window.__pmNpcAvatars.filter(s => s.enabled).flatMap(s => s.images || []);
    }
    // 同名 NPC 稳定拿到同一张头像：名字哈希取模，池子为空则返回 '' 走灰色占位
    function npcAvatarFor(name) {
        const pool = npcAvatarPool();
        if (!pool.length) return '';
        let h = 0;
        const s = String(name || '');
        for (let i = 0; i < s.length; i++) { h = ((h << 5) - h + s.charCodeAt(i)) | 0; }
        return pool[Math.abs(h) % pool.length] || '';
    }

    window.__pmRenderNpcAvSetList = () => {
        const container = document.getElementById('pm-npcav-set-list');
        if (!container) return;
        const sets = window.__pmNpcAvatars;
        if (!sets.length) {
            container.innerHTML = '<div style="text-align:center;color:#aaa;font-size:13px;padding:16px 0;">暂无头像组</div>';
            return;
        }
        container.innerHTML = sets.map((set, si) => `
            <div style="background:#fafafa;border:1px solid #eee;border-radius:10px;padding:10px 12px;margin-bottom:8px;">
                <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">
                    <span style="display:flex;align-items:center;gap:7px;min-width:0;">
                        <div onclick="window.__pmToggleNpcAvSet(${si})" class="pm-custom-check pm-bi-style ${set.enabled ? 'is-checked' : ''}" style="width:18px;height:18px;min-width:18px;min-height:18px;margin-bottom:0;border-radius:50%;"></div>
                        <span style="font-weight:600;font-size:13px;color:#222;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(set.name)}</span>
                    </span>
                    <div style="display:flex;gap:6px;flex-shrink:0;">
                        <button onclick="window.__pmAddNpcAvImage(${si})" style="font-size:11px;background:#007aff;color:#fff;border:none;border-radius:6px;padding:4px 8px;cursor:pointer;">➕头像</button>
                        <button onclick="window.__pmDeleteNpcAvSet(${si})" style="font-size:11px;background:#ff3b30;color:#fff;border:none;border-radius:6px;padding:4px 8px;cursor:pointer;">删除</button>
                    </div>
                </div>
                <div style="display:flex;flex-wrap:wrap;gap:6px;">
                    ${(set.images || []).map((url, ii) => `
                        <div style="position:relative;width:40px;height:40px;">
                            <img src="${escapeAttr(url)}" style="width:40px;height:40px;object-fit:cover;border-radius:50%;border:1px solid #eee;">
                            <span onclick="window.__pmDeleteNpcAvImage(${si},${ii})" style="position:absolute;top:-4px;right:-4px;background:#ff3b30;color:#fff;border-radius:50%;width:15px;height:15px;font-size:9px;display:flex;align-items:center;justify-content:center;cursor:pointer;line-height:1;">×</span>
                        </div>
                    `).join('')}
                    ${(set.images || []).length === 0 ? '<span style="font-size:12px;color:#aaa;">暂无头像</span>' : ''}
                </div>
                <div style="font-size:11px;color:#aaa;margin-top:5px;">${(set.images || []).length}/30 张 · ${set.enabled ? '已启用' : '未启用'}</div>
            </div>
        `).join('');
    };

    window.__pmToggleNpcAvSet = (si) => {
        const set = window.__pmNpcAvatars[si]; if (!set) return;
        set.enabled = !set.enabled;
        saveNpcAvatars();
        window.__pmRenderNpcAvSetList();
    };
    window.__pmDeleteNpcAvSet = (si) => {
        const set = window.__pmNpcAvatars[si]; if (!set) return;
        if (!confirm(`确认删除头像组「${set.name}」？`)) return;
        window.__pmNpcAvatars.splice(si, 1);
        saveNpcAvatars();
        window.__pmRenderNpcAvSetList();
    };
    window.__pmDeleteNpcAvImage = (si, ii) => {
        const set = window.__pmNpcAvatars[si]; if (!set) return;
        (set.images || []).splice(ii, 1);
        saveNpcAvatars();
        window.__pmRenderNpcAvSetList();
    };

    function pmSubOverlay(html, focusId) {
        const ov = document.createElement('div'); ov.id = 'pm-overlay-sub';
        if (typeof HTMLElement !== 'undefined' && HTMLElement.prototype.hasOwnProperty('popover')) ov.setAttribute('popover', 'manual');
        ov.style.cssText = 'position:fixed !important; inset:0 !important; margin:0 !important; padding:0 !important; border:none !important; width:100vw !important; height:100vh !important; max-width:none !important; max-height:none !important; background:rgba(0,0,0,.45) !important; z-index:2147483648 !important; display:flex !important; align-items:center !important; justify-content:center !important;';
        ov.innerHTML = html;
        ov.addEventListener('click', e => { if (e.target === ov) ov.remove(); });
        document.body.appendChild(ov);
        if (ov.showPopover) try { ov.showPopover(); } catch (e) {}
        if (focusId) setTimeout(() => document.getElementById(focusId)?.focus(), 10);
        return ov;
    }

    window.__pmAddNpcAvSet = () => {
        if (window.__pmNpcAvatars.length >= 10) return alert('最多只能创建 10 个头像组。');
        pmSubOverlay(`
<div class="pm-modal">
  <div class="pm-modal-header">
    <b>新建头像组</b>
    <span onclick="document.getElementById('pm-overlay-sub').remove()" class="pm-modal-close">✕</span>
  </div>
  <div style="padding:14px 16px;display:flex;flex-direction:column;gap:10px;">
    <input id="pm-new-npcav-name" class="pm-cfg-input" placeholder="组名称（如：女生、男生、二次元）" style="padding:8px 10px;font-size:13px;border-radius:8px;border:1px solid #ddd;">
  </div>
  <div class="pm-modal-add">
    <button onclick="window.__pmConfirmAddNpcAvSet()" style="width:100%;background:#ff8200;color:#fff;border:none;border-radius:10px;padding:10px;font-size:13px;cursor:pointer;font-weight:600;">确认</button>
  </div>
</div>`, 'pm-new-npcav-name');
    };
    window.__pmConfirmAddNpcAvSet = () => {
        const name = document.getElementById('pm-new-npcav-name')?.value.trim();
        if (!name) return alert('组名称不能为空。');
        if (window.__pmNpcAvatars.some(s => s.name === name)) return alert('该名称已存在。');
        window.__pmNpcAvatars.push({ id: 'npcav_' + Date.now(), name, enabled: true, images: [] });
        saveNpcAvatars();
        document.getElementById('pm-overlay-sub')?.remove();
        window.__pmRenderNpcAvSetList();
    };

    window.__pmAddNpcAvImage = (si) => {
        const set = window.__pmNpcAvatars[si]; if (!set) return;
        if ((set.images || []).length >= 30) return alert('本组已满 30 张。');
        pmSubOverlay(`
<div class="pm-modal">
  <div class="pm-modal-header">
    <b>添加头像 — ${escapeHtml(set.name)}</b>
    <span onclick="document.getElementById('pm-overlay-sub').remove();" class="pm-modal-close">✕</span>
  </div>
  <div style="padding:14px 16px;display:flex;flex-direction:column;gap:10px;">
    <div style="font-size:12px;color:#888;margin-bottom:2px;">图片 URL 或本地上传（可多选）</div>
    <input id="pm-npcav-url" class="pm-cfg-input" placeholder="https://... 或点下方选择文件" style="padding:8px 10px;font-size:13px;border-radius:8px;border:1px solid #ddd;">
    <button onclick="document.getElementById('pm-npcav-file').click()" style="background:#f0f0f3;color:#333;border:1px solid #ddd;border-radius:8px;padding:8px 10px;font-size:12px;cursor:pointer;">📁 上传本地图片（可多选）</button>
    <input id="pm-npcav-file" type="file" accept="image/*" multiple hidden onchange="window.__pmNpcAvFileRead(${si},this)">
    <div id="pm-npcav-preview" style="display:none;flex-wrap:wrap;gap:6px;justify-content:center;"></div>
    <div style="font-size:11px;color:#aaa;">头像会随机分配给评论区网友，同一个名字始终拿到同一张</div>
  </div>
  <div class="pm-modal-add">
    <button onclick="window.__pmConfirmAddNpcAvImage(${si})" style="width:100%;background:#ff8200;color:#fff;border:none;border-radius:10px;padding:10px;font-size:13px;cursor:pointer;font-weight:600;">确认添加</button>
  </div>
</div>`, 'pm-npcav-url');
    };
    // 多选上传：直接批量入组，省得一张张填
    window.__pmNpcAvFileRead = (si, input) => {
        const files = Array.from(input.files || []); if (!files.length) return;
        const set = window.__pmNpcAvatars[si]; if (!set) return;
        if (!Array.isArray(set.images)) set.images = [];
        const room = 30 - set.images.length;
        if (room <= 0) { alert('本组已满 30 张。'); return; }
        const picked = files.slice(0, room);
        Promise.all(picked.map(f => new Promise(res => {
            const rd = new FileReader();
            rd.onload = e => res(e.target.result);
            rd.onerror = () => res(null);
            rd.readAsDataURL(f);
        }))).then(urls => {
            urls.filter(Boolean).forEach(u => set.images.push(u));
            saveNpcAvatars();
            document.getElementById('pm-overlay-sub')?.remove();
            window.__pmRenderNpcAvSetList();
            if (files.length > room) alert(`本组只剩 ${room} 个位置，已添加前 ${room} 张。`);
        });
    };
    window.__pmConfirmAddNpcAvImage = (si) => {
        const url = document.getElementById('pm-npcav-url')?.value.trim();
        if (!url) return alert('请输入图片 URL 或上传图片。');
        const set = window.__pmNpcAvatars[si]; if (!set) return;
        if (!Array.isArray(set.images)) set.images = [];
        set.images.push(url);
        saveNpcAvatars();
        document.getElementById('pm-overlay-sub')?.remove();
        window.__pmRenderNpcAvSetList();
    };

    async function loadEmojis() {
        try {
            const v = await pmIDBGet('ST_SMS_EMOJIS');
            window.__pmEmojis = Array.isArray(v) ? v : [];
        } catch(e) { window.__pmEmojis = []; }
    }
    async function saveEmojis() {
        await pmIDBSet('ST_SMS_EMOJIS', window.__pmEmojis).catch(()=>{});
    }
    let __pmModelList = [];
    let __pmEventHooked = false;
    let __pmFirstOpen = true;

    let phoneActive = false, phoneWindow = null, currentPersona = '', conversationHistory = [];
    let isGenerating = false, isMinimized = false, isSelectMode = false;
    let isGroupChat = false, groupMembers = [], groupColorMap = {}, groupDisplayName = '';
    let currentGroupKey = '';

    const getCtx = () => typeof SillyTavern !== 'undefined' ? SillyTavern.getContext() : null;

    const THEME_PRESETS = {
        default: { right: '#007aff', left: '#e9e9eb', rightText: '#fff', leftText: '#000', label: '默认蓝' },
        pink:    { right: '#ff6b8a', left: '#fce4ec', rightText: '#fff', leftText: '#4a2030', label: '樱花粉' },
        dark:    { right: '#5856d6', left: '#2c2c2e', rightText: '#fff', leftText: '#e0e0e0', label: '暗夜紫' },
        frost:   { right: 'rgba(0,122,255,0.55)', left: 'rgba(255,255,255,0.35)', rightText: '#fff', leftText: '#222', label: '磨砂玻璃', frost: true },
        mint:    { right: '#34c759', left: '#e8f5e9', rightText: '#fff', leftText: '#1b4332', label: '薄荷绿' },
    };

    function contrastText(bg) {
        if (!bg || bg.startsWith('rgba')) return '#fff';
        const c = bg.replace('#', ''); if (c.length !== 6) return '#000';
        const r = parseInt(c.substr(0,2),16), g = parseInt(c.substr(2,2),16), b = parseInt(c.substr(4,2),16);
        return (r*0.299 + g*0.587 + b*0.114) > 150 ? '#000' : '#fff';
    }

    function loadTheme() { try { window.__pmTheme = { ...window.__pmTheme, ...JSON.parse(localStorage.getItem('ST_SMS_THEME')) }; } catch (e) {} }
    function saveTheme() { try { localStorage.setItem('ST_SMS_THEME', JSON.stringify(window.__pmTheme)); } catch (e) {} }
    function loadPokeConfig() { try { window.__pmPokeConfig = JSON.parse(localStorage.getItem('ST_SMS_POKE_CONFIG')) || {}; } catch (e) { window.__pmPokeConfig = {}; } }
    function savePokeConfig() { try { localStorage.setItem('ST_SMS_POKE_CONFIG', JSON.stringify(window.__pmPokeConfig)); } catch (e) {} }
    function loadWordyLimit() { try { window.__pmWordyLimit = !!JSON.parse(localStorage.getItem('ST_SMS_WORDY_LIMIT')); } catch (e) { window.__pmWordyLimit = false; } }
    function saveWordyLimit() { try { localStorage.setItem('ST_SMS_WORDY_LIMIT', JSON.stringify(window.__pmWordyLimit)); } catch (e) {} }

    async function loadBgSettings() {
        try {
            const ls = localStorage.getItem('ST_SMS_BG_GLOBAL') || '';
            if (ls === IDB_MARKER) {
                window.__pmBgGlobal = (await pmIDBGet('ST_SMS_BG_GLOBAL')) || '';
            } else if (pmIsBigData(ls)) {
                window.__pmBgGlobal = ls;
                await pmIDBSet('ST_SMS_BG_GLOBAL', ls);
                try { localStorage.setItem('ST_SMS_BG_GLOBAL', IDB_MARKER); } catch (e) {}
            } else {
                window.__pmBgGlobal = ls;
            }
        } catch (e) { window.__pmBgGlobal = ''; }

        try {
            const raw = JSON.parse(localStorage.getItem('ST_SMS_BG_LOCAL')) || {};
            const result = {};
            let migrated = 0;
            for (const [k, v] of Object.entries(raw)) {
                if (v === IDB_MARKER) {
                    result[k] = (await pmIDBGet('ST_SMS_BG_LOCAL_' + k)) || '';
                } else if (pmIsBigData(v)) {
                    result[k] = v;
                    await pmIDBSet('ST_SMS_BG_LOCAL_' + k, v);
                    raw[k] = IDB_MARKER;
                    migrated++;
                } else {
                    result[k] = v;
                }
            }
            if (migrated > 0) {
                try { localStorage.setItem('ST_SMS_BG_LOCAL', JSON.stringify(raw)); } catch (e) {}
            }
            window.__pmBgLocal = result;
        } catch (e) { window.__pmBgLocal = {}; }
    }

    async function saveBgGlobal() {
        const v = window.__pmBgGlobal || '';
        if (pmIsBigData(v)) {
            await pmIDBSet('ST_SMS_BG_GLOBAL', v);
            try { localStorage.setItem('ST_SMS_BG_GLOBAL', IDB_MARKER); } catch (e) {}
        } else {
            await pmIDBDel('ST_SMS_BG_GLOBAL');
            try { localStorage.setItem('ST_SMS_BG_GLOBAL', v); } catch (e) {}
        }
    }

    async function saveBgLocal() {
        const ptr = {};
        for (const [k, v] of Object.entries(window.__pmBgLocal || {})) {
            if (pmIsBigData(v)) {
                await pmIDBSet('ST_SMS_BG_LOCAL_' + k, v);
                ptr[k] = IDB_MARKER;
            } else {
                await pmIDBDel('ST_SMS_BG_LOCAL_' + k);
                if (v !== undefined) ptr[k] = v; 
            }
        }
        try { localStorage.setItem('ST_SMS_BG_LOCAL', JSON.stringify(ptr)); } catch (e) {}
    }

    function loadGroupMeta() { try { window.__pmGroupMeta = JSON.parse(localStorage.getItem('ST_SMS_GROUP_META')) || {}; } catch (e) { window.__pmGroupMeta = {}; } }
    function saveGroupMeta() { try { localStorage.setItem('ST_SMS_GROUP_META', JSON.stringify(window.__pmGroupMeta)); } catch (e) {} }

    function applyTheme() {
        const el = phoneWindow; if (!el) return;
        const t = window.__pmTheme, p = THEME_PRESETS[t.preset] || THEME_PRESETS.default;
        const rBg = t.customRight || p.right, lBg = t.customLeft || p.left;
        const rTxt = t.customRight ? contrastText(t.customRight) : p.rightText;
        const lTxt = t.customLeft ? contrastText(t.customLeft) : p.leftText;
        const border = t.borderColor || '#1a1a1a';
        el.style.setProperty('--pm-r-bg', rBg); el.style.setProperty('--pm-l-bg', lBg);
        el.style.setProperty('--pm-r-txt', rTxt); el.style.setProperty('--pm-l-txt', lTxt);
        el.style.setProperty('--pm-border', border);
        el.style.setProperty('--pm-frost', p.frost ? '1' : '0');
        const darkMode = t.darkMode || 'light';
        el.setAttribute('data-theme', darkMode);
    }

    function cssUrlEscape(url) {
        return (url || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    }

    function applyBackground() {
        const msgList = phoneWindow?.querySelector('.pm-msg-list'); if (!msgList) return;
        const id = getStorageId(), localKey = `${id}_${currentPersona}`;
        const bg = window.__pmBgLocal[localKey] || window.__pmBgGlobal || '';
        if (bg) {
            msgList.style.setProperty('background-image', `url("${cssUrlEscape(bg)}")`, 'important');
            msgList.style.setProperty('background-size', 'cover', 'important');
            msgList.style.setProperty('background-position', 'center', 'important');
        } else {
            msgList.style.removeProperty('background-image');
            msgList.style.removeProperty('background-size');
            msgList.style.removeProperty('background-position');
        }
    }

    function fitNameFont() {
        const nameEl = phoneWindow?.querySelector('.pm-name');
        if (!nameEl) return;
        nameEl.style.fontSize = '15px';
        requestAnimationFrame(() => {
            let fs = 15;
            while (nameEl.scrollWidth > nameEl.clientWidth && fs > 9) {
                fs -= 0.5; nameEl.style.fontSize = fs + 'px';
            }
        });
    }

    function escapeHtml(s) {
        return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }
    function escapeAttr(s) {
        return (s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }
    function safeJS(s) {
        const jsEscaped = (s || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '\\"').replace(/\n/g, '\\n');
        return escapeAttr(jsEscaped);
    }

    function openCropper(imgDataUrl, onConfirm) {
        const ratio = 330 / 450;
        document.getElementById('pm-overlay')?.remove();
        const ov = document.createElement('div'); ov.id = 'pm-overlay';
        if (POPOVER_SUPPORTED) ov.setAttribute('popover', 'manual');
        ov.innerHTML = `
<div class="pm-modal pm-modal-wide">
  <div class="pm-modal-header"><b>裁剪图片</b><span onclick="document.getElementById('pm-overlay').remove();window.__pmShowConfig();" class="pm-modal-close">✕</span></div>
  <div style="padding:12px 14px;">
    <div class="pm-crop-tip">拖动图片调整位置，滚轮/捏合缩放</div>
    <div class="pm-crop-frame" id="pm-crop-frame">
      <img id="pm-crop-img" src="${escapeAttr(imgDataUrl)}" alt="">
      <div class="pm-crop-mask"></div>
    </div>
    <div class="pm-crop-zoom">
      <span style="font-size:11px;color:#888;">缩放</span>
      <input type="range" id="pm-crop-zoom" min="100" max="400" value="100">
    </div>
  </div>
  <div class="pm-modal-add" style="display:flex;gap:8px;">
    <button onclick="document.getElementById('pm-overlay').remove();window.__pmShowConfig();" style="flex:1;background:#f0f0f0;color:#333;border:none;border-radius:10px;padding:10px;font-size:13px;cursor:pointer;">取消</button>
    <button id="pm-crop-confirm" style="flex:1;background:#007aff;color:#fff;border:none;border-radius:10px;padding:10px;font-size:13px;cursor:pointer;font-weight:600;">确认裁剪</button>
  </div>
</div>`;
        ov.addEventListener('click', e => { if (e.target === ov) { ov.remove(); window.__pmShowConfig(); } });
        document.body.appendChild(ov);
        if (ov.showPopover) try { ov.showPopover(); } catch (e) {}
        const frame = ov.querySelector('#pm-crop-frame'), img = ov.querySelector('#pm-crop-img');
        const zoomSlider = ov.querySelector('#pm-crop-zoom');
        let tx = 0, ty = 0, scale = 1, frameW = 0, frameH = 0, baseW = 0, baseH = 0;
        img.onload = () => {
            const cw = frame.clientWidth;
            frameW = cw; frameH = cw / ratio; frame.style.height = frameH + 'px';
            const natW = img.naturalWidth, natH = img.naturalHeight, imgRatio = natW / natH;
            if (imgRatio > ratio) { baseH = frameH; baseW = baseH * imgRatio; }
            else { baseW = frameW; baseH = baseW / imgRatio; }
            updateTransform();
        };
        function updateTransform() {
            const w = baseW * scale, h = baseH * scale;
            tx = Math.max(frameW - w, Math.min(0, tx)); ty = Math.max(frameH - h, Math.min(0, ty));
            img.style.width = w + 'px'; img.style.height = h + 'px';
            img.style.transform = `translate(${tx}px, ${ty}px)`;
        }
        zoomSlider.oninput = () => { scale = parseInt(zoomSlider.value) / 100; updateTransform(); };
        let dragging = false, sx = 0, sy = 0, stx = 0, sty = 0;
        const onDragStart = (e) => { dragging = true; const c = e.touches ? e.touches[0] : e; sx = c.clientX; sy = c.clientY; stx = tx; sty = ty; if (e.cancelable) e.preventDefault(); };
        const onDragMove = (e) => { if (!dragging) return; const c = e.touches ? e.touches[0] : e; tx = stx + (c.clientX - sx); ty = sty + (c.clientY - sy); updateTransform(); if (e.cancelable) e.preventDefault(); };
        const onDragEnd = () => { dragging = false; };
        frame.addEventListener('mousedown', onDragStart);
        window.addEventListener('mousemove', onDragMove);
        window.addEventListener('mouseup', onDragEnd);
        frame.addEventListener('touchstart', onDragStart, { passive: false });
        window.addEventListener('touchmove', onDragMove, { passive: false });
        window.addEventListener('touchend', onDragEnd);
        let pinchDist = 0, pinchScale = 1;
        frame.addEventListener('touchstart', (e) => {
            if (e.touches.length === 2) { pinchDist = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY); pinchScale = scale; }
        }, { passive: false });
        frame.addEventListener('touchmove', (e) => {
            if (e.touches.length === 2) {
                const d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
                scale = Math.max(1, Math.min(4, pinchScale * d / pinchDist));
                zoomSlider.value = Math.round(scale * 100); updateTransform(); e.preventDefault();
            }
        }, { passive: false });
        frame.addEventListener('wheel', (e) => {
            e.preventDefault();
            scale = Math.max(1, Math.min(4, scale + (e.deltaY > 0 ? -0.1 : 0.1)));
            zoomSlider.value = Math.round(scale * 100); updateTransform();
        });
        ov.querySelector('#pm-crop-confirm').onclick = () => {
            const canvas = document.createElement('canvas');
            const outW = 600, outH = Math.round(outW / ratio);
            canvas.width = outW; canvas.height = outH;
            const ctx = canvas.getContext('2d');
            const srcScale = img.naturalWidth / (baseW * scale);
            ctx.drawImage(img, (-tx) * srcScale, (-ty) * srcScale, frameW * srcScale, frameH * srcScale, 0, 0, outW, outH);
            let q = 0.7, out = canvas.toDataURL('image/jpeg', q);
            while (out.length > 200 * 1370 && q > 0.2) { q -= 0.1; out = canvas.toDataURL('image/jpeg', q); }
            ov.remove(); onConfirm(out);
        };
    }

    // 更新模糊匹配字典，增加"退还"
    const SPECIAL_KEYWORDS = {
        '转账':'转账','transfer':'转账','Transfer':'转账','TRANSFER':'转账','轉賬':'转账','轉帳':'转账',
        '收款':'收款','receive':'收款','Receive':'收款','RECEIVE':'收款','收钱':'收款','收到':'收款','收款':'收款','收錢':'收款',
        '退还':'退还','退钱':'退还','退款':'退还','refund':'退还','Refund':'退还','REFUND':'退还','退還':'退还','退錢':'退还',
        '图片':'图片','image':'图片','Image':'图片','IMAGE':'图片','img':'图片','pic':'图片','photo':'图片','圖片':'图片',
        '语音':'语音','voice':'语音','Voice':'语音','VOICE':'语音','audio':'语音','語音':'语音',
    };
    const KW_PATTERN = Object.keys(SPECIAL_KEYWORDS).join('|');
    const SPECIAL_RE = new RegExp(`[\\(（]\\s*(${KW_PATTERN})\\s*[+：:\\s]*([^)）]+)[\\)）]`, 'gi');
    function normalizeKeyword(k) { return SPECIAL_KEYWORDS[k] || SPECIAL_KEYWORDS[k.toLowerCase()] || k; }
    // [emo:套组名:序号] 格式，AI 和用户都可以发送
    const EMO_RE = /\[emo:([^\]:]+):(\d+)\]/gi;
    // 查找表情包图片：先按套组名+序号精确匹配，返回 url 或 null
    function findEmojiUrl(setName, idx) {
        const set = window.__pmEmojis.find(s => s.name === setName);
        if (!set) return null;
        const img = set.images[idx - 1]; // 序号从1开始
        return img ? img.url : null;
    }

    function getStorageId() {
        const c = getCtx(); if (!c) return 'sms_unknown__default';
        const char = c.characters?.[c.characterId];
        const avatar = char?.avatar || `idx_${c.characterId}`;
        const chatFile = c.chatId || (typeof c.getCurrentChatId === 'function' ? c.getCurrentChatId() : null) || c.chat_metadata?.chat_id_hash || c.chat_file || 'default';
        // 恢复使用 chatId 以区分不同角色卡（纯去掉 chatId 会导致同名头像的卡串记录）
        // 之前报告的"记录消失"真正原因是 localStorage 被旧数据覆盖，已在 __pmOpen 里修复
        return `sms_${avatar}__${chatFile}`;
    }

    function migrateOldHistory() {
        if (localStorage.getItem('ST_SMS_MIGRATED_V3')) return;
        const c = getCtx(); if (!c) return;
        try {
            const oldData = window.__pmHistories || {}, newData = {}; let migrated = 0;
            for (const oldKey of Object.keys(oldData)) {
                if (oldKey.startsWith('sms_')) { newData[oldKey] = oldData[oldKey]; continue; }
                // 旧格式：数字索引_chatId，迁移为 sms_avatar__chatId
                const m = oldKey.match(/^(\d+)_(.+)$/);
                if (!m) { newData[oldKey] = oldData[oldKey]; continue; }
                const ch = c.characters?.[parseInt(m[1])];
                if (ch?.avatar) { newData[`sms_${ch.avatar}__${m[2]}`] = oldData[oldKey]; migrated++; }
                else newData[oldKey] = oldData[oldKey];
            }
            window.__pmHistories = newData;
            saveHistories();
            localStorage.setItem('ST_SMS_MIGRATED_V3', '1');
        } catch (e) {}
    }

    function normalizeApiUrls(input) {
        let url = (input || '').trim().replace(/\/+$/, '');
        if (!url) return { chatUrl: '', modelsUrl: '' };
        if (/\/chat\/completions$/i.test(url)) return { chatUrl: url, modelsUrl: url.replace(/\/chat\/completions$/i, '/models') };
        if (/\/models$/i.test(url)) return { chatUrl: url.replace(/\/models$/i, '/chat/completions'), modelsUrl: url };
        if (/\/v\d+$/i.test(url)) return { chatUrl: url + '/chat/completions', modelsUrl: url + '/models' };
        return { chatUrl: url + '/v1/chat/completions', modelsUrl: url + '/v1/models' };
    }

    function loadProfiles() { try { window.__pmProfiles = JSON.parse(localStorage.getItem('ST_SMS_API_PROFILES')) || []; } catch (e) { window.__pmProfiles = []; } }
    function saveProfiles() { try { localStorage.setItem('ST_SMS_API_PROFILES', JSON.stringify(window.__pmProfiles)); } catch (e) {} }
    function addOrUpdateProfile(p) {
        if (!p.apiUrl || !p.apiKey) return;
        const idx = window.__pmProfiles.findIndex(x => x.apiUrl === p.apiUrl && x.apiKey === p.apiKey);
        if (idx >= 0) window.__pmProfiles[idx] = { ...window.__pmProfiles[idx], ...p, savedAt: Date.now() };
        else window.__pmProfiles.push({ ...p, savedAt: Date.now() });
        saveProfiles();
    }
    window.__pmDeleteProfile = (idx) => { window.__pmProfiles.splice(idx, 1); saveProfiles(); window.__pmShowConfig(); };
    window.__pmPickProfile = (idx) => {
        const p = window.__pmProfiles[idx]; if (!p) return;
        const u = document.getElementById('pm-cfg-url'), k = document.getElementById('pm-cfg-key'), m = document.getElementById('pm-cfg-model');
        if (u) u.value = p.apiUrl || ''; if (k) k.value = p.apiKey || ''; if (m) m.value = p.model || '';
    };

    window.__pmSetMode = (v) => {
        window.__pmConfig.useIndependent = !!v;
        try { localStorage.setItem('ST_SMS_CONFIG', JSON.stringify(window.__pmConfig)); } catch (e) {}
        const a = document.getElementById('pm-mode-main'), b = document.getElementById('pm-mode-indep'), t = document.getElementById('pm-mode-tip');
        if (a && b) { a.classList.toggle('pm-mode-active', !v); b.classList.toggle('pm-mode-active', !!v); }
        if (t) t.textContent = v ? '🔌 独立API' : '🏠 主API';
    };

    function loadBidirectional() { try { window.__pmBidirectional = JSON.parse(localStorage.getItem('ST_SMS_BIDIRECTIONAL')) || {}; } catch (e) { window.__pmBidirectional = {}; } }
    function saveBidirectional() { try { localStorage.setItem('ST_SMS_BIDIRECTIONAL', JSON.stringify(window.__pmBidirectional)); } catch (e) {} }

    // 把 [emo:套组名:序号] 替换成描述文字，用于注入主楼上下文
    function resolveEmojiText(text) {
        return (text || '').replace(/\[emo:([^\]:]+):(\d+)\]/g, (match, setName, idx) => {
            const set = window.__pmEmojis.find(s => s.name === setName);
            const img = set?.images[parseInt(idx) - 1];
            return img ? `(表情:${img.desc})` : '';
        });
    }

    function applyBidirectionalInjection() {
        const c = getCtx(); if (!c || typeof c.setExtensionPrompt !== 'function') return;
        const userName = getUserPersona().name || '用户';
        
        const id = getStorageId(), checked = window.__pmBidirectional[id] || [], histories = window.__pmHistories[id] || {};
        const groups = window.__pmGroupMeta[id] || {};
        if (!checked.length) { try { c.setExtensionPrompt(BIDIRECTIONAL_KEY, '', 0, 0, false, 0); } catch (e) {} return; }
        const blocks = checked.map(name => {
            const conv = (histories[name] || []).slice(-BIDIRECTIONAL_LIMIT);
            if (!conv.length) return '';
            if (name.startsWith('__group_')) {
                const meta = groups[name]; if (!meta) return '';
                const lines = conv.map(m => {
                    const t = resolveEmojiText((m.content || '').replace(/\s*\/\s*/g, '。').replace(/\n/g, '；'));
                    return m.role === 'user' ? `${userName}：${t}` : t;
                }).join('\n');
                return `【群聊"${meta.name}"（成员：${meta.members.join('、')}）的最近聊天 — 仅参与者与 ${userName} 知晓，其他角色不应知情】\n${lines}`;
            }
            const lines = conv.map(m => { 
                const t = resolveEmojiText((m.content || '').replace(/\s*\/\s*/g, '。')); 
                return m.role === 'user' ? `${userName}：${t}` : `${name}：${t}`; 
            }).join('\n');
            return `【与 ${name} 的短信 — 仅 ${name} 与 ${userName} 知晓】\n${lines}`;
        }).filter(Boolean).join('\n\n');
        if (!blocks) { try { c.setExtensionPrompt(BIDIRECTIONAL_KEY, '', 0, 0, false, 0); } catch (e) {} return; }
        try { c.setExtensionPrompt(BIDIRECTIONAL_KEY, `[手机短信记忆 — 私密]\n${blocks}\n[结束]`, 0, 0, false, 0); } catch (e) {}
    }

    let __pmLastChatLen = 0;

    function hookGenerationEvent() {
        if (__pmEventHooked) return;
        const c = getCtx();
        if (!c?.eventSource || !c?.event_types) return;
        const et = c.event_types;

        __pmLastChatLen = (c.chat || []).length;

        const events = [
            et.GENERATION_STARTED || 'generation_started',
            et.CHAT_CHANGED || 'chat_id_changed',
            et.SETTINGS_UPDATED || 'settings_updated',
            et.CHATCOMPLETION_SOURCE_CHANGED || 'chatcompletion_source_changed',
            et.OAI_PRESET_CHANGED_AFTER || 'oai_preset_changed_after',
        ];
        
        events.forEach(ev => {
            try {
                c.eventSource.on(ev, () => {
                    try { applyBidirectionalInjection(); } catch (e) {}
                });
            } catch (e) {}
        });

        try {
            c.eventSource.on(et.MESSAGE_RECEIVED || 'message_received', () => {
                const currentLen = (c.chat || []).length;
                if (currentLen > __pmLastChatLen) {
                    __pmLastChatLen = currentLen;
                    if (typeof window.__pmIncrementCounters === 'function') {
                        window.__pmIncrementCounters();
                    }
                } else if (currentLen < __pmLastChatLen) {
                    __pmLastChatLen = currentLen;
                }
            });
            c.eventSource.on(et.CHAT_CHANGED || 'chat_id_changed', () => {
                __pmLastChatLen = (c.chat || []).length;
                // 修复：当酒馆主线切换角色/聊天时，强制关闭手机，防止下一次发短信存错 ID
                if (phoneActive && typeof window.__pmEnd === 'function') {
                    window.__pmEnd();
                }
            });
        } catch (e) {}

        __pmEventHooked = true;
        console.log('[phone-mode] hooked', events.length, 'events');
    }

    window.__pmToggleBidirectional = (name) => {
        const id = getStorageId(), arr = window.__pmBidirectional[id] || [], idx = arr.indexOf(name);
        if (idx >= 0) arr.splice(idx, 1);
        else { if (arr.length >= MAX_BIDIRECTIONAL) return; arr.push(name); }
        window.__pmBidirectional[id] = arr; saveBidirectional(); applyBidirectionalInjection(); window.__pmShowList();
    };

    function getUserPersona() {
        const c = getCtx();
        if (!c) return { name: '用户', description: '' };
        let name = c.name1 || 'User';
        let description = '';

        try {
            const pu = c.powerUserSettings || c.power_user || window.power_user;
            if (pu) {
                description = pu.persona_description || pu.personaDescription || '';
                const avatar = c.userAvatar || pu.user_avatar || pu.default_persona;
                if (!description && avatar) {
                    const pdMap = pu.persona_descriptions || pu.personaDescriptions;
                    if (pdMap?.[avatar]) {
                        const pd = pdMap[avatar];
                        if (typeof pd === 'string') description = pd;
                        else if (pd?.description) description = pd.description;
                    }
                }
            }
        } catch (e) {}

        if (!description) {
            try {
                const meta = c.chatMetadata || c.chat_metadata;
                if (meta?.persona) description = String(meta.persona);
            } catch (e) {}
        }

        try {
            if (typeof c.substituteParams === 'function') {
                const resolvedName = c.substituteParams('{{user}}');
                if (resolvedName && resolvedName !== '{{user}}' && resolvedName.trim()) {
                    name = resolvedName.trim();
                }
            }
        } catch (e) {}

        return { name, description };
    }

    async function gatherContext() {
        const c = getCtx(), char = c?.characters?.[c.characterId] || {};
        const cleanMsg = (s) => (s || '').replace(/```[\s\S]*?```/g, '').replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<[^>]+>/g, '').trim();
        const mainChatArr = (c?.chat || []).slice(-8).map(m => ({ who: m.is_user ? '用户' : (m.name || '角色'), content: cleanMsg(m.mes || '') })).filter(m => m.content);
        const mainChatText = mainChatArr.map(m => `${m.who}：${m.content}`).join('\n');
        let worldBookText = '';
        try {
            if (typeof c?.getWorldInfoPrompt === 'function') {
                const ctxSize = c?.powerUserSettings?.openai_max_context
                    || c?.oai_settings?.openai_max_context
                    || c?.maxContext
                    || 131072;
                const wi = await c.getWorldInfoPrompt((c.chat || []).map(m => m.mes || '').slice(-10), ctxSize, false);
                worldBookText = wi?.worldInfoString || wi?.worldInfoBefore || '';
                if (!worldBookText && wi && typeof wi === 'object') worldBookText = [wi.worldInfoBefore, wi.worldInfoAfter].filter(Boolean).join('\n');
            }
        } catch (e) {}
        const userPersona = getUserPersona();
        return {
            cardDesc: char.description ?? '',
            cardPersonality: char.personality ?? '',
            cardScenario: char.scenario ?? '',
            cardFirstMes: char.first_mes ?? '',
            cardMesExample: char.mes_example ?? '',
            mainChatText, worldBookText,
            userName: userPersona.name,
            userDesc: userPersona.description,
        };
    }

    function bindIsland(el, handle) {
        let isDragging = false, startX, startY, startTX = 0, startTY = 0, moved = false;
        const getCoord = (e) => e.touches ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : { x: e.clientX, y: e.clientY };
        const getT = () => { const m = (el.style.transform || '').match(/translate\(\s*([-\d.]+)px\s*,\s*([-\d.]+)px/); return m ? { x: parseFloat(m[1]), y: parseFloat(m[2]) } : { x: 0, y: 0 }; };
        const onStart = (e) => {
            if (e.target.tagName === 'BUTTON') return;
            isDragging = true; moved = false;
            const coords = getCoord(e); startX = coords.x; startY = coords.y;
            const t = getT(); startTX = t.x; startTY = t.y;
            el.style.transition = 'none'; if (e.cancelable) e.preventDefault();
        };
        const onMove = (e) => {
            if (!isDragging) return;
            const coords = getCoord(e), dx = coords.x - startX, dy = coords.y - startY;
            if (!moved && Math.abs(dx) < 5 && Math.abs(dy) < 5) return;
            moved = true; if (e.cancelable) e.preventDefault();
            el.style.setProperty('transform', `translate(${startTX + dx}px, ${startTY + dy}px)`, 'important');
        };
        const onEnd = () => { if (!isDragging) return; isDragging = false; el.style.transition = '.35s cubic-bezier(.18,.89,.32,1.2)'; if (!moved) window.__pmToggleMin(); };
        handle.addEventListener('mousedown', onStart); window.addEventListener('mousemove', onMove); window.addEventListener('mouseup', onEnd);
        handle.addEventListener('touchstart', onStart, { passive: false }); window.addEventListener('touchmove', onMove, { passive: false }); window.addEventListener('touchend', onEnd);
    }

    function resolveGroupColor(name) {
        if (!name) return null;
        if (groupColorMap[name]) return groupColorMap[name];
        const lower = name.toLowerCase();
        for (const [k, v] of Object.entries(groupColorMap)) {
            if (k.toLowerCase() === lower) return v;
        }
        const idx = groupMembers.findIndex(n => n.toLowerCase() === lower);
        if (idx >= 0) return GROUP_COLORS[idx % GROUP_COLORS.length];
        return null;
    }

    // 字数控制提示词
    function getWordyPrompt() {
        if (!window.__pmWordyLimit) return '';
        return '\n\n[字数限制] 除非角色人设明确为话痨或碎嘴性格，否则每条独立消息（每个 / 分隔的片段）不得超过35个字符，超出请拆分为多条。';
    }

    // 生成表情包提示词\uff0c格式 [emo:套组名:序号]
    function getEmojiPrompt(contactKey) {
        const id = getStorageId();
        const assignedIds = window.__pmPokeConfig[id]?.[contactKey]?.emojis || [];
        if (!assignedIds.length) return '';
        const sets = window.__pmEmojis.filter(s => assignedIds.includes(s.id));
        if (!sets.length) return '';
        const lines = sets.map(s =>
            s.images.map((img, i) => `[emo:${s.name}:${i+1}] - ${img.desc}`).join('\n')
        ).join('\n');
        return `\n\n[表情包权限]
你可以在合适时机使用以下表情包，使用格式 [emo:套组名:序号] 独行发送：\n${lines}\n请在自然语境下适当使用，严禁自生新格式。`;
    }

    function createBubbles(text, side, senderName) {
        const results = [];
        const re = new RegExp(SPECIAL_RE.source, 'gi');
        let last = 0, m;
        const gc = senderName && side === 'left' ? resolveGroupColor(senderName) : null;
        const pushPlain = (str) => {
            const plain = str.trim(); if (!plain) return;
            if (senderName && side === 'left') {
                const wrapper = document.createElement('div'); wrapper.className = 'pm-group-bubble-wrap';
                const nameTag = document.createElement('div'); nameTag.className = 'pm-group-name'; nameTag.textContent = senderName;
                if (gc) nameTag.style.color = gc.bg;
                wrapper.appendChild(nameTag);
                const inner = document.createElement('div'); inner.className = `pm-bubble pm-${side}`;
                if (gc) {
                    inner.style.setProperty('background', gc.bg, 'important');
                    inner.style.setProperty('color', gc.text, 'important');
                }
                inner.innerHTML = escapeHtml(plain).replace(/\n/g, '<br>');
                wrapper.appendChild(inner); results.push(wrapper); return;
            }
            const b = document.createElement('div'); b.className = `pm-bubble pm-${side}`;
            b.innerHTML = escapeHtml(plain).replace(/\n/g, '<br>');
            results.push(b);
        };
        while ((m = re.exec(text)) !== null) {
            if (m.index > last) pushPlain(text.slice(last, m.index));
            const kind = normalizeKeyword(m[1]);
            const isGroupLeft = senderName && side === 'left';
            let container;
            if (isGroupLeft) {
                container = document.createElement('div'); container.className = 'pm-group-bubble-wrap';
                const nameTag = document.createElement('div'); nameTag.className = 'pm-group-name'; nameTag.textContent = senderName;
                if (gc) nameTag.style.color = gc.bg;
                container.appendChild(nameTag);
            }
            const b = document.createElement('div'); b.className = `pm-bubble pm-${side} pm-special`;
            
            if (kind === '转账') {
                const amount = parseFloat(m[2]) || 0;
                b.innerHTML = `<div class="pm-transfer-card"><div class="pm-t-icon">¥</div><div class="pm-t-info"><b>转账</b><span>¥${amount.toFixed(2)}</span></div></div>`;
            } else if (kind === '收款') {
                const amount = parseFloat(m[2]) || 0;
                b.innerHTML = `<div class="pm-receive-card"><div class="pm-t-icon">¥</div><div class="pm-t-info"><b>收款</b><span>¥${amount.toFixed(2)}</span></div></div>`;
            } else if (kind === '退还') {
                const amount = parseFloat(m[2]) || 0;
                b.innerHTML = `<div class="pm-refund-card"><div class="pm-t-icon">¥</div><div class="pm-t-info"><b>已退还</b><span>¥${amount.toFixed(2)}</span></div></div>`;
            } else if (kind === '图片') {
                b.innerHTML = `<div class="pm-img-card" data-desc="${escapeAttr(m[2].trim())}" role="button" tabindex="0" onclick="window.__pmGenChatImg(this)">🖼️ ${escapeHtml(m[2].trim())}</div>`;
            } else {
                const txt = m[2].trim(), len = [...txt].length;
                let dur;
                if (len <= 5) dur = Math.max(1, len);
                else if (len <= 15) dur = 5 + (len - 5);
                else if (len <= 40) dur = 15 + Math.ceil((len - 15) * 0.8);
                else dur = Math.min(VOICE_MAX_SEC, 35 + Math.ceil((len - 40) * 0.5));
                const width = Math.min(240, Math.max(110, 90 + Math.min(len, 30) * 4));
                let voiceStyle = `width:${width}px`, voiceClass = `pm-voice-card pm-voice-${side}`;
                if (isGroupLeft && gc) {
                    voiceStyle = `width:${width}px;background:${gc.bg} !important;color:${gc.text} !important;`;
                    voiceClass = 'pm-voice-card pm-voice-left pm-voice-group';
                }
                b.innerHTML = `<div class="pm-voice-wrap"><div class="pm-voice-row"><div class="${voiceClass}" style="${voiceStyle}" onclick="window.__pmToggleVoice(this)"><span class="pm-voice-icon">🎤</span><span class="pm-voice-wave"><i></i><i></i><i></i></span><span class="pm-voice-dur">${dur}"</span></div><span class="pm-voice-play" role="button" tabindex="0" title="朗读" onclick="event.stopPropagation();window.__pmPlayTTS(this)">🔊</span></div><div class="pm-voice-text" style="display:none;">${escapeHtml(txt)}</div></div>`;
            }
            if (container) { container.appendChild(b); results.push(container); }
            else results.push(b);
            last = m.index + m[0].length;
        }
        if (last < text.length) pushPlain(text.slice(last));
        if (!results.length) pushPlain(text);
        // 最后再对所有末尾文本气泡对 [emo:...] 进行单翻替换
        results.forEach(bubble => {
            const els = bubble.classList?.contains('pm-group-bubble-wrap')
                ? bubble.querySelectorAll('.pm-bubble')
                : (bubble.classList?.contains('pm-bubble') ? [bubble] : []);
            els.forEach(el => {
                if (!el.innerHTML.includes('[emo:')) return;
                el.innerHTML = el.innerHTML.replace(/\[emo:([^\]:]+):(\d+)\]/g, (match, sName, sIdx) => {
                    const url = findEmojiUrl(sName, parseInt(sIdx));
                    if (url) return `<img src="${url.replace(/"/g,'&quot;')}" style="max-width:98px;border-radius:8px;display:block;box-shadow:0 2px 8px rgba(0,0,0,0.15);vertical-align:middle;">`;
                    return `<span style="font-size:12px;color:#999;">🤔[${sName}:${sIdx}]</span>`;
                });
                el.style.background = el.querySelector('img') && el.childNodes.length===1 ? 'transparent' : '';
                el.style.boxShadow = el.querySelector('img') && el.childNodes.length===1 ? 'none' : '';
                el.style.padding = el.querySelector('img') && el.childNodes.length===1 ? '0' : '';
            });
        });
        return results;
    }

    window.__pmToggleVoice = (el) => {
        const wrap = el.closest('.pm-voice-wrap');
        const txt = wrap?.querySelector('.pm-voice-text');
        if (txt) txt.style.display = txt.style.display === 'none' ? 'block' : 'none';
    };

    // ── TTS 模块 ──────────────────────────────────────────
    const __pmTtsCache = new Map(); // key=text → blobURL
    let __pmTtsAudio = null;

    window.__pmTtsProviderChange = () => {
        const p = document.getElementById('pm-tts-provider')?.value || '';
        const show = (id, v) => { const el = document.getElementById(id); if (el) el.style.display = v ? '' : 'none'; };
        show('pm-tts-url', p && p !== 'doubao');
        show('pm-tts-key', !!p);
        show('pm-tts-doubao-row', p === 'doubao');
        show('pm-tts-voice', !!p);
        show('pm-tts-model-row', p === 'openai' || p === 'minimax');
    };

    window.__pmTtsUiLoad = () => {
        const c = window.__pmConfig.tts || {};
        const sel = document.getElementById('pm-tts-provider');
        if (sel) sel.value = c.provider || '';
        const f = (id, v) => { const el = document.getElementById(id); if (el) el.value = v || ''; };
        f('pm-tts-url', c.url); f('pm-tts-key', c.key);
        f('pm-tts-appid', c.appid); f('pm-tts-cluster', c.cluster);
        f('pm-tts-voice', c.voice); f('pm-tts-model', c.model);
        window.__pmTtsProviderChange();
    };

    window.__pmTtsSave = () => {
        const g = id => document.getElementById(id)?.value.trim() || '';
        const p = g('pm-tts-provider');
        window.__pmConfig.tts = { provider: p, url: g('pm-tts-url'), key: g('pm-tts-key'), appid: g('pm-tts-appid'), cluster: g('pm-tts-cluster'), voice: g('pm-tts-voice'), model: g('pm-tts-model') };
    };

    window.__pmPlayTTS = async (btn) => {
        const tts = window.__pmConfig.tts || {};
        if (!tts.provider) return;
        const wrap = btn.closest('.pm-voice-wrap');
        const textEl = wrap?.querySelector('.pm-voice-text');
        const text = textEl?.textContent?.trim();
        if (!text) return;
        if (__pmTtsCache.has(text)) {
            __pmTtsPlayUrl(__pmTtsCache.get(text), btn);
            return;
        }
        btn.textContent = '⏳';
        try {
            const url = await __pmTtsFetch(tts, text);
            __pmTtsCache.set(text, url);
            __pmTtsPlayUrl(url, btn);
        } catch (e) {
            btn.textContent = '🔊';
            console.error('[TTS]', e);
            alert('TTS 失败：' + e.message);
        }
    };

    function __pmTtsPlayUrl(url, btn) {
        if (__pmTtsAudio) { __pmTtsAudio.pause(); __pmTtsAudio.src = ''; }
        __pmTtsAudio = new Audio(url);
        __pmTtsAudio.play();
        btn.textContent = '⏹';
        __pmTtsAudio.onended = () => { btn.textContent = '🔊'; };
        __pmTtsAudio.onerror = () => { btn.textContent = '🔊'; };
        // 停止播放
        btn.onclick = (e) => {
            e.stopPropagation();
            if (__pmTtsAudio) { __pmTtsAudio.pause(); __pmTtsAudio.src = ''; __pmTtsAudio = null; }
            btn.textContent = '🔊';
            btn.onclick = (ev) => { ev.stopPropagation(); window.__pmPlayTTS(btn); };
        };
    }

    async function __pmTtsFetch(tts, text) {
        const { provider, url, key, appid, cluster, voice, model } = tts;
        if (provider === 'openai') {
            const base = (url || 'https://api.openai.com/v1').replace(/\/$/, '');
            const r = await fetch(`${base}/audio/speech`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
                body: JSON.stringify({ model: model || 'tts-1', voice: voice || 'alloy', input: text })
            });
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            const blob = await r.blob();
            return URL.createObjectURL(blob);
        }
        if (provider === 'minimax') {
            const base = (url || 'https://api.minimax.chat/v1').replace(/\/$/, '');
            const r = await fetch(`${base}/t2a_v2`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
                body: JSON.stringify({ model: model || 'speech-01-turbo', text, voice_setting: { voice_id: voice || 'female-tianmei' } })
            });
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            const j = await r.json();
            if (j.base_resp?.status_code && j.base_resp.status_code !== 0) throw new Error(j.base_resp.status_msg || '未知错误');
            const hex = j.data?.audio;
            if (!hex) throw new Error('MiniMax 未返回音频');
            const bytes = new Uint8Array(hex.match(/.{1,2}/g).map(b => parseInt(b, 16)));
            return URL.createObjectURL(new Blob([bytes], { type: 'audio/mpeg' }));
        }
        if (provider === 'doubao') {
            const base = (url || 'https://openspeech.bytedance.com/api/v1/tts').replace(/\/$/, '');
            const r = await fetch(base, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer;${key}` },
                body: JSON.stringify({ app: { appid: appid || '', token: key, cluster: cluster || 'volcano_tts' }, user: { uid: 'pm_tts' }, audio: { voice_type: voice || 'BV001_streaming', encoding: 'mp3' }, request: { reqid: Date.now().toString(), text, operation: 'query' } })
            });
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            const j = await r.json();
            if (j.code && j.code !== 3000) throw new Error(j.message || '未知错误');
            const b64 = j.data;
            if (!b64) throw new Error('火山引擎未返回音频');
            const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
            return URL.createObjectURL(new Blob([bytes], { type: 'audio/mpeg' }));
        }
        throw new Error('未知 TTS provider');
    }
    // ── TTS 模块结束 ──────────────────────────────────────

    // ── 生图模块 ──────────────────────────────────────────
    const PM_IMG_PER_CHAT = 30;
    const PM_IMG_GLOBAL   = 300;

    window.__pmImgUiLoad = () => {
        const c = window.__pmConfig.img || {};
        const f = (id, v) => { const el = document.getElementById(id); if (el) el.value = v || ''; };
        f('pm-img-provider', c.provider);
        f('pm-img-url', c.url);
        f('pm-img-key', c.key);
        f('pm-img-model', c.model);
        f('pm-img-size', c.size || '1024x1024');
    };

    window.__pmImgSave = () => {
        const g = id => document.getElementById(id)?.value.trim() || '';
        window.__pmConfig.img = { provider: g('pm-img-provider'), url: g('pm-img-url'), key: g('pm-img-key'), model: g('pm-img-model'), size: g('pm-img-size') || '1024x1024' };
    };

    async function pmImgLoad() {
        if (window.__pmImgStore) return;
        window.__pmImgStore = (await pmIDBGet('ST_SMS_IMGS')) || [];
    }
    async function pmImgSave() { await pmIDBSet('ST_SMS_IMGS', window.__pmImgStore || []).catch(() => {}); }

    function pmImgEvict(storageId) {
        const store = window.__pmImgStore;
        // 每聊天上限
        const chat = store.filter(x => x.sid === storageId);
        if (chat.length >= PM_IMG_PER_CHAT) {
            const oldest = chat.sort((a, b) => a.ts - b.ts)[0];
            const idx = store.indexOf(oldest);
            if (idx !== -1) store.splice(idx, 1);
        }
        // 全局上限
        while (store.length >= PM_IMG_GLOBAL) {
            store.sort((a, b) => a.ts - b.ts);
            store.shift();
        }
    }

    function pmImgFind(storageId, key) {
        return (window.__pmImgStore || []).find(x => x.sid === storageId && x.key === key) || null;
    }

    async function pmImgCompress(dataUrl) {
        return new Promise(resolve => {
            const img = new Image();
            img.onload = () => {
                const MAX = 768;
                let { width: w, height: h } = img;
                if (w > MAX || h > MAX) {
                    if (w > h) { h = Math.round(h * MAX / w); w = MAX; }
                    else { w = Math.round(w * MAX / h); h = MAX; }
                }
                const c = document.createElement('canvas'); c.width = w; c.height = h;
                c.getContext('2d').drawImage(img, 0, 0, w, h);
                resolve(c.toDataURL('image/jpeg', 0.82));
            };
            img.onerror = () => resolve(dataUrl);
            img.src = dataUrl;
        });
    }

    async function pmImgFetch(prompt) {
        const cfg = window.__pmConfig.img || {};
        if (!cfg.provider) throw new Error('未配置生图 API');
        const [w, h] = (cfg.size || '1024x1024').split('x').map(Number);
        if (cfg.provider === 'openai') {
            const base = (cfg.url || 'https://api.openai.com/v1').replace(/\/$/, '');
            const r = await fetch(`${base}/images/generations`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${cfg.key}` },
                body: JSON.stringify({ model: cfg.model || 'dall-e-3', prompt, n: 1, size: cfg.size || '1024x1024', response_format: 'b64_json' })
            });
            if (!r.ok) { const t = await r.text(); throw new Error(`HTTP ${r.status}: ${t.slice(0, 120)}`); }
            const j = await r.json();
            const b64 = j.data?.[0]?.b64_json;
            if (!b64) throw new Error('OpenAI 未返回图片');
            return await pmImgCompress(`data:image/png;base64,${b64}`);
        }
        if (cfg.provider === 'nai') {
            const base = (cfg.url || 'https://image.novelai.net').replace(/\/$/, '');
            const r = await fetch(`${base}/ai/generate-image`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${cfg.key}` },
                body: JSON.stringify({ input: prompt, model: cfg.model || 'nai-diffusion-4-5', action: 'generate', parameters: { width: w || 832, height: h || 1216, n_samples: 1, sampler: 'k_euler', steps: 28, scale: 6, noise_schedule: 'karras' } })
            });
            if (!r.ok) { const t = await r.text(); throw new Error(`HTTP ${r.status}: ${t.slice(0, 120)}`); }
            const buf = await r.arrayBuffer();
            // NAI 返回 zip，第一个文件是 PNG
            const arr = new Uint8Array(buf);
            const pngMagic = [0x89, 0x50, 0x4E, 0x47];
            let pngStart = -1;
            for (let i = 0; i < arr.length - 4; i++) {
                if (arr[i] === pngMagic[0] && arr[i+1] === pngMagic[1] && arr[i+2] === pngMagic[2] && arr[i+3] === pngMagic[3]) { pngStart = i; break; }
            }
            if (pngStart === -1) throw new Error('NAI 未找到图片数据');
            const pngSlice = arr.slice(pngStart);
            const b64nai = btoa(String.fromCharCode(...pngSlice));
            return await pmImgCompress(`data:image/png;base64,${b64nai}`);
        }
        throw new Error('未知生图 provider');
    }

    // 聊天侧：点击 pm-img-card 生图
    window.__pmGenChatImg = async (el) => {
        const cfg = window.__pmConfig.img || {};
        if (!cfg.provider) return alert('请先在设置 → 图像 里配置生图 API');
        const desc = el.dataset.desc;
        if (!desc) return;
        await pmImgLoad();
        const sid = getStorageId();
        const key = `chat:${sid}:${desc}`;
        const cached = pmImgFind(sid, key);
        if (cached) { el.innerHTML = `<img src="${escapeAttr(cached.dataUrl)}" style="max-width:100%;border-radius:10px;display:block;">`; el.classList.add('has-img'); return; }
        el.innerHTML = '<span class="wb-spin" style="font-size:18px;">⏳</span>';
        try {
            const dataUrl = await pmImgFetch(desc);
            pmImgEvict(sid);
            window.__pmImgStore.push({ sid, key, dataUrl, ts: Date.now() });
            await pmImgSave();
            el.innerHTML = `<img src="${escapeAttr(dataUrl)}" style="max-width:100%;border-radius:10px;display:block;">`;
            el.classList.add('has-img');
            // 同步写回 conversationHistory
            const hi = parseInt(el.closest('[data-history-index]')?.dataset.historyIndex ?? '-1');
            if (hi >= 0 && conversationHistory[hi]) {
                conversationHistory[hi].content = conversationHistory[hi].content.replace(
                    new RegExp(`\\(图片\\+${desc.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}\\)`, 'g'),
                    `(图片已生成:${key})`
                );
                saveHistories();
            }
        } catch (e) {
            el.innerHTML = `<div style="padding:8px;color:#ff3b30;font-size:12px;">❌ ${escapeHtml(e.message)}</div><span style="font-size:12px;color:#555;">🖼️ ${escapeHtml(desc)}</span>`;
        }
    };

    // 微博侧：点击 .wb-img 占位格生图
    window.__pmGenWbImg = async (el, pid, imgIdx) => {
        const cfg = window.__pmConfig.img || {};
        if (!cfg.provider) return alert('请先在设置 → 图像 里配置生图 API');
        const desc = el.dataset.desc;
        if (!desc) return;
        await pmImgLoad();
        const sid = getStorageId();
        const key = `wb:${pid}:${imgIdx}`;
        const cached = pmImgFind(sid, key);
        if (cached) { __pmApplyWbImg(el, cached.dataUrl); return; }
        el.innerHTML = '<span class="wb-spin" style="font-size:18px;">⏳</span>';
        try {
            const dataUrl = await pmImgFetch(desc);
            pmImgEvict(sid);
            window.__pmImgStore.push({ sid, key, dataUrl, ts: Date.now() });
            await pmImgSave();
            __pmApplyWbImg(el, dataUrl);
            // 写回微博 post.images
            const post = wbFindPost(pid);
            if (post) { post.images[imgIdx] = dataUrl; saveWeiboPosts(); }
        } catch (e) {
            el.innerHTML = `<span style="font-size:10px;color:#ff3b30;">❌ ${escapeHtml(e.message.slice(0,40))}</span>`;
        }
    };

    function __pmApplyWbImg(el, dataUrl) {
        el.classList.add('is-real');
        el.innerHTML = `<img src="${escapeAttr(dataUrl)}" alt="配图">`;
        el.onclick = null;
    }

    // 渲染后把已生成的聊天图片回填到 DOM（同步，store 必须已 loaded）
    function pmImgRestoreChatSync(list) {
        if (!window.__pmImgStore) return;
        const sid = getStorageId();
        list.querySelectorAll('.pm-img-card[data-desc]').forEach(el => {
            const key = `chat:${sid}:${el.dataset.desc}`;
            const cached = pmImgFind(sid, key);
            if (cached) {
                el.innerHTML = `<img src="${escapeAttr(cached.dataUrl)}" style="max-width:100%;border-radius:10px;display:block;">`;
                el.classList.add('has-img');
            }
        });
    }
    // ── 生图模块结束 ──────────────────────────────────────

    function cleanResponse(raw) {
        return (raw ?? '')
            .replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
            .replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, '').replace(/<reflection>[\s\S]*?<\/reflection>/gi, '')
            .replace(/<inner_thought>[\s\S]*?<\/inner_thought>/gi, '')
            .replace(/<scene>[\s\S]*?<\/scene>/gi, '').replace(/<narration>[\s\S]*?<\/narration>/gi, '')
            .replace(/<action>[\s\S]*?<\/action>/gi, '').replace(/```[\s\S]*?```/g, '')
            .replace(/^.*【[^】]{2,}】.*$/gm, '').replace(/---+[\s\S]*$/g, '')
            .replace(/<[^>]+>/g, '').trim();
    }

    function splitToSentences(str, stripFn = null) {
        const protect = (str || '').replace(/[\(（][^)）]*[\)\）]/g, m => m.replace(/\//g, '\u0001'));
        return protect.split(/\s*\/\s*/).map(s => {
            let t = s.replace(/\u0001/g, '/').trim();
            if (stripFn) t = stripFn(t);
            if (!t || t === ')' || t === '）' || t === '(' || t === '（') return '';
            const opens = (t.match(/[（(]/g) || []).length;
            const closes = (t.match(/[）)]/g) || []).length;
            if (opens > closes) {
                t += '）'.repeat(opens - closes);
            } else if (closes > opens && opens === 0) {
                t = t.replace(/^[)）]+\s*/, '').replace(/\s*[)）]+$/, '');
            }
            return t;
        }).filter(Boolean)
          .flatMap(s => {
              // 把含 [emo:...] 的片段按标记边界拆成独立气泡
              const parts = []; let lastIdx = 0, em;
              const emoRe = /\[emo:[^\]]+\]/g;
              emoRe.lastIndex = 0;
              while ((em = emoRe.exec(s)) !== null) {
                  const before = s.slice(lastIdx, em.index).trim();
                  if (before) parts.push(before);
                  parts.push(em[0]);
                  lastIdx = em.index + em[0].length;
              }
              const after = s.slice(lastIdx).trim();
              if (after) parts.push(after);
              return parts.length ? parts : [s];
          })
          .filter(Boolean).slice(0, 15);
    }

    function parseGroupResponse(raw) {
        let cleaned = cleanResponse(raw);
        const lines = cleaned.split('\n').map(l => l.trim()).filter(Boolean);
        const result = [];
        const normName = (s) => (s || '').trim().replace(/^[【\[\(（*「『"'\s]+|[】\]\)）*「』」"'\s]+$/g, '').trim().toLowerCase();
        const memberMap = new Map();
        groupMembers.forEach(n => memberMap.set(normName(n), n));
        const speakerRe = /^[\s\*【\[「『"'（\(]*(.{1,20}?)[\s\*】\]」』"'）\)]*\s*[：:]\s*([\s\S]+)$/;

        const stripAllPrefix = (s) => {
            let t = (s || '').trim();
            const outer = t.match(/^[\(（]\s*(.{1,20}?)\s*[：:]\s*([\s\S]+?)\s*[\)）]\s*$/);
            if (outer && memberMap.has(normName(outer[1]))) {
                t = outer[2].trim();
            } else {
                for (let i = 0; i < 3; i++) {
                    const m = t.match(speakerRe);
                    if (m && memberMap.has(normName(m[1]))) t = m[2].trim();
                    else break;
                }
            }
            return t;
        };

        for (const line of lines) {
            const m = line.match(speakerRe);
            if (m && memberMap.has(normName(m[1]))) {
                const name = memberMap.get(normName(m[1]));
                const sentences = splitToSentences(m[2], stripAllPrefix);
                if (sentences.length) result.push({ name, sentences });
            } else {
                const sentences = splitToSentences(line, stripAllPrefix);
                if (sentences.length) {
                    if (result.length > 0) result[result.length - 1].sentences.push(...sentences);
                    else result.push({ name: groupMembers[0] || '???', sentences });
                }
            }
        }
        return result;
    }

    async function callAI(systemPrompt, userPrompt, options = {}) {
        const cfg = window.__pmConfig;
        const useIndep = cfg.useIndependent && cfg.apiUrl && cfg.apiKey;
        const maxTokens = options.maxTokens || (isGroupChat ? 600 : 300);

        if (useIndep) {
            const { chatUrl } = normalizeApiUrls(cfg.apiUrl);
            const messages = [];
            if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
            messages.push({ role: 'user', content: userPrompt });
            const resp = await fetch(chatUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${cfg.apiKey}` },
                body: JSON.stringify({
                    model: cfg.model || 'gpt-4o-mini',
                    messages,
                    max_tokens: maxTokens,
                    temperature: 1.2,
                    top_p: 0.95,
                    frequency_penalty: 0.3,
                    presence_penalty: 0.3,
                })
            });
            if (!resp.ok) {
                const errText = await resp.text().catch(() => '');
                throw new Error(`HTTP ${resp.status}: ${errText.slice(0, 120)}`);
            }
            const json = await resp.json();
            return json.choices?.[0]?.message?.content ?? '';
        } else {
            const c = getCtx();
            if (!c) throw new Error('无上下文');
            const fullPrompt = systemPrompt ? `${systemPrompt}\n\n${userPrompt}` : userPrompt;
            return await c.generateQuietPrompt(fullPrompt, false, false);
        }
    }

    async function fetchSMS(userMsg, directorNote) {
        const c = getCtx();
        // 存入历史前把表情包标记替换为可读描述，让 AI 理解表情含义但不学习格式
        const userMsgClean = userMsg.replace(/\[emo:([^\]:]+):(\d+)\]/g, (_, setName, idxStr) => {
            const set = (window.__pmEmojis || []).find(s => s.name === setName);
            const img = set?.images?.[parseInt(idxStr, 10) - 1];
            return img?.desc ? `[表情包：${img.desc}]` : '[表情包]';
        }).replace(/\s{2,}/g, ' ').trim();
        if (userMsg.trim()) {
            conversationHistory.push({ role: 'user', content: userMsg }); // 存原始内容，保留 [emo:] 用于渲染
        }
        const ctxData = await gatherContext();
        const { cardDesc, cardPersonality, cardScenario, cardFirstMes, cardMesExample, mainChatText, worldBookText, userName, userDesc } = ctxData;

        const smsHistoryText = conversationHistory.slice(-CONTEXT_LIMIT, -1).map(m => {
            const clean = cleanResponse(m.content);
            return m.role === 'user' ? `${userName}：${clean}` : (isGroupChat ? clean : `${currentPersona}：${clean}`);
        }).join('\n');

        const userBlock = [
            `用户名字：${userName}`,
            userDesc ? `用户人设：${userDesc}` : ''
        ].filter(Boolean).join('\n');

        let injectedInstruction, systemPrompt;

        if (isGroupChat) {
            const memberList = groupMembers.join('、');
            const groupName = groupDisplayName || `群聊：${memberList}`;
            const groupRules = `
[群聊短信模式——最高优先级]
群聊名称：${groupName}
群聊成员：${memberList}
你同时扮演以上所有角色与用户（${userName}）聊天。

⚠️ 输出必须满足以下全部条件，违反即视为无效：
1. 每一行都必须以 "角色名：" 开头（角色名必须来自：${memberList}）
2. 严禁输出对界面、系统、对话本身的总结或描述性文字
3. 严禁输出类似"现在应该..."、"我已经..."、"看起来..."这类叙述性句子
4. 特殊格式必须在同一行内完整写出且闭合：(转账+金额) (收款+金额) (退还+金额) (图片+描述) (语音+内容)。注意：退还指拒绝聊天对象转账。
5. 特殊格式括号内严禁换行、编号（1. 2. 3.）、列表
6. 每条消息内的 / 只用于分隔同一角色的多条短信
7. 每个角色根据自己的人设和当前剧情主动决定发言条数，0-8句，可穿插发言，不必所有人都说话
8. 严禁英文格式 (Voice+/Image+/Transfer+/Refund+)
9. 完全沉浸于角色设定，褪去AI客观语气。根据用户引导自然推进剧情，在用户明确发起成人或极端互动前，保持符合日常社交尺度的全年龄对话风格。

✅ 正确示例：
小明：我先到了 / 这家店真不错
小红：等我五分钟 / (语音+马上到别急)
小明：好 / (图片+刚拍的店门口)
小李：(退还+50) / 昨天多给的钱退你啦

❌ 错误示例（绝对禁止）：
小明：(语音+内容有换行
1. 第一点)
小红：界面现在应该正常了...`;
            injectedInstruction = `${groupRules}

【用户信息】
${userBlock}

${cardScenario ? '【场景】\n' + cardScenario + '\n\n' : ''}${worldBookText ? '【世界书】\n' + worldBookText + '\n\n' : ''}群聊历史：
${smsHistoryText}
${directorNote ? `\n[剧情引导] ${directorNote}\n` : ''}
${userMsg.trim() ? `${userName}：${userMsgClean}` : '[仅有剧情引导，无用户发言，请按引导推进剧情]'}`;
            systemPrompt = [
                `你同时扮演 ${memberList} 在群聊「${groupName}」中与用户 ${userName} 对话。`,
                `【用户信息】\n${userBlock}`,
                cardDesc ? `【角色设定】\n${cardDesc}` : '',
                cardPersonality ? `【性格】\n${cardPersonality}` : '',
                cardScenario ? `【场景】\n${cardScenario}` : '',
                worldBookText ? `【世界书】\n${worldBookText}` : '',
                mainChatText ? `【主线最近对话】\n${mainChatText}` : '',
                '',
                `输出格式：角色名：消息 / 消息（每个角色0-8句，根据人设和剧情决定是否发言及发言数量）`,
                `角色名后只跟该角色的话，严禁 "(角色名：xxx)" 这种嵌套。`,
                `角色可穿插发言，不必所有人都说话。`,
                '特殊格式（必须中文且单行闭合）：(转账+金额) (收款+金额) (退还+金额) (图片+描述) (语音+内容)。注意：退还指拒绝聊天对象转账。',
                '禁止任何标签格式旁白选项状态栏。',
            ].filter(Boolean).join('\n\n');
        } else {
            const contextBlockMain = [
                cardScenario ? `【场景参考】\n${cardScenario}` : '',
                cardMesExample ? `【对话示例】\n${cardMesExample}` : '',
            ].filter(Boolean).join('\n\n');
            injectedInstruction = `
[短信模式指令——最高优先级]
当前角色：${currentPersona}
以${currentPersona}的身份用手机短信方式回复正在与你聊天的用户 ${userName}。

【用户信息】
${userBlock}

${contextBlockMain ? contextBlockMain + '\n\n' : ''}规则：
- 只输出短信文字，3到8句，每句用 / 分隔
- 禁止旁白心理描写场景描述角色名前缀标签格式
- 特殊格式（中文单行闭合）：(转账+金额) (收款+金额) (退还+金额) (图片+描述) (语音+内容)。注意：退还指拒绝聊天对象转账。
- 严禁英文格式
- 完全沉浸于角色设定，褪去AI助手的客观语气
- 根据用户的引导自然推进剧情，在用户明确发起成人或极端互动前，保持符合日常社交尺度的全年龄对话风格

短信对话历史：
${smsHistoryText}
${directorNote ? `\n[剧情引导] ${directorNote}\n` : ''}
${userMsg.trim() ? `${userName}：${userMsgClean}\n${currentPersona}：` : `[仅有剧情引导，无用户发言，请按引导推进剧情]\n${currentPersona}：`}`;
            systemPrompt = [
                `你正在扮演"${currentPersona}"通过手机短信与用户 ${userName} 聊天。`,
                `【用户信息】\n${userBlock}`,
                cardDesc ? `【角色设定】\n${cardDesc}` : '',
                cardPersonality ? `【性格】\n${cardPersonality}` : '',
                cardScenario ? `【场景】\n${cardScenario}` : '',
                cardFirstMes ? `【开场白参考】\n${cardFirstMes}` : '',
                cardMesExample ? `【对话示例】\n${cardMesExample}` : '',
                worldBookText ? `【世界书】\n${worldBookText}` : '',
                mainChatText ? `【主线最近对话】\n${mainChatText}` : '',
                '',
                '只输出3到8句短信，每句用 / 分隔，不得中途截断。',
                '特殊格式（必须中文单行闭合）：(转账+金额) (收款+金额) (退还+金额) (图片+描述) (语音+内容)。注意：退还指拒绝聊天对象转账。',
                '禁止任何标签格式旁白选项状态栏。',
            ].filter(Boolean).join('\n\n');
        }

        const antiFluff = '【务必直接按格式输出短信内容，严禁在开头输出“好的”、“下面是”等任何说明性废话，严禁输出非角色的语言。】';
        // 注入表情包提示词
        const targetContactKey = isGroupChat ? currentGroupKey : currentPersona;
        const emojiPrompt = getEmojiPrompt(targetContactKey);
        if (emojiPrompt) { systemPrompt += emojiPrompt; injectedInstruction += emojiPrompt; }
        // 注入字数限制提示词
        const wordyPrompt = getWordyPrompt();
        if (wordyPrompt) { systemPrompt += wordyPrompt; injectedInstruction += wordyPrompt; }
        systemPrompt += `\n\n${antiFluff}`;
        injectedInstruction += `\n\n${antiFluff}`;

        try {
            const cfg = window.__pmConfig;
            const useIndep = cfg.useIndependent && cfg.apiUrl && cfg.apiKey;
            let raw = '';

            if (useIndep) {
                const indepUserPrompt = isGroupChat
                    ? `【群聊历史】\n${smsHistoryText}\n${directorNote ? `\n[剧情引导] ${directorNote}\n` : ''}${userMsg.trim() ? `\n${userName}：${userMsgClean}` : '\n[仅有剧情引导，无用户发言，请按引导推进剧情]'}`
                    : `【短信对话历史】\n${smsHistoryText}\n${directorNote ? `\n[剧情引导] ${directorNote}\n` : ''}${userMsg.trim() ? `\n${userName}：${userMsgClean}\n${currentPersona}：` : `\n[仅有剧情引导，无用户发言，请按引导推进剧情]\n${currentPersona}：`}`;
                raw = await callAI(systemPrompt, indepUserPrompt, { maxTokens: isGroupChat ? 600 : 300 });
            } else {
                raw = await callAI('', injectedInstruction, { maxTokens: isGroupChat ? 600 : 300 });
            }

            let resultData;
            if (isGroupChat) {
                const parsed = parseGroupResponse(raw);
                if (parsed.length) {
                    const contentParts = parsed.map(p => `${p.name}：${p.sentences.join(' / ')}`);
                    conversationHistory.push({ role: 'assistant', content: contentParts.join('\n') });
                    resultData = { type: 'group', data: parsed };
                } else {
                    console.warn('[phone-mode] ⚠️ 群聊格式解析失败！AI 原始返回内容：', raw);
                    conversationHistory.push({ role: 'assistant', content: '（格式无法解析或AI拒答）' }); 
                    const snippet = raw ? raw.substring(0, 20).replace(/\n/g, '') + '...' : '空响应或纯思考过程';
                    resultData = { 
                        type: 'group', 
                        data: [{ 
                            name: '系统', 
                            sentences: [`（格式解析失败。AI原话: ${snippet}，请按F12查看控制台或检查是否触发了安全审查）`] 
                        }] 
                    };
                }
            } else {
                const clean = cleanResponse(raw);
                let sentences = splitToSentences(clean);
                if (!sentences.length && raw?.trim()) sentences = splitToSentences(raw.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<[^>]+>/g, ''));
                if (!sentences.length) sentences = !raw?.trim() ? ['（空响应）'] : ['（格式无法解析）'];
                conversationHistory.push({ role: 'assistant', content: sentences.join(' / ') });
                resultData = { type: 'single', data: sentences };
            }

            const id = getStorageId();
            if (!window.__pmHistories[id]) window.__pmHistories[id] = {};
            window.__pmHistories[id][currentPersona] = conversationHistory.slice(-SAVE_LIMIT);
            saveHistories();
            applyBidirectionalInjection();
            return resultData;
        } catch (e) {
            console.error('[phone-mode]', e);
            return isGroupChat
                ? { type: 'group', data: [{ name: '系统', sentences: [`（错误：${e?.message || e}）`] }] }
                : { type: 'single', data: [`（错误：${e?.message || e}）`] };
        }
    }

    function addBubble(text, side, senderName, historyIndex) {
        const list = phoneWindow?.querySelector('.pm-msg-list'); if (!list) return;
        const avatarUrl = resolveAvatarUrl(side, senderName); // null = 当前会话未开启头像显示
        createBubbles(text, side, senderName).forEach(b => {
            if (b.classList?.contains('pm-bubble')) {
                b.dataset.side = side; b.dataset.text = text;
                if (historyIndex !== undefined) b.dataset.historyIndex = historyIndex;
            } else if (b.classList?.contains('pm-group-bubble-wrap')) {
                b.dataset.side = side; b.dataset.text = text;
                if (historyIndex !== undefined) b.dataset.historyIndex = historyIndex;
                const inner = b.querySelector('.pm-bubble'); if (inner) {
                    inner.dataset.side = side; inner.dataset.text = text;
                    if (historyIndex !== undefined) inner.dataset.historyIndex = historyIndex;
                }
            }
            if (avatarUrl !== null) {
                const row = document.createElement('div');
                row.className = `pm-row pm-row-${side}`;
                const avatarEl = makeAvatarEl(avatarUrl, side, senderName);
                if (side === 'right') { row.appendChild(b); row.appendChild(avatarEl); }
                else { row.appendChild(avatarEl); row.appendChild(b); }
                list.appendChild(row);
            } else {
                list.appendChild(b);
            }
        });
        list.scrollTop = list.scrollHeight;
    }
    function addNote(text) {
        const list = phoneWindow?.querySelector('.pm-msg-list'); if (!list) return;
        const n = document.createElement('div'); n.className = 'pm-note'; n.textContent = text;
        list.appendChild(n); list.scrollTop = list.scrollHeight;
    }
    function addDirector(text) {
        const list = phoneWindow?.querySelector('.pm-msg-list'); if (!list) return;
        const d = document.createElement('div'); d.className = 'pm-director';
        d.innerHTML = `<span class="pm-director-icon">🎬</span><span class="pm-director-text">${escapeHtml(text)}</span>`;
        list.appendChild(d); list.scrollTop = list.scrollHeight;
    }
    function showTyping() {
        const list = phoneWindow?.querySelector('.pm-msg-list');
        if (!list || document.getElementById('pm-typing')) return;
        const t = document.createElement('div'); t.id = 'pm-typing'; t.className = 'pm-bubble pm-left pm-typing-bubble';
        t.innerHTML = '<span></span><span></span><span></span>';
        list.appendChild(t); list.scrollTop = list.scrollHeight;
    }
    function hideTyping() { document.getElementById('pm-typing')?.remove(); }

    window.__pmSend = async () => {
        if (isGenerating) return;
        const input = phoneWindow.querySelector('.pm-input');
        const val = input.value.trim(); if (!val) return; input.value = '';

        // 解析方括号引导：先把 [emo:...] 格式临时占位保护，再匹配 【...】/[...]/［...］ 为剧情引导
        const EMO_PLACEHOLDER = '\u0002';
        const emoSlots = [];
        const valProtected = val.replace(/\[emo:[^\]]+\]/g, m => { emoSlots.push(m); return EMO_PLACEHOLDER + (emoSlots.length - 1) + EMO_PLACEHOLDER; });
        const DIRECTOR_RE = /[【\[［]([^】\]］]+)[】\]］]/g;
        const directorNotes = [];
        let m;
        DIRECTOR_RE.lastIndex = 0;
        while ((m = DIRECTOR_RE.exec(valProtected)) !== null) directorNotes.push(m[1].trim());
        const directorNote = directorNotes.join('；');
        // 去掉所有方括号引导内容后，还原 emo 占位
        const plainValProtected = valProtected.replace(/[【\[［][^】\]］]*[】\]］]/g, '').trim();
        const plainVal = plainValProtected.replace(new RegExp(EMO_PLACEHOLDER + '(\\d+)' + EMO_PLACEHOLDER, 'g'), (_, i) => emoSlots[+i] || '');

        // 渲染剧情引导条（居中，不是气泡）
        if (directorNote) addDirector(directorNote);

        // 如果没有正常发言也没有引导，直接返回（不可能走到这，但防御一下）
        if (!directorNote && !plainVal) return;

        const protect = plainVal.replace(/[\(（][^)）]+[\)\）]/g, m => m.replace(/\//g, '\u0001'));
        const rawChunks = protect.split(/[/／]/).map(s => s.replace(/\u0001/g, '/').trim()).filter(Boolean);
        // 把含 [emo:...] 的 chunk 按标记边界再拆成独立气泡
        const userBubbles = rawChunks.flatMap(chunk => {
            const parts = []; let lastIdx = 0, m;
            const emoRe = /\[emo:[^\]]+\]/g;
            while ((m = emoRe.exec(chunk)) !== null) {
                const before = chunk.slice(lastIdx, m.index).trim();
                if (before) parts.push(before);
                parts.push(m[0]);
                lastIdx = m.index + m[0].length;
            }
            const after = chunk.slice(lastIdx).trim();
            if (after) parts.push(after);
            return parts.length ? parts : [chunk];
        });
        // 先渲染用户气泡，fetchSMS push 后回填 historyIndex
        const pendingUserBubbles = [];
        userBubbles.forEach(chunk => {
            addBubble(chunk, 'right');
            const list = phoneWindow?.querySelector('.pm-msg-list');
            const allBubbles = list?.querySelectorAll('.pm-bubble[data-side="right"], .pm-group-bubble-wrap[data-side="right"]');
            if (allBubbles?.length) pendingUserBubbles.push(allBubbles[allBubbles.length - 1]);
        });
        isGenerating = true; input.disabled = true;
        const btn = phoneWindow.querySelector('.pm-up-btn'); if (btn) btn.disabled = true;
        showTyping();
        try {
            const result = await fetchSMS(plainVal, directorNote);
            hideTyping();
            // 回填用户气泡的 historyIndex
            // 若有正常用户发言，fetchSMS 里 push 了 user+assistant，AI 在 length-1，user 在 length-2
            // 若纯剧情引导无用户发言，fetchSMS 只 push 了 assistant，AI 在 length-1
            const hasUserMsg = !!plainVal.trim();
            const userHi = conversationHistory.length - (hasUserMsg ? 2 : 1);
            pendingUserBubbles.forEach(b => { b.dataset.historyIndex = userHi; const inner = b.querySelector('.pm-bubble'); if(inner) inner.dataset.historyIndex = userHi; });
            const aiHi = conversationHistory.length - 1;
            if (result.type === 'group') {
                for (const block of result.data) {
                    for (const s of block.sentences) {
                        await new Promise(r => setTimeout(r, 120));
                        addBubble(s, 'left', block.name, aiHi);
                    }
                }
            } else {
                for (const s of result.data) { await new Promise(r => setTimeout(r, 150)); addBubble(s, 'left', undefined, aiHi); }
            }
            // 逐泡保存：渲染完毕后立即落盘，不等 finally，防止挂起丢失
            { const _id = getStorageId(); if (!window.__pmHistories[_id]) window.__pmHistories[_id] = {};
              const _key = isGroupChat && currentGroupKey ? currentGroupKey : currentPersona;
              window.__pmHistories[_id][_key] = conversationHistory.slice(-SAVE_LIMIT);
              saveHistories(); }
        } catch(e) {
            hideTyping();
            addNote(`（发送失败：${e?.message || e}）`);
            console.error('[phone-mode] __pmSend 异常', e);
        } finally {
            isGenerating = false; input.disabled = false; if (btn) btn.disabled = false; input.focus();
        }

        setTimeout(() => {
            if (!isGenerating && typeof window.__pmIncrementCounters === 'function') {
                window.__pmIncrementCounters();
            }
        }, 300);
    };
  
// 打开长文本输入界面
    window.__pmShowExpandInput = () => {
        const smallInput = phoneWindow?.querySelector('.pm-input');
        const currentText = smallInput ? smallInput.value : '';

        makeOverlay(`
<div class="pm-modal pm-modal-wide">
  <div class="pm-modal-header" style="justify-content:space-between;padding-right:14px;">
    <b>长文本输入</b>
    <!-- 修复问题1：点击叉号关闭时，先将长文本同步回小输入框，再销毁界面 -->
    <span onclick="(()=>{ const ta=document.getElementById('pm-expanded-textarea'); const si=document.querySelector('.pm-input'); if(ta && si) si.value=ta.value; document.getElementById('pm-overlay').remove(); })()" class="pm-modal-close">✕</span>
  </div>
  <div style="padding:14px 16px;">
    <textarea id="pm-expanded-textarea" class="pm-cfg-input" rows="7" 
        style="height:auto; resize:none; font-size:14px; padding:10px; line-height:1.5; font-family:inherit;" 
        placeholder="在这里输入多行文本...">${escapeAttr(currentText)}</textarea>
  </div>
  <div class="pm-modal-add" style="display:flex;gap:8px;">
    <!-- 修复问题2：点开表情包前，先将当前输入的文本同步回小输入框，防止从表情包界面返回时重新读取到旧数据而清空文本 -->
    <button onclick="(()=>{ const ta=document.getElementById('pm-expanded-textarea'); const si=document.querySelector('.pm-input'); if(ta && si) si.value=ta.value; window.__pmShowEmojiPicker(); })()" style="flex:2;background:#f0f0f3;color:#333;border:1px solid #ddd;border-radius:10px;padding:10px;font-size:14px;cursor:pointer;font-weight:600;">(^ ^)</button>
    <button onclick="window.__pmConfirmExpandInput()" style="flex:8;background:#007aff;color:#fff;border:none;border-radius:10px;padding:10px;font-size:13px;cursor:pointer;font-weight:600;">发送</button>
  </div>
</div>`);

        setTimeout(() => {
            const ta = document.getElementById('pm-expanded-textarea');
            if (ta) {
                ta.focus();
                ta.selectionStart = ta.selectionEnd = ta.value.length;
            }
        }, 10);
    };

    // 确认发送长文本
    window.__pmConfirmExpandInput = () => {
        const ta = document.getElementById('pm-expanded-textarea');
        const smallInput = phoneWindow?.querySelector('.pm-input');
        
        if (ta && smallInput) {
            smallInput.value = ta.value; // 将长文本同步回底部的原输入框
            document.getElementById('pm-overlay')?.remove();
            
            // 如果文本不为空，直接触发发送
            if (ta.value.trim()) {
                window.__pmSend();
            }
        }
    };
    // ===== 表情包管理 =====

    window.__pmRenderEmojiSetList = () => {
        const container = document.getElementById('pm-emoji-set-list');
        if (!container) return;
        const sets = window.__pmEmojis;
        if (!sets.length) {
            container.innerHTML = '<div style="text-align:center;color:#aaa;font-size:13px;padding:16px 0;">暂无表情包套组</div>';
            return;
        }
        container.innerHTML = sets.map((set, si) => `
            <div style="background:#fafafa;border:1px solid #eee;border-radius:10px;padding:10px 12px;margin-bottom:8px;">
                <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">
                    <span style="font-weight:600;font-size:13px;color:#222;">${escapeHtml(set.name)}</span>
                    <div style="display:flex;gap:6px;">
                        <button onclick="window.__pmAddEmojiImage(${si})" style="font-size:11px;background:#007aff;color:#fff;border:none;border-radius:6px;padding:4px 8px;cursor:pointer;">➕图片</button>
                        <button onclick="window.__pmDeleteEmojiSet(${si})" style="font-size:11px;background:#ff3b30;color:#fff;border:none;border-radius:6px;padding:4px 8px;cursor:pointer;">删除</button>
                    </div>
                </div>
                <div style="display:flex;flex-wrap:wrap;gap:8px;">
                    ${set.images.map((img, ii) => `
                        <div style="position:relative;width:52px;">
                            <img src="${escapeAttr(img.url)}" style="width:52px;height:52px;object-fit:cover;border-radius:8px;border:1px solid #eee;">
                            <div style="font-size:9px;color:#888;text-align:center;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;width:52px;">${escapeHtml(img.desc)}</div>
                            <span onclick="window.__pmDeleteEmojiImage(${si},${ii})" style="position:absolute;top:-4px;right:-4px;background:#ff3b30;color:#fff;border-radius:50%;width:16px;height:16px;font-size:10px;display:flex;align-items:center;justify-content:center;cursor:pointer;line-height:1;">×</span>
                        </div>
                    `).join('')}
                    ${set.images.length===0?'<span style="font-size:12px;color:#aaa;">暂无图片</span>':''}
                </div>
                <div style="font-size:11px;color:#aaa;margin-top:4px;">${set.images.length}/20 张 · [emo:${escapeHtml(set.name)}:1~${set.images.length}]</div>
            </div>
        `).join('');
    };

    window.__pmAddEmojiSet = () => {
        if (window.__pmEmojis.length >= 10) return alert('最多只能创建 10 个套组。');
        const ov = document.createElement('div'); ov.id = 'pm-overlay-sub';
        if (typeof HTMLElement !== 'undefined' && HTMLElement.prototype.hasOwnProperty('popover')) ov.setAttribute('popover', 'manual');
        ov.style.cssText = 'position:fixed !important; inset:0 !important; margin:0 !important; padding:0 !important; border:none !important; width:100vw !important; height:100vh !important; max-width:none !important; max-height:none !important; background:rgba(0,0,0,.45) !important; z-index:2147483648 !important; display:flex !important; align-items:center !important; justify-content:center !important;';
        ov.innerHTML = `
<div class="pm-modal">
  <div class="pm-modal-header">
    <b>新建表情包套组</b>
    <span onclick="document.getElementById('pm-overlay-sub').remove()" class="pm-modal-close">✕</span>
  </div>
  <div style="padding:14px 16px;display:flex;flex-direction:column;gap:10px;">
    <input id="pm-new-set-name" class="pm-cfg-input" placeholder="套组名称（如：开心、日常、可爱）" style="padding:8px 10px;font-size:13px;border-radius:8px;border:1px solid #ddd;">
  </div>
  <div class="pm-modal-add">
    <button onclick="window.__pmConfirmAddEmojiSet()" style="width:100%;background:#007aff;color:#fff;border:none;border-radius:10px;padding:10px;font-size:13px;cursor:pointer;font-weight:600;">确认</button>
  </div>
</div>`;
        ov.addEventListener('click', e => { if (e.target === ov) ov.remove(); });
        document.body.appendChild(ov);
        if (ov.showPopover) try { ov.showPopover(); } catch (e) {}
        setTimeout(() => document.getElementById('pm-new-set-name')?.focus(), 10);
    };

    window.__pmConfirmAddEmojiSet = () => {
        const name = document.getElementById('pm-new-set-name')?.value.trim();
        if (!name) return alert('套组名称不能为空。');
        if (window.__pmEmojis.some(s => s.name === name)) return alert('该名称已存在。');
        window.__pmEmojis.push({ id: 'emo_' + Date.now(), name, images: [] });
        saveEmojis();
        document.getElementById('pm-overlay-sub')?.remove(); // 关键修改：只关闭当前弹窗
        window.__pmRenderEmojiSetList();
    };

    window.__pmDeleteEmojiSet = (si) => {
        const set = window.__pmEmojis[si];
        if (!set) return;
        if (!confirm(`确认删除套组「${set.name}」？`)) return;
        window.__pmEmojis.splice(si, 1);
        saveEmojis();
        window.__pmRenderEmojiSetList();
    };

    window.__pmAddEmojiImage = (si) => {
        const set = window.__pmEmojis[si];
        if (!set) return;
        if (set.images.length >= 20) return alert('本套组已满 20 张。');
        
        const ov = document.createElement('div'); ov.id = 'pm-overlay-sub';
        if (typeof HTMLElement !== 'undefined' && HTMLElement.prototype.hasOwnProperty('popover')) ov.setAttribute('popover', 'manual');
        ov.style.cssText = 'position:fixed !important; inset:0 !important; margin:0 !important; padding:0 !important; border:none !important; width:100vw !important; height:100vh !important; max-width:none !important; max-height:none !important; background:rgba(0,0,0,.45) !important; z-index:2147483648 !important; display:flex !important; align-items:center !important; justify-content:center !important;';
        ov.innerHTML = `
<div class="pm-modal">
  <div class="pm-modal-header">
    <b>添加图片 — ${escapeHtml(set.name)}</b>
    <span onclick="document.getElementById('pm-overlay-sub').remove();" class="pm-modal-close">✕</span>
  </div>
  <div style="padding:14px 16px;display:flex;flex-direction:column;gap:10px;">
    <div style="font-size:12px;color:#888;margin-bottom:2px;">图片 URL 或本地上传</div>
    <input id="pm-emo-url" class="pm-cfg-input" placeholder="https://... 或点下方选择文件" style="padding:8px 10px;font-size:13px;border-radius:8px;border:1px solid #ddd;">
    <button onclick="document.getElementById('pm-emo-file').click()" style="background:#f0f0f3;color:#333;border:1px solid #ddd;border-radius:8px;padding:8px 10px;font-size:12px;cursor:pointer;">📁 上传本地图片</button>
    <input id="pm-emo-file" type="file" accept="image/*" hidden onchange="window.__pmEmoFileRead(${si},this)">
    <div id="pm-emo-preview" style="display:none;text-align:center;"><img id="pm-emo-preview-img" style="max-width:120px;max-height:120px;border-radius:10px;border:1px solid #eee;"></div>
    <input id="pm-emo-desc" class="pm-cfg-input" placeholder="图片描述（必填，如：猫猫开心）" style="padding:8px 10px;font-size:13px;border-radius:8px;border:1px solid #ddd;">
    <div style="font-size:11px;color:#aaa;">描述将告诉 AI 这张图在什么情形下使用</div>
  </div>
  <div class="pm-modal-add">
    <button onclick="window.__pmConfirmAddEmojiImage(${si})" style="width:100%;background:#007aff;color:#fff;border:none;border-radius:10px;padding:10px;font-size:13px;cursor:pointer;font-weight:600;">确认添加</button>
  </div>
</div>`;
        ov.addEventListener('click', e => { if (e.target === ov) ov.remove(); });
        document.body.appendChild(ov);
        if (ov.showPopover) try { ov.showPopover(); } catch (e) {}
        setTimeout(() => document.getElementById('pm-emo-url')?.focus(), 10);
    };

    window.__pmEmoFileRead = (si, input) => {
        const file = input.files?.[0]; if (!file) return;
        const reader = new FileReader();
        reader.onload = e => {
            const url = e.target.result;
            const urlInput = document.getElementById('pm-emo-url');
            if (urlInput) urlInput.value = url;
            const prev = document.getElementById('pm-emo-preview');
            const prevImg = document.getElementById('pm-emo-preview-img');
            if (prev && prevImg) { prevImg.src = url; prev.style.display = 'block'; }
        };
        reader.readAsDataURL(file);
    };

    window.__pmConfirmAddEmojiImage = (si) => {
        const url = document.getElementById('pm-emo-url')?.value.trim();
        const desc = document.getElementById('pm-emo-desc')?.value.trim();
        if (!url) return alert('请输入图片 URL 或上传图片。');
        if (!desc) return alert('请输入图片描述（必填）。');
        const set = window.__pmEmojis[si];
        if (!set) return;
        set.images.push({ url, desc });
        saveEmojis();
        document.getElementById('pm-overlay-sub')?.remove(); // 关键修改：只关闭当前弹窗
        window.__pmRenderEmojiSetList();
    };

    window.__pmDeleteEmojiImage = (si, ii) => {
        const set = window.__pmEmojis[si];
        if (!set) return;
        set.images.splice(ii, 1);
        saveEmojis();
        window.__pmRenderEmojiSetList();
    };

    window.__pmShowEmojiPicker = () => {
        if (!window.__pmEmojis.length) return alert('\xe8\xbf\x98\xe6\xb2\xa1\xe6\x9c\x89\xe8\xa1\xa8\xe6\x83\x85\xe5\x8c\x85\xef\xbc\x81\xe8\xaf\xb7\xe5\x85\x88\xe5\x8e\xbb\xe3\x80\x90\xe8\xae\xbe\xe7\xbd\xae-\xe5\x85\xb6\xe4\xbb\x96\xe3\x80\x91\xe4\xb8\xad\xe6\xb7\xbb\xe5\x8a\xa0\xe3\x80\x82');
        const ta = document.getElementById('pm-expanded-textarea');
        window.__pmTempText = ta ? ta.value : '';
        let activeSetIdx = 0;

        function renderPicker() {
            const sets = window.__pmEmojis;
            const set = sets[activeSetIdx] || sets[0];
            if (!set) return;
            const dotsHtml = sets.length > 1 ? `<div style="display:flex;justify-content:center;gap:8px;padding:8px 0 4px;">${
                sets.map((s, i) => `<div onclick="window.__pmEmojiSetDot(${i})" style="width:8px;height:8px;border-radius:50%;cursor:pointer;background:${i===activeSetIdx?'#007aff':'#ddd'};transition:background 0.2s;"></div>`).join('')
            }</div>` : '';
            const imgsHtml = set.images.length ? set.images.map((img, i) => `
                <div onclick="window.__pmInsertEmoji('[emo:${escapeAttr(set.name)}:${i+1}]')"
                     style="cursor:pointer;width:60px;display:flex;flex-direction:column;align-items:center;gap:4px;">
                    <img src="${escapeAttr(img.url)}" style="width:50px;height:50px;object-fit:cover;border-radius:8px;box-shadow:0 2px 6px rgba(0,0,0,0.1);">
                    <span style="font-size:10px;color:#666;width:100%;text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(img.desc)}</span>
                </div>`).join('') : `<div style="text-align:center;color:#999;font-size:12px;padding:20px 0;">\xe6\x9c\xac\xe5\xa5\x97\xe6\x9a\x82\xe6\x97\xa0\xe5\x9b\xbe\xe7\x89\x87</div>`;
            const el = document.getElementById('pm-emoji-picker-inner');
            if (el) {
                el.querySelector('.pm-emoji-set-label').textContent = set.name + ' (' + set.images.length + ')';
                el.querySelector('.pm-emoji-imgs').innerHTML = imgsHtml;
                el.querySelector('.pm-emoji-dots').innerHTML = dotsHtml;
                el.querySelectorAll('.pm-emoji-set-dot-btn').forEach((d,i)=>d.style.background=i===activeSetIdx?'#007aff':'#ddd');
            }
        }

        window.__pmEmojiSetDot = (idx) => { activeSetIdx = idx; renderPicker(); };

        const sets = window.__pmEmojis;
        const set0 = sets[0];
        const initialImgs = set0?.images.length ? set0.images.map((img,i)=>`
            <div onclick="window.__pmInsertEmoji('[emo:${escapeAttr(set0.name)}:${i+1}]')"
                 style="cursor:pointer;width:60px;display:flex;flex-direction:column;align-items:center;gap:4px;">
                <img src="${escapeAttr(img.url)}" style="width:50px;height:50px;object-fit:cover;border-radius:8px;box-shadow:0 2px 6px rgba(0,0,0,0.1);">
                <span style="font-size:10px;color:#666;width:100%;text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(img.desc)}</span>
            </div>`).join('') : `<div style="text-align:center;color:#999;font-size:12px;padding:20px 0;">\xe6\x9c\xac\xe5\xa5\x97\xe6\x9a\x82\xe6\x97\xa0\xe5\x9b\xbe\xe7\x89\x87</div>`;
        const initialDots = sets.length > 1 ? `<div style="display:flex;justify-content:center;gap:8px;padding:8px 0 4px;">${
            sets.map((s,i) => `<div onclick="window.__pmEmojiSetDot(${i})" style="width:8px;height:8px;border-radius:50%;cursor:pointer;background:${i===0?'#007aff':'#ddd'};"></div>`).join('')
        }</div>` : '';

        makeOverlay(`
<div class="pm-modal pm-modal-wide" id="pm-emoji-picker-inner">
  <div class="pm-modal-header" style="justify-content:space-between;padding-right:14px;">
    <b class="pm-emoji-set-label">${escapeHtml(set0?.name||'')} (${set0?.images.length||0})</b>
    <span onclick="document.getElementById('pm-overlay').remove();window.__pmShowExpandInput();" class="pm-modal-close">✕</span>
  </div>
  <div class="pm-emoji-imgs" id="pm-emoji-imgs-area" style="padding:12px 14px;overflow-y:auto;max-height:340px;display:flex;flex-wrap:wrap;gap:10px;justify-content:flex-start;touch-action:pan-y pinch-zoom;">${initialImgs}</div>
  <div class="pm-emoji-dots">${initialDots}</div>
</div>`);

        // 为表情包图片区域绑定左右滑动切换套组
        const pickerInner = document.getElementById('pm-emoji-picker-inner');
        if (pickerInner && sets.length > 1) {
            const imgsArea = pickerInner.querySelector('#pm-emoji-imgs-area');
            if (imgsArea) {
                let swipeStartX = 0, swipeStartY = 0, swipeMoved = false;
                imgsArea.addEventListener('touchstart', (e) => {
                    swipeStartX = e.touches[0].clientX;
                    swipeStartY = e.touches[0].clientY;
                    swipeMoved = false;
                }, { passive: true });
                imgsArea.addEventListener('touchmove', (e) => {
                    const dx = e.touches[0].clientX - swipeStartX;
                    const dy = e.touches[0].clientY - swipeStartY;
                    // 横向滑动幅度大于纵向时标记为横滑，阻止页面滚动
                    if (!swipeMoved && Math.abs(dx) > Math.abs(dy) + 5) {
                        swipeMoved = true;
                    }
                    if (swipeMoved && e.cancelable) e.preventDefault();
                }, { passive: false });
                imgsArea.addEventListener('touchend', (e) => {
                    const dx = e.changedTouches[0].clientX - swipeStartX;
                    const dy = e.changedTouches[0].clientY - swipeStartY;
                    if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy) * 1.5) {
                        if (dx < 0) {
                            // 左滑 → 下一套组
                            activeSetIdx = (activeSetIdx + 1) % sets.length;
                        } else {
                            // 右滑 → 上一套组
                            activeSetIdx = (activeSetIdx - 1 + sets.length) % sets.length;
                        }
                        renderPicker();
                    }
                }, { passive: true });
            }
        }
    };

    window.__pmInsertEmoji = (code) => {
        const text = window.__pmTempText || '';
        document.getElementById('pm-overlay').remove();
        window.__pmShowExpandInput();
        const ta = document.getElementById('pm-expanded-textarea');
        if (ta) {
            const sep = (text && !text.endsWith(' ') && !text.endsWith('\n')) ? '' : '';
            ta.value = text + sep + code + ' ';
            window.__pmTempText = ta.value;
            ta.focus();
            ta.selectionStart = ta.selectionEnd = ta.value.length;
        }
    };

    window.__pmIncrementCounters = () => {
        const id = getStorageId();
        const configs = window.__pmPokeConfig[id];
        if (!configs) return;

        let updated = false;
        const toPoke = [];

        for (const [contact, config] of Object.entries(configs)) {
            if (config?.autoPoke?.enabled) {
                config.autoPoke.counter = (config.autoPoke.counter || 0) + 1;
                updated = true;
                if (config.autoPoke.counter >= config.autoPoke.interval) {
                    config.autoPoke.counter = 0;
                    toPoke.push(contact);
                }
            }
        }

        if (updated) {
            savePokeConfig();
            const counterEl = document.getElementById('pm-poke-counter');
            if (counterEl && configs[currentPersona]) counterEl.textContent = configs[currentPersona].autoPoke.counter;
            const groupCounterEl = document.getElementById('pm-poke-counter-group');
            if (groupCounterEl && currentGroupKey && configs[currentGroupKey]) groupCounterEl.textContent = configs[currentGroupKey].autoPoke.counter;
        }

        if (toPoke.length > 0) {
            (async () => {
                for (const contact of toPoke) { await window.__pmAutoPoke(contact); }
            })();
        }
    };

    window.__pmAutoPoke = async (contactName) => {
        if (isGenerating) return;
        isGenerating = true;

        const id = getStorageId();
        const groupMeta = window.__pmGroupMeta[id]?.[contactName];
        const isGroup = !!groupMeta;
        
        const isActiveView = phoneActive && ((isGroup && currentGroupKey === contactName) || (!isGroup && currentPersona === contactName));
        
        if (isActiveView) {
            const input = phoneWindow?.querySelector('.pm-input');
            const btn = phoneWindow?.querySelector('.pm-up-btn');
            if (input) input.disabled = true;
            if (btn) btn.disabled = true;
            showTyping();
        }

        const ctxData = await gatherContext();
        const { cardDesc, cardPersonality, cardScenario, cardMesExample, mainChatText, worldBookText, userName, userDesc } = ctxData;
        const userBlock = [`用户名字：${userName}`, userDesc ? `用户人设：${userDesc}` : ''].filter(Boolean).join('\n');

        let targetHistory = window.__pmHistories[id]?.[contactName] || [];
        const smsHistoryText = targetHistory.slice(-CONTEXT_LIMIT).map(m => {
            const clean = cleanResponse(m.content);
            return m.role === 'user' ? `${userName}：${clean}` : (isGroup ? clean : `${contactName}：${clean}`);
        }).join('\n');

        const systemPrompt = isGroup ? `你同时扮演群聊中的所有成员。\n【务必直接按格式输出短信内容，严禁在开头输出“好的”等废话。】` : `你正在扮演"${contactName}"通过手机短信与用户 ${userName} 聊天。\n【务必直接按格式输出短信内容，严禁在开头输出“好的”等废话。】`;
        // 修复：注入表情包提示词（与 fetchSMS 保持一致）
        // 修复：群聊拍一拍使用 contactName（即 currentGroupKey），单人使用 contactName，两者相同，已正确
        const emojiPrompt = getEmojiPrompt(contactName);
        const userPrompt = (isGroup
            ? `群聊名称：${groupMeta.name}\n群聊成员：${groupMeta.members.join('、')}\n\n用户有一段时间没有说话。请以所有群成员的身份，根据各自的性格、人设和当前聊天上下文，自然地发起话题或继续聊天。每个成员根据人设决定发言 0-8 句。\n\n输出格式：角色名：消息 / 消息\n\n【用户信息】\n${userBlock}\n\n【角色设定】\n${cardDesc || ''}\n\n【性格】\n${cardPersonality || ''}\n\n【场景】\n${cardScenario || ''}\n\n【世界书】\n${worldBookText || ''}\n\n【主线最近对话】\n${mainChatText || ''}\n\n【群聊历史】\n${smsHistoryText}`
              + (emojiPrompt ? emojiPrompt : '')
            : `用户有一段时间没有回复。作为${contactName}，根据你的人设和当前聊天情境，自然地发送 3-8 句短信继续对话或发起新话题，不要提及用户没有回复这件事。\n\n【用户信息】\n${userBlock}\n\n【角色设定】\n${cardDesc || ''}\n\n【性格】\n${cardPersonality || ''}\n\n【场景】\n${cardScenario || ''}\n\n【对话示例】\n${cardMesExample || ''}\n\n【世界书】\n${worldBookText || ''}\n\n【主线最近对话】\n${mainChatText || ''}\n\n【短信对话历史】\n${smsHistoryText}\n\n输出格式：短信内容 / 短信内容（每句用 / 分隔，特殊格式中文单行闭合）`
              + (emojiPrompt ? emojiPrompt : ''))
            + getWordyPrompt();

        try {
            const raw = await callAI(systemPrompt, userPrompt);
            let historyUpdated = false;

            if (isActiveView) hideTyping();

            if (isGroup) {
                const oldMembers = groupMembers;
                let parsed = [];
                try {
                    groupMembers = groupMeta.members;
                    parsed = parseGroupResponse(raw);
                } finally {
                    groupMembers = oldMembers;
                }

                const contentParts = [];
                for (const block of parsed) {
                    if (block.sentences.length > 0) {
                        contentParts.push(`${block.name}：${block.sentences.join(' / ')}`);
                        if (isActiveView) {
                            const _pgHi = targetHistory.length; // push 之前的长度即为新条目下标
                            for (const s of block.sentences) { await new Promise(r => setTimeout(r, 120)); addBubble(s, 'left', block.name, _pgHi); }
                        }
                    }
                }
                if (contentParts.length > 0) {
                    targetHistory.push({ role: 'assistant', content: contentParts.join('\n') });
                    historyUpdated = true;
                }
            } else {
                const clean = cleanResponse(raw);
                const sentences = splitToSentences(clean);
                if (sentences.length > 0) {
                    targetHistory.push({ role: 'assistant', content: sentences.join(' / ') });
                    historyUpdated = true;
                    if (isActiveView) {
                        const _pokeHi = targetHistory.length - 1;
                        for (const s of sentences) {
                            await new Promise(r => setTimeout(r, 150));
                            addBubble(s, 'left', undefined, _pokeHi);
                            // 逐句落盘：每渲染一句立即保存，防止挂起丢失
                            { const _id = getStorageId(); if (!window.__pmHistories[_id]) window.__pmHistories[_id] = {};
                              window.__pmHistories[_id][isGroupChat && currentGroupKey ? currentGroupKey : currentPersona] = targetHistory.slice(-SAVE_LIMIT);
                              saveHistories(); }
                        }
                    }
                }
            }

            if (historyUpdated) {
                if (!window.__pmHistories[id]) window.__pmHistories[id] = {};
                const newHistory = targetHistory.slice(-SAVE_LIMIT);
                window.__pmHistories[id][contactName] = newHistory;
                
                // 修复：如果当前正好在这个角色的界面，必须把最新的数组同步给全局的 conversationHistory
                if (isActiveView) {
                    conversationHistory = newHistory;
                }
                
                saveHistories(); applyBidirectionalInjection();
                
                if (phoneActive && !isActiveView) {
                    addNote(`📩 ${isGroup ? groupMeta.name : contactName} 发来了新消息`);
                }
            }
        } catch (e) {
            if (isActiveView) hideTyping();
            console.error('[phone-mode] 自动发消息失败', e);
        }

        if (isActiveView) {
            const input = phoneWindow?.querySelector('.pm-input'); const btn = phoneWindow?.querySelector('.pm-up-btn');
            if (input) input.disabled = false; if (btn) btn.disabled = false;
        }
        isGenerating = false;
    };

    function showContactConfig(contactName) {
        const id = getStorageId();
        const config = window.__pmPokeConfig[id]?.[contactName] || {
            autoPoke: { enabled: false, interval: 3, counter: 0 }
        };
        const assignedEmojis = config.emojis || [];

        const emojiCheckHtml = window.__pmEmojis.length ? `
        <div style="margin-bottom:8px;border-bottom:1px solid #f0f0f0;padding-bottom:14px;">
            <div class="pm-cfg-label" style="margin-bottom:8px;">🥰 允许 AI 使用的表情包套组</div>
            <div style="display:flex;flex-direction:column;gap:10px;max-height:130px;overflow-y:auto;background:#fafafa;border-radius:8px;padding:10px;border:1px solid #eee;">
                ${window.__pmEmojis.map(set => `
                    <div style="display:flex;align-items:center;gap:10px;cursor:pointer;"
                         onclick="this.querySelector('.pm-emoji-assign-check').classList.toggle('is-checked')">
                        <div class="pm-custom-check pm-bi-style pm-emoji-assign-check ${assignedEmojis.includes(set.id)?'is-checked':''}"
                             data-id="${escapeAttr(set.id)}"
                             style="width:20px;height:20px;min-width:20px;flex-shrink:0;margin-bottom:0;"></div>
                        <span style="font-size:13px;color:#333;">${escapeHtml(set.name)}</span>
                        <span style="color:#aaa;font-size:11px;margin-left:auto;">(${set.images.length}张)</span>
                    </div>
                `).join('')}
            </div>
            <div style="font-size:11px;color:#aaa;margin-top:4px;">勾选后 AI 会知道如何使用这些表情</div>
        </div>` : '';

        const avEntry = window.__pmAvatarData[id]?.[contactName] || { enabled: false, self: '', other: '', remark: '', members: {} };
        const avatarBlockHtml = `
        <div style="padding-bottom:12px;border-bottom:1px solid #f0f0f0;">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">
                <span style="font-size:13px;font-weight:600;">头像显示</span>
                <div onclick="window.__pmToggleAvatarSwitch()"
                    class="pm-switch ${avEntry.enabled ? 'is-on' : ''}"
                    id="pm-avatar-check"></div>
            </div>
            <div style="display:flex;flex-direction:column;gap:4px;">
                <span style="font-size:11px;color:#888;">备注（仅本会话显示，不影响 AI）</span>
                <input id="pm-cfg-remark-input" class="pm-cfg-input" placeholder="${escapeAttr(contactName)}" value="${escapeAttr(avEntry.remark || '')}">
            </div>
        </div>`;

        makeOverlay(`
    <div class="pm-modal pm-modal-wide">
    <div class="pm-modal-header">
        <b>${escapeHtml(contactName)} 设置</b>
        <span onclick="window.__pmSaveAndCloseContactConfig('${safeJS(contactName)}')" class="pm-modal-close">✕</span>
    </div>
    <div style="padding:16px;display:flex;flex-direction:column;gap:8px;">
        ${avatarBlockHtml}
        ${emojiCheckHtml}
        <div style="margin-top:-6px;">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
            <span style="font-size:13px;font-weight:600;">⏰ 自动发消息</span>
            <div onclick="window.__pmToggleAutoPoke('${safeJS(contactName)}')"
                class="pm-custom-check pm-bi-style ${config.autoPoke.enabled ? 'is-checked' : ''}"
                id="pm-poke-check"
                style="cursor:pointer;width:22px;height:22px;min-width:22px;min-height:22px;flex-shrink:0;border-radius:50%;">
            </div>
        </div>
        <div style="display:flex;align-items:center;gap:8px;">
            <span style="font-size:12px;color:#888;">每隔</span>
            <input id="pm-poke-interval" type="number" min="1" max="99"
                value="${config.autoPoke.interval}"
                style="width:50px;border:1px solid #ddd;border-radius:6px;padding:4px 8px;font-size:13px;text-align:center;"
                ${!config.autoPoke.enabled ? 'disabled' : ''}>
            <span style="font-size:12px;color:#888;">轮无输入主动发消息</span>
        </div>
        <div style="font-size:11px;color:#999;margin-top:4px;">
            当前计数：<span id="pm-poke-counter">${config.autoPoke.counter}</span> / ${config.autoPoke.interval}
        </div>
        </div>
        <div style="margin-top:4px;">
        <button onclick="window.__pmPoke('${safeJS(contactName)}')"
                style="width:100%;background:linear-gradient(135deg,#ff9500,#ff6b00);color:#fff;border:none;border-radius:12px;padding:14px;font-size:14px;cursor:pointer;font-weight:600;display:flex;align-items:center;justify-content:center;">
            拍一拍
        </button>
        </div>
    </div>
    </div>`);
    }

    window.__pmSaveAndCloseContactConfig = (contactName) => {
        const checkEl = document.getElementById('pm-poke-check');
        const intervalEl = document.getElementById('pm-poke-interval');
        const emojiChecks = document.querySelectorAll('.pm-emoji-assign-check.is-checked');
        const selectedEmojis = Array.from(emojiChecks).map(cb => cb.dataset.id);

        if (checkEl && intervalEl) {
            const id = getStorageId();
            if (!window.__pmPokeConfig[id]) window.__pmPokeConfig[id] = {};

            const enabled = checkEl.classList.contains('is-checked');
            const interval = parseInt(intervalEl.value) || 3;
            const oldCounter = window.__pmPokeConfig[id][contactName]?.autoPoke?.counter || 0;

            window.__pmPokeConfig[id][contactName] = {
                autoPoke: {
                    enabled,
                    interval: Math.max(1, Math.min(99, interval)),
                    counter: enabled ? Math.min(oldCounter, interval - 1) : oldCounter
                },
                emojis: selectedEmojis
            };
            savePokeConfig();
        }

        const remarkEl = document.getElementById('pm-cfg-remark-input');
        const avatarCheckEl = document.getElementById('pm-avatar-check');
        if (remarkEl || avatarCheckEl) {
            const id = getStorageId();
            window.__pmAvatarData[id] = window.__pmAvatarData[id] || {};
            window.__pmAvatarData[id][contactName] = window.__pmAvatarData[id][contactName] || { enabled: false, self: '', other: '', remark: '', members: {} };
            if (remarkEl) window.__pmAvatarData[id][contactName].remark = remarkEl.value.trim();
            if (avatarCheckEl) window.__pmAvatarData[id][contactName].enabled = avatarCheckEl.classList.contains('is-on');
            saveAvatarData();
            if (!isGroupChat && currentPersona === contactName && phoneWindow) {
                const nameEl = phoneWindow.querySelector('.pm-name');
                if (nameEl) nameEl.textContent = getRemark(contactName) || contactName;
                fitNameFont();
                renderHistoryMessages();
            }
        }

        document.getElementById('pm-overlay')?.remove();
        addNote(`已保存 ${contactName} 的设置`);
    };

    window.__pmToggleWordyLimit = () => {
        window.__pmWordyLimit = !window.__pmWordyLimit;
        saveWordyLimit();
        const el = document.getElementById('pm-wordy-check');
        if (el) el.classList.toggle('is-checked', window.__pmWordyLimit);
    };

    window.__pmToggleAutoPoke = (contactName) => {
        const checkEl = document.getElementById('pm-poke-check');
        const intervalEl = document.getElementById('pm-poke-interval');
        if (!checkEl) return;
        const isChecked = checkEl.classList.toggle('is-checked');
        if (intervalEl) intervalEl.disabled = !isChecked;
    };

    window.__pmPoke = async (contactName) => {
        // 修复：先检查生成锁，再切换联系人，避免"界面已切换但函数直接 return"的幽灵切换问题
        if (isGenerating) return;

        const id = getStorageId();
        if (window.__pmPokeConfig[id]?.[contactName]) {
            window.__pmPokeConfig[id][contactName].autoPoke.counter = 0;
            savePokeConfig();
        }

        document.getElementById('pm-overlay')?.remove();

        if (currentPersona !== contactName) {
            window.__pmSwitchContact(contactName);
        }

        isGenerating = true;

        const input = phoneWindow?.querySelector('.pm-input');
        const btn = phoneWindow?.querySelector('.pm-up-btn');
        if (input) input.disabled = true;
        if (btn) btn.disabled = true;

        showTyping();

        const ctxData = await gatherContext();
        const { cardDesc, cardPersonality, cardScenario, cardMesExample, mainChatText, worldBookText, userName, userDesc } = ctxData;

        const userBlock = [
            `用户名字：${userName}`,
            userDesc ? `用户人设：${userDesc}` : ''
        ].filter(Boolean).join('\n');
        
        const smsHistoryText = conversationHistory.slice(-CONTEXT_LIMIT).map(m => {
            const clean = cleanResponse(m.content);
            return m.role === 'user' ? `${userName}：${clean}` : (isGroupChat ? clean : `${contactName}：${clean}`);
        }).join('\n');

        const systemPrompt = isGroupChat
            ? `你同时扮演群聊中的所有成员。\n【务必直接按格式输出短信内容，严禁在开头输出“好的”等废话。】`
            : `你正在扮演"${contactName}"通过手机短信与用户 ${userName} 聊天。\n【务必直接按格式输出短信内容，严禁在开头输出“好的”等废话。】`;

        // 修复：注入表情包提示词（与 fetchSMS 保持一致）
        const targetContactKey = isGroupChat ? currentGroupKey : contactName;
        const emojiPrompt = getEmojiPrompt(targetContactKey);
        const userPrompt = isGroupChat
            ? `群聊名称：${groupDisplayName || '群聊'}\n群聊成员：${groupMembers.join('、')}\n\n请以所有群成员的身份，根据各自的性格和当前聊天上下文，自然地发起话题或继续聊天。每个成员根据人设决定发言 0-8 句。\n\n输出格式：角色名：消息内容 / 消息内容\n\n【用户信息】\n${userBlock}\n\n【角色设定】\n${cardDesc || ''}\n\n【性格】\n${cardPersonality || ''}\n\n【场景】\n${cardScenario || ''}\n\n【世界书】\n${worldBookText || ''}\n\n【主线最近对话】\n${mainChatText || ''}\n\n【群聊历史】\n${smsHistoryText}`
            : `作为${contactName}，根据你的人设、性格和当前聊天情境，自然地发送 3-8 句短信，不要提及任何外部触发，就像你自己突然想发消息一样。\n\n【用户信息】\n${userBlock}\n\n【角色设定】\n${cardDesc || ''}\n\n【性格】\n${cardPersonality || ''}\n\n【场景】\n${cardScenario || ''}\n\n【对话示例】\n${cardMesExample || ''}\n\n【世界书】\n${worldBookText || ''}\n\n【主线最近对话】\n${mainChatText || ''}\n\n【短信对话历史】\n${smsHistoryText}\n\n输出格式：短信内容 / 短信内容（每句用 / 分隔，特殊格式中文单行闭合）`
            + (emojiPrompt ? emojiPrompt : '')
            + getWordyPrompt();

        try {
            const raw = await callAI(systemPrompt, userPrompt);
            let historyUpdated = false;

            hideTyping();

            if (isGroupChat) {
                const parsed = parseGroupResponse(raw);
                const contentParts = [];
                for (const block of parsed) {
                    if (block.sentences.length > 0) {
                        contentParts.push(`${block.name}：${block.sentences.join(' / ')}`);
                        for (const s of block.sentences) {
                            await new Promise(r => setTimeout(r, 120));
                            addBubble(s, 'left', block.name);
                        }
                    }
                }
                if (contentParts.length > 0) {
                    conversationHistory.push({ role: 'assistant', content: contentParts.join('\n') });
                    historyUpdated = true;
                }
            } else {
                const clean = cleanResponse(raw);
                const sentences = splitToSentences(clean);
                if (sentences.length > 0) {
                    conversationHistory.push({ role: 'assistant', content: sentences.join(' / ') });
                    historyUpdated = true;
                    for (const s of sentences) {
                        await new Promise(r => setTimeout(r, 150));
                        addBubble(s, 'left');
                    }
                }
            }

            if (historyUpdated) {
                const id = getStorageId();
                if (!window.__pmHistories[id]) window.__pmHistories[id] = {};
                const saveKey = isGroupChat && currentGroupKey ? currentGroupKey : currentPersona;
                window.__pmHistories[id][saveKey] = conversationHistory.slice(-SAVE_LIMIT);
                saveHistories();
                applyBidirectionalInjection();
            }
        } catch (e) {
            hideTyping();
            addNote(`（发送失败：${e?.message || e}）`);
        }

        if (input) input.disabled = false;
        if (btn) btn.disabled = false;
        isGenerating = false;
    };

    window.__pmEditGroup = () => {
        if (!isGroupChat) {
            showContactConfig(currentPersona);
        } else {
            showGroupForm('edit', groupDisplayName, groupMembers);
        }
    };

    function showGroupForm(mode, existingName, existingMembers) {
        document.getElementById('pm-overlay')?.remove();
        const title = mode === 'create' ? '新建群聊' : '编辑群聊';
        const initName = existingName || '';
        const initMembers = (existingMembers || []).join(' / ');
        const closeAction = mode === 'create'
            ? "window.__pmShowList()"
            : "window.__pmSaveAndCloseGroupEdit()";

        let pokeConfig = { enabled: false, interval: 3, counter: 0 };
        let assignedEmojis = [];
        let avatarGroupEnabled = false;
        if (mode === 'edit' && currentGroupKey) {
            const id = getStorageId();
            pokeConfig = window.__pmPokeConfig[id]?.[currentGroupKey]?.autoPoke || pokeConfig;
            assignedEmojis = window.__pmPokeConfig[id]?.[currentGroupKey]?.emojis || [];
            avatarGroupEnabled = !!window.__pmAvatarData[id]?.[currentGroupKey]?.enabled;
        }

        const emojiCheckHtml = window.__pmEmojis.length ? `
        <div style="padding-top:12px;border-top:1px solid #f0f0f0;">
            <div class="pm-cfg-label" style="margin-bottom:8px;">🥰 允许 AI 使用的表情包套组</div>
            <div style="display:flex;flex-direction:column;gap:10px;max-height:120px;overflow-y:auto;background:#fafafa;border-radius:8px;padding:10px;border:1px solid #eee;">
                ${window.__pmEmojis.map(set => `
                    <div style="display:flex;align-items:center;gap:10px;cursor:pointer;"
                         onclick="this.querySelector('.pm-emoji-assign-check').classList.toggle('is-checked')">
                        <div class="pm-custom-check pm-bi-style pm-emoji-assign-check ${assignedEmojis.includes(set.id) ? 'is-checked' : ''}"
                             data-id="${escapeAttr(set.id)}"
                             style="width:20px;height:20px;min-width:20px;flex-shrink:0;margin-bottom:0;"></div>
                        <span style="font-size:13px;color:#333;">${escapeHtml(set.name)}</span>
                        <span style="color:#aaa;font-size:11px;margin-left:auto;">(${set.images.length}张)</span>
                    </div>
                `).join('')}
            </div>
        </div>` : '';

        makeOverlay(`
    <div class="pm-modal pm-modal-wide">
    <div class="pm-modal-header"><b>${title}</b><span onclick="${closeAction}" class="pm-modal-close">✕</span></div>
    <div style="padding:14px 16px;display:flex;flex-direction:column;gap:10px;">
        <div class="pm-cfg-label">群聊名称</div>
        <input id="pm-group-name-input" class="pm-cfg-input" placeholder="给群聊起个名字" value="${escapeAttr(initName)}" maxlength="30">
        <div class="pm-cfg-label" style="margin-top:4px;">成员（用 / 分隔）</div>
        <input id="pm-group-input" class="pm-cfg-input" placeholder="角色A / 角色B / 角色C" oninput="window.__pmGroupInputChanged()" value="${escapeAttr(initMembers)}">
        <div id="pm-group-counter" class="pm-cfg-tip" style="text-align:left;font-weight:600;">0/${MAX_GROUP_MEMBERS - 1} 个角色</div>
        <div id="pm-group-preview" style="display:flex;flex-wrap:wrap;gap:4px;"></div>

        ${mode === 'edit' ? `
        <div style="padding-top:8px;border-top:1px solid #f0f0f0;">
        <div style="display:flex;align-items:center;justify-content:space-between;">
            <span style="font-size:13px;font-weight:600;">头像显示</span>
            <div onclick="window.__pmToggleAvatarSwitchGroup()"
                class="pm-switch ${avatarGroupEnabled ? 'is-on' : ''}"
                id="pm-avatar-check-group"></div>
        </div>
        </div>
        ${emojiCheckHtml}
        <div style="margin-top:0px;padding-top:8px;border-top:1px solid #f0f0f0;">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
            <span style="font-size:13px;font-weight:600;">⏰ 自动发消息</span>
            <div onclick="window.__pmToggleAutoPokeGroup()"
                class="pm-custom-check pm-bi-style ${pokeConfig.enabled ? 'is-checked' : ''}"
                id="pm-poke-check-group"
                style="cursor:pointer;width:22px;height:22px;min-width:22px;min-height:22px;flex-shrink:0;border-radius:50%;">
            </div>
        </div>
        <div style="display:flex;align-items:center;gap:8px;">
            <span style="font-size:12px;color:#888;">每隔</span>
            <input id="pm-poke-interval-group" type="number" min="1" max="99"
                value="${pokeConfig.interval}"
                style="width:50px;border:1px solid #ddd;border-radius:6px;padding:4px 8px;font-size:13px;text-align:center;"
                ${!pokeConfig.enabled ? 'disabled' : ''}>
            <span style="font-size:12px;color:#888;">轮无输入主动发消息</span>
        </div>
        <div style="font-size:11px;color:#999;margin-top:4px;">
            当前计数：<span id="pm-poke-counter-group">${pokeConfig.counter}</span> / ${pokeConfig.interval}
        </div>
        <div style="margin-top:12px;">
            <button onclick="window.__pmPokeGroup()"
                    style="width:100%;background:linear-gradient(135deg,#ff9500,#ff6b00);color:#fff;border:none;border-radius:12px;padding:14px;font-size:14px;cursor:pointer;font-weight:600;display:flex;align-items:center;justify-content:center;">
            拍一拍
            </button>
        </div>
        </div>
        ` : ''}
    </div>
    ${mode === 'create' ? `
    <div class="pm-modal-add">
        <button onclick="window.__pmConfirmGroup('${safeJS(mode)}')" style="flex:1;background:#007aff;color:#fff;border:none;border-radius:10px;padding:10px;font-size:13px;cursor:pointer;font-weight:600;">创建</button>
    </div>` : ''}
    </div>`);
        setTimeout(() => window.__pmGroupInputChanged(), 0);
    }

    window.__pmToggleAutoPokeGroup = () => {
        const checkEl = document.getElementById('pm-poke-check-group');
        const intervalEl = document.getElementById('pm-poke-interval-group');
        if (!checkEl) return;
        const isChecked = checkEl.classList.toggle('is-checked');
        if (intervalEl) intervalEl.disabled = !isChecked;
    };

    window.__pmPokeGroup = async () => {
        if (!isGroupChat || !currentGroupKey) return;
        // 修复：先检查生成锁，再移除 overlay，避免弹窗关闭但函数直接 return 的状态不一致
        if (isGenerating) return;

        const id = getStorageId();
        if (window.__pmPokeConfig[id]?.[currentGroupKey]) {
            window.__pmPokeConfig[id][currentGroupKey].autoPoke.counter = 0;
            savePokeConfig();
        }

        document.getElementById('pm-overlay')?.remove();

        isGenerating = true;

        const input = phoneWindow?.querySelector('.pm-input');
        const btn = phoneWindow?.querySelector('.pm-up-btn');
        if (input) input.disabled = true;
        if (btn) btn.disabled = true;

        showTyping();

        const ctxData = await gatherContext();
        const { cardDesc, cardPersonality, cardScenario, mainChatText, worldBookText, userName, userDesc } = ctxData;

        const userBlock = [
            `用户名字：${userName}`,
            userDesc ? `用户人设：${userDesc}` : ''
        ].filter(Boolean).join('\n');
        
        const smsHistoryText = conversationHistory.slice(-CONTEXT_LIMIT).map(m => {
            const clean = cleanResponse(m.content);
            return m.role === 'user' ? `${userName}：${clean}` : clean;
        }).join('\n');

        const systemPrompt = `你同时扮演群聊中的所有成员。\n【务必直接按格式输出短信内容，严禁在开头输出“好的”等废话。】`;
        const userPrompt = `群聊名称：${groupDisplayName || '群聊'}\n群聊成员：${groupMembers.join('、')}\n\n请以每个群成员的身份，根据各自的性格、人设和当前聊天上下文，自然地发起话题或继续聊天，不要提及任何外部触发。\n每个成员根据自己的判断选择发言 0-8 条。\n\n输出格式：角色名：消息内容 / 消息内容\n\n【用户信息】\n${userBlock}\n\n【角色设定】\n${cardDesc || ''}\n\n【性格】\n${cardPersonality || ''}\n\n【场景】\n${cardScenario || ''}\n\n【世界书】\n${worldBookText || ''}\n\n【主线最近对话】\n${mainChatText || ''}\n\n【群聊历史】\n${smsHistoryText}`
            + (getEmojiPrompt(currentGroupKey) || '') + getWordyPrompt();

        try {
            const raw = await callAI(systemPrompt, userPrompt);
            hideTyping();

            const parsed = parseGroupResponse(raw);
            const contentParts = []; 
            
            for (const block of parsed) {
                if (block.sentences.length > 0) {
                    contentParts.push(`${block.name}：${block.sentences.join(' / ')}`);
                    for (const s of block.sentences) {
                        await new Promise(r => setTimeout(r, 120));
                        addBubble(s, 'left', block.name, conversationHistory.length); // +1 after push below
                    }
                    // 每个成员说完话立即落盘，防止后续 block 渲染途中挂起
                    conversationHistory.push({ role: 'assistant', content: contentParts[contentParts.length - 1] });
                    { const _id = getStorageId(); if (!window.__pmHistories[_id]) window.__pmHistories[_id] = {};
                      const _key = isGroupChat && currentGroupKey ? currentGroupKey : currentPersona;
                      window.__pmHistories[_id][_key] = conversationHistory.slice(-SAVE_LIMIT);
                      saveHistories(); }
                }
            }
            
            if (contentParts.length > 0) {
                // 已在循环内逐条 push，此处仅做双向注入
                applyBidirectionalInjection();
            }
        } catch (e) {
            hideTyping();
            addNote(`（发送失败：${e?.message || e}）`);
        }

        if (input) input.disabled = false;
        if (btn) btn.disabled = false;
        isGenerating = false;
    };

    window.__pmSaveAndCloseGroupEdit = () => {
        const nameInput = document.getElementById('pm-group-name-input');
        const memInput = document.getElementById('pm-group-input');

        if (nameInput && memInput && currentGroupKey) {
            const groupName = nameInput.value.trim();
            const names = memInput.value.split(/[/／]/).map(s => s.trim()).filter(Boolean).slice(0, MAX_GROUP_MEMBERS - 1);

            if (groupName && names.length >= 2) {
                const id = getStorageId();
                if (!window.__pmGroupMeta[id]) window.__pmGroupMeta[id] = {};
                window.__pmGroupMeta[id][currentGroupKey] = { name: groupName, members: names };
                saveGroupMeta();

                groupMembers = names; groupDisplayName = groupName;
                groupColorMap = {};
                names.forEach((n, i) => { groupColorMap[n] = GROUP_COLORS[i % GROUP_COLORS.length]; });
            }

            const checkEl = document.getElementById('pm-poke-check-group');
            const intervalEl = document.getElementById('pm-poke-interval-group');
            const emojiChecks = document.querySelectorAll('.pm-emoji-assign-check.is-checked');
            const selectedEmojis = Array.from(emojiChecks).map(cb => cb.dataset.id);

            if (checkEl && intervalEl) {
                const id = getStorageId();
                if (!window.__pmPokeConfig[id]) window.__pmPokeConfig[id] = {};

                const enabled = checkEl.classList.contains('is-checked');
                const interval = parseInt(intervalEl.value) || 3;
                const oldCounter = window.__pmPokeConfig[id][currentGroupKey]?.autoPoke?.counter || 0;

                window.__pmPokeConfig[id][currentGroupKey] = {
                    autoPoke: {
                        enabled,
                        interval: Math.max(1, Math.min(99, interval)),
                        counter: enabled ? Math.min(oldCounter, interval - 1) : oldCounter
                    },
                    emojis: selectedEmojis
                };

                savePokeConfig();
            }

            const avatarCheckEl = document.getElementById('pm-avatar-check-group');
            if (avatarCheckEl) {
                const id = getStorageId();
                window.__pmAvatarData[id] = window.__pmAvatarData[id] || {};
                window.__pmAvatarData[id][currentGroupKey] = window.__pmAvatarData[id][currentGroupKey] || { enabled: false, self: '', other: '', remark: '', members: {} };
                window.__pmAvatarData[id][currentGroupKey].enabled = avatarCheckEl.classList.contains('is-on');
                saveAvatarData();
            }
        }

        document.getElementById('pm-overlay')?.remove();

        if (phoneWindow && currentGroupKey) {
            window.__pmSwitch(currentGroupKey);
        }
    };

    window.__pmShowGroupCreate = () => showGroupForm('create');

    window.__pmGroupInputChanged = () => {
        const input = document.getElementById('pm-group-input');
        const counter = document.getElementById('pm-group-counter');
        const preview = document.getElementById('pm-group-preview');
        if (!input) return;
        const names = input.value.split(/[/／]/).map(s => s.trim()).filter(Boolean);
        const max = MAX_GROUP_MEMBERS - 1;
        const count = Math.min(names.length, max);
        const over = names.length > max;
        counter.textContent = `${count}/${max} 个角色${over ? ' ⚠️ 超出上限' : ''}`;
        counter.style.color = over ? '#ff3b30' : '#b87a00';
        preview.innerHTML = names.slice(0, max).map((n, i) => {
            const gc = GROUP_COLORS[i % GROUP_COLORS.length];
            return `<span style="background:${gc.bg};color:${gc.text};padding:3px 8px;border-radius:10px;font-size:11px;">${escapeHtml(n)}</span>`;
        }).join('');
    };

    window.__pmConfirmGroup = (mode) => {
        const nameInput = document.getElementById('pm-group-name-input');
        const memInput = document.getElementById('pm-group-input');
        if (!nameInput || !memInput) return;
        const groupName = nameInput.value.trim();
        const names = memInput.value.split(/[/／]/).map(s => s.trim()).filter(Boolean).slice(0, MAX_GROUP_MEMBERS - 1);
        if (!groupName) { alert('请输入群聊名称'); return; }
        if (names.length < 2) { alert('至少需要 2 个角色'); return; }

        document.getElementById('pm-overlay')?.remove();
        const id = getStorageId();
        if (!window.__pmGroupMeta[id]) window.__pmGroupMeta[id] = {};
        
        if (mode === 'create') {
            const groupKey = `__group_${Date.now()}`;
            // 修复：在修改全局状态前先快照旧的 saveKey，防止旧聊天记录被写入新群聊
            const _prevSaveKey = isGroupChat && currentGroupKey ? currentGroupKey : currentPersona;
            window.__pmGroupMeta[id][groupKey] = { name: groupName, members: names };
            saveGroupMeta();
            isGroupChat = true; groupMembers = names; groupDisplayName = groupName; currentGroupKey = groupKey;
            groupColorMap = {}; names.forEach((n, i) => { groupColorMap[n] = GROUP_COLORS[i % GROUP_COLORS.length]; });
            window.__pmSwitch(groupKey, _prevSaveKey);
        } else {
            if (!currentGroupKey) return;
            window.__pmGroupMeta[id][currentGroupKey] = { name: groupName, members: names };
            saveGroupMeta();
            groupMembers = names; groupDisplayName = groupName;
            groupColorMap = {}; names.forEach((n, i) => { groupColorMap[n] = GROUP_COLORS[i % GROUP_COLORS.length]; });
            window.__pmSwitch(currentGroupKey);
        }
    };

    window.__pmSetDarkMode = (mode) => {
        window.__pmTheme.darkMode = mode;
        saveTheme();
        if (phoneWindow) {
            phoneWindow.setAttribute('data-theme', mode);
        }
        document.querySelectorAll('.pm-layout-chip').forEach(el => {
            if (el.textContent.includes('日间') || el.textContent.includes('夜间')) {
                el.classList.toggle('pm-layout-active',
                    (mode === 'light' && el.textContent.includes('日间')) ||
                    (mode === 'dark' && el.textContent.includes('夜间'))
                );
            }
        });
    };

    // ========== 导出 / 导入 数据功能 ==========
    window.__pmExportData = () => {
        const data = {
            histories: window.__pmHistories || {},
            config: window.__pmConfig || {},
            theme: window.__pmTheme || {},
            profiles: window.__pmProfiles || [],
            groupMeta: window.__pmGroupMeta || {},
            pokeConfig: window.__pmPokeConfig || {},
            bidirectional: window.__pmBidirectional || {},
            emojis: window.__pmEmojis || [],
            avatarData: window.__pmAvatarData || {},
            weiboPosts: window.__pmWeiboPosts || {},
            weiboIdentity: window.__pmWeiboIdentity || {},
            npcAvatars: window.__pmNpcAvatars || []
        };
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `PhoneMode_Backup_${new Date().getTime()}.json`;
        a.click();
        URL.revokeObjectURL(url);
        alert('✅ 短信备份已成功导出！');
    };

    window.__pmImportData = (input) => {
        const file = input.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const data = JSON.parse(e.target.result);
                if (data.histories) window.__pmHistories = data.histories;
                if (data.config) window.__pmConfig = data.config;
                if (data.theme) window.__pmTheme = data.theme;
                if (data.profiles) window.__pmProfiles = data.profiles;
                if (data.groupMeta) window.__pmGroupMeta = data.groupMeta;
                if (data.pokeConfig) window.__pmPokeConfig = data.pokeConfig;
                if (data.bidirectional) window.__pmBidirectional = data.bidirectional;
                if (data.emojis) { window.__pmEmojis = data.emojis; saveEmojis(); }
                if (data.avatarData) { window.__pmAvatarData = data.avatarData; saveAvatarData(); }
                if (data.weiboPosts) { window.__pmWeiboPosts = data.weiboPosts; saveWeiboPosts(); }
                if (data.weiboIdentity) { window.__pmWeiboIdentity = data.weiboIdentity; saveWeiboIdentity(); }
                if (data.npcAvatars) { window.__pmNpcAvatars = data.npcAvatars; saveNpcAvatars(); }

                saveHistories();
                try { localStorage.setItem('ST_SMS_CONFIG', JSON.stringify(window.__pmConfig)); } catch(err) {}
                saveTheme();
                saveGroupMeta();
                try { localStorage.setItem('ST_SMS_POKE_CONFIG', JSON.stringify(window.__pmPokeConfig)); } catch(err) {}
                try { localStorage.setItem('ST_SMS_BIDIRECTIONAL', JSON.stringify(window.__pmBidirectional)); } catch(err) {}

                alert('✅ 数据导入成功！请重新打开短信界面生效。');
                document.getElementById('pm-overlay')?.remove();
                window.__pmEnd();
            } catch (err) {
                alert('❌ 导入失败，文件格式不正确！\n' + err.message);
            }
        };
        reader.readAsText(file);
        input.value = '';
    };

    // ========== 设置界面 ==========
    window.__pmShowConfig = async () => {
        loadProfiles(); loadTheme();
        await loadBgSettings();
        const cfg = window.__pmConfig, t = window.__pmTheme;
        const shortUrl = (u) => (u || '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
        const maskKey = (k) => !k ? '' : (k.length <= 8 ? '****' : k.slice(0, 4) + '****' + k.slice(-4));
        const profilesHtml = window.__pmProfiles.length > 0
            ? window.__pmProfiles.map((p, i) => `<div class="pm-prof-li"><div class="pm-prof-info" onclick="window.__pmPickProfile(${i})"><div class="pm-prof-url">${escapeHtml(shortUrl(p.apiUrl))}</div><div class="pm-prof-meta">${escapeHtml(maskKey(p.apiKey))}${p.model ? ' · ' + escapeHtml(p.model) : ''}</div></div><i class="pm-prof-del" onclick="window.__pmDeleteProfile(${i})">✕</i></div>`).join('')
            : '<div class="pm-prof-empty">暂无档案</div>';
        const useIndep = !!cfg.useIndependent;
        const presetBtns = Object.entries(THEME_PRESETS).map(([k, v]) =>
            `<div class="pm-theme-chip ${t.preset === k ? 'pm-theme-active' : ''}" data-preset="${k}" onclick="window.__pmSetPreset('${safeJS(k)}')"><span class="pm-theme-dot" style="background:${v.right}"></span>${v.label}</div>`
        ).join('');
        const layoutBtns = ['standard', 'relaxed'].map(v =>
            `<div class="pm-layout-chip ${t.layout === v ? 'pm-layout-active' : ''}" onclick="window.__pmSetLayout('${safeJS(v)}')">${v === 'standard' ? '标准' : '宽松'}</div>`
        ).join('');
        const id = getStorageId(), localKey = `${id}_${currentPersona}`;
        const hasGlobalBg = !!window.__pmBgGlobal, hasLocalBg = !!window.__pmBgLocal[localKey];
        const globalBgBtn = hasGlobalBg
            ? `<button class="pm-bg-btn pm-bg-del" onclick="window.__pmClearBg('global')">清除</button>`
            : `<label class="pm-bg-btn">选择图片<input type="file" accept="image/*" onchange="window.__pmUploadBg(this,'global')" hidden></label>
               <button class="pm-bg-btn" onclick="window.__pmBgUrl('global')">URL</button>`;
        const localBgBtn = hasLocalBg
            ? `<button class="pm-bg-btn pm-bg-del" onclick="window.__pmClearBg('local')">清除</button>`
            : `<label class="pm-bg-btn">选择图片<input type="file" accept="image/*" onchange="window.__pmUploadBg(this,'local')" hidden></label>
               <button class="pm-bg-btn" onclick="window.__pmBgUrl('local')">URL</button>`;

        makeOverlay(`
<div class="pm-modal pm-modal-wide" style="height: 560px;"> <div class="pm-modal-header"><b>设置</b><span onclick="document.getElementById('pm-overlay').remove()" class="pm-modal-close">✕</span></div>
  <div class="pm-cfg-tabs">
    <div class="pm-cfg-tab pm-cfg-tab-active" data-tab="api" onclick="window.__pmSwitchTab('api')">API</div>
    <div class="pm-cfg-tab" data-tab="look" onclick="window.__pmSwitchTab('look')">外观</div>
    <div class="pm-cfg-tab" data-tab="image" onclick="window.__pmSwitchTab('image')">图像</div>
    <div class="pm-cfg-tab" data-tab="other" onclick="window.__pmSwitchTab('other')">其他</div>
  </div>
  <div class="pm-modal-scroll">
    <div id="pm-tab-api" class="pm-tab-pane">
      <div style="padding:12px 14px 6px;">
        <div class="pm-cfg-label" style="margin-bottom:6px;">⚡ API 模式</div>
        <div class="pm-mode-switch">
          <div id="pm-mode-main" class="pm-mode-opt ${!useIndep ? 'pm-mode-active' : ''}" onclick="window.__pmSetMode(false)">🏠 主API</div>
          <div id="pm-mode-indep" class="pm-mode-opt ${useIndep ? 'pm-mode-active' : ''}" onclick="window.__pmSetMode(true)">🔌 独立API</div>
        </div>
        <div id="pm-mode-tip" class="pm-cfg-tip" style="text-align:left;padding:6px 2px 0;">${useIndep ? '🔌 独立API' : '🏠 主API'}</div>
      </div>
      <div style="padding:6px 14px 4px;border-top:1px solid #f0f0f0;">
        <div class="pm-cfg-label" style="margin:8px 0 6px;">📚 已保存档案</div>
        <div class="pm-prof-list">${profilesHtml}</div>
      </div>
      <div style="padding:10px 16px;display:flex;flex-direction:column;gap:10px;border-top:1px solid #f0f0f0;">
        <div class="pm-cfg-label">API 地址</div>
        <input id="pm-cfg-url" class="pm-cfg-input" placeholder="https://api.xxx.com 或 .../v1" value="${escapeAttr(cfg.apiUrl || '')}">
        <div class="pm-cfg-label">API Key</div>
        <input id="pm-cfg-key" class="pm-cfg-input" placeholder="sk-..." value="${escapeAttr(cfg.apiKey || '')}" maxlength="999">
        <div class="pm-cfg-label">模型名称</div>
        <div class="pm-model-row">
          <input id="pm-cfg-model" class="pm-cfg-input" placeholder="手动输入或 ▼" value="${escapeAttr(cfg.model || '')}">
          <button id="pm-model-arrow" type="button" onclick="window.__pmShowModelPicker()">▼</button>
        </div>
        <div id="pm-api-status" class="pm-cfg-tip" style="font-weight:bold;">连接成功后自动保存</div>
        
        <div style="display:flex;gap:6px;margin-top:4px;">
          <button onclick="window.__pmTestApi()" style="flex:1;background:#ff9500;color:#fff;border:none;border-radius:10px;padding:9px;font-size:12px;cursor:pointer;font-weight:600;">🔗 拉取模型</button>
          <button onclick="window.__pmTestModel()" style="flex:1;background:#5856d6;color:#fff;border:none;border-radius:10px;padding:9px;font-size:12px;cursor:pointer;font-weight:600;">🧪 测试</button>
        </div>
      </div>
      <div style="height:12px;"></div>
    </div>
    
    <div id="pm-tab-look" class="pm-tab-pane" style="display:none;">
      <div style="padding:12px 16px 0;"> <div class="pm-cfg-label" style="margin-bottom:8px;">🌓 日夜模式</div>
        <div class="pm-theme-row" style="margin-bottom:8px;"> <div class="pm-layout-chip ${t.darkMode === 'light' ? 'pm-layout-active' : ''}" onclick="window.__pmSetDarkMode('light')">☀️ 日间</div>
          <div class="pm-layout-chip ${t.darkMode === 'dark' ? 'pm-layout-active' : ''}" onclick="window.__pmSetDarkMode('dark')">🌙 夜间</div>
        </div>
      </div>
      <div style="padding:12px 16px;border-top:1px solid #f0f0f0;">
        <div class="pm-cfg-label" style="margin-bottom:8px;">📐 界面布局</div>
        <div class="pm-layout-row">${layoutBtns}</div>
      </div>
      <div style="padding:14px 16px 12px;border-top:1px solid #f0f0f0;">
        <div class="pm-cfg-label" style="margin-bottom:10px;">🎨 气泡主题</div>
        <div class="pm-theme-row">${presetBtns}</div>
        <div style="display:flex;gap:8px;margin-top:14px;align-items:center;flex-wrap:wrap;">
          <label class="pm-cfg-label" style="margin:0;">自定义右</label>
          <input id="pm-custom-right" type="color" value="${t.customRight || '#007aff'}" onchange="window.__pmSetCustomColor()" class="pm-color-pick">
          <label class="pm-cfg-label" style="margin:0;">自定义左</label>
          <input id="pm-custom-left" type="color" value="${t.customLeft || '#e9e9eb'}" onchange="window.__pmSetCustomColor()" class="pm-color-pick">
          <button onclick="window.__pmClearCustomColor()" class="pm-color-clear">重置</button>
        </div>
        <div style="display:flex;gap:8px;margin-top:12px;align-items:center;">
          <label class="pm-cfg-label" style="margin:0;">边框颜色</label>
          <input id="pm-border-color" type="color" value="${t.borderColor || '#1a1a1a'}" onchange="window.__pmSetBorderColor()" class="pm-color-pick">
          <button onclick="document.getElementById('pm-border-color').value='#1a1a1a';window.__pmSetBorderColor()" class="pm-color-clear">重置</button>
        </div>
      </div>
      <div style="padding:12px 16px 12px;border-top:1px solid #f0f0f0;">
        <div class="pm-cfg-label" style="margin-bottom:14px;">🖼️ 背景图</div>
        <div style="display:flex;flex-direction:column;gap:14px;padding:0 4px;">
          <div class="pm-bg-row">
            <span class="pm-bg-label">全局背景</span>
            ${globalBgBtn}
          </div>
          <div class="pm-bg-row">
            <span class="pm-bg-label">本联系人</span>
            ${localBgBtn}
          </div>
        </div>
      </div>
      <div style="height:12px;"></div>
    </div>
    <div id="pm-tab-image" class="pm-tab-pane" style="display:none;">
      <div style="padding:14px 16px 12px;border-bottom:1px solid #f0f0f0;">
        <div class="pm-cfg-label" style="margin-bottom:10px;">✍️ 字数控制</div>
        <div style="display:flex;align-items:center;justify-content:space-between;padding:4px 0;">
          <div style="display:flex;flex-direction:column;gap:3px;">
            <span style="font-size:13px;font-weight:600;color:#333;">话少一点</span>
            <span style="font-size:11px;color:#aaa;">每条消息不超过35字（话痨人设除外）</span>
          </div>
          <div id="pm-wordy-check"
               onclick="window.__pmToggleWordyLimit()"
               class="pm-custom-check pm-bi-style"
               style="cursor:pointer;width:22px;height:22px;min-width:22px;min-height:22px;flex-shrink:0;border-radius:50%;">
          </div>
        </div>
      </div>
      <div style="padding:14px 16px 12px;border-bottom:1px solid #f0f0f0;">
        <div class="pm-cfg-label" style="margin-bottom:10px;">🥰 表情包管理</div>
        <div id="pm-emoji-set-list"></div>
        <button onclick="window.__pmAddEmojiSet()" style="width:100%;margin-top:8px;background:#007aff;color:#fff;border:none;border-radius:10px;padding:10px;font-size:13px;cursor:pointer;font-weight:600;">➕ 添加新套组</button>
        <div class="pm-cfg-tip" style="text-align:left;margin-top:6px;">最多 10 套，每套最多 20 张图片</div>
      </div>
      <div style="padding:12px 16px 12px;border-bottom:1px solid #f0f0f0;">
        <div class="pm-cfg-label" style="margin-bottom:10px;">🧑‍🤝‍🧑 微博NPC头像组</div>
        <div id="pm-npcav-set-list"></div>
        <button onclick="window.__pmAddNpcAvSet()" style="width:100%;margin-top:8px;background:#007aff;color:#fff;border:none;border-radius:10px;padding:10px;font-size:13px;cursor:pointer;font-weight:600;">➕ 添加新头像组</button>
        <div class="pm-cfg-tip" style="text-align:left;margin-top:6px;">勾选启用的组会被微博评论区取用；头像不够时其余NPC用灰色占位。最多 10 组，每组最多 30 张</div>
      </div>
      <div style="padding:12px 16px 12px;">
        <div class="pm-cfg-label" style="margin-bottom:10px;">🎨 AI 生图</div>
        <div style="display:flex;flex-direction:column;gap:8px;">
          <select id="pm-img-provider" class="pm-cfg-input" style="padding:8px 10px;">
            <option value="">— 未启用 —</option>
            <option value="openai">OpenAI / 兼容接口</option>
            <option value="nai">NovelAI (NAI)</option>
          </select>
          <input id="pm-img-url" class="pm-cfg-input" placeholder="API 地址（OpenAI 兼容时填，NAI 留空）">
          <input id="pm-img-key" class="pm-cfg-input" placeholder="API Key">
          <input id="pm-img-model" class="pm-cfg-input" placeholder="模型（OpenAI: dall-e-3 | NAI: nai-diffusion-4-5）">
          <select id="pm-img-size" class="pm-cfg-input" style="padding:8px 10px;">
            <option value="1024x1024">1024×1024（方形）</option>
            <option value="832x1216">832×1216（竖图，NAI 默认）</option>
            <option value="1216x832">1216×832（横图）</option>
          </select>
        </div>
        <div class="pm-cfg-tip" style="text-align:left;margin-top:6px;">配置后点击聊天/微博里的图片描述即可生成，每聊天保存 30 张，全局上限 300 张</div>
      </div>
      <div style="height:12px;"></div>
    </div>
    <div id="pm-tab-other" class="pm-tab-pane" style="display:none;">
      <div style="padding:12px 16px 12px;border-bottom:1px solid #f0f0f0;">
        <div class="pm-cfg-label" style="margin-bottom:10px;">🔊 语音合成（TTS）</div>
        <div style="display:flex;flex-direction:column;gap:8px;">
          <select id="pm-tts-provider" class="pm-cfg-input" style="padding:8px 10px;" onchange="window.__pmTtsProviderChange()">
            <option value="">— 未启用 —</option>
            <option value="openai">OpenAI / 兼容接口</option>
            <option value="minimax">MiniMax</option>
            <option value="doubao">豆包 / 火山引擎</option>
          </select>
          <input id="pm-tts-url" class="pm-cfg-input" placeholder="API 地址（留空用默认）" style="display:none;">
          <input id="pm-tts-key" class="pm-cfg-input" placeholder="API Key" style="display:none;">
          <div id="pm-tts-doubao-row" style="display:none;flex-direction:column;gap:8px;">
            <input id="pm-tts-appid" class="pm-cfg-input" placeholder="AppID">
            <input id="pm-tts-cluster" class="pm-cfg-input" placeholder="Cluster（如 volcano_tts）">
          </div>
          <input id="pm-tts-voice" class="pm-cfg-input" placeholder="音色 ID（如 alloy / zh-CN-XiaoxiaoNeural / BV001_streaming）" style="display:none;">
          <div id="pm-tts-model-row" style="display:none;">
            <input id="pm-tts-model" class="pm-cfg-input" placeholder="模型（如 tts-1、speech-01-turbo）">
          </div>
        </div>
        <div class="pm-cfg-tip" style="text-align:left;margin-top:6px;">配置后角色语音条右侧出现 🔊 按钮，点击即可播放</div>
      </div>
      <div style="padding:12px 16px 12px;">
        <div class="pm-cfg-label" style="margin-bottom:10px;">📦 数据备份</div>
        <div style="display:flex;gap:6px;">
         <button onclick="window.__pmExportData()" style="flex:1;background:#34c759;color:#fff;border:none;border-radius:10px;padding:10px;font-size:13px;cursor:pointer;font-weight:600;">📥 导出备份</button>
         <button onclick="document.getElementById('pm-import-file').click()" style="flex:1;background:#5856d6;color:#fff;border:none;border-radius:10px;padding:10px;font-size:13px;cursor:pointer;font-weight:600;">📤 导入备份</button>
         <input id="pm-import-file" type="file" accept=".json" onchange="window.__pmImportData(this)" hidden>
        </div>
        <div class="pm-cfg-tip" style="text-align:left;margin-top:6px;color:#ff9500;">注意：导入会覆盖当前所有联系人与记录</div>
      </div>
      <div style="height:12px;"></div>
    </div>
  </div>
  <div class="pm-modal-add" id="pm-config-bottom">
    <button onclick="window.__pmSaveConfig()" style="width:100%;background:#007aff;color:#fff;border:none;border-radius:10px;padding:10px;font-size:13px;cursor:pointer;font-weight:600;">保存配置</button>
  </div>
</div>`);
    };

    window.__pmSwitchTab = (tab) => {
        document.querySelectorAll('.pm-cfg-tab').forEach(el => el.classList.toggle('pm-cfg-tab-active', el.dataset.tab === tab));
        document.querySelectorAll('.pm-tab-pane').forEach(el => el.style.display = 'none');
        const pane = document.getElementById(`pm-tab-${tab}`);
        if (pane) pane.style.display = 'block';
        if (tab === 'image') {
            window.__pmRenderEmojiSetList();
            window.__pmRenderNpcAvSetList();
            const wc = document.getElementById('pm-wordy-check');
            if (wc) wc.classList.toggle('is-checked', !!window.__pmWordyLimit);
            window.__pmImgUiLoad();
        }
        if (tab === 'other') {
            window.__pmTtsUiLoad();
        }
    };

    window.__pmSetPreset = (p) => {
        window.__pmTheme.preset = p; window.__pmTheme.customRight = ''; window.__pmTheme.customLeft = '';
        saveTheme(); applyTheme();
        document.querySelectorAll('.pm-theme-chip').forEach(el => el.classList.toggle('pm-theme-active', el.dataset.preset === p));
    };
    window.__pmSetCustomColor = () => {
        window.__pmTheme.customRight = document.getElementById('pm-custom-right')?.value || '';
        window.__pmTheme.customLeft = document.getElementById('pm-custom-left')?.value || '';
        window.__pmTheme.preset = 'custom'; saveTheme(); applyTheme();
        document.querySelectorAll('.pm-theme-chip').forEach(el => el.classList.remove('pm-theme-active'));
    };
    window.__pmClearCustomColor = () => {
        window.__pmTheme.customRight = ''; window.__pmTheme.customLeft = '';
        window.__pmTheme.preset = 'default'; saveTheme(); applyTheme();
        const r = document.getElementById('pm-custom-right'), l = document.getElementById('pm-custom-left');
        if (r) r.value = '#007aff'; if (l) l.value = '#e9e9eb';
        document.querySelectorAll('.pm-theme-chip').forEach(el => el.classList.toggle('pm-theme-active', el.dataset.preset === 'default'));
    };
    window.__pmSetBorderColor = () => {
        window.__pmTheme.borderColor = document.getElementById('pm-border-color')?.value || '#1a1a1a';
        saveTheme(); applyTheme();
    };
    window.__pmSetLayout = (v) => {
        window.__pmTheme.layout = v; saveTheme();
        if (phoneWindow) phoneWindow.dataset.layout = v;
        document.querySelectorAll('.pm-layout-chip').forEach(el => el.classList.toggle('pm-layout-active', el.textContent === (v === 'standard' ? '标准' : '宽松')));
        fitNameFont();
    };

    window.__pmUploadBg = (input, scope) => {
        const file = input.files?.[0]; if (!file) return;
        const reader = new FileReader();
        reader.onload = (e) => {
            openCropper(e.target.result, (croppedDataUrl) => {
                if (scope === 'global') { window.__pmBgGlobal = croppedDataUrl; saveBgGlobal(); }
                else { const id = getStorageId(); window.__pmBgLocal[`${id}_${currentPersona}`] = croppedDataUrl; saveBgLocal(); }
                applyBackground();
                window.__pmShowConfig();
                setTimeout(() => window.__pmSwitchTab('look'), 50);
            });
        };
        reader.readAsDataURL(file);
        input.value = '';
    };

    window.__pmBgUrl = (scope) => {
        const url = prompt('输入图片 URL：');
        if (!url?.trim()) return;
        if (scope === 'global') { window.__pmBgGlobal = url.trim(); saveBgGlobal(); }
        else { const id = getStorageId(); window.__pmBgLocal[`${id}_${currentPersona}`] = url.trim(); saveBgLocal(); }
        applyBackground();
        window.__pmShowConfig();
        setTimeout(() => window.__pmSwitchTab('look'), 50);
    };

    window.__pmClearBg = async (scope) => {
        if (scope === 'global') {
            window.__pmBgGlobal = '';
            await pmIDBDel('ST_SMS_BG_GLOBAL');
            try { localStorage.removeItem('ST_SMS_BG_GLOBAL'); } catch (e) {}
        } else {
            const id = getStorageId(), key = `${id}_${currentPersona}`;
            delete window.__pmBgLocal[key];
            await pmIDBDel('ST_SMS_BG_LOCAL_' + key);
            await saveBgLocal();
        }
        applyBackground();
        window.__pmShowConfig();
        setTimeout(() => window.__pmSwitchTab('look'), 50);
    };

    window.__pmTestApi = async () => {
        const u = document.getElementById('pm-cfg-url').value.trim(), k = document.getElementById('pm-cfg-key').value.trim(), m = document.getElementById('pm-cfg-model').value.trim();
        const s = document.getElementById('pm-api-status');
        if (!u) { s.textContent = "❌ 填写API地址"; s.style.color = "#ff3b30"; return; }
        s.textContent = "连接中..."; s.style.color = "#007aff";
        try {
            const r = await fetch(normalizeApiUrls(u).modelsUrl, { method: 'GET', headers: { 'Authorization': `Bearer ${k}` } });
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            const d = await r.json();
            if (d?.data && Array.isArray(d.data)) { __pmModelList = d.data.map(x => x.id).filter(Boolean); s.textContent = `✅ ${__pmModelList.length} 个模型`; s.style.color = "#34c759"; }
            else { s.textContent = "✅ 连接成功"; s.style.color = "#34c759"; }
            addOrUpdateProfile({ apiUrl: u, apiKey: k, model: m });
        } catch (e) { s.textContent = "❌ " + e.message; s.style.color = "#ff3b30"; }
    };
    window.__pmTestModel = async () => {
        const u = document.getElementById('pm-cfg-url').value.trim(), k = document.getElementById('pm-cfg-key').value.trim(), m = document.getElementById('pm-cfg-model').value.trim();
        const s = document.getElementById('pm-api-status');
        if (!u || !k || !m) { s.textContent = '❌ 请填完整'; s.style.color = '#ff3b30'; return; }
        s.textContent = `测试「${m}」...`; s.style.color = '#007aff';
        const ctrl = new AbortController(); const tm = setTimeout(() => ctrl.abort(), 15000);
        try {
            const r = await fetch(normalizeApiUrls(u).chatUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${k}` }, body: JSON.stringify({ model: m, messages: [{ role: 'user', content: 'hi' }], max_tokens: 16 }), signal: ctrl.signal });
            clearTimeout(tm); if (!r.ok) throw new Error(`HTTP ${r.status}`);
            const j = await r.json(), reply = j.choices?.[0]?.message?.content;
            s.textContent = reply != null ? `✅ "${String(reply).slice(0, 25)}"` : '⚠️ 格式异常'; s.style.color = reply != null ? '#34c759' : '#ff9500';
        } catch (e) { clearTimeout(tm); s.textContent = '❌ ' + (e.name === 'AbortError' ? '超时' : e.message); s.style.color = '#ff3b30'; }
    };
    window.__pmSaveConfig = () => {
        const apiUrl = document.getElementById('pm-cfg-url')?.value.trim() ?? '', apiKey = document.getElementById('pm-cfg-key')?.value.trim() ?? '', model = document.getElementById('pm-cfg-model')?.value.trim() ?? '';
        window.__pmConfig = { ...window.__pmConfig, apiUrl, apiKey, model, useIndependent: !!window.__pmConfig.useIndependent };
        window.__pmTtsSave();
        window.__pmImgSave();
        try { localStorage.setItem('ST_SMS_CONFIG', JSON.stringify(window.__pmConfig)); } catch (e) {}
        if (apiUrl && apiKey) addOrUpdateProfile({ apiUrl, apiKey, model });
        document.getElementById('pm-overlay')?.remove();
        addNote(`已保存：${window.__pmConfig.useIndependent && apiUrl ? '独立API' : '主API'}`);
    };

    window.__pmShowModelPicker = () => {
        const existing = document.getElementById('pm-model-dropdown');
        if (existing) { existing.remove(); return; }
        if (!__pmModelList.length) { const s = document.getElementById('pm-api-status'); if (s) { s.textContent = '⚠️ 先拉取模型'; s.style.color = '#ff9500'; } return; }
        const input = document.getElementById('pm-cfg-model'), rect = input.getBoundingClientRect();
        const dd = document.createElement('div'); dd.id = 'pm-model-dropdown'; dd.className = 'pm-model-dropdown';
        if (POPOVER_SUPPORTED) dd.setAttribute('popover', 'manual');
        dd.innerHTML = `<input class="pm-model-search" placeholder="🔍 搜索..." /><div class="pm-model-options"></div>`;
        dd.style.left = rect.left + 'px'; dd.style.top = (rect.bottom + 4) + 'px'; dd.style.width = rect.width + 'px';
        document.body.appendChild(dd); if (dd.showPopover) try { dd.showPopover(); } catch (e) {}
        const optsDiv = dd.querySelector('.pm-model-options');
        const render = (f = '') => {
            const fl = f.toLowerCase(), filtered = __pmModelList.filter(m => !fl || m.toLowerCase().includes(fl));
            optsDiv.innerHTML = filtered.length ? filtered.map(m => `<div class="pm-model-opt" data-m="${escapeAttr(m)}">${escapeHtml(m)}</div>`).join('') : '<div class="pm-model-empty">无匹配</div>';
            optsDiv.querySelectorAll('.pm-model-opt').forEach(el => el.addEventListener('click', () => { document.getElementById('pm-cfg-model').value = el.dataset.m; dd.remove(); }));
        };
        render(); dd.querySelector('.pm-model-search').addEventListener('input', function () { render(this.value); }); dd.querySelector('.pm-model-search').focus();
        setTimeout(() => { const closer = (e) => { if (!dd.contains(e.target) && e.target.id !== 'pm-model-arrow') { dd.remove(); document.removeEventListener('click', closer, true); } }; document.addEventListener('click', closer, true); }, 0);
    };

    function makeOverlay(html) {
        document.getElementById('pm-overlay')?.remove();
        const ov = document.createElement('div'); ov.id = 'pm-overlay';
        if (POPOVER_SUPPORTED) ov.setAttribute('popover', 'manual');
        ov.innerHTML = html;
        ov.addEventListener('click', e => { if (e.target === ov) ov.remove(); });
        document.body.appendChild(ov);
        if (ov.showPopover) try { ov.showPopover(); } catch (e) {}
        return ov;
    }

    window.__pmShowList = () => {
        const id = getStorageId();
        loadGroupMeta();
        const histories = window.__pmHistories[id] || {};
        const groups = window.__pmGroupMeta[id] || {};
        const checked = window.__pmBidirectional[id] || [];
        const singleList = Object.keys(histories).filter(k => !k.startsWith('__group_'));
        const groupList = Object.keys(groups);

        const renderSingle = singleList.map(n => {
            const isChk = checked.includes(n);
            const remark = getRemark(n);
            return `<div class="pm-li">
                <div class="pm-custom-check pm-bi-style ${isChk ? 'is-checked' : ''}" onclick="event.stopPropagation();window.__pmToggleBidirectional('${safeJS(n)}')" style="width:20px;height:20px;min-width:20px;min-height:20px;flex-shrink:0;border-radius:50%;"></div>
                <span onclick="window.__pmSwitchContact('${safeJS(n)}')">${escapeHtml(remark || n)}${remark ? `<span style="color:#bbb;font-size:11px;margin-left:4px;">(${escapeHtml(n)})</span>` : ''}</span>
                <i onclick="window.__pmDel('${safeJS(n)}')">删除</i>
            </div>`;
        }).join('');

        const renderGroups = groupList.map(key => {
            const meta = groups[key];
            const isChk = checked.includes(key);
            return `<div class="pm-li">
                <div class="pm-custom-check pm-bi-style ${isChk ? 'is-checked' : ''}" onclick="event.stopPropagation();window.__pmToggleBidirectional('${safeJS(key)}')" style="width:20px;height:20px;min-width:20px;min-height:20px;flex-shrink:0;border-radius:50%;"></div>
                <span onclick="window.__pmSwitchContact('${safeJS(key)}')">${escapeHtml(meta.name)}<span class="pm-group-sub">${escapeHtml(meta.members.join('、'))}</span></span>
                <i onclick="window.__pmDelGroup('${safeJS(key)}')">删除</i>
            </div>`;
        }).join('');

        const empty = !singleList.length && !groupList.length;

        makeOverlay(`
    <div class="pm-modal">
    <div class="pm-modal-header">
      <b>联系人</b>
      <span style="display:flex;align-items:center;gap:10px;">
        <span id="pm-autogen-btn" onclick="window.__pmConfirmAutoGen()" title="AI 自动生成联系人" style="cursor:pointer;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:50%;transition:background .15s;" onmouseenter="this.style.background='rgba(0,122,255,0.1)'" onmouseleave="this.style.background='transparent'">
          <svg id="pm-autogen-icon" xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#007aff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="display:block;transform-origin:center center;">
            <path d="M23 4v6h-6"/>
            <path d="M1 20v-6h6"/>
            <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
          </svg>
        </span>
        <span onclick="document.getElementById('pm-overlay').remove()" class="pm-modal-close">✕</span>
      </span>
    </div>
    <div class="pm-bi-bar"><span>🧠 勾选角色/群聊可被主楼读取短信</span><span class="pm-bi-tip">已选 ${checked.length}/${MAX_BIDIRECTIONAL}</span></div>
    <div class="pm-modal-list">
        ${empty ? '<div style="text-align:center;color:#999;padding:20px;font-size:13px;">暂无联系人</div>' : (renderGroups + renderSingle)}
    </div>
    <div class="pm-modal-add" style="display:flex;gap:8px;">
        <button onclick="window.__pmShowGroupCreate()" class="pm-btn-group">👥 新建群聊</button>
        <button onclick="window.__pmShowAddContact()" class="pm-btn-add">＋ 添加联系人</button>
    </div>
    </div>`);
    };

    window.__pmShowAddContact = () => {
        document.getElementById('pm-overlay')?.remove();
        makeOverlay(`
<div class="pm-modal">
  <div class="pm-modal-header"><b>添加联系人</b><span onclick="window.__pmShowList()" class="pm-modal-close">✕</span></div>
  <div style="padding:14px 16px;">
    <div class="pm-cfg-label" style="margin-bottom:8px;">输入角色名</div>
    <input id="pm-add-contact-input" class="pm-cfg-input" placeholder="角色名">
  </div>
  <div class="pm-modal-add">
    <button onclick="(()=>{const v=document.getElementById('pm-add-contact-input').value.trim();if(v)window.__pmSwitchContact(v);})()" style="flex:1;background:#007aff;color:#fff;border:none;border-radius:10px;padding:10px;font-size:13px;cursor:pointer;font-weight:600;">开始聊天</button>
  </div>
</div>`);
        setTimeout(() => {
            const input = document.getElementById('pm-add-contact-input');
            input?.focus();
            input?.addEventListener('keydown', e => {
                if (e.key === 'Enter') { const v = input.value.trim(); if (v) window.__pmSwitchContact(v); }
            });
        }, 0);
    };

    // AI 自动生成联系人 — 确认弹窗
    window.__pmConfirmAutoGen = () => {
        const id = getStorageId();
        const histories = window.__pmHistories[id] || {};
        const groups = window.__pmGroupMeta[id] || {};
        const singleCount = Object.keys(histories).filter(k => !k.startsWith('__group_')).length;
        const groupCount = Object.keys(groups).length;
        const total = singleCount + groupCount;
        const MAX_TOTAL = 10;

        if (total >= MAX_TOTAL) {
            alert(`已有 ${total} 个联系人/群聊，已达上限（${MAX_TOTAL}），无法继续生成。`);
            return;
        }

        const canAdd = MAX_TOTAL - total;
        const willAdd = Math.min(canAdd, 10); // 实际生成数由 AI 在 3~min(canAdd,10) 范围内决定
        if (!confirm(`AI 将根据当前剧情信息自动生成联系人和群聊（最多 ${willAdd} 个），直接写入列表，是否继续？`)) return;
        window.__pmAutoGenContacts();
    };

    // AI 自动生成联系人 — 核心逻辑
    window.__pmAutoGenContacts = async () => {
        const id = getStorageId();
        const histories = window.__pmHistories[id] || {};
        const groups = window.__pmGroupMeta[id] || {};
        const existingSingle = Object.keys(histories).filter(k => !k.startsWith('__group_'));
        const existingGroups = Object.keys(groups).map(k => groups[k].name);
        const total = existingSingle.length + existingGroups.length;
        const MAX_TOTAL = 10;
        const canAdd = MAX_TOTAL - total;
        if (canAdd <= 0) return;
        const maxNew = Math.min(canAdd, 10);

        // 旋转刷新图标：对 SVG 元素做旋转，transform-origin:center 在 SVG 上完全精准
        const setSpinning = (on) => {
            const icon = document.getElementById('pm-autogen-icon');
            const btn  = document.getElementById('pm-autogen-btn');
            if (icon) icon.style.animation = on ? 'pm-spin 0.8s linear infinite' : '';
            if (btn)  btn.style.pointerEvents = on ? 'none' : '';
        };
        setSpinning(true);

        try {
            // 收集上下文（与 fetchSMS 读取的来源完全一致）
            const ctxData = await gatherContext();
            const { cardDesc, cardPersonality, cardScenario, mainChatText, worldBookText, userName, userDesc } = ctxData;

            const existingList = [
                ...existingSingle,
                ...Object.keys(groups).map(k => groups[k].name)
            ];
            const existingStr = existingList.length ? `已有联系人/群聊（跳过同名）：${existingList.join('、')}` : '目前暂无联系人。';

            const systemPrompt = `你是一个角色扮演辅助工具，负责根据当前剧情背景自动生成符合世界观的联系人列表。
输出必须严格为 JSON，格式如下（不得有任何注释或 markdown）：
{
  "contacts": ["角色名A", "角色名B"],
  "groups": [
    {"name": "群聊名称", "members": ["成员1", "成员2", "成员3"]},
    ...
  ]
}
要求：
1. contacts 是单个联系人，groups 是群聊（每个群 2~15 个成员）
2. 生成总数（contacts.length + groups.length）在 3 到 ${maxNew} 之间
3. 所有角色名必须与当前剧情世界观、人设背景高度相关
4. 绝不生成与 ${existingStr} 同名的联系人或群聊
5. 不生成用户自己（${userName}）作为联系人，群聊成员里也不得包含 ${userName}
6. 只输出 JSON，不输出任何其他内容`;

            const userPrompt = [
                `【用户信息】\n用户名：${userName}${userDesc ? '\n' + userDesc : ''}`,
                cardDesc ? `【角色/世界设定】\n${cardDesc}` : '',
                cardPersonality ? `【性格】\n${cardPersonality}` : '',
                cardScenario ? `【场景】\n${cardScenario}` : '',
                worldBookText ? `【世界书】\n${worldBookText}` : '',
                mainChatText ? `【主线最近对话】\n${mainChatText}` : '',
                existingStr,
                `请生成 3~${maxNew} 个符合以上背景的联系人和/或群聊，以 JSON 输出。`
            ].filter(Boolean).join('\n\n');

            const raw = await callAI(systemPrompt, userPrompt, { maxTokens: 600 });

            // 解析 JSON（兼容 AI 带 markdown 代码块的情况）
            const cleaned = raw.replace(/```json|```/gi, '').trim();
            let parsed;
            try { parsed = JSON.parse(cleaned); } catch (e) {
                throw new Error(`AI 返回格式无法解析：${cleaned.slice(0, 100)}`);
            }

            const newContacts = Array.isArray(parsed.contacts) ? parsed.contacts : [];
            const newGroups = Array.isArray(parsed.groups) ? parsed.groups : [];

            // 写入联系人（去重、去同名）
            if (!window.__pmHistories[id]) window.__pmHistories[id] = {};
            let added = 0;
            for (const name of newContacts) {
                if (typeof name !== 'string' || !name.trim()) continue;
                const n = name.trim();
                // 同名跳过（不区分大小写）
                const alreadyExists = existingList.some(e => e.toLowerCase() === n.toLowerCase())
                    || Object.keys(window.__pmHistories[id]).some(k => !k.startsWith('__group_') && k.toLowerCase() === n.toLowerCase());
                if (alreadyExists) continue;
                if (!window.__pmHistories[id][n]) window.__pmHistories[id][n] = [];
                added++;
            }
            saveHistories();

            // 写入群聊
            if (!window.__pmGroupMeta[id]) window.__pmGroupMeta[id] = {};
            for (const g of newGroups) {
                if (!g?.name || !Array.isArray(g.members) || g.members.length < 2) continue;
                const gName = g.name.trim();
                // 同名群跳过
                const alreadyExists = Object.values(window.__pmGroupMeta[id]).some(m => m.name.toLowerCase() === gName.toLowerCase());
                if (alreadyExists) continue;
                const members = g.members.map(m => m.trim()).filter(m => m && m.toLowerCase() !== userName.toLowerCase()).slice(0, 15);
                const groupKey = `__group_${Date.now()}_${Math.random().toString(36).slice(2,6)}`;
                window.__pmGroupMeta[id][groupKey] = { name: gName, members };
                added++;
            }
            saveGroupMeta();

            // 刷新列表
            window.__pmShowList();
            // 简短提示
            setTimeout(() => addNote(`✨ 已自动添加 ${added} 个联系人/群聊`), 200);
        } catch (e) {
            console.error('[phone-mode] __pmAutoGenContacts 异常', e);
            alert(`自动生成失败：${e?.message || e}`);
        } finally {
            setSpinning(false);
        }
    };

    window.__pmDelGroup = async (key) => {
        const id = getStorageId();
        if (window.__pmGroupMeta[id]) delete window.__pmGroupMeta[id][key];
        if (window.__pmHistories[id]) delete window.__pmHistories[id][key];

        const arr = window.__pmBidirectional[id] || [], idx = arr.indexOf(key);
        if (idx >= 0) { arr.splice(idx, 1); window.__pmBidirectional[id] = arr; saveBidirectional(); }

        const bgKey = `${id}_${key}`;
        if (window.__pmBgLocal[bgKey]) {
            delete window.__pmBgLocal[bgKey];
            await pmIDBDel('ST_SMS_BG_LOCAL_' + bgKey);
            await saveBgLocal();
        }

        if (window.__pmPokeConfig[id]?.[key]) {
            delete window.__pmPokeConfig[id][key];
            savePokeConfig();
        }

        // 修复：await 确保 IDB 写入完成，防止冷启动时 IDB 旧数据覆盖删除操作
        await pmIDBSet('ST_SMS_DATA_V2', window.__pmHistories).catch(() => {});
        try { localStorage.setItem('ST_SMS_DATA_V2', JSON.stringify(window.__pmHistories)); } catch (e) {};
        saveGroupMeta();
        applyBidirectionalInjection();
        // 修复：删除当前会话后清空全局状态，防止后续切换时落盘把已删记录写入新目标
        if (currentGroupKey === key) { isGroupChat = false; currentGroupKey = ''; currentPersona = ''; conversationHistory = []; groupMembers = []; groupDisplayName = ''; groupColorMap = {}; }
        window.__pmShowList();
    };

    window.__pmSwitchContact = (key) => {
        if (!key?.trim()) return; key = key.trim();
        loadGroupMeta();
        const id = getStorageId();
        // 修复：如果上下文尚未就绪导致 ID 为 unknown，给出警告，避免存入错误 key
        if (id === 'sms_unknown__default') {
            console.warn('[phone-mode] __pmSwitchContact: SillyTavern 上下文尚未就绪，storageId 为 unknown，跳过切换');
            return;
        }
        const groupMeta = window.__pmGroupMeta[id]?.[key];
        // 修复：在修改全局状态前快照旧 saveKey，防止落盘时把当前会话记录写入目标会话
        const _prevSaveKey = isGroupChat && currentGroupKey ? currentGroupKey : currentPersona;
        if (groupMeta) {
            isGroupChat = true; currentGroupKey = key;
            groupMembers = groupMeta.members.slice();
            groupDisplayName = groupMeta.name;
            groupColorMap = {};
            groupMembers.forEach((n, i) => { groupColorMap[n] = GROUP_COLORS[i % GROUP_COLORS.length]; });
        } else {
            isGroupChat = false; groupMembers = []; groupColorMap = {}; groupDisplayName = ''; currentGroupKey = '';
        }
        window.__pmSwitch(key, _prevSaveKey);
    };

    // 从 conversationHistory 全量重绘消息列表（供切换联系人 / 切换头像开关时复用）
    function renderHistoryMessages() {
        const list = phoneWindow?.querySelector('.pm-msg-list'); if (!list) return;
        list.innerHTML = '';
        if (conversationHistory.length > 0) {
            addNote(`历史记录`);
            conversationHistory.forEach((m, hi) => {
                if (isGroupChat && m.role === 'assistant') {
                    const lines = m.content.split('\n');
                    for (const line of lines) {
                        const match = line.match(/^(.{1,20})[：:]\s*(.+)$/);
                        if (match && groupMembers.some(gm => gm.toLowerCase() === match[1].trim().toLowerCase())) {
                            const sender = groupMembers.find(gm => gm.toLowerCase() === match[1].trim().toLowerCase());
                            splitToSentences(match[2]).forEach(s => addBubble(s, 'left', sender, hi));
                        } else {
                            splitToSentences(line).forEach(s => addBubble(s, 'left', undefined, hi));
                        }
                    }
                } else {
                    splitToSentences(m.content).forEach(s => addBubble(s, m.role === 'user' ? 'right' : 'left', undefined, hi));
                }
            });
            addNote('── 以上为历史 ──');
        } else addNote(`开始对话`);
        applyBackground();
        const _list = phoneWindow?.querySelector('.pm-msg-list');
        if (_list) pmImgLoad().then(() => pmImgRestoreChatSync(_list));
    }

    window.__pmSwitch = (name, _prevSaveKey) => {
        if (!name?.trim()) return; name = name.trim();
        document.getElementById('pm-overlay')?.remove();
        const id = getStorageId();
        // 切换前先把当前联系人的最新 conversationHistory 落盘，
        // 修复：调用方（__pmConfirmGroup）可能在调用本函数前已修改了 isGroupChat/currentGroupKey，
        // 导致落盘时 saveKey 错误地指向新目标，把旧聊天记录写入新会话。优先使用调用方传入的 _prevSaveKey。
        if (currentPersona && conversationHistory.length > 0) {
            if (!window.__pmHistories[id]) window.__pmHistories[id] = {};
            const saveKey = _prevSaveKey || (isGroupChat && currentGroupKey ? currentGroupKey : currentPersona);
            window.__pmHistories[id][saveKey] = conversationHistory.slice(-SAVE_LIMIT);
            saveHistories();
        }
        currentPersona = name;
        conversationHistory = window.__pmHistories[id]?.[name] ?? [];
        if (phoneWindow) {
            const nameEl = phoneWindow.querySelector('.pm-name');
            const editBtn = phoneWindow.querySelector('.pm-name-edit');
            if (nameEl) {
                if (isGroupChat) {
                    const display = groupDisplayName || name;
                    const arr = [...display];
                    nameEl.textContent = arr.length > 5 ? arr.slice(0, 5).join('') + '...' : display;
                } else {
                    // 备注只影响 UI 渲染：有备注显示备注，没有则显示原名
                    const remark = getRemark(name);
                    nameEl.textContent = remark || name;
                }
            }
            if (editBtn) {
                editBtn.classList.remove('is-hidden');  // 个人和群聊都显示编辑按钮
            }
            fitNameFont();
            renderHistoryMessages();
        }
        applyBidirectionalInjection();
    };

    window.__pmDel = async (name) => {
        const id = getStorageId();
        if (window.__pmHistories[id]) delete window.__pmHistories[id][name];
        // 修复：await 确保 IDB 写入完成，防止冷启动时 IDB 旧数据覆盖删除操作
        await pmIDBSet('ST_SMS_DATA_V2', window.__pmHistories).catch(() => {});
        try { localStorage.setItem('ST_SMS_DATA_V2', JSON.stringify(window.__pmHistories)); } catch (e) {};

        const arr = window.__pmBidirectional[id] || [], idx = arr.indexOf(name);
        if (idx >= 0) { arr.splice(idx, 1); window.__pmBidirectional[id] = arr; saveBidirectional(); }

        const bgKey = `${id}_${name}`;
        if (window.__pmBgLocal[bgKey]) {
            delete window.__pmBgLocal[bgKey];
            await pmIDBDel('ST_SMS_BG_LOCAL_' + bgKey);
            await saveBgLocal();
        }

        if (window.__pmPokeConfig[id]?.[name]) {
            delete window.__pmPokeConfig[id][name];
            savePokeConfig();
        }

        applyBidirectionalInjection();
        // 修复：删除当前联系人后清空全局状态，防止后续切换时落盘把已删记录写入新目标
        if (!isGroupChat && currentPersona === name) { currentPersona = ''; conversationHistory = []; }
        window.__pmShowList();
    };

    window.__pmToggleSelect = () => {
        isSelectMode = !isSelectMode;
        const list = phoneWindow?.querySelector('.pm-msg-list');
        const trashBtn = phoneWindow?.querySelector('.pm-trash-btn');
        const confirmBar = phoneWindow?.querySelector('.pm-confirm-bar');
        if (!list) return;
        if (isSelectMode) {
            trashBtn.style.color = '#ff3b30'; confirmBar.style.display = 'flex';
            // 气泡上已在渲染时打好 data-history-index，直接读取，无需事后映射
            list.querySelectorAll('.pm-bubble, .pm-group-bubble-wrap, .pm-director')
                .forEach(b => {
                if (b.id === 'pm-typing' || b.closest('.pm-select-wrap')) return;
                const isDirector = b.classList.contains('pm-director');
                const wrap = document.createElement('div'); wrap.className = 'pm-select-wrap';
                const side = isDirector ? 'center' : (b.dataset.side || 'left');
                wrap.style.cssText = 'display:flex;align-items:center;gap:8px;align-self:' + (side === 'right' ? 'flex-end' : side === 'center' ? 'center' : 'flex-start') + ';';
                const cb = document.createElement('div'); cb.className = 'pm-custom-check'; cb.dataset.checked = '0';
                cb.style.cssText = 'width:22px;height:22px;min-width:22px;min-height:22px;border-radius:50%;flex-shrink:0;cursor:pointer;';
                cb.onclick = () => { cb.dataset.checked = cb.dataset.checked === '0' ? '1' : '0'; };
                b.parentNode.insertBefore(wrap, b);
                wrap.appendChild(cb); wrap.appendChild(b);
                wrap.dataset.side = side; wrap.dataset.text = b.dataset.text || '';
                // 直接从气泡上读下标，渲染时已打好
                const hi = b.dataset.historyIndex;
                if (hi !== undefined && hi !== '') wrap.dataset.historyIndex = hi;
            });
        } else {
            trashBtn.style.color = ''; confirmBar.style.display = 'none';
            list.querySelectorAll('.pm-select-wrap').forEach(wrap => {
                const b = wrap.querySelector('.pm-bubble, .pm-group-bubble-wrap, .pm-director');
                if (b) wrap.parentNode.insertBefore(b, wrap); wrap.remove();
            });
        }
    };

    window.__pmDeleteSelected = () => {
        const list = phoneWindow?.querySelector('.pm-msg-list'); if (!list) return;
        // 按 data-history-index 收集要删除的下标（精确，不依赖文本匹配）
        const toRemoveIndices = new Set();
        list.querySelectorAll('.pm-select-wrap').forEach(wrap => {
            const cb = wrap.querySelector('.pm-custom-check');
            if (cb?.dataset.checked === '1') {
                const hi = wrap.dataset.historyIndex;
                if (hi !== undefined && hi !== '') toRemoveIndices.add(Number(hi));
                wrap.remove();
            } else {
                const b = wrap.querySelector('.pm-bubble, .pm-group-bubble-wrap, .pm-director');
                if (b) wrap.parentNode.insertBefore(b, wrap);
                wrap.remove();
            }
        });
        if (toRemoveIndices.size > 0) {
            conversationHistory = conversationHistory.filter((_, i) => !toRemoveIndices.has(i));
            const id = getStorageId();
            if (!window.__pmHistories[id]) window.__pmHistories[id] = {};
            const saveKey = isGroupChat && currentGroupKey ? currentGroupKey : currentPersona;
            window.__pmHistories[id][saveKey] = conversationHistory.slice(-SAVE_LIMIT);
            saveHistories();
            applyBidirectionalInjection();
        }
        isSelectMode = false;
        phoneWindow?.querySelector('.pm-trash-btn')?.style.removeProperty('color');
        const bar = phoneWindow?.querySelector('.pm-confirm-bar'); if (bar) bar.style.display = 'none';
    };

    window.__pmToggleMin = () => { isMinimized = !isMinimized; phoneWindow.classList.toggle('is-min', isMinimized); phoneWindow.style.removeProperty('transform'); };
    window.__pmEnd = () => {
        // 修复：关闭前先把当前 conversationHistory 存档
        // 避免"AI 已回复但叉掉插件导致最新消息丢失"的问题
        if (currentPersona && conversationHistory.length) {
            const id = getStorageId();
            if (!window.__pmHistories[id]) window.__pmHistories[id] = {};
            // 修复：群聊时应使用 currentGroupKey 而非 currentPersona 作为存档 key
            const saveKey = isGroupChat && currentGroupKey ? currentGroupKey : currentPersona;
            window.__pmHistories[id][saveKey] = conversationHistory.slice(-SAVE_LIMIT);
            saveHistories();
        }
        if (phoneWindow) { try { phoneWindow.hidePopover?.(); } catch (e) {} phoneWindow.remove(); }
        phoneWindow = null; phoneActive = false; isMinimized = false; isSelectMode = false;
        isGroupChat = false; groupMembers = []; groupColorMap = {}; groupDisplayName = ''; currentGroupKey = '';
        // 修复：关闭时重置冷启动标记，确保下次打开时（尤其是切换角色卡后）重新从 IDB 加载最新数据
        __pmFirstOpen = true;
        // 修复：关闭时清除可见性定时器，重新开启时再创建新的
        if (__pmVisibilityTimer) { clearInterval(__pmVisibilityTimer); __pmVisibilityTimer = null; }
    };

    function ensureVisibility() {
        if (!phoneWindow) return;
        const cs = getComputedStyle(phoneWindow);
        if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity || '1') < 0.1) {
            phoneWindow.style.setProperty('display', 'flex', 'important');
            phoneWindow.style.setProperty('visibility', 'visible', 'important');
            phoneWindow.style.setProperty('opacity', '1', 'important');
        }
    }
    // 修复：保存定时器 ID，在 __pmEnd 时清除，避免永久泄漏
    let __pmVisibilityTimer = setInterval(ensureVisibility, 2000);

    window.__pmOpen = () => {
        if (phoneActive && phoneWindow) { try { phoneWindow.showPopover?.(); } catch (e) {} phoneWindow.style.display = 'flex'; ensureVisibility(); return; }
        // 修复：删除每次打开都用 localStorage 覆盖内存的逻辑
        // localStorage 因容量限制可能保存的是旧数据，而内存和 IDB 才是最新的
        // 冷启动时（内存为空）靠 loadHistoriesFromIDB() 从 IDB 加载后再渲染
        if (!__pmVisibilityTimer) { __pmVisibilityTimer = setInterval(ensureVisibility, 2000); }
        try {
            const saved = JSON.parse(localStorage.getItem('ST_SMS_CONFIG'));
            window.__pmConfig = saved || { apiUrl: '', apiKey: '', model: '', useIndependent: false };
            if (typeof window.__pmConfig.useIndependent === 'undefined') window.__pmConfig.useIndependent = !!(window.__pmConfig.apiUrl && window.__pmConfig.apiKey);
        } catch (e) { window.__pmConfig = { apiUrl: '', apiKey: '', model: '', useIndependent: false }; }
        loadProfiles(); loadBidirectional(); loadTheme(); loadGroupMeta(); loadPokeConfig(); loadWordyLimit(); migrateOldHistory(); loadEmojis(); loadAvatarData(); loadWeiboData(); loadNpcAvatars(); loadMemoData();
        __pmWeiboAcct = 'main';
        loadBgSettings().then(() => { try { applyBackground(); } catch (e) {} });
        hookGenerationEvent();
        const c = getCtx(), defaultChar = c?.characters?.[c.characterId]?.name ?? 'AI';

        phoneWindow = document.createElement('div'); phoneWindow.id = 'pm-iphone';
        phoneWindow.dataset.layout = window.__pmTheme.layout || 'standard';
        phoneWindow.setAttribute('data-theme', window.__pmTheme.darkMode || 'light');
        if (POPOVER_SUPPORTED) phoneWindow.setAttribute('popover', 'manual');

        const editSvg = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`;

        phoneWindow.innerHTML = `
<div class="pm-island"></div>
<div class="pm-main-ui">
  <div class="pm-navbar">
    <div class="pm-nav-left">
      <button onclick="window.__pmShowList()" class="pm-nav-btn">☰</button>
      <button onclick="window.__pmShowWeibo()" class="pm-nav-btn" title="微博">🌐</button>
      ${c?.groupId ? '' : '<button onclick="window.__pmShowMemo()" class="pm-nav-btn" title="备忘录">📖</button>'}
    </div>
    <div class="pm-name-wrap">
      <div class="pm-name">${escapeHtml(defaultChar)}</div>
      <button onclick="window.__pmEditGroup()" class="pm-name-edit is-hidden" title="编辑">${editSvg}</button>
    </div>
    <div class="pm-nav-right">
      <button onclick="window.__pmToggleSelect()" class="pm-nav-btn pm-trash-btn">🗑</button>
      <button onclick="window.__pmShowConfig()" class="pm-nav-btn">⚙</button>
      <button onclick="window.__pmEnd()" class="pm-nav-btn" style="color:#ff3b30">✕</button>
    </div>
  </div>
  <div class="pm-confirm-bar" style="display:none;">
    <span class="pm-confirm-tip">选择要删除的消息</span>
    <button onclick="window.__pmDeleteSelected()" class="pm-confirm-btn">删除所选</button>
    <button onclick="window.__pmToggleSelect()" class="pm-cancel-btn">取消</button>
  </div>
  <div class="pm-msg-list"></div>
  <div class="pm-input-bar">
    <button onclick="window.__pmShowExpandInput()" class="pm-expand-btn" title="展开长文本输入">⤢</button>
    <input class="pm-input" placeholder="iMessage">
    <button onclick="window.__pmSend()" class="pm-up-btn">↑</button>
  </div>
</div>`;
        document.body.appendChild(phoneWindow);
        if (phoneWindow.showPopover) try { phoneWindow.showPopover(); } catch (e) {}
        phoneActive = true;
        phoneWindow.querySelector('.pm-input').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); window.__pmSend(); } });
        bindIsland(phoneWindow, phoneWindow.querySelector('.pm-island'));
        applyTheme(); isGroupChat = false; groupMembers = []; groupColorMap = {}; groupDisplayName = ''; currentGroupKey = '';


        if (!__pmFirstOpen) {
            // 热启动：信任内存历史直接渲染，但表情包/头像数据可能因为插件重载而清空，需确保已加载
            const doRender = () => { window.__pmSwitch(defaultChar); applyBidirectionalInjection(); ensureVisibility(); };
            const needEmoji = window.__pmEmojis.length === 0;
            const needAvatar = !__pmAvatarLoaded;
            const needWeibo = !__pmWeiboLoaded;
            const needNpcAv = !__pmNpcAvLoaded;
            if (!needEmoji && !needAvatar && !needWeibo && !needNpcAv) {
                doRender();
            } else {
                Promise.all([
                    needEmoji ? loadEmojis() : Promise.resolve(),
                    needAvatar ? loadAvatarData() : Promise.resolve(),
                    needWeibo ? loadWeiboData() : Promise.resolve(),
                    needNpcAv ? loadNpcAvatars() : Promise.resolve(),
                ]).then(doRender);
            }
        } else {
            // ❄️ 冷启动：第一次打开，先占位，等外部的 IDB 把最新数据拉进内存再渲染
            __pmFirstOpen = false; // 翻转标记，此后不刷新就不会再走这里
            const list = phoneWindow?.querySelector('.pm-msg-list');
            if (list) { list.innerHTML = '<div style="text-align:center;color:#aaa;padding:20px;font-size:13px;">正在加载历史记录…</div>'; }
            
            // 冷启动：表情包/头像数据和历史记录都需要从 IDB 加载完才能正确渲染
            // 否则 [emo:...] 会因为 __pmEmojis 为空而显示占位符
            Promise.all([loadHistoriesFromIDB(), loadEmojis(), loadAvatarData(), loadWeiboData(), loadNpcAvatars()]).then(() => {
                if (!phoneWindow) return;
                window.__pmSwitch(defaultChar);
                applyBidirectionalInjection(); ensureVisibility();
            });
        }
    };
    

    // ══════════════════════ 微博模块 ══════════════════════
    // 数据分桶：[会话id][大号/小号]，大号=main 小号=alt，两个账号的身份/博文/粉丝池完全独立
    window.__pmWeiboPosts = window.__pmWeiboPosts || {};
    window.__pmWeiboIdentity = window.__pmWeiboIdentity || {};
    const PM_WB_MAX_POSTS = 30;      // 每桶最多 30 条，超出 FIFO 丢最旧
    const PM_WB_CTX_POSTS = 10;      // 喂给 AI 的自己最近博文数
    const PM_WB_CTX_COMMENTS = 3;    // 喂给 AI 的带评论区的博文数
    let __pmWeiboLoaded = false;
    let __pmWeiboAcct = 'main';      // 当前账号，切换时不落盘（每次打开默认回大号）
    let __pmWeiboBusy = false;

    async function loadWeiboData() {
        try {
            const [p, i] = await Promise.all([pmIDBGet('ST_SMS_WEIBO_POSTS'), pmIDBGet('ST_SMS_WEIBO_IDENTITY')]);
            window.__pmWeiboPosts = (p && typeof p === 'object') ? p : {};
            window.__pmWeiboIdentity = (i && typeof i === 'object') ? i : {};
        } catch (e) { window.__pmWeiboPosts = {}; window.__pmWeiboIdentity = {}; }
        __pmWeiboLoaded = true;
    }
    async function saveWeiboPosts() { await pmIDBSet('ST_SMS_WEIBO_POSTS', window.__pmWeiboPosts).catch(() => {}); }
    async function saveWeiboIdentity() { await pmIDBSet('ST_SMS_WEIBO_IDENTITY', window.__pmWeiboIdentity).catch(() => {}); }

    // ===== 手机备忘录 =====
    // 和微博一样按 getStorageId() 分桶（跟聊天走，不跟角色卡走）。群聊没有备忘录。
    const PM_MEMO_MAX = 30;          // 备忘 + 日记 合计上限
    let __pmMemoLoaded = false;
    let __pmMemoBusy = false;

    async function loadMemoData() {
        try {
            const m = await pmIDBGet('ST_SMS_MEMOS');
            window.__pmMemos = (m && typeof m === 'object') ? m : {};
        } catch (e) { window.__pmMemos = {}; }
        __pmMemoLoaded = true;
    }
    async function saveMemos() { await pmIDBSet('ST_SMS_MEMOS', window.__pmMemos).catch(() => {}); }

    function pmMemoList(create) {
        const id = getStorageId();
        if (!window.__pmMemos) window.__pmMemos = {};
        if (!Array.isArray(window.__pmMemos[id])) {
            if (!create) return [];
            window.__pmMemos[id] = [];
        }
        return window.__pmMemos[id];
    }

    // 满 30 篇就悄悄删（不提示用户）：优先删最老的备忘，备忘删完了才动日记。
    function pmMemoEvict(list, need) {
        while (list.length + need > PM_MEMO_MAX) {
            let idx = list.findIndex(x => x.type !== 'diary');
            if (idx === -1) idx = 0;              // 只剩日记了，删最老的日记
            list.splice(idx, 1);
        }
        return list;
    }

    function pmNormalizeMemo(o, type) {
        const cap = type === 'diary' ? 800 : 250;
        const text = String(o && o.text != null ? o.text : '').trim().slice(0, cap);
        let title = String(o && o.title != null ? o.title : '').trim().slice(0, 20);
        if (!title) title = text.split('\n')[0].slice(0, 20) || (type === 'diary' ? '日记' : '备忘');
        // when 由 AI 自己写（三条备忘不该是同一分钟）。存原样字符串，只做长度兜底
        const when = String(o && o.when != null ? o.when : '').trim().slice(0, 24);
        return { id: wbUid(), type: type === 'diary' ? 'diary' : 'memo', title, text, when, createdAt: Date.now() };
    }
    // 备忘录不能复用 wbSystemPrompt()：那份规则 8 要求「一切内容都要短」，
    // 会把 300/800 字的篇幅要求直接抵消掉。
    function pmMemoSystemPrompt(type) {
        const isDiary = type === 'diary';
        return `你现在扮演一个角色，正在用手机写${isDiary ? '日记' : '备忘录'}。只输出 JSON，不加任何解释或 markdown 围栏。

【认知边界——非常重要】
只提及角色设定里出现的人物和事物。如果设定里没有提到某人，不要凭空捏造姓名或关系。可以用"那个人""他""她"指代，或留空白。

【日期时间】
你需要自己填写合理的写作时间（when 字段），根据剧情推断是哪天。${isDiary ? '日记通常在睡前或一天结束后写。' : '三条备忘的时间要分散，体现是不同日期想起来记的。'}格式固定为 YYYY/M/D，例如 2024/3/7。不要写时间，不要写星期，只写日期。

这是私人记录，完全自由，不用工整：
${isDiary ? `— 流水账、骂人、打油诗、顺口溜都行
— 可混用多种语言（角色会的话）
— 酒后/梦醒/崩溃时写的，语句断裂没关系
— 夹一张翻到的老照片、一首临时起意的歌词
— 600 到 800 字，内容具体，不要泛泛的「感觉很累」` : `— 取餐码、密码、门牌、快递单号
— 清单：买的、要还的、想买的
— 对某人的碎碎念、没发出去的话
— 读后感、歌词片段、突然想到的问题
— 自己懂的暗语或缩写
— 三条内容各自独立，每条 50 到 250 字`}

可用格式（会被真实渲染）：
  # 大标题    → 醒目大字（备忘标题/日记开头大字）
  ## 副标题   → 稍小加粗
  **粗体**    → 强调重要信息
  *斜体*      → 心理活动、旁白口吻
  ~~划掉~~    → 反悔、自我否定、改了主意
  __下划线__  → 提醒自己别忘
  |||涂黑|||  → 不想被人看到的秘密（点击可揭开）
  - 无序列表  → 清单、随手罗列
  1. 有序列表 → 步骤、优先级
  > 引用块    → 想到的一句话、他人说的话

语气和措辞贴合角色本人，不要写成通用心情模板。篇幅自己控制在上限内。`;
    }

    function pmMemoSchema(type) {
        if (type === 'diary') {
            return `只输出这一个 JSON 对象：
{"title":"标题，10字以内","when":"日期，格式YYYY/M/D，如2024/3/7","text":"正文600-800字，换行用\\n，可用# ## **粗** *斜* ~~划掉~~ __下划线__ |||涂黑||| - 列表 1.有序 > 引用"}`;
        }
        return `只输出这一个 JSON 对象：
{"memos":[{"title":"10字以内","when":"YYYY/M/D，三条日期要不同","text":"50-250字，换行用\\n，可用# ## **粗** *斜* ~~划掉~~ __下划线__ |||涂黑||| - 列表 > 引用"},{"title":"…","when":"…","text":"…"},{"title":"…","when":"…","text":"…"}]}`;
    }

    function pmInlineFmt(s) {
        return s
            .replace(/~~(.+?)~~/g, '<s>$1</s>')
            .replace(/__(.+?)__/g, '<u>$1</u>')
            .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
            .replace(/\*(.+?)\*/g, '<em>$1</em>')
            .replace(/\|\|\|(.+?)\|\|\|/g, '<span class="pm-memo-redact" onclick="this.classList.toggle(\'pm-memo-redact-open\')">$1</span>');
    }
    function pmStripLeadTitle(raw, title) {
        const lines = String(raw || '').split('\n');
        let i = 0;
        while (i < lines.length && !lines[i].trim()) i++;
        if (i >= lines.length) return raw;
        const m = lines[i].trim().match(/^#(?!#)\s*(.*)$/);
        if (!m) return raw;
        const norm = s => String(s || '').replace(/[\s*_~`|#]/g, '');
        if (norm(m[1]) && norm(title) && !norm(m[1]).includes(norm(title)) && !norm(title).includes(norm(m[1]))) return raw;
        lines.splice(0, i + 1);
        while (lines.length && !lines[0].trim()) lines.shift();
        return lines.join('\n');
    }
    function pmRenderMemoText(raw) {
        const lines = String(raw || '').split('\n');
        const out = [];
        let inOl = false, inUl = false;
        const closeList = () => {
            if (inOl) { out.push('</ol>'); inOl = false; }
            if (inUl) { out.push('</ul>'); inUl = false; }
        };
        for (const line of lines) {
            const t = line.trim();
            if (!t) { closeList(); out.push('<div class="pm-memo-gap"></div>'); continue; }
            if (/^# (.+)/.test(t)) { closeList(); out.push(`<div class="pm-memo-h1">${pmInlineFmt(escapeHtml(t.slice(2).trim()))}</div>`); continue; }
            if (/^## (.+)/.test(t)) { closeList(); out.push(`<div class="pm-memo-h2">${pmInlineFmt(escapeHtml(t.slice(3).trim()))}</div>`); continue; }
            if (/^> (.+)/.test(t)) { closeList(); out.push(`<blockquote class="pm-memo-bq">${pmInlineFmt(escapeHtml(t.slice(2).trim()))}</blockquote>`); continue; }
            const olM = t.match(/^\d+\. (.+)/);
            if (olM) { if (!inOl) { closeList(); out.push('<ol class="pm-memo-ol">'); inOl = true; } out.push(`<li>${pmInlineFmt(escapeHtml(olM[1]))}</li>`); continue; }
            const ulM = t.match(/^[-•] (.+)/);
            if (ulM) { if (!inUl) { closeList(); out.push('<ul class="pm-memo-ul">'); inUl = true; } out.push(`<li>${pmInlineFmt(escapeHtml(ulM[1]))}</li>`); continue; }
            closeList();
            out.push(`<p class="pm-memo-p">${pmInlineFmt(escapeHtml(t))}</p>`);
        }
        closeList();
        return out.join('') || `<p class="pm-memo-p">${pmInlineFmt(escapeHtml(raw || ''))}</p>`;
    }

    async function pmGenerateMemos(type) {
        const isDiary = type === 'diary';
        const ctx = await gatherContext();
        const charName = wbCharName();
        const list = pmMemoList(false);
        const recent = list.slice(-6).map(m => `[${m.type === 'diary' ? '日记' : '备忘'}][${m.when || '日期未知'}]${m.title}：${(m.text || '').slice(0, 60)}`).join('\n') || '（无）';
        const lastWhen = list.length ? (list[list.length - 1].when || '') : '';
        const userPrompt = `【你扮演的角色】${charName}
${ctx.cardDesc}
${ctx.cardPersonality}
${ctx.cardScenario}

【世界书】
${ctx.worldBookText || '（无）'}

【最近发生的事（主线对话）】
${ctx.mainChatText || '（无）'}

【${ctx.userName}】${ctx.userDesc || '（无设定）'}

【你之前写过的（不要重复）】
${recent}

请以 ${charName} 本人的身份，结合上面的剧情，写${isDiary ? '一篇日记' : '三条备忘'}。${lastWhen ? `\n【日期参考】上一篇写于 ${lastWhen}，when 字段应在这个日期附近（前后数天内），不要跳跃到相差很远的日期。` : ''}
${pmMemoSchema(type)}`;
        const raw = await callAI(pmMemoSystemPrompt(type), userPrompt, { maxTokens: isDiary ? 1500 : 3200 });
        const o = wbParseJSON(raw);
        if (isDiary) {
            if (!o.text) throw new Error('AI 没有返回日记内容');
            return [pmNormalizeMemo(o, 'diary')];
        }
        const arr = Array.isArray(o.memos) ? o.memos : (o.text ? [o] : []);
        if (!arr.length) throw new Error('AI 没有返回任何备忘');
        return arr.slice(0, 3).map(x => pmNormalizeMemo(x, 'memo'));
    }
    // iOS 备忘录列表那行灰字：今天只给时间，今年给月日，往年才给年份
    function pmMemoDate(ts) {
        const d = new Date(ts || Date.now()), now = new Date();
        const p = n => String(n).padStart(2, '0');
        if (d.toDateString() === now.toDateString()) return `${p(d.getHours())}:${p(d.getMinutes())}`;
        if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日`;
        return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())}`;
    }
    // 列表里的一行预览：去掉换行，压掉连续空格
    function pmMemoPreview(t) {
        return String(t || '')
            .replace(/^#+\s*/mg, '').replace(/\|\|\|.+?\|\|\|/g, '…').replace(/[*_~`]+/g, '')
            .replace(/\s+/g, ' ').trim().slice(0, 50) || '无正文';
    }

    window.__pmShowMemo = () => {
        if (!__pmMemoLoaded) {
            loadMemoData().then(() => {
                if (document.querySelector('#pm-overlay .pm-memo-list')) window.__pmShowMemo();
            });
        }
        const list = pmMemoList(false).slice().reverse();
        // 按 createdAt 分组：今天 / 昨天 / 更早
        const now = new Date(), todayStr = now.toDateString();
        const yest = new Date(now); yest.setDate(yest.getDate() - 1); const yestStr = yest.toDateString();
        const groups = [
            { label: '今天', items: list.filter(m => new Date(m.createdAt).toDateString() === todayStr) },
            { label: '昨天', items: list.filter(m => new Date(m.createdAt).toDateString() === yestStr) },
            { label: '更早', items: list.filter(m => { const s = new Date(m.createdAt).toDateString(); return s !== todayStr && s !== yestStr; }) },
        ].filter(g => g.items.length);
        const renderCard = m => `
      <div class="pm-memo-card" role="button" tabindex="0" onclick="window.__pmMemoOpen('${safeJS(m.id)}')">
        <div class="pm-memo-card-title">${m.type === 'diary' ? '<span class="pm-memo-tag">日记</span>' : ''}${escapeHtml(m.title)}</div>
        <div class="pm-memo-card-sub"><span class="pm-memo-card-when">${escapeHtml(m.when || '')}</span>${m.when ? ' ' : ''}<span class="pm-memo-card-pre">${escapeHtml(pmMemoPreview(m.text))}</span></div>
        <span class="pm-memo-del" role="button" tabindex="0" onclick="event.stopPropagation();window.__pmMemoDel('${safeJS(m.id)}')">删除</span>
      </div>`;
        const body = list.length
            ? groups.map(g => `${g.items.map(renderCard).join('')}`).join('<div class="pm-memo-group-sep"></div>')
            : (!__pmMemoLoaded
                ? '<div class="wb-loading"><span class="wb-spin"></span></div>'
                : `<div class="wb-empty"><div class="wb-empty-ic">📖</div><div class="wb-empty-t">还没有备忘录</div><div class="wb-empty-s">让 TA 结合当前剧情<br>随手记点什么</div></div>`);
        makeOverlay(`
<div class="pm-modal pm-modal-wide pm-memo-modal">
  <div class="pm-memo-list-header">
    <div class="pm-memo-list-title">备忘录</div>
    <div style="display:flex;align-items:center;gap:10px;">
      <span class="pm-memo-count">${list.length}/${PM_MEMO_MAX}</span>
      <span onclick="document.getElementById('pm-overlay').remove()" class="pm-modal-close">✕</span>
    </div>
  </div>
  <div class="pm-modal-scroll pm-memo-list">${body}</div>
  <div class="pm-modal-add">
    <button id="pm-memo-gen-memo" class="wb-btn-main" style="flex:1;" onclick="window.__pmMemoGen('memo')">生成备忘录</button>
    <button id="pm-memo-gen-diary" class="wb-btn-sub" onclick="window.__pmMemoGen('diary')">生成日记</button>
  </div>
</div>`);
    };
    window.__pmMemoGen = async (type) => {
        if (__pmMemoBusy) return;
        __pmMemoBusy = true;
        const btn = document.getElementById(type === 'diary' ? 'pm-memo-gen-diary' : 'pm-memo-gen-memo');
        const old = btn ? btn.textContent : '';
        if (btn) { btn.textContent = '生成中…'; btn.disabled = true; }
        try {
            if (!__pmMemoLoaded) await loadMemoData();
            const made = await pmGenerateMemos(type);
            const list = pmMemoList(true);
            pmMemoEvict(list, made.length);
            list.push(...made);
            await saveMemos();
            window.__pmShowMemo();
            wbToast(type === 'diary' ? '日记写好了' : `记下了 ${made.length} 条`);
        } catch (e) {
            wbToast(e && e.message ? e.message : '生成失败');
            if (btn) { btn.textContent = old; btn.disabled = false; }
        } finally {
            __pmMemoBusy = false;
        }
    };

    window.__pmMemoDel = async (id) => {
        const list = pmMemoList(false);
        const at = list.findIndex(m => m.id === id);
        if (at < 0) return;
        list.splice(at, 1);
        await saveMemos();
        window.__pmShowMemo();
    };

    // 详情：叠在备忘录列表之上的子浮层，不销毁 #pm-overlay
    window.__pmMemoOpen = (id) => {
        const m = pmMemoList(false).find(x => x.id === id);
        if (!m) return;
        const ov = document.createElement('div'); ov.id = 'pm-overlay-sub';
        if (typeof HTMLElement !== 'undefined' && HTMLElement.prototype.hasOwnProperty('popover')) ov.setAttribute('popover', 'manual');
        ov.style.cssText = 'position:fixed !important; inset:0 !important; margin:0 !important; padding:0 !important; border:none !important; width:100vw !important; height:100vh !important; max-width:none !important; max-height:none !important; background:rgba(0,0,0,.45) !important; z-index:2147483648 !important; display:flex !important; align-items:center !important; justify-content:center !important;';
        ov.innerHTML = `
<div class="pm-modal pm-memo-modal">
  <div class="pm-modal-header">
    <b>${m.type === 'diary' ? '日记' : '备忘'}</b>
    <span onclick="document.getElementById('pm-overlay-sub')?.remove()" class="pm-modal-close">✕</span>
  </div>
  <div class="pm-modal-scroll" style="padding:18px 20px 24px;">
    <div class="pm-memo-d-t">${escapeHtml(m.title)}</div>
    <div class="pm-memo-d-d">${escapeHtml(m.when || pmMemoDate(m.createdAt))}</div>
    <div class="pm-memo-d-b">${pmRenderMemoText(pmStripLeadTitle(m.text, m.title))}</div>
  </div>
</div>`;
        document.body.appendChild(ov);
        if (ov.showPopover) { try { ov.showPopover(); } catch (e) {} }
    };
    (function() {
        const _s = document.createElement('style');
        _s.id = 'pm-memo-styles';
        _s.textContent = [
            /* ── 列表弹层整体 ── */
            '.pm-memo-modal{background:#f2f2f7!important;height:560px;max-height:88dvh;}',
            '.pm-memo-list-header{padding:18px 18px 6px;flex-shrink:0;display:flex!important;justify-content:space-between!important;align-items:flex-start!important;}',
            '.pm-memo-list-title{font-size:28px;font-weight:700;color:#1c1c1e;letter-spacing:-.5px;line-height:1.2;}',
            '.pm-memo-count{font-size:12px;color:#8e8e93;font-variant-numeric:tabular-nums;margin-top:6px;}',
            '.pm-memo-group-sep{height:12px;}',
            /* ── 卡片 ── */
            '.pm-memo-list{padding:8px 10px 8px!important;background:transparent;}',
            '.pm-memo-card{background:#fff;border-radius:0;padding:12px 14px 10px;margin-bottom:0;cursor:pointer;position:relative;border-bottom:1px solid #e5e5ea;}',
            '.pm-memo-card:first-of-type{border-radius:12px 12px 0 0;}',
            '.pm-memo-card:last-of-type{border-radius:0 0 12px 12px;border-bottom:none;}',
            '.pm-memo-card:only-of-type{border-radius:12px;border-bottom:none;}',
            '.pm-memo-card:active{opacity:.7;}',
            '.pm-memo-card-title{font-size:16px;font-weight:600;color:#1c1c1e;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-bottom:1px;}',
            '.pm-memo-card-sub{font-size:13px;color:#8e8e93;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-bottom:6px;}',
            '.pm-memo-card-when{color:#8e8e93;}',
            '.pm-memo-card-pre{color:#8e8e93;}',
            '.pm-memo-tag{display:inline-block;background:#ffcc00;color:#3a2e00;font-size:10px;font-weight:700;border-radius:4px;padding:1px 5px;margin-right:6px;vertical-align:1px;}',
            '.pm-memo-del{font-size:12px;color:#c7c7cc;display:block;text-align:right;}',
            '.pm-memo-del:active{color:#ff3b30;}',
            /* ── 底部按钮 ── */
            '.pm-memo-modal .pm-modal-add{background:#f2f2f7;border-top:none!important;}',
            '.pm-memo-modal .wb-btn-main{background:#ffcc00!important;color:#3a2e00!important;border-radius:10px!important;}',
            '.pm-memo-modal .wb-btn-sub{background:#fff!important;color:#1c1c1e!important;border:none!important;border-radius:10px!important;}',
            '.pm-memo-modal .wb-empty,.pm-memo-modal .wb-loading{padding:80px 20px;}',
            /* ── 详情页 ── */
            '.pm-memo-d-t{font-size:24px;font-weight:700;color:#1c1c1e;line-height:1.25;letter-spacing:-.5px;margin-bottom:4px;}',
            '.pm-memo-d-d{font-size:13px;color:#8e8e93;margin-bottom:18px;font-style:italic;}',
            '.pm-memo-d-b{font-size:16px;color:#1c1c1e;line-height:1.65;}',
            /* ── 正文格式 ── */
            '.pm-memo-p{margin:0 0 12px;}',
            '.pm-memo-p:last-child{margin-bottom:0;}',
            '.pm-memo-gap{height:8px;}',
            '.pm-memo-h1{font-size:22px;font-weight:700;color:#1c1c1e;margin:0 0 6px;letter-spacing:-.3px;}',
            '.pm-memo-h2{font-size:17px;font-weight:600;color:#1c1c1e;margin:4px 0 6px;}',
            '.pm-memo-bq{border-left:3px solid #ffcc00;margin:0 0 12px;padding:2px 0 2px 10px;color:#555;font-style:italic;}',
            '.pm-memo-ul{margin:0 0 12px;padding-left:20px;list-style:disc;}',
            '.pm-memo-ol{margin:0 0 12px;padding-left:22px;list-style:decimal;}',
            '.pm-memo-ul li,.pm-memo-ol li{margin-bottom:4px;font-size:16px;line-height:1.5;}',
            /* ── 涂黑/揭开 ── */
            '.pm-memo-redact{background:#1c1c1e;color:transparent;border-radius:3px;padding:0 3px;cursor:pointer;transition:all .25s;user-select:none;}',
            '.pm-memo-redact-open{background:#fff3b0;color:#1c1c1e;}',
            /* ── reduced motion ── */
            '@media (prefers-reduced-motion:reduce){#pm-overlay .pm-memo-modal *,#pm-overlay-sub .pm-memo-modal *{transition:none!important;animation:none!important;}}'
        ].join('');
        if (!document.getElementById('pm-memo-styles')) document.head.appendChild(_s);
    })();

    function wbIdentity(create, acct) {
        const id = getStorageId();
        const a = acct || __pmWeiboAcct;
        if (!window.__pmWeiboIdentity[id]) { if (!create) return null; window.__pmWeiboIdentity[id] = {}; }
        if (!window.__pmWeiboIdentity[id][a]) {
            if (!create) return null;
            window.__pmWeiboIdentity[id][a] = {
                // 大号默认红V（角色的公开账号本来就是名人）；小号/我的默认没V。
                // 只在「首次创建」时给默认值 —— 老数据的 '' 可能是用户明确选的「普通」，不能覆盖
                name: '', avatar: '', bio: '', tier: 'auto', vType: a === 'main' ? 'red' : '',
                fixedFans: false, fans: [], followed: false,
            };
        }
        const e = window.__pmWeiboIdentity[id][a];
        if (!Array.isArray(e.fans)) e.fans = [];
        if (!e.tier) e.tier = 'auto';
        wbMigrateV(e);
        return e;
    }
    // 老数据只有 vip 布尔（橙色加V）；现在分红V(名人)/蓝V(官方)/普通，老的当红V
    function wbMigrateV(o) {
        if (o && o.vType === undefined) o.vType = o.vip ? 'red' : '';
        return o;
    }
    // 指定账号的身份（不改当前 __pmWeiboAcct）—— 详情页要拿角色大号头像给「角色下场评论」用
    function wbIdentOf(acct) {
        const id = getStorageId();
        const e = window.__pmWeiboIdentity[id]?.[acct];
        return e ? wbMigrateV(e) : null;
    }
    // 用户自己在微博上的身份（跨大小号共用——你在评论区始终是同一个人）
    // bio 为空就是默认的"普通网友"；填了就按填的来，网友和博主都会照这个身份对待你
    function wbSelf(create) {
        const id = getStorageId();
        if (!window.__pmWeiboIdentity[id]) { if (!create) return null; window.__pmWeiboIdentity[id] = {}; }
        if (!window.__pmWeiboIdentity[id].__self) {
            if (!create) return null;
            window.__pmWeiboIdentity[id].__self = { name: '', avatar: '', vType: '', bio: '' };
        }
        return wbMigrateV(window.__pmWeiboIdentity[id].__self);
    }
    function wbSelfName() {
        const s = wbSelf(false);
        return (s && s.name) || getUserPersona().name || '我';
    }
    // 喂给 AI 的用户身份描述。没填就说是普通网友，填了就用用户写的
    function wbSelfIdentityText() {
        const s = wbSelf(false);
        const bio = (s && s.bio || '').trim();
        return bio || '一个普通网友（无特殊身份）';
    }
    // 角色是否认得出这个微博号就是用户本人：昵称用了真名，或者身份设定里写明了 TA 知道
    function wbCharKnowsMe() {
        const s = wbSelf(false) || {};
        const persona = (getUserPersona().name || '').trim();
        const nick = (s.name || '').trim();
        if (persona && nick && (nick === persona || nick.includes(persona))) return true;
        const bio = (s.bio || '');
        return /知道|认得|认出|是我|本人|小号是/.test(bio) && bio.includes(wbCharName());
    }
    function wbKnowsMeText() {
        return wbCharKnowsMe()
            ? `${wbCharName()}认得出这个账号就是用户本人（昵称用了真名，或用户在身份设定里写明了），所以 TA 说话时可以直接把对方当成认识的人。`
            : `默认情况下这只是个匿名路人号，${wbCharName()}并不知道账号背后是用户本人，只当成一个陌生网友对待——除非用户在身份设定里另有说明。`;
    }
    // 名气档位 → 赞数区间，直接写进 prompt 约束 AI 的数据自洽性
    // 从高到低排；档位之间的区间不许重叠，否则 AI 会拿不准
    const PM_WB_TIERS = {
        auto:     { label: '自动（AI按角色卡判断）', hint: '' },
        top:      { label: '顶流明星', hint: '点赞 100万-200万，评论 10万-80万（绝对不要超过 100万），转发数万' },
        mid:      { label: '中等明星', hint: '点赞 10万-50万，评论数千到上万，转发数千' },
        small:    { label: '小明星 / 运动员 / 电竞选手', hint: '点赞 5万-10万，评论数千，转发上千' },
        pro:      { label: '不火（业内有建树，如高管、名医）', hint: '点赞 1万-5万，评论几百条，转发几十到几百' },
        ordinary: { label: '素人（普通上班族、学生等）', hint: '点赞 10-200，评论几条到几十条，转发个位数' },
    };
    function wbTierHint(ident) {
        const t = PM_WB_TIERS[ident?.tier || 'auto'];
        if (!t || !t.hint) return '请你根据角色卡自行判断这个账号的粉丝量级和火爆程度，点赞/评论/转发数要与该量级自洽。';
        return `这个账号的名气档位是「${t.label}」：${t.hint}。互动数据必须落在这个区间内。`;
    }
    // acct 显式传入时锁定那个桶：异步生成期间用户切 tab 也不会写错账号
    function wbPosts(create, acct) {
        const id = getStorageId();
        const a = acct || __pmWeiboAcct;
        if (!window.__pmWeiboPosts[id]) { if (!create) return []; window.__pmWeiboPosts[id] = {}; }
        if (!Array.isArray(window.__pmWeiboPosts[id][a])) {
            if (!create) return [];
            window.__pmWeiboPosts[id][a] = [];
        }
        return window.__pmWeiboPosts[id][a];
    }
    function wbFindPost(pid) { return wbPosts(false).find(p => p.id === pid) || null; }
    // 「我的」页把用户自己当成第三个账号：博文桶照旧按 acct 分，身份取 __self
    function wbIsMe(acct) { return (acct || __pmWeiboAcct) === 'me'; }
    // 当前页的"博主"身份：我的页是用户自己，大小号是角色
    function wbCurIdent(create, acct) { return wbIsMe(acct) ? wbSelf(create) : wbIdentity(create, acct); }
    // 博主是 AI 扮演的角色，不是用户；「我的」页的博主就是用户
    function wbDefaultName(acct) {
        const a = acct || __pmWeiboAcct;
        if (wbIsMe(a)) return wbSelfName();
        const ident = wbIdentity(false, a);
        if (ident && ident.name) return ident.name;
        return wbCharName() + (a === 'alt' ? '的小号' : '');
    }
    function wbCharName() {
        const c = getCtx();
        return c?.characters?.[c.characterId]?.name || '角色';
    }
    // 头像兜底：聊天页设过头像的话，大号沿用角色那张、我的沿用用户那张（小号是马甲，不兜底）
    function wbAvatarFor(acct) {
        const ident = acct === 'me' ? wbSelf(false) : wbIdentOf(acct);
        if (ident && ident.avatar) return ident.avatar;
        const chat = getAvatarEntry(false);
        if (!chat) return '';
        if (acct === 'me') return chat.self || '';
        if (acct === 'main') return chat.other || '';
        return '';
    }
    function wbUid() { return 'w' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
    function wbNum(n) {
        n = Number(n) || 0;
        if (n >= 100000000) return (n / 100000000).toFixed(1).replace(/\.0$/, '') + '亿';
        if (n >= 10000) return (n / 10000).toFixed(1).replace(/\.0$/, '') + '万';
        return String(n);
    }
    // ── AI 生成：上下文拼装 ──────────────────────────
    // 角色卡+世界书+主聊天记录（与短信一致），额外附自己最近10条正文 + 最近3条博文的评论
    // acct 显式传入时，身份/历史/账号说明全部取那个号：gatherContext 里有 await，
    // 期间用户切 tab 的话，不锁账号就会拿错号的 prompt 素材
    async function wbBuildContext(acct) {
        const a = acct || __pmWeiboAcct;
        const ctx = await gatherContext();
        const ident = wbIdentity(false, a) || {};
        const posts = wbPosts(false, a);
        const recent = posts.slice(-PM_WB_CTX_POSTS);
        const historyText = recent.length
            ? recent.map(p => `- ${p.text}`).join('\n')
            : '（还没发过微博）';
        const withComments = posts.slice(-PM_WB_CTX_COMMENTS).filter(p => (p.comments || []).length);
        const commentText = withComments.length
            ? withComments.map(p => {
                const cs = (p.comments || []).map(c => {
                    const subs = (c.replies || []).map(r => `    · ${r.name}：${r.text}`).join('\n');
                    return `  · ${c.name}：${c.text}${subs ? '\n' + subs : ''}`;
                }).join('\n');
                return `【博文】${p.text.slice(0, 60)}\n${cs}`;
            }).join('\n')
            : '（暂无历史评论）';
        const acctLabel = a === 'main'
            ? '大号（角色的公开账号，说话要顾及公众形象。昵称可以是个网名而不是真名，但公众都知道这个号就是本人 —— 评论区网友清楚在跟谁说话，可以直呼其名、提 TA 的作品/身份/近况，不需要遮掩）'
            : '小号（角色的私密马甲，绝对不要暴露真实身份。内容要大众化生活化——聊聊天气、吃的、路上见闻、吐槽日常琐事、追剧感想之类，人人都可能发的东西。绝对不要提亲朋好友的名字或身份、不要炫富晒奢侈品、不要发工作内幕、不要发任何能让人猜到"这是个名人"的内容。语气随意放松，像个普通素人。评论区网友也只把 TA 当普通路人对待，平等交流，不要追捧崇拜）——如果角色本身就是素人/普通人，小号没有额外的隐藏要求';
        return { ctx, ident, acctLabel, historyText, commentText };
    }

    function wbSystemPrompt() {
        return `你在为一个角色扮演场景生成中文微博（新浪微博）内容。你扮演的是角色本人在发微博，同时也扮演评论区的所有网友。你必须严格只输出一个 JSON 对象，不要输出任何解释文字，不要用 markdown 代码块包裹。
硬性规则：
1. 博主是角色本人，不是用户。正文要符合角色的性格、说话习惯和当前处境。
2. 主楼正文可以配图，配图用文字描述（0-9 条），会被渲染成灰底占位图。评论和楼中楼绝对不许配图，需要视觉表达时用 emoji。
3. 评论区网友昵称要像真人（可带 emoji、数字、错别字），说话口语化、有梗、允许阴阳怪气或吵架，不要每条都是夸夸。
4. 评论区的网友也读得到这个账号过去发的微博，可以提到、调侃、对比之前的博文内容。
5. 同一个网友可以在同一条微博下出现 1-2 次（比如自己追评，或者在楼中楼里回别人）。
6. IP 属地写省份或"未知"，时间格式 "MM-DD HH:MM" 或 "刚刚"、"3分钟前"。
7. 楼中楼（replies）是网友对某条评论的回复，可以为空数组。如果某条评论的楼中楼回复数超过 3 条，可以把前面几条具体的回复截掉，换成 manyReplies: true 标记，渲染时会显示「共 xx 条回复」的装饰。replyTotal 是这条评论楼中楼的总回复数（只做装饰用），热门评论可以给几百到几千，冷门评论给 0 即可。
8. 一切内容都要短。真实微博的正文是一小段话，评论是一两句话。任何字段都不要写成长篇大论，超出篇幅的内容会被系统截断。`;
    }

    // needName：账号还没有昵称时，让 AI 顺手起一个。
    // 小号要藏身份（昵称不能沾真名），大号是公开号（昵称反而最好和本名有关联）—— 所以要知道是哪个号
    function wbPostSchema(needName, acct) {
        const isMain = acct === 'main';
        return `输出 JSON 结构：
{
${needName ? `  "author_name": "这个${isMain ? '账号' : '小号'}的昵称，10 字以内",\n` : ''}  "posts": [
    {
      "text": "微博正文，可含 #话题# 和 @某人，可用 emoji，换行用 \\n",
      "images": ["配图1的画面描述", "配图2的画面描述"],
      "ip": "四川",
      "time": "07-31 21:14",
      "likes": 12800,
      "comments_count": 1600,
      "reposts": 430,
      "comments": [
        {"name":"网友昵称","text":"评论内容","ip":"广东","time":"3分钟前","likes":220,"vip":true,
         "replies":[{"name":"另一个网友","text":"回复内容","time":"2分钟前","likes":15}],
         "manyReplies":false,"replyTotal":860}
      ]
    }
  ]
}
posts 必须正好 3 条，按时间从旧到新排列，内容互不重复（可以是不同话题，也可以是同一件事的不同阶段）。
每条微博的 comments 给 10-14 条主评论，热评在前，其中 3-5 条带 replies 楼中楼（每条楼中楼最多 2 层回复）。

【篇幅硬性限制】必须遵守，超长会被截断：
- 正文：不超过 500 字。长文只在角色真的要长篇输出时用（比如澄清、长文吐槽），平时 100-200 字更像真人发博。
- 配图描述：每条 12 字以内，只写画面主体，例如"深夜便利店的关东煮"。
- 主评论：不超过 50 字。真实网友的评论就是一两句话，8-30 字最常见。
- 楼中楼回复：不超过 50 字，比主评论更短更随口。
- 昵称：10 字以内。
不要为了凑字数把评论写成小作文，宁短勿长，口语化、有梗才是重点。
vip 为 true 表示昵称显示橙色会员色。${needName ? (isMain ? `
【必须额外输出 author_name】这是角色的公开大号，还没设置昵称。请起一个「一般和本名有相关」的昵称，10 字以内 —— 就像真人明星的微博名那样，是本名的变形而不是另一个身份：可以直接用本名，或在本名上加后缀（如「XX的日常」「XX工作室」），或取本名里的字、谐音、昵称化叫法。
公众本来就知道这个号是谁，所以不需要遮掩身份，别起一个和本名毫无关系的网名。` : `
【必须额外输出 author_name】这是一个匿名小号，还没有昵称。请按角色的性格和这个账号的调性起一个网感的昵称，10 字以内。
昵称里绝对不能出现角色的真名，也不能带「小号」「马甲」「vlog」这类自暴身份的字眼 —— 要看起来就是个普通网友的 ID。`) : ''}`;
    }

    function wbParseJSON(raw) {
        let s = String(raw || '').trim();
        s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
        const a = s.indexOf('{'), b = s.lastIndexOf('}');
        if (a === -1 || b === -1 || b <= a) throw new Error('AI 未返回 JSON');
        let body = s.slice(a, b + 1);
        try { return JSON.parse(body); }
        catch (e) {
            // 容错：去掉对象/数组尾随逗号后再试一次
            try { return JSON.parse(body.replace(/,\s*([}\]])/g, '$1')); }
            catch (e2) { throw new Error('AI 返回的 JSON 无法解析'); }
        }
    }

    // 把 AI 返回的原始对象规整成内部存储格式，防止字段缺失/类型错误导致渲染崩掉
    function wbNormalizePost(o, existing) {
        const p = existing || { id: wbUid(), createdAt: Date.now() };
        // 截断上限就是 prompt 里给的硬性限制：正文 500 字，评论 50 字
        p.text = wbStripImgToken(String(o.text || '')).slice(0, 500);
        // trim 掉纯空白的描述，否则会渲染出一个没字的灰方块
        p.images = Array.isArray(o.images) ? o.images.slice(0, 9).map(wbNormImage).filter(Boolean) : [];
        p.ip = String(o.ip == null ? '未知' : o.ip).slice(0, 20);
        p.time = String(o.time || '刚刚').slice(0, 30);
        p.likes = Math.max(0, Number(o.likes) || 0);
        p.reposts = Math.max(0, Number(o.reposts) || 0);
        p.commentsCount = Math.max(0, Number(o.comments_count) || 0);
        p.liked = !!p.liked;
        p.comments = (Array.isArray(o.comments) ? o.comments : []).slice(0, 16).map(c => wbNormalizeComment(c));
        if (!p.commentsCount) p.commentsCount = p.comments.length;
        return p;
    }
    // 只作用于 AI 返回的内容；用户自己打的评论是直接 push 的，不走这里，不会被截
    function wbNormalizeComment(c) {
        return {
            id: wbUid(),
            name: String(c?.name || '网友').slice(0, 20),
            text: String(c?.text || '').slice(0, 50),
            ip: String(c?.ip || '').slice(0, 20),
            time: String(c?.time || '刚刚').slice(0, 30),
            likes: Math.max(0, Number(c?.likes) || 0),
            vip: !!c?.vip,
            liked: false,
            isSelf: !!c?.isSelf,
            isOwner: !!c?.by_owner,
            manyReplies: !!c?.manyReplies,
            replyTotal: Math.max(0, Math.floor(Number(c?.replyTotal) || 0)),
            replies: (Array.isArray(c?.replies) ? c.replies : []).slice(0, 6).map(r => ({
                id: wbUid(),
                name: String(r?.name || '网友').slice(0, 20),
                text: String(r?.text || '').slice(0, 50),
                time: String(r?.time || '刚刚').slice(0, 30),
                likes: Math.max(0, Number(r?.likes) || 0),
                replyTo: String(r?.reply_to || '').slice(0, 20),
                liked: false,
                isSelf: !!r?.isSelf,
                isOwner: !!r?.by_owner,
            })),
        };
    }

    function wbFansPrompt(ident) {
        if (!ident.fixedFans) return '每次生成都用全新的网友昵称，不必与历史评论中的昵称重合。';
        const pool = (ident.fans || []).slice(0, 25);
        if (!pool.length) return '这些网友是该账号的固定粉丝，请在本次生成时创造 5-9 个昵称，之后会一直复用他们。';
        return `以下是该账号的固定粉丝，本次评论请优先复用这些昵称（可只用其中一部分，也可新增 1-2 个新面孔）：\n${pool.map(f => f.name).join('、')}`;
    }
    // 固定网友：把本次出现过的昵称并入粉丝池，后续生成复用
    function wbAbsorbFans(post, acct) {
        const ident = wbIdentity(true, acct);
        if (!ident.fixedFans) return;
        const seen = new Set((ident.fans || []).map(f => f.name));
        const add = (name, vip) => { if (name && !seen.has(name)) { seen.add(name); ident.fans.push({ name, vip: !!vip }); } };
        (post.comments || []).forEach(c => { add(c.name, c.vip); (c.replies || []).forEach(r => add(r.name, false)); });
        if (ident.fans.length > 60) ident.fans = ident.fans.slice(-60);
    }

    // 刷新：AI 以角色身份生成 3 条新微博，每条自带完整评论区
    async function wbGeneratePosts(acct) {
        const lockAcct = acct || __pmWeiboAcct;
        const { ctx, ident, acctLabel, historyText, commentText } = await wbBuildContext(lockAcct);
        // 大号/小号没昵称：这次生成顺便让 AI 起名（小号要藏身份，大号要和本名有关联，分工在 wbPostSchema 里）。
        // 「我的号」是用户自己的账号，昵称跟着用户名走，不让 AI 起
        const needName = (lockAcct === 'alt' || lockAcct === 'main') && !(ident && ident.name);
        const userPrompt = `【角色卡】
${ctx.cardDesc}
${ctx.cardPersonality}
${ctx.cardScenario}

【世界书】
${ctx.worldBookText || '（无）'}

【主线剧情最近对话】
${ctx.mainChatText || '（无）'}

【用户角色】${ctx.userName}：${ctx.userDesc || '（无设定）'}

【发博账号】${acctLabel}
昵称：${needName ? `（还没起，见文末 author_name 要求${lockAcct === 'main' ? `。本名是「${wbCharName()}」，起名要和它有关联` : ''}）` : wbDefaultName(lockAcct)}
账号设定：${ident.bio || '（未填写，请根据角色卡自行推断这个账号的调性）'}

【名气档位】
${wbTierHint(ident)}

【该账号最近的微博】
${historyText}

【该账号最近博文的评论区】
${commentText}

【固定网友规则】
${wbFansPrompt(ident)}

请以角色本人的身份，生成 3 条新的微博（含各自完整的评论区）。这 3 条要符合角色当前的处境和心情，和上面列出的历史微博不要重复。
${wbPostSchema(needName, lockAcct)}`;
        const raw = await callAI(wbSystemPrompt(), userPrompt, { maxTokens: 3200 });
        const o = wbParseJSON(raw);
        // 用户自己填过昵称就永远不覆盖；只有 needName 那次才写回
        if (needName && o.author_name) {
            const target = wbIdentity(true, lockAcct);
            if (target && !target.name) {
                target.name = String(o.author_name).trim().slice(0, 10);
                await saveWeiboIdentity();
            }
        }
        const arr = Array.isArray(o.posts) ? o.posts : (o.text ? [o] : []);
        if (!arr.length) throw new Error('AI 没有返回任何微博');
        return arr.slice(0, 3).map(x => wbNormalizePost(x));
    }

    // 刷新：只针对用户新发的评论/回复生成回应，但允许其他网友"串戏"插话
    // acct 显式传入时锁定那个桶：等待期间用户切 tab 也不会把粉丝写错账号
    async function wbRefreshComments(post, acct) {
        const lockAcct = acct || __pmWeiboAcct;
        const { ctx, ident, acctLabel } = await wbBuildContext(lockAcct);
        const pending = [];
        const me = wbSelfName();
        (post.comments || []).forEach(c => {
            if (c.isSelf && !c.answered) pending.push(`「${me}」（用户）在这条微博下发了评论：「${c.text}」`);
            (c.replies || []).forEach(r => {
                if (r.isSelf && !r.answered) {
                    const who = r.replyTo ? `${r.replyTo} 的回复` : `${c.name} 的评论「${c.text}」`;
                    pending.push(`「${me}」（用户）回复了 ${who}，回复内容是：「${r.text}」`);
                }
            });
        });
        if (!pending.length) return { added: 0 };

        const existing = (post.comments || []).map(c => {
            const subs = (c.replies || []).map(r => `    · ${r.name}${r.isSelf ? '（用户）' : ''}：${r.text}`).join('\n');
            return `  [${c.id}] ${c.name}${c.isSelf ? '（用户）' : ''}：${c.text}${subs ? '\n' + subs : ''}`;
        }).join('\n');

        const userPrompt = `【角色卡】
${ctx.cardDesc}
${ctx.cardPersonality}

【世界书】
${ctx.worldBookText || '（无）'}

【主线剧情最近对话】
${ctx.mainChatText || '（无）'}

【发博账号】${acctLabel}，昵称：${wbDefaultName(lockAcct)}
账号设定：${ident.bio || '（无）'}

【用户在微博上的身份】昵称「${me}」：${wbSelfIdentityText()}
网友和博主都按这个身份看待用户——如果用户是个有身份的人，评论区该认出来就认出来（起哄、质疑、蹭热度都行）；如果只是普通网友，就当普通人对待。

【微博正文】
${post.text}

【当前评论区】
${existing || '（空）'}

【本次需要回应的新动作】
${pending.join('\n')}

【固定网友规则】
${wbFansPrompt(ident)}

要求：
1. 主要针对上面"需要回应的新动作"生成回应。
2. 博主（角色本人）也可能亲自下场回复用户——如果角色的性格和当前处境让他愿意回，就在 replies_to_comments 里用博主的昵称「${wbDefaultName(lockAcct)}」回一条，并把 by_owner 设为 true。不是每次都要回，看角色愿不愿意。
3. 允许串戏：如果有别的网友对这个话题感兴趣，也可以让他插一条回复进来，不必只回应被 @ 的那个人。
4. 回复要接住上下文，像真人在评论区你来我往，可以调侃、追问、反驳。
5. 只输出新增的内容，不要重复已有评论。
6. 篇幅硬性限制：每条评论和楼中楼回复都不超过 50 字，昵称 10 字以内。宁短勿长，别写小作文。
7. 总共给 2-6 条新内容就够了，不要刷屏。

输出 JSON：
{
  "replies_to_comments": [
    {"comment_id":"上面方括号里的评论id","name":"网友昵称","text":"楼中楼回复内容","time":"刚刚","likes":3,"by_owner":false,"reply_to":"如果是回复楼中楼里的某个人，写他的昵称；直接回主评论就留空"}
  ],
  "new_comments": [
    {"name":"网友昵称","text":"新增的主评论","ip":"浙江","time":"刚刚","likes":8,"vip":false,"replies":[]}
  ]
}
两个数组都可以为空，但总共至少给 2 条。`;
        const raw = await callAI(wbSystemPrompt(), userPrompt, { maxTokens: 900 });
        const o = wbParseJSON(raw);
        let added = 0;
        if (!Array.isArray(post.comments)) post.comments = [];

        (Array.isArray(o.replies_to_comments) ? o.replies_to_comments : []).forEach(r => {
            const target = (post.comments || []).find(c => c.id === r.comment_id) || post.comments?.[0];
            if (!target) return;
            if (!Array.isArray(target.replies)) target.replies = [];
            target.replies.push({
                id: wbUid(),
                name: String(r.name || '网友').slice(0, 20),
                // 上限跟 prompt 里说的一致：楼中楼 50 字
                text: String(r.text || '').slice(0, 50),
                time: String(r.time || '刚刚').slice(0, 30),
                likes: Math.max(0, Number(r.likes) || 0),
                replyTo: String(r.reply_to || '').slice(0, 20),
                liked: false, isSelf: false, isOwner: !!r.by_owner,
            });
            added++;
        });
        (Array.isArray(o.new_comments) ? o.new_comments : []).forEach(c => {
            post.comments.push(wbNormalizeComment(c));
            post.commentsCount = (post.commentsCount || 0) + 1;
            added++;
        });

        // 标记已回应，避免下次刷新重复针对同一条用户发言
        (post.comments || []).forEach(c => {
            if (c.isSelf) c.answered = true;
            (c.replies || []).forEach(r => { if (r.isSelf) r.answered = true; });
        });
        wbAbsorbFans(post, lockAcct);
        return { added };
    }

    // ── UI：列表页 ──────────────────────────
    // vType 有值时右下角挂 V 标，所以要包一层定位容器（生成器里的 .avatar-container 同理）
    function wbAvatarHtml(url, cls, vType) {
        const inner = url
            ? `<img src="${escapeAttr(url)}" class="wb-av ${cls || ''}" alt="">`
            : `<div class="wb-av wb-av-ph ${cls || ''}"></div>`;
        const badge = wbVBadge(vType);
        return badge ? `<span class="wb-avwrap ${cls || ''}">${inner}${badge}</span>` : inner;
    }
    function wbToast(msg) {
        const t = document.createElement('div');
        t.className = 'wb-toast'; t.textContent = msg;
        (document.getElementById('pm-overlay') || document.body).appendChild(t);
        setTimeout(() => t.remove(), 2200);
    }

    // 覆盖层挂在 body 上而非 #pm-iphone 内，拿不到 data-theme 继承，所以显式打 is-dark
    function wbDarkCls() { return (window.__pmTheme?.darkMode === 'dark') ? ' is-dark' : ''; }

    // ── 图标：路径直接取自 微博生成器3.0.html，保持同一套视觉语言 ──────
    const WB_PATH_REPOST = 'M18 16.08c-.76 0-1.44.3-1.96.77L8.91 12.7c.05-.23.09-.46.09-.7s-.04-.47-.09-.7l7.05-4.11c.54.5 1.25.81 2.04.81 1.66 0 3-1.34 3-3s-1.34-3-3-3-3 1.34-3 3c0 .24.04.47.09.7L8.04 9.81C7.5 9.31 6.79 9 6 9c-1.66 0-3 1.34-3 3s1.34 3 3 3c.79 0 1.5-.31 2.04-.81l7.12 4.16c-.05.21-.08.43-.08.65 0 1.61 1.31 2.92 2.92 2.92 1.61 0 2.92-1.31 2.92-2.92s-1.31-2.92-2.92-2.92z';
    const WB_PATH_COMMENT = 'M21.99 4c0-1.1-.89-2-1.99-2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h14l4 4-.01-18zM18 14H6v-2h12v2zm0-3H6V9h12v2zm0-3H6V6h12v2z';
    const WB_PATH_LIKE = 'M1 21h4V9H1v12zm22-11c0-1.1-.9-2-2-2h-6.31l.95-4.57.03-.32c0-.41-.17-.79-.44-1.06L14.17 1 7.59 7.59C7.22 7.95 7 8.45 7 9v10c0 1.1.9 2 2 2h9c.83 0 1.54-.5 1.84-1.22l3.02-7.05c.09-.23.14-.47.14-.73v-2z';

    // 排序栏的降序箭头，取自 微博生成器3.0
    const WB_PATH_SORT = 'M4 4v12.2l-2.1-2.1-.9.9 4 4 4-4-.9-.9L6 16.2V4H4zm6 1h12v2H10V5zm0 6h8v2H10v-2zm0 6h5v2H10v-2z';

    function wbIcon(d, size) {
        return `<svg class="wb-svg" viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true"><path d="${d}"/></svg>`;
    }
    // 超话前面的钻石，path 也来自 微博生成器3.0
    const WB_SVG_TOPIC = '<svg class="wb-diamond" viewBox="0 0 1024 1024" aria-hidden="true"><path d="M152.1 366.5l359.9 458.7 359.9-458.7-200.7-204H352.8L152.1 366.5z m75.1 19.3h569.6L512 748 227.2 385.8z" fill="currentColor"/><path d="M375.4 340.6h273.2l-136.6 172.9z" fill="currentColor"/></svg>';

    // 正文/评论里的 #话题#、@某人、XX超话 一律染蓝（和真微博一致）。
    // 必须先 escapeHtml 再加标签，否则用户输入的 < 会被当标签解析。
    function wbLinkify(raw) {
        let s = escapeHtml(String(raw || ''));
        // 超话：钻石图标 + 名字，整体染蓝。放在 #话题# 之前处理，避免 #xx超话# 被拆开
        s = s.replace(/#([^#\n]{1,30}超话)#/g, (m, t) => `<span class="wb-blue">${WB_SVG_TOPIC}${t}</span>`);
        s = s.replace(/([^\s#@]{1,20}超话)(?![^<]*<\/span>)/g, (m, t) => `<span class="wb-blue">${WB_SVG_TOPIC}${t}</span>`);
        // #话题#
        s = s.replace(/#([^#\n]{1,40})#/g, (m, t) => `<span class="wb-blue">#${t}#</span>`);
        // @某人：中英数字下划线，不吃标点和 &（escapeHtml 产物）
        s = s.replace(/@([一-龥A-Za-z0-9_\-]{1,20})/g, (m, t) => `<span class="wb-blue">@${t}</span>`);
        return s.replace(/\n/g, '<br>');
    }

    // 头像右下角的 V 标：红V=名人，蓝V=官方，空=普通。仿 微博生成器3.0 的 .v-badge
    function wbVBadge(vType) {
        if (vType !== 'red' && vType !== 'blue') return '';
        return `<i class="wb-vb wb-vb-${vType}">V</i>`;
    }
    // 昵称类：红V 用橙色名（和生成器的 .vip 一致），蓝V/普通保持默认蓝
    function wbNameCls(vType) { return vType === 'red' ? ' is-vip' : ''; }
    const PM_WB_VTYPES = { '': '普通（无认证）', red: '红V（名人认证）', blue: '蓝V（官方/机构认证）' };
    // 点赞：空心/实心用同一条 path，只切 fill 与 stroke —— 形状完全不变，只有"填满"的差别
    function wbLikeIcon(liked, size) {
        return `<svg class="wb-svg wb-svg-like${liked ? ' is-solid' : ''}" viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true"><path d="${WB_PATH_LIKE}"/></svg>`;
    }

    // span 上的 onclick 不响应回车/空格，给 role=button 的元素补键盘触发，
    // 否则那些 focus 圈就是假的。一次性挂在 document 上，覆盖后续所有重绘出来的节点。
    if (!window.__pmWbKeyBound) {
        window.__pmWbKeyBound = true;
        document.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter' && e.key !== ' ') return;
            const t = e.target;
            if (!t || t.getAttribute?.('role') !== 'button') return;
            if (!t.closest('#pm-overlay,#pm-overlay-sub')) return;
            e.preventDefault();
            t.click();
        });
    }

    // 同步渲染。以前开头有个 await loadWeiboData()，切大号/小号时那一下 await 让旧弹窗
    // 先被拆掉、内容等 IDB 回来才画出来，看起来就是"内容消失几秒又弹出来"。
    // 数据没就位时先画骨架，加载完再自己重画一次。
    window.__pmShowWeibo = () => {
        if (!__pmWeiboLoaded) {
            loadWeiboData().then(() => { if (document.querySelector('#pm-overlay .wb-feed')) window.__pmShowWeibo(); });
        }
        const ident = wbCurIdent(false) || {};
        const posts = wbPosts(false).slice().reverse();
        const name = wbDefaultName();
        const me = wbIsMe();

        // 列表页只给正文 + 转赞评数量，配图和评论区都留到详情页（像微博页面中间被截掉）
        const cards = posts.map(p => `<div class="wb-card" onclick="window.__pmWeiboDetail('${safeJS(p.id)}')">
  <div class="wb-card-top">
    ${wbAvatarHtml(wbAvatarFor(__pmWeiboAcct), 'wb-av-40', ident.vType)}
    <div class="wb-card-id">
      <div class="wb-uname${wbNameCls(ident.vType)}"><span>${escapeHtml(name)}</span></div>
      <div class="wb-meta">${escapeHtml(p.time)}${p.ip ? ' · 发布于 ' + escapeHtml(p.ip) : ''}</div>
    </div>
  </div>
  <div class="wb-text wb-text-clip">${wbLinkify(p.text)}</div>
  ${wbGridHtml(p.images, true, p.id)}
  <div class="wb-bar">
    <span>${wbIcon(WB_PATH_REPOST, 14)}<b>${wbNum(p.reposts)}</b></span>
    <span>${wbIcon(WB_PATH_COMMENT, 14)}<b>${wbNum(p.commentsCount)}</b></span>
    <span class="wb-like ${p.liked ? 'is-liked' : ''}" onclick="event.stopPropagation();window.__pmWeiboLikeFeed(this,'${safeJS(p.id)}')" role="button" tabindex="0" title="${p.liked ? '取消赞' : '赞'}">${wbLikeIcon(!!p.liked, 14)}<b>${wbLikeLabel(p.likes, !!p.liked)}</b></span>
  </div>
</div>`).join('');

        makeOverlay(`
<div class="pm-modal pm-modal-wide wb-modal${wbDarkCls()}">
  <div class="pm-modal-header">
    <b>微博</b>
    <span style="display:flex;align-items:center;gap:10px;">
      <span onclick="window.__pmWeiboIdentityModal()" title="账号设置（头像/昵称/认证/名气档位）" class="wb-ico" role="button" tabindex="0" style="font-size:15px;">⚙️</span>
      <span onclick="document.getElementById('pm-overlay').remove()" class="pm-modal-close">✕</span>
    </span>
  </div>
  <div class="wb-acct-tabs">
    <div class="wb-tab ${__pmWeiboAcct === 'main' ? 'is-on' : ''}" onclick="window.__pmWeiboSetAcct('main')" role="button" tabindex="0">大号</div>
    <div class="wb-tab ${__pmWeiboAcct === 'alt' ? 'is-on' : ''}" onclick="window.__pmWeiboSetAcct('alt')" role="button" tabindex="0">小号</div>
    <div class="wb-tab ${me ? 'is-on' : ''}" onclick="window.__pmWeiboSetAcct('me')" role="button" tabindex="0">我的</div>
  </div>
  <div class="pm-modal-scroll wb-feed">
    ${posts.length ? cards : (!__pmWeiboLoaded ? wbSkeletonHtml() : `<div class="wb-empty">
      <div class="wb-empty-ic">${me ? '✍️' : '🌐'}</div>
      <div class="wb-empty-t">${me ? '你还没发过微博' : escapeHtml(name) + '的' + (__pmWeiboAcct === 'main' ? '大号' : '小号') + '还没有微博'}</div>
      <div class="wb-empty-s">${me
                ? '点下面的发微博写一条<br>发完点 🔄 让网友来评论'
                : '点下面的刷新，让 TA 发三条<br>先去 ⚙️ 里设好头像、昵称和名气档位，生成的内容会更贴角色'}</div>
    </div>`)}
  </div>
  <div class="pm-modal-add">
    ${me ? `
    <button onclick="window.__pmWeiboCompose()" class="wb-btn-main" style="flex:1;">✍️ 发微博</button>
    <button id="pm-wb-refresh-btn" onclick="window.__pmWeiboReplyMine()" class="wb-btn-sub" title="让网友来评论你还没有人回复的微博">🔄 收评论</button>`
                : `<button id="pm-wb-refresh-btn" onclick="window.__pmWeiboRefreshFeed()" class="wb-btn-main" style="flex:1;">🔄 刷新（生成3条新微博）</button>`}
  </div>
</div>`);
    };

    // 配图网格。用户发的是真图（dataURL/http），AI 发的是文字描述→灰底占位图
    // 配图既可能是真实图片地址（用户发博选的图），也可能是 AI 写的文字描述。
// 真图整条保留，文字描述才截断；纯占位词（[图片] 之类）直接丢掉。
// AI 偶尔会把「[图片]」当成正文的一部分写在末尾（尤其只配一张图时）。
// 配图数组那边由 wbNormImage 挡掉，正文这边得单独清：末尾连续的占位词全剥掉。
function wbStripImgToken(t) {
    let s = String(t || '');
    const tail = /[\s，,。.、;；]*[\[【(（]\s*(图片|图|照片|配图|image|img|picture|pic)\s*[\]】)）]\s*$/i;
    while (tail.test(s)) s = s.replace(tail, '');
    return s.trim();
}

// 判断一条配图是"真图"还是"AI 写的文字描述"。
// 图库里的图既可能是 dataURL / http，也可能是酒馆自己的相对路径（/user/images/x.png）
// 或 blob:。这些以前都会被当成文字描述，截成 30 字再渲染成灰底方块——图就"看不见"了。
function wbIsImgSrc(s) {
    return /^(data:image|https?:\/\/|blob:|\.{0,2}\/)/i.test(s) || /\.(png|jpe?g|gif|webp|avif|bmp|svg)(\?|#|$)/i.test(s);
}

function wbNormImage(x) {
    const s = String(x || '').trim();
    if (!s) return '';
    if (wbIsImgSrc(s)) return s;
    if (/^[\[【(（]?\s*(图片|图|照片|image|img|picture|pic)\s*[\]】)）]?$/i.test(s)) return '';
    return s.slice(0, 30);
}

function wbGridHtml(images, clip, pid) {
        const arr = (images || []).slice(0, 9);
        if (!arr.length) return '';
        const cells = arr.map((d, i) => wbIsImgSrc(d)
            ? `<div class="wb-img is-real"><img src="${escapeAttr(d)}" alt="配图"></div>`
            : `<div class="wb-img" data-desc="${escapeAttr(d)}" role="button" tabindex="0" onclick="event.stopPropagation();window.__pmGenWbImg(this,'${pid ? escapeAttr(pid) : ''}',${i})" title="点击生成图片"><span>${escapeHtml(d)}</span></div>`).join('');
        return `<div class="wb-grid${clip ? ' wb-grid-sm' : ''}" data-n="${arr.length}">${cells}</div>`;
    }

    // 三条骨架卡，占位形状和真实 wb-card 对齐
    function wbSkeletonHtml() {
        const one = (w1, w2) => `<div class="wb-skel">
  <div class="wb-skel-row"><div class="wb-skel-b wb-skel-av"></div>
    <div style="flex:1;"><div class="wb-skel-b" style="height:11px;width:38%;"></div>
    <div class="wb-skel-b" style="height:9px;width:24%;margin-top:6px;"></div></div></div>
  <div class="wb-skel-b wb-skel-l" style="width:${w1};"></div>
  <div class="wb-skel-b wb-skel-l" style="width:${w2};"></div>
</div>`;
        return one('96%', '61%') + one('88%', '73%') + one('93%', '45%');
    }

    // 刷新动态：生成 3 条新博文，只作用于当前正在看的账号
    window.__pmWeiboRefreshFeed = async () => {
        if (__pmWeiboBusy) return;
        __pmWeiboBusy = true;
        const btn = document.getElementById('pm-wb-refresh-btn');
        const feed = document.querySelector('#pm-overlay .wb-feed');
        if (btn) { btn.textContent = '生成中…（3条微博+评论区）'; btn.disabled = true; btn.style.opacity = '.6'; }
        if (feed) { feed.insertAdjacentHTML('afterbegin', `<div id="pm-wb-skel">${wbSkeletonHtml()}</div>`); feed.scrollTop = 0; }
        // 生成前锁定当前账号：等待期间用户切 tab 也不会把微博写进别的号
        const lockAcct = __pmWeiboAcct;
        try {
            const posts = await wbGeneratePosts(lockAcct);
            const arr = wbPosts(true, lockAcct);
            posts.forEach(p => { arr.push(p); wbAbsorbFans(p, lockAcct); });
            while (arr.length > PM_WB_MAX_POSTS) arr.shift();
            await Promise.all([saveWeiboPosts(), saveWeiboIdentity()]);
            window.__pmShowWeibo();
            wbToast(`生成了 ${posts.length} 条新微博`);
        } catch (e) {
            document.getElementById('pm-wb-skel')?.remove();
            if (btn) { btn.textContent = '🔄 刷新（生成3条新微博）'; btn.disabled = false; btn.style.opacity = '1'; }
            wbToast('生成失败：' + (e.message || e));
        } finally { __pmWeiboBusy = false; }
    };

    window.__pmWeiboSetAcct = (a) => { __pmWeiboAcct = a; window.__pmShowWeibo(); };

    // 每个 tab 的齿轮只编辑自己那一个身份：大号编大号、小号编小号、我的编用户自己
    window.__pmWeiboIdentityModal = () => {
        const me = wbIsMe();
        const ident = wbCurIdent(true);
        const label = me ? '我的账号' : (__pmWeiboAcct === 'main' ? '大号' : '小号');
        const vOpts = Object.keys(PM_WB_VTYPES).map(k =>
            `<option value="${k}"${(ident.vType || '') === k ? ' selected' : ''}>${escapeHtml(PM_WB_VTYPES[k])}</option>`).join('');
        const tierOpts = Object.keys(PM_WB_TIERS).map(k =>
            `<option value="${k}"${(ident.tier || 'auto') === k ? ' selected' : ''}>${escapeHtml(PM_WB_TIERS[k].label)}</option>`).join('');
        const persona = getUserPersona().name || '我';
        makeOverlay(`
<div class="pm-modal pm-modal-wide wb-modal${wbDarkCls()}">
  <div class="pm-modal-header"><b>${label}设置</b><span onclick="window.__pmWeiboSaveIdentity()" class="pm-modal-close">✕</span></div>
  <div class="pm-modal-scroll wb-form">
    <div class="wb-form-h">— ${me ? '你自己的微博号' : '角色的' + label + '（博主本人）'} —</div>
    <div style="display:flex;justify-content:center;">
      ${wbAvPickHtml('pm-wb-av-slot', wbAvatarFor(__pmWeiboAcct), '头像')}
    </div>
    <div class="pm-cfg-label">昵称</div>
    <input id="pm-wb-name" class="pm-cfg-input" placeholder="${escapeAttr(me ? persona : wbDefaultName())}" value="${escapeAttr(ident.name || '')}">
    <div class="pm-cfg-label">认证类型</div>
    <select id="pm-wb-vtype" class="pm-cfg-input">${vOpts}</select>
    <div class="wb-form-note">红V＝名人（昵称显橙色），蓝V＝官方或机构（例如 XX工作室），普通＝没有认证标。</div>
    ${me ? '' : `
    <div class="pm-cfg-label">名气档位</div>
    <select id="pm-wb-tier" class="pm-cfg-input">${tierOpts}</select>`}
    <div class="pm-cfg-label">${me ? '身份设定（留空＝匿名路人）' : '账号设定（发博风格、人设补充）'}</div>
    <textarea id="pm-wb-bio" class="pm-cfg-input" rows="${me ? 3 : 4}" style="resize:vertical;font-family:inherit;" placeholder="${escapeAttr(me
                ? '例如：八百万粉的美食博主 / 同公司的实习生小号 / ' + wbCharName() + '知道这个号是我'
                : '例如：三万粉的旅行博主，爱吐槽，粉丝黏性高')}">${escapeHtml(ident.bio || '')}</textarea>
    ${me ? `<div class="wb-form-note">默认你在微博上是<b>匿名路人</b>，${escapeHtml(wbCharName())}并不知道这个号是你本人。想让 TA 认出你，二选一：把昵称改成你的真名「${escapeHtml(persona)}」，或者在上面写明"${escapeHtml(wbCharName())}知道这个账号是我"。填了身份设定后，评论区的网友也会照这个身份对待你。</div>`
                : `
    <div class="wb-form-row wb-form-sep">
      <span>固定网友</span>
      <div id="pm-wb-fixedfans" class="pm-switch ${ident.fixedFans ? 'is-on' : ''}" onclick="this.classList.toggle('is-on')"></div>
    </div>
    <div class="wb-form-note">开启后同一批网友会在这个账号的博文间反复出现；关闭则每次都是全新面孔。当前已记住 ${(ident.fans || []).length} 个网友。</div>
    ${(ident.fans || []).length ? `<button onclick="window.__pmWeiboClearFans()" class="wb-btn-danger">清空固定网友</button>` : ''}`}
  </div>
</div>`);
        document.getElementById('pm-wb-av-slot')?.addEventListener('click', () => wbPickAvatar());
    };

    // 可点的头像位。以前只是个透明圆，看着是空白却能点出选图框；
    // 现在虚线圈+相机+文字说明，点击区域和视觉边界一致。
    function wbAvPickHtml(id, url, label) {
        const inner = url
            ? `<img src="${escapeAttr(url)}" alt="${escapeAttr(label)}">`
            : `<span class="wb-avpick-cam">📷</span>`;
        return `<div id="${id}" class="wb-avpick" role="button" tabindex="0" title="点击设置${escapeAttr(label)}">
      <div class="wb-avpick-ring${url ? ' has-img' : ''}">${inner}</div>
      <div class="wb-avpick-t">${escapeHtml(label)}</div>
    </div>`;
    }

    // 关掉弹窗时统一落盘（和插件里其他设置页一致）
    // 表单值先收进内存、立刻画出列表页，IDB 写盘丢到下一帧 —— 点✕不该等磁盘
    window.__pmWeiboSaveIdentity = () => {
        wbCollectIdentityForm();
        window.__pmShowWeibo();
        requestAnimationFrame(() => { saveWeiboIdentity(); });
    };
    function wbCollectIdentityForm() {
        const ident = wbCurIdent(true);
        const g = (id) => document.getElementById(id);
        if (!g('pm-wb-name')) return; // 弹窗已经不在了，别把空值写回去
        ident.name = g('pm-wb-name')?.value.trim() || '';
        ident.bio = g('pm-wb-bio')?.value.trim() || '';
        ident.vType = g('pm-wb-vtype')?.value || '';
        // 「我的」页没有这两项，别用空值覆盖掉大小号的设置
        if (g('pm-wb-tier')) ident.tier = g('pm-wb-tier').value || 'auto';
        if (g('pm-wb-fixedfans')) ident.fixedFans = g('pm-wb-fixedfans').classList.contains('is-on');
    }
    window.__pmWeiboClearFans = () => {
        const ident = wbIdentity(true); ident.fans = [];
        saveWeiboIdentity(); wbToast('已清空');
        window.__pmWeiboIdentityModal();
    };

    // 头像选择：与短信头像同款（URL 或相册单张），存 IDB 不建库
    // who: 'char' = 角色这个号的头像；'self' = 用户在评论区的头像
    function wbPickAvatar() {
        wbCollectIdentityForm(); // 换页会丢表单，先把身份页里已填的东西收进内存
        const target = wbCurIdent(true);
        const cur = target.avatar || '';
        const urlVal = (cur && !cur.startsWith('data:')) ? cur : '';
        makeOverlay(`
<div class="pm-modal wb-modal${wbDarkCls()}">
  <div class="pm-modal-header"><b>设置头像</b><span onclick="window.__pmWeiboIdentityModal()" class="pm-modal-close">✕</span></div>
  <div class="wb-form">
    ${cur ? `<img src="${escapeAttr(cur)}" style="width:56px;height:56px;border-radius:50%;object-fit:cover;align-self:center;">` : ''}
    <div class="pm-cfg-label">图片URL</div>
    <input id="pm-wb-av-url" class="pm-cfg-input" placeholder="https://..." value="${escapeAttr(urlVal)}">
    <div style="text-align:center;color:#888;font-size:12px;">— 或 —</div>
    <label style="display:flex;align-items:center;justify-content:center;gap:6px;background:#f2f2f2;border-radius:10px;padding:10px;cursor:pointer;font-size:13px;color:#555;">
      📷 从相册选择
      <input id="pm-wb-av-file" type="file" accept="image/*" style="display:none;">
    </label>
  </div>
  <div class="pm-modal-add" style="display:flex;gap:8px;">
    ${cur ? `<button id="pm-wb-av-clear" style="flex:1;background:#f2f2f2;color:#ff3b30;border:none;border-radius:10px;padding:10px;font-size:13px;cursor:pointer;font-weight:600;">清除</button>` : ''}
    <button id="pm-wb-av-save" style="flex:1;background:#007aff;color:#fff;border:none;border-radius:10px;padding:10px;font-size:13px;cursor:pointer;font-weight:600;">保存</button>
  </div>
</div>`);
        const save = (url) => {
            target.avatar = url;
            window.__pmWeiboIdentityModal();   // 先回到身份页，别等写盘
            requestAnimationFrame(() => { saveWeiboIdentity(); });
        };
        document.getElementById('pm-wb-av-save')?.addEventListener('click', () => save(document.getElementById('pm-wb-av-url')?.value.trim() || ''));
        document.getElementById('pm-wb-av-clear')?.addEventListener('click', () => save(''));
        document.getElementById('pm-wb-av-file')?.addEventListener('change', (ev) => {
            const f = ev.target.files?.[0]; if (!f) return;
            const rd = new FileReader(); rd.onload = () => save(rd.result); rd.readAsDataURL(f);
        });
    }

    // ── UI：详情页 ──────────────────────────
    let __pmWbCurPost = '';
    let __pmWbReplyTo = null; // {cid} 表示正在回复某条主评论；null 表示发主评论

    // keepScroll=true 时保留滚动位置（发完评论、刷新完不要把人踢回顶部）
    window.__pmWeiboDetail = (pid, keepScroll) => {
        const post = wbFindPost(pid);
        if (!post) { wbToast('博文不存在'); return; }
        const prevScroll = keepScroll
            ? (document.querySelector('#pm-overlay .wb-detail')?.scrollTop || 0) : 0;
        __pmWbCurPost = pid;
        __pmWbReplyTo = null;
        const me = wbIsMe();
        const ident = wbCurIdent(false) || {};
        const name = wbDefaultName();
        const self = wbSelf(false) || {};
        const charMain = wbIdentOf('main') || {};
        const hasPending = (post.comments || []).some(c => (c.isSelf && !c.answered) || (c.replies || []).some(r => r.isSelf && !r.answered));

        const imgs = wbGridHtml(post.images, false, post.id);

        // isSelf = 用户自己；isOwner = 本页博主下场回复；isChar = 角色跑到用户的博文下评论
        const cAvatar = (x) => x.isSelf ? wbAvatarFor('me')
            : (x.isOwner ? wbAvatarFor(__pmWeiboAcct) : (x.isChar ? wbAvatarFor('main') : npcAvatarFor(x.name)));
        const cV = (x) => x.isSelf ? (self.vType || '')
            : (x.isOwner ? (ident.vType || '') : (x.isChar ? (charMain.vType || '') : (x.v || (x.vip ? 'red' : ''))));
        const cBadge = (x) => x.isOwner ? '<span class="wb-tag-bozhu">博主</span>' : '';

        const comments = (post.comments || []).map(c => {
            // 楼中楼也能被回复：回复它时把它的昵称记进 replyTo，渲染成「回复 @某人」
            const replyCount = (c.replies || []).length;
            // 「共 xx 条回复」纯装饰：不绑事件、不加 role，点上去没反应。
            // 总数优先用 AI 给的 replyTotal；没给就按 c.id 稳定散列造一个合理数字，
            // 免得每次重渲染数字都在跳。
            const hintTotal = (c.manyReplies || replyCount > 3)
                ? Math.max(replyCount, c.replyTotal || wbFakeReplyTotal(c.id, replyCount))
                : 0;
            const expandHint = hintTotal
                ? `<div class="wb-reply-expand" aria-hidden="true"><span class="wb-reply-dots">······</span><span class="wb-reply-count">共 ${wbNum(hintTotal)} 条回复</span></div>`
                : '';
            const subs = (c.replies || []).slice(0, 3).map(r => `
      <div class="wb-reply">
        ${wbAvatarHtml(cAvatar(r), 'wb-av-24', cV(r))}
        <div class="wb-c-main">
          <div class="wb-c-name${wbNameCls(cV(r))}">${escapeHtml(r.name)}${cBadge(r)}</div>
          <div class="wb-c-text">${r.replyTo ? `<span class="wb-rt">回复 @${escapeHtml(r.replyTo)}：</span>` : ''}${wbLinkify(r.text)}</div>
          <div class="wb-c-meta">
            <span>${escapeHtml(r.time)}</span>
            <span class="wb-c-act" onclick="event.stopPropagation();window.__pmWeiboReplyTo('${safeJS(c.id)}','${safeJS(r.name)}')" role="button" tabindex="0">回复</span>
            ${r.isSelf ? `<span class="wb-c-act wb-c-del" onclick="event.stopPropagation();window.__pmWeiboDelReply('${safeJS(c.id)}','${safeJS(r.id)}')" role="button" tabindex="0">删除</span>` : ''}
            <span class="wb-like ${r.liked ? 'is-liked' : ''}" onclick="event.stopPropagation();window.__pmWeiboLikeReply(this,'${safeJS(c.id)}','${safeJS(r.id)}')" role="button" tabindex="0" title="${r.liked ? '取消赞' : '赞'}">${wbLikeIcon(!!r.liked, 13)}<b>${wbLikeLabel(r.likes, !!r.liked)}</b></span>
          </div>
        </div>
      </div>`).join('');
            return `<div class="wb-comment">
    ${wbAvatarHtml(cAvatar(c), 'wb-av-32', cV(c))}
    <div class="wb-c-main">
      <div class="wb-c-name${wbNameCls(cV(c))}">${escapeHtml(c.name)}${cBadge(c)}</div>
      <div class="wb-c-text">${wbLinkify(c.text)}</div>
      <div class="wb-c-meta">
        <span>${escapeHtml(c.time)}${c.ip ? ' · ' + escapeHtml(c.ip) : ''}</span>
        <span class="wb-c-act" onclick="event.stopPropagation();window.__pmWeiboReplyTo('${safeJS(c.id)}','${safeJS(c.name)}')" role="button" tabindex="0">回复</span>
        ${c.isSelf ? `<span class="wb-c-act wb-c-del" onclick="event.stopPropagation();window.__pmWeiboDelComment('${safeJS(c.id)}')" role="button" tabindex="0">删除</span>` : ''}
        <span class="wb-like ${c.liked ? 'is-liked' : ''}" onclick="event.stopPropagation();window.__pmWeiboLikeComment(this,'${safeJS(c.id)}')" role="button" tabindex="0" title="${c.liked ? '取消赞' : '赞'}">${wbLikeIcon(!!c.liked, 13)}<b>${wbLikeLabel(c.likes, !!c.liked)}</b></span>
      </div>
      ${subs}
      ${expandHint || ''}
    </div>
  </div>`;
        }).join('');

        makeOverlay(`
<div class="pm-modal pm-modal-wide wb-modal${wbDarkCls()}">
  <div class="pm-modal-header">
    <span onclick="window.__pmShowWeibo()" class="wb-back" role="button" tabindex="0">‹ 返回</span>
    <span style="display:flex;align-items:center;gap:4px;">
      <span id="pm-wb-refresh" onclick="window.__pmWeiboRefresh()" title="${hasPending ? '生成网友回应' : '先发一条评论再刷新'}" class="wb-ico" role="button" tabindex="0" style="font-size:14px;${hasPending ? '' : 'opacity:.35;'}">🔄</span>
      <span onclick="window.__pmWeiboDelPost('${safeJS(pid)}')" title="删除这条微博" class="wb-ico" role="button" tabindex="0" style="font-size:16px;color:#ff3b30;">🗑</span>
      <span onclick="document.getElementById('pm-overlay').remove()" class="pm-modal-close">✕</span>
    </span>
  </div>
  <div class="pm-modal-scroll wb-detail">
    <div class="wb-card-top" style="padding:12px 14px 0;">
      ${wbAvatarHtml(wbAvatarFor(__pmWeiboAcct), 'wb-av-40', ident.vType || '')}
      <div class="wb-card-id">
        <div class="wb-uname${wbNameCls(ident.vType || '')}"><span>${escapeHtml(name)}</span></div>
        <div class="wb-meta">${escapeHtml(post.time)}${post.ip ? ' · 发布于 ' + escapeHtml(post.ip) : ''}</div>
      </div>
      ${me ? '' : `<div class="wb-follow ${ident.followed ? 'is-on' : ''}" onclick="window.__pmWeiboToggleFollow()" role="button" tabindex="0">${ident.followed ? '已关注' : '+ 关注'}</div>`}
    </div>
    <div class="wb-text" style="padding:8px 14px;">${wbLinkify(post.text)}</div>
    ${imgs}
    <div class="wb-bar" style="border-top:1px solid var(--wb-line);border-bottom:1px solid var(--wb-line);">
      <span>${wbIcon(WB_PATH_REPOST, 15)}<b>${wbNum(post.reposts)}</b></span>
      <span>${wbIcon(WB_PATH_COMMENT, 15)}<b>${wbNum(post.commentsCount)}</b></span>
      <span class="wb-like ${post.liked ? 'is-liked' : ''}" onclick="window.__pmWeiboLikePost(this)" role="button" tabindex="0" title="${post.liked ? '取消赞' : '赞'}">${wbLikeIcon(!!post.liked, 15)}<b>${wbLikeLabel(post.likes, !!post.liked)}</b></span>
    </div>
    <div class="wb-sort"><span>${(post.comments || []).length ? `全部评论 ${wbNum(post.commentsCount || (post.comments || []).length)}` : '评论'}</span><span class="wb-sort-by">${wbIcon(WB_PATH_SORT, 14)}按热度</span></div>
    <div class="wb-clist">${comments || '<div class="wb-empty" style="padding:26px 20px;"><div class="wb-empty-s" style="opacity:1;">还没有人评论<br>说点什么，然后点右上角 🔄 让网友回应你</div></div>'}</div>
  </div>
  <div class="wb-input-bar">
    <span id="pm-wb-reply-hint" class="wb-hint" style="display:none;"></span>
    <input id="pm-wb-cinput" class="wb-cinput" placeholder="说点什么…">
    <button id="pm-wb-csend" class="wb-csend">发送</button>
  </div>
</div>`);
        const inp = document.getElementById('pm-wb-cinput');
        inp?.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); window.__pmWeiboSendComment(); } });
        document.getElementById('pm-wb-csend')?.addEventListener('click', () => window.__pmWeiboSendComment());
        // 重绘后把滚动位置放回去，别让人从评论区被弹回顶部
        if (prevScroll) {
            const d = document.querySelector('#pm-overlay .wb-detail');
            if (d) d.scrollTop = prevScroll;
        }
    };

    // cid 始终是主评论 id（楼中楼平铺在主评论下，和真微博一样）；
    // toName 是实际被回复的人 —— 点主评论的「回复」就是楼主，点楼中楼的「回复」就是那层的人
    // 回复提示中昵称超过3字用...代替，避免撑爆输入框
    function wbShortReplyName(n) {
        const s = String(n || '');
        return s.length > 3 ? s.slice(0, 3) + '…' : s;
    }
    window.__pmWeiboReplyTo = (cid, toName) => {
        const c = (wbFindPost(__pmWbCurPost)?.comments || []).find(x => x.id === cid);
        __pmWbReplyTo = { cid, toName, isSub: !!c && c.name !== toName };
        const inp = document.getElementById('pm-wb-cinput');
        const hint = document.getElementById('pm-wb-reply-hint');
        const short = wbShortReplyName(toName);
        if (hint) { hint.style.display = 'inline-flex'; hint.innerHTML = `回复 ${escapeHtml(short)} <i onclick="window.__pmWeiboCancelReply()">✕</i>`; }
        if (inp) { inp.placeholder = `回复 ${short}…`; inp.focus(); }
    };
    window.__pmWeiboCancelReply = () => {
        __pmWbReplyTo = null;
        const hint = document.getElementById('pm-wb-reply-hint');
        const inp = document.getElementById('pm-wb-cinput');
        if (hint) hint.style.display = 'none';
        if (inp) inp.placeholder = '说点什么…';
    };

    // 关注：纯 UI 状态，不进 prompt，不影响 AI 生成
    window.__pmWeiboToggleFollow = async () => {
        const ident = wbIdentity(true);
        ident.followed = !ident.followed;
        saveWeiboIdentity();
        wbToast(ident.followed ? '已关注' : '已取消关注');
        window.__pmWeiboDetail(__pmWbCurPost, true);
    };

    window.__pmWeiboSendComment = async () => {
        const post = wbFindPost(__pmWbCurPost); if (!post) return;
        const inp = document.getElementById('pm-wb-cinput');
        const txt = inp?.value.trim(); if (!txt) return;
        const me = wbSelfName(); // 用户以自己设的身份出现在评论区（默认普通网友）
        if (__pmWbReplyTo) {
            const target = (post.comments || []).find(c => c.id === __pmWbReplyTo.cid);
            if (target) {
                if (!Array.isArray(target.replies)) target.replies = [];
                // 回主评论不写 replyTo（跟真微博一致）；回楼中楼里的人才标出「回复 @谁」
                target.replies.push({
                    id: wbUid(), name: me, text: txt, time: '刚刚', likes: 0,
                    replyTo: __pmWbReplyTo.isSub ? (__pmWbReplyTo.toName || '') : '',
                    liked: false, isSelf: true, isOwner: false, answered: false,
                });
            }
        } else {
            if (!Array.isArray(post.comments)) post.comments = [];
            post.comments.push({ id: wbUid(), name: me, text: txt, ip: '', time: '刚刚', likes: 0, vip: false, liked: false, isSelf: true, isOwner: false, answered: false, replies: [] });
            post.commentsCount = (post.commentsCount || 0) + 1;
        }
        if (inp) inp.value = '';
        await saveWeiboPosts();
        window.__pmWeiboDetail(__pmWbCurPost, true); // 保留滚动位置
    };

    window.__pmWeiboRefresh = async () => {
        const post = wbFindPost(__pmWbCurPost); if (!post) return;
        const hasPending = (post.comments || []).some(c => (c.isSelf && !c.answered) || (c.replies || []).some(r => r.isSelf && !r.answered));
        if (!hasPending) { wbToast('先发一条评论或回复，再刷新'); return; }
        if (__pmWeiboBusy) return;
        __pmWeiboBusy = true;
        const btn = document.getElementById('pm-wb-refresh');
        if (btn) { btn.innerHTML = '<i class="wb-spin"></i>'; btn.style.opacity = '1'; }
        const lockAcct = __pmWeiboAcct;
        try {
            const { added } = await wbRefreshComments(post, lockAcct);
            await Promise.all([saveWeiboPosts(), saveWeiboIdentity()]);
            window.__pmWeiboDetail(__pmWbCurPost, true);
            if (!added) wbToast('这次没人搭话');
        } catch (e) {
            if (btn) { btn.textContent = '🔄'; btn.style.opacity = '1'; }
            wbToast('刷新失败：' + (e.message || e));
        } finally { __pmWeiboBusy = false; }
    };

    // 点赞就地改这一个节点：整页重绘会把人弹回顶部，而且长评论区重绘明显卡手。
    // obj 是被点的那条数据，el 是被点的那个 <span>，base 是原始赞数。
    // 赞数显示规则：只有显示到个位（base < 10000）时，点赞才 +1。
    // 一旦进了万/亿档，wbNum 的精度是 0.1万 = 1000，单人一赞看不出来，
    // 强行 base+1 再格式化会出现 2.4万→2.5万 这种离谱跳变，所以万档以上数字不动，
    // 只靠图标变色反馈。同时避开 9999 +1 → "1万" 的突跳。
    function wbLikeLabel(base, liked) {
        if (base < 10000) return String(base + (liked ? 1 : 0));
        return wbNum(base);
    }

    // 「共 xx 条回复」的兜底总数。AI 没给 replyTotal 时按评论 id 散列造一个，
    // 同一条评论每次重渲染都得到同一个数字，不然刷一下列表数字就在跳。
    // 范围压在 120-3200，对应"明星前排评论几百到几千条回复"的量级。
    function wbFakeReplyTotal(id, floor) {
        let h = 0;
        const s = String(id || '');
        for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) & 0x7fffffff;
        return Math.max(Number(floor) || 0, 120 + (h % 3081));
    }
    function wbApplyLike(el, obj, base, iconSize) {
        obj.liked = !obj.liked;
        if (el) {
            const size = iconSize || (el.closest('.wb-bar') ? 15 : 13);
            el.classList.toggle('is-liked', obj.liked);
            el.title = obj.liked ? '取消赞' : '赞';
            el.innerHTML = `${wbLikeIcon(obj.liked, size)}<b>${wbLikeLabel(base, obj.liked)}</b>`;
        }
        saveWeiboPosts();
    }
    // 列表页点赞：按 id 找到博文再调用 wbApplyLike
    window.__pmWeiboLikeFeed = (el, pid) => {
        const post = wbFindPost(pid);
        if (!post) return;
        wbApplyLike(el, post, post.likes);
    };
    window.__pmWeiboLikePost = (el) => {
        const post = wbFindPost(__pmWbCurPost); if (!post) return;
        wbApplyLike(el, post, post.likes);
    };
    window.__pmWeiboLikeComment = (el, cid) => {
        const post = wbFindPost(__pmWbCurPost); if (!post) return;
        const c = (post.comments || []).find(x => x.id === cid); if (!c) return;
        wbApplyLike(el, c, c.likes);
    };
    window.__pmWeiboLikeReply = (el, cid, rid) => {
        const post = wbFindPost(__pmWbCurPost); if (!post) return;
        const c = (post.comments || []).find(x => x.id === cid); if (!c) return;
        const r = (c.replies || []).find(x => x.id === rid); if (!r) return;
        wbApplyLike(el, r, r.likes);
    };
    // 删除自己的评论（连带它的楼中楼回复一起删，不弹确认）
    window.__pmWeiboDelComment = async (cid) => {
        const post = wbFindPost(__pmWbCurPost); if (!post) return;
        const arr = post.comments || [];
        const i = arr.findIndex(x => x.id === cid);
        if (i < 0 || !arr[i].isSelf) return;
        arr.splice(i, 1);
        await saveWeiboPosts();
        window.__pmWeiboDetail(__pmWbCurPost, true);
    };
    // 删除自己的楼中楼回复
    window.__pmWeiboDelReply = async (cid, rid) => {
        const post = wbFindPost(__pmWbCurPost); if (!post) return;
        const c = (post.comments || []).find(x => x.id === cid); if (!c) return;
        const arr = c.replies || [];
        const i = arr.findIndex(x => x.id === rid);
        if (i < 0 || !arr[i].isSelf) return;
        arr.splice(i, 1);
        await saveWeiboPosts();
        window.__pmWeiboDetail(__pmWbCurPost, true);
    };
    // 删除微博：与详情页删除按钮共用逻辑
    window.__pmWeiboDelPost = async (pid) => {
        const arr = wbPosts(false);
        const i = arr.findIndex(p => p.id === pid);
        if (i > -1) { arr.splice(i, 1); await saveWeiboPosts(); }
        window.__pmShowWeibo();
    };

    // ── 我的页面：发微博 + 收评论 ──────────────────────────
    // 发微博弹窗：可写正文+选图（最多9张）
    let __pmComposeImages = [];
    window.__pmWeiboCompose = () => {
        __pmComposeImages = [];
        const me = wbIsMe();
        makeOverlay(`
<div class="pm-modal pm-modal-wide wb-modal${wbDarkCls()}" style="height:auto;max-height:85dvh;">
  <div class="pm-modal-header">
    <b>发微博</b>
    <span onclick="window.__pmShowWeibo()" class="pm-modal-close">✕</span>
  </div>
  <div class="pm-modal-scroll wb-form" style="padding:14px 16px;">
    <div class="pm-cfg-label">正文</div>
    <textarea id="pm-wb-compose-text" class="pm-cfg-input" rows="5" style="resize:vertical;font-family:inherit;font-size:14px;line-height:1.6;" placeholder="${me ? '说点什么…' : '以角色身份发一条微博…'}"></textarea>
    <div style="font-size:11px;color:var(--wb-sub);text-align:right;"><span id="pm-wb-compose-count">0</span>/500</div>
    <div class="pm-cfg-label" style="display:flex;align-items:center;justify-content:space-between;">
      <span>配图（最多9张）</span>
      <button onclick="window.__pmWbOpenGallery()" style="background:var(--wb-blue,#507daf);color:#fff;border:none;border-radius:7px;padding:4px 10px;font-size:11px;cursor:pointer;font-weight:600;">🖼 从图库选</button>
    </div>
    <div id="pm-wb-compose-grid" style="display:flex;flex-wrap:wrap;gap:6px;min-height:50px;">
      <label id="pm-wb-compose-addimg" style="width:72px;height:72px;border:1.5px dashed var(--wb-input-bd);border-radius:8px;display:flex;flex-direction:column;align-items:center;justify-content:center;cursor:pointer;color:var(--wb-sub);font-size:22px;flex-shrink:0;transition:background .18s;">
        <span style="font-size:24px;line-height:1;">+</span>
        <span style="font-size:10px;margin-top:2px;">本地</span>
        <input id="pm-wb-compose-file" type="file" accept="image/*" multiple style="display:none;">
      </label>
    </div>
    <div class="pm-cfg-tip" style="text-align:left;">可从表情包图库选图，也可上传本地图片。点右上角 ✕ 删除。</div>
    <div class="pm-cfg-label">属地（选填）</div>
    <input id="pm-wb-compose-ip" class="pm-cfg-input" type="text" maxlength="10" placeholder="例如：四川。留空则不显示属地">
  </div>
  <div class="pm-modal-add" style="display:flex;gap:8px;">
    <button onclick="window.__pmWeiboCancelCompose()" style="flex:1;background:#f2f2f2;color:#555;border:none;border-radius:10px;padding:10px;font-size:13px;cursor:pointer;font-weight:600;">取消</button>
    <button id="pm-wb-compose-send" onclick="window.__pmWeiboDoCompose()" style="flex:2;background:var(--wb-orange);color:#fff;border:none;border-radius:10px;padding:10px;font-size:13px;cursor:pointer;font-weight:600;">发送</button>
  </div>
</div>`);
        const ta = document.getElementById('pm-wb-compose-text');
        const count = document.getElementById('pm-wb-compose-count');
        ta?.addEventListener('input', () => {
            const t = ta.value.slice(0, 500); ta.value = t;
            if (count) count.textContent = t.length;
        });
        const fileInput = document.getElementById('pm-wb-compose-file');
        const grid = document.getElementById('pm-wb-compose-grid');
        fileInput?.addEventListener('change', (e) => {
            const files = Array.from(e.target.files || []);
            if (!files.length) return;
            const remaining = 9 - __pmComposeImages.length;
            const take = files.slice(0, remaining);
            take.forEach(f => {
                const rd = new FileReader();
                rd.onload = (ev) => {
                    __pmComposeImages.push(ev.target.result);
                    renderComposeGrid();
                };
                rd.readAsDataURL(f);
            });
            fileInput.value = '';
        });
        renderComposeGrid();
    };

    // 渲染配图缩略图网格（模块级，供 window 处理器复用）
    function renderComposeGrid() {
        const grid = document.getElementById('pm-wb-compose-grid');
        if (!grid) return;
        const addBtn = grid.querySelector('#pm-wb-compose-addimg');
        grid.querySelectorAll('.pm-compose-img-item').forEach(el => el.remove());
        __pmComposeImages.forEach((url, i) => {
            const div = document.createElement('div');
            div.className = 'pm-compose-img-item';
            div.style.cssText = 'position:relative;width:72px;height:72px;border-radius:8px;overflow:hidden;flex-shrink:0;';
            div.innerHTML = `<img src="${escapeAttr(url)}" style="width:100%;height:100%;object-fit:cover;display:block;border-radius:8px;">
              <span onclick="window.__pmWbRemoveComposeImg(${i})" style="position:absolute;top:-3px;right:-3px;width:20px;height:20px;border-radius:50%;background:#ff3b30;color:#fff;font-size:11px;display:flex;align-items:center;justify-content:center;border:2px solid #fff;cursor:pointer;line-height:1;">✕</span>`;
            grid.insertBefore(div, addBtn);
        });
        if (addBtn) addBtn.style.display = __pmComposeImages.length >= 9 ? 'none' : 'flex';
    }
    window.__pmWbRemoveComposeImg = (i) => {
        __pmComposeImages.splice(i, 1);
        renderComposeGrid();
        wbSyncGalleryTicks();
    };
    // 用户图库选图：读表情包套组，叠在发微博弹窗之上（子浮层，不销毁 #pm-overlay）
    window.__pmWbOpenGallery = () => {
        if (__pmComposeImages.length >= 9) { wbToast('最多九张'); return; }
        const sets = (window.__pmEmojis || []).filter(s => (s.images || []).length);
        const ov = document.createElement('div'); ov.id = 'pm-overlay-sub';
        if (typeof HTMLElement !== 'undefined' && HTMLElement.prototype.hasOwnProperty('popover')) ov.setAttribute('popover', 'manual');
        ov.style.cssText = 'position:fixed !important; inset:0 !important; margin:0 !important; padding:0 !important; border:none !important; width:100vw !important; height:100vh !important; max-width:none !important; max-height:none !important; background:rgba(0,0,0,.45) !important; z-index:2147483648 !important; display:flex !important; align-items:center !important; justify-content:center !important;';
        const body = sets.length ? sets.map((set, si) => `
        <div style="margin-bottom:12px;">
          <div style="font-weight:600;font-size:12px;color:#666;margin-bottom:6px;">${escapeHtml(set.name)}</div>
          <div style="display:flex;flex-wrap:wrap;gap:8px;">
            ${(set.images || []).map((img, ii) => `
              <div class="wb-gal-cell${__pmComposeImages.includes(img.url) ? ' is-picked' : ''}" data-url="${escapeAttr(img.url)}" onclick="window.__pmWbPickGalleryImg(${si},${ii})" title="${escapeAttr(img.desc || '')}">
                <img src="${escapeAttr(img.url)}">
                <span class="wb-gal-tick">✓</span>
              </div>
            `).join('')}
          </div>
        </div>`).join('') : '<div style="text-align:center;color:#aaa;font-size:13px;padding:24px 0;">图库还是空的，先去「表情包管理」添加图片</div>';
        ov.innerHTML = `
<div class="pm-modal">
  <div class="pm-modal-header">
    <b>选择配图（还可选 ${9 - __pmComposeImages.length} 张）</b>
    <span onclick="document.getElementById('pm-overlay-sub')?.remove()" class="pm-modal-close">✕</span>
  </div>
  <div class="pm-modal-scroll" style="padding:14px 16px;max-height:60dvh;overflow-y:auto;">${body}</div>
</div>`;
        document.body.appendChild(ov);
        if (ov.showPopover) { try { ov.showPopover(); } catch (e) {} }
    };
    // 再点一次已选中的图 = 取消选择，勾就地加/去，不重绘整个选图器
    window.__pmWbPickGalleryImg = (si, ii) => {
        const sets = (window.__pmEmojis || []).filter(s => (s.images || []).length);
        const url = sets[si]?.images?.[ii]?.url;
        if (!url) return;
        const at = __pmComposeImages.indexOf(url);
        if (at >= 0) __pmComposeImages.splice(at, 1);
        else {
            if (__pmComposeImages.length >= 9) { wbToast('最多九张'); return; }
            __pmComposeImages.push(url);
        }
        renderComposeGrid();
        wbSyncGalleryTicks();
    };
    // 按 __pmComposeImages 把选图器里的勾刷新一遍（同一张图可能出现在多个套组里）
    function wbSyncGalleryTicks() {
        const sub = document.getElementById('pm-overlay-sub');
        if (!sub) return;
        sub.querySelectorAll('.wb-gal-cell').forEach(el => {
            el.classList.toggle('is-picked', __pmComposeImages.includes(el.dataset.url || ''));
        });
        const hdr = sub.querySelector('.pm-modal-header b');
        if (hdr) hdr.textContent = `选择配图（还可选 ${9 - __pmComposeImages.length} 张）`;
    }
    window.__pmWeiboCancelCompose = () => { __pmComposeImages = []; window.__pmShowWeibo(); };
    window.__pmWeiboDoCompose = async () => {
        const ta = document.getElementById('pm-wb-compose-text');
        const text = ta?.value.trim();
        if (!text) { wbToast('请输入微博正文'); return; }
        // 属地选填：只存纯地名，渲染处会自己加「发布于 」前缀
        const ipRaw = (document.getElementById('pm-wb-compose-ip')?.value || '').trim();
        const ipVal = ipRaw.replace(/^发布于\s*/, '').trim();
        const btn = document.getElementById('pm-wb-compose-send');
        if (btn) { btn.textContent = '发送中…'; btn.disabled = true; btn.style.opacity = '.6'; }
        try {
            const post = wbNormalizePost({
                text, images: __pmComposeImages,
                // 属地由用户选填，留空则 wb-meta 那边整段不渲染
                ip: ipVal, time: new Date().toISOString().slice(0, 10).replace(/-/g, '-') + ' ' + new Date().toTimeString().slice(0, 5),
                likes: 0, comments_count: 0, reposts: 0, comments: [],
            });
            post.createdAt = Date.now();
            const arr = wbPosts(true, __pmWeiboAcct);
            arr.push(post);
            while (arr.length > PM_WB_MAX_POSTS) arr.shift();
            await saveWeiboPosts();
            __pmComposeImages = [];
            wbToast('微博已发送');
            window.__pmShowWeibo();
        } catch (e) { wbToast('发送失败：' + (e.message || e)); }
    };

    // 收评论：从最早的未评论微博开始，AI最多回复5条
    window.__pmWeiboReplyMine = async () => {
        if (__pmWeiboBusy) return;
        const posts = wbPosts(false, __pmWeiboAcct);
        // 找还没人评论过的微博，从早到晚排序
        const uncommented = posts
            .map((p, i) => ({ post: p, idx: i }))
            .filter(({ post }) => !post.comments || post.comments.length === 0)
            .sort((a, b) => (a.post.createdAt || 0) - (b.post.createdAt || 0));
        if (!uncommented.length) { wbToast('没有需要收评论的微博'); return; }
        const targets = uncommented.slice(0, 5);
        __pmWeiboBusy = true;
        const btn = document.getElementById('pm-wb-refresh-btn');
        const feed = document.querySelector('#pm-overlay .wb-feed');
        if (btn) { btn.textContent = `收评论中…（${targets.length}条）`; btn.disabled = true; btn.style.opacity = '.6'; }
        if (feed) { feed.insertAdjacentHTML('afterbegin', `<div id="pm-wb-skel" class="wb-loading"><i class="wb-spin"></i><span>收评论中…</span></div>`); feed.scrollTop = 0; }
        // 锁定账号 + context 只取一次：循环里每条都重建 context 是白跑
        const lockAcct = __pmWeiboAcct;
        try {
            let success = 0;
            const { ctx } = await wbBuildContext(lockAcct);
            const me = wbSelfName();
            const acctName = wbDefaultName(lockAcct);
            for (const { post } of targets) {
                const userPrompt = `【角色卡】
${ctx.cardDesc}
${ctx.cardPersonality}

【世界书】
${ctx.worldBookText || '（无）'}

【主线剧情最近对话】
${ctx.mainChatText || '（无）'}

【用户】${ctx.userName}

发博账号：${acctName}

【微博正文】
${post.text}

要求：以网友的身份，为这条微博生成 6-12 条主评论。评论要口语化、有生活气息，像真实微博评论区。用户「${me}」是一个普通网友，用户名是其在这个场景中的称呼${wbSelfIdentityText() !== '一个普通网友（无特殊身份）' ? '，身份是：' + wbSelfIdentityText() : ''}。不要每条都夸，可以有调侃、不同意见、玩梗。

输出 JSON：
{
  "comments": [
    {"name":"网友昵称","text":"评论内容","ip":"广东","time":"刚刚","likes":3,"vip":false,"replies":[],"manyReplies":false,"replyTotal":0}
  ]
}
comments 给 6-12 条。每条不超过 50 字。`;
                const raw = await callAI(wbSystemPrompt(), userPrompt, { maxTokens: 1200 });
                const o = wbParseJSON(raw);
                const cs = Array.isArray(o.comments) ? o.comments : [];
                post.comments = (post.comments || []).concat(cs.slice(0, 14).map(c => wbNormalizeComment(c)));
                post.commentsCount = post.comments.length;
                success++;
            }
            await saveWeiboPosts();
            window.__pmShowWeibo();
            wbToast(`收评论完成：${success} 条微博有了评论`);
        } catch (e) {
            document.getElementById('pm-wb-skel')?.remove();
            if (btn) { btn.textContent = '🔄 收评论'; btn.disabled = false; btn.style.opacity = '1'; }
            wbToast('收评论失败：' + (e.message || e));
        } finally { __pmWeiboBusy = false; }
    };

    // ══════════════════════ CSS ══════════════════════
    if (!document.getElementById('pm-css')) {
        const s = document.createElement('style'); s.id = 'pm-css';
        s.textContent = `
[popover]{border:none;padding:0;background:transparent;color:inherit;margin:0;overflow:visible;}
[popover]::backdrop{display:none;background:transparent;}
#pm-iphone{
    --pm-r-bg:#007aff;--pm-l-bg:#e9e9eb;--pm-r-txt:#fff;--pm-l-txt:#000;--pm-border:#1a1a1a;--pm-frost:0;
    position:fixed !important;inset:auto 40px 40px auto !important;margin:0 !important;transform:none !important;
    width:330px !important;height:580px !important;min-width:330px !important;max-width:330px !important;min-height:580px !important;max-height:580px !important;
    background:#fff !important;border:10px solid var(--pm-border) !important;border-radius:45px !important;z-index:2147483647 !important;
    display:flex !important;flex-direction:column !important;visibility:visible !important;opacity:1 !important;overflow:hidden !important;
    box-shadow:0 20px 60px rgba(0,0,0,.45) !important;transition:.35s cubic-bezier(.18,.89,.32,1.2);
    font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif !important;
    touch-action:none;box-sizing:border-box !important;pointer-events:auto !important;filter:none !important;color:#000 !important;
}

#pm-iphone[data-theme="light"] {
    --pm-bg: #fff;
    --pm-navbar-bg: #fff;
    --pm-navbar-border: #f0f0f0;
    --pm-input-bg: #f2f2f7;
    --pm-list-bg: #fff;
    --pm-text: #000;
    --pm-name-color: #000;
}

#pm-iphone[data-theme="dark"] {
    --pm-bg: #1c1c1e;
    --pm-navbar-bg: #1c1c1e;
    --pm-navbar-border: #38383a;
    --pm-input-bg: #2c2c2e;
    --pm-list-bg: #1c1c1e;
    --pm-text: #e5e5e5;
    --pm-name-color: #ccc;
}

#pm-iphone{background:var(--pm-bg,#fff) !important;}
.pm-main-ui{background:var(--pm-bg,#fff) !important;}
.pm-navbar{background:var(--pm-navbar-bg,#fff) !important;border-bottom-color:var(--pm-navbar-border,#f0f0f0) !important;}
.pm-name{color:var(--pm-name-color,#000) !important;}
.pm-input{background:var(--pm-input-bg,#f2f2f7) !important;color:var(--pm-text,#000) !important;}


#pm-iphone[data-theme="dark"] .pm-li:hover{background:#2c2c2e;}
#pm-iphone[data-theme="dark"] .pm-modal{background:#1c1c1e !important;color:#e5e5e5 !important;}
#pm-iphone[data-theme="dark"] .pm-modal-header{border-bottom-color:#38383a !important;}
#pm-iphone[data-theme="dark"] .pm-modal-header b{color:#e5e5e5 !important;}
#pm-iphone[data-theme="dark"] .pm-cfg-input{background:#2c2c2e !important;color:#e5e5e5 !important;border-color:#48484a !important;}
#pm-iphone[data-theme="dark"] .pm-cfg-label{color:#aaa !important;}
#pm-iphone[data-theme="dark"] .pm-cfg-tab{color:#aaa !important;}
#pm-iphone[data-theme="dark"] .pm-cfg-tab-active{color:#0a84ff !important;}
#pm-iphone[data-theme="dark"] .pm-cfg-tabs{border-bottom-color:#38383a !important;}
#pm-iphone[data-theme="dark"] .pm-layout-chip,#pm-iphone[data-theme="dark"] .pm-theme-chip{background:#2c2c2e !important;color:#ccc !important;}
#pm-iphone[data-theme="dark"] .pm-layout-active,#pm-iphone[data-theme="dark"] .pm-theme-active{border-color:#0a84ff !important;color:#0a84ff !important;background:#1c2a3a !important;}
#pm-iphone[data-theme="dark"] .pm-bg-btn{background:#2c2c2e !important;border-color:#48484a !important;color:#ccc !important;}
#pm-iphone[data-theme="dark"] .pm-prof-list{background:#2c2c2e !important;border-color:#48484a !important;}
#pm-iphone[data-theme="dark"] .pm-prof-li:hover{background:#3a3a3c !important;}
#pm-iphone[data-theme="dark"] .pm-mode-switch{background:#2c2c2e !important;}
#pm-iphone[data-theme="dark"] .pm-mode-opt{color:#aaa !important;}
#pm-iphone[data-theme="dark"] .pm-mode-active{background:#3a3a3c !important;color:#0a84ff !important;}
#pm-iphone[data-theme="dark"] .pm-bi-bar{background:#2c2410 !important;border-bottom-color:#4a3a10 !important;color:#b8902a !important;}
#pm-iphone[data-theme="dark"] .pm-confirm-bar{background:#2c2410 !important;border-bottom-color:#4a3a10 !important;}
#pm-iphone[data-theme="dark"] .pm-note{color:#666 !important;}
#pm-iphone[data-theme="dark"] .pm-group-name{color:#aaa !important;}
#pm-iphone[data-theme="dark"] .pm-island{background:#48484a;}

/* ── UI 精调 ── */
.pm-bubble{box-shadow:0 .5px 1.5px rgba(0,0,0,.06);}
.pm-right.pm-bubble{border-bottom-right-radius:6px !important;}
.pm-left.pm-bubble{border-bottom-left-radius:6px !important;}
.pm-msg-list{padding:14px 12px !important;gap:9px;}
.pm-msg-list .pm-note{padding:5px 0;}
.pm-group-name{font-size:10.5px;letter-spacing:.2px;opacity:.75;}
.pm-cfg-label{font-size:11.5px;font-weight:600;color:#555;letter-spacing:.1px;margin-bottom:-3px;padding:0 2px;}
.pm-cfg-input{border:1px solid #e2e2e5 !important;border-radius:11px !important;padding:10px 13px;font-size:13.5px !important;transition:border-color .2s,box-shadow .2s;}
.pm-cfg-input:focus{border-color:#007aff !important;box-shadow:0 0 0 3px rgba(0,122,255,.15);}
#pm-iphone[data-theme="dark"] .pm-cfg-input:focus{border-color:#0a84ff !important;box-shadow:0 0 0 3px rgba(10,132,255,.2);}
.pm-li{gap:12px;padding:11px 12px;border-radius:14px;}
.pm-li > span{font-size:14.5px !important;}
.pm-li > span small,.pm-group-sub{font-size:11px !important;line-height:1.4;margin-top:1px;}
.pm-modal-add{padding:14px 16px 18px;}
.pm-modal-add button,.pm-btn-group,.pm-btn-add{border-radius:12px !important;padding:11px 14px !important;font-size:13px !important;}
.pm-modal-scroll{padding:4px 0;}
.pm-modal-header{padding:14px 16px 10px !important;}
.pm-modal-header b{font-size:15px !important;}
.pm-cfg-tabs{padding:0 12px;}
.pm-cfg-tab{padding:11px 0;font-size:12.5px;}
.pm-mode-switch{border-radius:14px;padding:4px;gap:4px;}
.pm-mode-opt{padding:10px 0;border-radius:10px;font-size:12.5px;}
.pm-select-wrap{gap:8px;}
.pm-custom-check{width:22px;height:22px;border-width:2.5px;}
.pm-bg-btn,.pm-theme-chip,.pm-layout-chip{border-radius:10px;}
.pm-prof-list{border-radius:12px;padding:6px;}
.pm-prof-li{padding:8px 10px;border-radius:10px;}
.pm-color-pick{width:36px;height:32px;border-radius:8px;}
#pm-model-arrow{border-radius:12px;width:40px;}
.pm-model-opt{padding:9px 14px;font-size:13px;border-radius:6px;margin:1px 4px;border-bottom:none;height:auto;line-height:1.4;}
.pm-model-opt:hover{background:#f0f7ff;}

#pm-iphone.is-min{inset:auto 40px 40px auto !important;height:50px !important;min-height:50px !important;max-height:50px !important;width:140px !important;min-width:140px !important;max-width:140px !important;border-radius:25px !important;border-width:6px !important;}
#pm-iphone.is-min .pm-main-ui{display:none !important;}
#pm-iphone *,#pm-iphone *::before,#pm-iphone *::after{box-sizing:border-box;}
.pm-island{width:100px;height:28px;background:#1a1a1a;margin:8px auto 4px;border-radius:14px;cursor:move;flex-shrink:0;touch-action:none;}
.pm-main-ui{flex:1 !important;display:flex !important;flex-direction:column !important;overflow:hidden;min-height:0;}
.pm-navbar{position:relative;display:flex !important;align-items:center;padding:6px 10px;border-bottom:1px solid #f0f0f0;flex-shrink:0;min-height:38px;}
.pm-nav-left{display:flex;gap:4px;align-items:center;margin-right:auto;}
#pm-iphone[data-layout="relaxed"] .pm-nav-left{gap:10px;}
.pm-nav-right{display:flex;gap:4px;justify-content:flex-end;margin-left:auto;}
.pm-name-wrap{position:absolute !important;left:50%;top:50%;transform:translate(-50%,-50%);display:inline-flex;align-items:center;max-width:60%;pointer-events:auto;}
.pm-name{font-weight:700 !important;font-size:15px !important;text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%;}
.pm-name-edit{background:#f0f0f3 !important;border:none !important;color:#666 !important;cursor:pointer;padding:5px !important;line-height:1;flex-shrink:0;border-radius:50% !important;width:24px;height:24px;display:inline-flex;align-items:center;justify-content:center;transition:all .2s;position:absolute;left:100%;margin-left:8px;}
.pm-name-edit.is-hidden{display:none !important;}
.pm-name-edit:hover{background:#007aff !important;color:#fff !important;transform:scale(1.05);}
.pm-name-edit svg{display:block;}
#pm-iphone[data-layout="relaxed"] .pm-nav-right{gap:10px;}
#pm-iphone[data-layout="relaxed"] .pm-navbar{padding:8px 14px;min-height:44px;}
.pm-nav-btn{background:none !important;border:none !important;font-size:18px !important;cursor:pointer;color:#007aff !important;padding:3px !important;line-height:1;flex-shrink:0;}
.pm-confirm-bar{background:#fff8f0;border-bottom:1px solid #ffe0b0;padding:7px 12px;align-items:center;gap:8px;flex-shrink:0;}
.pm-confirm-tip{flex:1;font-size:12px;color:#888;}
.pm-confirm-btn{background:#ff3b30 !important;color:#fff !important;border:none;border-radius:8px;padding:5px 12px;font-size:12px;cursor:pointer;font-weight:600;}
.pm-cancel-btn{background:#f0f0f0 !important;color:#333 !important;border:none;border-radius:8px;padding:5px 12px;font-size:12px;cursor:pointer;}
.pm-msg-list{flex:1 !important;overflow-y:auto !important;padding:12px !important;display:flex !important;flex-direction:column !important;gap:7px;background:var(--pm-list-bg,#fff) !important;min-height:0;background-size:cover;background-position:center;}
.pm-select-wrap{display:flex !important;align-items:flex-end;gap:6px;}
.pm-custom-check{width:20px;height:20px;border-radius:50%;border:2px solid #ccc;cursor:pointer;flex-shrink:0;margin-bottom:4px;transition:all .15s;position:relative;background:#fff !important;}
.pm-custom-check[data-checked="1"],.pm-custom-check.is-checked{border-color:#007aff;background:#007aff !important;}
.pm-custom-check[data-checked="1"]::after,.pm-custom-check.is-checked::after{content:'✓';position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#fff;font-size:12px;font-weight:bold;}
.pm-bi-style{border-color:#e0a030;}.pm-bi-style.is-checked{border-color:#ff9500;background:#ff9500 !important;}
.pm-bubble{max-width:74% !important;padding:9px 13px;border-radius:18px !important;font-size:14px !important;line-height:1.45;word-break:break-word;animation:pm-pop .22s ease-out;}
.pm-bubble.pm-special{background:transparent !important;box-shadow:none !important;padding:0 !important;}
@keyframes pm-pop{from{opacity:0;transform:scale(.92) translateY(4px)}to{opacity:1;transform:scale(1) translateY(0)}}
.pm-right{align-self:flex-end !important;background:var(--pm-r-bg) !important;color:var(--pm-r-txt) !important;border-bottom-right-radius:4px !important;}
.pm-left{align-self:flex-start !important;background:var(--pm-l-bg) !important;color:var(--pm-l-txt) !important;border-bottom-left-radius:4px !important;}
#pm-iphone[style*="--pm-frost: 1"] .pm-right,#pm-iphone[style*="--pm-frost: 1"] .pm-left{backdrop-filter:blur(12px) saturate(1.4);-webkit-backdrop-filter:blur(12px) saturate(1.4);}
.pm-group-bubble-wrap{align-self:flex-start !important;display:flex !important;flex-direction:column !important;gap:2px;max-width:78% !important;width:fit-content !important;align-items:flex-start !important;}
.pm-group-bubble-wrap .pm-bubble{max-width:none !important;width:auto !important;align-self:flex-start !important;}
.pm-group-name{font-size:11px;color:#999;padding-left:6px;font-weight:500;white-space:nowrap;}
.pm-typing-bubble{display:flex !important;gap:5px;align-items:center;padding:11px 15px !important;width:fit-content;}
.pm-typing-bubble span{width:7px;height:7px;border-radius:50%;background:#999;display:inline-block;animation:pm-bounce 1.2s infinite;}
.pm-typing-bubble span:nth-child(2){animation-delay:.2s;}.pm-typing-bubble span:nth-child(3){animation-delay:.4s;}
@keyframes pm-bounce{0%,60%,100%{transform:translateY(0)}30%{transform:translateY(-5px)}}
.pm-note{text-align:center;font-size:11px;color:#bbb;padding:3px 0;}
.pm-director{display:flex;align-items:center;justify-content:center;gap:5px;padding:5px 10px;margin:2px 4px;background:rgba(88,86,214,0.08);border:1px solid rgba(88,86,214,0.18);border-radius:12px;animation:pm-pop .22s ease-out;}
.pm-director-icon{font-size:12px;flex-shrink:0;}
.pm-director-text{font-size:11px;color:#5856d6;font-style:italic;text-align:center;line-height:1.4;word-break:break-word;}
#pm-iphone[data-theme="dark"] .pm-director{background:rgba(88,86,214,0.15);border-color:rgba(88,86,214,0.3);}
#pm-iphone[data-theme="dark"] .pm-director-text{color:#a29bfe;}
@keyframes pm-spin{from{transform:rotate(0deg);}to{transform:rotate(360deg);}}
.pm-transfer-card{background:linear-gradient(135deg,#ff9500,#ff6b00);color:#fff;border-radius:14px;padding:12px 14px;display:flex;align-items:center;gap:10px;min-width:150px;box-shadow:0 3px 10px rgba(255,149,0,.35);}
.pm-receive-card{background:linear-gradient(135deg,#34c759,#28a745);color:#fff;border-radius:14px;padding:12px 14px;display:flex;align-items:center;gap:10px;min-width:150px;box-shadow:0 3px 10px rgba(52,199,89,.35);}
.pm-refund-card{background:linear-gradient(135deg,#ff9500,#ff6b00);color:#fff;border-radius:14px;padding:12px 14px;display:flex;align-items:center;gap:10px;min-width:150px;box-shadow:0 3px 10px rgba(255,149,0,.35);}
.pm-t-icon{width:34px;height:34px;background:rgba(255,255,255,.25);border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:17px;font-weight:800;}
.pm-t-info{display:flex;flex-direction:column;gap:1px;}.pm-t-info b{font-size:12px;opacity:.85;}.pm-t-info span{font-size:17px;font-weight:700;}
.pm-img-card{background:#f2f2f7;border:1px solid #e0e0e0;padding:12px 14px;border-radius:14px;color:#555;font-size:13px;text-align:center;}
.pm-voice-wrap{display:flex;flex-direction:column;gap:4px;align-items:inherit;}
.pm-voice-row{display:flex;align-items:center;gap:6px;}
.pm-special.pm-right .pm-voice-wrap{align-items:flex-end;}.pm-special.pm-left .pm-voice-wrap{align-items:flex-start;}
.pm-voice-play{font-size:15px;cursor:pointer;opacity:.7;transition:opacity .15s;user-select:none;flex-shrink:0;}
.pm-voice-play:hover{opacity:1;}
.pm-voice-card{display:flex !important;align-items:center !important;flex-direction:row !important;flex-wrap:nowrap !important;gap:10px;padding:10px 14px;border-radius:18px;cursor:pointer;user-select:none;transition:filter .15s;white-space:nowrap;}
.pm-voice-card:hover{filter:brightness(.96);}
.pm-voice-right{background:var(--pm-r-bg);color:var(--pm-r-txt);border-bottom-right-radius:4px;flex-direction:row-reverse !important;}
.pm-voice-left{background:var(--pm-l-bg);color:var(--pm-l-txt);border-bottom-left-radius:4px;}
.pm-voice-icon{font-size:14px;flex-shrink:0;line-height:1;}
.pm-voice-wave{flex:1 1 auto;display:flex !important;flex-direction:row !important;gap:3px;align-items:center;height:16px;min-width:30px;}
.pm-voice-wave i{display:inline-block;width:3px;background:currentColor;opacity:.7;border-radius:2px;animation:pm-wave 1s infinite ease-in-out;flex-shrink:0;}
.pm-voice-wave i:nth-child(1){height:8px;}.pm-voice-wave i:nth-child(2){height:14px;animation-delay:.2s;}.pm-voice-wave i:nth-child(3){height:10px;animation-delay:.4s;}
@keyframes pm-wave{0%,100%{transform:scaleY(.5)}50%{transform:scaleY(1)}}
.pm-voice-dur{font-size:12px;opacity:.85;min-width:34px;text-align:right;flex-shrink:0;font-variant-numeric:tabular-nums;line-height:1;}
.pm-voice-text{background:#f7f7f9;border:1px solid #e5e5e8;color:#333;padding:7px 10px;border-radius:10px;font-size:13px;line-height:1.4;max-width:220px;word-break:break-word;position:relative;}
.pm-voice-text::before{content:'已转文字';position:absolute;top:-8px;left:8px;font-size:9px;color:#999;background:#fff;padding:0 4px;border-radius:4px;}
.pm-input-bar{padding:8px 12px 30px !important;display:flex !important;gap:8px;border-top:1px solid var(--pm-navbar-border,#f0f0f0);align-items:center;background:var(--pm-navbar-bg,#fff) !important;flex-shrink:0;}
.pm-input{flex:1 !important;min-width:0 !important;background:#f2f2f7 !important;color:#000 !important;border:none !important;border-radius:20px !important;padding:9px 14px !important;outline:none !important;font-size:14px !important;font-family:inherit !important;}
.pm-input:disabled{opacity:.5;}
.pm-up-btn{width:32px !important;height:32px !important;background:#007aff !important;color:#fff !important;border:none !important;border-radius:50% !important;cursor:pointer;font-size:16px !important;font-weight:bold;display:flex !important;align-items:center !important;justify-content:center !important;flex-shrink:0;}
.pm-up-btn:disabled{background:#ccc !important;}
.pm-expand-btn {
    width: 28px !important;
    height: 28px !important;
    background: none !important;
    color: #888 !important;
    border: none !important;
    cursor: pointer;
    font-size: 18px !important;
    display: flex !important;
    align-items: center !important;
    justify-content: center !important;
    flex-shrink: 0;
    padding: 0 !important;
    transition: color 0.15s;
}
.pm-expand-btn:hover {
    color: #007aff !important;
}
/* 适配夜间模式的加号按钮颜色 */
#pm-iphone[data-theme="dark"] .pm-expand-btn {
    color: #aaa !important;
}
#pm-iphone[data-theme="dark"] .pm-expand-btn:hover {
    color: #0a84ff !important;
}
#pm-overlay{position:fixed !important;inset:0 !important;margin:0 !important;width:100vw !important;height:100vh !important;height:100dvh !important;max-width:none !important;max-height:none !important;background:rgba(0,0,0,.45) !important;z-index:2147483647 !important;display:flex !important;align-items:center !important;justify-content:center !important;border:none !important;padding:0 !important;}
/* 弹窗挂在 body 上，会继承 SillyTavern 主题的浅灰字色 —— 必须自己钉死字色，否则正文全是灰的 */
.pm-modal{background:#fff !important;color:#111 !important;border-radius:20px !important;width:290px;max-height:85vh;max-height:85dvh;display:flex !important;flex-direction:column !important;overflow:hidden;box-shadow:0 16px 48px rgba(0,0,0,.28);font-family:-apple-system,BlinkMacSystemFont,'PingFang SC',sans-serif !important;}
.pm-modal-wide{width:320px;}
.pm-modal-scroll{flex:1;overflow-y:auto;min-height:0;}
.pm-modal-header{display:flex !important;justify-content:space-between !important;align-items:center !important;padding:16px 18px 12px !important;border-bottom:1px solid #f0f0f0;flex-shrink:0;}
.pm-modal-header b{font-size:16px !important;color:#000 !important;}.pm-modal-close{font-size:20px;color:#999;cursor:pointer;line-height:1;}
.pm-cfg-tabs{display:flex;border-bottom:1px solid #f0f0f0;flex-shrink:0;padding:0 14px;}
.pm-cfg-tab{flex:1;text-align:center;padding:10px 0;font-size:13px;font-weight:600;color:#888;cursor:pointer;border-bottom:2px solid transparent;transition:all .2s;user-select:none;}
.pm-cfg-tab:hover{color:#555;}
.pm-cfg-tab-active{color:#007aff !important;border-bottom-color:#007aff !important;}
.pm-tab-pane{animation:pm-fade-in .15s ease;}
@keyframes pm-fade-in{from{opacity:0}to{opacity:1}}
.pm-bi-bar{padding:8px 14px;background:#fff8e8;border-bottom:1px solid #ffe6a8;font-size:11px;color:#885d00;display:flex;flex-direction:column;gap:3px;}
.pm-bi-tip{font-weight:600;color:#b87a00;}
.pm-modal-list{overflow-y:auto;flex:1;padding:6px 8px;max-height:400px;}
.pm-li{display:flex !important;align-items:center !important;gap:10px;padding:10px;border-radius:12px;}.pm-li:hover{background:#f5f5f5;}
.pm-li > span{flex:1;font-size:14px !important;color:#007aff !important;font-weight:500;cursor:pointer;display:flex;flex-direction:column;gap:2px;min-width:0;}
.pm-group-sub{font-size:11px !important;color:#999 !important;font-weight:400 !important;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.pm-li i{font-style:normal;font-size:11px;color:#fff !important;background:#ff3b30 !important;padding:3px 9px;border-radius:8px;cursor:pointer;font-weight:600;flex-shrink:0;}
.pm-modal-add{padding:12px 14px 16px;border-top:1px solid #f0f0f0;display:flex;gap:8px;flex-shrink:0;}
.pm-modal-add input{flex:1;min-width:0;border:1px solid #ddd;border-radius:10px;padding:9px 12px;font-size:13px;outline:none;color:#000 !important;background:#fff !important;}
.pm-modal-add button{background:#007aff !important;color:#fff !important;border:none;border-radius:10px;padding:9px 14px;font-size:13px;cursor:pointer;font-weight:600;white-space:nowrap;}
.pm-btn-group{flex:1;background:linear-gradient(135deg,#ff9500,#ff6b00) !important;color:#fff !important;border:none !important;border-radius:10px !important;padding:11px !important;font-size:13px !important;cursor:pointer !important;font-weight:600 !important;}
.pm-btn-add{flex:1;background:linear-gradient(135deg,#007aff,#0056b3) !important;color:#fff !important;border:none !important;border-radius:10px !important;padding:11px !important;font-size:13px !important;cursor:pointer !important;font-weight:600 !important;}
.pm-btn-group:hover,.pm-btn-add:hover{filter:brightness(1.05);}
.pm-cfg-label{font-size:12px;color:#555;margin-bottom:-4px;}
.pm-cfg-input{width:100%;border:1px solid #ddd !important;border-radius:10px !important;padding:9px 12px;font-size:13px !important;outline:none;color:#000 !important;background:#fff !important;}
.pm-cfg-tip{font-size:11px;color:#aaa;text-align:center;padding:4px 0;}
.pm-mode-switch{display:flex !important;background:#f0f0f3;border-radius:12px;padding:3px;gap:3px;}
.pm-mode-opt{flex:1;text-align:center;padding:9px 0;font-size:13px;font-weight:600;color:#888;cursor:pointer;border-radius:9px;transition:all .2s;user-select:none;}
.pm-mode-opt:hover{color:#555;}.pm-mode-active{background:#fff !important;color:#007aff !important;box-shadow:0 2px 6px rgba(0,0,0,.08);}
.pm-prof-list{max-height:100px;overflow-y:auto;border:1px solid #eee;border-radius:10px;background:#fafafa;padding:4px;}
.pm-prof-li{display:flex !important;align-items:center !important;gap:8px;padding:7px 9px;border-radius:8px;}.pm-prof-li:hover{background:#fff;}
.pm-prof-info{flex:1;min-width:0;cursor:pointer;display:flex;flex-direction:column;gap:2px;}
.pm-prof-url{font-size:12px;color:#007aff !important;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.pm-prof-meta{font-size:10px;color:#999;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.pm-prof-del{font-style:normal;font-size:12px;color:#ff3b30;background:#fff !important;border:1px solid #ffd0cc;width:22px;height:22px;border-radius:50%;display:flex !important;align-items:center !important;justify-content:center !important;cursor:pointer;flex-shrink:0;font-weight:600;}
.pm-prof-del:hover{background:#ff3b30 !important;color:#fff !important;}
.pm-prof-empty{text-align:center;color:#aaa;font-size:12px;padding:10px 0;}
.pm-theme-row{display:flex;gap:6px;flex-wrap:wrap;}
.pm-theme-chip{display:flex;align-items:center;gap:4px;padding:5px 10px;border-radius:16px;font-size:12px;color:#555;background:#f5f5f5;cursor:pointer;border:2px solid transparent;transition:all .15s;user-select:none;}
.pm-theme-chip:hover{background:#eee;}.pm-theme-active{border-color:#007aff;color:#007aff;background:#f0f7ff;}
.pm-theme-dot{width:14px;height:14px;border-radius:50%;flex-shrink:0;}
.pm-color-pick{width:32px;height:28px;padding:0;border:1px solid #ddd;border-radius:6px;cursor:pointer;background:none;}
.pm-color-clear{background:none;border:1px solid #ddd;border-radius:6px;padding:3px 8px;font-size:11px;color:#888;cursor:pointer;white-space:nowrap;}.pm-color-clear:hover{background:#f0f0f0;}
.pm-layout-row{display:flex;gap:6px;}
.pm-layout-chip{padding:6px 16px;border-radius:16px;font-size:12px;color:#555;background:#f5f5f5;cursor:pointer;border:2px solid transparent;transition:all .15s;user-select:none;}
.pm-layout-chip:hover{background:#eee;}.pm-layout-active{border-color:#007aff;color:#007aff;background:#f0f7ff;}
.pm-bg-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
.pm-bg-label{font-size:12px;color:#555;font-weight:500;min-width:64px;}
.pm-bg-btn{background:#f0f0f3;border:1px solid #ddd;border-radius:8px;padding:6px 12px;font-size:12px;color:#555;cursor:pointer;white-space:nowrap;font-family:inherit;}
.pm-bg-btn:hover{background:#e5e5e8;}.pm-bg-del{color:#ff3b30 !important;border-color:#ffc8c8 !important;}
.pm-model-row{display:flex;gap:6px;}.pm-model-row .pm-cfg-input{flex:1;}
#pm-model-arrow{background:#f0f0f3;border:1px solid #ddd;border-radius:10px;width:38px;cursor:pointer;font-size:12px;color:#555;flex-shrink:0;transition:all .15s;}
#pm-model-arrow:hover{background:#007aff;color:#fff;border-color:#007aff;}
.pm-model-dropdown{position:fixed;z-index:2147483647;background:#fff !important;border:1px solid #ddd !important;border-radius:12px !important;box-shadow:0 8px 24px rgba(0,0,0,.18);overflow:hidden;display:flex;flex-direction:column;min-width:200px;padding:0 !important;margin:0 !important;color:#000 !important;}
.pm-model-search{border:none !important;border-bottom:1px solid #eee !important;padding:9px 12px !important;outline:none;font-size:13px !important;background:#fafafa !important;color:#000 !important;width:100%;}
.pm-model-options{overflow-y:auto;max-height:${MODEL_VISIBLE_ROWS * 34}px;}
.pm-model-opt{padding:8px 12px;font-size:13px;color:#333;cursor:pointer;border-bottom:1px solid #f5f5f5;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;height:34px;line-height:18px;}
.pm-model-opt:hover{background:#f0f7ff;color:#007aff;}.pm-model-empty{padding:14px;text-align:center;font-size:12px;color:#999;}
.pm-crop-tip{font-size:11px;color:#888;text-align:center;margin-bottom:8px;}
.pm-crop-frame{position:relative;width:100%;background:#000;border-radius:12px;overflow:hidden;cursor:grab;user-select:none;touch-action:none;}
.pm-crop-frame:active{cursor:grabbing;}
.pm-crop-frame img{position:absolute;left:0;top:0;max-width:none;pointer-events:none;}
.pm-crop-mask{position:absolute;inset:0;border:2px solid rgba(255,255,255,0.6);box-shadow:0 0 0 2000px rgba(0,0,0,0.3) inset;pointer-events:none;border-radius:8px;}
.pm-crop-zoom{display:flex;align-items:center;gap:8px;margin-top:10px;}
.pm-crop-zoom input[type=range]{accent-color:#007aff;cursor:pointer !important;flex:1;}
.pm-crop-zoom input[type=range]::-webkit-slider-thumb{cursor:pointer !important;}
.pm-crop-zoom input[type=range]::-moz-range-thumb{cursor:pointer !important;}
@media(max-width:500px),(max-height:700px){
    #pm-iphone{inset:0 !important;margin:auto !important;transform:none !important;width:min(330px,92vw) !important;height:min(560px,82vh) !important;height:min(560px,82dvh) !important;min-width:0 !important;min-height:0 !important;max-width:92vw !important;max-height:82vh !important;max-height:82dvh !important;border-width:8px !important;border-radius:36px !important;}
    #pm-iphone.is-min{inset:auto 20px 20px auto !important;margin:0 !important;transform:none !important;width:120px !important;min-width:120px !important;max-width:120px !important;height:44px !important;min-height:44px !important;max-height:44px !important;border-width:5px !important;border-radius:22px !important;}
    .pm-modal,.pm-modal-wide{width:min(320px,94vw) !important;max-height:90vh !important;max-height:90dvh !important;}
}
.pm-modal-close{cursor:pointer;font-size:16px;color:#999;padding:2px 6px;line-height:1;user-select:none;border-radius:50%;transition:background 0.15s;}
.pm-modal-close:active{background:#f0f0f0;}
.pm-row{display:flex !important;width:100%;align-items:flex-end;gap:6px;}
.pm-row-left{justify-content:flex-start;}
.pm-row-right{justify-content:flex-end;}
.pm-avatar-img{width:28px;height:28px;border-radius:50% !important;object-fit:cover;flex-shrink:0;background:#d8d8dc;cursor:pointer;}
.pm-avatar-placeholder{background:#d8d8dc;}
#pm-iphone[data-theme="dark"] .pm-avatar-placeholder{background:#48484a;}
/* iOS 风格滑动开关 */
.pm-switch{position:relative;width:44px;height:26px;min-width:44px;flex-shrink:0;border-radius:13px;background:#e9e9ea;cursor:pointer;transition:background .22s ease;}
.pm-switch::after{content:'';position:absolute;top:2px;left:2px;width:22px;height:22px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.2);transition:transform .22s ease;}
.pm-switch.is-on{background:#34c759;}
.pm-switch.is-on::after{transform:translateX(18px);}
#pm-iphone[data-theme="dark"] .pm-switch{background:#39393d;}
#pm-iphone[data-theme="dark"] .pm-switch.is-on{background:#32d74b;}
/* ── 微博 ── */
/* --wb-sub 原来是 #939393，白底上对比度不够（约 3:1），正文看着像没加载完；压到 #6b6b6b 约 5.3:1 */
#pm-overlay .wb-modal{--wb-orange:#ff8200;--wb-blue:#507daf;--wb-line:#ececec;--wb-sub:#6b6b6b;--wb-ph:#f5f5f5;
  --wb-av-ph:#d8d8d8;--wb-fill:rgba(0,0,0,.03);--wb-imgtext:#6f6f6f;--wb-input-bd:#dcdcdc;
  height:min(560px,80dvh);}
.wb-modal.is-dark{--wb-line:#38383a;--wb-sub:#a1a1a6;--wb-ph:#2c2c2e;
  --wb-av-ph:#48484a;--wb-fill:rgba(255,255,255,.055);--wb-imgtext:#98989d;--wb-input-bd:#48484a;}
.pm-modal.is-dark{background:#1c1c1e !important;color:#e5e5e5 !important;}
.pm-modal.is-dark .pm-modal-header{border-bottom-color:#38383a !important;}
.pm-modal.is-dark .pm-modal-header b{color:#e5e5e5 !important;}
.pm-modal.is-dark .pm-cfg-input{background:#2c2c2e !important;color:#e5e5e5 !important;border-color:#48484a !important;}
.pm-modal.is-dark .pm-cfg-label{color:#aaa !important;}
.pm-modal.is-dark .pm-modal-add{border-top-color:#38383a !important;}
.wb-modal .pm-modal-header b{color:var(--wb-orange) !important;}
/* 顶栏图标：撑到 30px 可点区域，加悬停底色 */
.wb-ico{display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;border-radius:50%;
  cursor:pointer;user-select:none;transition:background .18s ease,transform .12s ease;-webkit-tap-highlight-color:transparent;}
.wb-ico:hover{background:var(--wb-fill);}
.wb-ico:active{transform:scale(.9);}
.wb-ico:focus-visible{outline:2px solid var(--wb-orange);outline-offset:1px;}
.wb-back{display:inline-flex;align-items:center;gap:2px;cursor:pointer;color:#007aff;font-size:14.5px;
  padding:5px 9px 5px 5px;margin-left:-5px;border-radius:9px;user-select:none;
  transition:background .18s ease,transform .12s ease;-webkit-tap-highlight-color:transparent;}
.wb-back:hover{background:var(--wb-fill);}
.wb-back:active{transform:translateX(-2px);}
.wb-back:focus-visible{outline:2px solid #007aff;outline-offset:1px;}
.wb-acct-tabs{display:flex;border-bottom:1px solid var(--wb-line);flex-shrink:0;}
.wb-tab{flex:1;text-align:center;padding:11px 0;font-size:13px;color:var(--wb-sub);cursor:pointer;position:relative;
  transition:color .2s ease;-webkit-tap-highlight-color:transparent;}
/* 下划线用伪元素做，避免 is-on 切换时 border 改变盒模型导致 1px 跳动 */
.wb-tab::after{content:'';position:absolute;left:50%;bottom:0;height:2px;width:26px;border-radius:2px 2px 0 0;
  background:var(--wb-orange);transform:translateX(-50%) scaleX(0);transition:transform .24s cubic-bezier(.32,.72,0,1);}
.wb-tab.is-on{color:var(--wb-orange);font-weight:600;}
.wb-tab.is-on::after{transform:translateX(-50%) scaleX(1);}
.wb-tab:hover:not(.is-on){color:var(--wb-orange);opacity:.72;}
.wb-tab:focus-visible{outline:2px solid var(--wb-orange);outline-offset:-2px;border-radius:4px;}
.wb-feed{padding:0;}
.wb-card{padding:13px 14px;border-bottom:1px solid var(--wb-line);cursor:pointer;
  transition:background .18s ease;-webkit-tap-highlight-color:transparent;}
.wb-card:hover{background:var(--wb-fill);}
.wb-card:active{background:var(--wb-fill);}
.wb-card-top{display:flex;align-items:center;gap:9px;}
.wb-card-id{min-width:0;flex:1;}
.wb-av{border-radius:50% !important;object-fit:cover;flex-shrink:0;display:block;}
.wb-av-ph{background:var(--wb-av-ph);}

/* 设置页里可点的头像位：以前是个没背景的透明圆，看着是一片空白，点了却弹出选图。
   现在画成明确的虚线圆+相机图标，点哪儿会发生什么一眼看得出。 */
.wb-avpick{display:inline-flex;flex-direction:column;align-items:center;gap:5px;cursor:pointer;
  padding:6px 10px;border-radius:12px;transition:background .18s ease;-webkit-tap-highlight-color:transparent;}
.wb-avpick:hover{background:var(--wb-fill,rgba(0,0,0,.03));}
.wb-avpick:active{transform:scale(.97);}
.wb-avpick:focus-visible{outline:2px solid #ff8200;outline-offset:1px;}
.wb-avpick-t{font-size:11px;color:#777;}
.pm-modal.is-dark .wb-avpick-t{color:#98989d;}
.wb-avpick-ring{position:relative;width:56px;height:56px;border-radius:50%;display:flex;align-items:center;
  justify-content:center;background:#f2f2f2;border:1.5px dashed #c8c8c8;overflow:hidden;}
.pm-modal.is-dark .wb-avpick-ring{background:#2c2c2e;border-color:#54545a;}
.wb-avpick-ring img{width:100%;height:100%;object-fit:cover;border-radius:50%;}
.wb-avpick-ring .wb-avpick-cam{font-size:19px;line-height:1;opacity:.55;}
/* 有图时不再挂右下角小角标：那个橙圈太像认证 V 了，会被误读成"这个号有认证"。
   还能换头像这件事靠 title 和整块可点提示，不用角标。 */
.wb-avpick-ring.has-img{border-style:solid;border-color:transparent;}

/* 表单：flex 容器默认允许子项收缩，内容一多 textarea 就被压成一条缝（截图里「账号设定」只剩半行）。
   钉死 flex-shrink:0，让容器去滚动，而不是把输入框压扁。 */
.wb-form{display:flex;flex-direction:column;gap:10px;padding:14px 16px;}
.wb-form>*{flex-shrink:0;}
.wb-form textarea.pm-cfg-input{min-height:82px;}
.wb-form-sep{margin-top:6px;border-top:1px solid #ececec;padding-top:12px;}
.pm-modal.is-dark .wb-form-sep{border-top-color:#38383a;}
.wb-form-h{font-size:12px;font-weight:600;color:#ff8200;letter-spacing:.2px;}
.wb-form-row{display:flex;align-items:center;justify-content:space-between;gap:10px;}
.wb-form-row span{font-size:13px;}
.wb-form-note{font-size:11px;color:#777;line-height:1.6;text-wrap:pretty;}
.pm-modal.is-dark .wb-form-note{color:#98989d;}
.wb-av-24{width:24px;height:24px;}.wb-av-32{width:32px;height:32px;}
.wb-av-40{width:40px;height:40px;}.wb-av-56{width:56px;height:56px;}
.wb-uname{font-size:13px;font-weight:600;color:var(--wb-blue);letter-spacing:-.1px;
  display:flex;align-items:center;gap:4px;min-width:0;}
/* flex 容器自己吃不到 text-overflow，昵称必须包一层 span 才能省略号 */
.wb-uname>span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;}
/* 红V=名人，昵称跟着变橙（和微博生成器的 .username.vip 一致）；蓝V/普通保持蓝 */
.wb-uname.is-vip{color:var(--wb-orange);}
.wb-meta{font-size:11px;color:var(--wb-sub);margin-top:2.5px;font-variant-numeric:tabular-nums;}
.wb-text{font-size:13.5px;line-height:1.68;color:#111;margin-top:8px;word-break:break-word;text-wrap:pretty;}
.wb-modal.is-dark .wb-text{color:#e8e8ea;}
.wb-text-clip{display:-webkit-box;-webkit-line-clamp:6;-webkit-box-orient:vertical;overflow:hidden;}
/* #话题#、@某人、超话 一律染蓝，和真微博一致 */
.wb-blue{color:#1a5f9c;cursor:pointer;}
.wb-modal.is-dark .wb-blue{color:#6aa9e0;}
.wb-blue:hover{text-decoration:underline;}
.wb-diamond{width:12px;height:12px;vertical-align:-1.5px;margin-right:1px;}
/* V 标挂在头像右下角（微博生成器的 .v-badge），所以要包一层定位容器 */
.wb-avwrap{position:relative;display:inline-block;flex-shrink:0;line-height:0;}
.wb-vb{position:absolute;right:-1px;bottom:-1px;display:flex;align-items:center;justify-content:center;
  border-radius:50%;border:1px solid #fff;color:#fff;font-family:Arial,Helvetica,sans-serif;
  font-style:italic;font-weight:900;line-height:1;user-select:none;
  width:13px;height:13px;font-size:9px;}
.wb-modal.is-dark .wb-vb{border-color:#1c1c1e;}
.wb-vb-red{background:#ee1a1a;}
.wb-vb-blue{background:#1da1f2;}
/* 头像越小，V 标跟着缩 —— 尺寸照生成器的 header/comment/reply 三档 */
.wb-avwrap.wb-av-40 .wb-vb{width:14px;height:14px;font-size:10px;}
.wb-avwrap.wb-av-32 .wb-vb{width:12px;height:12px;font-size:8px;}
.wb-avwrap.wb-av-24 .wb-vb{width:10px;height:10px;font-size:7px;}
.wb-avwrap.wb-av-56 .wb-vb{width:18px;height:18px;font-size:12px;}
.wb-follow{flex-shrink:0;font-size:12px;font-weight:600;padding:5px 12px;border-radius:14px;
  border:1px solid var(--wb-orange);background:transparent;color:var(--wb-orange);cursor:pointer;user-select:none;
  white-space:nowrap;transition:background .2s ease,color .2s ease,border-color .2s ease,transform .12s ease;
  -webkit-tap-highlight-color:transparent;}
.wb-follow:hover{background:var(--wb-orange);color:#fff;}
.wb-follow.is-on{border-color:var(--wb-line);color:var(--wb-sub);font-weight:400;}
.wb-follow.is-on:hover{background:var(--wb-fill);color:var(--wb-sub);}
.wb-follow:active{transform:scale(.95);}
.wb-follow:focus-visible{outline:2px solid var(--wb-orange);outline-offset:2px;}
.wb-grid{display:grid;gap:3px;margin-top:8px;padding:0 14px;}
.wb-detail .wb-grid,.wb-card .wb-grid{padding:0;}
.wb-grid[data-n="1"]{grid-template-columns:1fr;}
.wb-grid[data-n="2"],.wb-grid[data-n="4"]{grid-template-columns:1fr 1fr;}
.wb-grid[data-n="3"],.wb-grid[data-n="5"],.wb-grid[data-n="6"],.wb-grid[data-n="7"],.wb-grid[data-n="8"],.wb-grid[data-n="9"]{grid-template-columns:1fr 1fr 1fr;}
.wb-img{position:relative;background:var(--wb-ph);border-radius:5px;aspect-ratio:1/1;display:flex;align-items:center;
  justify-content:center;padding:7px;overflow:hidden;}
/* 灰底占位图靠一条极淡的内描边和角标区分于纯色块，不然像渲染失败 */
.wb-img::before{content:'';position:absolute;inset:0;border-radius:5px;pointer-events:none;
  box-shadow:inset 0 0 0 1px rgba(0,0,0,.045);}
.wb-modal.is-dark .wb-img::before{box-shadow:inset 0 0 0 1px rgba(255,255,255,.05);}
.wb-grid[data-n="1"] .wb-img{aspect-ratio:8/5;}
.wb-img span{font-size:10px;line-height:1.45;color:var(--wb-imgtext);text-align:center;word-break:break-word;
  max-height:100%;overflow:hidden;position:relative;}
.wb-grid[data-n="1"] .wb-img span,.wb-grid[data-n="2"] .wb-img span{font-size:12px;}
/* 用户自己发的是真图，铺满格子；AI 发的仍是灰底+文字描述 */
.wb-img.is-real{padding:0;background:var(--wb-fill);}
.wb-img.is-real img{width:100%;height:100%;object-fit:cover;display:block;}
/* 列表卡里的九宫格缩一点，别把卡片撑太高 */
.wb-grid-sm{max-width:270px;}
.wb-bar{display:flex;justify-content:space-around;padding:7px 0;margin-top:8px;font-size:12px;color:var(--wb-sub);
  font-variant-numeric:tabular-nums;}
.wb-bar span{user-select:none;padding:5px 10px;border-radius:14px;min-height:30px;
  display:inline-flex;align-items:center;gap:1px;transition:background .18s ease,color .18s ease,transform .12s ease;
  -webkit-tap-highlight-color:transparent;}
/* 列表卡里的转赞评只是数字展示（整卡才可点）；只有 role=button 的才给可点反馈 */
.wb-bar span[role="button"]{cursor:pointer;}
.wb-bar span[role="button"]:hover{background:var(--wb-fill);}
.wb-bar span[role="button"]:active{transform:scale(.93);}
.wb-bar .is-liked,.wb-like.is-liked{color:var(--wb-orange) !important;}

/* 图标：path 与 微博生成器3.0 同源，统一 fill:currentColor 跟着文字色走 */
.wb-svg{fill:currentColor;flex-shrink:0;vertical-align:-2px;}
/* 未赞=空心（描边），已赞=实心。同一条 path，只切填充方式，所以不会有形变跳动 */
.wb-svg-like{fill:none;stroke:currentColor;stroke-width:1.6;
  transition:fill .16s ease,stroke-width .16s ease;}
.wb-svg-like.is-solid{fill:currentColor;stroke:none;}
/* 点下去弹一下，实心那一刻有反馈 */
.wb-like.is-liked .wb-svg-like{animation:wb-pop .28s cubic-bezier(.34,1.56,.64,1);}
@keyframes wb-pop{0%{transform:scale(.8);}60%{transform:scale(1.18);}100%{transform:scale(1);}}
.wb-sort{display:flex;justify-content:space-between;align-items:center;padding:10px 14px 2px;font-size:11px;color:var(--wb-sub);font-weight:600;letter-spacing:.3px;}
.wb-sort-by{display:inline-flex;align-items:center;gap:2px;font-weight:400;}
.wb-sort-by .wb-svg{fill:currentColor;}
.wb-clist{padding:0 14px 8px;}
.wb-comment{display:flex;gap:9px;padding:11px 0;border-bottom:1px solid var(--wb-line);}
.wb-comment:last-child{border-bottom:none;}
.wb-c-main{flex:1;min-width:0;}
.wb-c-name{font-size:12px;font-weight:600;color:var(--wb-blue);display:flex;align-items:center;gap:4px;flex-wrap:wrap;}
.wb-c-name.is-vip{color:var(--wb-orange);}
.wb-tag-bozhu{background:var(--wb-orange);color:#fff;font-size:9px;font-weight:500;padding:1.5px 4px;border-radius:3px;
  letter-spacing:.2px;line-height:1.2;}
.wb-c-text{font-size:13px;line-height:1.58;margin-top:3px;word-break:break-word;text-wrap:pretty;color:#111;}
.wb-modal.is-dark .wb-c-text{color:#e8e8ea;}
/* 楼中楼里「回复 @某人」的前缀 */
.wb-c-text .wb-rt{color:var(--wb-blue);font-weight:600;}
.wb-c-meta{display:flex;gap:4px;align-items:center;font-size:11px;color:var(--wb-sub);margin-top:3px;
  font-variant-numeric:tabular-nums;}
/* 时间戳不是按钮，给它自己的右间距；回复/点赞才做成可点区域 */
.wb-c-meta>span:first-child{margin-right:8px;}
.wb-c-act,.wb-like{cursor:pointer;user-select:none;padding:4px 7px;margin:-4px 0;border-radius:11px;
  display:inline-flex;align-items:center;gap:2px;transition:background .18s ease,color .18s ease,transform .12s ease;
  -webkit-tap-highlight-color:transparent;}
.wb-c-act:hover,.wb-like:hover{background:var(--wb-fill);color:var(--wb-orange);}
.wb-c-act:active,.wb-like:active{transform:scale(.92);}
.wb-c-del:hover{color:#ff3b30;}
.wb-c-act:focus-visible,.wb-like:focus-visible,.wb-bar span:focus-visible{outline:2px solid var(--wb-orange);outline-offset:1px;}
.wb-reply{display:flex;gap:7px;margin-top:8px;padding:8px 9px;background:var(--wb-fill);border-radius:7px;}
.wb-reply+.wb-reply{margin-top:5px;}
.wb-input-bar{display:flex;align-items:center;gap:7px;padding:9px 12px;border-top:1px solid var(--wb-line);flex-shrink:0;flex-wrap:wrap;}
.wb-hint{font-size:11px;color:var(--wb-orange);background:rgba(255,130,0,.1);border-radius:10px;padding:3px 8px;align-items:center;gap:5px;}
.wb-hint i{cursor:pointer;font-style:normal;opacity:.7;transition:opacity .18s ease;}
.wb-hint i:hover{opacity:1;}
.wb-cinput{flex:1;min-width:0;border:1px solid var(--wb-input-bd) !important;border-radius:16px !important;
  padding:8px 13px;font-size:13px !important;outline:none;background:var(--wb-ph) !important;color:inherit !important;
  transition:border-color .2s ease,background .2s ease,box-shadow .2s ease;}
.wb-cinput::placeholder{color:var(--wb-sub);}
/* outline 关掉了，focus 反馈靠 border + 光晕补回来，键盘操作才不会瞎 */
.wb-cinput:focus{border-color:var(--wb-orange) !important;background:transparent !important;
  box-shadow:0 0 0 3px rgba(255,130,0,.13);}
.wb-csend{background:var(--wb-orange);color:#fff;border:none;border-radius:16px;padding:8px 16px;font-size:13px;
  cursor:pointer;font-weight:600;flex-shrink:0;transition:filter .2s ease,transform .12s ease;
  -webkit-tap-highlight-color:transparent;}
.wb-csend:hover{filter:brightness(1.08);}
.wb-csend:active{transform:scale(.96);}
.wb-csend:focus-visible{outline:2px solid var(--wb-orange);outline-offset:2px;}
.wb-toast{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);background:rgba(0,0,0,.82);color:#fff;
  font-size:12.5px;padding:9px 15px;border-radius:10px;z-index:99999;max-width:75%;text-align:center;line-height:1.5;
  pointer-events:none;backdrop-filter:blur(6px);box-shadow:0 6px 22px rgba(0,0,0,.22);}
.wb-spin{display:inline-block;width:13px;height:13px;border-radius:50%;vertical-align:-1px;
  border:2px solid var(--wb-line);border-top-color:var(--wb-orange);animation:wb-rot .7s linear infinite;}
@keyframes wb-rot{to{transform:rotate(360deg);}}
/* 图库选图器：选过的图打勾 + 压暗，避免重复挑同一张 */
.wb-gal-cell{position:relative;width:52px;height:52px;border-radius:8px;overflow:hidden;
  border:1px solid #eee;cursor:pointer;flex-shrink:0;}
.wb-gal-cell img{width:100%;height:100%;object-fit:cover;display:block;}
.wb-gal-tick{display:none;position:absolute;right:2px;bottom:2px;width:17px;height:17px;border-radius:50%;
  background:var(--wb-orange,#ff8200);color:#fff;font-size:10px;font-weight:700;line-height:17px;text-align:center;
  box-shadow:0 0 0 1.5px #fff;}
.wb-gal-cell.is-picked{border-color:var(--wb-orange,#ff8200);}
.wb-gal-cell.is-picked img{opacity:.45;}
.wb-gal-cell.is-picked .wb-gal-tick{display:block;}
/* 收评论用：只转圈，不摆骨架屏——骨架屏像是有新微博要来，跟"收评论"不搭 */
.wb-loading{display:flex;align-items:center;justify-content:center;gap:9px;
  padding:22px 16px;font-size:12.5px;color:var(--wb-sub);letter-spacing:-.1px;}
.wb-loading .wb-spin{width:15px;height:15px;vertical-align:0;}
.wb-empty{text-align:center;padding:46px 30px;}
.wb-empty-ic{font-size:34px;line-height:1;opacity:.28;margin-bottom:14px;}
.wb-empty-t{font-size:13.5px;font-weight:600;color:var(--wb-sub);letter-spacing:-.1px;}
.wb-empty-s{font-size:11.5px;color:var(--wb-sub);opacity:.72;line-height:1.7;margin-top:7px;text-wrap:pretty;}
/* 生成中的骨架屏：形状照着 wb-card 摆，比转圈更能说明"在写什么" */
.wb-skel{padding:13px 14px;border-bottom:1px solid var(--wb-line);}
.wb-skel-row{display:flex;align-items:center;gap:9px;}
.wb-skel-b{background:linear-gradient(90deg,var(--wb-ph) 25%,var(--wb-fill) 37%,var(--wb-ph) 63%);
  background-size:400% 100%;border-radius:4px;animation:wb-shimmer 1.5s ease-in-out infinite;}
.wb-skel-av{width:40px;height:40px;border-radius:50%;flex-shrink:0;}
.wb-skel-l{height:10px;margin-top:9px;}
@keyframes wb-shimmer{0%{background-position:100% 0;}100%{background-position:0 0;}}
.wb-reply-expand{display:flex;align-items:center;margin-top:8px;padding-left:0;gap:4px;user-select:none;cursor:default;}
	.wb-reply-dots{color:#999;letter-spacing:-2px;font-size:14px;font-family:Arial,sans-serif;}
	.wb-reply-count{font-size:12px;color:#507daf;}
	.wb-modal.is-dark .wb-reply-count{color:#6aa9e0;}
	@media (prefers-reduced-motion:reduce){
  #pm-overlay .wb-modal *,#pm-overlay-sub .wb-modal *{transition-duration:.01ms !important;animation-duration:.01ms !important;animation-iteration-count:1 !important;}
}
        `;
        document.head.appendChild(s);
    }

    function registerPhoneCommand() {
        const ctx = getCtx(); if (!ctx) return false;
        const cb = () => { try { window.__pmOpen(); } catch (e) { console.error('[phone-mode]', e); } return ''; };
        try {
            const SCP = window.SlashCommandParser || ctx.SlashCommandParser, SC = window.SlashCommand || ctx.SlashCommand;
            if (SCP && SC && typeof SCP.addCommandObject === 'function' && typeof SC.fromProps === 'function') { SCP.addCommandObject(SC.fromProps({ name: 'phone', callback: cb, helpString: '打开短信' })); return true; }
        } catch (e) {}
        try { if (typeof ctx.registerSlashCommand === 'function') { ctx.registerSlashCommand('phone', cb, [], '打开短信', true, true); return true; } } catch (e) {}
        return false;
    }
    if (!registerPhoneCommand()) { let t = 0; const i = setInterval(() => { t++; if (registerPhoneCommand() || t >= 30) clearInterval(i); }, 500); }

    document.addEventListener('keydown', e => {
        if (e.key !== 'Enter' || e.shiftKey) return;
        const ta = document.getElementById('send_textarea');
        if (!ta || document.activeElement !== ta) return;
        if (ta.value.trim() === '/phone') { e.preventDefault(); e.stopImmediatePropagation(); ta.value = ''; window.__pmOpen(); }
    }, true);
    document.addEventListener('click', e => {
        const btn = e.target.closest?.('#send_but'); if (!btn) return;
        const ta = document.getElementById('send_textarea'); if (!ta) return;
        if (ta.value.trim() === '/phone') { e.preventDefault(); e.stopImmediatePropagation(); ta.value = ''; window.__pmOpen(); }
    }, true);

    try { window.__pmHistories = window.__pmHistories || {}; } catch (e) {}
    loadBidirectional(); loadGroupMeta(); loadPokeConfig(); loadWordyLimit();
    loadHistoriesFromIDB(); // IDB 加载完成后内部会用 localStorage 作 fallback
    setTimeout(() => { migrateOldHistory(); applyBidirectionalInjection(); hookGenerationEvent(); }, 1500);

    console.log('[phone-mode] v9.5.7 已加载：世界书预算改为读取ST实际上下文窗口大小');
})();
