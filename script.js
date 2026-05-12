// ========== 设置管理 ==========
const STORAGE_KEY = 'sticker-drop-settings';
const GROUPS_KEY = 'sticker-drop-groups';

const defaults = {
  token: '',
  owner: '6zs5kxbhhy-svg',
  repo: 'Sticker-Drop',
  branch: 'main',
};

function loadSettings() {
  try {
    var raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { ...defaults, ...JSON.parse(raw) };
  } catch (e) { /* ignore */ }
  return { ...defaults };
}

function saveSettings(s) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
}

let settings = loadSettings();

// ========== DOM 引用 ==========
var $ = function (sel) { return document.querySelector(sel); };

var uploadZone = $('#uploadZone');
var fileInput = $('#fileInput');
var uploadPreview = $('#uploadPreview');
var previewGroup = $('#previewGroup');
var batchCount = $('#batchCount');
var batchList = $('#batchList');
var btnCancel = $('#btnCancel');
var btnUpload = $('#btnUpload');
var galleryGrid = $('#galleryGrid');
var galleryLoading = $('#galleryLoading');
var galleryEmpty = $('#galleryEmpty');
var galleryNoSettings = $('#galleryNoSettings');
var searchInput = $('#searchInput');
var btnRefresh = $('#btnRefresh');
var btnSettings = $('#btnSettings');
var settingsModal = $('#settingsModal');
var btnCloseModal = $('#btnCloseModal');
var btnSaveSettings = $('#btnSaveSettings');
var deleteModal = $('#deleteModal');
var btnCloseDelete = $('#btnCloseDelete');
var btnCancelDelete = $('#btnCancelDelete');
var btnConfirmDelete = $('#btnConfirmDelete');
var deleteFileName = $('#deleteFileName');
var toastContainer = $('#toastContainer');
var groupTabs = $('#groupTabs');
var selectAllLabel = $('#selectAllLabel');
var selectAllCheckbox = $('#selectAllCheckbox');
var btnBatchCopy = $('#btnBatchCopy');
var btnBatchDelete = $('#btnBatchDelete');
var newGroupModal = $('#newGroupModal');
var newGroupInput = $('#newGroupInput');
var btnCreateGroup = $('#btnCreateGroup');
var btnCloseNewGroup = $('#btnCloseNewGroup');
var btnCancelNewGroup = $('#btnCancelNewGroup');
var moveGroupModal = $('#moveGroupModal');
var moveGroupSelect = $('#moveGroupSelect');
var btnConfirmMove = $('#btnConfirmMove');
var btnCloseMove = $('#btnCloseMove');
var btnCancelMove = $('#btnCancelMove');

var tokenInput = $('#token');
var ownerInput = $('#owner');
var repoInput = $('#repo');
var branchInput = $('#branch');

var selectedImages = {};
var currentFiles = [];
var pendingDelete = null;
var currentGroup = 'all';
var groups = [];
var allImages = [];
var pendingRename = null;
var pendingMove = null;

// ========== Toast ==========
function showToast(message, type) {
  type = type || 'success';
  var toast = document.createElement('div');
  toast.className = 'toast' + (type === 'error' ? ' error' : '');
  toast.innerHTML = '<span>' + escapeHtml(message) + '</span><button onclick="this.parentElement.remove()">&times;</button>';
  toastContainer.appendChild(toast);
  setTimeout(function () { if (toast.parentElement) toast.remove(); }, 4000);
}

function escapeHtml(str) {
  var div = document.createElement('div');
  div.appendChild(document.createTextNode(str));
  return div.innerHTML;
}

// ========== GitHub API ==========
function apiHeaders() {
  var headers = { Accept: 'application/vnd.github+json' };
  if (settings.token) headers.Authorization = 'Bearer ' + settings.token;
  return headers;
}

function imagesRoot() { return 'images'; }

// ========== 内存缓存（TTL 缓存，减少 API 请求） ==========
var CACHE_VERSION = 2;
(function () {
  try {
    var v = localStorage.getItem('sticker:cacheVersion');
    if (v !== String(CACHE_VERSION)) {
      // 版本不匹配，清除所有旧缓存
      localStorage.removeItem('sticker:groupData');
      localStorage.removeItem('sticker:imageList');
      localStorage.setItem('sticker:cacheVersion', CACHE_VERSION);
    }
  } catch (e) {}
})();

var cacheStore = {};

// localStorage 持久化 key 列表（跨页面加载保持缓存）
var CACHE_PERSIST_KEYS = ['groupData', 'imageList'];

function cacheGet(key) {
  var entry = cacheStore[key];
  if (entry && Date.now() - entry.ts <= entry.ttl) return entry.data;
  if (entry) delete cacheStore[key];
  // 内存未命中，尝试从 localStorage 恢复
  try {
    var saved = localStorage.getItem('sticker:' + key);
    if (saved) {
      entry = JSON.parse(saved);
      if (Date.now() - entry.ts <= entry.ttl) {
        cacheStore[key] = { data: entry.data, ts: Date.now(), ttl: 30000 };
        return entry.data;
      }
      localStorage.removeItem('sticker:' + key);
    }
  } catch (e) {}
  return null;
}

function cacheSet(key, data, ttl) {
  cacheStore[key] = { data: data, ts: Date.now(), ttl: ttl || 30000 };
  // 重要数据持久化到 localStorage（60 秒 TTL，允许跨标签页快速恢复但不过期太久）
  if (CACHE_PERSIST_KEYS.indexOf(key) >= 0) {
    try {
      localStorage.setItem('sticker:' + key, JSON.stringify({
        data: data,
        ts: Date.now(),
        ttl: 60 * 1000
      }));
    } catch (e) {}
  }
}

function cacheClear() {
  cacheStore = {};
  CACHE_PERSIST_KEYS.forEach(function (k) { try { localStorage.removeItem('sticker:' + k); } catch (e) {} });
}

function cacheClearKey(key) {
  delete cacheStore[key];
  try { localStorage.removeItem('sticker:' + key); } catch (e) {}
}

// ========== 分组数据管理（扁平存储，group 信息存入 .group-data.json） ==========
var groupData = {};
var groupDataSha = null;

async function readGroupData(force) {
  if (!force) {
    var cached = cacheGet('groupData');
    if (cached) { groupData = cached.data; groupDataSha = cached.sha; return; }
  }
  var url = 'https://api.github.com/repos/' + encodeURIComponent(settings.owner) + '/' + encodeURIComponent(settings.repo) + '/contents/images/.group-data.json?ref=' + encodeURIComponent(settings.branch || 'main');
  try {
    var res = await fetch(url, { headers: apiHeaders() });
    if (!res.ok) return;
    var data = await res.json();
    groupDataSha = data.sha;
    groupData = JSON.parse(decodeURIComponent(escape(atob(data.content))));
    cacheSet('groupData', { data: groupData, sha: groupDataSha }, 30000);
  } catch (e) {}
}

