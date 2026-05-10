// ========== 设置管理 ==========
const STORAGE_KEY = 'sticker-drop-settings';

const defaults = {
  token: '',
  owner: '6zs5kxbhhy-svg',
  repo: 'Sticker-Drop',
  branch: 'main',
};

function loadSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { ...defaults, ...JSON.parse(raw) };
  } catch (e) { /* ignore */ }
  return { ...defaults };
}

function saveSettings(s) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
}

let settings = loadSettings();

// ========== DOM 引用 ==========
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const uploadZone = $('#uploadZone');
const fileInput = $('#fileInput');
const uploadPreview = $('#uploadPreview');
const previewImage = $('#previewImage');
const previewName = $('#previewName');
const previewExt = $('#previewExt');
const btnCancel = $('#btnCancel');
const btnUpload = $('#btnUpload');
const galleryGrid = $('#galleryGrid');
const galleryLoading = $('#galleryLoading');
const galleryEmpty = $('#galleryEmpty');
const galleryNoSettings = $('#galleryNoSettings');
const searchInput = $('#searchInput');
const btnRefresh = $('#btnRefresh');
const btnSettings = $('#btnSettings');
const settingsModal = $('#settingsModal');
const btnCloseModal = $('#btnCloseModal');
const btnSaveSettings = $('#btnSaveSettings');
const deleteModal = $('#deleteModal');
const btnCloseDelete = $('#btnCloseDelete');
const btnCancelDelete = $('#btnCancelDelete');
const btnConfirmDelete = $('#btnConfirmDelete');
const deleteFileName = $('#deleteFileName');
const toastContainer = $('#toastContainer');

// 设置表单
const tokenInput = $('#token');
const ownerInput = $('#owner');
const repoInput = $('#repo');
const branchInput = $('#branch');

let currentFile = null;
let pendingDelete = null;

// ========== Toast 通知 ==========
function showToast(message, type) {
  type = type || 'success';
  var toast = document.createElement('div');
  toast.className = 'toast' + (type === 'error' ? ' error' : '');
  toast.innerHTML =
    '<span>' + escapeHtml(message) + '</span>' +
    '<button onclick="this.parentElement.remove()">&times;</button>';
  toastContainer.appendChild(toast);
  setTimeout(function () {
    if (toast.parentElement) toast.remove();
  }, 4000);
}

function escapeHtml(str) {
  var div = document.createElement('div');
  div.appendChild(document.createTextNode(str));
  return div.innerHTML;
}

// ========== GitHub API ==========
function apiHeaders() {
  var headers = { Accept: 'application/vnd.github+json' };
  if (settings.token) {
    headers.Authorization = 'Bearer ' + settings.token;
  }
  return headers;
}

function imagesPath() {
  return 'images';
}

async function listImages() {
  var url =
    'https://api.github.com/repos/' +
    encodeURIComponent(settings.owner) + '/' +
    encodeURIComponent(settings.repo) + '/contents/' +
    encodeURIComponent(imagesPath()) +
    '?ref=' + encodeURIComponent(settings.branch || 'main');

  var res = await fetch(url, { headers: apiHeaders() });
  if (res.status === 404) return [];
  if (!res.ok) {
    var err = await res.json().catch(function () { return {}; });
    throw new Error(err.message || '请求失败: HTTP ' + res.status);
  }
  var data = await res.json();
  if (!Array.isArray(data)) return [];
  var exts = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'];
  return data.filter(function (f) {
    if (f.type !== 'file') return false;
    var name = f.name.toLowerCase();
    return exts.some(function (e) { return name.endsWith('.' + e); });
  });
}

async function getFileContent(path) {
  var url =
    'https://api.github.com/repos/' +
    encodeURIComponent(settings.owner) + '/' +
    encodeURIComponent(settings.repo) + '/contents/' +
    encodeURIComponent(path) +
    '?ref=' + encodeURIComponent(settings.branch || 'main');

  var res = await fetch(url, { headers: apiHeaders() });
  if (!res.ok) {
    throw new Error('获取文件内容失败: HTTP ' + res.status);
  }
  return res.json();
}

