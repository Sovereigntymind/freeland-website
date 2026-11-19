/* Application form client for /growth-roadmap/ (form_type roadmap) and /partners/ (form_type partner).
   Contract: tasks/freeland-website-rebuild-2026-11-18/CONTRACT.md (POST /api/roadmap-apply).
   Also wires booking links: any <a data-booking-source="x"> fires FL.track("booking_open", {source: "x"}).
   The form is disabled in HTML and only enabled here, so it never half-works without this file. */
(function () {
  "use strict";
  var EMAIL = "kevin@freelandme.com";
  var MAX_ELAPSED = 86400000;

  function fl() { return window.FL || {}; }
  function formEvent(name, params) {
    var F = fl();
    if (typeof F.formEvent === "function") { try { F.formEvent(name, params); } catch (e) { /* tracking never blocks the form */ } }
  }
  function track(name, params) {
    var F = fl();
    if (typeof F.track === "function") { try { F.track(name, params); } catch (e) { /* same */ } }
  }
  function attribution() {
    var F = fl();
    if (typeof F.attribution === "function") { try { return F.attribution() || {}; } catch (e) { /* fall through */ } }
    return {};
  }
  function uuid() {
    if (window.crypto && typeof crypto.randomUUID === "function") return crypto.randomUUID();
    var b = new Uint8Array(16);
    crypto.getRandomValues(b);
    b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
    var h = [];
    for (var i = 0; i < 16; i++) h.push((b[i] + 0x100).toString(16).slice(1));
    return h.slice(0, 4).join("") + "-" + h.slice(4, 6).join("") + "-" + h.slice(6, 8).join("") + "-" + h.slice(8, 10).join("") + "-" + h.slice(10).join("");
  }
  function store(key, value) {
    try {
      if (value === undefined) return sessionStorage.getItem(key);
      if (value === null) sessionStorage.removeItem(key); else sessionStorage.setItem(key, value);
    } catch (e) { /* private mode: the id simply lives in memory */ }
    return null;
  }
  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === "text") node.textContent = attrs[k]; else node.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function (c) { if (c) node.appendChild(c); });
    return node;
  }
  function mailLink(label) { return el("a", { href: "mailto:" + EMAIL, "data-cta": "apply_email_fallback", text: label || EMAIL }); }

  /* Booking links anywhere on the page (the /book/ page and the success step). */
  document.addEventListener("click", function (e) {
    var a = e.target && e.target.closest ? e.target.closest("a[data-booking-source]") : null;
    if (a) track("booking_open", { source: a.getAttribute("data-booking-source") });
  });

  function normalizeUrl(value) {
    var v = (value || "").trim();
    if (!v || /\s/.test(v)) return "";
    if (!/^https?:\/\//i.test(v)) v = "https://" + v;
    try {
      var u = new URL(v);
      if (u.hostname.indexOf(".") < 1 || u.hostname.slice(-1) === ".") return "";
      return u.href;
    } catch (e) { return ""; }
  }
  var EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[a-z]{2,}$/i;

  var SPECS = {
    roadmap: {
      formId: "roadmap_apply",
      fields: {
        store_url: { url: true, message: "Add your store address, like yourbrand.com." },
        revenue_band: { message: "Pick your monthly online sales range." },
        main_channel: { message: "Pick the channel that brings in most of your sales." },
        role: { message: "Pick your role." },
        email: { email: true, message: "Add a valid email, like you@yourbrand.com." }
      }
    },
    partner: {
      formId: "partner_apply",
      fields: {
        agency_name: { message: "Add your agency's name." },
        agency_website: { url: true, message: "Add your agency's website, like youragency.com." },
        client_count: { message: "Pick how many clients you serve." },
        services: { message: "List the services you offer, in a few words." },
        email: { email: true, message: "Add a valid email, like you@youragency.com." }
      }
    }
  };

  /* hCaptcha loads only when a sitekey is configured (funnel.json hcaptchaSitekey). */
  var captchaReady = null;
  function loadCaptcha(sitekey, slot) {
    if (!sitekey || !slot) return null;
    if (captchaReady) return captchaReady;
    captchaReady = new Promise(function (resolve) {
      window.flHcaptchaReady = function () {
        resolve(window.hcaptcha || null);
      };
      var s = document.createElement("script");
      s.src = "https://js.hcaptcha.com/1/api.js?render=explicit&onload=flHcaptchaReady";
      s.async = true;
      s.onerror = function () { captchaReady = null; resolve(null); };
      document.head.appendChild(s);
    });
    return captchaReady;
  }
  function captchaToken(ready, sitekey, slot) {
    if (!ready) return Promise.resolve("");
    return new Promise(function (resolve, reject) {
      var settled = false, widgetId = null, api = null, timer;
      function finish(token) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        // Each attempt owns a widget. Old callbacks cannot complete a later attempt.
        if (api && widgetId !== null) {
          try { api.reset(widgetId); } catch (e) { /* already removed */ }
          try { api.remove(widgetId); } catch (e) { /* already removed */ }
        }
        if (token) resolve(token);
        else { var error = new Error("Spam check expired or unavailable"); error.captcha = true; reject(error); }
      }
      function deadline(ms) {
        clearTimeout(timer);
        timer = setTimeout(function () { finish(""); }, ms);
      }
      deadline(8000); // Loading the API must not leave the form busy indefinitely.
      ready.then(function (loaded) {
        if (settled) return; // A late loader must not open an abandoned challenge.
        if (!loaded) { finish(""); return; }
        api = loaded;
        try {
          widgetId = api.render(slot, {
            sitekey: sitekey, size: "invisible",
            "open-callback": function () { if (!settled) deadline(120000); },
            "close-callback": function () { finish(""); },
            "expired-callback": function () { finish(""); },
            "chalexpired-callback": function () { finish(""); },
            "error-callback": function () { finish(""); }
          });
          deadline(8000); // Short execution startup; opening the UI grants two minutes.
          api.execute(widgetId, { async: true }).then(function (r) { finish(r && r.response); }, function () { finish(""); });
        } catch (e) { finish(""); }
      }, function () { finish(""); });
    });
  }

  function init(form) {
    var type = form.getAttribute("data-form-type") === "partner" ? "partner" : "roadmap";
    var spec = SPECS[type];
    var endpoint = form.getAttribute("data-endpoint");
    var button = form.querySelector('button[type="submit"]');
    var status = form.querySelector("[data-form-status]");
    var slot = form.querySelector("#hcaptcha-slot");
    if (!endpoint || !button || !status) return;

    var idKey = "fl_app_" + type;
    var receiptKey = idKey + "_receipt";
    var applicationId = store(idKey) || uuid();
    store(idKey, applicationId);
    var loadedAt = Date.now();
    var buttonLabel = button.textContent;
    var busy = false, started = false;
    var ready = null;
    function ensureCaptcha() { if (!ready) ready = loadCaptcha(form.getAttribute("data-hcaptcha-sitekey"), slot); return ready; }
    form.addEventListener("focusin", ensureCaptcha, { once: true });

    function input(name) { return form.elements[name]; }
    function errorNode(name) { return form.querySelector('[data-error-for="' + name + '"]'); }
    function setError(name, message) {
      var field = input(name), node = errorNode(name);
      if (!field || !node) return false;
      node.textContent = message || "";
      if (message) field.setAttribute("aria-invalid", "true"); else field.removeAttribute("aria-invalid");
      return true;
    }
    function clearStatus() { status.hidden = true; status.className = "form-status"; status.textContent = ""; }
    function setBusy(on) {
      busy = on;
      button.disabled = on;
      button.textContent = on ? "Sending..." : buttonLabel;
      if (on) button.setAttribute("aria-busy", "true"); else button.removeAttribute("aria-busy");
    }

    function values() {
      var out = {};
      Object.keys(spec.fields).forEach(function (name) {
        var raw = (input(name).value || "").trim();
        out[name] = spec.fields[name].url ? (normalizeUrl(raw) || raw) : raw;
      });
      return out;
    }
    function validate(data) {
      var first = null;
      Object.keys(spec.fields).forEach(function (name) {
        var rule = spec.fields[name], v = data[name], bad = !v;
        if (!bad && rule.url) bad = !normalizeUrl(v);
        if (!bad && rule.email) bad = !EMAIL_RE.test(v);
        setError(name, bad ? rule.message : "");
        if (bad && !first) first = input(name);
      });
      return first;
    }

    function showProblem(kind) {
      var copy = {
        unconfirmed: ["We could not confirm your application.", "Try again or email Kevin."],
        rate_limited: ["Too many applications from this connection.", "Wait a few minutes and send it again. Your answers are still here. Or email Kevin and he will take it from there."],
        challenge_failed: ["The spam check did not pass.", "Send it again. If it keeps failing, email Kevin your store address and he will take it from there."],
        conflict: ["We already have an application from this browser.", "It was sent with different answers. To change an answer, email Kevin."],
        network: ["We could not reach the server.", "Check your connection and send it again. Your answers are still here."],
        timeout: ["We could not confirm your application.", "The request took too long. It may have been received. Your answers are still here; send it again or email Kevin."],
        server: ["Something broke on our side.", "Your application may not have been saved. Send it again, your answers are still here. Or email Kevin directly."]
      }[kind];
      status.textContent = "";
      status.className = kind === "unconfirmed" ? "form-status" : "form-status form-error";
      status.setAttribute("role", kind === "unconfirmed" ? "status" : "alert");
      status.appendChild(el("h3", { text: copy[0] }));
      status.appendChild(el("p", { text: copy[1] }));
      var actions = el("div", { "class": "actions" });
      if (kind !== "conflict") {
        var retry = el("button", { type: "button", "class": "button button-primary", text: "Send it again" });
        retry.addEventListener("click", submit);
        actions.appendChild(retry);
      }
      var mail = mailLink("Email " + EMAIL);
      mail.className = "button button-secondary";
      actions.appendChild(mail);
      status.appendChild(actions);
      status.hidden = false;
      status.focus();
      formEvent("form_error", { form_id: spec.formId, error_type: kind });
    }

    function showSuccess(body) {
      var genuine = !!(body && body.accepted === true);
      var bookingUrl = form.getAttribute("data-booking-url") || "";
      var panel = el("div", { "class": "form-status", role: "status", tabindex: "-1" });
      if (type === "partner") {
        panel.appendChild(el("h3", { text: "Application received." }));
        panel.appendChild(el("p", { text: "Kevin reviews every partner application and replies by email." }));
      } else if (genuine && body.eligible === false) {
        panel.appendChild(el("h3", { text: "Application received." }));
        panel.appendChild(el("p", { text: "Right now the playbooks and the instant site check are the best place to start. Kevin replies by email if there is a fit." }));
        var list = el("ul", {});
        [["/free-business-audit/", "Run the instant site check"], ["/meta-ads-playbook/", "Read the Meta ads playbook"], ["/google-ads-checklist/", "Get the Google Ads checklist"], ["/lead-follow-up/", "Read the lead follow-up guide"]].forEach(function (r) {
          list.appendChild(el("li", {}, [el("a", { href: r[0], text: r[1] })]));
        });
        panel.appendChild(list);
      } else if (bookingUrl) {
        panel.appendChild(el("h3", { text: "Application received. Pick a time." }));
        panel.appendChild(el("p", { text: "Kevin walks you through your roadmap on a 30-minute call. His calendar opens in a new tab." }));
        var attrs = { href: bookingUrl, target: "_blank", rel: "noopener", "class": "button button-primary", text: "Pick a time" };
        if (genuine) { attrs["data-cta"] = "booking_open_apply_success"; attrs["data-booking-source"] = "apply_success"; }
        panel.appendChild(el("div", { "class": "actions" }, [el("a", attrs)]));
      } else {
        panel.appendChild(el("h3", { text: "Application received." }));
        panel.appendChild(el("p", { text: "Kevin will email you to pick a time." }));
      }
      panel.appendChild(el("p", { "class": "helper" }, [el("span", { text: "Need help with the next step? " }), mailLink("Email " + EMAIL)]));
      form.replaceWith(panel);
      panel.focus();
      // Keep the id for retries after refresh. Never persist answers or contact details.
    }

    function handle(httpStatus, body, data) {
      if (httpStatus === 200 && body && body.accepted === true) {
        if (body.test === true || body.status === "test") {
          window.FL = window.FL || {}; window.FL.internal = true;
          if (typeof window.FL.markInternal === "function") window.FL.markInternal();
        }
        var attr = attribution();
        var lead = { form_id: spec.formId, application_id: body.application_id || applicationId, status: body.status || "", source_page: attr.last_cta_path || attr.landing_path || location.pathname, originating_page: attr.originating_page || attr.landing_path || location.pathname, cta_id: attr.last_cta_id || ("direct_" + spec.formId) };
        if (type === "roadmap") { lead.revenue_band = data.revenue_band; lead.main_channel = data.main_channel; }
        formEvent("generate_lead", lead);
        store(receiptKey, JSON.stringify({ version: 1, application_id: applicationId, accepted: true, eligible: body.eligible !== false, savedAt: Date.now() }));
        showSuccess(body);
        return;
      }
      if (httpStatus === 200 && body && body.accepted === false) {
        // Acceptance is unconfirmed: preserve answers and retry, never a lead or receipt.
        setBusy(false);
        showProblem("unconfirmed"); return;
      }
      setBusy(false);
      if (httpStatus === 400 && body && body.fields) {
        var first = null, loose = [];
        Object.keys(body.fields).forEach(function (name) {
          if (spec.fields[name] && setError(name, String(body.fields[name]))) { if (!first) first = input(name); }
          else loose.push(String(body.fields[name]));
        });
        formEvent("form_error", { form_id: spec.formId, error_type: "validation" });
        if (first) { first.focus(); return; }
        status.textContent = "";
        status.className = "form-status form-error";
        status.setAttribute("role", "alert");
        status.appendChild(el("h3", { text: "The form could not be sent." }));
        status.appendChild(el("p", { text: (loose[0] || "Reload the page and try again.") + " If it keeps happening, email " + EMAIL + "." }));
        status.hidden = false;
        status.focus();
        return;
      }
      if (httpStatus === 409) return showProblem("conflict");
      if (httpStatus === 429) return showProblem("rate_limited");
      if (httpStatus === 403) return showProblem("challenge_failed");
      showProblem("server");
    }

    function submit(e) {
      if (e && e.preventDefault) e.preventDefault();
      if (busy) return;
      clearStatus();
      var data = values();
      var firstBad = validate(data);
      if (firstBad) {
        firstBad.focus();
        formEvent("form_error", { form_id: spec.formId, error_type: "validation" });
        return;
      }
      setBusy(true);
      var hp = form.elements.hp_company_url;
      // Autofill can finish before the server's 2.5-second anti-bot minimum.
      // Wait actual elapsed time instead of fabricating the timing field.
      var remaining = Math.max(0, 2500 - (Date.now() - loadedAt));
      var settled = remaining ? new Promise(function (resolve) { setTimeout(resolve, remaining); }) : Promise.resolve();
      settled.then(function () { return captchaToken(ensureCaptcha(), form.getAttribute("data-hcaptcha-sitekey"), slot); }).then(function (token) {
        var fields = {};
        fields[type] = data;
        var payload = {
          application_id: applicationId,
          form_type: type,
          fields: fields,
          attribution: (function () {
            var a = attribution();
            // Keep the frozen API's attribution contract unchanged.
            return { landing_path: a.landing_path, last_cta_id: a.last_cta_id, last_cta_path: a.last_cta_path, utm: a.utm };
          })(),
          hcaptcha_token: token,
          hp_company_url: hp ? hp.value : "",
          elapsed_ms: Math.min(Date.now() - loadedAt, MAX_ELAPSED)
        };
        var ctrl = window.AbortController ? new AbortController() : null;
        var timer;
        var limit = new Promise(function (_, reject) {
          timer = setTimeout(function () {
            var error = new Error("Request deadline exceeded"); error.timeout = true;
            reject(error);
            if (ctrl) ctrl.abort();
          }, 30000);
        });
        var work = fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify(payload),
          signal: ctrl ? ctrl.signal : undefined
        }).then(function (resp) {
          return resp.json().catch(function () { return null; }).then(function (body) { return { status: resp.status, body: body }; });
        });
        // Only the winning result may change the UI, even if abort is unsupported.
        return Promise.race([work, limit]).then(function (result) {
          handle(result.status, result.body, data);
        }).finally(function () { clearTimeout(timer); });
      }).catch(function (error) {
        if (error && error.captcha) ready = null;
        setBusy(false);
        showProblem(error && error.captcha ? "challenge_failed" : error && error.timeout ? "timeout" : "network");
      });
    }

    var receipt;
    try { receipt = JSON.parse(store(receiptKey)); } catch (e) { /* corrupted storage: normal form */ }
    if (receipt && receipt.version === 1 && receipt.application_id === applicationId && receipt.accepted === true &&
        typeof receipt.eligible === "boolean" && typeof receipt.savedAt === "number" && Date.now() >= receipt.savedAt && Date.now() - receipt.savedAt < MAX_ELAPSED) {
      showSuccess(receipt); return;
    }
    store(receiptKey, null);
    form.noValidate = true;
    form.addEventListener("submit", submit);
    form.addEventListener("input", function (e) {
      if (!started) { started = true; formEvent("form_start", { form_id: spec.formId }); }
      var name = e.target && e.target.name;
      if (name && spec.fields[name] && e.target.getAttribute("aria-invalid")) setError(name, "");
    });
    button.disabled = false;
  }

  function boot() {
    var forms = document.querySelectorAll("form[data-apply-form]");
    for (var i = 0; i < forms.length; i++) {
      try { init(forms[i]); } catch (e) {
        var status = forms[i].querySelector("[data-form-status]");
        if (status) {
          status.textContent = "The form could not start. ";
          status.appendChild(mailLink("Email " + EMAIL));
          status.hidden = false;
          status.setAttribute("role", "alert");
        }
      }
    }
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
})();