async function saveGroupData() {
  var url = 'https://api.github.com/repos/' + encodeURIComponent(settings.owner) + '/' + encodeURIComponent(settings.repo) + '/contents/images/.group-data.json';
  var content = btoa(unescape(encodeURIComponent(JSON.stringify(groupData, null, 2))));
  for (var attempt = 0; attempt < 3; attempt++) {
    var body = {
      message: 'Update group data',
      content: content,
      branch: settings.branch || 'main'
    };
    if (groupDataSha) body.sha = groupDataSha;
    var res = await fetch(url, { method: 'PUT', headers: apiHeaders(), body: JSON.stringify(body) });
    if (res.ok) {
      try { var r = await res.json(); if (r.content) groupDataSha = r.content.sha; } catch (e) {}
      cacheClearKey('groupData');
      return true;
    }
    if (res.status === 409) {
      // SHA 冲突，重新获取最新 SHA 后重试
      try {
        var get = await fetch(url + '?ref=' + encodeURIComponent(settings.branch || 'main'), { headers: apiHeaders() });
        if (get.ok) {
          var fresh = await get.json();
          groupDataSha = fresh.sha;
          // 合并远程数据到本地（保留本地新增，补充远程独有）
          var remote = JSON.parse(decodeURIComponent(escape(atob(fresh.content))));
          if (remote._groups) {
            remote._groups.forEach(function (g) {
              if (groupData._groups.indexOf(g) < 0) groupData._groups.push(g);
            });
          }
          if (remote._order) {
            remote._order.forEach(function (n) {
              if (groupData._order.indexOf(n) < 0) groupData._order.push(n);
            });
          }
          Object.keys(remote).forEach(function (k) {
            if (k === '_order' || k === '_groups') return;
            if (!groupData[k]) groupData[k] = remote[k];
          });
          content = btoa(unescape(encodeURIComponent(JSON.stringify(groupData, null, 2))));
          continue;
        }
      } catch (e) {}
      break;
    }
    if (res.status >= 400) break;
  }
  cacheClearKey('groupData');
  return false;
}

async function discoverGroups() {
  await readGroupData();
  var gs = ['default'];
  var seen = {};
  // 从文件分组映射中收集
  Object.keys(groupData).forEach(function (k) {
    if (k === '_groups' || k === '_order') return;
    var g = groupData[k];
    if (g && typeof g === 'string' && !seen[g]) { seen[g] = true; gs.push(g); }
  });
  // 从空分组列表中收集
  if (groupData._groups && Array.isArray(groupData._groups)) {
    groupData._groups.forEach(function (g) {
      if (!seen[g]) { seen[g] = true; gs.push(g); }
    });
  }
  return gs;
}

async function listImages(group) {
  if (group === 'all') return listAllImages();
  // 有全量缓存时直接从本地过滤，不请求 API
  if (fullImageList && fullImageList.length > 0) {
    return filterByGroup(fullImageList, group);
  }
  var data = await fetchImageList();
  var results = [];
  data.forEach(function (f) {
    if (f.type !== 'file') return;
    if (f.name === '.group-data.json') return;
    var name = f.name.toLowerCase();
    var exts = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'];
    if (exts.some(function (e) { return name.endsWith('.' + e); })) {
      f._group = groupData[f.name] || null;
      results.push(f);
    }
  });
  return sortByOrder(filterByGroup(results, group));
}

function filterByGroup(arr, group) {
  return arr.filter(function (f) {
    var fg = f._group || null;
    if (group === 'default') return !fg;
    return fg === group;
  });
}

async function fetchImageList() {
  var cached = cacheGet('imageList');
  if (cached) return cached;
  var url = 'https://api.github.com/repos/' + encodeURIComponent(settings.owner) + '/' + encodeURIComponent(settings.repo) + '/contents/' + encodeURIComponent(imagesRoot()) + '?ref=' + encodeURIComponent(settings.branch || 'main');
  var res = await fetch(url, { headers: apiHeaders() });
  if (res.status === 404) return [];
  if (!res.ok) return [];
  var data = await res.json();
  if (!Array.isArray(data)) return [];
  cacheSet('imageList', data, 30000);
  return data;
}

function sortByOrder(arr) {
  var order = groupData._order;
  if (!order || !order.length) return arr;
  var indexMap = {};
  order.forEach(function (name, i) { indexMap[name] = i; });
  return arr.sort(function (a, b) {
    var ai = indexMap.hasOwnProperty(a.name) ? indexMap[a.name] : 999999;
    var bi = indexMap.hasOwnProperty(b.name) ? indexMap[b.name] : 999999;
    return ai - bi;
  });
}

var fullImageList = null;

async function listAllImages() {
  var data = await fetchImageList();
  var exts = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'];
  var all = [];
  data.forEach(function (f) {
    if (f.type !== 'file') return;
    if (f.name === '.group-data.json') return;
    var name = f.name.toLowerCase();
    if (exts.some(function (e) { return name.endsWith('.' + e); })) {
      f._group = groupData[f.name] || null;
      all.push(f);
    }
  });
  fullImageList = sortByOrder(all);
  return fullImageList;
}

async function getFileContent(path) {
  var url = 'https://api.github.com/repos/' + encodeURIComponent(settings.owner) + '/' + encodeURIComponent(settings.repo) + '/contents/' + encodeURIComponent(path) + '?ref=' + encodeURIComponent(settings.branch || 'main');
  var res = await fetch(url, { headers: apiHeaders() });
  if (!res.ok) throw new Error('获取文件内容失败: HTTP ' + res.status);
  return res.json();
}

async function uploadImageFile(filename, base64Content, group) {
  var path = imagesRoot() + '/' + filename;
  var url = 'https://api.github.com/repos/' + encodeURIComponent(settings.owner) + '/' + encodeURIComponent(settings.repo) + '/contents/' + encodeURIComponent(path);
  var res = await fetch(url, {
    method: 'PUT',
    headers: apiHeaders(),
    body: JSON.stringify({ message: 'Upload sticker: ' + filename, content: base64Content, branch: settings.branch || 'main' }),
  });
  if (res.status === 409) throw new Error('文件 "' + filename + '" 已存在，请修改文件名');
  if (res.status === 422) {
    var errData = await res.json().catch(function () { return {}; });
    throw new Error(errData.message || '上传失败，可能是文件名不合法');
  }
  if (!res.ok) {
    var errData2 = await res.json().catch(function () { return {}; });
    if (res.status === 401) throw new Error('Token 无效或已过期，请在设置中更新');
    throw new Error(errData2.message || '上传失败: HTTP ' + res.status);
  }
  return res.json();
}

async function deleteImageFile(path, sha) {
  var url = 'https://api.github.com/repos/' + encodeURIComponent(settings.owner) + '/' + encodeURIComponent(settings.repo) + '/contents/' + encodeURIComponent(path);
  var res = await fetch(url, {
    method: 'DELETE',
    headers: apiHeaders(),
    body: JSON.stringify({ message: 'Delete sticker: ' + path.split('/').pop(), sha: sha, branch: settings.branch || 'main' }),
  });
  if (!res.ok) {
    var errData = await res.json().catch(function () { return {}; });
    throw new Error(errData.message || '删除失败: HTTP ' + res.status);
  }
}