async function uploadImageFile(filename, base64Content) {
  var path = imagesPath() + '/' + filename;
  var url =
    'https://api.github.com/repos/' +
    encodeURIComponent(settings.owner) + '/' +
    encodeURIComponent(settings.repo) + '/contents/' +
    encodeURIComponent(path);

  var res = await fetch(url, {
    method: 'PUT',
    headers: apiHeaders(),
    body: JSON.stringify({
      message: 'Upload sticker: ' + filename,
      content: base64Content,
      branch: settings.branch || 'main',
    }),
  });

  if (res.status === 409) {
    throw new Error('文件 "' + filename + '" 已存在，请修改文件名');
  }
  if (res.status === 422) {
    var errData = await res.json().catch(function () { return {}; });
    throw new Error(errData.message || '上传失败，可能是文件名不合法');
  }
  if (!res.ok) {
    var errData2 = await res.json().catch(function () { return {}; });
    if (res.status === 401) {
      throw new Error('Token 无效或已过期，请在设置中更新');
    }
    throw new Error(errData2.message || '上传失败: HTTP ' + res.status);
  }
  return res.json();
}

async function deleteImageFile(path, sha) {
  var url =
    'https://api.github.com/repos/' +
    encodeURIComponent(settings.owner) + '/' +
    encodeURIComponent(settings.repo) + '/contents/' +
    encodeURIComponent(path);

  var res = await fetch(url, {
    method: 'DELETE',
    headers: apiHeaders(),
    body: JSON.stringify({
      message: 'Delete sticker: ' + path.split('/').pop(),
      sha: sha,
      branch: settings.branch || 'main',
    }),
  });

  if (!res.ok) {
    var errData = await res.json().catch(function () { return {}; });
    throw new Error(errData.message || '删除失败: HTTP ' + res.status);
  }
}

async function renameImageFile(oldPath, oldSha, newName) {
  // 1. 获取旧文件内容
  var oldFile = await getFileContent(oldPath);

  // 2. 创建新文件
  var dir = oldPath.substring(0, oldPath.lastIndexOf('/'));
  var newPath = dir + '/' + newName;
  var newUrl =
    'https://api.github.com/repos/' +
    encodeURIComponent(settings.owner) + '/' +
    encodeURIComponent(settings.repo) + '/contents/' +
    encodeURIComponent(newPath);

  var createRes = await fetch(newUrl, {
    method: 'PUT',
    headers: apiHeaders(),
    body: JSON.stringify({
      message: 'Rename: ' + oldPath.split('/').pop() + ' → ' + newName,
      content: oldFile.content,
      branch: settings.branch || 'main',
    }),
  });

  if (createRes.status === 409) {
    throw new Error('文件名 "' + newName + '" 已存在，请换一个名字');
  }
  if (!createRes.ok) {
    var err = await createRes.json().catch(function () { return {}; });
    throw new Error(err.message || '重命名失败');
  }

  // 3. 删除旧文件
  await deleteImageFile(oldPath, oldSha);
}

