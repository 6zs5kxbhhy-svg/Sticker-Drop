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
var cacheStore = {};

function cacheGet(key) {
  var entry = cacheStore[key];
  if (!entry) return null;
  if (Date.now() - entry.ts > entry.ttl) {
    delete cacheStore[key];
    return null;
  }
  return entry.data;
}

function cacheSet(key, data, ttl) {
  cacheStore[key] = { data: data, ts: Date.now(), ttl: ttl || 30000 };
}

function cacheClear() { cacheStore = {}; }

function cacheClearKey(key) { delete cacheStore[key]; }

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
    if (!res.ok) { groupData = {}; groupDataSha = null; return; }
    var data = await res.json();
    groupDataSha = data.sha;
    groupData = JSON.parse(decodeURIComponent(escape(atob(data.content))));
    cacheSet('groupData', { data: groupData, sha: groupDataSha }, 30000);
  } catch (e) { groupData = {}; groupDataSha = null; }
}

async function saveGroupData() {
  var url = 'https://api.github.com/repos/' + encodeURIComponent(settings.owner) + '/' + encodeURIComponent(settings.repo) + '/contents/images/.group-data.json';
  var content = btoa(unescape(encodeURIComponent(JSON.stringify(groupData, null, 2))));
  var body = {
    message: 'Update group data',
    content: content,
    branch: settings.branch || 'main'
  };
  if (groupDataSha) body.sha = groupDataSha;
  var res = await fetch(url, { method: 'PUT', headers: apiHeaders(), body: JSON.stringify(body) });
  if (res.ok) {
    try { var r = await res.json(); if (r.content) groupDataSha = r.content.sha; } catch (e) {}
  }
  cacheClearKey('groupData');
}

