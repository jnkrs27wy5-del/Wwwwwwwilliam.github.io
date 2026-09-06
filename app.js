/* SECTION: app-boot */
(function () {
  'use strict';

  var E = window.FilmUnmask;
  var $ = function (id) { return document.getElementById(id); };

  /* SECTION: app-dom */
  var view = $('view'), vctx = view.getContext('2d', { willReadFrequently: false });
  var vf = $('vf'), hud = $('hud'), ph = $('ph'), note = $('note');
  var chipSrcTx = $('chipSrcTx'), baseSwatch = $('baseSwatch'), baseTx = $('baseTx'), fpsEl = $('fps');
  var tgInvert = $('tgInvert'), tgMask = $('tgMask');
  var btnStart = $('btnStart'), btnUpload = $('btnUpload'), btnUploadTop = $('btnUploadTop');
  var btnAutoBase = $('btnAutoBase'), btnPick = $('btnPick'), btnAutoGain = $('btnAutoGain');
  var btnShoot = $('btnShoot'), btnReset = $('btnReset'), btnDownloadLast = $('btnDownloadLast');
  var btnStartTx = $('btnStartTx');
  var strip = $('strip'), stripEmpty = $('stripEmpty'), btnClear = $('btnClear');
  var slidersEl = $('sliders'), toastEl = $('toast'), flashEl = $('flash');
  var video = $('cam'), fileInput = $('fileInput');

  var srcCanvas = document.createElement('canvas');
  var srcCtx = srcCanvas.getContext('2d', { willReadFrequently: true });
  var capCanvas = document.createElement('canvas');
  var capCtx = capCanvas.getContext('2d', { willReadFrequently: true });

  var PREVIEW_MAX_CAMERA = 720;
  var PREVIEW_MIN_CAMERA = 360;
  var PREVIEW_MAX_IMAGE = 1100;
  var CAPTURE_MAX = 1600;
  var THUMB_MAX = 150;
  var MAX_SHOTS = 8;

  var params = E.defaults();
  var state = { source: 'none', picking: false, running: false, needsRender: true, baseAuto: false };
  var photo = new Image();
  var photoUrl = '';
  var srcData = null, outData = null;
  var shots = [];
  var rafId = 0, frames = 0, fpsStamp = 0;
  var toastTimer = 0;

  view.width = 640; view.height = 480;

  /* SECTION: app-slider-defs */
  var SLIDERS = [
    { key: 'maskStrength', label: '色罩强度', min: 0, max: 150, step: 1, unit: '%', needsUnmask: true },
    { key: 'exposure', label: '曝光', min: -100, max: 100, step: 1, unit: '' },
    { key: 'contrast', label: '对比度', min: 20, max: 220, step: 1, unit: '%' },
    { key: 'saturation', label: '饱和度', min: 0, max: 200, step: 1, unit: '%' },
    { key: 'gainR', label: '红通道', min: 40, max: 220, step: 1, unit: '%', dim: true },
    { key: 'gainG', label: '绿通道', min: 40, max: 220, step: 1, unit: '%', dim: true },
    { key: 'gainB', label: '蓝通道', min: 40, max: 220, step: 1, unit: '%', dim: true }
  ];
  var sliderRefs = {};

  function buildSliders() {
    var frag = document.createDocumentFragment();
    SLIDERS.forEach(function (def) {
      var row = document.createElement('div');
      row.className = 'row' + (def.dim ? ' dim' : '');
      row.dataset.key = def.key;

      var lab = document.createElement('label');
      lab.textContent = def.label;
      lab.htmlFor = 'sl-' + def.key;

      var inp = document.createElement('input');
      inp.type = 'range';
      inp.id = 'sl-' + def.key;
      inp.min = String(def.min); inp.max = String(def.max); inp.step = String(def.step);
      inp.value = String(params[def.key]);

      var out = document.createElement('output');
      out.textContent = def.unit ? params[def.key] + def.unit : String(params[def.key]);

      lab.setAttribute('for', inp.id);
      row.appendChild(lab); row.appendChild(inp); row.appendChild(out);
      frag.appendChild(row);

      sliderRefs[def.key] = { row: row, input: inp, output: out, def: def };

      inp.addEventListener('input', function () {
        params[def.key] = Number(inp.value);
        out.textContent = def.unit ? inp.value + def.unit : inp.value;
        if (def.key === 'maskStrength') { state.baseAuto = false; }
        invalidate();
      });
    });
    slidersEl.appendChild(frag);
  }

  function syncSliders() {
    SLIDERS.forEach(function (def) {
      var ref = sliderRefs[def.key];
      if (!ref) { return; }
      ref.input.value = String(params[def.key]);
      ref.output.textContent = def.unit ? params[def.key] + def.unit : String(params[def.key]);
      ref.row.classList.toggle('off', !!def.needsUnmask && !params.unmask);
      ref.input.disabled = !!def.needsUnmask && !params.unmask;
    });
  }

  function syncBase() {
    baseSwatch.style.background = 'rgb(' + params.baseR + ',' + params.baseG + ',' + params.baseB + ')';
    baseTx.textContent = '片基 ' + params.baseR + ',' + params.baseG + ',' + params.baseB + (state.baseAuto ? ' · 自动' : '');
  }

  function syncToggles() {
    tgInvert.setAttribute('aria-pressed', params.invert ? 'true' : 'false');
    tgMask.setAttribute('aria-pressed', params.unmask ? 'true' : 'false');
  }

  function syncAll() { syncSliders(); syncToggles(); syncBase(); }

  function invalidate() { state.needsRender = true; }

  /* SECTION: app-toast */
  function toast(msg, isErr) {
    toastEl.textContent = msg;
    toastEl.classList.toggle('err', !!isErr);
    toastEl.classList.add('show');
    if (toastTimer) { clearTimeout(toastTimer); }
    toastTimer = setTimeout(function () { toastEl.classList.remove('show'); }, 2400);
  }

  function showNote(htmlText) {
    note.textContent = htmlText;
    note.hidden = false;
  }
  function hideNote() { note.hidden = true; note.textContent = ''; }

  /* SECTION: app-render */
  function fitSize(nw, nh, maxDim) {
    var s = Math.min(1, maxDim / Math.max(nw, nh));
    return { w: Math.max(1, Math.round(nw * s)), h: Math.max(1, Math.round(nh * s)) };
  }

  function currentSourceEl() { return state.source === 'camera' ? video : photo; }

  function currentSourceSize() {
    if (state.source === 'camera') { return { w: video.videoWidth, h: video.videoHeight }; }
    if (state.source === 'image') { return { w: photo.naturalWidth, h: photo.naturalHeight }; }
    return { w: 0, h: 0 };
  }

  /* 实时预览按取景框的实际显示像素定分辨率：
     逐像素处理开销与像素总数成正比，超过显示尺寸的部分纯属浪费帧率 */
  function cameraMaxDim() {
    var rect = vf.getBoundingClientRect();
    var cssLong = Math.max(rect.width, rect.height);
    if (!cssLong) { return PREVIEW_MAX_CAMERA; }
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var px = cssLong * dpr;
    return Math.round(Math.max(PREVIEW_MIN_CAMERA, Math.min(px, PREVIEW_MAX_CAMERA)));
  }

  function renderPreview() {
    var size = currentSourceSize();
    if (!size.w || !size.h) { return; }
    var el = currentSourceEl();
    var maxDim = state.source === 'camera' ? cameraMaxDim() : PREVIEW_MAX_IMAGE;
    var f = fitSize(size.w, size.h, maxDim);

    if (srcCanvas.width !== f.w || srcCanvas.height !== f.h) {
      srcCanvas.width = f.w; srcCanvas.height = f.h;
      outData = null;
    }
    srcCtx.imageSmoothingEnabled = true;
    srcCtx.imageSmoothingQuality = 'high';
    srcCtx.drawImage(el, 0, 0, f.w, f.h);

    var fresh = srcCtx.getImageData(0, 0, f.w, f.h);
    srcData = fresh;

    if (!outData || outData.width !== f.w || outData.height !== f.h) {
      outData = vctx.createImageData(f.w, f.h);
      var od = outData.data;
      for (var i = 3; i < od.length; i += 4) { od[i] = 255; }
    }
    if (view.width !== f.w || view.height !== f.h) { view.width = f.w; view.height = f.h; }

    E.processInto(fresh, outData, params);
    vctx.putImageData(outData, 0, 0);
  }

  function tick(now) {
    rafId = requestAnimationFrame(tick);
    frames++;
    if (now - fpsStamp >= 1000) {
      fpsEl.textContent = frames + ' fps';
      frames = 0; fpsStamp = now;
    }
    if (state.source === 'camera') {
      if (video.readyState < 2) { return; }
      renderPreview();
    } else if (state.source === 'image' && state.needsRender) {
      state.needsRender = false;
      renderPreview();
    }
  }

  function startLoop() {
    if (state.running) { return; }
    state.running = true;
    fpsStamp = performance.now();
    frames = 0;
    rafId = requestAnimationFrame(tick);
  }

  /* SECTION: app-source-switch */
  function enterSource(label) {
    ph.hidden = true;
    hud.hidden = false;
    chipSrcTx.textContent = label;
    btnShoot.disabled = false;
    btnStart.disabled = false;
    btnStartTx.textContent = '重新开启';
    hideNote();
  }

  function startCamera() {
    hideNote();
    if (!window.isSecureContext && location.protocol !== 'file:') {
      showNote('当前页面不是 HTTPS 或 localhost 环境，浏览器会拒绝调用摄像头。可以改用「上传底片照片」，处理效果完全相同。');
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showNote('当前浏览器或环境不支持摄像头调用（需要 HTTPS 或 localhost）。请改用「上传底片照片」，去色罩效果完全相同。');
      toast('此环境无法调用摄像头，请上传底片照片', true);
      return;
    }
    btnStart.disabled = true;
    btnStartTx.textContent = '正在请求…';

    var want = { video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false };
    navigator.mediaDevices.getUserMedia(want).then(onStream).catch(function (err) {
      // 部分设备不支持 ideal 约束，降级为最简约束再试一次
      navigator.mediaDevices.getUserMedia({ video: true, audio: false }).then(onStream).catch(function (err2) {
        handleCameraError(err2 || err);
      });
    });
  }

  function onStream(stream) {
    video.srcObject = stream;
    var played = video.play();
    if (played && typeof played.catch === 'function') { played.catch(function () {}); }
    var ready = function () {
      video.removeEventListener('loadedmetadata', ready);
      state.source = 'camera';
      state.needsRender = true;
      enterSource('实时取景');
      startLoop();
      fpsEl.textContent = '—';
      toast('镜头已开启，正在实时去色罩');
      // loadedmetadata 时画面还不一定可绘制（readyState=1），
      // 必须等首帧真正落到源画布后才能做片基统计
      if (video.readyState >= 2 && video.videoWidth) {
        renderPreview();
        autoBase(true);
      } else {
        var once = function () {
          video.removeEventListener('loadeddata', once);
          renderPreview();
          autoBase(true);
        };
        video.addEventListener('loadeddata', once);
      }
    };
    if (video.readyState >= 1 && video.videoWidth) { ready(); }
    else { video.addEventListener('loadedmetadata', ready); }
  }

  function handleCameraError(err) {
    btnStart.disabled = false;
    btnStartTx.textContent = '开启镜头';
    var name = (err && (err.name || err.code)) || '';
    var msg;
    if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 1) {
      msg = '摄像头权限被拒绝。请在浏览器地址栏左侧的权限设置中允许访问摄像头，再点一次「开启镜头」。也可以改用上传底片照片。';
    } else if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 8) {
      msg = '没有找到可用摄像头。可以直接上传底片照片，去色罩效果完全相同。';
    } else if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError') {
      msg = '摄像头被其他应用占用，或系统拒绝了访问。关闭占用摄像头的程序后重试，也可以改用上传底片照片。';
    } else if (name === 'SecurityError' || name === 18) {
      msg = '浏览器要求在 HTTPS 或 localhost 环境下才能调用摄像头，当前页面不满足条件。请改用「上传底片照片」。';
    } else {
      msg = '摄像头开启失败（' + (name || '未知原因') + '）。可以改用「上传底片照片」，处理效果完全相同。';
    }
    showNote(msg);
    toast('摄像头不可用，可改用上传底片照片', true);
  }

  function stopCamera() {
    if (video.srcObject) {
      video.srcObject.getTracks().forEach(function (t) { t.stop(); });
      video.srcObject = null;
    }
  }

  /* SECTION: app-upload */
  function pickFile() { fileInput.click(); }

  function onFile(e) {
    var file = e.target.files && e.target.files[0];
    if (!file) { return; }
    if (!/^image\//.test(file.type)) { toast('请选择图片文件', true); return; }
    if (photoUrl) { URL.revokeObjectURL(photoUrl); }
    photoUrl = URL.createObjectURL(file);
    hideNote();
    photo.onload = function () {
      stopCamera();
      state.source = 'image';
      state.needsRender = true;
      enterSource('本地底片');
      startLoop();
      fpsEl.textContent = '静态';
      autoBase(true);
      toast('已载入底片，参数变化会即时刷新');
    };
    photo.onerror = function () {
      toast('图片读取失败，请换一张试试', true);
      if (photoUrl) { URL.revokeObjectURL(photoUrl); photoUrl = ''; }
    };
    photo.src = photoUrl;
    fileInput.value = '';
  }

  /* SECTION: app-base-tools */
  function autoBase(silent) {
    if (!srcData) {
      if (!silent) { toast('请先开启镜头或上传底片照片', true); }
      return;
    }
    var r = E.detectBase(srcData);
    if (!r) {
      if (!silent) { toast('没能识别片基色，请用吸管在片基处取样', true); }
      return;
    }
    params.baseR = r.r; params.baseG = r.g; params.baseB = r.b;
    state.baseAuto = true;
    syncBase();
    invalidate();
    var tail = r.weak ? '（画面里没有明显的干净片基，建议用吸管复核）' : '';
    toast('已识别片基色 ' + r.r + ',' + r.g + ',' + r.b + tail, !!r.weak);
  }

  function autoGain() {
    if (!srcData) { toast('请先开启镜头或上传底片照片', true); return; }
    var g = E.computeGrayGains(srcData, params);
    if (!g) { toast('画面信息不足，无法自动灰平衡，请手动调三个通道', true); return; }
    params.gainR = g.r; params.gainG = g.g; params.gainB = g.b;
    syncSliders();
    invalidate();
    toast('已自动灰平衡：红' + g.r + '% 绿' + g.g + '% 蓝' + g.b + '%');
  }

  /* SECTION: app-eyepicker */
  function setPicking(on) {
    state.picking = on;
    vf.classList.toggle('pick', on);
    btnPick.setAttribute('aria-pressed', on ? 'true' : 'false');
    if (on) { toast('点击画面上的片基（最亮的橙色区域）'); }
  }

  function pointToSource(cx, cy) {
    var rect = view.getBoundingClientRect();
    if (!rect.width || !rect.height || !view.width) { return null; }
    var s = Math.min(rect.width / view.width, rect.height / view.height);
    var dw = view.width * s, dh = view.height * s;
    var ox = (rect.width - dw) / 2, oy = (rect.height - dh) / 2;
    var x = (cx - rect.left - ox) / s;
    var y = (cy - rect.top - oy) / s;
    if (x < 0 || y < 0 || x >= view.width || y >= view.height) { return null; }
    return { x: Math.round(x), y: Math.round(y) };
  }

  function sampleBaseAt(pt) {
    if (!srcData) { toast('画面还没准备好，请稍候', true); return; }
    var d = srcData.data, w = srcData.width, h = srcData.height;
    var rad = 3, sr = 0, sg = 0, sb = 0, n = 0;
    for (var dy = -rad; dy <= rad; dy++) {
      for (var dx = -rad; dx <= rad; dx++) {
        var x = pt.x + dx, y = pt.y + dy;
        if (x < 0 || y < 0 || x >= w || y >= h) { continue; }
        var i = (y * w + x) * 4;
        sr += d[i]; sg += d[i + 1]; sb += d[i + 2]; n++;
      }
    }
    if (!n) { return; }
    params.baseR = Math.round(sr / n);
    params.baseG = Math.round(sg / n);
    params.baseB = Math.round(sb / n);
    state.baseAuto = false;
    syncBase();
    invalidate();
    toast('已取片基色 ' + params.baseR + ',' + params.baseG + ',' + params.baseB);
  }

  function onViewPointer(e) {
    if (!state.picking || !srcData) { return; }
    var pt = pointToSource(e.clientX, e.clientY);
    if (!pt) { toast('点到了画面外，请点在底片上', true); return; }
    e.preventDefault();
    sampleBaseAt(pt);
    setPicking(false);
  }

  /* SECTION: app-capture */
  function flash() {
    flashEl.classList.remove('on');
    void flashEl.offsetWidth;
    flashEl.classList.add('on');
  }

  function modeLabel() {
    if (!params.invert && !params.unmask) { return '原负片'; }
    if (!params.invert) { return '负片去罩'; }
    if (!params.unmask) { return '正片未去罩'; }
    return '正片去罩';
  }

  function stamp() {
    var d = new Date();
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
  }

  function makeThumb(src) {
    var f = fitSize(src.width, src.height, THUMB_MAX);
    var c = document.createElement('canvas');
    c.width = f.w; c.height = f.h;
    c.getContext('2d').drawImage(src, 0, 0, f.w, f.h);
    try { return c.toDataURL('image/png'); } catch (e) { return ''; }
  }

  function addShot(url, thumb, w, h) {
    shots.unshift({
      url: url, thumb: thumb, w: w, h: h,
      label: modeLabel(), name: '去色罩预览_' + modeLabel() + '_' + stamp() + '.png'
    });
    while (shots.length > MAX_SHOTS) {
      var old = shots.pop();
      if (old && old.url && old.url.indexOf('blob:') === 0) { URL.revokeObjectURL(old.url); }
    }
    renderStrip();
  }

  function capture() {
    var size = currentSourceSize();
    if (state.source === 'none' || !size.w || !size.h) { return; }
    if (state.source === 'camera' && video.readyState < 2) { toast('画面还没准备好，请稍候', true); return; }

    var el = currentSourceEl();
    var f = fitSize(size.w, size.h, CAPTURE_MAX);
    capCanvas.width = f.w; capCanvas.height = f.h;
    capCtx.imageSmoothingEnabled = true;
    capCtx.imageSmoothingQuality = 'high';
    capCtx.drawImage(el, 0, 0, f.w, f.h);

    var id;
    try { id = capCtx.getImageData(0, 0, f.w, f.h); }
    catch (err) { toast('当前环境禁止读取画布像素，无法保存', true); return; }

    E.processInPlace(id, params);
    capCtx.putImageData(id, 0, 0);

    var thumb = makeThumb(capCanvas);
    flash();

    if (capCanvas.toBlob) {
      capCanvas.toBlob(function (blob) {
        if (!blob) { toast('图片编码失败，请重试', true); return; }
        addShot(URL.createObjectURL(blob), thumb, f.w, f.h);
        toast('已保存预览图 ' + f.w + '×' + f.h);
      }, 'image/png');
    } else {
      try {
        addShot(capCanvas.toDataURL('image/png'), thumb, f.w, f.h);
        toast('已保存预览图 ' + f.w + '×' + f.h);
      } catch (err2) {
        toast('图片编码失败，请重试', true);
      }
    }
  }

  /* SECTION: app-strip */
  function download(shot) {
    var a = document.createElement('a');
    a.href = shot.url;
    a.download = shot.name;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    toast('已开始下载 ' + shot.name);
  }

  function renderStrip() {
    strip.querySelectorAll('.th').forEach(function (n) { n.remove(); });
    stripEmpty.hidden = shots.length > 0;
    btnClear.hidden = shots.length === 0;
    btnDownloadLast.disabled = shots.length === 0;

    shots.forEach(function (shot, idx) {
      var box = document.createElement('div');
      box.className = 'th';
      box.title = shot.label + ' ' + shot.w + '×' + shot.h + ' · 点击下载';

      var img = document.createElement('img');
      img.alt = shot.label + '预览图 ' + (idx + 1);
      if (shot.thumb) { img.src = shot.thumb; } else { img.src = shot.url; }
      img.addEventListener('error', function () { img.style.visibility = 'hidden'; });

      var dl = document.createElement('span');
      dl.className = 'dl';
      dl.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/></svg>';

      box.appendChild(img);
      box.appendChild(dl);
      box.addEventListener('click', function () { download(shot); });
      strip.appendChild(box);
    });

    strip.scrollLeft = 0;
  }

  function clearShots() {
    shots.forEach(function (s) {
      if (s.url && s.url.indexOf('blob:') === 0) { URL.revokeObjectURL(s.url); }
    });
    shots = [];
    renderStrip();
    toast('已清空本次保存的预览图');
  }

  /* SECTION: app-events */
  btnStart.addEventListener('click', startCamera);
  btnUpload.addEventListener('click', pickFile);
  btnUploadTop.addEventListener('click', pickFile);
  fileInput.addEventListener('change', onFile);

  tgInvert.addEventListener('click', function () {
    params.invert = !params.invert;
    syncToggles(); invalidate();
    toast(params.invert ? '已反相为正片' : '已切回负片观感（可对照去罩效果）');
  });
  tgMask.addEventListener('click', function () {
    params.unmask = !params.unmask;
    syncToggles(); syncSliders(); invalidate();
    toast(params.unmask ? '已开启片基色罩去除' : '已关闭去色罩，保留原始色罩');
  });

  btnAutoBase.addEventListener('click', function () { autoBase(false); });
  btnAutoGain.addEventListener('click', autoGain);
  btnPick.addEventListener('click', function () {
    if (state.source === 'none') { toast('请先开启镜头或上传底片照片', true); return; }
    setPicking(!state.picking);
  });

  btnShoot.addEventListener('click', capture);
  btnReset.addEventListener('click', function () {
    params = E.defaults();
    state.baseAuto = false;
    setPicking(false);
    syncAll();
    invalidate();
    toast('参数已复位到默认片基与增益');
  });
  btnDownloadLast.addEventListener('click', function () {
    if (shots.length) { download(shots[0]); }
  });
  btnClear.addEventListener('click', clearShots);

  vf.addEventListener('pointerdown', onViewPointer);
  vf.addEventListener('touchstart', function (e) {
    if (!state.picking) { return; }
    var t = e.touches && e.touches[0];
    if (!t) { return; }
    var pt = pointToSource(t.clientX, t.clientY);
    if (pt) { e.preventDefault(); sampleBaseAt(pt); setPicking(false); }
  }, { passive: false });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && state.picking) { setPicking(false); return; }
    if ((e.code === 'Space' || e.key === 'Enter') && e.target === document.body && state.source !== 'none') {
      e.preventDefault();
      capture();
    }
  });

  video.addEventListener('error', function () {
    if (state.source === 'camera') { toast('摄像头数据流中断，请重新开启', true); }
  });

  window.addEventListener('beforeunload', function () {
    if (rafId) { cancelAnimationFrame(rafId); }
    stopCamera();
    shots.forEach(function (s) {
      if (s.url && s.url.indexOf('blob:') === 0) { URL.revokeObjectURL(s.url); }
    });
    if (photoUrl) { URL.revokeObjectURL(photoUrl); }
  });

  /* SECTION: app-init */
  buildSliders();
  syncAll();
  renderStrip();
  if (!window.isSecureContext && location.protocol !== 'file:') {
    showNote('提示：浏览器只允许在 HTTPS 或 localhost 环境调用摄像头。如果「开启镜头」无反应，请直接使用「上传底片照片」，去色罩效果完全一致。');
  }
})();
