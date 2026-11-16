/* Live canvas — a website that builds itself, then works.
 *
 * Every scene is a tall <section> whose stage sticks to the viewport. The
 * scroll position inside the section becomes progress p ∈ [0,1], and every
 * step on the timeline (draw a rect, type text, drop an image, pick a fill…)
 * is a pure function of p — so it can play forwards and backwards.
 *
 * The "director" turns one scroll gesture into an auto-played tween to the
 * next stop (a fully built section). Once a section is built it goes "live":
 * links, buttons, the gallery, the form and the newsletter all work.
 */
(() => {
'use strict';

/* ---------------- helpers ---------------- */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const clamp = (v, a = 0, b = 1) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const lerp2 = (p, q, t) => [lerp(p[0], q[0], t), lerp(p[1], q[1], t)];
const ease = t => (t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const easeOut = t => 1 - Math.pow(1 - t, 3);
const easeSine = t => -(Math.cos(Math.PI * t) - 1) / 2;
const backOut = t => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); };
const smooth = (a, b, v) => { const t = clamp((v - a) / (b - a)); return t * t * (3 - 2 * t); };
const center = r => [r.x + r.w / 2, r.y + r.h / 2];
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const emph = s => esc(s).replace(/_(.+?)_/g, '<em>$1</em>');
const HOLD = .022;
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;

// design canvas size: desktop 1280×800, portrait phones 400×820
let W = 1280, H = 800, MOBILE = false;
// timeline coordinates are authored for desktop; map them onto the current canvas
const S2 = pt => [pt[0] * W / 1280, pt[1] * H / 800];

// write-through caches so we only touch the DOM when a value actually changes
function css(el, k, v) { const c = el._c || (el._c = {}); if (c[k] !== v) { c[k] = v; el.style[k] = v; } }
function cssv(el, k, v) { const c = el._c || (el._c = {}); if (c[k] !== v) { c[k] = v; el.style.setProperty(k, v); } }
function tog(el, cls, on) { const c = el._c || (el._c = {}); const k = '.' + cls; if (c[k] !== on) { c[k] = on; el.classList.toggle(cls, on); } }
function txt(el, v) { if (el._t !== v) { el._t = v; el.textContent = v; } }

function rectOf(el, root) {
  let x = 0, y = 0, n = el;
  while (n && n !== root) {
    x += n.offsetLeft; y += n.offsetTop;
    const op = n.offsetParent;
    if (op && op !== root) { x += op.clientLeft; y += op.clientTop; }
    n = op;
  }
  return { x, y, w: el.offsetWidth, h: el.offsetHeight };
}

const hexRgb = h => { h = h.replace('#', ''); return [0, 2, 4].map(i => parseInt(h.substr(i, 2), 16)); };
const rgbHex = c => '#' + c.map(v => Math.round(v).toString(16).padStart(2, '0')).join('').toUpperCase();
function rgbStrHex(s) { const m = s.match(/[\d.]+/g); return m ? rgbHex(m.slice(0, 3).map(Number)) : '–'; }
function hsv([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d) { h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; h *= 60; if (h < 0) h += 360; }
  return [h, mx ? d / mx : 0, mx];
}

/* ---------------- text: | = newline, _x_ = italic, [label](action) = link ---------------- */
function parseText(s) {
  const out = [], links = [], str = s.replace(/\|/g, '\n');
  let em = false;
  for (let i = 0; i < str.length;) {
    const ch = str[i];
    if (ch === '_') { em = !em; i++; continue; }
    if (ch === '[') {
      const mid = str.indexOf('](', i), end = mid > 0 ? str.indexOf(')', mid) : -1;
      if (end > 0) {
        const ln = links.push(str.slice(mid + 2, end)) - 1;
        for (const c of str.slice(i + 1, mid)) out.push({ ch: c, em, ln });
        i = end + 1; continue;
      }
    }
    const c = String.fromCodePoint(str.codePointAt(i));
    out.push({ ch: c, em, ln: -1 });
    i += c.length;
  }
  out.links = links;
  return out;
}
function renderText(chars, n) {
  let h = '', em = false, ln = -1;
  const close = () => { if (em) h += '</em>'; if (ln >= 0) h += '</a>'; };
  for (let i = 0; i < n; i++) {
    const c = chars[i];
    if (c.em !== em || c.ln !== ln) {
      close();
      if (c.ln >= 0) h += `<a class="lnk" href="#" data-x="${esc(chars.links[c.ln])}">`;
      if (c.em) h += '<em>';
      em = c.em; ln = c.ln;
    }
    h += esc(c.ch);
  }
  close();
  return h;
}

/* ---------------- people ---------------- */
const PEOPLE = { Maya: '#F24E1E', Leo: '#0D99FF', Ines: '#14AE5C', Kai: '#9747FF' };

/* ---------------- actions ----------------
 * Each step runs from a→b. The first `tv` fraction is the cursor travelling
 * to where the action starts; the rest (u ∈ [0,1]) is the action itself.
 */
const TV = { draw: .25, type: .3, count: .3, drop: .22, fill: .22, move: .28, pop: .35, press: .4, goto: 1, chat: 0 };
const DOWN = { draw: 1, drop: 1, move: 1, fill: 1 };

const ACT = {
  draw: {
    init(st) { const p = st.el.previousElementSibling; st.el._label = p && p.classList.contains('frame-label') ? p : null; },
    start(st) { const r = st.r(); return [r.x, r.y]; },
    pos(st, u) { const r = st.r(), e = ease(u); return [r.x + r.w * e, r.y + r.h * e]; },
    apply(st) {
      const el = st.el, u = st.u, e = ease(u);
      css(el, 'visibility', u > 0 ? 'visible' : 'hidden');
      css(el, 'clipPath', u > 0 && u < 1 ? `inset(0 ${((1 - e) * 100).toFixed(2)}% ${((1 - e) * 100).toFixed(2)}% 0)` : 'none');
      if (el._label) css(el._label, 'opacity', u > 0 ? '1' : '0');
    },
    sel(st) { const r = st.r(), e = ease(st.u); return { x: r.x, y: r.y, w: Math.max(1, r.w * e), h: Math.max(1, r.h * e), badge: `${Math.round(r.w * e)} × ${Math.round(r.h * e)}` }; },
  },
  type: {
    init(st) { st.center = st.el.classList.contains('lbl'); st.el._text = true; ACT.type.parse(st); },
    parse(st) { st.chars = parseText((MOBILE && st.el.dataset.mtext) || st.el.dataset.text || ''); },
    start(st) { const r = st.r(); return st.center ? [r.x + r.w / 2, r.y + r.h / 2 + 4] : [r.x - 2, r.y + st.lh * .55]; },
    pos(st, u) { const s = ACT.type.start(st), e = easeOut(Math.min(1, u * 1.6)); return [s[0] - 10 * e, s[1] + 24 * e]; },
    apply(st, scene) {
      const u = st.u, len = st.chars.length;
      let n = Math.round(len * u), caret = u > 0 && u < 1;
      if (st.retype && u >= 1) {             // re-typed live (story carousel)
        const k = clamp((scene.now - st.retype) / st.retypeMs);
        n = Math.round(len * k); caret = k < 1;
        if (k >= 1) st.retype = 0;
      }
      const key = n + (caret ? 'c' : '');
      if (st.el._k === key) return;
      st.el._k = key;
      st.el.innerHTML = renderText(st.chars, n) + (caret ? `<span class="caret" style="background:${st.cur.color}"></span>` : '');
    },
    sel(st) { return st.r(); },
  },
  count: {
    init(st) { const d = st.el.dataset; st.to = +d.count; st.dec = +(d.dec || 0); st.suf = d.suffix || ''; st.el._text = true; },
    start(st) { return ACT.type.start(st); },
    pos(st, u) { return ACT.type.pos(st, u); },
    apply(st) {
      const u = st.u, v = st.to * easeOut(u);
      txt(st.el, u <= 0 ? '' : (st.dec ? v.toFixed(st.dec) : Math.round(v).toLocaleString('en-US')) + st.suf);
    },
    sel(st) { return st.r(); },
  },
  drop: {
    init(st) { st.img = $('.img', st.el); },
    start(st) { return S2(st.o.from); },
    pos(st, u) { const c = center(st.r()); return u < .72 ? lerp2(S2(st.o.from), c, ease(u / .72)) : c; },
    apply(st) {
      const k = smooth(.84, 1, st.u);
      css(st.img, 'opacity', k.toFixed(3));
      css(st.img, 'transform', `scale(${(1.08 - .08 * k).toFixed(4)})`);
      tog(st.el, 'hover', st.u > .55 && st.u < .97);
      cssv(st.el, '--hc', st.cur.color);
    },
    sel(st) { return st.u > .55 ? st.r() : null; },
  },
  fill: {
    init(st) {
      st.fl = $('.fill', st.el);
      st.c0 = hexRgb(st.o.fromColor || '#D9D9D9');
      st.c1 = hexRgb(st.o.color);
      const [h, s, v] = hsv(st.c1);
      st.hue = h; st.d = [s, 1 - v];
      st.pk = () => {
        const r = st.r();
        let x = r.x + r.w + 18, y = clamp(r.y - 20, 10, H - 236);
        if (x + 200 > W - 10) x = r.x - 218;
        if (x < 10) { x = clamp(r.x + r.w / 2 - 100, 10, W - 210); y = r.y + r.h + 14; if (y + 226 > H - 6) y = r.y - 240; }
        return { x, y };
      };
    },
    dot(st, k) { const pk = st.pk(); return [pk.x + 12 + lerp(.04, st.d[0], k) * 176, pk.y + 38 + lerp(.04, st.d[1], k) * 120]; },
    start(st) { return center(st.r()); },
    pos(st, u) { return u < .18 ? lerp2(center(st.r()), ACT.fill.dot(st, 0), ease(u / .18)) : ACT.fill.dot(st, ease(clamp((u - .18) / .62))); },
    apply(st) {
      const k = ease(clamp((st.u - .18) / .62));
      css(st.fl, 'opacity', k.toFixed(3));
      if (st.o.cls) tog(st.el, st.o.cls, k > .5);
    },
    sel(st) { return st.r(); },
  },
  move: {
    off(st) { return S2(st.o.from); },
    start(st) { const c = center(st.r()), f = ACT.move.off(st); return [c[0] + f[0], c[1] + f[1]]; },
    pos(st, u) { const c = center(st.r()), e = ease(u), f = ACT.move.off(st); return [c[0] + f[0] * (1 - e), c[1] + f[1] * (1 - e)]; },
    apply(st) {
      const e = ease(st.u), f = ACT.move.off(st), el = st.el;
      cssv(el, '--mx', (f[0] * (1 - e)).toFixed(2) + 'px');
      cssv(el, '--my', (f[1] * (1 - e)).toFixed(2) + 'px');
      cssv(el, '--mr', ((st.o.rot || 0) * (1 - e)).toFixed(2) + 'deg');
      if (st.o.fade) cssv(el, '--mo', clamp(st.u * 8).toFixed(3));
      tog(el, 'dragging', st.u > 0 && st.u < 1);
    },
    sel(st) { const r = st.r(), e = ease(st.u), f = ACT.move.off(st); return { x: r.x + f[0] * (1 - e), y: r.y + f[1] * (1 - e), w: r.w, h: r.h }; },
  },
  pop: {
    start(st) { return center(st.r()); },
    pos(st) { return center(st.r()); },
    apply(st) {
      cssv(st.el, '--pop', st.u <= 0 ? '0' : backOut(st.u).toFixed(4));
      cssv(st.el, '--po', clamp(st.u * 3).toFixed(3));
    },
    sel(st) { return st.r(); },
  },
  press: {
    start(st) { return center(st.r()); },
    pos(st) { const c = center(st.r()); return [c[0] - 6, c[1] + 2]; },
    apply(st, scene) {
      cssv(st.el, '--press', (1 - .1 * Math.sin(Math.PI * st.u)).toFixed(4));
      const on = st.u >= .5;
      if (on !== st.on) { st.on = on; scene.onFire(st.o.fire, on); }
    },
    sel(st) { return st.r(); },
  },
  goto: { start(st) { return S2(st.o.at); }, pos(st) { return S2(st.o.at); } },
  chat: { start() { return [0, 0]; }, pos() { return [0, 0]; } },
};

/* ---------------- the timeline ----------------
 * [who, action, elementId, start, end, options] — coordinates in desktop canvas px.
 * rest  = where the auto-player stops (everything built, chats done)
 * build = how long (ms) the auto-player takes to build the frame
 */
const SCENES = [
  {
    id: 'hero', name: 'Hero', rest: .785, build: 4400,
    from: { Maya: [430, 585], Leo: [800, 300], Ines: [930, 560], Kai: [330, 280] },
    exit: { a: .8, b: .95, to: { Maya: [300, 940], Leo: [720, 960], Ines: [1020, 940], Kai: [520, 980] } },
    steps: [
      ['Leo', 'chat', null, -.12, .07, { msg: 'morning team ☕ let’s build' }],
      ['Ines', 'chat', null, -.08, .09, { msg: 'ready 🙌' }],
      ['Maya', 'draw', 'hero-frame', .03, .13],
      ['Maya', 'type', 'h-logo', .13, .19],
      ['Leo', 'type', 'h-nav', .12, .22],
      ['Ines', 'draw', 'h-navbtn', .13, .21],
      ['Ines', 'fill', 'h-navbtn', .21, .27, { color: '#1F2A24' }],
      ['Ines', 'type', 'h-navbtn-t', .27, .31],
      ['Maya', 'type', 'h-title', .19, .37],
      ['Kai', 'draw', 'h-img', .15, .25],
      ['Kai', 'drop', 'h-img', .27, .42, { from: [1460, 420] }],
      ['Leo', 'type', 'h-sub', .23, .38],
      ['Ines', 'draw', 'h-cta', .32, .40],
      ['Ines', 'fill', 'h-cta', .40, .45, { color: '#D2693C' }],
      ['Ines', 'type', 'h-cta-t', .45, .50],
      ['Leo', 'draw', 'h-sec', .39, .46],
      ['Leo', 'type', 'h-sec-t', .47, .52],
      ['Maya', 'type', 'h-rating', .40, .52],
      ['Kai', 'move', 'h-card', .44, .56, { from: [150, 170], rot: 9, fade: true }],
      ['Maya', 'chat', null, .55, .66, { msg: 'headline feels right ✨' }],
      ['Kai', 'chat', null, .58, .69, { msg: 'that photo though 🔥' }],
      ['Leo', 'chat', null, .64, .76, { msg: 'it works — click around!' }],
    ],
  },
  {
    id: 'features', name: 'Why Driftwood', rest: .815, build: 4300,
    from: { Maya: [300, -150], Leo: [640, -170], Ines: [980, -150], Kai: [500, -210] },
    exit: { a: .82, b: .96, to: { Maya: [260, 950], Leo: [640, 970], Ines: [1040, 950], Kai: [450, 990] } },
    steps: [
      ['Leo', 'draw', 'feat-frame', .02, .12],
      ['Maya', 'type', 'f-eye', .12, .17],
      ['Maya', 'type', 'f-title', .17, .31],
      ['Leo', 'type', 'f-para', .13, .28],
      ['Maya', 'draw', 'f-c1', .31, .39],
      ['Leo', 'draw', 'f-c2', .29, .37],
      ['Ines', 'draw', 'f-c3', .31, .39],
      ['Kai', 'pop', 'f-i1', .38, .42],
      ['Kai', 'pop', 'f-i2', .42, .46],
      ['Kai', 'pop', 'f-i3', .46, .50],
      ['Maya', 'type', 'f-t1', .39, .45],
      ['Maya', 'type', 'f-b1', .45, .58],
      ['Leo', 'type', 'f-t2', .38, .44],
      ['Leo', 'type', 'f-b2', .44, .57],
      ['Ines', 'type', 'f-t3', .40, .46],
      ['Ines', 'type', 'f-b3', .46, .59],
      ['Leo', 'chat', null, .56, .66, { msg: 'make the middle one dark?' }],
      ['Kai', 'chat', null, .60, .67, { msg: 'say less' }],
      ['Kai', 'fill', 'f-c2', .64, .74, { color: '#1F2A24', fromColor: '#FFFFFF', cls: 'inv' }],
      ['Ines', 'chat', null, .72, .81, { msg: 'chef’s kiss 🤌' }],
    ],
  },
  {
    id: 'gallery', name: 'Journeys', rest: .79, build: 4200,
    from: { Maya: [200, -150], Leo: [700, -150], Ines: [1100, -150], Kai: [450, -200] },
    exit: { a: .82, b: .96, to: { Maya: [300, 950], Leo: [760, 960], Ines: [1060, 950], Kai: [520, 990] } },
    steps: [
      ['Ines', 'draw', 'gal-frame', .02, .12],
      ['Leo', 'type', 'g-title', .12, .28],
      ['Maya', 'type', 'g-side', .15, .28],
      ['Kai', 'draw', 'g-a', .24, .32],
      ['Maya', 'draw', 'g-b', .28, .35],
      ['Ines', 'draw', 'g-c', .27, .34],
      ['Leo', 'draw', 'g-d', .29, .36],
      ['Kai', 'drop', 'g-a', .33, .47, { from: [-230, 520] }],
      ['Maya', 'drop', 'g-b', .37, .50, { from: [690, -220] }],
      ['Ines', 'drop', 'g-c', .40, .53, { from: [690, 1010] }],
      ['Leo', 'drop', 'g-d', .44, .57, { from: [1500, 450] }],
      ['Kai', 'type', 'g-ca', .48, .54],
      ['Maya', 'type', 'g-cb', .51, .57],
      ['Ines', 'type', 'g-cc', .54, .60],
      ['Leo', 'type', 'g-cd', .58, .64],
      ['Ines', 'chat', null, .62, .72, { msg: 'these photos 😍' }],
      ['Maya', 'chat', null, .66, .77, { msg: 'tap one, they open' }],
    ],
  },
  {
    id: 'story', name: 'Stories', rest: .765, build: 3900,
    from: { Maya: [250, -150], Leo: [900, -150], Ines: [600, -180], Kai: [1100, -160] },
    exit: { a: .8, b: .95, to: { Maya: [280, 950], Leo: [760, 960], Ines: [520, 980], Kai: [1040, 950] } },
    steps: [
      ['Kai', 'draw', 'story-frame', .02, .12],
      ['Maya', 'type', 's-eye', .12, .16],
      ['Maya', 'type', 's-quote', .16, .34],
      ['Leo', 'draw', 's-photo', .13, .22],
      ['Leo', 'drop', 's-photo', .24, .38, { from: [1490, 200] }],
      ['Ines', 'pop', 's-av', .30, .35],
      ['Ines', 'type', 's-name', .35, .40],
      ['Ines', 'type', 's-meta', .40, .46],
      ['Ines', 'pop', 's-prev', .47, .51],
      ['Ines', 'pop', 's-next', .51, .55],
      ['Kai', 'draw', 's-line', .38, .46],
      ['Kai', 'count', 's-n1', .46, .56],
      ['Leo', 'count', 's-n2', .44, .53],
      ['Maya', 'count', 's-n3', .47, .56],
      ['Kai', 'type', 's-l1', .56, .62],
      ['Leo', 'type', 's-l2', .53, .60],
      ['Maya', 'type', 's-l3', .56, .63],
      ['Ines', 'chat', null, .57, .66, { msg: 'arrows flip the stories 🥹' }],
      ['Leo', 'chat', null, .64, .74, { msg: 'one more frame' }],
    ],
  },
  {
    id: 'launch', name: 'Newsletter', rest: .93, build: 5000,
    from: { Maya: [300, -150], Leo: [800, -150], Ines: [1000, -180], Kai: [550, -200] },
    steps: [
      ['Maya', 'draw', 'launch-frame', .02, .11],
      ['Leo', 'type', 'l-title', .11, .27],
      ['Ines', 'type', 'l-para', .18, .30],
      ['Kai', 'draw', 'l-img', .12, .21],
      ['Kai', 'drop', 'l-img', .22, .36, { from: [1490, 600] }],
      ['Maya', 'draw', 'l-input', .28, .35],
      ['Maya', 'type', 'l-ph', .35, .42],
      ['Ines', 'draw', 'l-sub', .31, .37],
      ['Ines', 'fill', 'l-sub', .37, .42, { color: '#1F2A24' }],
      ['Ines', 'type', 'l-sub-t', .42, .46],
      ['Leo', 'draw', 'l-line', .36, .42],
      ['Leo', 'type', 'l-flogo', .42, .47],
      ['Kai', 'type', 'l-links', .42, .50],
      ['Maya', 'type', 'l-copy', .45, .52],
      ['Kai', 'pop', 'l-pub', .53, .58],
      ['Kai', 'chat', null, .57, .66, { msg: 'ready to ship? 👀' }],
      ['Kai', 'goto', null, .59, .64, { at: [1222, 120] }],
      ['Maya', 'goto', null, .59, .66, { at: [1030, 98] }],
      ['Ines', 'goto', null, .60, .67, { at: [1112, 150] }],
      ['Leo', 'press', 'l-pub', .63, .73, { fire: 'publish' }],
      ['Maya', 'chat', null, .75, .86, { msg: '🚀🚀🚀' }],
      ['Ines', 'chat', null, .76, .88, { msg: 'we shipped it!!' }],
      ['Leo', 'chat', null, .79, .9, { msg: 'gg team 💛' }],
    ],
  },
];

/* ---------------- scene engine ---------------- */
let S = 1, INV = 1;

function makeCursor(ov, name, from, i) {
  const color = PEOPLE[name];
  const el = document.createElement('div');
  el.className = 'cursor';
  el.style.setProperty('--c', color);
  el.innerHTML = `<svg width="24" height="26" viewBox="0 0 24 26"><path d="M3 2.5v18.2l5-4.7 3.3 7.3 3.1-1.4-3.2-7.1h7z" fill="${color}" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg><div class="tag">${name}</div><div class="chat"></div>`;
  const sel = document.createElement('div');
  sel.className = 'sel'; sel.style.setProperty('--c', color);
  sel.innerHTML = '<i></i><i></i><i></i><i></i><b class="badge"></b>';
  const ghost = document.createElement('div'); ghost.className = 'ghost';
  const picker = document.createElement('div'); picker.className = 'picker';
  picker.innerHTML = '<div class="pk-h"><span>Fill</span><span>Solid</span></div><div class="pk-sq"><i class="pk-dot"></i></div><div class="pk-hue"><i class="pk-thumb"></i></div><div class="pk-row"><i class="pk-sw"></i><span class="pk-hex"></span><span>100%</span></div>';
  ov.prepend(sel); ov.append(picker, ghost, el);
  return {
    name, color, from, el, sel, ghost, picker,
    badge: $('.badge', sel), chat: $('.chat', el),
    pk: { dot: $('.pk-dot', picker), thumb: $('.pk-thumb', picker), sw: $('.pk-sw', picker), hex: $('.pk-hex', picker) },
    ph: i * 1.7 + .5, sp: .8 + i * .17, wa: 1,
  };
}

class Scene {
  constructor(cfg, index) {
    this.cfg = cfg; this.index = index; this.name = cfg.name; this.rest = cfg.rest; this.buildMs = cfg.build;
    this.root = document.getElementById(cfg.id);
    this.stage = $('.stage', this.root);
    this.canvas = $('.canvas', this.root);
    this.frame = $('.frame', this.root);
    this.hint = $('.hint', this.root);
    this.pub = $('.pub', this.root);
    this.label = $('.frame-label', this.root);
    this.xEls = $$('[data-x]', this.root);
    this.xEls.forEach(el => { if (el.tagName !== 'A') { el.setAttribute('role', 'button'); el.tabIndex = -1; } });
    this.inputs = $$('input', this.root);

    const ov = document.createElement('div');
    ov.className = 'overlay';
    this.canvas.appendChild(ov);
    this.cursors = {};
    Object.entries(cfg.from).forEach(([n, from], i) => { this.cursors[n] = makeCursor(ov, n, from, i); });

    const raw = cfg.steps.slice();
    if (cfg.exit) Object.entries(cfg.exit.to).forEach(([n, at], i) => raw.push([n, 'goto', null, cfg.exit.a + i * .015, cfg.exit.b, { at }]));
    this.steps = raw.map(r => this.makeStep(r));
    for (const c of Object.values(this.cursors)) {
      c.steps = this.steps.filter(s => s.cur === c).sort((a, b) => a.a - b.a);
      c.path = c.steps.filter(s => s.positional);
      c.chats = c.steps.filter(s => s.act === 'chat');
    }
    this.born = new Map();
    for (const s of this.steps) if (s.el) this.born.set(s.el, Math.min(this.born.get(s.el) ?? 9, s.a + (s.b - s.a) * s.tv));
    // the frame turns interactive once every visual step is done
    this.liveAt = Math.max(...this.steps.filter(s => s.act !== 'chat' && s.act !== 'goto').map(s => s.b)) + .004;
    this.layers = $$('[data-layer]', this.canvas);
    this.p = -1; this.dir = 1; this.ready = false; this.live = false; this.now = 0;
  }

  makeStep([c, act, id, a, b, o = {}]) {
    const st = { c, act, a, b, o, cur: this.cursors[c], el: id ? document.getElementById(id) : null, t: 0, u: 0, lh: 20 };
    if (id && !st.el) console.warn('missing element', id);
    st.tv = o.tv ?? TV[act];
    st.positional = act !== 'chat';
    st.r = () => { const el = st.el, r = el._r; return el._text ? { x: r.x, y: r.y, w: el.offsetWidth, h: el.offsetHeight } : r; };
    ACT[act].init?.(st, this);
    return st;
  }

  layout() {
    for (const el of this.layers) el._r = rectOf(el, this.canvas);
    if (this.pub) this.pub._r = rectOf(this.pub, this.canvas);
    for (const st of this.steps) {
      if (st.act === 'type' || st.act === 'count') {
        const cs = getComputedStyle(st.el);
        st.lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.2;
      }
    }
  }

  cursorPos(cur, p) {
    let prev = S2(cur.from);
    for (const st of cur.path) {
      if (p < st.a) return { pt: prev, busy: false };
      const A = ACT[st.act];
      if (p <= st.b) {
        const t = (p - st.a) / (st.b - st.a);
        if (st.tv >= 1 || t < st.tv) return { pt: lerp2(prev, A.start(st), ease(st.tv >= 1 ? t : t / st.tv)), busy: true };
        const u = (t - st.tv) / (1 - st.tv);
        return { pt: A.pos(st, u), busy: true, down: DOWN[st.act] && u > 0 && u < 1 };
      }
      prev = A.pos(st, 1);
    }
    return { pt: prev, busy: false };
  }

  onFire(name, on) {
    if (name !== 'publish') return;
    tog(this.root, 'published', on);
    this.pubAt = on && this.ready && this.dir > 0 ? performance.now() : 0;
    if (this.pubAt) confettiAt(this.pub);
  }

  update(p, time) {
    this.dir = p > this.p ? 1 : p < this.p ? -1 : this.dir;
    this.p = p; this.now = time;
    for (const st of this.steps) {
      const t = clamp((p - st.a) / (st.b - st.a));
      st.t = t;
      st.u = st.tv >= 1 ? 0 : clamp((t - st.tv) / (1 - st.tv));
    }
    for (const st of this.steps) ACT[st.act].apply?.(st, this);

    const live = p >= this.liveAt;
    if (live !== this.live) {
      this.live = live;
      tog(this.root, 'live', live);
      this.xEls.forEach(el => { if (el.tagName !== 'A') el.tabIndex = live ? 0 : -1; });
      this.inputs.forEach(el => { el.tabIndex = live ? 0 : -1; });
    }
    if (this.hint) css(this.hint, 'opacity', (1 - smooth(0, .035, p)).toFixed(3));

    let focus = null;
    const gs = MOBILE ? .7 : 1;
    for (const cur of Object.values(this.cursors)) {
      // position
      const cp = this.cursorPos(cur, p);
      cur.wa += ((cp.busy ? 0 : 1) - cur.wa) * .08;
      const x = cp.pt[0] + Math.sin(time * .0012 * cur.sp + cur.ph) * 6 * cur.wa;
      const y = cp.pt[1] + Math.cos(time * .0009 * cur.sp + cur.ph * 1.3) * 5 * cur.wa;
      cur.busy = cp.busy;
      const out = Math.max(0, -x, x - W, -y, y - H);
      const op = 1 - clamp((out - 20) / 100);
      css(cur.el, 'transform', `translate3d(${x.toFixed(2)}px,${y.toFixed(2)}px,0) scale(${INV.toFixed(4)})`);
      css(cur.el, 'opacity', op.toFixed(3));
      tog(cur.el, 'down', !!cp.down);

      // selection box
      let sst = null;
      for (const st of cur.steps) if (ACT[st.act].sel && st.u > 0 && p <= st.b + HOLD && (!sst || st.a > sst.a)) sst = st;
      const sel = sst && ACT[sst.act].sel(sst);
      cur.selEl = sel ? sst.el : null;
      if (sel) {
        css(cur.sel, 'display', 'block');
        css(cur.sel, 'transform', `translate(${sel.x.toFixed(2)}px,${sel.y.toFixed(2)}px)`);
        css(cur.sel, 'width', sel.w.toFixed(2) + 'px');
        css(cur.sel, 'height', sel.h.toFixed(2) + 'px');
        tog(cur.sel, 'sized', !!sel.badge);
        if (sel.badge) txt(cur.badge, sel.badge);
        if (!focus || sst.a > focus.st.a) focus = { st: sst, sel };
      } else css(cur.sel, 'display', 'none');

      // dragged image
      const dst = cur.steps.find(s => s.act === 'drop' && s.u > 0 && s.u < 1);
      const g = cur.ghost;
      if (dst) {
        if (g._for !== dst) { g._for = dst; g.innerHTML = `<img src="${esc($('img', dst.el).getAttribute('src'))}" alt="">`; }
        const r = dst.r(), u = dst.u;
        let gx, gy, gw, gh, rot;
        if (u < .72) { gw = 170 * gs; gh = 118 * gs; gx = x + 14; gy = y + 20; rot = -6; }
        else { const k = ease((u - .72) / .28); gw = lerp(170 * gs, r.w, k); gh = lerp(118 * gs, r.h, k); gx = lerp(x + 14, r.x, k); gy = lerp(y + 20, r.y, k); rot = lerp(-6, 0, k); }
        css(g, 'display', 'block');
        css(g, 'width', gw.toFixed(1) + 'px');
        css(g, 'height', gh.toFixed(1) + 'px');
        css(g, 'transform', `translate(${gx.toFixed(2)}px,${gy.toFixed(2)}px) rotate(${rot.toFixed(2)}deg)`);
        css(g, 'opacity', ((1 - smooth(.88, 1, u)) * op).toFixed(3));
      } else css(g, 'display', 'none');

      // colour picker
      const fst = cur.steps.find(s => s.act === 'fill' && s.u > 0 && (s.u < 1 || p <= s.b + HOLD));
      const pk = cur.picker;
      if (fst) {
        const pp = fst.pk(), k = ease(clamp((fst.u - .18) / .62));
        css(pk, 'display', 'block');
        css(pk, 'transform', `translate(${pp.x.toFixed(1)}px,${pp.y.toFixed(1)}px)`);
        css(pk, 'opacity', (1 - clamp((p - fst.b) / HOLD)).toFixed(3));
        cssv(pk, '--hue', fst.hue.toFixed(1));
        css(cur.pk.dot, 'left', (lerp(.04, fst.d[0], k) * 100).toFixed(2) + '%');
        css(cur.pk.dot, 'top', (lerp(.04, fst.d[1], k) * 100).toFixed(2) + '%');
        css(cur.pk.thumb, 'left', (fst.hue / 360 * 100).toFixed(2) + '%');
        const col = rgbHex(fst.c0.map((v, i) => lerp(v, fst.c1[i], k)));
        css(cur.pk.sw, 'background', col);
        txt(cur.pk.hex, col.slice(1));
      } else css(pk, 'display', 'none');

      // cursor chat
      const cst = cur.chats.find(s => s.t > 0 && s.t < 1);
      tog(cur.el, 'chatting', !!cst);
      if (cst) {
        const chars = cst._chars || (cst._chars = Array.from(cst.o.msg));
        txt(cur.chat, chars.slice(0, Math.ceil(chars.length * clamp(cst.t / .4))).join(''));
        css(cur.chat, 'opacity', (1 - smooth(.86, 1, cst.t)).toFixed(3));
      }
    }
    this.focus = focus;
    this.ready = true;
  }
}

/* ---------------- confetti ---------------- */
const cv = $('#confetti'), cx = cv.getContext('2d');
let parts = [], confettiOn = false;
function sizeConfetti() { const d = devicePixelRatio || 1; cv.width = innerWidth * d; cv.height = innerHeight * d; cx.setTransform(d, 0, 0, d, 0, 0); }
function confettiAt(el, count = 180) { const b = el.getBoundingClientRect(); confetti(b.left + b.width / 2, b.top + b.height / 2, count); }
function confetti(x, y, count = 180) {
  if (REDUCED) return;
  const cols = ['#F24E1E', '#0D99FF', '#14AE5C', '#9747FF', '#FFC700', '#F6F1E9', '#D2693C'];
  for (let i = 0; i < count; i++) {
    const a = Math.random() * Math.PI * 2, v = 4 + Math.random() * 11;
    parts.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 7, w: 5 + Math.random() * 7, h: 3 + Math.random() * 6, r: Math.random() * 6, vr: (Math.random() - .5) * .35, c: cols[i % cols.length], life: 0 });
  }
  if (!confettiOn) { confettiOn = true; requestAnimationFrame(drawConfetti); }
}
function drawConfetti() {
  cx.clearRect(0, 0, innerWidth, innerHeight);
  parts = parts.filter(q => q.y < innerHeight + 40 && q.life < 260);
  for (const q of parts) {
    q.life++; q.vy += .32; q.vx *= .985; q.vy *= .985; q.x += q.vx; q.y += q.vy; q.r += q.vr;
    cx.save(); cx.translate(q.x, q.y); cx.rotate(q.r); cx.scale(1, Math.cos(q.life * .15));
    cx.fillStyle = q.c; cx.fillRect(-q.w / 2, -q.h / 2, q.w, q.h); cx.restore();
  }
  if (parts.length) requestAnimationFrame(drawConfetti);
  else { confettiOn = false; cx.clearRect(0, 0, innerWidth, innerHeight); }
}

