/* SECTION: engine-core */
/* 胶片负片去色罩引擎：在密度域（density domain）完成反相与片基色罩去除 */
(function (global) {
  'use strict';

  /* 典型彩色负片片基＋色罩的颜色（偏橙），仅作默认起点 */
  var DEFAULT_BASE = { r: 233, g: 143, b: 62 };

  var DEFAULTS = {
    invert: true,        // 反相成正片
    unmask: true,        // 去除片基色罩
    maskStrength: 100,   // 色罩强度 %
    exposure: 0,         // 曝光 -100..100
    contrast: 100,       // 对比度 %
    saturation: 100,     // 饱和度 %
    gainR: 100,          // 红通道增益 %
    gainG: 100,          // 绿通道增益 %
    gainB: 100,          // 蓝通道增益 %
    baseR: DEFAULT_BASE.r,
    baseG: DEFAULT_BASE.g,
    baseB: DEFAULT_BASE.b
  };

  function defaults() {
    var o = {}, k;
    for (k in DEFAULTS) { if (Object.prototype.hasOwnProperty.call(DEFAULTS, k)) { o[k] = DEFAULTS[k]; } }
    return o;
  }

  function clampByte(v) { return v < 0 ? 0 : (v > 255 ? 255 : v | 0); }

  function density(byteVal) {
    // D = -log10(v/255)，Beer-Lambert：透射率转密度
    return -Math.log10(Math.max(byteVal, 1) / 255);
  }

  /* SECTION: engine-lut */
  var lutCache = { key: '', luts: null };

  function lutKey(p) {
    return [p.invert ? 1 : 0, p.unmask ? 1 : 0, p.maskStrength, p.exposure, p.contrast,
            p.gainR, p.gainG, p.gainB, p.baseR, p.baseG, p.baseB].join('|');
  }

  /* 为单通道构建 256 级查找表：
     Din  = -log10(v/255)                 实测密度
     Dm   = Din - maskStrength * Dbase    减去片基色罩密度（色罩在密度域是可加的）
     Dp   = gain * contrast * exp * Dm    通道增益 / 对比度 / 曝光
     正片 = 255 * (1 - 10^-Dp)            Dm=0（片基）→ 黑，密度大（原场景高光）→ 白
     负片 = 255 * 10^-Dp                  保留负片观感，用于对照去罩效果 */
  function buildChannelLut(p, ch) {
    var lut = new Uint8ClampedArray(256);
    var base = ch === 0 ? p.baseR : (ch === 1 ? p.baseG : p.baseB);
    var gain = (ch === 0 ? p.gainR : (ch === 1 ? p.gainG : p.gainB)) / 100;
    var Dbase = density(base);
    var mask = p.unmask ? (p.maskStrength / 100) : 0;
    var contrast = Math.max(p.contrast, 1) / 100;
    var expF = Math.pow(2, p.exposure / 100);
    var k = gain * contrast * expF;
    var invert = !!p.invert;
    var v, Dm, Dp, out;
    for (v = 0; v < 256; v++) {
      Dm = density(v) - mask * Dbase;
      if (Dm < 0) { Dm = 0; }
      Dp = k * Dm;
      out = invert ? 255 * (1 - Math.pow(10, -Dp)) : 255 * Math.pow(10, -Dp);
      lut[v] = clampByte(out);
    }
    return lut;
  }

  function getLuts(p) {
    var key = lutKey(p);
    if (lutCache.key !== key || !lutCache.luts) {
      lutCache = { key: key, luts: [buildChannelLut(p, 0), buildChannelLut(p, 1), buildChannelLut(p, 2)] };
    }
    return lutCache.luts;
  }

  /* SECTION: engine-process */
  /* 读取 src、写入 dst，两块缓冲分离，避免每帧整块拷贝 */
  function processInto(srcImg, dstImg, p) {
    var s = srcImg.data, d = dstImg.data;
    var luts = getLuts(p);
    var lr = luts[0], lg = luts[1], lb = luts[2];
    var sat = p.saturation / 100;
    var n = s.length < d.length ? s.length : d.length;
    var i, r, g, b, lum;
    if (sat === 1) {
      for (i = 0; i < n; i += 4) {
        d[i] = lr[s[i]];
        d[i + 1] = lg[s[i + 1]];
        d[i + 2] = lb[s[i + 2]];
      }
    } else {
      for (i = 0; i < n; i += 4) {
        r = lr[s[i]]; g = lg[s[i + 1]]; b = lb[s[i + 2]];
        lum = (r * 77 + g * 151 + b * 28) >> 8;
        d[i] = clampByte(lum + (r - lum) * sat);
        d[i + 1] = clampByte(lum + (g - lum) * sat);
        d[i + 2] = clampByte(lum + (b - lum) * sat);
      }
    }
    return dstImg;
  }

  /* 原地处理，用于拍照全分辨率输出 */
  function processInPlace(imgData, p) {
    var d = imgData.data;
    var luts = getLuts(p);
    var lr = luts[0], lg = luts[1], lb = luts[2];
    var sat = p.saturation / 100;
    var n = d.length;
    var i, r, g, b, lum;
    if (sat === 1) {
      for (i = 0; i < n; i += 4) {
        d[i] = lr[d[i]];
        d[i + 1] = lg[d[i + 1]];
        d[i + 2] = lb[d[i + 2]];
      }
    } else {
      for (i = 0; i < n; i += 4) {
        r = lr[d[i]]; g = lg[d[i + 1]]; b = lb[d[i + 2]];
        lum = (r * 77 + g * 151 + b * 28) >> 8;
        d[i] = clampByte(lum + (r - lum) * sat);
        d[i + 1] = clampByte(lum + (g - lum) * sat);
        d[i + 2] = clampByte(lum + (b - lum) * sat);
      }
    }
    return imgData;
  }

  /* SECTION: engine-base-detect */
  /* 自动识别片基色：负片上未曝光的片基透光最多，在照片里是最亮的一片橙色。
     取亮度 90 分位以上的像素求均值作为片基色。 */
  function detectBase(imgData) {
    var d = imgData.data, w = imgData.width, h = imgData.height;
    var stepX = Math.max(1, Math.floor(w / 180));
    var stepY = Math.max(1, Math.floor(h / 180));
    var hist = new Int32Array(256);
    var x, y, i, r, g, b, l;
    var total = 0;
    for (y = 0; y < h; y += stepY) {
      for (x = 0; x < w; x += stepX) {
        i = (y * w + x) * 4;
        r = d[i]; g = d[i + 1]; b = d[i + 2];
        l = (r * 77 + g * 151 + b * 28) >> 8;
        hist[l]++; total++;
      }
    }
    if (!total) { return null; }

    var acc = 0, thr = 255, target = total * 0.90;
    for (l = 0; l < 256; l++) { acc += hist[l]; if (acc >= target) { thr = l; break; } }

    var midAcc = 0, mid = 0, targetMid = total * 0.5;
    for (l = 0; l < 256; l++) { midAcc += hist[l]; if (midAcc >= targetMid) { mid = l; break; } }

    var sr = 0, sg = 0, sb = 0, n = 0;
    for (y = 0; y < h; y += stepY) {
      for (x = 0; x < w; x += stepX) {
        i = (y * w + x) * 4;
        l = (d[i] * 77 + d[i + 1] * 151 + d[i + 2] * 28) >> 8;
        if (l >= thr) { sr += d[i]; sg += d[i + 1]; sb += d[i + 2]; n++; }
      }
    }
    if (!n) { return null; }
    return {
      r: Math.round(sr / n),
      g: Math.round(sg / n),
      b: Math.round(sb / n),
      samples: n,
      // 片基应明显亮于画面中位亮度，否则说明画面里没有干净的片基区
      weak: thr < mid * 1.12 + 8
    };
  }

  /* SECTION: engine-gray-balance */
  /* 自动灰平衡：灰世界假设在密度域成立——影像区去罩后三通道的平均密度应当相等。
     只统计「明显暗于片基」的影像区像素：负片里片基是透光最多的地方，
     若把大片片基边缘也算进来，净密度会趋近 0，校正量就失真甚至失效。 */
  function computeGrayGains(imgData, p) {
    var d = imgData.data, w = imgData.width, h = imgData.height;
    var stepX = Math.max(1, Math.floor(w / 160));
    var stepY = Math.max(1, Math.floor(h / 160));
    var mask = p.unmask ? (p.maskStrength / 100) : 0;
    var baseLum = (p.baseR * 77 + p.baseG * 151 + p.baseB * 28) >> 8;
    // 影像区判定阈值：亮度低于片基一定比例才算有效影像
    var imgThr = baseLum * 0.92;

    var sumR = 0, sumG = 0, sumB = 0, n = 0;
    var x, y, i, lum;
    for (y = 0; y < h; y += stepY) {
      for (x = 0; x < w; x += stepX) {
        i = (y * w + x) * 4;
        lum = (d[i] * 77 + d[i + 1] * 151 + d[i + 2] * 28) >> 8;
        if (lum >= imgThr) { continue; }   // 跳过片基区
        sumR += density(d[i]);
        sumG += density(d[i + 1]);
        sumB += density(d[i + 2]);
        n++;
      }
    }

    var sampled = 0;
    for (y = 0; y < h; y += stepY) { for (x = 0; x < w; x += stepX) { sampled++; } }
    // 影像区占比过低说明画面几乎全是片基，没有可校正的影像内容
    if (!n || n < sampled * 0.06) { return null; }

    var mR = sumR / n - mask * density(p.baseR);
    var mG = sumG / n - mask * density(p.baseG);
    var mB = sumB / n - mask * density(p.baseB);
    if (mR < 0.02 || mG < 0.02 || mB < 0.02) { return null; }

    var t = (mR + mG + mB) / 3;
    function norm(v) { return Math.round(Math.max(40, Math.min(220, (t / v) * 100))); }
    return { r: norm(mR), g: norm(mG), b: norm(mB) };
  }

  global.FilmUnmask = {
    DEFAULT_BASE: DEFAULT_BASE,
    defaults: defaults,
    processInto: processInto,
    processInPlace: processInPlace,
    detectBase: detectBase,
    computeGrayGains: computeGrayGains
  };
})(typeof window !== 'undefined' ? window : this);