async function discoverGroups() {
  await readGroupData();
  var gs = ['default'];
  var seen = {};
  // 从文件分组映射中收集
  Object.keys(groupData).forEach(function (k) {
    if (k === '_groups') return;
    var g = groupData[k];
    if (g && !seen[g]) { seen[g] = true; gs.push(g); }
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
  var data = await fetchImageList();
  var exts = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'];
  var results = [];
  data.forEach(function (f) {
    if (f.type !== 'file') return;
    if (f.name === '.group-data.json') return;
    var name = f.name.toLowerCase();
    if (exts.some(function (e) { return name.endsWith('.' + e); })) {
      var fileGroup = groupData[f.name] || null;
      if (group === 'default') {
        if (!fileGroup) { f._group = null; results.push(f); }
      } else {
        if (fileGroup === group) { f._group = group; results.push(f); }
      }
    }
  });
  return results;
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
  return all;
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
  await deleteImageFile(oldPath, oldSha);
  cacheClearKey('imageList');
  // 更新分组数据中的文件名
  var oldName = oldPath.split('/').pop();
  if (groupData[oldName]) {
    groupData[newName] = groupData[oldName];
    delete groupData[oldName];
    await saveGroupData();
  }
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
  // 扁平路径，不包含分组目录
  return 'https://cdn.jsdelivr.net/gh/' + encodeURIComponent(settings.owner) + '/' + encodeURIComponent(settings.repo) + '@' + encodeURIComponent(settings.branch || 'main') + '/images/' + encodeURIComponent(filename);
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
  fileList.forEach(function (file) {
    if (!file.type.startsWith('image/')) { showToast(file.name + ' 不是图片文件', 'error'); return; }
    if (file.size > 10 * 1024 * 1024) { showToast(file.name + ' 超过 10MB 限制', 'error'); return; }
    // 去重
    var exists = currentFiles.some(function (f) { return f.file.name === file.name && f.file.size === file.size; });
    if (exists) { dupes++; return; }
    currentFiles.push({ file: file });
    added++;
  });
  if (dupes > 0) showToast(dupes + ' 个重复文件已跳过', 'error');
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
    div.innerHTML = '<img class="batch-thumb" src="' + url + '" alt="">'
      + '<span class="batch-filename">' + escapeHtml(item.file.name) + '</span>'
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
    var filename = item.file.name;
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
  // 记录分组信息
  if (group && group !== 'default' && uploadedNames.length > 0) {
    await readGroupData(true);
    uploadedNames.forEach(function (n) { groupData[n] = group; });
    await saveGroupData();
  }
  cacheClearKey('imageList');
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

// ========== 分组标签 ==========
function renderGroupTabs() {
  var html = '';
  html += '<button class="group-tab' + (currentGroup === 'all' ? ' active' : '') + '" data-group="all">全部</button>';
  groups.forEach(function (g) {
    var label = g === 'default' ? '默认' : g;
    html += '<button class="group-tab' + (currentGroup === g ? ' active' : '') + '" data-group="' + escapeHtml(g) + '">' + escapeHtml(label) + '</button>';
  });
  html += '<button class="group-tab group-tab-add" id="btnNewGroup">+ 新建分组</button>';
  groupTabs.innerHTML = html;

  // 绑定事件
  groupTabs.querySelectorAll('[data-group]').forEach(function (btn) {
    btn.addEventListener('click', function () { switchGroup(this.getAttribute('data-group')); });
  });
  var btnNew = document.getElementById('btnNewGroup');
  if (btnNew) btnNew.addEventListener('click', openNewGroupModal);
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
  showEmptyState('loading');
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
      fragment.appendChild(createCard(images[i]));
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

  var imgWrap = document.createElement('div');
  imgWrap.className = 'card-img-wrap';

  var imgEl = document.createElement('img');
  imgEl.className = 'card-image';
  imgEl.src = getStickerUrl(img.name, img._group);
  imgEl.alt = img.name;
  imgEl.loading = 'lazy';
  imgEl.title = '点击复制链接';
  imgEl.addEventListener('click', function () { copyUrl(img.name, img._group, null); });
  imgEl.onerror = function () {
    imgEl.style.objectFit = 'none';
    imgEl.style.padding = '20px';
    imgEl.src = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="60" height="60" viewBox="0 0 24 24" fill="none" stroke="#999" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>');
  };

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
  var editOk = document.createElement('button');
  editOk.className = 'btn-rename-ok';
  editOk.textContent = '✓';
  var editCancel = document.createElement('button');
  editCancel.className = 'btn-rename-cancel';
  editCancel.textContent = '✗';
  editRow.appendChild(editInput);
  editRow.appendChild(extSpan);
  editRow.appendChild(editOk);
  editRow.appendChild(editCancel);

  var actions = document.createElement('div');
  actions.className = 'card-actions';

  var copyBtn = document.createElement('button');
  copyBtn.className = 'btn-copy';
  copyBtn.textContent = '复制链接';
  copyBtn.addEventListener('click', function () { copyUrl(img.name, img._group, copyBtn); });

  var renameBtn = document.createElement('button');
  renameBtn.className = 'btn-rename-card';
  renameBtn.textContent = '重命名';
  renameBtn.addEventListener('click', function (e) { e.stopPropagation(); startRename(card, img); });

  var moveBtn = document.createElement('button');
  moveBtn.className = 'btn-move-card';
  moveBtn.textContent = '移动';
  moveBtn.addEventListener('click', function (e) { e.stopPropagation(); openMoveModal(img); });

  var deleteBtn = document.createElement('button');
  deleteBtn.className = 'btn-delete-card';
  deleteBtn.textContent = '删除';
  deleteBtn.addEventListener('click', function (e) { e.stopPropagation(); openDeleteModal(img); });

  actions.appendChild(copyBtn);
  actions.appendChild(renameBtn);
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
    btnBatchCopy.textContent = '📋 复制选中 (' + count + ')';
  } else {
    selectAllLabel.classList.add('hidden');
    btnBatchCopy.classList.add('hidden');
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
    await renameImageFile(r.img.path, r.img.sha, newName);
    showToast('已重命名为: ' + newName);
    cancelRename();
    await refreshAfterMutation();
  } catch (e) {
    showToast(e.message, 'error');
    r.editInput.disabled = false;
    r.editInput.focus();
  }
}

// ========== 复制链接 ==========
async function copyUrl(filename, group, btn) {
  var url = getStickerUrl(filename);
  try {
    await navigator.clipboard.writeText(url);
    if (btn) {
      btn.textContent = '已复制!';
      btn.classList.add('copied');
      setTimeout(function () { btn.textContent = '复制链接'; btn.classList.remove('copied'); }, 1500);
    }
    showToast('链接已复制到剪贴板');
  } catch (e) {
    var input = document.createElement('input');
    input.value = url;
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
    // 清理分组数据
    var delName = pendingDelete.name;
    if (groupData[delName]) {
      delete groupData[delName];
      await saveGroupData();
    }
    cacheClearKey('imageList');
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

// 全局事件委托
document.addEventListener('click', function (e) {
  if (e.target.classList.contains('btn-rename-ok')) confirmRename();
  else if (e.target.classList.contains('btn-rename-cancel')) cancelRename();
});
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