/* ---------------- editor chrome ---------------- */
const LIC = {
  frame: '<svg viewBox="0 0 12 12"><path d="M3.5 1v10M8.5 1v10M1 3.5h10M1 8.5h10" stroke="currentColor" fill="none"/></svg>',
  text: '<svg viewBox="0 0 12 12"><path d="M2 2.5h8M6 2.5V10.5" stroke="currentColor" stroke-width="1.4" fill="none"/></svg>',
  image: '<svg viewBox="0 0 12 12"><rect x="1" y="1.5" width="10" height="9" rx="1" stroke="currentColor" fill="none"/><path d="M1.5 9l3-3 2 2 1.5-1.5 2.5 2.5" stroke="currentColor" fill="none"/></svg>',
  rect: '<svg viewBox="0 0 12 12"><rect x="1.5" y="1.5" width="9" height="9" rx="1" stroke="currentColor" fill="none"/></svg>',
  ellipse: '<svg viewBox="0 0 12 12"><circle cx="6" cy="6" r="4.5" stroke="currentColor" fill="none"/></svg>',
};
const ui = {
  tools: $$('.tool'), avs: $('#avs'), zoom: $('#zoom'), frames: $('#frames'), layers: $('#layers'), layersOf: $('#layers-of'),
  pn: { ic: $('#pn-ic'), name: $('#pn-name'), edit: $('#pn-edit'), x: $('#pn-x'), y: $('#pn-y'), w: $('#pn-w'), h: $('#pn-h'), sw: $('#pn-sw'), fill: $('#pn-fill'), type: $('#pn-type'), font: $('#pn-font'), size: $('#pn-size'), lh: $('#pn-lh') },
  status: $('#status-t'), bar: $('#status-bar'), toast: $('#toast'), prev: $('#nav-prev'), next: $('#nav-next'),
  panelL: $('.panel.left'), panelR: $('.panel.right'),
};
ui.avMap = {};
for (const [n, c] of Object.entries(PEOPLE)) {
  const a = document.createElement('span');
  a.className = 'av'; a.style.setProperty('--c', c); a.textContent = n[0]; a.title = n;
  ui.avs.appendChild(a); ui.avMap[n] = a;
}

