/*
 * Правила «Косынки» без картинок и кнопок: колода, ходы, очки, отмена, подсказка.
 * Работает и в браузере (window.Solitaire), и в Node (для автопроверки).
 */
(function (root) {
  'use strict';

  var SUITS = ['S', 'H', 'D', 'C']; // пики, черви, бубны, трефы
  var RANK_LABELS = ['', 'A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
  var RANK_NAMES = ['', 'Туз', 'Двойка', 'Тройка', 'Четвёрка', 'Пятёрка', 'Шестёрка', 'Семёрка',
    'Восьмёрка', 'Девятка', 'Десятка', 'Валет', 'Дама', 'Король'];
  var SUIT_NAMES = { S: 'пик', H: 'червей', D: 'бубен', C: 'треф' };

  var MODES = {
    easy:   { id: 'easy',   name: 'Лёгкий',  draw: 1, maxPasses: Infinity, undo: 'free' },
    medium: { id: 'medium', name: 'Средний', draw: 3, maxPasses: Infinity, undo: 'penalty' },
    hard:   { id: 'hard',   name: 'Сложный', draw: 3, maxPasses: 3,        undo: 'none' }
  };

  var SCORE = {
    toFoundation: 10,     // карта в основание
    wasteToTableau: 5,    // карта из сброса в колонку
    flip: 5,              // открыта закрытая карта в колонке
    fromFoundation: -15,  // карта возвращена из основания
    recycle: -20,         // новый проход по колоде
    undo: -15,            // отмена хода (средний режим)
    timeStep: 10,         // каждые 10 секунд…
    timePenalty: 2,       // …минус 2 очка
    win: 500              // бонус за победу
  };

  function isRed(card) { return card.suit === 'H' || card.suit === 'D'; }
  function top(arr) { return arr.length ? arr[arr.length - 1] : null; }
  function label(card) { return RANK_LABELS[card.rank]; }
  function cardName(card) { return RANK_NAMES[card.rank] + ' ' + SUIT_NAMES[card.suit]; }

  function makeDeck() {
    var deck = [];
    SUITS.forEach(function (suit) {
      for (var rank = 1; rank <= 13; rank++) deck.push({ id: suit + rank, suit: suit, rank: rank, up: false });
    });
    return deck;
  }

  function randomInt(max, rng) {
    if (rng) return Math.floor(rng() * max);
    if (root.crypto && root.crypto.getRandomValues) {
      var buf = new Uint32Array(1);
      root.crypto.getRandomValues(buf);
      return buf[0] % max;
    }
    return Math.floor(Math.random() * max);
  }

  function shuffle(deck, rng) {
    for (var i = deck.length - 1; i > 0; i--) {
      var j = randomInt(i + 1, rng);
      var t = deck[i]; deck[i] = deck[j]; deck[j] = t;
    }
    return deck;
  }

  function createGame(modeId, rng) {
    var mode = MODES[modeId] ? modeId : 'easy';
    var deck = shuffle(makeDeck(), rng);
    var tableau = [[], [], [], [], [], [], []];
    var k = 0;
    for (var col = 0; col < 7; col++) {
      for (var row = 0; row <= col; row++) {
        var card = deck[k++];
        card.up = row === col;
        tableau[col].push(card);
      }
    }
    return {
      mode: mode,
      stock: deck.slice(k),
      waste: [],
      foundations: [[], [], [], []],
      tableau: tableau,
      points: 0,
      pass: 1,
      moves: 0,
      undoPenalty: 0,
      history: [],
      won: false
    };
  }

  function modeOf(state) { return MODES[state.mode]; }

  /* ---------- проверки ---------- */

  function canStackOnTableau(card, pile) {
    var t = top(pile);
    if (!t) return card.rank === 13;
    return t.up && isRed(t) !== isRed(card) && t.rank === card.rank + 1;
  }

  function canPlaceOnFoundation(card, pile) {
    var t = top(pile);
    if (!t) return card.rank === 1;
    return t.suit === card.suit && t.rank + 1 === card.rank;
  }

  function pileOf(state, loc) {
    if (loc.type === 'waste') return state.waste;
    if (loc.type === 'stock') return state.stock;
    if (loc.type === 'foundation') return state.foundations[loc.index];
    if (loc.type === 'tableau') return state.tableau[loc.index];
    return null;
  }

  // Какие карты можно взять из этого места. src.card — индекс карты в колонке.
  function getMovable(state, src) {
    if (src.type === 'waste' || src.type === 'foundation') {
      var t = top(pileOf(state, src));
      return t ? [t] : null;
    }
    if (src.type === 'tableau') {
      var pile = state.tableau[src.index];
      var from = src.card == null ? pile.length - 1 : src.card;
      if (from < 0 || from >= pile.length || !pile[from].up) return null;
      var cards = pile.slice(from);
      for (var i = 1; i < cards.length; i++) {
        var a = cards[i - 1], b = cards[i];
        if (!b.up || isRed(a) === isRed(b) || a.rank !== b.rank + 1) return null;
      }
      return cards;
    }
    return null;
  }

  function canMove(state, src, dst) {
    var cards = getMovable(state, src);
    if (!cards) return false;
    if (dst.type === 'foundation') {
      if (src.type === 'foundation') return false;
      return cards.length === 1 && canPlaceOnFoundation(cards[0], state.foundations[dst.index]);
    }
    if (dst.type === 'tableau') {
      if (src.type === 'tableau' && src.index === dst.index) return false;
      return canStackOnTableau(cards[0], state.tableau[dst.index]);
    }
    return false;
  }

  /* ---------- история для отмены ---------- */

  function snapshot(state) {
    return JSON.stringify({
      stock: state.stock, waste: state.waste, foundations: state.foundations,
      tableau: state.tableau, points: state.points, pass: state.pass
    });
  }

  function remember(state) {
    if (modeOf(state).undo !== 'none') state.history.push(snapshot(state));
  }

  function canUndo(state) {
    return modeOf(state).undo !== 'none' && state.history.length > 0 && !state.won;
  }

  function undo(state) {
    if (!canUndo(state)) return false;
    var s = JSON.parse(state.history.pop());
    state.stock = s.stock; state.waste = s.waste; state.foundations = s.foundations;
    state.tableau = s.tableau; state.points = s.points; state.pass = s.pass;
    state.moves++;
    if (modeOf(state).undo === 'penalty') state.undoPenalty -= SCORE.undo;
    return true;
  }

  /* ---------- ходы ---------- */

  function checkWin(state) {
    state.won = state.foundations.every(function (f) { return f.length === 13; });
    return state.won;
  }

  // Возвращает описание хода или null, если ход недопустим.
  function move(state, src, dst) {
    if (state.won || !canMove(state, src, dst)) return null;
    remember(state);
    var from = pileOf(state, src);
    var count = getMovable(state, src).length;
    var cards = from.splice(from.length - count, count);
    var to = pileOf(state, dst);
    for (var i = 0; i < cards.length; i++) to.push(cards[i]);

    if (dst.type === 'foundation') state.points += SCORE.toFoundation;
    if (src.type === 'waste' && dst.type === 'tableau') state.points += SCORE.wasteToTableau;
    if (src.type === 'foundation') state.points += SCORE.fromFoundation;

    var flipped = null;
    if (src.type === 'tableau') {
      var t = top(from);
      if (t && !t.up) { t.up = true; flipped = t.id; state.points += SCORE.flip; }
    }
    state.moves++;
    checkWin(state);
    return { cards: cards.map(function (c) { return c.id; }), flipped: flipped };
  }

  function canRecycle(state) {
    return state.stock.length === 0 && state.waste.length > 0 && state.pass < modeOf(state).maxPasses;
  }

  function canDraw(state) {
    return !state.won && (state.stock.length > 0 || canRecycle(state));
  }

  // Клик по колоде: открыть карты или перевернуть сброс обратно в колоду.
  function draw(state, opts) {
    if (!canDraw(state)) return null;
    remember(state);
    state.moves++;
    if (state.stock.length) {
      var n = Math.min(modeOf(state).draw, state.stock.length);
      for (var i = 0; i < n; i++) {
        var card = state.stock.pop();
        card.up = true;
        state.waste.push(card);
      }
      return 'draw';
    }
    state.stock = state.waste.reverse();
    state.stock.forEach(function (c) { c.up = false; });
    state.waste = [];
    state.pass++;
    if (!(opts && opts.free)) state.points += SCORE.recycle;
    return 'recycle';
  }

  function findFoundation(state, src) {
    var cards = getMovable(state, src);
    if (!cards || cards.length !== 1) return -1;
    var i;
    for (i = 0; i < 4; i++) if (state.foundations[i].length && canMove(state, src, { type: 'foundation', index: i })) return i;
    for (i = 0; i < 4; i++) if (canMove(state, src, { type: 'foundation', index: i })) return i;
    return -1;
  }

  /* ---------- очки ---------- */

  function timePenalty(seconds) {
    return Math.floor(seconds / SCORE.timeStep) * SCORE.timePenalty;
  }

  function score(state, seconds) {
    var total = state.points - timePenalty(seconds || 0) - state.undoPenalty + (state.won ? SCORE.win : 0);
    return Math.max(0, total);
  }

  /* ---------- подсказка ---------- */

  // Все места, откуда что-то можно взять сейчас.
  function sources(state) {
    var list = [];
    if (state.waste.length) list.push({ type: 'waste' });
    state.tableau.forEach(function (pile, index) {
      for (var c = 0; c < pile.length; c++) if (pile[c].up) list.push({ type: 'tableau', index: index, card: c });
    });
    return list;
  }

  function anyCardPlayable(state, card) {
    var i;
    for (i = 0; i < 4; i++) if (canPlaceOnFoundation(card, state.foundations[i])) return true;
    for (i = 0; i < 7; i++) if (canStackOnTableau(card, state.tableau[i])) return true;
    return false;
  }

  function canGoToFoundation(state, card) {
    for (var f = 0; f < 4; f++) if (canPlaceOnFoundation(card, state.foundations[f])) return true;
    return false;
  }

  // Возвращает {src, dst} | {draw:true} | null (ходов нет).
  function hint(state) {
    if (state.won) return null;
    var srcs = sources(state);
    var i, j, s, f;

    // 1. Верхнюю карту можно отправить в основание.
    for (i = 0; i < srcs.length; i++) {
      s = srcs[i];
      if (s.type === 'tableau' && s.card !== state.tableau[s.index].length - 1) continue;
      f = findFoundation(state, s);
      if (f >= 0) return { src: s, dst: { type: 'foundation', index: f } };
    }

    // Есть ли король, которому пригодится пустая колонка.
    var kingWaiting = !!(top(state.waste) && top(state.waste).rank === 13);
    state.tableau.forEach(function (pile) {
      for (var c = 1; c < pile.length; c++) {
        if (pile[c].up && !pile[c - 1].up && pile[c].rank === 13) kingWaiting = true;
      }
    });

    // 2. Перенос между колонками, от которого есть польза.
    var useful = [];
    for (i = 0; i < srcs.length; i++) {
      s = srcs[i];
      if (s.type !== 'tableau') continue;
      var pile = state.tableau[s.index];
      var below = s.card > 0 ? pile[s.card - 1] : null;
      var priority = 0;
      if (below && !below.up) priority = 3;                                   // откроет закрытую карту
      else if (below && below.up && canGoToFoundation(state, below)) priority = 2; // освободит карту для основания
      else if (!below && pile[s.card].rank !== 13 && kingWaiting) priority = 1;    // освободит место для короля
      if (!priority) continue;
      for (j = 0; j < 7; j++) {
        var dst = { type: 'tableau', index: j };
        if (!canMove(state, s, dst)) continue;
        if (!state.tableau[j].length && !below) continue; // короля с пустого места на пустое — бессмысленно
        useful.push({ src: s, dst: dst, priority: priority });
        break;
      }
    }
    // 3. Карта из сброса в колонку.
    if (state.waste.length) {
      for (j = 0; j < 7; j++) {
        if (canMove(state, { type: 'waste' }, { type: 'tableau', index: j })) {
          useful.push({ src: { type: 'waste' }, dst: { type: 'tableau', index: j }, priority: 2.5 });
          break;
        }
      }
    }
    if (useful.length) {
      useful.sort(function (a, b) { return b.priority - a.priority; });
      return { src: useful[0].src, dst: useful[0].dst };
    }

    // 4. Открыть колоду — если там вообще есть карта, которую куда-то можно положить.
    if (canDraw(state)) {
      var rest = state.stock.length || canRecycle(state) ? state.stock.concat(state.waste) : [];
      for (i = 0; i < rest.length; i++) if (anyCardPlayable(state, rest[i])) return { draw: true };
    }
    return null;
  }

  /* ---------- автозавершение ---------- */

  function allOpen(state) {
    return state.tableau.every(function (p) { return p.every(function (c) { return c.up; }); });
  }

  // Один шаг автосбора: в основание, иначе открыть колоду. null — шагов нет.
  function autoStep(state) {
    var i, f, s;
    for (i = 0; i < 7; i++) {
      s = { type: 'tableau', index: i };
      f = findFoundation(state, s);
      if (f >= 0) return { src: s, dst: { type: 'foundation', index: f } };
    }
    f = findFoundation(state, { type: 'waste' });
    if (f >= 0) return { src: { type: 'waste' }, dst: { type: 'foundation', index: f } };
    if (canDraw(state)) return { draw: true };
    return null;
  }

  // Соберётся ли пасьянс сам: все карты в колонках открыты и автосбор доходит до конца.
  function canAutoComplete(state) {
    if (state.won || !allOpen(state)) return false;
    var sim = JSON.parse(JSON.stringify(state));
    sim.history = [];
    var idle = 0;
    for (var guard = 0; guard < 3000 && !sim.won; guard++) {
      var step = autoStep(sim);
      if (!step) return false;
      if (step.draw) {
        draw(sim, { free: true });
        var limit = 2 * (Math.ceil((sim.stock.length + sim.waste.length) / modeOf(sim).draw) + 1);
        if (++idle > limit) return false;
      } else {
        move(sim, step.src, step.dst);
        idle = 0;
      }
    }
    return sim.won;
  }

  var api = {
    SUITS: SUITS, MODES: MODES, SCORE: SCORE,
    isRed: isRed, label: label, cardName: cardName, makeDeck: makeDeck,
    createGame: createGame, canMove: canMove, getMovable: getMovable, move: move,
    draw: draw, canDraw: canDraw, canRecycle: canRecycle, undo: undo, canUndo: canUndo,
    findFoundation: findFoundation, score: score, timePenalty: timePenalty,
    hint: hint, autoStep: autoStep, canAutoComplete: canAutoComplete, allOpen: allOpen,
    canStackOnTableau: canStackOnTableau, canPlaceOnFoundation: canPlaceOnFoundation
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Solitaire = api;
})(typeof window !== 'undefined' ? window : globalThis);