async function renameImageFile(oldPath, oldSha, newName) {
  var oldFile = await getFileContent(oldPath);
  var dir = oldPath.substring(0, oldPath.lastIndexOf('/'));
  var newPath = dir + '/' + newName;
  var newUrl = 'https://api.github.com/repos/' + encodeURIComponent(settings.owner) + '/' + encodeURIComponent(settings.repo) + '/contents/' + encodeURIComponent(newPath);
  var createRes = await fetch(newUrl, {
    method: 'PUT',
    headers: apiHeaders(),
    body: JSON.stringify({ message: 'Rename: ' + oldPath.split('/').pop() + ' → ' + newName, content: oldFile.content, branch: settings.branch || 'main' }),
  });
  if (createRes.status === 409) throw new Error('文件名 "' + newName + '" 已存在，请换一个名字');
  if (!createRes.ok) {
    var err = await createRes.json().catch(function () { return {}; });
    throw new Error(err.message || '重命名失败');
  }
  var created = await createRes.json();
  await deleteImageFile(oldPath, oldSha);
  cacheClearKey('imageList'); fullImageList = null;
  return { sha: created.content.sha, path: newPath, oldName: oldPath.split('/').pop() };
}

async function moveImageFile(oldPath, oldSha, newGroup) {
  var filename = oldPath.split('/').pop();
  if (newGroup && newGroup !== 'default') {
    groupData[filename] = newGroup;
  } else {
    delete groupData[filename];
  }
  await saveGroupData();
}

async function createGroupDir(name) {
  if (!name || name.trim() === '') throw new Error('分组名不能为空');
  await readGroupData();
  var groups = groupData._groups || [];
  if (groups.indexOf(name) >= 0) throw new Error('分组 "' + name + '" 已存在');
  groups.push(name);
  groupData._groups = groups;
  await saveGroupData();
}

function getStickerUrl(filename, group) {
  return 'https://cdn.jsdelivr.net/gh/' + encodeURIComponent(settings.owner) + '/' + encodeURIComponent(settings.repo) + '@' + encodeURIComponent(settings.branch || 'main') + '/images/' + encodeURIComponent(filename);
}

function getRawUrl(filename) {
  return 'https://raw.githubusercontent.com/' + encodeURIComponent(settings.owner) + '/' + encodeURIComponent(settings.repo) + '/' + encodeURIComponent(settings.branch || 'main') + '/images/' + encodeURIComponent(filename);
}

// ========== 文件处理 ==========
function fileToBase64(file) {
  return new Promise(function (resolve, reject) {
    var reader = new FileReader();
    reader.onload = function () {
      var result = reader.result;
      var comma = result.indexOf(',');
      resolve(comma >= 0 ? result.substring(comma + 1) : result);
    };
    reader.onerror = function () { reject(new Error('文件读取失败')); };
    reader.readAsDataURL(file);
  });
}

function compressImage(file) {
  return new Promise(function (resolve) {
    // 小文件跳过压缩
    if (file.size < 300 * 1024) { resolve(file); return; }

    var img = new Image();
    var objUrl = URL.createObjectURL(file);
    img.onload = function () {
      URL.revokeObjectURL(objUrl);
      var w = img.width, h = img.height;
      var maxDim = 1920;
      var needsResize = w > maxDim || h > maxDim;

      if (!needsResize && file.size < 2 * 1024 * 1024) { resolve(file); return; }

      if (needsResize) {
        if (w > h) { h = Math.round(h * maxDim / w); w = maxDim; }
        else { w = Math.round(w * maxDim / h); h = maxDim; }
      }

      var canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      var ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, w, h);

      var mimeType = file.type === 'image/png' || file.type === 'image/webp' ? 'image/png' : 'image/jpeg';
      var quality = mimeType === 'image/jpeg' ? 0.85 : 1;

      canvas.toBlob(function (blob) {
        if (blob && blob.size < file.size) {
          var compressed = new File([blob], file.name, { type: mimeType, lastModified: Date.now() });
          resolve(compressed);
        } else {
          resolve(file);
        }
      }, mimeType, quality);
    };
    img.onerror = function () { resolve(file); };
    img.src = objUrl;
  });
}

function handleFileSelect(files) {
  if (!files || files.length === 0) return;
  var fileList = files instanceof FileList ? Array.from(files) : (Array.isArray(files) ? files : [files]);
  var added = 0;
  var dupes = 0;
  var skipped = 0;
  fileList.forEach(function (file) {
    if (!file.type.startsWith('image/')) { showToast(file.name + ' 不是图片文件', 'error'); return; }
    if (file.size > 10 * 1024 * 1024) { showToast(file.name + ' 超过 10MB 限制', 'error'); return; }
    // 本地列表去重
    var exists = currentFiles.some(function (f) { return f.file.name === file.name && f.file.size === file.size; });
    if (exists) { dupes++; return; }
    // 图库去重：排除已上传的同名图片
    if (allImages.length > 0 && allImages.some(function (img) { return img.name === file.name; })) {
      skipped++;
      return;
    }
    currentFiles.push({ file: file, customName: null });
    added++;
  });
  if (dupes > 0) showToast(dupes + ' 个重复文件已跳过', 'error');
  if (skipped > 0) showToast('已跳过 ' + skipped + ' 个已上传的图片');
  if (added === 0) return;
  renderBatchList();
  // 保持上传区可见，缩为紧凑模式，允许继续添加
  uploadZone.classList.add('compact');
  uploadPreview.classList.remove('hidden');
  // 关键：重置 input，确保再次选择同一文件时也能触发 change 事件
  fileInput.value = '';
}

function renderBatchList() {
  previewGroup.innerHTML = '<option value="default">默认分组</option>';
  groups.forEach(function (g) {
    if (g !== 'default') {
      previewGroup.innerHTML += '<option value="' + escapeHtml(g) + '">' + escapeHtml(g) + '</option>';
    }
  });
  if (currentGroup !== 'all' && currentGroup !== 'default') {
    previewGroup.value = currentGroup;
  }
  batchCount.textContent = '已选 ' + currentFiles.length + ' 个文件';
  batchList.innerHTML = '';
  currentFiles.forEach(function (item, index) {
    var div = document.createElement('div');
    div.className = 'batch-item';
    var url = URL.createObjectURL(item.file);
    var displayName = item.customName || item.file.name;
    var dot = displayName.lastIndexOf('.');
    var baseName = dot > 0 ? displayName.substring(0, dot) : displayName;
    var ext = dot > 0 ? displayName.substring(dot) : '';
    div.innerHTML = '<img class="batch-thumb" src="' + url + '" alt="">'
      + '<div class="batch-name-wrap" data-index="' + index + '">'
      + '<span class="batch-filename-text">' + escapeHtml(baseName) + '</span><span class="batch-ext">' + escapeHtml(ext) + '</span>'
      + '<input class="batch-rename-input hidden" type="text" value="' + escapeHtml(baseName) + '">'
      + '</div>'
      + '<button class="batch-remove" data-index="' + index + '">×</button>';
    batchList.appendChild(div);
  });
  batchList.querySelectorAll('.batch-remove').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var idx = parseInt(this.getAttribute('data-index'));
      if (!isNaN(idx)) {
        currentFiles.splice(idx, 1);
        if (currentFiles.length === 0) resetUpload();
        else renderBatchList();
      }
    });
  });
  // 上传前点击文件名重命名
  batchList.querySelectorAll('.batch-filename-text').forEach(function (el) {
    el.addEventListener('click', function () {
      var wrap = this.parentElement;
      var input = wrap.querySelector('.batch-rename-input');
      if (!input) return;
      wrap.querySelector('.batch-filename-text').classList.add('hidden');
      wrap.querySelector('.batch-ext').classList.add('hidden');
      input.classList.remove('hidden');
      input.focus();
      input.select();
    });
  });
  batchList.querySelectorAll('.batch-rename-input').forEach(function (input) {
    function confirmRename() {
      var wrap = input.parentElement;
      var idx = parseInt(wrap.getAttribute('data-index'));
      var val = input.value.trim();
      if (!val) { cancelRename(); return; }
      var item = currentFiles[idx];
      if (item) {
        var dot = item.file.name.lastIndexOf('.');
        var ext = dot > 0 ? item.file.name.substring(dot) : '';
        item.customName = val + ext;
      }
      renderBatchList();
    }
    function cancelRename() {
      renderBatchList();
    }
    input.addEventListener('blur', confirmRename);
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); this.blur(); }
      else if (e.key === 'Escape') { e.preventDefault(); cancelRename(); }
    });
  });
}