const scenes = SCENES.map((c, i) => new Scene(c, i));
const sceneById = Object.fromEntries(scenes.map(s => [s.cfg.id, s]));
scenes.forEach(sc => { sc.labelBase = sc.label.firstChild.nodeValue; });

scenes.forEach((sc, i) => {
  const d = document.createElement('button');
  d.type = 'button'; d.className = 'fr';
  d.innerHTML = `${LIC.frame}<span></span><span class="ck">✓</span>`;
  d.children[1].textContent = sc.name;
  d.addEventListener('click', () => playTo(i + 1));
  ui.frames.appendChild(d);
  sc.frItem = d;
});

let layerScene = null;
function buildLayers(sc) {
  layerScene = sc;
  ui.layers.innerHTML = '';
  txt(ui.layersOf, sc ? '· ' + sc.name : '');
  if (!sc) return;
  sc.layerItems = sc.layers.map(el => {
    let d = 0;
    for (let n = el.parentElement; n && n !== sc.canvas; n = n.parentElement) if (n.dataset && n.dataset.layer) d++;
    const li = document.createElement('div');
    li.className = 'layer';
    li.style.paddingLeft = (12 + d * 16) + 'px';
    li.innerHTML = `<span class="ic">${LIC[el.dataset.kind] || LIC.rect}</span><span class="nm"></span><i class="who"></i>`;
    li.querySelector('.nm').textContent = el.dataset.layer;
    ui.layers.appendChild(li);
    return { el, li, born: sc.born.get(el) ?? 0 };
  });
}

