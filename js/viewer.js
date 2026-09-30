/* Multi-instance interactive 3D part viewer (three.js, classic build).
   Mounts into EVERY [data-part-viewer] element on the page. Per-instance
   options come from data attributes:
     data-part   — which mesh to show (currently only "MROD")
     data-edge   — EdgesGeometry line color (default brand green)
     data-ground — hemisphere-light ground tint (default warm pale green)

   The STL for each part is parsed ONCE and its geometry shared across every
   instance. Each viewer is created lazily when it scrolls near the viewport,
   and its render loop is skipped while offscreen (browsers cap the number of
   simultaneous WebGL contexts, and more viewers get added over time).

   Model data (assets/mrod-model.js) holds a base64 binary STL, so no fetch is
   needed and everything works from a double-clicked file. If a part's model
   is missing, that viewer falls back to a placeholder pillow-block. */
(function () {
  if (typeof THREE === "undefined") return;
  var mounts = document.querySelectorAll("[data-part-viewer]");
  if (!mounts.length) return;

  var reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* -------- shared geometry, parsed once per part -------- */
  var partCache = {};

  function parseBinaryStl(base64) {
    var bin = atob(base64);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    var view = new DataView(bytes.buffer);
    var triCount = view.getUint32(80, true);
    if (84 + triCount * 50 !== bytes.length) return null;
    var positions = new Float32Array(triCount * 9);
    for (var t = 0; t < triCount; t++) {
      var off = 84 + t * 50 + 12; // skip the facet normal; recomputed below
      for (var f = 0; f < 9; f++) {
        positions[t * 9 + f] = view.getFloat32(off + f * 4, true);
      }
    }
    var geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geo.computeVertexNormals();
    return geo;
  }

  // Returns { geo, edges, center, scale } for a part, or a placeholder marker.
  function getPart(name) {
    if (partCache[name]) return partCache[name];

    var geo = null;
    if (name === "MROD" && typeof MROD_STL_BASE64 !== "undefined") {
      geo = parseBinaryStl(MROD_STL_BASE64);
    }

    var data;
    if (geo) {
      var edges = new THREE.EdgesGeometry(geo, 24);
      // Measure in CAD orientation (Z-up), the same rotation used at mount time.
      var probe = new THREE.Group();
      var m = new THREE.Mesh(geo);
      probe.add(m);
      probe.rotation.x = -Math.PI / 2; // CAD Z-up -> three.js Y-up
      probe.updateMatrixWorld(true);
      var box = new THREE.Box3().setFromObject(probe);
      var size = box.getSize(new THREE.Vector3());
      var center = box.getCenter(new THREE.Vector3());
      var maxDim = Math.max(size.x, size.y, size.z) || 1;
      data = { geo: geo, edges: edges, center: center, scale: 2.8 / maxDim, placeholder: false };
    } else {
      data = { placeholder: true };
    }
    partCache[name] = data;
    return data;
  }

  /* -------- one viewer instance -------- */
  function createViewer(el) {
    var edgeColor = new THREE.Color(el.getAttribute("data-edge") || "#1f4d3a");
    var groundColor = new THREE.Color(el.getAttribute("data-ground") || "#eef1ec");
    var partName = el.getAttribute("data-part") || "MROD";

    var scene = new THREE.Scene();

    var camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
    camera.position.set(4.4, 3.1, 5.2);
    camera.lookAt(0, 0.2, 0);

    var renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    var canvas = renderer.domElement;
    canvas.style.position = "absolute";
    canvas.style.inset = "0";
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    el.appendChild(canvas);

    // Lighting
    scene.add(new THREE.HemisphereLight(0xffffff, groundColor, 0.95));
    var key = new THREE.DirectionalLight(0xffffff, 0.8);
    key.position.set(4, 6, 3);
    scene.add(key);
    var fill = new THREE.DirectionalLight(0xffffff, 0.3);
    fill.position.set(-4, 2, -3);
    scene.add(fill);

    // Flat-shaded matte material — a CAD part, not a glossy render
    var matte = new THREE.MeshStandardMaterial({
      color: 0xdfe3dc, metalness: 0.1, roughness: 0.85, flatShading: true
    });
    var edgeMat = new THREE.LineBasicMaterial({ color: edgeColor });

    var part = buildPart(partName, matte, edgeMat);
    scene.add(part);

    /* drag-to-rotate + slow idle spin */
    var idleSpeed = reduced ? 0 : 0.0035;
    var velX = idleSpeed, velY = 0;
    var dragging = false, lastX = 0, lastY = 0;

    canvas.addEventListener("pointerdown", function (e) {
      dragging = true; lastX = e.clientX; lastY = e.clientY;
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener("pointermove", function (e) {
      if (!dragging) return;
      velX = (e.clientX - lastX) * 0.006;
      velY = (e.clientY - lastY) * 0.006;
      lastX = e.clientX; lastY = e.clientY;
    });
    function endDrag() { dragging = false; }
    canvas.addEventListener("pointerup", endDrag);
    canvas.addEventListener("pointercancel", endDrag);

    function resize() {
      var r = el.getBoundingClientRect();
      var w = Math.round(r.width), h = Math.round(r.height);
      if (!w || !h) return;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h, false); // false: never write px dims back into layout
    }
    if ("ResizeObserver" in window) {
      new ResizeObserver(resize).observe(el);
    } else {
      window.addEventListener("resize", resize);
    }
    resize();

    // Only render while on (or near) screen.
    var visible = true;
    if ("IntersectionObserver" in window) {
      visible = false;
      new IntersectionObserver(function (entries) {
        visible = entries[0].isIntersecting;
      }, { rootMargin: "120px" }).observe(el);
    }

    renderer.setAnimationLoop(function () {
      if (!visible) return;
      if (!dragging) {
        velX += (idleSpeed - velX) * 0.02;
        velY += (0 - velY) * 0.05;
      }
      part.rotation.y += velX;
      part.rotation.x += velY;
      part.rotation.x = Math.max(-0.85, Math.min(0.85, part.rotation.x));
      renderer.render(scene, camera);
    });
  }

  // Build the display group for a part, reusing shared geometry.
  function buildPart(name, matte, edgeMat) {
    var data = getPart(name);
    if (data.placeholder) return buildPlaceholder(matte, edgeMat);

    var inner = new THREE.Group();
    inner.add(new THREE.Mesh(data.geo, matte));
    inner.add(new THREE.LineSegments(data.edges, edgeMat));
    inner.rotation.x = -Math.PI / 2;
    inner.position.sub(data.center);

    var holder = new THREE.Group();
    holder.add(inner);
    holder.scale.setScalar(data.scale);
    return holder;
  }

  function buildPlaceholder(matte, edgeMat) {
    var g = new THREE.Group();
    function add(geo, x, y, z, rx) {
      var mesh = new THREE.Mesh(geo, matte);
      mesh.position.set(x, y, z);
      if (rx) mesh.rotation.x = rx;
      g.add(mesh);
      var e = new THREE.LineSegments(new THREE.EdgesGeometry(geo, 24), edgeMat);
      e.position.copy(mesh.position);
      e.rotation.copy(mesh.rotation);
      g.add(e);
    }
    add(new THREE.BoxGeometry(3.4, 0.35, 2.0), 0, 0, 0);
    add(new THREE.CylinderGeometry(0.85, 0.85, 0.9, 48), 0, 0.95, 0, Math.PI / 2);
    add(new THREE.BoxGeometry(0.28, 0.85, 1.3), -1.05, 0.55, 0);
    add(new THREE.BoxGeometry(0.28, 0.85, 1.3), 1.05, 0.55, 0);
    g.position.y = -0.55;
    return g;
  }

  /* -------- lazy mount: create each viewer as it nears the viewport -------- */
  if ("IntersectionObserver" in window) {
    var mountObs = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        mountObs.unobserve(entry.target);
        createViewer(entry.target);
      });
    }, { rootMargin: "300px" });
    mounts.forEach(function (el) { mountObs.observe(el); });
  } else {
    mounts.forEach(createViewer);
  }
})();
