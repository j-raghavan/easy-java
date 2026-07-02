/* Java, Clearly — shared lesson engine.
 * window.LessonEngine.mount(rootEl, opts) wires an entire interactive lesson
 * from DOM conventions so every lesson file stays thin + consistent.
 *
 * Conventions inside rootEl:
 *   [data-stage]            wrapper holding the <section data-narr> scenes
 *   section[data-narr]      one scene; text is spoken + shown as caption
 *   [data-prog] [data-dots] [data-score]   progress bar / dots / score pill
 *   [data-prev] [data-next] [data-mute] [data-replay]   nav + narration ctrls
 *   .q[data-answer][data-fb-ok][data-fb-no] > .opt[data-i]   MCQ questions
 *   .match with .chip[data-type] and .drop[data-type]        drag-match
 *   .stepper[data-steps='[{line,set,out}]'] with .cline[data-line]
 *                                            and .varchip[data-v]   step viz
 *   .editor + [data-run] (+ [data-try] + [data-console])     live Java editor
 * opts: { key: 'l2' }  — localStorage namespace for score/progress.
 */
(function () {
  function $(sel, ctx) { return (ctx || document).querySelector(sel); }
  function $all(sel, ctx) { return [...(ctx || document).querySelectorAll(sel)]; }
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

  // ---------- live Java-subset interpreter ----------
  function runJava(src) {
    var out = [], vars = {}, itype = {}, methods = {}, lineBuf = ''; // itype tracks int-declared names for int division/truncation
    var guard = 0;
    function callMethod(name, args) {
      var m = methods[name]; if (!m) throw new Error('Unknown method: ' + name);
      var scope = {}; for (var p = 0; p < m.params.length; p++) scope[m.params[p]] = args[p];
      var prev = vars, prevIt = itype; vars = scope; itype = {};
      var ret;
      try { parse(m.body.slice()); }
      catch (e) { if (e && Object.prototype.hasOwnProperty.call(e, '__ret')) { ret = e.__ret; } else { vars = prev; itype = prevIt; throw e; } }
      vars = prev; itype = prevIt; return ret;
    }
    function evalExpr(raw) {
      var expr = raw.trim();
      var lits = [], js = '', i = 0;
      // char literals 'a' -> string; string literals "..."
      while (i < expr.length) {
        var ch = expr[i];
        if (ch === '"' || ch === "'") {
          var q = ch, j = i + 1, str = '';
          while (j < expr.length && expr[j] !== q) { if (expr[j] === '\\') { str += expr[j] + expr[j + 1]; j += 2; continue; } str += expr[j]; j++; }
          lits.push(JSON.stringify(JSON.parse('"' + str.replace(/"/g, '\\"') + '"')));
          js += '\u0000' + (lits.length - 1) + '\u0000'; i = j + 1;
        } else { js += ch; i++; }
      }
      // Java -> JS translations (outside strings)
      js = js.replace(/\((?:double|float|long)\)\s*/g, '')      // widening casts: JS math is float already
             .replace(/\(int\)\s*([A-Za-z_$][\w$.]*(?:\([^()]*\))?|\d+\.?\d*|\([^()]*\))/g, '__toInt($1)')
             .replace(/\.length\(\)/g, '.length')          // String length
             .replace(/\.equals\s*\(/g, '.__eq(')          // s.equals(x)
             .replace(/\bInteger\.parseInt\s*\(/g, 'parseInt(')
             .replace(/\bDouble\.parseDouble\s*\(/g, 'parseFloat(')
             .replace(/\bMath\.pow\b/g, 'Math.pow')
             .replace(/([A-Za-z_$][\w$]*)\.equalsIgnoreCase\s*\(/g, '$1.__eqi(');
      js = js.replace(/[A-Za-z_$][A-Za-z0-9_$]*/g, function (m) {
        if (m === 'true' || m === 'false' || m === 'Math' || m === 'parseInt' || m === 'parseFloat') return m;
        if (m in vars) { var v = vars[m]; return typeof v === 'string' ? JSON.stringify(v) : (Array.isArray(v) ? '__arr' + refArr(v) : v); }
        // allow method names / properties to pass through untouched
        return m;
      });
      js = js.replace(/\u0000(\d+)\u0000/g, function (_, k) { return lits[+k]; });
      var val;
      try {
        val = (function () {
          'use strict';
          String.prototype.__eq = function (o) { return this.valueOf() === o; };
          String.prototype.__eqi = function (o) { return this.toLowerCase() === String(o).toLowerCase(); };
          return Function('__ctx', 'with(__ctx){return (' + js + ')}')(arrRefs);
        })();
      } catch (e) { throw new Error('Could not evaluate: ' + raw.trim()); }
      if (typeof val === 'number' && !isFinite(val)) throw new Error('Exception in thread "main" java.lang.ArithmeticException: / by zero');
      return val;
    }
    // array reference plumbing so substituted arrays keep identity
    var arrRefs = { __toInt: Math.trunc }, arrN = 0;
    function refArr(a) { for (var k in arrRefs) if (arrRefs[k] === a) return k.slice(5); arrN++; arrRefs['__arr' + arrN] = a; return arrN; }

    function evalRHS(raw) {
      var t = raw.trim();
      var nm = t.match(/^new\s+\w+\s*\[\s*(.+?)\s*\]$/);              // new int[n]
      if (nm) { var n = evalExpr(nm[1]); return new Array(n).fill(0); }
      var arr = t.match(/^\{(.*)\}$/);                                // {1,2,3}
      if (arr) { return arr[1].trim() === '' ? [] : splitArgs(arr[1]).map(evalRHS); }
      return evalExpr(t);
    }
    function splitArgs(s) {
      var parts = [], depth = 0, cur = '', inStr = 0;
      for (var i = 0; i < s.length; i++) { var c = s[i];
        if (inStr) { cur += c; if (c === inStr) inStr = 0; continue; }
        if (c === '"' || c === "'") { inStr = c; cur += c; continue; }
        if (c === '(' || c === '[' || c === '{') depth++;
        if (c === ')' || c === ']' || c === '}') depth--;
        if (c === ',' && depth === 0) { parts.push(cur); cur = ''; } else cur += c;
      }
      if (cur.trim() !== '') parts.push(cur); return parts;
    }
    function fmt(v) {
      if (typeof v === 'boolean') return v ? 'true' : 'false';
      if (Array.isArray(v)) return '[' + v.map(fmt).join(', ') + ']';
      if (v === undefined || v === null) return 'null';
      return String(v);
    }
    var stripType = /^(?:final\s+)?(int|double|String|boolean|long|float|char|var)(\[\])*\s+/;

    function runStmt(stmt) {
      stmt = stmt.trim(); if (!stmt || stmt.indexOf('//') === 0) return;
      stmt = stmt.replace(/;$/, '');
      var rm = stmt.match(/^return\b\s*([\s\S]*)$/);
      if (rm) { throw { __ret: rm[1].trim() === '' ? undefined : evalExpr(rm[1]) }; }
      var m = stmt.match(/^System\.out\.(println|print)\s*\(([\s\S]*)\)$/);
      if (m) { var v = m[2].trim() === '' ? '' : evalExpr(m[2]); if (m[1] === 'print') { lineBuf += fmt(v); } else { out.push(lineBuf + fmt(v)); lineBuf = ''; } return; }
      // array element assign: a[i] = x
      m = stmt.match(/^([A-Za-z_$][\w$]*)\s*\[\s*(.+?)\s*\]\s*=\s*([\s\S]+)$/);
      if (m && (m[1] in vars)) { var idx = evalExpr(m[2]); vars[m[1]][idx] = evalExpr(m[3]); return; }
      // declaration
      var isIntDecl = /^(?:final\s+)?int\s+/.test(stmt) && !/\[\]/.test(stmt.split('=')[0]);
      var decl = stmt.replace(stripType, '');
      m = decl.match(/^([A-Za-z_$][\w$]*)\s*=\s*([\s\S]+)$/);
      if (m) { var val = evalRHS(m[2]); if (isIntDecl && typeof val === 'number') val = Math.trunc(val); vars[m[1]] = val; if (isIntDecl) itype[m[1]] = 1; return; }
      // bare declaration `int x;`
      m = decl.match(/^([A-Za-z_$][\w$]*)$/);
      if (m && stmt !== decl) { vars[m[1]] = 0; return; }
      // compound ops
      m = stmt.match(/^([A-Za-z_$][\w$]*)\s*(\+\+|--)$/);
      if (m) { vars[m[1]] = (vars[m[1]] || 0) + (m[2] === '++' ? 1 : -1); return; }
      m = stmt.match(/^([A-Za-z_$][\w$]*)\s*(\+=|-=|\*=|\/=|%=)\s*([\s\S]+)$/);
      if (m) {
        var op = m[2][0]; var rhs = evalExpr(m[3]); var cur = vars[m[1]];
        if (op === '+') cur = cur + rhs; else if (op === '-') cur -= rhs; else if (op === '*') cur *= rhs; else if (op === '/') cur /= rhs; else cur %= rhs;
        if (itype[m[1]] && typeof cur === 'number') cur = Math.trunc(cur);
        vars[m[1]] = cur; return; }
      // plain assign
      m = stmt.match(/^([A-Za-z_$][\w$]*)\s*=\s*([\s\S]+)$/);
      if (m && (m[1] in vars)) { var vv = evalRHS(m[2]); if (itype[m[1]] && typeof vv === 'number') vv = Math.trunc(vv); vars[m[1]] = vv; return; }
      if (/^(public|private|class|import|package|static|void)\b/.test(stmt) || stmt === '}' || stmt === '{') return;
      // bare method call as a statement, e.g. greet();
      if (/^[A-Za-z_$][\w$]*\s*\(/.test(stmt)) { evalExpr(stmt); return; }
      throw new Error("Don't understand: " + stmt);
    }

    // normalize: split block braces onto their own lines, strip comments, keep
    // array-initializer braces + string contents intact.
    function normalize(src) {
      var res = [], line = '', inStr = 0, prev = '', init = 0;
      function flush() { if (line.trim()) res.push(line.trim()); line = ''; }
      for (var i = 0; i < src.length; i++) {
        var c = src[i];
        if (inStr) { line += c; if (c === inStr && src[i - 1] !== '\\') inStr = 0; prev = c; continue; }
        if (c === '"' || c === "'") { inStr = c; line += c; prev = c; continue; }
        if (c === '/' && src[i + 1] === '/') { while (i + 1 < src.length && src[i + 1] !== '\n') i++; continue; }
        if (c === '/' && src[i + 1] === '*') { i += 2; while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++; i++; continue; }
        if (c === '\n') { flush(); continue; }
        if (c === '{') {
          var initCtx = init > 0 || '=,(['.indexOf(prev) >= 0 || prev === '{';
          if (initCtx) { line += '{'; init++; } else { flush(); res.push('{'); }
          prev = '{'; continue;
        }
        if (c === '}') {
          if (init > 0) { line += '}'; init--; } else { flush(); res.push('}'); }
          prev = '}'; continue;
        }
        line += c; if (!/\s/.test(c)) prev = c;
      }
      flush(); return res;
    }
    // collect a block whose opening '{' is at index `braceIdx`; returns body + index of matching '}'
    function collectBlock(arr, braceIdx) {
      var body = [], depth = 0, k = braceIdx;
      for (; k < arr.length; k++) {
        var t = arr[k];
        if (t === '{') { depth++; if (depth === 1) continue; }
        else if (t === '}') { depth--; if (depth === 0) return { body: body, end: k }; }
        body.push(t);
      }
      return { body: body, end: k };
    }
    function nextBrace(arr, from) { var b = from; while (arr[b] && arr[b] !== '{') b++; return b; }

    function parse(arr) {
      for (var k = 0; k < arr.length; k++) {
        var line = arr[k];
        if (!line || line === '{' || line === '}' || line.indexOf('//') === 0) continue;
        if (++guard > 500000) throw new Error('Program ran too long (infinite loop?)');
        var fm = line.match(/^for\s*\(\s*(.*?)\s*;\s*(.*?)\s*;\s*(.*?)\s*\)$/);
        if (fm) {
          var bs = nextBrace(arr, k + 1), blk = collectBlock(arr, bs); k = blk.end;
          if (fm[1]) runStmt(fm[1]);
          while (evalExpr(fm[2])) { if (++guard > 500000) throw new Error('Loop ran too long (infinite loop?)'); parse(blk.body.slice()); runStmt(fm[3]); }
          continue;
        }
        var wm = line.match(/^while\s*\(\s*([\s\S]*?)\s*\)$/);
        if (wm) {
          var bsw = nextBrace(arr, k + 1), blkw = collectBlock(arr, bsw); k = blkw.end;
          while (evalExpr(wm[1])) { if (++guard > 500000) throw new Error('Loop ran too long (infinite loop?)'); parse(blkw.body.slice()); }
          continue;
        }
        var im = line.match(/^if\s*\(\s*([\s\S]*?)\s*\)$/);
        if (im) {
          var branches = [];
          var bsi = nextBrace(arr, k + 1), blkI = collectBlock(arr, bsi); k = blkI.end;
          branches.push({ cond: im[1], body: blkI.body });
          while (k + 1 < arr.length) {
            var nxt = arr[k + 1];
            var em = nxt.match(/^else\s+if\s*\(\s*([\s\S]*?)\s*\)$/);
            if (em) { k++; var bs2 = nextBrace(arr, k + 1), b = collectBlock(arr, bs2); k = b.end; branches.push({ cond: em[1], body: b.body }); }
            else if (nxt === 'else') { k++; var bs3 = nextBrace(arr, k + 1), b2 = collectBlock(arr, bs3); k = b2.end; branches.push({ cond: null, body: b2.body }); break; }
            else break;
          }
          for (var bi = 0; bi < branches.length; bi++) {
            if (branches[bi].cond === null || evalExpr(branches[bi].cond)) { parse(branches[bi].body.slice()); break; }
          }
          continue;
        }
        runStmt(line);
      }
    }
    // pull method definitions out of the top-level stream; returns {top, methods}
    function extractMethods(arr) {
      var top = [];
      for (var i = 0; i < arr.length; i++) {
        var line = arr[i];
        var mm = line.match(/^(?:public\s+|private\s+|protected\s+|static\s+|final\s+)*(?:int|double|String|boolean|char|long|float|void)(?:\[\])?\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)$/);
        if (mm && arr[i + 1] === '{') {
          var blk = collectBlock(arr, i + 1);
          var params = mm[2].trim() === '' ? [] : mm[2].split(',').map(function (p) { var parts = p.trim().split(/\s+/); return parts[parts.length - 1]; });
          methods[mm[1]] = { params: params, body: blk.body };
          i = blk.end;
        } else top.push(line);
      }
      return { top: top, methods: methods };
    }
    try {
      var ex = extractMethods(normalize(src));
      Object.keys(methods).forEach(function (nm) { arrRefs[nm] = function () { return callMethod(nm, [].slice.call(arguments)); }; });
      if (methods.main) parse(methods.main.body.slice()); else parse(ex.top);
      if (lineBuf !== '') { out.push(lineBuf); lineBuf = ''; }
      return { out: out };
    }
    catch (e) { if (lineBuf !== '') { out.push(lineBuf); lineBuf = ''; } if (e && Object.prototype.hasOwnProperty.call(e, '__ret')) return { out: out }; return { out: out, err: e.message }; }
  }

  // ---------- lesson wiring ----------
  function mount(root, opts) {
    opts = opts || {};
    var key = opts.key || 'lesson';
    var scenes = $all('section[data-narr]', root);
    if (!scenes.length) scenes = $all('.scene', root);
    var state = { i: 0, score: 0, answered: {}, visited: new Set([0]), muted: false };
    try { var saved = JSON.parse(localStorage.getItem(key + 'prog') || '{}'); if (typeof saved.score === 'number') state.score = saved.score; } catch (e) {}

    var prog = $('[data-prog]', root), dotsWrap = $('[data-dots]', root), scorePill = $('[data-score]', root);
    var prevBtn = $('[data-prev]', root), nextBtn = $('[data-next]', root);
    var dots = [];
    if (dotsWrap) { dotsWrap.innerHTML = ''; scenes.forEach(function (_, k) { var b = document.createElement('div'); b.className = 'ndot'; b.title = 'Scene ' + (k + 1); b.onclick = function () { show(k); }; dotsWrap.appendChild(b); dots.push(b); }); }

    function save() { try { localStorage.setItem(key + 'prog', JSON.stringify({ score: state.score, i: state.i })); } catch (e) {} }
    function updateScore() { if (scorePill) scorePill.textContent = state.score + ' pts'; var fs = $('[data-final-score]', root); if (fs) fs.textContent = state.score; }
    function addScore(n) { state.score += n; updateScore(); save(); }

    // narration
    var synth = window.speechSynthesis;
    var voiceCache = null;
    // Voices load asynchronously: getVoices() is empty on the first call in Chrome
    // and only fills in after 'voiceschanged'. Not waiting for that is what made the
    // narration fall back to the robotic default voice. Cache once, refresh on change.
    function pickVoice() {
      if (voiceCache) return voiceCache;
      var vs = (synth && synth.getVoices()) || [];
      if (!vs.length) return null;
      var en = vs.filter(function (v) { return /^en(-|_|$)/i.test(v.lang); });
      var pool = en.length ? en : vs;
      // Best-sounding first: neural/natural voices, then premium named voices, then any en-US.
      var tiers = [
        /Natural/i,                              // Edge/Windows neural, e.g. "Microsoft Aria Online (Natural)"
        /Siri|Premium|Enhanced/i,                // macOS/iOS premium & Siri voices
        /Samantha|Ava|Allison|Serena|Evan|Zoe/i, // high-quality Apple voices
        /Google (US|UK) English/i,               // Chrome's best
        /Jenny|Aria|Guy|Michelle|Sonia/i,        // other Microsoft voices
        /en-US/i                                 // any US English
      ];
      for (var t = 0; t < tiers.length; t++) {
        var m = pool.find(function (v) { return tiers[t].test(v.name) || tiers[t].test(v.lang); });
        if (m) { voiceCache = m; return m; }
      }
      voiceCache = pool[0] || null;
      return voiceCache;
    }
    if (synth && 'onvoiceschanged' in synth) {
      synth.onvoiceschanged = function () { voiceCache = null; pickVoice(); };
    }
    pickVoice();
    var speakToken = 0;
    function speak(force) {
      if (!synth) return; if (state.muted && !force) return;
      var txt = scenes[state.i].getAttribute('data-narr'); if (!txt) return;
      try {
        var myToken = ++speakToken;
        synth.cancel();
        var voice = pickVoice();
        // Speak sentence by sentence so each gets a natural falling intonation and a
        // short breath follows — far closer to human cadence than one long monotone run.
        var parts = String(txt).replace(/\s+/g, ' ').trim().match(/[^.!?]+[.!?]+|\S[^.!?]*$/g) || [txt];
        var idx = 0;
        (function next() {
          if (myToken !== speakToken || (state.muted && !force)) return;
          if (idx >= parts.length) return;
          var u = new SpeechSynthesisUtterance(parts[idx++]);
          if (voice) { u.voice = voice; u.lang = voice.lang; } else { u.lang = 'en-US'; }
          u.rate = 0.95;   // a touch slower reads as calmer and clearer
          u.pitch = 1.0;   // natural pitch, not chipmunky
          u.volume = 1.0;
          u.onend = function () { if (myToken === speakToken) setTimeout(next, idx < parts.length ? 180 : 0); };
          synth.speak(u);
        })();
      } catch (e) {}
    }
    var muteBtn = $('[data-mute]', root), replayBtn = $('[data-replay]', root);
    if (muteBtn) muteBtn.onclick = function () { state.muted = !state.muted; muteBtn.textContent = state.muted ? '🔇' : '🔊'; if (state.muted && synth) synth.cancel(); else speak(); };
    if (replayBtn) replayBtn.onclick = function () { speak(true); };

    function show(n, skipSpeak) {
      n = Math.max(0, Math.min(scenes.length - 1, n)); state.i = n; state.visited.add(n);
      scenes.forEach(function (s, k) { s.classList.toggle('active', k === n); });
      dots.forEach(function (d, k) { d.classList.toggle('on', k === n); d.classList.toggle('done', state.visited.has(k) && k !== n); });
      if (prog) prog.style.width = (n / (scenes.length - 1) * 100) + '%';
      if (prevBtn) prevBtn.style.visibility = n === 0 ? 'hidden' : 'visible';
      if (nextBtn) nextBtn.textContent = n === 0 ? 'Start →' : (n === scenes.length - 1 ? '↺ Restart' : 'Next →');
      updateScore();
      try { window.scrollTo({ top: 0, behavior: 'smooth' }); } catch (e) {}
      if (!skipSpeak) speak();
      save();
    }
    if (nextBtn) nextBtn.onclick = function () { if (state.i === scenes.length - 1) show(0); else show(state.i + 1); };
    if (prevBtn) prevBtn.onclick = function () { show(state.i - 1); };
    document.addEventListener('keydown', function (e) { if (e.target && e.target.tagName === 'TEXTAREA') return; if (e.key === 'ArrowRight') show(state.i + 1); if (e.key === 'ArrowLeft') show(state.i - 1); });

    // quizzes
    $all('.q', root).forEach(function (q, gi) {
      var ans = +q.getAttribute('data-answer');
      var opts = $all('.opt', q);
      var fb = $('.fb', q); if (!fb) { fb = document.createElement('div'); fb.className = 'fb'; q.appendChild(fb); }
      var qkey = (q.closest('.quiz') ? q.closest('.quiz').getAttribute('data-quiz') : 'q') + '-' + gi;
      opts.forEach(function (o) {
        o.onclick = function () {
          if (state.answered[qkey]) return;
          var pick = +o.getAttribute('data-i'), correct = pick === ans;
          opts.forEach(function (x) { x.classList.add('locked'); });
          o.classList.add(correct ? 'correct' : 'wrong');
          if (!correct && opts[ans]) opts[ans].classList.add('correct');
          fb.textContent = (correct ? '✓ ' : '✗ ') + q.getAttribute(correct ? 'data-fb-ok' : 'data-fb-no');
          fb.className = 'fb show ' + (correct ? 'ok' : 'no');
          state.answered[qkey] = true; if (correct) addScore(+(q.getAttribute('data-pts') || 10));
        };
      });
    });

    // drag-match
    $all('.match', root).forEach(function (wrap) {
      var fb = wrap.parentElement.querySelector('.fb') || (function () { var f = document.createElement('div'); f.className = 'fb'; wrap.after(f); return f; })();
      var dragged = null, placed = 0, chips = $all('.chip', wrap), drops = $all('.drop', wrap);
      chips.forEach(function (c) {
        c.addEventListener('dragstart', function () { if (c.classList.contains('placed')) return; dragged = c; c.classList.add('dragging'); });
        c.addEventListener('dragend', function () { c.classList.remove('dragging'); });
      });
      drops.forEach(function (d) {
        d.addEventListener('dragover', function (e) { e.preventDefault(); d.classList.add('over'); });
        d.addEventListener('dragleave', function () { d.classList.remove('over'); });
        d.addEventListener('drop', function (e) {
          e.preventDefault(); d.classList.remove('over');
          if (!dragged || dragged.classList.contains('placed')) return;
          var ok = dragged.getAttribute('data-type') === d.getAttribute('data-type');
          if (ok) {
            var slot = d.querySelector('.slot'); if (slot) slot.textContent = dragged.textContent;
            d.classList.add('right'); dragged.classList.add('placed'); placed++; addScore(5);
            if (placed === chips.length) { fb.textContent = '🎉 Perfect! All matched. +' + (chips.length * 5) + ' pts.'; fb.className = 'fb show ok'; }
          } else {
            d.classList.add('wrongdrop'); setTimeout(function () { d.classList.remove('wrongdrop'); }, 600);
            fb.textContent = '✗ Not quite — ' + dragged.textContent.trim() + " doesn't go there. Try again."; fb.className = 'fb show no';
          }
        });
      });
    });

    // steppers
    $all('.stepper', root).forEach(function (sp) {
      var steps; try { steps = JSON.parse(sp.getAttribute('data-steps') || '[]'); } catch (e) { steps = []; }
      var lines = $all('.cline', sp), stepBtn = $('[data-step]', sp), resetBtn = $('[data-step-reset]', sp), outEl = $('[data-step-out]', sp);
      var cur = -1;
      function chip(n) { return sp.querySelector('.varchip[data-v="' + n + '"]'); }
      function render() { lines.forEach(function (l, k) { var ln = +l.getAttribute('data-line'); l.classList.toggle('hot', steps[cur] && ln === steps[cur].line); l.classList.toggle('dim', steps[cur] && ln < steps[cur].line); }); }
      function reset() { cur = -1; $all('.varchip', sp).forEach(function (c) { c.textContent = '—'; c.className = 'varchip empty'; }); if (outEl) outEl.innerHTML = '<span class="muted">// output</span>'; lines.forEach(function (l) { l.classList.remove('hot', 'dim'); }); if (stepBtn) { stepBtn.textContent = '▶ Step'; stepBtn.disabled = false; } }
      if (stepBtn) stepBtn.onclick = function () {
        cur++; var s = steps[cur]; if (!s) return;
        if (s.set) Object.keys(s.set).forEach(function (n) { var c = chip(n); if (c) { c.className = 'varchip upd'; c.innerHTML = esc(String(s.set[n])) + (s.type ? ' <span class="vt">' + esc(s.type) + '</span>' : ''); setTimeout(function () { c.classList.remove('upd'); }, 450); } });
        if (s.out !== undefined && outEl) outEl.innerHTML = '<span style="color:#c7f2e6">' + esc(s.out) + '</span>';
        render();
        if (cur >= steps.length - 1) { stepBtn.textContent = '✓ Done'; stepBtn.disabled = true; }
        else stepBtn.textContent = '▶ Step (' + (cur + 2) + '/' + steps.length + ')';
      };
      if (resetBtn) resetBtn.onclick = reset;
      reset();
    });

    // live editor(s)
    $all('.editor', root).forEach(function (ed) {
      var scope = ed.closest('.scene') || root;
      var con = $('[data-console]', scope), runBtn = $('[data-run]', scope), tryBtn = $('[data-try]', scope);
      ed.addEventListener('keydown', function (e) { if (e.key === 'Tab') { e.preventDefault(); var s = ed.selectionStart; ed.value = ed.value.slice(0, s) + '  ' + ed.value.slice(ed.selectionEnd); ed.selectionStart = ed.selectionEnd = s + 2; } });
      if (runBtn) runBtn.onclick = function () {
        var r = runJava(ed.value);
        if (!con) return;
        if (r.err) con.innerHTML = '<span class="err">✗ ' + esc(r.err) + '</span>';
        else if (!r.out.length) con.innerHTML = '<span class="muted">// (no output — add a println!)</span>';
        else con.innerHTML = r.out.map(esc).join('\n');
      };
      if (tryBtn) tryBtn.onclick = function () { var ex = tryBtn.getAttribute('data-try'); if (ex) { ed.value = ex.replace(/\\n/g, '\n'); if (runBtn) runBtn.click(); } };
    });

    show(0, true); updateScore();
    return { show: show, runJava: runJava };
  }

  window.LessonEngine = { mount: mount, runJava: runJava };
})();