const WEIGHTS = { 400: 'Regular', 500: 'Medium', 600: 'Semi Bold', 700: 'Bold' };
let lastFocusKey = '';
function updateChrome(sc) {
  if (sc !== layerScene) buildLayers(sc);
  scenes.forEach(s => { tog(s.frItem, 'on', s === sc); tog(s.frItem, 'built', s.p >= s.liveAt); });

  const active = new Map();
  if (sc) for (const c of Object.values(sc.cursors)) if (c.selEl) active.set(c.selEl, c.color);
  if (sc && sc.layerItems) for (const L of sc.layerItems) {
    tog(L.li, 'show', sc.p >= L.born);
    const col = active.get(L.el);
    tog(L.li, 'active', !!col);
    if (col) cssv(L.li, '--ac', col);
  }

  for (const [n, a] of Object.entries(ui.avMap)) tog(a, 'busy', !!(sc && sc.cursors[n] && sc.cursors[n].busy));

  let tool = 'move';
  const f = sc && sc.focus;
  if (f) {
    const a = f.st.act;
    tool = a === 'draw' ? (f.st.el.classList.contains('frame') ? 'frame' : 'rect') : a === 'type' || a === 'count' ? 'text' : a === 'drop' ? 'image' : 'move';
  } else if (sc && Object.values(sc.cursors).some(c => c.chats.some(s => s.t > 0 && s.t < 1))) tool = 'comment';
  ui.tools.forEach(t => tog(t, 'on', t.dataset.tool === tool));

  if (ui.panelR.offsetWidth) updateDesignPanel(sc);

  // status pill
  const last = D.stops.length - 1, at = nearestStop();
  let msg;
  if (D.tw) {
    if (D.tw.dir < 0) msg = 'Rewinding…';
    else if (sc) msg = `Building ${sc.name} · ${Math.round(clamp(sc.p / sc.rest) * 100)}%`;
    else msg = 'Wrapping up…';
    if (D.rate > 1) msg += ` · ⏩ ${D.rate.toFixed(1).replace('.0', '')}×`;
  } else if (at === 0 && Math.abs(scrollY - D.stops[0].y) < 4) msg = 'Scroll once to start building';
  else if (at === last && Math.abs(scrollY - D.stops[last].y) < 4) msg = '✓ All 5 frames shipped';
  else if (sc && sc.live) msg = innerWidth < 560 ? `✓ ${sc.name} is live` : `✓ ${sc.name} is live — try the buttons`;
  else if (sc) msg = `${sc.name} · ${Math.round(clamp(sc.p / sc.rest) * 100)}%`;
  else msg = 'Scroll to continue';
  txt(ui.status, msg);
  css(ui.bar, 'width', (sc ? Math.round(clamp(sc.p / sc.rest) * 100) : 100) + '%');
  ui.prev.disabled = !D.tw && scrollY <= D.stops[0].y + 4;
  ui.next.disabled = !D.tw && scrollY >= D.stops[last].y - 4;
  tog(ui.next, 'nudge', !D.tw && !ui.next.disabled);

  const launch = scenes[scenes.length - 1];
  tog(ui.toast, 'show', sc === launch && !!launch.pubAt && performance.now() - launch.pubAt < 5000);
}