async function doUpload() {
  if (currentFiles.length === 0) return;
  var group = previewGroup.value;
  btnUpload.disabled = true;
  var total = currentFiles.length;
  var success = 0;
  var failed = 0;
  var uploadedNames = [];
  for (var i = 0; i < currentFiles.length; i++) {
    var item = currentFiles[i];
    var filename = item.customName || item.file.name;
    btnUpload.textContent = '压缩上传中... (' + (i + 1) + '/' + total + ')';
    try {
      var compressed = await compressImage(item.file);
      var base64 = await fileToBase64(compressed);
      await uploadImageFile(filename, base64, group);
      uploadedNames.push(filename);
      success++;
    } catch (e) {
      showToast(filename + ': ' + e.message, 'error');
      failed++;
    }
  }
  // 维护 _order 和分组信息
  if (uploadedNames.length > 0) {
    await readGroupData(true);
    if (!groupData._order) groupData._order = [];
    uploadedNames.forEach(function (n) {
      if (groupData._order.indexOf(n) < 0) groupData._order.push(n);
    });
    if (group && group !== 'default') {
      uploadedNames.forEach(function (n) { groupData[n] = group; });
    }
    await saveGroupData();
  }
  cacheClearKey('imageList'); fullImageList = null;
  if (success > 0) showToast('成功上传 ' + success + ' 个文件' + (failed > 0 ? '，' + failed + ' 个失败' : ''));
  resetUpload();
  btnUpload.disabled = false;
  btnUpload.textContent = '上传全部图片';
  if (success > 0) await refreshAfterMutation();
}

function resetUpload() {
  currentFiles = [];
  uploadZone.classList.remove('compact');
  uploadZone.classList.remove('hidden');
  uploadPreview.classList.add('hidden');
  fileInput.value = '';
}

// ========== 懒加载图片观察器（限制并发） ==========
var loadQueue = [];
var activeLoads = 0;
var MAX_LOADS = 3;

function processLoadQueue() {
  while (activeLoads < MAX_LOADS && loadQueue.length > 0) {
    var task = loadQueue.shift();
    activeLoads++;
    task.img.src = task.src;
    task.img.removeAttribute('data-src');
  }
}

function onImgDone() { activeLoads--; processLoadQueue(); }

var imageObserver = new IntersectionObserver(function (entries) {
  entries.forEach(function (entry) {
    if (entry.isIntersecting) {
      var img = entry.target;
      var src = img.getAttribute('data-src');
      if (src) {
        loadQueue.push({ img: img, src: src });
        imageObserver.unobserve(img);
        processLoadQueue();
      }
    }
  });
}, { rootMargin: '200px' });

// ========== 分组标签 ==========
function renderGroupTabs() {
  var html = '';
  html += '<button class="group-tab' + (currentGroup === 'all' ? ' active' : '') + '" data-group="all">全部</button>';
  groups.forEach(function (g) {
    var label = g === 'default' ? '默认' : g;
    html += '<button class="group-tab' + (currentGroup === g ? ' active' : '') + '" data-group="' + escapeHtml(g) + '">' + escapeHtml(label) + '</button>';
  });
  html += '<button class="group-tab group-tab-add" id="btnNewGroup">+</button>';
  html += '<button class="group-tab group-tab-manage" id="btnManageGroups" title="管理分组">⚙</button>';
  groupTabs.innerHTML = html;

  // 绑定事件
  groupTabs.querySelectorAll('[data-group]').forEach(function (btn) {
    btn.addEventListener('click', function () { switchGroup(this.getAttribute('data-group')); });
  });
  var btnNew = document.getElementById('btnNewGroup');
  if (btnNew) btnNew.addEventListener('click', openNewGroupModal);
  var btnManage = document.getElementById('btnManageGroups');
  if (btnManage) btnManage.addEventListener('click', openManageGroupsModal);
}

async function switchGroup(group) {
  currentGroup = group;
  selectedImages = {};
  selectAllCheckbox.checked = false;
  updateBatchUI();
  await loadGallery();
  renderGroupTabs();
}

// ========== 图库 ==========
function delay(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }

async function refreshAfterMutation() {
  await delay(600);
  await refreshAll();
}

async function refreshAll() {
  groups = await discoverGroups();
  renderGroupTabs();
  if (currentGroup !== 'all' && groups.indexOf(currentGroup) < 0) {
    currentGroup = 'all';
    renderGroupTabs();
  }
  await loadGallery();
}

async function loadGallery() {
  if (!settings.token && !settings.owner) { showEmptyState('noSettings'); return; }
  await readGroupData();
  // 已有图片或有本地缓存时不显示 loading 闪动
  var hasCards = galleryGrid.querySelectorAll('.sticker-card').length > 0;
  var hasLocalCache = false;
  try { hasLocalCache = !!localStorage.getItem('sticker:imageList'); } catch (e) {}
  if (!hasCards && !hasLocalCache) showEmptyState('loading');
  selectedImages = {};
  selectAllCheckbox.checked = false;
  updateBatchUI();
  try {
    allImages = await listImages(currentGroup);
    if (allImages.length === 0) {
      showEmptyState('empty');
    } else {
      hideAllStates();
      renderCards(filterImages());
    }
  } catch (e) {
    showToast('加载失败: ' + e.message, 'error');
    showEmptyState('empty');
  }
}

function showEmptyState(state) {
  hideAllStates();
  if (state === 'loading') galleryLoading.classList.remove('hidden');
  else if (state === 'empty') galleryEmpty.classList.remove('hidden');
  else if (state === 'noSettings') galleryNoSettings.classList.remove('hidden');
}

function hideAllStates() {
  galleryLoading.classList.add('hidden');
  galleryEmpty.classList.add('hidden');
  galleryNoSettings.classList.add('hidden');
}

function filterImages() {
  var q = searchInput.value.trim().toLowerCase();
  if (!q) return allImages;
  return allImages.filter(function (img) { return img.name.toLowerCase().indexOf(q) >= 0; });
}

