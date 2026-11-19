/* Night Shift core: header state, mobile menu, GA4 loader + FL.track, reveal-on-enter, proof count-up, sticky stack.
   Everything is progressive enhancement: the page is complete without this file. No window scroll listeners. */
(function () {
  "use strict";
  var FL = window.FL = window.FL || {};
  var root = document.documentElement;
  var rmq = window.matchMedia("(prefers-reduced-motion: reduce)");
  var updateMotion = function () {};
  FL.reduced = rmq.matches;
  if (rmq.addEventListener) rmq.addEventListener("change", function (m) {
    FL.reduced = m.matches;
    updateMotion();
  });

  /* GA4: loads on first interaction or after 3 s; preview builds mark every hit internal (PLAN R1-15). */
  var gaLoaded = false;
  function analyticsContext() {
    return FL.analyticsContext ? FL.analyticsContext() : { page_location: 'https://freelandme.com/', page_referrer: '' };
  }
  function loadGA() {
    if (gaLoaded || !FL.ga) return; gaLoaded = true;
    var cfg = analyticsContext();
    if (FL.env === "preview" || FL.internal) cfg.traffic_type = "internal";
    // Set safe defaults before loading GA or queuing its automatic page view.
    gtag("set", analyticsContext());
    gtag("js", new Date());
    gtag("config", FL.ga, cfg);
    var s = document.createElement("script");
    s.src = "https://www.googletagmanager.com/gtag/js?id=" + FL.ga; s.async = true;
    document.head.appendChild(s);
  }
  setTimeout(loadGA, 3000);
  ["pointerdown", "keydown", "touchstart"].forEach(function (e) { window.addEventListener(e, loadGA, { once: true, passive: true }); });
  FL.track = function (name, params) {
    var safe = {}, context = analyticsContext();
    Object.keys(params || {}).forEach(function (key) {
      safe[key] = /(?:_path|_page)$/.test(key) ? (FL.analyticsPath ? FL.analyticsPath(params[key]) : '/') : params[key];
    });
    safe.page_location = context.page_location;
    safe.page_referrer = context.page_referrer;
    if (FL.env === "preview" || FL.internal) safe.traffic_type = "internal";
    loadGA();
    gtag("set", context);
    gtag("event", name, safe);
  };

  document.addEventListener("DOMContentLoaded", function () {
    /* Header turns solid once the page has moved (IntersectionObserver on a sentinel). */
    var header = document.getElementById("site-header");
    var sentinel = document.createElement("div");
    sentinel.setAttribute("aria-hidden", "true");
    sentinel.style.cssText = "position:absolute;top:0;left:0;width:1px;height:8px;pointer-events:none";
    document.body.prepend(sentinel);
    if (header && "IntersectionObserver" in window) {
      new IntersectionObserver(function (e) { header.classList.toggle("is-solid", !e[0].isIntersecting); }).observe(sentinel);
    } else if (header) { header.classList.add("is-solid"); }

    /* Mobile menu: Escape closes, focus returns to the toggle. */
    var toggle = document.querySelector(".nav-toggle"), menu = document.getElementById("mobile-nav");
    function setMenu(open) {
      if (!toggle || !menu) return;
      menu.hidden = !open; toggle.setAttribute("aria-expanded", open ? "true" : "false");
      toggle.textContent = open ? "Close" : "Menu"; header.classList.toggle("menu-open", open);
      if (open) { var first = menu.querySelector("a"); if (first) first.focus(); }
    }
    if (toggle) {
      toggle.addEventListener("click", function () { setMenu(menu.hidden); });
      document.addEventListener("keydown", function (e) { if (e.key === "Escape" && !menu.hidden) { setMenu(false); toggle.focus(); } });
      window.matchMedia("(min-width: 901px)").addEventListener("change", function (m) { if (m.matches) setMenu(false); });
    }

    var counts = Array.from(document.querySelectorAll("[data-count-to]")).map(function (el) {
      return { el: el, final: el.textContent };
    });
    var stopMotion = function () {};
    updateMotion = function () {
      stopMotion();
      root.classList.toggle("motion-ready", !FL.reduced);
      if (FL.reduced || !("IntersectionObserver" in window)) return;
      var active = true, frames = new Set();
      var io = new IntersectionObserver(function (es) {
        if (!active) return;
        es.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add("is-in"); io.unobserve(e.target); } });
      }, { threshold: 0.15 });
      document.querySelectorAll(".reveal").forEach(function (el) { io.observe(el); });
      var cio = new IntersectionObserver(function (es) {
        if (!active) return;
        es.forEach(function (e) {
          if (!e.isIntersecting) return; cio.unobserve(e.target);
          var el = e.target, to = parseFloat(el.dataset.countTo), from = parseFloat(el.dataset.countFrom || "0");
          var dec = parseInt(el.dataset.decimals || "0", 10), pre = el.dataset.prefix || "", suf = el.dataset.suffix || "";
          var final = counts.find(function (item) { return item.el === el; }).final;
          var t0 = performance.now(), D = 1400, frame;
          (function tick(t) {
            frames.delete(frame);
            if (!active) return;
            var p = Math.min(1, (t - t0) / D), k = 1 - Math.pow(1 - p, 3);
            el.textContent = p < 1 ? pre + (from + (to - from) * k).toFixed(dec) + suf : final;
            if (p < 1) { frame = requestAnimationFrame(tick); frames.add(frame); }
          })(t0);
        });
      }, { threshold: 0.6 });
      counts.forEach(function (item) { cio.observe(item.el); });
      stopMotion = function () {
        active = false;
        io.disconnect(); cio.disconnect();
        frames.forEach(function (frame) { cancelAnimationFrame(frame); }); frames.clear();
        counts.forEach(function (item) { item.el.textContent = item.final; });
      };
    };
    updateMotion();

    /* Sticky stack (desktop only; GSAP loaded only on pages with motion: true). */
    function initStack() {
      var stack = document.querySelector("[data-stack]");
      if (!stack || !window.gsap || !window.ScrollTrigger) return;
      gsap.registerPlugin(ScrollTrigger);
      var mm = gsap.matchMedia();
      mm.add("(min-width: 900px) and (prefers-reduced-motion: no-preference)", function () {
        stack.classList.add("stack-enhanced");
        var cards = gsap.utils.toArray(stack.querySelectorAll(".stack-card"));
        cards.forEach(function (card, i) { card.style.zIndex = String(i + 1); });
        cards.forEach(function (card, i) {
          if (i === cards.length - 1) return;
          var panel = card.querySelector(".card-panel");
          ScrollTrigger.create({ trigger: card, start: "top top", endTrigger: cards[cards.length - 1], end: "top top", pin: true, pinSpacing: false });
          gsap.to(panel, { scale: 0.94, "--dim": 0.55, ease: "none", scrollTrigger: { trigger: cards[i + 1], start: "top 60%", end: "top top", scrub: true } });
        });
        ScrollTrigger.refresh();
        return function () {
          stack.classList.remove("stack-enhanced");
          cards.forEach(function (card) {
            var panel = card.querySelector(".card-panel");
            [card, panel].forEach(function (el) {
              if (!el) return;
              ["transform", "transform-origin", "--dim", "z-index"].forEach(function (prop) { el.style.removeProperty(prop); });
            });
          });
        };
      });
    }
    if (window.gsap) initStack(); else window.addEventListener("load", initStack);
  });
})();