function updateDesignPanel(sc) {
  const P = ui.pn;
  let el = null, r = null, who = null;
  if (sc && sc.focus) { el = sc.focus.st.el; r = sc.focus.sel; who = sc.focus.st.cur; }
  else if (sc && sc.p > .14) { el = sc.frame; r = sc.frame._r; }
  if (!el) {
    if (lastFocusKey === '') return;
    txt(P.name, 'Nothing selected'); P.ic.innerHTML = ''; P.edit.innerHTML = '';
    ['x', 'y', 'w', 'h', 'fill', 'font', 'size', 'lh'].forEach(k => txt(P[k], '–'));
    tog(P.type, 'off', true);
    lastFocusKey = '';
    return;
  }
  const fr = sc.frame._r, isFrame = el === sc.frame;
  txt(P.x, String(Math.round(isFrame ? 0 : r.x - fr.x)));
  txt(P.y, String(Math.round(isFrame ? sc.index * (H + 20) : r.y - fr.y)));
  txt(P.w, String(Math.round(r.w)));
  txt(P.h, String(Math.round(r.h)));

  const kind = el.dataset.kind || 'rect';
  const fl = $(':scope > .fill', el);
  const key = el.id + (who ? who.name : '') + (fl ? (+getComputedStyle(fl).opacity > .5) : '');
  if (key === lastFocusKey) return;
  lastFocusKey = key;

  txt(P.name, el.dataset.layer);
  P.ic.innerHTML = LIC[kind] || LIC.rect;
  P.edit.innerHTML = who ? `<i style="--c:${who.color}">${who.name[0]}</i>${who.name} is editing` : '';
  const cs = getComputedStyle(el);
  let fill, sw;
  if (kind === 'image') { fill = 'Image'; sw = 'linear-gradient(135deg,#8DB6CD,#45667A)'; }
  else if (kind === 'text') { fill = rgbStrHex(cs.color); sw = cs.color; }
  else if (fl && +getComputedStyle(fl).opacity > .5) { const c = getComputedStyle(fl).backgroundColor; fill = rgbStrHex(c); sw = c; }
  else if (cs.backgroundImage !== 'none') { fill = 'Linear'; sw = cs.backgroundImage; }
  else { const c = cs.backgroundColor; fill = c === 'rgba(0, 0, 0, 0)' ? 'None' : rgbStrHex(c); sw = c; }
  txt(P.fill, fill); P.sw.style.background = sw;
  if (kind === 'text') {
    tog(P.type, 'off', false);
    txt(P.font, cs.fontFamily.split(',')[0].replace(/["']/g, '') + ' · ' + (WEIGHTS[cs.fontWeight] || cs.fontWeight));
    txt(P.size, String(Math.round(parseFloat(cs.fontSize))));
    txt(P.lh, cs.lineHeight === 'normal' ? 'Auto' : String(Math.round(parseFloat(cs.lineHeight))));
  } else {
    tog(P.type, 'off', true);
    ['font', 'size', 'lh'].forEach(k => txt(P[k], '–'));
  }
}

/* ---------------- desktop ↔ mobile canvas ---------------- */
const mEls = $$('[data-m]');
mEls.forEach(el => { el._base = el.getAttribute('style') || ''; });
function applyMode(m) {
  MOBILE = m; W = m ? 400 : 1280; H = m ? 820 : 800;
  document.body.classList.toggle('mobile', m);
  for (const el of mEls) { el.setAttribute('style', el._base + (m ? ';' + el.dataset.m : '')); el._c = {}; el._k = null; }
  for (const sc of scenes) {
    sc.canvas.style.width = W + 'px';
    sc.canvas.style.height = H + 'px';
    sc.label.firstChild.nodeValue = sc.labelBase.replace('Desktop', m ? 'Mobile' : 'Desktop');
    for (const st of sc.steps) { if (st.act === 'type') { ACT.type.parse(st); st.el._k = null; } }
    sc.p = -1;
  }
}

/* ---------------- layout + render loop ---------------- */
let vh = innerHeight;
const outro = $('#outro');
function layout() {
  const vw = innerWidth; vh = innerHeight;
  const m = vw / Math.max(1, vh - 48) < .9;
  if (m !== MOBILE || !layout.done) applyMode(m);
  layout.done = true;
  const L = ui.panelL.offsetWidth || 0;
  const R = ui.panelR.offsetWidth || 0;
  // zoom to the website frame (plus its label / publish row), not the whole canvas
  const V = MOBILE ? { x: 8, y: 2, w: 384, h: 806 } : { x: 28, y: 14, w: 1224, h: 752 };
  const T = 48, pad = vw < 760 ? 4 : 10;
  const aw = vw - L - R - pad * 2, ah = vh - T - pad * 2;
  S = Math.min(aw / V.w, ah / V.h); INV = 1 / S;
  const ox = L + pad + (aw - V.w * S) / 2 - V.x * S, oy = T + pad + (ah - V.h * S) / 2 - V.y * S;
  for (const sc of scenes) {
    sc.canvas.style.transform = `translate(${ox.toFixed(1)}px,${oy.toFixed(1)}px) scale(${S.toFixed(5)})`;
    sc.canvas.style.setProperty('--inv', INV.toFixed(4));
    sc.top = sc.root.offsetTop;
    sc.h = sc.root.offsetHeight;
    sc.stage.style.backgroundPosition = `${ox.toFixed(1)}px ${(-(sc.index * vh) % 22).toFixed(1)}px`;
    sc.layout();
  }
  txt(ui.zoom, Math.round(S * 100) + '%');
  sizeConfetti();
  buildStops();
}

/* ---------------- the director: one gesture → play to the next stop ---------------- */
const D = { stops: [], tw: null, rate: 1, lastWheel: 0 };
function buildStops() {
  const maxY = document.documentElement.scrollHeight - vh;
  D.stops = [{ y: scenes[0].top, sc: null }];
  scenes.forEach(sc => D.stops.push({ y: Math.round(sc.top + (sc.h - vh) * sc.rest), sc }));
  D.stops.push({ y: Math.min(outro.offsetTop, maxY), sc: null });
}
function nearestStop(y = scrollY) {
  let best = 0;
  D.stops.forEach((s, i) => { if (Math.abs(s.y - y) < Math.abs(D.stops[best].y - y)) best = i; });
  return best;
}
const nextIdx = y => { const i = D.stops.findIndex(s => s.y > y + 4); return i < 0 ? null : i; };
const prevIdx = y => { let r = null; D.stops.forEach((s, i) => { if (s.y < y - 4) r = i; }); return r; };

function playTo(i, mode) {
  i = clamp(i, 0, D.stops.length - 1);
  const y0 = D.tw ? D.tw.y : scrollY, to = D.stops[i], legs = [];
  const dir = to.y >= y0 ? 1 : -1;
  if (Math.abs(to.y - y0) < 2) { D.tw = null; scrollTo(0, to.y); return; }
  if (!mode) { const n = nextIdx(y0); mode = dir > 0 && n === i ? 'step' : 'fast'; }
  if (REDUCED) legs.push({ y0, y1: to.y, dur: 1, e: t => t });
  else if (mode === 'step' && to.sc) {
    const top = to.sc.top;
    if (y0 < top - 2) legs.push({ y0, y1: top, dur: 750, e: ease });
    const from = Math.max(y0, top);
    legs.push({ y0: from, y1: to.y, dur: to.sc.buildMs * clamp((to.y - from) / Math.max(1, to.y - top), .15, 1), e: easeSine });
  } else if (mode === 'step') {
    legs.push({ y0, y1: to.y, dur: 950, e: ease });
  } else {
    const hops = Math.max(1, Math.abs(i - nearestStop(y0)));
    legs.push({ y0, y1: to.y, dur: clamp(500 + 500 * hops, 900, 2800), e: ease });
  }
  D.tw = { legs, li: 0, t: 0, i, dir, y: y0 };
  D.rate = 1;
}
function advanceTween(dt) {
  const tw = D.tw;
  tw.t += dt * D.rate;
  while (tw.li < tw.legs.length && tw.t >= tw.legs[tw.li].dur) { tw.t -= tw.legs[tw.li].dur; tw.li++; }
  if (tw.li >= tw.legs.length) {
    tw.y = D.stops[tw.i].y;
    D.tw = null; D.rate = 1;
  } else {
    const L = tw.legs[tw.li];
    tw.y = lerp(L.y0, L.y1, L.e(tw.t / L.dur));
  }
  scrollTo(0, tw.y);
  return tw.y;
}
function gesture(dir) {
  if (!modal.hidden) return;
  const y = D.tw ? D.tw.y : scrollY;
  if (D.tw) {
    if (dir === D.tw.dir) { D.rate = Math.min(D.rate * 2.5, 8); return; }  // fast-forward
    const i = dir > 0 ? nextIdx(y) : prevIdx(y);
    if (i != null) playTo(i, 'fast');
    return;
  }
  const i = dir > 0 ? nextIdx(y) : prevIdx(y);
  if (i != null) playTo(i);
}
function goToScene(id) {
  const i = D.stops.findIndex(s => s.sc && s.sc.cfg.id === id);
  if (i >= 0) playTo(i);
}

addEventListener('wheel', e => {
  if (!modal.hidden) { if (!e.target.closest('.m-panel')) e.preventDefault(); return; }
  e.preventDefault();
  const now = performance.now(), gap = now - D.lastWheel;
  D.lastWheel = now;
  if (gap < 220) return;                         // still the same gesture / inertia
  const d = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : 0;
  if (Math.abs(d) < 1) return;
  gesture(Math.sign(d));
}, { passive: false });

let touchY = null;
addEventListener('touchstart', e => { touchY = modal.hidden ? e.touches[0].clientY : null; }, { passive: true });
addEventListener('touchmove', e => {
  if (e.touches.length > 1) return;              // keep pinch-zoom
  if (!modal.hidden) { if (!e.target.closest('.m-panel')) e.preventDefault(); return; }
  e.preventDefault();
}, { passive: false });
addEventListener('touchend', e => {
  if (touchY == null) return;
  const dy = touchY - e.changedTouches[0].clientY;
  touchY = null;
  if (Math.abs(dy) > 36) gesture(Math.sign(dy));
});

let sY = scrollY, lastT = performance.now();
function tick(now) {
  const dt = Math.min(64, now - lastT); lastT = now;
  let target;
  if (D.tw) { target = advanceTween(dt); sY = target; }
  else {
    target = scrollY;
    const k = REDUCED ? 1 : 1 - Math.pow(1 - .11, dt / 16.7);
    sY += (target - sY) * k;
    if (Math.abs(target - sY) < .3) sY = target;
  }
  let current = null;
  const mid = sY + vh * .5;
  for (const sc of scenes) {
    const vis = (target + vh > sc.top && target < sc.top + sc.h) || (sY + vh > sc.top && sY < sc.top + sc.h);
    if (vis || sc.p < 0) sc.update(clamp((sY - sc.top) / (sc.h - vh)), now);
    if (mid >= sc.top && mid < sc.top + sc.h) current = sc;
  }
  updateChrome(current);
  requestAnimationFrame(tick);
}

/* ============================================================
   The working website
   ============================================================ */
const TRIPS = [
  { name: 'Lofoten, Norway', img: 'img/coast.jpg', alt: 'Sea cliffs and turquoise water on a rugged northern coast', nights: 9, price: '€2,450', season: 'Feb–Apr',
    text: 'Red fishing cabins on stilts, a slow coastal ferry and evenings that never quite end. We pace it for the weather, not for a checklist.',
    list: ['Rorbu cabin on the water, five nights', 'A leg on the coastal ferry from Bodø', 'Guided ridge walk above Reine', 'An aurora night with a local photographer'] },
  { name: 'Hokkaido, Japan', img: 'img/falls.jpg', alt: 'A waterfall pouring into a mossy green forest valley', nights: 12, price: '€3,180', season: 'May–Jun',
    text: 'Onsen towns, family-run ryokan and long local trains through forests that feel untouched.',
    list: ['Three ryokan, each with its own hot spring', 'Rail pass on the slow local lines', 'A cooking evening with your hosts', 'Day hike in Daisetsuzan'] },
  { name: 'Dolomites, Italy', img: 'img/alps.jpg', alt: 'Green alpine slopes under a cloudy sky', nights: 9, price: '€2,690', season: 'Jun–Sep',
    text: 'Hut-to-hut walking with your bag sent ahead, and a working farm at either end.',
    list: ['Four mountain rifugi, luggage transferred', 'Two nights on a farm near Bolzano', 'An easy via ferrata with a guide', 'By train from Verona — no car needed'] },
  { name: 'Patagonia, Chile', img: 'img/peaks.jpg', alt: 'A tent pitched in snow below jagged mountain peaks', nights: 14, price: '€4,350', season: 'Nov–Mar',
    text: 'Wind, granite and a great deal of sky. Camps and estancias, with days built around the weather window.',
    list: ['The W Trek with a small-group guide', 'Two nights at a family estancia', 'A fjord crossing to Puerto Natales', 'Spare days for when the wind says no'] },
];
const FILM = [
  { img: 'img/fjord.jpg', k: 'Norway', t: 'Mornings start late up here.' },
  { img: 'img/coast.jpg', k: 'Lofoten', t: 'The sea decides the plan.' },
  { img: 'img/falls.jpg', k: 'Hokkaido', t: 'Walk until the forest goes quiet.' },
  { img: 'img/alps.jpg', k: 'Dolomites', t: 'Hut to hut, bag sent ahead.' },
  { img: 'img/peaks.jpg', k: 'Patagonia', t: 'Wait for the window.' },
  { img: 'img/lake.jpg', k: 'Anywhere', t: 'Arrive. Actually arrive.' },
  { img: 'img/road.jpg', k: 'Driftwood', t: 'Slow travel, beautifully planned.' },
];
const INFO = {
  routes: { k: 'Promise 01', t: 'Unhurried _routes_', p: 'We never book a single night anywhere. Two is the floor, three is better — long enough for a place to stop being a destination and start being somewhere you live for a while.',
    list: ['Minimum two nights at every stop', 'Rail and ferry first; flights only when there’s no sane alternative', 'Free mornings built into every itinerary'] },
  hosts: { k: 'Promise 02', t: 'Hosts, not _hotels_', p: 'Every cabin, ryokan and farmhouse we book is one someone on our team has slept in. Most are family-run, and most hosts have been with us for years.',
    list: ['Stays under 20 rooms, nearly always', 'We pay hosts fairly and on time', 'A short note from your host before you arrive'] },
  concierge: { k: 'Promise 03', t: 'A quiet _concierge_', p: 'One named person plans your trip and stays on call for the whole of it. Missed train? Message them; they fix it while you get a coffee.',
    list: ['One human from first idea to the trip home', 'Reachable by message, 7am–11pm local time', 'No app to install, no daily itinerary emails'] },
  careers: { k: 'Careers', t: 'Come plan _slowly_ with us', p: 'We’re a team of eleven spread between Bergen, Lisbon and Kyoto. Right now we’re hoping to meet:',
    list: ['Trip Designer — Japan (remote, Japanese speaker)', 'Trip Designer — Alps (Bolzano or remote)', 'Field Scout — part-time, a lot of walking'] },
  contact: { k: 'Contact', t: 'Say _hello_', p: 'Questions about a trip, a host you love, or just the weather in Lofoten — we read everything and reply within one working day.',
    list: ['hello@driftwood.example', 'Studios in Bergen, Lisbon and Kyoto', 'Weekdays, 9:00–17:00 CET'] },
};
const QUOTES = [
  { q: '“We came home slower,|quieter — and somehow|more like _ourselves._”', n: 'Amara Okafor', m: 'Lofoten in winter · 9 nights', ini: 'AO', img: 'img/hiker.jpg', alt: 'A hiker with a backpack looking over a misty valley at sunrise' },
  { q: '“Nine days, two trains,|zero alarms. I didn’t|check email _once._”', n: 'Jonas Weber', m: 'Dolomites in autumn · 9 nights', ini: 'JW', img: 'img/ridge.jpg', alt: 'A grassy ridge trail curving over green hills' },
  { q: '“Our host taught us|to fold dumplings. We|still make them _Sundays._”', n: 'Priya & Sam', m: 'Hokkaido in spring · 12 nights', ini: 'PS', img: 'img/river.jpg', alt: 'A person standing by a rocky river in a misty forest' },
];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/* ---------- modal ---------- */
const modal = $('#modal'), mPanel = $('.m-panel', modal), mBody = $('#m-body');
let lastFocus = null, tripIdx = 0;
const film = { i: 0, t: 0, paused: false, raf: 0, last: 0 };

const TPL = {
  plan(dest) {
    const dests = [...TRIPS.map(t => t.name), 'Surprise me'];
    const pick = dests.includes(dest) ? dest : dests[0];
    const mNow = (new Date().getMonth() + 2) % 12;
    return `<p class="m-k">Plan a trip</p>
<h2 class="m-title" id="m-title">Tell us the <em>shape</em> of it.</h2>
<p class="m-sub">A real person replies within a day with a draft route. No payment, no obligation.</p>
<form class="pf" id="plan-form" novalidate>
  <label>Where to?<select name="dest">${dests.map(d => `<option${d === pick ? ' selected' : ''}>${esc(d)}</option>`).join('')}</select></label>
  <div class="row2">
    <label>When<select name="month">${MONTHS.map((m, i) => `<option${i === mNow ? ' selected' : ''}>${m}</option>`).join('')}</select></label>
    <div class="lab"><label for="pf-n" style="display:block;margin-bottom:6px">Travellers</label><div class="stepper"><button type="button" data-step="-1" aria-label="Fewer travellers">−</button><output id="pf-n" name="n" aria-live="polite">2</output><button type="button" data-step="1" aria-label="More travellers">+</button></div></div>
  </div>
  <div class="row2">
    <label>Your name<input name="name" autocomplete="name" required></label>
    <label>Email<input name="email" type="email" autocomplete="email" required></label>
  </div>
  <label class="chk"><input type="checkbox" name="slow" checked> Trains over planes where possible</label>
  <p class="pf-err" role="alert"></p>
  <div class="m-actions"><button class="m-btn" type="submit">Send request →</button></div>
</form>`;
  },
  trip(i) {
    const t = TRIPS[i];
    return `<div class="trip-grid">
  <div class="trip-img"><img src="${t.img}" alt="${esc(t.alt)}"><div class="trip-nav"><button type="button" data-trip="-1" aria-label="Previous journey">←</button><button type="button" data-trip="1" aria-label="Next journey">→</button></div></div>
  <div class="trip-copy">
    <p class="m-k">Journey ${i + 1} of ${TRIPS.length}</p>
    <h2 class="m-title" id="m-title">${esc(t.name)}</h2>
    <div class="trip-facts"><div><b>${t.nights}</b>nights</div><div><b>${t.price}</b>per person, from</div><div><b>${t.season}</b>best season</div></div>
    <p class="m-text">${esc(t.text)}</p>
    <ul class="m-list">${t.list.map(l => `<li>${esc(l)}</li>`).join('')}</ul>
    <div class="m-actions"><button class="m-btn" type="button" data-plan="${esc(t.name)}">Plan this trip →</button></div>
  </div>
</div>`;
  },
  film() {
    return `<div class="film-stage" id="film-stage">
  ${FILM.map((f, i) => `<img src="${f.img}" alt="" data-i="${i}">`).join('')}
  <div class="film-shade"></div>
  <div class="film-bars">${FILM.map(() => '<i><b></b></i>').join('')}</div>
  <div class="film-cap"><p class="m-k" id="film-k"></p><h3 id="m-title"></h3></div>
  <div class="film-ctl"><button type="button" data-film="-1" aria-label="Previous scene">←</button><button type="button" data-film="pause" aria-label="Pause">❚❚</button><button type="button" data-film="1" aria-label="Next scene">→</button></div>
</div>`;
  },
  info(key) {
    const d = INFO[key] || INFO.contact;
    return `<p class="m-k">${esc(d.k)}</p>
<h2 class="m-title" id="m-title">${emph(d.t)}</h2>
<p class="m-text">${esc(d.p)}</p>
<ul class="m-list">${d.list.map(l => `<li>${esc(l)}</li>`).join('')}</ul>
<div class="m-actions"><button class="m-btn" type="button" data-plan="">Plan a trip →</button><button class="m-btn ghost-btn" type="button" data-close>Close</button></div>`;
  },
};

function openModal(kind, arg) {
  if (modal.hidden) lastFocus = document.activeElement;
  stopFilm();
  mPanel.className = 'm-panel' + (kind === 'trip' ? ' trip' : kind === 'film' ? ' film' : '');
  if (kind === 'trip') tripIdx = +arg || 0;
  mBody.innerHTML = TPL[kind](kind === 'trip' ? tripIdx : arg);
  modal.hidden = false;
  if (kind === 'plan') wirePlan();
  if (kind === 'film') startFilm();
  const first = mBody.querySelector('input[name="name"]') || mPanel;
  first.focus({ preventScroll: true });
}
function closeModal() {
  if (modal.hidden) return;
  stopFilm();
  modal.hidden = true;
  mBody.innerHTML = '';
  if (lastFocus && lastFocus.focus) lastFocus.focus({ preventScroll: true });
}

function wirePlan() {
  const form = $('#plan-form'), out = $('output', form), err = $('.pf-err', form);
  let n = 2;
  form.addEventListener('click', e => {
    const b = e.target.closest('[data-step]');
    if (b) { n = clamp(n + +b.dataset.step, 1, 12); out.textContent = n; }
  });
  form.addEventListener('submit', e => {
    e.preventDefault();
    const F = form.elements, fName = F.namedItem('name'), fMail = F.namedItem('email');
    const name = fName.value.trim(), email = fMail.value.trim();
    fName.setAttribute('aria-invalid', !name);
    const okMail = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);
    fMail.setAttribute('aria-invalid', !okMail);
    if (!name) { err.textContent = 'What should we call you?'; fName.focus(); return; }
    if (!okMail) { err.textContent = 'That email doesn’t look quite right.'; fMail.focus(); return; }
    const dest = F.namedItem('dest').value, month = F.namedItem('month').value;
    mBody.innerHTML = `<div class="done"><div class="tick">✓</div>
<h2 class="m-title" id="m-title">Request sent</h2>
<p class="m-sub">Thanks, ${esc(name)}. We’ll sketch ${dest === 'Surprise me' ? 'a surprise route' : 'a route for <b>' + esc(dest) + '</b>'} for ${n} traveller${n > 1 ? 's' : ''} in ${esc(month)} and write to <b>${esc(email)}</b> within a day.</p>
<p class="m-sub" style="font-size:12.5px;opacity:.7">(Demo site — nothing was actually sent.)</p>
<div class="m-actions"><button class="m-btn dark" type="button" data-close>Back to the site</button></div></div>`;
    $('[data-close]', mBody).focus();
    confetti(innerWidth / 2, innerHeight / 2, 120);
  });
}

function showFilm(i) {
  film.i = (i + FILM.length) % FILM.length; film.t = 0;
  const imgs = $$('#film-stage img');
  imgs.forEach((im, k) => { im.classList.remove('on'); if (k === film.i) { void im.offsetWidth; im.classList.add('on'); } });
  $('#film-k').textContent = FILM[film.i].k;
  $('#m-title').textContent = FILM[film.i].t;
  $$('.film-bars b').forEach((b, k) => { b.style.width = k < film.i ? '100%' : '0'; });
}
function startFilm() {
  film.paused = false; film.last = performance.now();
  showFilm(0);
  const loop = now => {
    const dt = now - film.last; film.last = now;
    if (!film.paused) {
      film.t += dt;
      const bar = $$('.film-bars b')[film.i];
      if (bar) bar.style.width = Math.min(100, film.t / 50) + '%';
      if (film.t >= 5000) showFilm(film.i + 1);
    }
    film.raf = requestAnimationFrame(loop);
  };
  film.raf = requestAnimationFrame(loop);
}
function stopFilm() { cancelAnimationFrame(film.raf); film.raf = 0; }

modal.addEventListener('click', e => {
  if (e.target.closest('[data-close]')) return closeModal();
  const tp = e.target.closest('[data-trip]');
  if (tp) return openModal('trip', (tripIdx + +tp.dataset.trip + TRIPS.length) % TRIPS.length);
  const pl = e.target.closest('[data-plan]');
  if (pl) return openModal('plan', pl.dataset.plan);
  const fb = e.target.closest('[data-film]');
  if (fb) {
    if (fb.dataset.film === 'pause') {
      film.paused = !film.paused;
      fb.textContent = film.paused ? '▶' : '❚❚';
      fb.setAttribute('aria-label', film.paused ? 'Play' : 'Pause');
      $('#film-stage').classList.toggle('paused', film.paused);
    } else showFilm(film.i + +fb.dataset.film);
  }
});

/* ---------- newsletter ---------- */
const email = $('#l-email'), inputBox = $('#l-input'), lErr = $('#l-err'), lFrame = $('#launch-frame');
email.addEventListener('input', () => { inputBox.classList.toggle('has', !!email.value); inputBox.classList.remove('bad'); lErr.textContent = ''; });
email.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); subscribe(); } });
function subscribe() {
  const v = email.value.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v)) {
    inputBox.classList.remove('bad'); void inputBox.offsetWidth; inputBox.classList.add('bad');
    lErr.textContent = v ? 'That email looks off — mind checking it?' : 'Pop your email in first.';
    email.focus({ preventScroll: true });
    return;
  }
  lFrame.classList.add('subscribed');
  $('#l-ok span').textContent = `First letter goes to ${v} next month. No noise, promise.`;
  email.blur();
  confettiAt($('#l-ok'), 90);
}