function renderCards(images) {
  var oldCards = galleryGrid.querySelectorAll('.sticker-card');
  oldCards.forEach(function (c) { c.remove(); });
  var noResult = document.getElementById('noSearchResult');
  if (noResult) noResult.remove();

  if (images.length === 0) {
    if (allImages.length > 0) {
      var el = document.createElement('div');
      el.className = 'gallery-status';
      el.innerHTML = '<div class="empty-icon">🔍</div><p>没有匹配的表情包</p>';
      el.id = 'noSearchResult';
      galleryGrid.appendChild(el);
    }
    return;
  }

  var BATCH = 20;
  var i = 0;

  function renderNextBatch() {
    var fragment = document.createDocumentFragment();
    var end = Math.min(i + BATCH, images.length);
    while (i < end) {
      try { fragment.appendChild(createCard(images[i])); } catch (e) {}
      i++;
    }
    galleryGrid.appendChild(fragment);
    if (i < images.length) {
      requestAnimationFrame(renderNextBatch);
    }
  }

  if (images.length > 50) {
    requestAnimationFrame(renderNextBatch);
  } else {
    var fragment = document.createDocumentFragment();
    images.forEach(function (img) { fragment.appendChild(createCard(img)); });
    galleryGrid.appendChild(fragment);
  }
}

function createCard(img) {
  var card = document.createElement('div');
  card.className = 'sticker-card';
  card.setAttribute('data-path', img.path);
  card.setAttribute('data-sha', img.sha);
  card.setAttribute('draggable', 'true');

  var imgWrap = document.createElement('div');
  imgWrap.className = 'card-img-wrap img-loading';

  var imgEl = document.createElement('img');
  imgEl.className = 'card-image';
  imgEl.setAttribute('data-src', getStickerUrl(img.name, img._group));
  imgEl.alt = img.name;
  imgEl.title = '点击复制链接';
  imgEl.addEventListener('click', function () { copyUrl(img.name, img._group, null); });
  imgEl.onload = function () {
    imgWrap.classList.remove('img-loading');
    onImgDone();
  };
  imgEl.onerror = function () {
    imgWrap.classList.remove('img-loading');
    onImgDone();
    if (imgEl.getAttribute('data-error')) return;
    imgEl.setAttribute('data-error', '1');
    imgEl.alt = '加载失败';
    imgWrap.classList.add('img-error');
    setTimeout(function () {
      imgWrap.classList.remove('img-error');
      imgEl.removeAttribute('data-error');
      imgEl.src = getStickerUrl(img.name, img._group) + '?_retry=' + Date.now();
    }, 10000);
  };
  imageObserver.observe(imgEl);

  var checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.className = 'card-checkbox';
  checkbox.title = '选择此表情包';
  checkbox.addEventListener('click', function (e) { e.stopPropagation(); toggleSelect(img, checkbox); });

  imgWrap.appendChild(imgEl);
  imgWrap.appendChild(checkbox);

  // 分组标签（仅在"全部"视图显示）
  if (currentGroup === 'all' && img._group) {
    var groupTag = document.createElement('span');
    groupTag.className = 'card-group-tag';
    groupTag.textContent = img._group;
    imgWrap.appendChild(groupTag);
  }

  var body = document.createElement('div');
  body.className = 'card-body';

  var nameEl = document.createElement('div');
  nameEl.className = 'card-name';
  nameEl.textContent = img.name;
  nameEl.title = '点击重命名';
  nameEl.style.cursor = 'pointer';
  nameEl.addEventListener('click', function (e) { e.stopPropagation(); startRename(card, img); });

  // 行内重命名
  var editRow = document.createElement('div');
  editRow.className = 'card-rename-row hidden';
  var editInput = document.createElement('input');
  editInput.className = 'card-rename-input';
  editInput.type = 'text';
  var extSpan = document.createElement('span');
  extSpan.className = 'card-rename-ext';
  editRow.appendChild(editInput);
  editRow.appendChild(extSpan);

  var actions = document.createElement('div');
  actions.className = 'card-actions';

  var copyBtn = document.createElement('button');
  copyBtn.className = 'btn-copy';
  copyBtn.textContent = '复制链接';
  copyBtn.addEventListener('click', function () { copyUrl(img.name, img._group, copyBtn); });

  var moveBtn = document.createElement('button');
  moveBtn.className = 'btn-move-card';
  moveBtn.textContent = '移动';
  moveBtn.addEventListener('click', function (e) { e.stopPropagation(); openMoveModal(img); });

  var deleteBtn = document.createElement('button');
  deleteBtn.className = 'btn-delete-card';
  deleteBtn.textContent = '删除';
  deleteBtn.addEventListener('click', function (e) { e.stopPropagation(); openDeleteModal(img); });

  actions.appendChild(copyBtn);
  actions.appendChild(moveBtn);
  actions.appendChild(deleteBtn);
  body.appendChild(nameEl);
  body.appendChild(editRow);
  body.appendChild(actions);
  card.appendChild(imgWrap);
  card.appendChild(body);
  return card;
}

// ========== 批量选择 ==========
function toggleSelect(img, checkbox) {
  if (checkbox.checked) {
    selectedImages[img.path] = img;
    checkbox.parentElement.parentElement.classList.add('selected');
  } else {
    delete selectedImages[img.path];
    checkbox.parentElement.parentElement.classList.remove('selected');
  }
  updateBatchUI();
}

function updateBatchUI() {
  var count = Object.keys(selectedImages).length;
  if (count > 0) {
    selectAllLabel.classList.remove('hidden');
    btnBatchCopy.classList.remove('hidden');
    btnBatchDelete.classList.remove('hidden');
    btnBatchCopy.textContent = '📋 复制选中 (' + count + ')';
    btnBatchDelete.textContent = '🗑️ 删除选中 (' + count + ')';
  } else {
    selectAllLabel.classList.add('hidden');
    btnBatchCopy.classList.add('hidden');
    btnBatchDelete.classList.add('hidden');
  }
}

function toggleSelectAll() {
  var checked = selectAllCheckbox.checked;
  var cards = galleryGrid.querySelectorAll('.sticker-card');
  cards.forEach(function (card) {
    var cb = card.querySelector('.card-checkbox');
    var path = card.getAttribute('data-path');
    if (cb && path) {
      cb.checked = checked;
      if (checked) {
        card.classList.add('selected');
        var found = allImages.find(function (img) { return img.path === path; });
        if (found) selectedImages[path] = found;
      } else {
        card.classList.remove('selected');
        delete selectedImages[path];
      }
    }
  });
  updateBatchUI();
}

function batchCopy() {
  var paths = Object.keys(selectedImages);
  if (paths.length === 0) return;
  var lines = paths.map(function (path) {
    var img = selectedImages[path];
    var displayName = img.name.replace(/\.(png|jpe?g|gif|webp|svg)$/i, '');
    return displayName + ': ' + getStickerUrl(img.name);
  });
  var text = lines.join('\n');
  try {
    awaitCopy(text);
    showToast('已复制 ' + paths.length + ' 个表情包链接');
  } catch (e) {
    showToast('复制失败，请重试', 'error');
  }
}