function getStickerUrl(filename) {
  return (
    'https://' +
    encodeURIComponent(settings.owner) +
    '.github.io/' +
    encodeURIComponent(settings.repo) +
    '/' + imagesPath() + '/' +
    encodeURIComponent(filename)
  );
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

function handleFileSelect(file) {
  if (!file) return;
  if (!file.type.startsWith('image/')) {
    showToast('请选择图片文件', 'error');
    return;
  }
  if (file.size > 10 * 1024 * 1024) {
    showToast('文件大小不能超过 10MB', 'error');
    return;
  }

  currentFile = file;

  // 解析文件名
  var dot = file.name.lastIndexOf('.');
  var baseName = dot >= 0 ? file.name.substring(0, dot) : file.name;
  var ext = dot >= 0 ? file.name.substring(dot) : '.png';

  // 预览图片
  var url = URL.createObjectURL(file);
  previewImage.src = url;
  previewName.value = baseName;
  previewExt.textContent = ext;

  uploadZone.classList.add('hidden');
  uploadPreview.classList.remove('hidden');
}

async function doUpload() {
  if (!currentFile) return;
  var name = previewName.value.trim();
  if (!name) {
    showToast('请输入文件名', 'error');
    return;
  }
  var ext = previewExt.textContent;
  var filename = name + ext;

  btnUpload.disabled = true;
  btnUpload.textContent = '上传中...';

  try {
    var base64 = await fileToBase64(currentFile);
    await uploadImageFile(filename, base64);
    showToast('上传成功！链接已可用');
    resetUpload();
    await loadGallery();
  } catch (e) {
    showToast(e.message, 'error');
  } finally {
    btnUpload.disabled = false;
    btnUpload.textContent = '上传图片';
  }
}

function resetUpload() {
  currentFile = null;
  uploadZone.classList.remove('hidden');
  uploadPreview.classList.add('hidden');
  previewImage.src = '';
  previewName.value = '';
  fileInput.value = '';
}

// ========== 图库 ==========
var allImages = [];

async function loadGallery() {
  if (!settings.token && !settings.owner) {
    showEmptyState('noSettings');
    return;
  }

  showEmptyState('loading');

  try {
    allImages = await listImages();
    if (allImages.length === 0) {
      showEmptyState('empty');
    } else {
      hideAllStates();
      renderCards(filterImages());
    }
  } catch (e) {
    showToast('加载图库失败: ' + e.message, 'error');
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
  return allImages.filter(function (img) {
    return img.name.toLowerCase().indexOf(q) >= 0;
  });
}

function renderCards(images) {
  // 清除旧的卡片（保留状态元素）
  var oldCards = galleryGrid.querySelectorAll('.sticker-card');
  oldCards.forEach(function (c) { c.remove(); });

  images.forEach(function (img) {
    var card = createCard(img);
    galleryGrid.appendChild(card);
  });

  if (images.length === 0 && allImages.length > 0) {
    var noResult = document.createElement('div');
    noResult.className = 'gallery-status';
    noResult.innerHTML = '<div class="empty-icon">🔍</div><p>没有匹配的表情包</p>';
    noResult.id = 'noSearchResult';
    galleryGrid.appendChild(noResult);
  }
}

function createCard(img) {
  var card = document.createElement('div');
  card.className = 'sticker-card';
  card.setAttribute('data-path', img.path);
  card.setAttribute('data-sha', img.sha);

  var imgEl = document.createElement('img');
  imgEl.className = 'card-image';
  imgEl.src = img.download_url;
  imgEl.alt = img.name;
  imgEl.loading = 'lazy';
  imgEl.title = '点击复制链接';
  imgEl.addEventListener('click', function () { copyUrl(img.name); });

  var body = document.createElement('div');
  body.className = 'card-body';

  var nameEl = document.createElement('div');
  nameEl.className = 'card-name';
  nameEl.textContent = img.name;

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
  copyBtn.addEventListener('click', function () { copyUrl(img.name, copyBtn); });

  var renameBtn = document.createElement('button');
  renameBtn.className = 'btn-rename-card';
  renameBtn.textContent = '重命名';
  renameBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    startRename(card, img);
  });

  var deleteBtn = document.createElement('button');
  deleteBtn.className = 'btn-delete-card';
  deleteBtn.textContent = '删除';
  deleteBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    openDeleteModal(img);
  });

  actions.appendChild(copyBtn);
  actions.appendChild(renameBtn);
  actions.appendChild(deleteBtn);
  body.appendChild(nameEl);
  body.appendChild(editRow);
  body.appendChild(actions);
  card.appendChild(imgEl);
  card.appendChild(body);
  return card;
}

