/* ============================================================================
   anim.js — motion choreography for the Omnius deck
   ----------------------------------------------------------------------------
   Backbone: GSAP (entrance choreography) + Three.js (divider & hero WebGL).
   Single hook: the `slidechange` CustomEvent dispatched by app.js' go().

   Design rules honoured here:
   - Never touches copy/markup content; only animates existing nodes.
   - Never blocks the deck's click-to-navigate (all overlays pointer-events:none).
   - prefers-reduced-motion + weak-GPU  ->  calm, near-static fallback.
   - Transforms/opacity only. Per-slide lazy init; WebGL paused when offscreen.
   - All feel lives in TIMING below so it's tunable in one place.
   ========================================================================== */
(function () {
  'use strict';

  var gsap = window.gsap;
  var THREE = window.THREE;

  // If GSAP failed to load, do nothing: the CSS `rise` fallback stays in charge.
  if (!gsap) return;

  /* ------------------------------------------------------------------ config */
  // One place to tune the whole deck's feel.
  var TIMING = {
    ease:        'power3.out',     // primary entrance ease (mirrors --ease)
    easeHeavy:   'power4.out',     // the "lands heavy" ease (comparison)
    easeOut:     'power2.out',
    rise:        26,               // px travel for entrance rise
    dur:         0.55,             // base entrance duration
    durSlow:     0.9,
    stagger:     0.075,            // base stagger between [data-r] groups
    staggerCard: 0.06,            // stagger between cards within a group
    countUp:     1.15,             // stat count-up duration
    draw:        0.9,              // svg connector draw-on duration
    packet:      1.4               // traveling packet loop duration
  };

  /* -------------------------------------------------------- capability flags */
  var reduceMotion = window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  var isTouch = ('ontouchstart' in window) ||
    (navigator.maxTouchPoints > 0);

  // Decide whether WebGL is worth running. Cheap heuristic — we only need
  // an atmospheric particle field, not a game engine.
  var webglOK = (function () {
    if (reduceMotion) return false;
    if (!THREE) return false;
    try {
      var c = document.createElement('canvas');
      var gl = c.getContext('webgl') || c.getContext('experimental-webgl');
      if (!gl) return false;
      // Bail on very small / very dense displays where particle fields cost most.
      if (isTouch && Math.min(window.innerWidth, window.innerHeight) < 600) return false;
      return true;
    } catch (e) { return false; }
  })();

  // Particle budget scaled to device — keeps weak GPUs honest.
  var dpr = Math.min(window.devicePixelRatio || 1, 2);

  // Mark the document so CSS hands entrance control to GSAP.
  document.body.classList.add('js-anim');
  if (reduceMotion) document.body.classList.add('reduce-motion');
  if (!webglOK) document.body.classList.add('no-webgl');

  /* ----------------------------------------------------------------- helpers */
  var slides = [].slice.call(document.querySelectorAll('.slide'));

  // The staggered-reveal elements within a slide, in author order.
  function risers(slide) {
    return [].slice.call(slide.querySelectorAll('[data-r]'));
  }

  // Reduced-motion: place everything at its final state instantly, no motion.
  function settle(slide) {
    gsap.set(risers(slide), { clearProps: 'all', opacity: 1, y: 0 });
  }

  // Generic staggered fade+rise. Used as the default and by prose/card slides.
  // `opts.childStagger` additionally cascades direct grid children of any
  // container that holds several cards, so big card grids ripple in.
  function genericEnter(slide, opts) {
    opts = opts || {};
    var items = risers(slide);
    if (!items.length) return gsap.timeline();

    var tl = gsap.timeline();
    tl.fromTo(items,
      { opacity: 0, y: TIMING.rise },
      {
        opacity: 1, y: 0,
        duration: TIMING.dur,
        ease: TIMING.ease,
        stagger: TIMING.stagger
      });

    // Optional second-order cascade: ripple the cards inside a grid.
    if (opts.childStagger !== false) {
      var grids = slide.querySelectorAll('.cards, .capgrid, .prin, .fpillars, .status');
      grids.forEach(function (grid) {
        var kids = [].slice.call(grid.children);
        if (kids.length < 2) return;
        tl.fromTo(kids,
          { opacity: 0, y: TIMING.rise * 0.7 },
          {
            opacity: 1, y: 0,
            duration: TIMING.dur * 0.85,
            ease: TIMING.easeOut,
            stagger: TIMING.staggerCard
          },
          // overlap with the parent group's reveal so it doesn't feel serial
          '<0.12');
      });
    }
    return tl;
  }

  // Cover (slide 0): quiet, premium settle of the title block.
  function coverEnter(slide) {
    var items = risers(slide);
    var tl = gsap.timeline();
    tl.fromTo(items,
      { opacity: 0, y: TIMING.rise * 1.3 },
      {
        opacity: 1, y: 0,
        duration: TIMING.durSlow,
        ease: TIMING.ease,
        stagger: TIMING.stagger * 1.4
      });
    return tl;
  }

  /* ============================================================ WebGL field
     ONE shared renderer/canvas, fixed behind the deck, reused by all three
     dividers. Renders only while a divider is active (RAF stopped otherwise),
     fades out on non-dividers. Each divider gets a distinct wireframe motif
     ("trading core / network") over a slow green/lime particle drift.
     Skipped entirely when webglOK is false -> CSS gradient fallback shows. */
  var Field = (function () {
    var holder, renderer, camera, scene, group, raf = null, built = false;
    var pointer = { x: 0, y: 0, tx: 0, ty: 0 };
    var variants = {};        // slide index -> { group, color }
    var activeVariant = null;
    var stopToken = 0;        // bumped on every enter; guards the deferred stop
    var t = 0;

    // Palette pulled from the deck's CSS variables.
    var GREEN = 0x00d4a1, LIME = 0x00f0b5, BLUE = 0x2962ff;

    function build() {
      if (built) return;
      built = true;

      holder = document.createElement('div');
      holder.className = 'fx-webgl';
      document.body.insertBefore(holder, document.getElementById('deck'));

      renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
      renderer.setPixelRatio(dpr);
      renderer.setSize(window.innerWidth, window.innerHeight);
      holder.appendChild(renderer.domElement);
      renderer.domElement.className = 'fx-canvas';

      scene = new THREE.Scene();
      camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 100);
      camera.position.z = 18;

      // Desktop parallax — subtle camera lean toward the cursor.
      if (!isTouch) {
        window.addEventListener('pointermove', function (e) {
          pointer.tx = (e.clientX / window.innerWidth - 0.5);
          pointer.ty = (e.clientY / window.innerHeight - 0.5);
        });
      }
      window.addEventListener('resize', onResize);
    }

    function onResize() {
      if (!renderer) return;
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(window.innerWidth, window.innerHeight);
    }

    // Particle slab — shared shape, colour varies per divider.
    function makeParticles(color) {
      var count = Math.round((isTouch ? 320 : 720) * (dpr >= 2 ? 1 : 0.8));
      var pos = new Float32Array(count * 3);
      for (var i = 0; i < count; i++) {
        pos[i * 3]     = (Math.random() - 0.5) * 46;
        pos[i * 3 + 1] = (Math.random() - 0.5) * 28;
        pos[i * 3 + 2] = (Math.random() - 0.5) * 24;
      }
      var geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      var mat = new THREE.PointsMaterial({
        color: color, size: 0.13, transparent: true, opacity: 0.55,
        blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true
      });
      return new THREE.Points(geo, mat);
    }

    // Wireframe motif — the "core". A low-poly solid, lightly glowing edges.
    function makeMotif(kind, color) {
      var geo;
      if (kind === 'ico')        geo = new THREE.IcosahedronGeometry(6.2, 1);
      else if (kind === 'torus') geo = new THREE.TorusKnotGeometry(4.4, 1.1, 90, 12);
      else                       geo = new THREE.OctahedronGeometry(6.6, 1);
      var wire = new THREE.WireframeGeometry(geo);
      var mat = new THREE.LineBasicMaterial({
        color: color, transparent: true, opacity: 0.16,
        blending: THREE.AdditiveBlending, depthWrite: false
      });
      geo.dispose();
      return new THREE.LineSegments(wire, mat);
    }

    // Build (and cache) the scene group for a given divider index.
    function variantFor(idx) {
      if (variants[idx]) return variants[idx];
      var conf = ({
        3:  { motif: 'ico',   color: GREEN, accent: LIME },
        13: { motif: 'octa',  color: LIME,  accent: GREEN },
        15: { motif: 'torus', color: GREEN, accent: BLUE }
      })[idx] || { motif: 'ico', color: GREEN, accent: LIME };

      var g = new THREE.Group();
      g.add(makeParticles(conf.color));
      var motif = makeMotif(conf.motif, conf.accent);
      g.userData.motif = motif;
      g.add(motif);
      g.visible = false;
      scene.add(g);
      variants[idx] = g;
      return g;
    }

    function tick() {
      raf = requestAnimationFrame(tick);
      t += 0.0045;
      // ease parallax
      pointer.x += (pointer.tx - pointer.x) * 0.04;
      pointer.y += (pointer.ty - pointer.y) * 0.04;
      camera.position.x = pointer.x * 4;
      camera.position.y = -pointer.y * 3;
      camera.lookAt(0, 0, 0);
      if (activeVariant) {
        activeVariant.rotation.y = t * 0.6;
        activeVariant.rotation.x = Math.sin(t * 0.4) * 0.12;
        var m = activeVariant.userData.motif;
        if (m) { m.rotation.y = -t * 0.9; m.rotation.z = t * 0.35; }
      }
      renderer.render(scene, camera);
    }

    return {
      // Show the field for a divider; returns a teardown that pauses it.
      enter: function (idx) {
        if (!webglOK) return null;
        build();
        var token = ++stopToken;                 // invalidate any pending stop
        if (activeVariant) activeVariant.visible = false;
        activeVariant = variantFor(idx);
        activeVariant.visible = true;
        onResize();
        // Show via CSS class (synchronous, transition-driven) — can't get stuck.
        document.body.classList.add('field-on');
        if (!raf) tick();
        return function () {
          // Hide immediately (CSS fades it out); stop the RAF once it's invisible,
          // unless we've re-entered a divider in the meantime (token changed).
          document.body.classList.remove('field-on');
          var mine = stopToken;
          setTimeout(function () {
            if (stopToken !== mine) return;       // re-entered — keep rendering
            if (raf) { cancelAnimationFrame(raf); raf = null; }
            if (activeVariant) { activeVariant.visible = false; activeVariant = null; }
          }, 650);
        };
      }
    };
  })();

  /* ========================================================= CoverFX (hero)
     Slide 0 only. "Speed & precision": fast parallel light streaks race across
     the frame (the wire / the tape at light speed) through a crisp, steadily
     rotating wireframe core (exact geometry). Low-contrast green/lime so the
     title stays dominant. Own context; shown only on the cover, RAF paused off
     it. Skipped entirely when webglOK is false -> the static cover stays. */
  var CoverFX = (function () {
    var holder, renderer, camera, scene, core, streaks, sPos, sVel, sLen, N = 0;
    var raf = null, built = false, stopToken = 0, t = 0;
    var pointer = { x: 0, y: 0, tx: 0, ty: 0 };
    var SPAN_X = 30, SPAN_Y = 17, SPAN_Z = 14;

    function build() {
      built = true;
      holder = document.createElement('div');
      holder.className = 'fx-cover';
      document.body.insertBefore(holder, document.getElementById('deck'));

      renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
      renderer.setPixelRatio(dpr);
      renderer.setSize(window.innerWidth, window.innerHeight);
      renderer.domElement.className = 'fx-canvas';
      holder.appendChild(renderer.domElement);

      scene = new THREE.Scene();
      camera = new THREE.PerspectiveCamera(58, window.innerWidth / window.innerHeight, 0.1, 200);
      camera.position.set(0, 0, 22);

      // Precise core — a clean wireframe lattice, steady rotation = precision.
      var geo = new THREE.IcosahedronGeometry(5.4, 1);
      var wire = new THREE.WireframeGeometry(geo);
      geo.dispose();
      core = new THREE.LineSegments(wire, new THREE.LineBasicMaterial({
        color: 0x00d4a1, transparent: true, opacity: 0.14,
        blending: THREE.AdditiveBlending, depthWrite: false
      }));
      scene.add(core);

      // Streaks — 2 verts each (tail->head). Parallel lanes = precision;
      // high velocity + long tail = speed. Per-vertex colour fades the trail.
      N = isTouch ? 70 : 150;
      sPos = new Float32Array(N * 2 * 3);
      var col = new Float32Array(N * 2 * 3);
      sVel = new Float32Array(N);
      sLen = new Float32Array(N);
      var LANES = 26;
      for (var i = 0; i < N; i++) {
        spawn(i, true);
        // tail colour (near-black), head colour (muted desaturated teal-green)
        col[i * 6 + 0] = 0.0;  col[i * 6 + 1] = 0.05; col[i * 6 + 2] = 0.04;
        col[i * 6 + 3] = 0.05; col[i * 6 + 4] = 0.34; col[i * 6 + 5] = 0.28;
      }
      // quantise lanes after spawn for a crisp, gridded look
      for (i = 0; i < N; i++) {
        var lane = Math.round(((sPos[i * 6 + 1] / SPAN_Y) * 0.5 + 0.5) * (LANES - 1));
        var y = ((lane / (LANES - 1)) - 0.5) * 2 * SPAN_Y;
        sPos[i * 6 + 1] = y; sPos[i * 6 + 4] = y;
      }
      var sg = new THREE.BufferGeometry();
      sg.setAttribute('position', new THREE.BufferAttribute(sPos, 3));
      sg.setAttribute('color', new THREE.BufferAttribute(col, 3));
      streaks = new THREE.LineSegments(sg, new THREE.LineBasicMaterial({
        vertexColors: true, transparent: true, opacity: 0.5,
        blending: THREE.AdditiveBlending, depthWrite: false
      }));
      scene.add(streaks);

      if (!isTouch) {
        window.addEventListener('pointermove', function (e) {
          pointer.tx = (e.clientX / window.innerWidth - 0.5);
          pointer.ty = (e.clientY / window.innerHeight - 0.5);
        });
      }
      window.addEventListener('resize', onResize);
    }

    // Place streak i; `seed` randomises x across the span, else starts at left.
    function spawn(i, seed) {
      var x = seed ? (Math.random() * 2 - 1) * SPAN_X : -SPAN_X - Math.random() * 6;
      var y = (Math.random() * 2 - 1) * SPAN_Y;
      // Bias depth behind the core (z<0) so streaks read as background, smaller & dimmer.
      var z = -5 - Math.random() * SPAN_Z;
      sVel[i] = 0.34 + Math.random() * 0.42;          // fast
      sLen[i] = 2.0 + Math.random() * 2.8;            // trail length
      sPos[i * 6 + 0] = x - sLen[i]; sPos[i * 6 + 1] = y; sPos[i * 6 + 2] = z; // tail
      sPos[i * 6 + 3] = x;           sPos[i * 6 + 4] = y; sPos[i * 6 + 5] = z; // head
    }

    function onResize() {
      if (!renderer) return;
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(window.innerWidth, window.innerHeight);
    }

    function tick() {
      raf = requestAnimationFrame(tick);
      t += 0.01;
      for (var i = 0; i < N; i++) {
        var head = sPos[i * 6 + 3] + sVel[i];
        if (head - sLen[i] > SPAN_X + 2) {            // fully off the right edge
          var y = sPos[i * 6 + 1], z = sPos[i * 6 + 2];
          head = -SPAN_X - Math.random() * 4;
          sVel[i] = 0.34 + Math.random() * 0.42;
          sPos[i * 6 + 1] = y; sPos[i * 6 + 4] = y;   // keep the lane (precision)
          sPos[i * 6 + 2] = z;
        }
        sPos[i * 6 + 0] = head - sLen[i];             // tail x
        sPos[i * 6 + 3] = head;                       // head x
      }
      streaks.geometry.attributes.position.needsUpdate = true;

      core.rotation.y += 0.0052;                      // steady, exact
      core.rotation.x = Math.sin(t * 0.25) * 0.18;

      pointer.x += (pointer.tx - pointer.x) * 0.05;
      pointer.y += (pointer.ty - pointer.y) * 0.05;
      camera.position.x = pointer.x * 3.5;
      camera.position.y = -pointer.y * 2.5;
      camera.lookAt(0, 0, 0);
      renderer.render(scene, camera);
    }

    return {
      enter: function () {
        if (!webglOK) return null;
        if (!built) build();
        var mine = ++stopToken;
        onResize();
        document.body.classList.add('cover-fx-on');
        if (!raf) tick();
        return function () {
          document.body.classList.remove('cover-fx-on');
          setTimeout(function () {
            if (stopToken !== mine) return;
            if (raf) { cancelAnimationFrame(raf); raf = null; }
          }, 1000);
        };
      }
    };
  })();

  // Divider entrance: WebGL field + a confident reveal of the big letter + text.
  function dividerEnter(slide) {
    var idx = indexOf(slide);
    var num = slide.querySelector('.dnum');
    var h = slide.querySelector('h1');
    var sub = slide.querySelector('.sub');

    if (!reduceMotion) {
      var tl = gsap.timeline();
      if (num) tl.fromTo(num, { opacity: 0, scale: 0.6, y: 10 },
        { opacity: 1, scale: 1, y: 0, duration: 0.9, ease: 'power4.out' });
      if (h) tl.fromTo(h, { opacity: 0, y: 24 },
        { opacity: 1, y: 0, duration: 0.7, ease: TIMING.ease }, '-0.45');
      if (sub) tl.fromTo(sub, { opacity: 0, y: 14, letterSpacing: '0.5em' },
        { opacity: 1, y: 0, letterSpacing: '0.18em', duration: 0.8, ease: 'power2.out' }, '-0.4');
    }

    var teardown = Field.enter(idx);   // null when webglOK is false
    return teardown || undefined;
  }

  /* ========================================================= ArchFlow (hero)
     Contained WebGL canvas BEHIND the existing HTML tier diagram on slide 5.
     Particles stream top->bottom (Edge -> Core -> Data) to dramatise flow
     direction; the readable HTML diagram sits on top, untouched. Singleton,
     one context, rebuilt size on each enter, RAF stopped on exit. */
  var ArchFlow = (function () {
    var built = false, renderer, scene, camera, points, posAttr, vel, count = 0, raf = null, host = null;

    function build(arch) {
      built = true;
      host = arch;
      renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
      renderer.setPixelRatio(dpr);
      renderer.domElement.className = 'arch-flow';
      arch.appendChild(renderer.domElement);

      scene = new THREE.Scene();
      // Orthographic in normalised [0,1] space so positions map to the box.
      camera = new THREE.OrthographicCamera(0, 1, 1, 0, -10, 10);

      count = isTouch ? 90 : 170;
      var pos = new Float32Array(count * 3);
      vel = new Float32Array(count);
      for (var i = 0; i < count; i++) {
        pos[i * 3]     = Math.random();
        pos[i * 3 + 1] = Math.random();
        pos[i * 3 + 2] = 0;
        vel[i] = 0.0009 + Math.random() * 0.0019;
      }
      var geo = new THREE.BufferGeometry();
      posAttr = new THREE.BufferAttribute(pos, 3);
      geo.setAttribute('position', posAttr);
      var mat = new THREE.PointsMaterial({
        color: 0x00f0b5, size: 2.4 * dpr, sizeAttenuation: false,
        transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending, depthWrite: false
      });
      points = new THREE.Points(geo, mat);
      scene.add(points);
    }

    function resize() {
      if (!renderer || !host) return;
      var w = host.clientWidth || 1, h = host.clientHeight || 1;
      renderer.setSize(w, h, false);
    }

    function tick() {
      raf = requestAnimationFrame(tick);
      var a = posAttr.array;
      for (var i = 0; i < count; i++) {
        a[i * 3 + 1] -= vel[i];
        if (a[i * 3 + 1] < -0.03) { a[i * 3 + 1] = 1.03; a[i * 3] = Math.random(); }
      }
      posAttr.needsUpdate = true;
      renderer.render(scene, camera);
    }

    return {
      enter: function (arch) {
        if (!webglOK) return null;
        if (!built) build(arch);
        resize();
        gsap.fromTo(renderer.domElement, { opacity: 0 }, { opacity: 1, duration: 1.0, ease: 'power2.out' });
        if (!raf) tick();
        return function () {
          if (raf) { cancelAnimationFrame(raf); raf = null; }
          if (renderer) gsap.set(renderer.domElement, { opacity: 0 });
        };
      }
    };
  })();

  // Slide 5 — assemble the tier diagram in data-flow order, then run the flow.
  function archEnter(slide) {
    var arch = slide.querySelector('.arch');
    var rest = risers(slide).filter(function (n) { return n !== arch; });
    var teardown;

    if (reduceMotion) { teardown = ArchFlow.enter(arch); return teardown || undefined; }

    var tl = gsap.timeline();
    tl.fromTo(rest, { opacity: 0, y: TIMING.rise },
      { opacity: 1, y: 0, duration: TIMING.dur, ease: TIMING.ease, stagger: TIMING.stagger });

    if (arch) {
      tl.set(arch, { opacity: 1 }, 0);
      // Reveal tiers + the ↓ connectors strictly top -> bottom.
      var rows = [].slice.call(arch.children); // tier, down, tier, down, tier
      tl.fromTo(rows,
        { opacity: 0, y: 18 },
        { opacity: 1, y: 0, duration: 0.5, ease: 'power2.out', stagger: 0.13 }, '-0.1');
      // Ripple the boxes within each tier as it lands.
      arch.querySelectorAll('.tier').forEach(function (tier, ti) {
        tl.fromTo(tier.querySelectorAll('.box2'),
          { opacity: 0, y: 10 },
          { opacity: 1, y: 0, duration: 0.4, ease: 'power2.out', stagger: 0.04 },
          0.35 + ti * 0.13 * 2);
      });
      // Emphasis pulse on the Core tier once assembled.
      var core = arch.querySelector('.tier.core');
      if (core) tl.fromTo(core, { boxShadow: '0 0 0 0 rgba(0,212,161,0)' },
        { boxShadow: '0 0 38px -6px rgba(0,212,161,.55)', duration: 0.5, yoyo: true, repeat: 1, ease: 'sine.inOut' }, '>-0.1');
    }

    teardown = ArchFlow.enter(arch);
    return teardown || undefined;
  }

  // Slide 7 — two models converge on the Smart Router in the middle.
  function colpairEnter(slide) {
    if (reduceMotion) { return; }
    var pair = slide.querySelector('.colpair');
    var rest = risers(slide).filter(function (n) { return n !== pair; });
    var tl = gsap.timeline();
    tl.fromTo(rest, { opacity: 0, y: TIMING.rise },
      { opacity: 1, y: 0, duration: TIMING.dur, ease: TIMING.ease, stagger: TIMING.stagger });
    if (pair) {
      tl.set(pair, { opacity: 1 }, 0);
      var cols = pair.querySelectorAll('.col');
      var mid = pair.querySelector('.mid');
      if (cols[0]) tl.fromTo(cols[0], { opacity: 0, x: -34 }, { opacity: 1, x: 0, duration: 0.6, ease: TIMING.ease }, '-0.1');
      if (cols[1]) tl.fromTo(cols[1], { opacity: 0, x: 34 }, { opacity: 1, x: 0, duration: 0.6, ease: TIMING.ease }, '<');
      if (mid) tl.fromTo(mid, { opacity: 0, scale: 0.6 }, { opacity: 1, scale: 1, duration: 0.55, ease: 'back.out(2)' }, '-0.25');
    }
  }

  // Slide 8 — liquidity assembles left->right; light packets ride the pipes.
  function liqEnter(slide) {
    if (reduceMotion) { return; }
    var flow = slide.querySelector('.liq-flow');
    var rest = risers(slide).filter(function (n) { return n !== flow; });
    var tl = gsap.timeline();
    tl.fromTo(rest, { opacity: 0, y: TIMING.rise },
      { opacity: 1, y: 0, duration: TIMING.dur, ease: TIMING.ease, stagger: TIMING.stagger });
    if (flow) {
      tl.set(flow, { opacity: 1 }, 0);
      tl.fromTo([].slice.call(flow.children),
        { opacity: 0, y: 16 },
        { opacity: 1, y: 0, duration: 0.5, ease: 'power2.out', stagger: 0.1 }, '-0.1');
      // Add a travelling packet to each pipe (idempotent — guard against re-entry).
      flow.querySelectorAll('.liq-pipe-wrap').forEach(function (wrap) {
        if (wrap.querySelector('.liq-packet')) return;
        var p = document.createElement('i');
        p.className = 'liq-packet';
        wrap.appendChild(p);
        var ptl = gsap.timeline({ repeat: -1, repeatDelay: 0.15 });
        ptl.fromTo(p, { left: '0%', opacity: 0 }, { left: '12%', opacity: 1, duration: TIMING.packet * 0.18, ease: 'none' })
           .to(p, { left: '88%', duration: TIMING.packet * 0.64, ease: 'none' })
           .to(p, { left: '100%', opacity: 0, duration: TIMING.packet * 0.18, ease: 'none' });
      });
    }
  }

  // Slide 17 — AI assembly line: stepped reveal that narrates the pipeline.
  // The two parallel reviewers (the .pair) reveal together; Orchestrator last.
  function pipelineEnter(slide) {
    if (reduceMotion) { return; }
    var flow = slide.querySelector('.aflow');
    var rest = risers(slide).filter(function (n) { return n !== flow; });
    var tl = gsap.timeline();
    tl.fromTo(rest, { opacity: 0, y: TIMING.rise },
      { opacity: 1, y: 0, duration: TIMING.dur, ease: TIMING.ease, stagger: TIMING.stagger });
    if (flow) {
      tl.set(flow, { opacity: 1 }, 0);
      [].slice.call(flow.children).forEach(function (child) {
        if (child.classList.contains('pair')) {
          // both reviewers in, simultaneously
          tl.fromTo(child.querySelectorAll('.node'),
            { opacity: 0, y: 14, scale: 0.97 },
            { opacity: 1, y: 0, scale: 1, duration: 0.45, ease: 'power2.out', stagger: 0 }, '+=0.04');
        } else if (child.classList.contains('node')) {
          tl.fromTo(child, { opacity: 0, x: -14 },
            { opacity: 1, x: 0, duration: 0.4, ease: 'power2.out' }, '+=0.07');
        } else { // the ↓ connector labels
          tl.fromTo(child, { opacity: 0 }, { opacity: 1, duration: 0.25, ease: 'none' }, '+=0.02');
        }
      });
      // Orchestrator (06, red tag) lands with a confirming pulse.
      var orchTag = flow.querySelector('.tg.rd');
      var orch = orchTag ? orchTag.closest('.node') : null;
      if (orch) tl.fromTo(orch, { boxShadow: '0 0 0 0 rgba(255,71,87,0)' },
        { boxShadow: '0 0 26px -6px rgba(255,71,87,.6)', duration: 0.45, yoyo: true, repeat: 1, ease: 'sine.inOut' }, '>-0.05');
    }
  }

  // Slide 13 — stat "emphasis snap": numbers scale+blur in and snap sharp.
  // Plays the full snap on first view; quiet fade on revisits (less nagging).
  function statEnter(slide) {
    var stats = slide.querySelector('.stats');
    var rest = risers(slide).filter(function (n) { return n !== stats; });

    if (reduceMotion) { return; }

    var tl = gsap.timeline();
    tl.fromTo(rest, { opacity: 0, y: TIMING.rise },
      { opacity: 1, y: 0, duration: TIMING.dur, ease: TIMING.ease, stagger: TIMING.stagger });

    if (!stats) return;
    tl.set(stats, { opacity: 1 }, 0);
    var cells = [].slice.call(stats.querySelectorAll('.s'));
    var firstView = !slide.dataset.statShown;
    slide.dataset.statShown = '1';

    if (!firstView) {
      tl.fromTo(cells, { opacity: 0 }, { opacity: 1, duration: 0.4, ease: 'power2.out', stagger: 0.05 }, '-0.1');
      return;
    }

    cells.forEach(function (cell, idx) {
      var n = cell.querySelector('.n');
      var c = cell.querySelector('.c');
      var at = 0.18 + idx * 0.13;
      tl.fromTo(cell, { opacity: 0 }, { opacity: 1, duration: 0.3, ease: 'none' }, at);
      if (n) tl.fromTo(n,
        { scale: 1.45, filter: 'blur(9px)', opacity: 0 },
        { scale: 1, filter: 'blur(0px)', opacity: 1, duration: 0.55, ease: 'power4.out' }, at);
      // unit emphasis flash on snap
      if (n) tl.fromTo(n, { color: '#ffffff' },
        { color: '', duration: 0.5, ease: 'power2.out', clearProps: 'color' }, at + 0.1);
      if (c) tl.fromTo(c, { opacity: 0, y: 6 }, { opacity: 1, y: 0, duration: 0.4, ease: 'power2.out' }, at + 0.18);
    });
  }

  // Slide 19 — comparison: Adaptive lands heavy & slow; Omnius resolves fast.
  function compareEnter(slide) {
    if (reduceMotion) { return; }
    var cmp = slide.querySelector('.compare');
    var rest = risers(slide).filter(function (n) { return n !== cmp; });
    var tl = gsap.timeline();
    tl.fromTo(rest, { opacity: 0, y: TIMING.rise },
      { opacity: 1, y: 0, duration: TIMING.dur, ease: TIMING.ease, stagger: TIMING.stagger });
    if (cmp) {
      tl.set(cmp, { opacity: 1 }, 0);
      var them = cmp.querySelector('.side.them');
      var us = cmp.querySelector('.side.us');
      // expensive side: heavy, slow, settles with weight
      if (them) tl.fromTo(them, { opacity: 0, y: 46, scale: 0.98 },
        { opacity: 1, y: 0, scale: 1, duration: TIMING.durSlow, ease: TIMING.easeHeavy }, '-0.05');
      // Omnius side: snaps in fast and confident, just after
      if (us) tl.fromTo(us, { opacity: 0, y: 22, scale: 0.96 },
        { opacity: 1, y: 0, scale: 1, duration: 0.4, ease: 'back.out(1.7)' }, '-0.35');
      if (us) tl.fromTo(us, { boxShadow: '0 0 0 0 rgba(0,212,161,0)' },
        { boxShadow: '0 0 55px -28px rgba(0,212,161,1)', duration: 0.5, ease: 'power2.out', clearProps: 'boxShadow' }, '>-0.2');
    }
  }

  /* ======================================================= TVChart (slide 11)
     Canvas 2D animated candlestick chart mimicking a TradingView panel.
     Candles draw in left→right on enter; current-price dashed line pulses
     once all candles are shown. RAF is stopped when the slide exits. */
  var TVChart = (function () {
    var canvas, ctx, raf = null, proxy = { v: 0 };
    var candles = [], N = 30, progress = 0, t = 0;

    function gen() {
      candles = [];
      var price = 1.08056;
      for (var i = 0; i < N; i++) {
        var open  = price;
        var bias  = i < N * 0.55 ? 0.52 : 0.45;
        var move  = (Math.random() - bias) * 0.0020;
        var close = open + move;
        var high  = Math.max(open, close) + Math.random() * 0.0006;
        var low   = Math.min(open, close) - Math.random() * 0.0006;
        candles.push({ o: open, h: high, l: low, c: close });
        price = close;
      }
    }

    function resize() {
      if (!canvas) return;
      var p = canvas.parentElement;
      if (!p) return;
      var r = p.getBoundingClientRect();
      var W = r.width || 460, H = r.height || 218;
      canvas.width  = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
      canvas.style.width  = W + 'px';
      canvas.style.height = H + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    function draw() {
      if (!ctx || !candles.length) return;
      var W = canvas.width / dpr, H = canvas.height / dpr;
      ctx.clearRect(0, 0, W, H);
      var vis = Math.min(Math.ceil(progress), N);
      if (!vis) return;

      var hi = candles.reduce(function (m, c) { return Math.max(m, c.h); }, -Infinity);
      var lo = candles.reduce(function (m, c) { return Math.min(m, c.l); },  Infinity);
      var rng = hi - lo || 0.001;
      var pad = { l: 6, r: 58, t: 10, b: 22 };
      var cW = W - pad.l - pad.r, cH = H - pad.t - pad.b;
      var slotW = cW / N, bodyW = Math.max(2, slotW * 0.56);

      function py(p) { return pad.t + cH * (1 - (p - lo) / rng); }

      // Grid
      ctx.textAlign = 'right';
      ctx.font = '8.5px Roboto Mono, monospace';
      for (var gi = 0; gi <= 4; gi++) {
        var gp = lo + rng * gi / 4;
        var gy = py(gp);
        ctx.strokeStyle = 'rgba(43,49,58,0.65)';
        ctx.lineWidth = 1;
        ctx.setLineDash([2, 6]);
        ctx.beginPath(); ctx.moveTo(pad.l, gy); ctx.lineTo(pad.l + cW, gy); ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = 'rgba(100,108,118,0.62)';
        ctx.fillText(gp.toFixed(4), W - 4, gy + 3);
      }

      // Volume bars (deterministic sizing so they don't jump on redraws)
      var vZone = cH * 0.22;
      for (var vi = 0; vi < vis; vi++) {
        var vA = vi === vis - 1 ? Math.min(1, progress - vi + 1) : 1;
        var vx = pad.l + vi * slotW + slotW / 2;
        var vh = (0.28 + ((vi * 17 + 7) % 11) / 11 * 0.72) * vZone;
        ctx.globalAlpha = vA * 0.5;
        ctx.fillStyle = candles[vi].c >= candles[vi].o
          ? 'rgba(0,212,161,0.4)' : 'rgba(255,71,87,0.35)';
        ctx.fillRect(vx - bodyW / 2, H - pad.b - vh, bodyW, vh);
      }
      ctx.globalAlpha = 1;

      // MA-5 line
      if (vis >= 5) {
        ctx.strokeStyle = 'rgba(41,98,255,0.5)';
        ctx.lineWidth = 1.4;
        ctx.setLineDash([]);
        ctx.beginPath();
        for (var mi = 4; mi < vis; mi++) {
          var ma = 0;
          for (var mj = mi - 4; mj <= mi; mj++) ma += candles[mj].c;
          ma /= 5;
          var mx = pad.l + mi * slotW + slotW / 2;
          ctx.globalAlpha = mi === vis - 1 ? Math.min(1, progress - mi + 1) : 1;
          if (mi === 4) ctx.moveTo(mx, py(ma)); else ctx.lineTo(mx, py(ma));
        }
        ctx.stroke();
        ctx.globalAlpha = 1;
      }

      // Candles
      for (var ci = 0; ci < vis; ci++) {
        var c  = candles[ci];
        var ca = ci === vis - 1 ? Math.min(1, progress - ci + 1) : 1;
        var cx = pad.l + ci * slotW + slotW / 2;
        var up = c.c >= c.o;
        ctx.globalAlpha = ca;
        ctx.strokeStyle = up ? '#00d4a1' : '#ff4757';
        ctx.lineWidth = 1; ctx.setLineDash([]);
        ctx.beginPath(); ctx.moveTo(cx, py(c.h)); ctx.lineTo(cx, py(c.l)); ctx.stroke();
        var bT = py(Math.max(c.o, c.c)), bB = py(Math.min(c.o, c.c));
        ctx.fillStyle = up ? 'rgba(0,212,161,0.9)' : 'rgba(255,71,87,0.85)';
        ctx.fillRect(cx - bodyW / 2, bT, bodyW, Math.max(1.5, bB - bT));
      }
      ctx.globalAlpha = 1;

      // Current-price line + pulsing tag once all candles are visible
      if (progress >= N - 0.05) {
        var last  = candles[N - 1].c;
        var ly    = py(last);
        var pulse = 0.5 + 0.5 * Math.sin(t * 2.6);
        ctx.strokeStyle = 'rgba(0,212,161,' + (0.28 + 0.18 * pulse) + ')';
        ctx.lineWidth = 1; ctx.setLineDash([3, 5]);
        ctx.beginPath(); ctx.moveTo(pad.l, ly); ctx.lineTo(pad.l + cW, ly); ctx.stroke();
        ctx.setLineDash([]);
        var tW = 54, tH = 14, tX = pad.l + cW + 2, tY = ly - tH / 2;
        ctx.fillStyle = 'rgba(0,212,161,' + (0.82 + 0.18 * pulse) + ')';
        ctx.beginPath();
        if (ctx.roundRect) { ctx.roundRect(tX, tY, tW, tH, 3); } else { ctx.rect(tX, tY, tW, tH); }
        ctx.fill();
        ctx.fillStyle = '#08090b';
        ctx.font = 'bold 8.5px Roboto Mono, monospace';
        ctx.textAlign = 'center';
        ctx.fillText(last.toFixed(4), tX + tW / 2, ly + 3.2);
      }
    }

    function tick() { raf = requestAnimationFrame(tick); t += 0.016; draw(); }

    return {
      enter: function (wrap) {
        gen(); progress = 0; t = 0;
        if (!canvas) {
          canvas = document.createElement('canvas');
          canvas.style.cssText = 'display:block;width:100%;height:100%';
          ctx = canvas.getContext('2d');
        }
        wrap.innerHTML = '';
        wrap.appendChild(canvas);
        resize();
        gsap.killTweensOf(proxy);
        proxy.v = 0;
        gsap.to(proxy, {
          v: N, duration: N * 0.09, ease: 'power1.inOut',
          onUpdate: function () { progress = proxy.v; },
          onComplete: function () { progress = N; }
        });
        if (!raf) tick();
      },
      stop: function () {
        gsap.killTweensOf(proxy);
        if (raf) { cancelAnimationFrame(raf); raf = null; }
      }
    };
  })();

  function tvEnter(slide) {
    var kicker   = slide.querySelector('.kicker');
    var h1       = slide.querySelector('h1');
    var lede     = slide.querySelector('.lede');
    var tvBadges = slide.querySelector('.tv-badges');
    var badges   = [].slice.call(slide.querySelectorAll('.tv-badge'));
    var punch    = slide.querySelector('.punch');
    var chartCol = slide.querySelector('.tv-col-chart');
    var wrap     = slide.querySelector('.tv-canvas-wrap');

    if (reduceMotion) {
      gsap.set(risers(slide), { opacity: 1, y: 0 });
      if (chartCol) gsap.set(chartCol, { opacity: 1 });
      if (wrap) TVChart.enter(wrap);
      return function () { TVChart.stop(); };
    }

    var tl = gsap.timeline();

    // Text column — staggered rise
    tl.fromTo([kicker, h1, lede].filter(Boolean),
      { opacity: 0, y: TIMING.rise },
      { opacity: 1, y: 0, duration: TIMING.dur, ease: TIMING.ease, stagger: TIMING.stagger });

    // Badge container visible; individual badges slide in from left
    if (tvBadges) tl.set(tvBadges, { opacity: 1 }, 0);
    if (badges.length) {
      tl.fromTo(badges,
        { opacity: 0, x: -14 },
        { opacity: 1, x: 0, duration: 0.38, ease: 'power2.out', stagger: 0.1 }, '-0.05');
    }

    // Punch last
    if (punch) {
      tl.fromTo(punch, { opacity: 0, y: 10 },
        { opacity: 1, y: 0, duration: 0.38, ease: 'power2.out' }, '>-0.05');
    }

    // Chart panel slides in from right, simultaneous with the text column
    if (chartCol) {
      tl.fromTo(chartCol, { opacity: 0, x: 28, scale: 0.98 },
        { opacity: 1, x: 0, scale: 1, duration: 0.65, ease: TIMING.ease }, 0.14);
    }

    // Draw the chart after the panel has revealed
    if (wrap) {
      tl.add(function () { TVChart.enter(wrap); }, 0.52);
    }

    return function () { tl.kill(); TVChart.stop(); };
  }

  // Slide 12 — "Scaffolded": half-built high-rise + crane, hook lowering a floor panel.
  // Injected once as a background SVG; GSAP animates the hook lift cycle and the
  // newly-placed slab glow. Teardown kills the repeating tweens only.
  function scaffoldEnter(slide) {
    var firstTime = !slide.querySelector('.scaffold-scene');

    if (firstTime) {
      var scene = document.createElement('div');
      scene.className = 'scaffold-scene';
      // SVG: viewBox 0 0 230 315.
      // Building: x=25–185 (w=160). Completed floors y=152–305, scaffold y=84–152,
      // latest slab y=68–84. Crane mast x=179–186, jib y=18–23, hook at cx=70.
      var svg = '<svg viewBox="0 0 230 315" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">'
        + '<defs>'
        + '<pattern id="sc-wins" x="25" y="152" width="40" height="17" patternUnits="userSpaceOnUse">'
        + '<rect x="4" y="3" width="12" height="9" rx="1" fill="#0a1520" stroke="#19253a" stroke-width=".5"/>'
        + '<rect x="22" y="3" width="12" height="9" rx="1" fill="#0a1520" stroke="#19253a" stroke-width=".5"/>'
        + '</pattern>'
        + '</defs>'
        // ground glow + slab
        + '<ellipse cx="105" cy="310" rx="82" ry="6" fill="#00d4a1" fill-opacity=".25"/>'
        + '<rect x="25" y="305" width="160" height="5" rx="1" fill="#0d1014" stroke="#1e2535" stroke-width="1"/>'
        // completed building body + windows
        + '<rect x="25" y="152" width="160" height="153" fill="#0d1014"/>'
        + '<rect x="25" y="152" width="160" height="153" fill="url(#sc-wins)"/>'
        // floor lines
        + '<line x1="25" y1="169" x2="185" y2="169" stroke="#1e2535" stroke-width=".8"/>'
        + '<line x1="25" y1="186" x2="185" y2="186" stroke="#1e2535" stroke-width=".8"/>'
        + '<line x1="25" y1="203" x2="185" y2="203" stroke="#1e2535" stroke-width=".8"/>'
        + '<line x1="25" y1="220" x2="185" y2="220" stroke="#1e2535" stroke-width=".8"/>'
        + '<line x1="25" y1="237" x2="185" y2="237" stroke="#1e2535" stroke-width=".8"/>'
        + '<line x1="25" y1="254" x2="185" y2="254" stroke="#1e2535" stroke-width=".8"/>'
        + '<line x1="25" y1="271" x2="185" y2="271" stroke="#1e2535" stroke-width=".8"/>'
        + '<line x1="25" y1="288" x2="185" y2="288" stroke="#1e2535" stroke-width=".8"/>'
        // completed section outline
        + '<rect x="25" y="152" width="160" height="153" fill="none" stroke="#2a3040" stroke-width="1.5"/>'
        // scaffold verticals
        + '<line x1="25" y1="84" x2="25" y2="152" stroke="#1e2535" stroke-width="1.8"/>'
        + '<line x1="65" y1="84" x2="65" y2="152" stroke="#1e2535" stroke-width="1.2"/>'
        + '<line x1="105" y1="84" x2="105" y2="152" stroke="#1e2535" stroke-width="1.2"/>'
        + '<line x1="145" y1="84" x2="145" y2="152" stroke="#1e2535" stroke-width="1.2"/>'
        + '<line x1="185" y1="84" x2="185" y2="152" stroke="#1e2535" stroke-width="1.8"/>'
        // scaffold horizontals
        + '<line x1="25" y1="84" x2="185" y2="84" stroke="#1e2535" stroke-width="1.5"/>'
        + '<line x1="25" y1="101" x2="185" y2="101" stroke="#1e2535" stroke-width="1"/>'
        + '<line x1="25" y1="118" x2="185" y2="118" stroke="#1e2535" stroke-width="1"/>'
        + '<line x1="25" y1="135" x2="185" y2="135" stroke="#1e2535" stroke-width="1"/>'
        // scaffold diagonal bracing (zigzag per bay)
        + '<line x1="25" y1="84" x2="65" y2="101" stroke="#17222e" stroke-width=".8"/>'
        + '<line x1="65" y1="101" x2="25" y2="118" stroke="#17222e" stroke-width=".8"/>'
        + '<line x1="25" y1="118" x2="65" y2="135" stroke="#17222e" stroke-width=".8"/>'
        + '<line x1="65" y1="135" x2="25" y2="152" stroke="#17222e" stroke-width=".8"/>'
        + '<line x1="105" y1="84" x2="65" y2="101" stroke="#17222e" stroke-width=".8"/>'
        + '<line x1="65" y1="101" x2="105" y2="118" stroke="#17222e" stroke-width=".8"/>'
        + '<line x1="105" y1="118" x2="65" y2="135" stroke="#17222e" stroke-width=".8"/>'
        + '<line x1="65" y1="135" x2="105" y2="152" stroke="#17222e" stroke-width=".8"/>'
        + '<line x1="105" y1="84" x2="145" y2="101" stroke="#17222e" stroke-width=".8"/>'
        + '<line x1="145" y1="101" x2="105" y2="118" stroke="#17222e" stroke-width=".8"/>'
        + '<line x1="105" y1="118" x2="145" y2="135" stroke="#17222e" stroke-width=".8"/>'
        + '<line x1="145" y1="135" x2="105" y2="152" stroke="#17222e" stroke-width=".8"/>'
        + '<line x1="145" y1="84" x2="185" y2="101" stroke="#17222e" stroke-width=".8"/>'
        + '<line x1="185" y1="101" x2="145" y2="118" stroke="#17222e" stroke-width=".8"/>'
        + '<line x1="145" y1="118" x2="185" y2="135" stroke="#17222e" stroke-width=".8"/>'
        + '<line x1="185" y1="135" x2="145" y2="152" stroke="#17222e" stroke-width=".8"/>'
        // latest slab highlight (the floor the crane is placing)
        + '<rect class="s-topslab" x="25" y="68" width="160" height="16"'
        + ' fill="#00d4a1" fill-opacity=".07" stroke="#00d4a1" stroke-width="1" stroke-opacity=".4"/>'
        + '<line x1="65" y1="68" x2="65" y2="84" stroke="#00d4a1" stroke-width=".8" stroke-opacity=".3"/>'
        + '<line x1="105" y1="68" x2="105" y2="84" stroke="#00d4a1" stroke-width=".8" stroke-opacity=".3"/>'
        + '<line x1="145" y1="68" x2="145" y2="84" stroke="#00d4a1" stroke-width=".8" stroke-opacity=".3"/>'
        // crane mast
        + '<rect x="179" y="22" width="7" height="46" fill="#172028" stroke="#243040" stroke-width="1"/>'
        + '<line x1="179" y1="30" x2="186" y2="30" stroke="#243040" stroke-width=".5"/>'
        + '<line x1="179" y1="38" x2="186" y2="38" stroke="#243040" stroke-width=".5"/>'
        + '<line x1="179" y1="46" x2="186" y2="46" stroke="#243040" stroke-width=".5"/>'
        + '<line x1="179" y1="54" x2="186" y2="54" stroke="#243040" stroke-width=".5"/>'
        // jib (horizontal beam, full span)
        + '<rect x="18" y="18" width="205" height="5" fill="#172028" stroke="#243040" stroke-width=".8" rx="1"/>'
        // mast cap
        + '<rect x="176" y="14" width="14" height="6" rx="1" fill="#1a2838" stroke="#243040" stroke-width=".8"/>'
        // jib stay cables
        + '<line x1="182" y1="15" x2="22" y2="21" stroke="#1e2d3a" stroke-width=".8" opacity=".6"/>'
        + '<line x1="182" y1="15" x2="219" y2="21" stroke="#1e2d3a" stroke-width=".8" opacity=".6"/>'
        // counterweight
        + '<rect x="203" y="23" width="17" height="9" rx="1" fill="#192535" stroke="#243040" stroke-width=".8"/>'
        // pulley at trolley position on jib
        + '<circle cx="70" cy="20" r="2.5" fill="none" stroke="#243040" stroke-width="1"/>'
        // cable (y2 animated by GSAP)
        + '<line class="s-cable" x1="70" y1="23" x2="70" y2="48" stroke="#253545" stroke-width="1.5"/>'
        // load block — the floor panel being lowered (y animated by GSAP)
        + '<rect class="s-load" x="58" y="48" width="24" height="13" rx="1"'
        + ' fill="#0d1820" stroke="#00d4a1" stroke-width="1.2" stroke-opacity=".75"/>'
        + '</svg>';
      scene.innerHTML = svg;
      slide.insertBefore(scene, slide.firstChild);
    }

    if (reduceMotion) {
      gsap.set(slide.querySelector('.scaffold-scene'), { opacity: 0.2 });
      return;
    }

    var scene = slide.querySelector('.scaffold-scene');
    var cable = slide.querySelector('.s-cable');
    var load  = slide.querySelector('.s-load');
    var slab  = slide.querySelector('.s-topslab');

    // Text entrance (generic)
    genericEnter(slide);

    // Fade in illustration
    gsap.fromTo(scene, { opacity: 0 }, { opacity: 0.22, duration: 1.4, ease: 'power2.out', delay: 0.2 });

    // Gentle slab glow pulse
    if (slab) {
      gsap.fromTo(slab,
        { attr: { 'fill-opacity': '0.05', 'stroke-opacity': '0.3' } },
        { attr: { 'fill-opacity': '0.16', 'stroke-opacity': '0.65' },
          duration: 2.2, ease: 'sine.inOut', yoyo: true, repeat: -1 });
    }

    // Hook lowering cycle: load descends from y=48 (raised) to y=68 (placed)
    if (!cable || !load) return;
    var state = { y: 48 };
    var tw = gsap.to(state, {
      y: 68,
      duration: 2.8,
      ease: 'power1.inOut',
      yoyo: true,
      repeat: -1,
      repeatDelay: 0.8,
      onUpdate: function () {
        var y = String(Math.round(state.y));
        cable.setAttribute('y2', y);
        load.setAttribute('y', y);
      }
    });

    return function () { tw.kill(); gsap.killTweensOf(slab); };
  }

  // Slide 1 — the hero "leap": text + cards rise, then the leap arc draws on
  // with a glowing marker travelling from "Today (MT4/5)" up onto the owned
  // "Omnius" plateau. The flowing-dash energy on the arc is always-on CSS.
  function opportunityEnter(slide) {
    if (reduceMotion) return;           // settle() already revealed everything
    var tl = genericEnter(slide);       // headline + three cards rise/ripple

    var arc    = slide.querySelector('#leapArc');
    var marker = slide.querySelector('.leap-marker');
    var dest   = slide.querySelector('.leap-dest');

    if (arc && arc.getTotalLength) {
      var len = arc.getTotalLength();
      gsap.set(arc, { strokeDasharray: len, strokeDashoffset: len });
      tl.to(arc, { strokeDashoffset: 0, duration: 1.0, ease: 'power2.out' }, '-0.15');

      if (marker) {
        var mp = { d: 0 };
        gsap.set(marker, { attr: { cx: 268, cy: 146 }, opacity: 1 });
        tl.to(mp, {
          d: len, duration: 1.0, ease: 'power2.out',
          onUpdate: function () {
            var pt = arc.getPointAtLength(mp.d);
            marker.setAttribute('cx', pt.x);
            marker.setAttribute('cy', pt.y);
          }
        }, '<');
      }
    }

    if (dest) {
      tl.fromTo(dest, { opacity: 0 }, { opacity: 1, duration: 0.5, ease: 'power2.out' }, '-0.3');
    }
  }

  /* --------------------------------------------------------------- registry */
  // Map data-i -> { enter(slide), exit(slide) }. Anything without an entry
  // falls back to genericEnter. exit() is for tearing down per-slide effects
  // (WebGL, looping packets) so nothing runs while offscreen.
  var registry = {};

  // current per-slide teardown fn (set on enter, called on exit)
  var teardowns = {};

  function indexOf(slide) { return slides.indexOf(slide); }

  function runEnter(slide) {
    if (reduceMotion) { settle(slide);
      // reduced-motion still gets static WebGL handled inside specific enters
    }
    var i = indexOf(slide);
    var entry = registry[i];
    if (entry && entry.enter) {
      var td = entry.enter(slide);
      if (typeof td === 'function') teardowns[i] = td;
    } else {
      if (!reduceMotion) genericEnter(slide);
    }
  }

  function runExit(slide) {
    var i = indexOf(slide);
    if (teardowns[i]) { try { teardowns[i](); } catch (e) {} teardowns[i] = null; }
    var entry = registry[i];
    if (entry && entry.exit) entry.exit(slide);
  }

  // Cover — text settle + the "speed & precision" WebGL hero.
  registry[0] = { enter: function (s) {
    if (!reduceMotion) coverEnter(s);
    return CoverFX.enter() || undefined;   // null -> no teardown when no WebGL
  } };

  // Hero — the "leap" opportunity pitch.
  registry[1]  = { enter: opportunityEnter };

  // The cost/time proof — moved up to lead.
  registry[2]  = { enter: compareEnter };  // Adaptive vs Omnius

  // Section dividers A / B / C  ->  WebGL field + letter reveal.
  registry[3]  = { enter: dividerEnter };
  registry[13] = { enter: dividerEnter };
  registry[15] = { enter: dividerEnter };

  // Flow / architecture diagrams.
  registry[4] = { enter: archEnter };     // Edge->Core->Data (WebGL hero)
  registry[6] = { enter: colpairEnter };  // two models + smart router
  registry[7] = { enter: liqEnter };      // liquidity routing + packets
  // 5 = "Beyond MT4/MT5" open-platform/API slide -> generic entrance

  // Storytelling / data slides.
  registry[10] = { enter: tvEnter };       // TradingView — animated candlestick chart
  registry[11] = { enter: scaffoldEnter }; // Built to extend — crane + half-built high-rise
  registry[12] = { enter: statEnter };     // merged perf+eng: <2ms / 500K–1M+ / <1s / 24/7
  registry[14] = { enter: pipelineEnter }; // AI assembly-line

  /* ------------------------------------------------------------- the hook */
  var current = null;

  window.addEventListener('slidechange', function (e) {
    var idx = e.detail.index;
    var slide = slides[idx];
    if (!slide) return;
    if (current && current !== slide) runExit(current);
    current = slide;
    runEnter(slide);
  });

  // app.js dispatches slidechange only on navigation, and it ran before us,
  // so prime the currently-active slide ourselves.
  var active = document.querySelector('.slide.active') || slides[0];
  if (active) {
    // settle non-active slides' risers are hidden via CSS; reveal active.
    current = active;
    runEnter(active);
  }

  // Expose for console tuning during review (e.g. ANIM.TIMING.stagger = 0.1).
  window.ANIM = { TIMING: TIMING, registry: registry, caps: {
    reduceMotion: reduceMotion, webglOK: webglOK, isTouch: isTouch, dpr: dpr
  } };

})();