async function batchDelete() {
  var paths = Object.keys(selectedImages);
  if (paths.length === 0) return;
  if (!confirm('确定要删除选中的 ' + paths.length + ' 个表情包吗？此操作不可撤销。')) return;
  var success = 0;
  var failed = 0;
  for (var i = 0; i < paths.length; i++) {
    var img = selectedImages[paths[i]];
    showToast('删除中 (' + (i + 1) + '/' + paths.length + '): ' + img.name);
    try {
      await deleteImageFile(img.path, img.sha);
      var delName = img.name;
      if (groupData[delName]) {
        delete groupData[delName];
      }
      success++;
    } catch (e) {
      showToast(img.name + ': ' + e.message, 'error');
      failed++;
    }
  }
  if (success > 0) {
    if (groupData._order) {
      var deletedNames = Object.values(selectedImages).map(function (img) { return img.name; });
      groupData._order = groupData._order.filter(function (n) { return deletedNames.indexOf(n) < 0; });
    }
    try { await saveGroupData(); } catch (e) {}
    cacheClearKey('imageList'); fullImageList = null;
    selectedImages = {};
    selectAllCheckbox.checked = false;
    updateBatchUI();
    showToast('成功删除 ' + success + ' 个文件' + (failed > 0 ? '，' + failed + ' 个失败' : ''));
    await refreshAfterMutation();
  }
}

function awaitCopy(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(text);
  }
  return new Promise(function (resolve, reject) {
    try {
      var input = document.createElement('textarea');
      input.value = text;
      input.style.position = 'fixed';
      input.style.opacity = '0';
      document.body.appendChild(input);
      input.select();
      document.execCommand('copy');
      document.body.removeChild(input);
      resolve();
    } catch (e) { reject(e); }
  });
}

// ========== 重命名 ==========
function startRename(card, img) {
  if (pendingRename) cancelRename();
  var nameEl = card.querySelector('.card-name');
  var editRow = card.querySelector('.card-rename-row');
  var editInput = editRow.querySelector('.card-rename-input');
  var extSpan = editRow.querySelector('.card-rename-ext');
  var dot = img.name.lastIndexOf('.');
  var baseName = dot >= 0 ? img.name.substring(0, dot) : img.name;
  var ext = dot >= 0 ? img.name.substring(dot) : '';
  editInput.value = baseName;
  extSpan.textContent = ext;
  nameEl.classList.add('hidden');
  editRow.classList.remove('hidden');
  editInput.focus();
  editInput.select();
  pendingRename = { card: card, img: img, nameEl: nameEl, editRow: editRow, editInput: editInput, ext: ext };
  // 点击其他地方自动保存
  editInput.onblur = function () { confirmRename(); };
}

function cancelRename() {
  if (!pendingRename) return;
  pendingRename.nameEl.classList.remove('hidden');
  pendingRename.editRow.classList.add('hidden');
  pendingRename = null;
}

async function confirmRename() {
  if (!pendingRename) return;
  var r = pendingRename;
  var newBase = r.editInput.value.trim();
  if (!newBase) { showToast('请输入文件名', 'error'); return; }
  var newName = newBase + r.ext;
  if (newName === r.img.name) { cancelRename(); return; }
  r.editInput.disabled = true;
  try {
    var result = await renameImageFile(r.img.path, r.img.sha, newName);
    // 更新 DOM 和数据（r 指向原始卡片，始终有效）
    var oldName = r.img.name;
    r.img.name = newName;
    r.img.path = result.path;
    r.img.sha = result.sha;
    r.nameEl.textContent = newName;
    r.card.setAttribute('data-path', r.img.path);
    r.card.setAttribute('data-sha', r.img.sha);
    for (var i = 0; i < allImages.length; i++) {
      if (allImages[i].name === oldName) {
        allImages[i].name = newName;
        allImages[i].path = r.img.path;
        allImages[i].sha = r.img.sha;
        break;
      }
    }
    // 合并更新分组映射 + _order，有变更时一次保存
    var gdChanged = false;
    if (groupData[oldName]) {
      groupData[newName] = groupData[oldName];
      delete groupData[oldName];
      gdChanged = true;
    }
    if (groupData._order) {
      var orderIdx = groupData._order.indexOf(oldName);
      if (orderIdx >= 0) { groupData._order[orderIdx] = newName; gdChanged = true; }
    }
    if (gdChanged) await saveGroupData();
    // 仅当异步期间用户没有开始重命名其他图片时才关闭编辑状态
    if (pendingRename === r) {
      showToast('已重命名为: ' + newName);
      cancelRename();
    }
  } catch (e) {
    if (pendingRename === r) {
      showToast(e.message, 'error');
      r.editInput.disabled = false;
      r.editInput.focus();
    }
  }
}

// ========== 拖拽排序 ==========
function reorderCard(srcCard, targetCard, before) {
  if (!srcCard || !targetCard || srcCard === targetCard) return;
  var srcName = getCardName(srcCard);
  var targetName = getCardName(targetCard);
  if (!srcName || !targetName) return;
  var order = groupData._order || [];
  if (order.indexOf(srcName) < 0) order.push(srcName);
  if (order.indexOf(targetName) < 0) order.push(targetName);
  var srcIdx = order.indexOf(srcName);
  var targetIdx = order.indexOf(targetName);
  order.splice(srcIdx, 1);
  if (srcIdx < targetIdx) targetIdx--;
  order.splice(before ? targetIdx : targetIdx + 1, 0, srcName);
  groupData._order = order;
  if (before) {
    galleryGrid.insertBefore(srcCard, targetCard);
  } else {
    galleryGrid.insertBefore(srcCard, targetCard.nextSibling);
  }
  saveGroupData().catch(function () {});
}

function getCardName(card) {
  var path = card.getAttribute('data-path');
  if (path) return path.split('/').pop();
  return null;
}

function clearDragClasses() {
  galleryGrid.querySelectorAll('.sticker-card').forEach(function (c) {
    c.classList.remove('dragging', 'drop-before', 'drop-after');
  });
}

// == 桌面拖拽 ==
galleryGrid.addEventListener('dragstart', function (e) {
  var card = e.target.closest('.sticker-card');
  if (!card) return;
  card.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', card.getAttribute('data-path'));
});

galleryGrid.addEventListener('dragover', function (e) {
  e.preventDefault();
  var card = e.target.closest('.sticker-card');
  if (!card || card.classList.contains('dragging')) return;
  clearDragClasses();
  var rect = card.getBoundingClientRect();
  if (e.clientY < rect.top + rect.height / 2) {
    card.classList.add('drop-before');
  } else {
    card.classList.add('drop-after');
  }
});

galleryGrid.addEventListener('drop', function (e) {
  e.preventDefault();
  var path = e.dataTransfer.getData('text/plain');
  var srcCard = galleryGrid.querySelector('.sticker-card[data-path="' + path + '"]');
  var targetCard = document.querySelector('.sticker-card.drop-before') || document.querySelector('.sticker-card.drop-after');
  if (srcCard && targetCard) {
    reorderCard(srcCard, targetCard, targetCard.classList.contains('drop-before'));
  }
  clearDragClasses();
});

galleryGrid.addEventListener('dragend', clearDragClasses);

// == 手机端长按拖拽 ==
var touchState = null;

