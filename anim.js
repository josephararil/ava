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
        15: { motif: 'octa',  color: LIME,  accent: GREEN },
        20: { motif: 'torus', color: GREEN, accent: BLUE }
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

  // Section dividers A / B / C  ->  WebGL field + letter reveal.
  registry[3]  = { enter: dividerEnter };
  registry[15] = { enter: dividerEnter };
  registry[20] = { enter: dividerEnter };

  // Flow / architecture diagrams.
  registry[5] = { enter: archEnter };     // Edge->Core->Data (WebGL hero)
  registry[7] = { enter: colpairEnter };  // two models + smart router
  registry[8] = { enter: liqEnter };      // liquidity routing + packets

  // Storytelling / data slides.
  registry[17] = { enter: pipelineEnter }; // AI assembly-line
  registry[13] = { enter: statEnter };     // <2ms / 500K–1M+ / <1s / 24/7
  registry[19] = { enter: compareEnter };  // Adaptive vs Omnius

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
