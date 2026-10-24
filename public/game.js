/*
 * Косынка: всё, что видно на экране, — раскладка карт, перетаскивание,
 * кнопки, таймер, окна, рекорды и цветовые схемы. Правила — в logic.js.
 */
(function () {
  'use strict';

  var S = window.Solitaire;

  // Чтобы добавить схему: блок [data-theme="id"] в style.css + строка здесь.
  var THEMES = [
    { id: 'cyber',   name: 'Киберпанк',    a: '#29e7ff', b: '#ff2fd6' },
    { id: 'matrix',  name: 'Матрица',      a: '#2bff88', b: '#c6ff3a' },
    { id: 'sunset',  name: 'Закат',        a: '#ff8c3a', b: '#ff3d8b' },
    { id: 'ultra',   name: 'Ультрафиолет', a: '#a65cff', b: '#4f7dff' },
    { id: 'classic', name: 'Классика',     a: '#ff4d6d', b: '#dfe6f5' }
  ];
  var MODE_IDS = ['easy', 'medium', 'hard'];
  var STORE = 'kosynka.v1.';
  var reducedMotion = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };

  /* ---------- сохранение в браузере ---------- */

  function load(key, fallback) {
    try {
      var raw = localStorage.getItem(STORE + key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) { return fallback; }
  }
  function save(key, value) {
    try { localStorage.setItem(STORE + key, JSON.stringify(value)); } catch (e) { /* хранилище недоступно — играем без сохранения */ }
  }

  var settings = load('settings', {}) || {};
  if (!THEMES.some(function (t) { return t.id === settings.theme; })) settings.theme = 'cyber';
  if (MODE_IDS.indexOf(settings.mode) < 0) settings.mode = 'easy';
  if (typeof settings.name !== 'string') settings.name = '';

  var records = normalizeRecords(load('records', {}));

  /* ---------- элементы страницы ---------- */

  function $(id) { return document.getElementById(id); }
  var board = $('board');
  var layer = $('cards');
  var stockEl = $('stock');
  var wasteEl = $('waste');
  var foundationEls = Array.prototype.slice.call(document.querySelectorAll('[data-foundation]'));
  var columnEls = Array.prototype.slice.call(document.querySelectorAll('[data-column]'));

  var state = null;
  var cardEls = {};       // id карты → элемент
  var locs = {};          // id карты → где она лежит
  var geo = null;         // последние замеры поля
  var drag = null;
  var lastTap = null;
  var busy = false;       // идёт автосбор
  var winShown = false;
  var gameToken = 0;
  var timer = { elapsed: 0, since: 0, id: 0, paused: false };

  /* ---------- карты ---------- */

  function buildCards() {
    S.makeDeck().forEach(function (c) {
      var el = document.createElement('div');
      el.className = 'card ' + (S.isRed(c) ? 'red' : 'black');
      el.dataset.id = c.id;
      el.setAttribute('role', 'img');
      el.innerHTML =
        '<div class="card-inner">' +
          '<div class="face front">' +
            '<span class="corner"><span>' + S.label(c) + '</span><svg aria-hidden="true"><use href="#suit-' + c.suit + '"/></svg></span>' +
            '<svg class="pip-big" aria-hidden="true"><use href="#suit-' + c.suit + '"/></svg>' +
          '</div>' +
          '<div class="face back"></div>' +
        '</div>';
      el._name = S.cardName(c);
      layer.appendChild(el);
      cardEls[c.id] = el;
    });
  }

  function rel(el, b) {
    var r = el.getBoundingClientRect();
    return { x: r.left - b.left, y: r.top - b.top, w: r.width, h: r.height };
  }

  function measure() {
    var b = board.getBoundingClientRect();
    var stock = rel(stockEl, b);
    return {
      top: b.top + window.scrollY,
      cw: stock.w, ch: stock.h,
      stock: stock,
      waste: rel(wasteEl, b),
      foundations: foundationEls.map(function (el) { return rel(el, b); }),
      columns: columnEls.map(function (el) { return rel(el, b); })
    };
  }

  // Шаги между картами в колонке: если колонка длинная, сжимаем, чтобы влезла в экран.
  function columnSteps(pile, g) {
    var down = g.ch * 0.11, up = g.ch * 0.27;
    var nDown = 0, nUp = 0;
    for (var i = 0; i < pile.length - 1; i++) { if (pile[i].up) nUp++; else nDown++; }
    var need = nDown * down + nUp * up;
    var avail = window.innerHeight - (g.top + g.columns[0].y) - g.ch - 14;
    if (need > avail && need > 0) {
      var k = Math.max(avail, g.ch * 1.2) / need;
      down = Math.max(down * k, g.ch * 0.05);
      up = Math.max(up * k, g.ch * 0.15);
    }
    return { down: down, up: up };
  }

  function translate(x, y) { return 'translate3d(' + x.toFixed(1) + 'px,' + y.toFixed(1) + 'px,0)'; }

  // Расставляет все карты по местам. opts.instant — без подъёма летящих карт, opts.deal — раздача.
  function layout(opts) {
    opts = opts || {};
    var g = geo = measure();
    board.style.setProperty('--cw', g.cw + 'px');
    board.style.setProperty('--ch', g.ch + 'px');
    var z = 1;
    var bottom = g.columns[0].y + g.ch;
    var dealOrder = 0;

    // buried — карта целиком закрыта другими (в колоде, сбросе, основании): без свечения, иначе стопка «светится» в 20 слоёв.
    function place(card, x, y, loc, buried) {
      var el = cardEls[card.id];
      var prev = locs[card.id];
      var changed = prev && (prev.type !== loc.type || prev.index !== loc.index);
      locs[card.id] = loc;
      el._x = x; el._y = y; el._z = z;
      el.classList.toggle('up', card.up);
      el.classList.toggle('buried', !!buried);
      el.setAttribute('aria-label', card.up ? el._name : 'Закрытая карта');
      if (opts.deal && loc.type === 'tableau') {
        el.style.transitionDelay = (dealOrder++ * 28) + 'ms';
        el.classList.add('flying');
      }
      // Летящая карта поднимается над остальными, пока летит.
      // Пока летит, она «прозрачна» для нажатий — иначе быстрый второй клик по колоде попадёт в неё.
      if (changed && !opts.instant) {
        el.style.zIndex = 600 + z;
        el.classList.add('flying');
        clearTimeout(el._lift);
        el._lift = setTimeout(function () { el._lift = 0; el.style.zIndex = el._z; el.classList.remove('flying'); }, 330);
      } else if (!el._lift) {
        el.style.zIndex = z;
      }
      el.style.transform = translate(x, y);
      z++;
    }

    state.stock.forEach(function (c, i) {
      place(c, g.stock.x, g.stock.y, { type: 'stock', index: 0, card: i }, i < state.stock.length - 1);
    });

    var fan = S.MODES[state.mode].draw === 3 ? Math.min(3, state.waste.length) : 1;
    var fanStep = g.cw * 0.27;
    state.waste.forEach(function (c, i) {
      var k = Math.max(0, i - (state.waste.length - fan));
      place(c, g.waste.x + k * fanStep, g.waste.y, { type: 'waste', index: 0, card: i }, i < state.waste.length - fan);
    });

    state.foundations.forEach(function (pile, f) {
      pile.forEach(function (c, i) {
        place(c, g.foundations[f].x, g.foundations[f].y, { type: 'foundation', index: f, card: i }, i < pile.length - 1);
      });
    });

    state.tableau.forEach(function (pile, col) {
      var steps = columnSteps(pile, g);
      var y = g.columns[col].y;
      pile.forEach(function (c, i) {
        place(c, g.columns[col].x, y, { type: 'tableau', index: col, card: i });
        if (i === pile.length - 1) bottom = Math.max(bottom, y + g.ch);
        y += c.up ? steps.up : steps.down;
      });
    });

    board.style.minHeight = Math.ceil(bottom + 6) + 'px';
    markGrabbable();

    if (opts.deal) {
      var token = gameToken;
      setTimeout(function () {
        Object.keys(cardEls).forEach(function (id) {
          var el = cardEls[id];
          el.style.transitionDelay = '';
          if (token === gameToken && !el._lift) el.classList.remove('flying');
        });
      }, 28 * 28 + 400);
    }
  }

  function srcFromLoc(loc) {
    if (loc.type === 'tableau') return { type: 'tableau', index: loc.index, card: loc.card };
    return { type: loc.type, index: loc.index };
  }

  function markGrabbable() {
    Object.keys(cardEls).forEach(function (id) {
      var loc = locs[id], ok = false;
      if (loc && loc.type !== 'stock') {
        var cards = S.getMovable(state, srcFromLoc(loc));
        ok = !!cards && cards[0].id === id;
      }
      cardEls[id].classList.toggle('grab', ok && !state.won);
    });
  }

  /* ---------- новая игра и раздача ---------- */

  function newGame(mode) {
    gameToken++;
    busy = false;
    drag = null;
    winShown = false;
    pendingResult = null;
    clearHighlights();
    board.classList.remove('won');
    stopTimer();
    timer.elapsed = 0;
    timer.paused = false;
    state = S.createGame(mode);

    // Все карты сначала собираются в колоду, потом разлетаются по колонкам.
    geo = measure();
    Object.keys(cardEls).forEach(function (id) {
      var el = cardEls[id];
      clearTimeout(el._lift);
      el._lift = 0;
      el.classList.add('no-anim');
      el.classList.remove('up', 'flying', 'dragging');
      el.style.transform = translate(geo.stock.x, geo.stock.y);
    });
    locs = {};
    void layer.offsetWidth;
    Object.keys(cardEls).forEach(function (id) { cardEls[id].classList.remove('no-anim'); });
    layout({ deal: !reducedMotion.matches });
    updateHud();
  }

  /* ---------- ходы ---------- */

  function afterChange(opts) {
    layout();
    updateHud();
    if (state.won) onWin();
    else if (!(opts && opts.noAuto)) maybeAutoComplete();
  }

  function doMove(src, dst) {
    if (!S.move(state, src, dst)) { layout(); return false; }
    startTimer();
    afterChange();
    return true;
  }

  function doDraw() {
    if (busy || state.won) return;
    var result = S.draw(state);
    if (!result) {
      if (state.waste.length) toast('Проходы по колоде закончились');
      return;
    }
    startTimer();
    afterChange();
  }

  function doUndo() {
    if (busy || !S.canUndo(state)) return;
    S.undo(state);
    clearHighlights();
    afterChange({ noAuto: true });
    if (S.MODES[state.mode].undo === 'penalty') toast('Ход отменён: −' + Math.abs(S.SCORE.undo) + ' очков');
  }

  function toFoundation(src) {
    var f = S.findFoundation(state, src);
    if (f < 0) return false;
    return doMove(src, { type: 'foundation', index: f });
  }

  /* ---------- автосбор ---------- */

  function maybeAutoComplete() {
    if (busy || state.won || !S.canAutoComplete(state)) return;
    busy = true;
    updateHud();
    toast('Все карты открыты — собираю пасьянс');
    var token = gameToken;
    var delay = reducedMotion.matches ? 30 : 110;
    (function step() {
      if (token !== gameToken) return;
      var s = S.autoStep(state);
      if (s && s.draw) S.draw(state, { free: true });
      else if (s) S.move(state, s.src, s.dst);
      layout();
      if (state.won || !s) {
        busy = false;
        updateHud();
        if (state.won) onWin();
        return;
      }
      updateHud();
      setTimeout(step, delay);
    })();
  }

  /* ---------- перетаскивание (мышь и палец) ---------- */

  layer.addEventListener('pointerdown', function (e) {
    if (busy || state.won || drag) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    var el = e.target.closest('.card');
    if (!el) return;
    var loc = locs[el.dataset.id];
    if (!loc) return;
    if (loc.type === 'stock') { e.preventDefault(); doDraw(); return; }

    var src = srcFromLoc(loc);
    var cards = S.getMovable(state, src);
    if (!cards || cards[0].id !== el.dataset.id) return;
    e.preventDefault();

    drag = {
      src: src,
      ids: cards.map(function (c) { return c.id; }),
      pointerId: e.pointerId,
      x0: e.clientX, y0: e.clientY,
      dx: 0, dy: 0,
      started: false,
      targets: []
    };
    try { el.setPointerCapture(e.pointerId); } catch (err) { /* не критично */ }
  });

  document.addEventListener('pointermove', function (e) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    var dx = e.clientX - drag.x0, dy = e.clientY - drag.y0;
    if (!drag.started) {
      if (dx * dx + dy * dy < 36) return;
      startDrag();
    }
    drag.dx = dx; drag.dy = dy;
    drag.ids.forEach(function (id) {
      var el = cardEls[id];
      el.style.transform = translate(el._x + dx, el._y + dy);
    });
  });

  document.addEventListener('pointerup', function (e) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    var d = drag;
    drag = null;
    if (!d.started) { handleTap(d); return; }
    endDrag(d);
    var target = pickTarget(d);
    if (target) doMove(d.src, target);
    else layout();
  });

  document.addEventListener('pointercancel', function (e) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    var d = drag;
    drag = null;
    if (d.started) endDrag(d);
    layout();
  });

  function startDrag() {
    drag.started = true;
    lastTap = null;
    clearHighlights();
    drag.ids.forEach(function (id, i) {
      var el = cardEls[id];
      clearTimeout(el._lift);
      el._lift = 0;
      el.classList.remove('flying');
      el.classList.add('dragging');
      el.style.zIndex = 2000 + i;
    });
    // Подсвечиваем все места, куда можно положить карту.
    var dsts = [];
    if (drag.ids.length === 1) for (var f = 0; f < 4; f++) dsts.push({ type: 'foundation', index: f });
    for (var c = 0; c < 7; c++) dsts.push({ type: 'tableau', index: c });
    drag.targets = dsts.filter(function (dst) { return S.canMove(state, drag.src, dst); }).map(function (dst) {
      var pile = dst.type === 'foundation' ? state.foundations[dst.index] : state.tableau[dst.index];
      var slot = dst.type === 'foundation' ? foundationEls[dst.index] : columnEls[dst.index];
      var topCard = pile.length ? cardEls[pile[pile.length - 1].id] : null;
      if (topCard) topCard.classList.add('target'); else slot.classList.add('drop-ok');
      return { dst: dst, zone: zoneOf(dst, topCard) };
    });
  }

  function zoneOf(dst, topCard) {
    var g = geo;
    if (dst.type === 'foundation') {
      var r = g.foundations[dst.index];
      return { x: r.x, y: r.y, w: r.w, h: r.h };
    }
    var col = g.columns[dst.index];
    var bottom = topCard ? topCard._y + g.ch : col.y + g.ch;
    return { x: col.x - g.cw * 0.1, y: col.y, w: g.cw * 1.2, h: bottom - col.y + g.ch * 0.6 };
  }

  function pickTarget(d) {
    var lead = cardEls[d.ids[0]];
    var box = { x: lead._x + d.dx, y: lead._y + d.dy, w: geo.cw, h: geo.ch };
    var best = null, bestArea = 0;
    d.targets.forEach(function (t) {
      var w = Math.min(box.x + box.w, t.zone.x + t.zone.w) - Math.max(box.x, t.zone.x);
      var h = Math.min(box.y + box.h, t.zone.y + t.zone.h) - Math.max(box.y, t.zone.y);
      var area = w > 0 && h > 0 ? w * h : 0;
      if (area > bestArea) { bestArea = area; best = t.dst; }
    });
    return best;
  }

  function endDrag(d) {
    d.ids.forEach(function (id) { cardEls[id].classList.remove('dragging'); });
    clearHighlights();
  }

  function handleTap(d) {
    var now = Date.now();
    var id = d.ids[0];
    if (lastTap && lastTap.id === id && now - lastTap.t < 400) {
      lastTap = null;
      if (!toFoundation(d.src)) toast('Эту карту пока нельзя убрать в стопку масти');
    } else {
      lastTap = { id: id, t: now };
    }
  }

  function clearHighlights() {
    var els = board.querySelectorAll('.drop-ok, .target, .hint');
    Array.prototype.forEach.call(els, function (el) { el.classList.remove('drop-ok', 'target', 'hint'); });
  }

  stockEl.addEventListener('click', doDraw);

  /* ---------- подсказка ---------- */

  var hintTimer = 0;

  function flash(el) {
    el.classList.remove('hint');
    void el.offsetWidth;
    el.classList.add('hint');
  }

  function showHint() {
    if (busy || state.won) return;
    clearTimeout(hintTimer);
    clearHighlights();
    var h = S.hint(state);
    if (!h) {
      toast('Похоже, ходов больше нет. Отмените ход или начните новую игру.');
      return;
    }
    if (h.draw) {
      var topStock = state.stock[state.stock.length - 1];
      flash(topStock ? cardEls[topStock.id] : stockEl);
      toast(state.stock.length ? 'Откройте карты из колоды' : 'Переверните колоду заново');
    } else {
      S.getMovable(state, h.src).forEach(function (c) { flash(cardEls[c.id]); });
      var pile = h.dst.type === 'foundation' ? state.foundations[h.dst.index] : state.tableau[h.dst.index];
      if (pile.length) flash(cardEls[pile[pile.length - 1].id]);
      else flash(h.dst.type === 'foundation' ? foundationEls[h.dst.index] : columnEls[h.dst.index]);
    }
    hintTimer = setTimeout(clearHighlights, 2600);
  }

  /* ---------- таймер и табло ---------- */

  function seconds() {
    var ms = timer.elapsed + (timer.since ? performance.now() - timer.since : 0);
    return Math.floor(ms / 1000);
  }

  function startTimer() {
    if (timer.since || state.won) return;
    timer.since = performance.now();
    clearInterval(timer.id);
    timer.id = setInterval(updateHud, 1000);
  }

  function stopTimer() {
    if (timer.since) timer.elapsed += performance.now() - timer.since;
    timer.since = 0;
    clearInterval(timer.id);
  }

  document.addEventListener('visibilitychange', function () {
    if (!state) return;
    if (document.hidden && timer.since) { stopTimer(); timer.paused = true; }
    else if (!document.hidden && timer.paused) { timer.paused = false; startTimer(); updateHud(); }
  });

  function fmtTime(sec) {
    var m = Math.floor(sec / 60), s = sec % 60;
    if (m >= 60) return Math.floor(m / 60) + ':' + pad(m % 60) + ':' + pad(s);
    return m + ':' + pad(s);
  }
  function pad(n) { return (n < 10 ? '0' : '') + n; }

  function updateHud() {
    var mode = S.MODES[state.mode];
    var secs = seconds();
    $('score').textContent = S.score(state, secs);
    $('time').textContent = fmtTime(secs);
    $('moves').textContent = state.moves;
    $('modeBadge').textContent = mode.name;

    var limited = isFinite(mode.maxPasses);
    $('passBox').hidden = !limited;
    if (limited) $('pass').textContent = state.pass + '/' + mode.maxPasses;

    var undoBtn = $('btnUndo');
    undoBtn.disabled = busy || !S.canUndo(state);
    undoBtn.title = mode.undo === 'none' ? 'В сложном режиме отмены нет'
      : mode.undo === 'penalty' ? 'Отменить ход (−15 очков)' : 'Отменить ход';
    $('btnHint').disabled = busy || state.won;

    var empty = state.stock.length === 0;
    var canAgain = S.canRecycle(state);
    var final = empty && !canAgain;
    stockEl.classList.toggle('final', final);
    $('stockIcon').firstElementChild.setAttribute('href', final ? '#i-stop' : '#i-recycle');
    stockEl.setAttribute('aria-label', !empty ? 'Колода: открыть карты' : canAgain ? 'Перевернуть колоду заново' : 'Колода закончилась');
  }

  /* ---------- победа и рекорды ---------- */

  var pendingResult = null;

  function onWin() {
    if (winShown) return;
    winShown = true;
    stopTimer();
    updateHud();
    markGrabbable();
    board.classList.add('won');

    var secs = seconds();
    var result = {
      name: '',
      score: S.score(state, secs),
      time: secs,
      moves: state.moves,
      date: new Date().toISOString()
    };
    var place = placeFor(state.mode, result);
    pendingResult = place ? { mode: state.mode, entry: result } : null;

    $('winScore').textContent = result.score;
    $('winTime').textContent = fmtTime(secs);
    $('winMoves').textContent = result.moves;
    $('winRecord').hidden = !place;
    $('winNoRecord').hidden = !!place;
    $('btnWinSave').hidden = !place;
    $('btnWinAgain').hidden = !!place;
    $('btnWinClose').hidden = !!place;
    if (place) {
      $('winPlace').textContent = place + '-е место в таблице «' + S.MODES[state.mode].name + '». Как вас записать?';
      $('winName').value = settings.name;
    }
    var token = gameToken;
    setTimeout(function () {
      if (token !== gameToken) return;
      $('dlgWin').showModal();
      if (place) $('winName').focus();
    }, reducedMotion.matches ? 50 : 700);
  }

  $('dlgWin').addEventListener('close', function () {
    var action = $('dlgWin').returnValue;
    $('dlgWin').returnValue = '';
    if (pendingResult) {
      // Результат из топ-10 сохраняем, даже если окно закрыли клавишей Esc.
      var name = $('winName').value.trim().slice(0, 20) || 'Игрок';
      settings.name = name;
      save('settings', settings);
      var mode = pendingResult.mode;
      var entry = pendingResult.entry;
      entry.name = name;
      pendingResult = null;
      records[mode].push(entry);
      records[mode].sort(compareRecords);
      records[mode] = records[mode].slice(0, 10);
      save('records', records);
      openRecords(mode, entry);
    } else if (action === 'again') {
      openNewGame();
    }
  });

  function compareRecords(a, b) {
    return b.score - a.score || a.time - b.time || a.moves - b.moves || (a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
  }

  function placeFor(mode, entry) {
    var list = records[mode].concat([entry]).sort(compareRecords);
    var i = list.indexOf(entry);
    return i < 10 ? i + 1 : 0;
  }

  function normalizeRecords(raw) {
    var out = {};
    MODE_IDS.forEach(function (m) {
      var list = raw && Array.isArray(raw[m]) ? raw[m] : [];
      out[m] = list.filter(function (r) {
        return r && typeof r.name === 'string' && isFinite(r.score) && isFinite(r.time) && isFinite(r.moves);
      }).sort(compareRecords).slice(0, 10);
    });
    return out;
  }

  var recordsMode = 'easy';

  function openRecords(mode, fresh) {
    recordsMode = mode || (state ? state.mode : 'easy');
    $('resetConfirm').hidden = true;
    $('btnReset').hidden = false;
    renderRecords(fresh);
    if (!$('dlgRecords').open) $('dlgRecords').showModal();
  }

  function renderRecords(fresh) {
    Array.prototype.forEach.call(document.querySelectorAll('#recordTabs .tab'), function (tab) {
      tab.setAttribute('aria-selected', tab.dataset.mode === recordsMode ? 'true' : 'false');
    });
    var body = $('recordsBody');
    body.textContent = '';
    var list = records[recordsMode];
    list.forEach(function (r, i) {
      var tr = document.createElement('tr');
      if (fresh && r === fresh) tr.className = 'fresh';
      [i + 1, r.name, r.score, fmtTime(r.time), r.moves, fmtDate(r.date)].forEach(function (v) {
        var td = document.createElement('td');
        td.textContent = v;
        tr.appendChild(td);
      });
      body.appendChild(tr);
    });
    $('recordsEmpty').hidden = list.length > 0;
    document.querySelector('.records').classList.toggle('empty', list.length === 0);
    $('btnReset').disabled = list.length === 0;
  }

  function fmtDate(iso) {
    var d = new Date(iso);
    if (isNaN(d)) return '—';
    return pad(d.getDate()) + '.' + pad(d.getMonth() + 1) + '.' + d.getFullYear();
  }

  $('recordTabs').addEventListener('click', function (e) {
    var tab = e.target.closest('.tab');
    if (!tab) return;
    recordsMode = tab.dataset.mode;
    $('resetConfirm').hidden = true;
    $('btnReset').hidden = false;
    renderRecords();
  });
  $('btnReset').addEventListener('click', function () {
    $('resetConfirm').hidden = false;
    $('btnReset').hidden = true;
  });
  $('btnResetNo').addEventListener('click', function () {
    $('resetConfirm').hidden = true;
    $('btnReset').hidden = false;
  });
  $('btnResetYes').addEventListener('click', function () {
    records[recordsMode] = [];
    save('records', records);
    $('resetConfirm').hidden = true;
    $('btnReset').hidden = false;
    renderRecords();
    toast('Таблица «' + S.MODES[recordsMode].name + '» очищена');
  });

  /* ---------- новая игра: выбор сложности ---------- */

  function openNewGame() {
    var radios = document.querySelectorAll('#formNew input[name="mode"]');
    Array.prototype.forEach.call(radios, function (r) { r.checked = r.value === settings.mode; });
    $('dlgNew').returnValue = '';
    $('dlgNew').showModal();
  }

  $('dlgNew').addEventListener('close', function () {
    if ($('dlgNew').returnValue !== 'start') return;
    var picked = document.querySelector('#formNew input[name="mode"]:checked');
    settings.mode = picked ? picked.value : 'easy';
    save('settings', settings);
    newGame(settings.mode);
  });

  /* ---------- цветовые схемы ---------- */

  function applyTheme(id) {
    settings.theme = id;
    document.body.dataset.theme = id;
    save('settings', settings);
    Array.prototype.forEach.call(document.querySelectorAll('.theme-item'), function (b) {
      b.setAttribute('aria-checked', b.dataset.theme === id ? 'true' : 'false');
    });
  }

  function buildThemes() {
    var list = $('themeList');
    list.setAttribute('role', 'radiogroup');
    THEMES.forEach(function (t) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'theme-item';
      b.dataset.theme = t.id;
      b.setAttribute('role', 'radio');
      b.style.setProperty('--sw-a', t.a);
      var sw = document.createElement('span');
      sw.className = 'theme-swatch';
      [t.a, t.b].forEach(function (color) {
        var i = document.createElement('i');
        i.style.color = color;
        sw.appendChild(i);
      });
      var name = document.createElement('span');
      name.className = 'theme-name';
      name.textContent = t.name;
      b.appendChild(sw);
      b.appendChild(name);
      b.addEventListener('click', function () { applyTheme(t.id); });
      list.appendChild(b);
    });
  }

  /* ---------- всплывающие сообщения ---------- */

  var toastTimer = 0;
  function toast(text) {
    var el = $('toast');
    el.textContent = text;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('show'); }, 2600);
  }

  /* ---------- кнопки и клавиши ---------- */

  $('btnNew').addEventListener('click', openNewGame);
  $('btnUndo').addEventListener('click', doUndo);
  $('btnHint').addEventListener('click', showHint);
  $('btnRecords').addEventListener('click', function () { openRecords(state.mode); });
  $('btnRules').addEventListener('click', function () { $('dlgRules').showModal(); });
  $('btnTheme').addEventListener('click', function () { $('dlgTheme').showModal(); });

  document.addEventListener('keydown', function (e) {
    if (document.querySelector('dialog[open]')) return;
    if (e.target && /^(INPUT|TEXTAREA)$/.test(e.target.tagName)) return;
    if ((e.ctrlKey || e.metaKey) && e.code === 'KeyZ') { e.preventDefault(); doUndo(); return; }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.code === 'KeyH') showHint();
    else if (e.code === 'KeyN') openNewGame();
    else if (e.code === 'Space' && e.target.tagName !== 'BUTTON') { e.preventDefault(); doDraw(); }
  });

  var resizeTimer = 0;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      if (drag) return;
      layout({ instant: true });
    }, 60);
  });

  /* ---------- запуск ---------- */

  buildThemes();
  applyTheme(settings.theme);
  buildCards();
  newGame(settings.mode);

  // Для проверки из консоли браузера.
  window.__kosynka = {
    get state() { return state; },
    layout: layout,
    newGame: newGame,
    records: function () { return records; }
  };
})();