/* ---------- story carousel ---------- */
let qi = 0;
function retype(sc, id, text, ms) {
  const st = sc.steps.find(s => s.el && s.el.id === id && s.act === 'type');
  st.el.dataset.text = text;
  ACT.type.parse(st);
  st.retype = performance.now(); st.retypeMs = ms; st.el._k = null;
}
function setQuote(d) {
  const sc = sceneById.story;
  qi = (qi + d + QUOTES.length) % QUOTES.length;
  const q = QUOTES[qi];
  retype(sc, 's-quote', q.q, 1100);
  retype(sc, 's-name', q.n, 450);
  retype(sc, 's-meta', q.m, 600);
  $('#s-av').textContent = q.ini;
  const img = $('#s-photo img'), photo = $('#s-photo');
  img.src = q.img; img.alt = q.alt;
  photo.classList.remove('swap'); void photo.offsetWidth; photo.classList.add('swap');
}

/* ---------- one handler for every [data-x] on the site ---------- */
function act(x, el) {
  const [kind, a, b] = x.split(':');
  if (kind === 'go') goToScene(a);
  else if (kind === 'open') openModal(a, b);
  else if (kind === 'subscribe') subscribe();
  else if (kind === 'quote') setQuote(+a);
  else if (kind === 'confetti') confettiAt(el);
}
document.addEventListener('click', e => {
  const x = e.target.closest('[data-x]');
  if (!x || modal.contains(x)) return;
  const sc = x.closest('.scene');
  e.preventDefault();
  if (sc && !sc.classList.contains('live')) return;
  act(x.dataset.x, x);
});