galleryGrid.addEventListener('touchstart', function (e) {
  var card = e.target.closest('.sticker-card');
  if (!card || e.touches.length > 1) return;
  var t = e.touches[0];
  touchState = { card: card, sx: t.clientX, sy: t.clientY, active: false, ghost: null };
  touchState.timer = setTimeout(function () {
    touchState.active = true;
    card.classList.add('dragging');
    var ghost = card.cloneNode(true);
    ghost.className = 'drag-ghost';
    ghost.style.width = card.offsetWidth + 'px';
    ghost.style.left = (t.clientX - card.offsetWidth / 2) + 'px';
    ghost.style.top = (t.clientY - card.offsetHeight / 2) + 'px';
    document.body.appendChild(ghost);
    touchState.ghost = ghost;
  }, 500);
}, { passive: false });

galleryGrid.addEventListener('touchmove', function (e) {
  if (!touchState) return;
  var t = e.touches[0];
  if (!touchState.active) {
    if (Math.abs(t.clientX - touchState.sx) > 10 || Math.abs(t.clientY - touchState.sy) > 10) {
      clearTimeout(touchState.timer);
      touchState = null;
    }
    return;
  }
  e.preventDefault();
  touchState.ghost.style.left = (t.clientX - touchState.ghost.offsetWidth / 2) + 'px';
  touchState.ghost.style.top = (t.clientY - touchState.ghost.offsetHeight / 2) + 'px';
  var el = document.elementFromPoint(t.clientX, t.clientY);
  var targetCard = el ? el.closest('.sticker-card') : null;
  clearDragClasses();
  if (targetCard && targetCard !== touchState.card) {
    var rect = targetCard.getBoundingClientRect();
    if (t.clientY < rect.top + rect.height / 2) {
      targetCard.classList.add('drop-before');
    } else {
      targetCard.classList.add('drop-after');
    }
  }
}, { passive: false });

document.addEventListener('touchend', function () {
  if (!touchState) return;
  clearTimeout(touchState.timer);
  if (touchState.ghost) document.body.removeChild(touchState.ghost);
  if (touchState.active) {
    var targetCard = document.querySelector('.sticker-card.drop-before') || document.querySelector('.sticker-card.drop-after');
    if (targetCard) reorderCard(touchState.card, targetCard, targetCard.classList.contains('drop-before'));
  }
  clearDragClasses();
  touchState = null;
});

// ========== 复制链接 ==========
async function copyUrl(filename, group, btn) {
  var cdnUrl = getStickerUrl(filename);
  var rawUrl = getRawUrl(filename);
  var displayName = filename.replace(/\.(png|jpe?g|gif|webp|svg)$/i, '');
  var text = displayName + ': ' + cdnUrl + '\n' + displayName + '（直链）: ' + rawUrl;
  try {
    await navigator.clipboard.writeText(text);
    if (btn) {
      btn.textContent = '已复制!';
      btn.classList.add('copied');
      setTimeout(function () { btn.textContent = '复制链接'; btn.classList.remove('copied'); }, 1500);
    }
    showToast('链接已复制到剪贴板');
  } catch (e) {
    var input = document.createElement('input');
    input.value = text;
    document.body.appendChild(input);
    input.select();
    document.execCommand('copy');
    document.body.removeChild(input);
    showToast('链接已复制到剪贴板');
  }
}

// ========== 删除 ==========
function openDeleteModal(img) {
  pendingDelete = img;
  deleteFileName.textContent = img.name;
  deleteModal.showModal();
}

async function confirmDelete() {
  if (!pendingDelete) return;
  btnConfirmDelete.disabled = true;
  btnConfirmDelete.textContent = '删除中...';
  try {
    await deleteImageFile(pendingDelete.path, pendingDelete.sha);
    // 清理分组数据和 _order
    var delName = pendingDelete.name;
    if (groupData[delName]) delete groupData[delName];
    if (groupData._order) {
      groupData._order = groupData._order.filter(function (n) { return n !== delName; });
    }
    await saveGroupData();
    cacheClearKey('imageList'); fullImageList = null;
    showToast('已删除: ' + delName);
    deleteModal.close();
    pendingDelete = null;
    await refreshAfterMutation();
  } catch (e) {
    showToast(e.message, 'error');
  } finally {
    btnConfirmDelete.disabled = false;
    btnConfirmDelete.textContent = '删除';
  }
}

// ========== 移动分组 ==========
function openMoveModal(img) {
  pendingMove = img;
  var html = '';
  groups.forEach(function (g) {
    var label = g === 'default' ? '默认分组' : g;
    var currentGroupName = img._group || 'default';
    var selected = g === currentGroupName ? ' selected' : '';
    html += '<option value="' + escapeHtml(g) + '"' + selected + '>' + escapeHtml(label) + '</option>';
  });
  moveGroupSelect.innerHTML = html;
  moveGroupModal.showModal();
}

async function confirmMove() {
  if (!pendingMove) return;
  var newGroup = moveGroupSelect.value;
  var currentGroupName = pendingMove._group || 'default';
  if (newGroup === currentGroupName) { moveGroupModal.close(); return; }
  btnConfirmMove.disabled = true;
  btnConfirmMove.textContent = '移动中...';
  try {
    await moveImageFile(pendingMove.path, pendingMove.sha, newGroup);
    showToast('已移动到: ' + (newGroup === 'default' ? '默认分组' : newGroup));
    moveGroupModal.close();
    pendingMove = null;
    await refreshAfterMutation();
  } catch (e) {
    showToast(e.message, 'error');
  } finally {
    btnConfirmMove.disabled = false;
    btnConfirmMove.textContent = '移动';
  }
}

// ========== 新建分组 ==========
function openNewGroupModal() {
  newGroupInput.value = '';
  newGroupModal.showModal();
  setTimeout(function () { newGroupInput.focus(); }, 100);
}

async function createNewGroup() {
  var name = newGroupInput.value.trim();
  if (!name) { showToast('请输入分组名称', 'error'); return; }
  if (!/^[\w一-龥]+$/.test(name)) { showToast('分组名只能包含中英文、数字和下划线', 'error'); return; }
  if (name === 'default' || name === 'all') { showToast('分组名不能使用保留字', 'error'); return; }
  btnCreateGroup.disabled = true;
  btnCreateGroup.textContent = '创建中...';
  try {
    await createGroupDir(name);
    showToast('分组 "' + name + '" 已创建');
    newGroupModal.close();
    await refreshAfterMutation();
    switchGroup(name);
  } catch (e) {
    showToast(e.message, 'error');
  } finally {
    btnCreateGroup.disabled = false;
    btnCreateGroup.textContent = '创建';
  }
}

// ========== 管理分组 ==========
var manageGroupsModal = $('#manageGroupsModal');
var manageGroupsList = $('#manageGroupsList');
var btnCloseManageGroups = $('#btnCloseManageGroups');
var btnCancelManageGroups = $('#btnCancelManageGroups');

function openManageGroupsModal() {
  renderManageGroupsList();
  manageGroupsModal.showModal();
}