var pendingRename = null;

function startRename(card, img) {
  // 如果已经在编辑另一个，先取消
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
  if (!newBase) {
    showToast('请输入文件名', 'error');
    return;
  }
  var newName = newBase + r.ext;
  if (newName === r.img.name) {
    cancelRename();
    return;
  }

  r.editInput.disabled = true;
  try {
    await renameImageFile(r.img.path, r.img.sha, newName);
    showToast('已重命名为: ' + newName);
    cancelRename();
    await loadGallery();
  } catch (e) {
    showToast(e.message, 'error');
    r.editInput.disabled = false;
    r.editInput.focus();
  }
}

async function copyUrl(filename, btn) {
  var url = getStickerUrl(filename);
  try {
    await navigator.clipboard.writeText(url);
    if (btn) {
      btn.textContent = '已复制!';
      btn.classList.add('copied');
      setTimeout(function () {
        btn.textContent = '复制链接';
        btn.classList.remove('copied');
      }, 1500);
    }
    showToast('链接已复制到剪贴板');
  } catch (e) {
    // 降级方案：选中文本
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
    showToast('已删除: ' + pendingDelete.name);
    deleteModal.close();
    pendingDelete = null;
    await loadGallery();
  } catch (e) {
    showToast(e.message, 'error');
  } finally {
    btnConfirmDelete.disabled = false;
    btnConfirmDelete.textContent = '删除';
  }
}

// ========== 设置弹窗 ==========
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
  loadGallery();
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
uploadZone.addEventListener('click', function () { fileInput.click(); });
uploadZone.addEventListener('dragover', function (e) {
  e.preventDefault();
  uploadZone.classList.add('drag-over');
});
uploadZone.addEventListener('dragleave', function () {
  uploadZone.classList.remove('drag-over');
});
uploadZone.addEventListener('drop', function (e) {
  e.preventDefault();
  uploadZone.classList.remove('drag-over');
  var file = e.dataTransfer.files[0];
  if (file) handleFileSelect(file);
});
fileInput.addEventListener('change', function () {
  var file = fileInput.files[0];
  if (file) handleFileSelect(file);
});

btnCancel.addEventListener('click', resetUpload);
btnUpload.addEventListener('click', doUpload);
btnRefresh.addEventListener('click', loadGallery);
searchInput.addEventListener('input', onSearchChange);

btnSettings.addEventListener('click', openSettings);
btnCloseModal.addEventListener('click', function () { settingsModal.close(); });
btnSaveSettings.addEventListener('click', saveSettingsForm);

btnCloseDelete.addEventListener('click', function () { deleteModal.close(); });
btnCancelDelete.addEventListener('click', function () { deleteModal.close(); });
btnConfirmDelete.addEventListener('click', confirmDelete);

// 点击 Modal 背景关闭
settingsModal.addEventListener('click', function (e) {
  if (e.target === settingsModal) settingsModal.close();
});
deleteModal.addEventListener('click', function (e) {
  if (e.target === deleteModal) deleteModal.close();
});

// 键盘快捷键：Escape 关闭弹窗，Enter 保存设置
settingsModal.addEventListener('keydown', function (e) {
  if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA') {
    e.preventDefault();
    saveSettingsForm();
  }
});

// 重命名事件的全局委托
document.addEventListener('click', function (e) {
  if (e.target.classList.contains('btn-rename-ok')) {
    confirmRename();
  } else if (e.target.classList.contains('btn-rename-cancel')) {
    cancelRename();
  }
});
document.addEventListener('keydown', function (e) {
  if (!pendingRename) return;
  if (e.key === 'Enter') {
    e.preventDefault();
    confirmRename();
  } else if (e.key === 'Escape') {
    cancelRename();
  }
});

// ========== 初始化 ==========
function init() {
  if (settings.token) {
    loadGallery();
  } else {
    showEmptyState('noSettings');
  }
}

init();