addEventListener('keydown', e => {
  if (!modal.hidden) {
    if (e.key === 'Escape') { e.preventDefault(); closeModal(); }
    else if (e.key === 'Tab') {
      const f = $$('button, [href], input, select, [tabindex]:not([tabindex="-1"])', mPanel).filter(n => !n.disabled && n.offsetParent);
      if (!f.length) return;
      if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
      else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
    } else if (mPanel.classList.contains('film') && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) showFilm(film.i + (e.key === 'ArrowRight' ? 1 : -1));
    return;
  }
  const t = e.target;
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
  if ((e.key === 'Enter' || e.key === ' ') && t.dataset && t.dataset.x && t.tagName !== 'A') { e.preventDefault(); t.click(); return; }
  if (e.key === ' ' && t.tagName === 'BUTTON') return;
  if (['ArrowDown', 'PageDown', ' '].includes(e.key)) { e.preventDefault(); gesture(1); }
  else if (['ArrowUp', 'PageUp'].includes(e.key)) { e.preventDefault(); gesture(-1); }
  else if (e.key === 'Home') { e.preventDefault(); playTo(0, 'fast'); }
  else if (e.key === 'End') { e.preventDefault(); playTo(D.stops.length - 1, 'fast'); }
});

ui.prev.addEventListener('click', () => gesture(-1));
ui.next.addEventListener('click', () => gesture(1));
$('#replay').addEventListener('click', () => playTo(0, 'fast'));

/* ---------------- boot ---------------- */
if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
let resizeT = 0;
addEventListener('resize', () => {
  clearTimeout(resizeT);
  resizeT = setTimeout(() => {
    const i = nearestStop();
    layout();
    if (!D.tw) scrollTo(0, D.stops[i].y);
  }, 120);
});
layout();
scrollTo(0, 0);
if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { layout(); });
requestAnimationFrame(tick);
})();