function renderManageGroupsList() {
  var html = '';
  var mgmtGroups = groupData._groups || [];
  if (mgmtGroups.length === 0) {
    html = '<p style="color:#999;text-align:center;padding:20px">暂无自定义分组</p>';
  }
  mgmtGroups.forEach(function (g) {
    html += '<div class="mgmt-group-row" data-group="' + escapeHtml(g) + '">'
      + '<input class="input mgmt-rename" value="' + escapeHtml(g) + '" data-old="' + escapeHtml(g) + '">'
      + '<button class="btn btn-save mgmt-btn-rename" style="width:auto;padding:6px 12px;font-size:12px">重命名</button>'
      + '<button class="btn btn-danger mgmt-btn-delete" style="width:auto;padding:6px 12px;font-size:12px">删除</button>'
      + '</div>';
  });
  manageGroupsList.innerHTML = html;

  // 删除按钮事件
  manageGroupsList.querySelectorAll('.mgmt-btn-delete').forEach(function (btn) {
    btn.addEventListener('click', async function () {
      var row = this.parentElement;
      var groupName = row.getAttribute('data-group');
      var count = 0;
      Object.keys(groupData).forEach(function (k) {
        if (k === '_groups' || k === '_order') return;
        if (groupData[k] === groupName) count++;
      });
      if (count > 0 && !confirm('分组 "' + groupName + '" 中有 ' + count + ' 张图片，删除后这些图片将回到默认分组。确定删除？')) return;
      try {
        groupData._groups = groupData._groups.filter(function (g) { return g !== groupName; });
        Object.keys(groupData).forEach(function (k) {
          if (k === '_groups' || k === '_order') return;
          if (groupData[k] === groupName) delete groupData[k];
        });
        await saveGroupData();
        showToast('分组 "' + groupName + '" 已删除');
        renderManageGroupsList();
        await refreshAfterMutation();
      } catch (e) { showToast(e.message, 'error'); }
    });
  });

  // 重命名按钮事件
  manageGroupsList.querySelectorAll('.mgmt-btn-rename').forEach(function (btn) {
    btn.addEventListener('click', async function () {
      var row = this.parentElement;
      var input = row.querySelector('.mgmt-rename');
      var oldName = input.getAttribute('data-old');
      var newName = input.value.trim();
      if (!newName || newName === oldName) return;
      if (!/^[\w一-龥]+$/.test(newName)) { showToast('分组名只能包含中英文、数字和下划线', 'error'); return; }
      if (newName === 'default' || newName === 'all') { showToast('分组名不能使用保留字', 'error'); return; }
      if (groupData._groups.indexOf(newName) >= 0) { showToast('分组 "' + newName + '" 已存在', 'error'); return; }
      try {
        groupData._groups = groupData._groups.map(function (g) { return g === oldName ? newName : g; });
        Object.keys(groupData).forEach(function (k) {
          if (k === '_groups' || k === '_order') return;
          if (groupData[k] === oldName) groupData[k] = newName;
        });
        await saveGroupData();
        showToast('分组已重命名: ' + oldName + ' → ' + newName);
        renderManageGroupsList();
        await refreshAfterMutation();
      } catch (e) { showToast(e.message, 'error'); }
    });
  });
}

btnCloseManageGroups.addEventListener('click', function () { manageGroupsModal.close(); });
btnCancelManageGroups.addEventListener('click', function () { manageGroupsModal.close(); });
manageGroupsModal.addEventListener('click', function (e) { if (e.target === manageGroupsModal) manageGroupsModal.close(); });

// ========== 设置 ==========
function openSettings() {
  tokenInput.value = settings.token;
  ownerInput.value = settings.owner;
  repoInput.value = settings.repo;
  branchInput.value = settings.branch;
  settingsModal.showModal();
}

function saveSettingsForm() {
  settings.token = tokenInput.value.trim();
  settings.owner = ownerInput.value.trim() || defaults.owner;
  settings.repo = repoInput.value.trim() || defaults.repo;
  settings.branch = branchInput.value.trim() || defaults.branch;
  saveSettings(settings);
  settingsModal.close();
  showToast('设置已保存');
  refreshAll();
}

// ========== 搜索 ==========
var searchTimer = null;
function onSearchChange() {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(function () {
    if (allImages.length > 0) {
      var noResult = document.getElementById('noSearchResult');
      if (noResult) noResult.remove();
      renderCards(filterImages());
    }
  }, 200);
}

// ========== 事件绑定 ==========
uploadZone.addEventListener('dragover', function (e) { e.preventDefault(); uploadZone.classList.add('drag-over'); });
uploadZone.addEventListener('dragleave', function () { uploadZone.classList.remove('drag-over'); });
uploadZone.addEventListener('drop', function (e) { e.preventDefault(); uploadZone.classList.remove('drag-over'); if (e.dataTransfer.files.length > 0) handleFileSelect(e.dataTransfer.files); });
// 点击紧凑模式上传区 = 重新打开文件选择器
uploadZone.addEventListener('click', function (e) {
  if (uploadZone.classList.contains('compact') && e.target !== fileInput) {
    fileInput.click();
  }
});
fileInput.addEventListener('change', function () { if (fileInput.files.length > 0) handleFileSelect(fileInput.files); });

var btnAddMore = document.getElementById('btnAddMore');
btnAddMore.addEventListener('click', function (e) { e.stopPropagation(); fileInput.click(); });

btnCancel.addEventListener('click', resetUpload);
btnUpload.addEventListener('click', doUpload);
btnRefresh.addEventListener('click', function () { selectedImages = {}; updateBatchUI(); refreshAll(); });
searchInput.addEventListener('input', onSearchChange);
selectAllCheckbox.addEventListener('change', toggleSelectAll);
btnBatchCopy.addEventListener('click', batchCopy);
btnBatchDelete.addEventListener('click', batchDelete);

btnSettings.addEventListener('click', openSettings);
btnCloseModal.addEventListener('click', function () { settingsModal.close(); });
btnSaveSettings.addEventListener('click', saveSettingsForm);

btnCloseDelete.addEventListener('click', function () { deleteModal.close(); });
btnCancelDelete.addEventListener('click', function () { deleteModal.close(); });
btnConfirmDelete.addEventListener('click', confirmDelete);

btnCreateGroup.addEventListener('click', createNewGroup);
btnCloseNewGroup.addEventListener('click', function () { newGroupModal.close(); });
btnCancelNewGroup.addEventListener('click', function () { newGroupModal.close(); });

btnConfirmMove.addEventListener('click', confirmMove);
btnCloseMove.addEventListener('click', function () { moveGroupModal.close(); });
btnCancelMove.addEventListener('click', function () { moveGroupModal.close(); });

// 点击 Modal 背景关闭
[settingsModal, deleteModal, newGroupModal, moveGroupModal].forEach(function (m) {
  m.addEventListener('click', function (e) { if (e.target === m) m.close(); });
});

settingsModal.addEventListener('keydown', function (e) {
  if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA') { e.preventDefault(); saveSettingsForm(); }
});
newGroupModal.addEventListener('keydown', function (e) {
  if (e.key === 'Enter') { e.preventDefault(); createNewGroup(); }
});

// 全局键盘事件
document.addEventListener('keydown', function (e) {
  if (pendingRename) {
    if (e.key === 'Enter') { e.preventDefault(); confirmRename(); }
    else if (e.key === 'Escape') cancelRename();
  }
});

// ========== 初始化 ==========
function init() {
  if (settings.token) refreshAll();
  else showEmptyState('noSettings');
}
init();
