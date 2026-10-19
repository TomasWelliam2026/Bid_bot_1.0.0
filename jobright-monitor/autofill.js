// Auto Fill: fills the job application form on a page with the applicant's
// details. Injected into the page the side panel's "Fill this page" is
// pressed on (chrome.scripting, then window.__jobrightAutofill(details)), and
// loaded by autofill-sample.html, the extension's own sample form, which the
// panel reaches with an AUTOFILL_RUN message instead.
//
// Two kinds of value:
//   - the standard details (name, email, phone, location, links, cover
//     letter), each matched to a field by what the field says it is — its
//     label, name, id, placeholder, aria-label and title — and by the
//     stronger hints autocomplete= and type=;
//   - extra answers, { question, answer } — an imported JSON's "answers" — each
//     matched to the field whose label reads as that question, a text field
//     or a dropdown, whose option is then picked by the answer.
//
// Only empty fields are filled: whatever the applicant or the site already put
// in one is left as it is. Values go in through the element's native value
// setter followed by input and change events, so a React-style form, which
// ignores a plain .value assignment, sees the change as typed.

(() => {
  if (window.__jobrightAutofill) return; // injected again: one copy is enough

  // What each detail is called, for the report.
  const NAMES = {
    firstName: "First name",
    lastName: "Last name",
    fullName: "Full name",
    email: "Email",
    phone: "Phone",
    location: "Location",
    linkedin: "LinkedIn",
    website: "Website"
  };

  // In the order a field is tried against them: the specific before the
  // general, so "LinkedIn URL" is LinkedIn rather than a website and "First
  // name" is not taken for a full name.
  const FIELDS = [
    { key: "email", autocomplete: ["email"], type: ["email"], words: /e-?mail/i },
    { key: "phone", autocomplete: ["tel", "tel-national"], type: ["tel"], words: /phone|mobile|\btel\b/i },
    { key: "linkedin", words: /linked\s*-?_?in/i },
    { key: "firstName", autocomplete: ["given-name"], words: /first[\s_-]*name|given[\s_-]*name|\bfname\b|forename/i },
    { key: "lastName", autocomplete: ["family-name"], words: /last[\s_-]*name|family[\s_-]*name|surname|\blname\b/i },
    { key: "fullName", autocomplete: ["name"], words: /full[\s_-]*name|legal[\s_-]*name|your[\s_-]*name|^\s*name\s*\*?\s*$/i },
    { key: "website", autocomplete: ["url"], type: ["url"], words: /website|portfolio|personal[\s_-]*(site|page)|github|\burl\b/i },
    { key: "location", autocomplete: ["address-level2", "address-line1"], words: /\bcity\b|location|address|where .*(live|based)/i }
  ];

  const TEXT_TYPES = new Set(["", "text", "email", "tel", "url", "search", "number"]);
  const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();
  // For comparing a question with a label: case, punctuation and the
  // required-field asterisk do not count.
  const norm = (s) =>
    clean(s)
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim();

  // A label-ish element before the field, for forms that use none: its own
  // previous sibling, or — many real application forms wrap each field in
  // its own container div, putting the label beside *that*, not beside the
  // input — a previous sibling found by walking up a couple of ancestors.
  function nearLabel(el) {
    let node = el;
    for (let depth = 0; depth < 3 && node; depth++) {
      const sib = node.previousElementSibling;
      if (sib && !sib.matches("input, textarea, select, button")) {
        const text = clean(sib.textContent);
        if (text) return text.slice(0, 120);
      }
      node = node.parentElement;
    }
    return "";
  }

  // Everything the page says about a field, each source on its own — a
  // pattern anchored to a whole label ("Name") must not see the name= too.
  function wordsFor(el) {
    const labels = [...(el.labels || [])].map((l) => clean(l.textContent));
    const byIds = (el.getAttribute("aria-labelledby") || "")
      .split(/\s+/)
      .filter(Boolean)
      .map((id) => clean(document.getElementById(id)?.textContent));
    return [
      ...labels,
      ...byIds,
      nearLabel(el),
      el.getAttribute("aria-label"),
      el.getAttribute("placeholder"),
      el.getAttribute("name"),
      el.id,
      el.getAttribute("title")
    ]
      .map(clean)
      .filter(Boolean);
  }

  function kindOf(el) {
    const autocomplete = (el.getAttribute("autocomplete") || "").toLowerCase().split(/\s+/).pop();
    const type = (el.getAttribute("type") || "").toLowerCase();
    const words = wordsFor(el);
    for (const f of FIELDS) {
      if (f.autocomplete?.includes(autocomplete) || f.type?.includes(type)) return f.key;
    }
    for (const f of FIELDS) {
      if (words.some((w) => f.words.test(w))) return f.key;
    }
    return null;
  }

  // The extra answer whose question this field asks: a label that reads as
  // the question, or holds it whole ("Years of experience *" for "Years of
  // experience"), or is held whole by a longer question.
  function answerFor(el, extra) {
    const words = wordsFor(el).map(norm).filter(Boolean);
    for (const x of extra) {
      const q = norm(x.question);
      if (!q) continue;
      const hit = words.some(
        (w) => w === q || (q.length >= 4 && w.includes(q)) || (w.length >= 8 && q.includes(w))
      );
      if (hit) return x;
    }
    return null;
  }

  const visible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);

  function usable(el) {
    if (el.disabled || el.readOnly || !visible(el)) return false;
    if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return true;
    return TEXT_TYPES.has((el.getAttribute("type") || "").toLowerCase());
  }

  // A dropdown with nothing picked yet: no value, or still on its
  // "Select…" prompt.
  const unpicked = (el) =>
    !el.value || el.selectedIndex <= 0 && /^(select|choose|please|--|—|-)/i.test(clean(el.options[0]?.text));

  const isEmpty = (el) => (el instanceof HTMLSelectElement ? unpicked(el) : !el.value.trim());

  // The option an answer means: the same words, or — failing that — the one
  // option whose words hold the answer's, or are held by them.
  function optionFor(select, answer) {
    const a = norm(answer);
    if (!a) return null;
    const options = [...select.options].filter((o) => !o.disabled && norm(o.text));
    return (
      options.find((o) => norm(o.text) === a || norm(o.value) === a) ||
      options.find((o) => a.length >= 3 && norm(o.text).includes(a)) ||
      options.find((o) => norm(o.text).length >= 3 && a.includes(norm(o.text))) ||
      null
    );
  }

  // The value the way a person typing (or picking) it would leave it:
  // through the native setter (React keeps its own record of the last value,
  // and only a change past that record counts), then the events a keystroke
  // or a pick ends with.
  function setValue(el, value) {
    const proto =
      el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : el instanceof HTMLSelectElement
          ? HTMLSelectElement.prototype
          : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function mark(el) {
    const before = { outline: el.style.outline, offset: el.style.outlineOffset };
    el.style.outline = "2px solid #6a5fdb";
    el.style.outlineOffset = "1px";
    setTimeout(() => {
      el.style.outline = before.outline;
      el.style.outlineOffset = before.offset;
    }, 4000);
  }

  // The details as given, plus the ones that follow from them: a full name
  // from first and last, or first and last from a full name.
  function valuesFrom(details) {
    const d = {};
    for (const key of Object.keys(NAMES)) d[key] = String(details?.[key] ?? "").trim();
    if (!d.fullName) d.fullName = [d.firstName, d.lastName].filter(Boolean).join(" ");
    if (d.fullName && !d.firstName && !d.lastName) {
      const parts = d.fullName.split(/\s+/);
      d.firstName = parts.shift() || "";
      d.lastName = parts.join(" ");
    }
    return d;
  }

  const extraFrom = (details) =>
    (Array.isArray(details?.extra) ? details.extra : [])
      .map((x) => ({ question: clean(x?.question), answer: String(x?.answer ?? "").trim() }))
      .filter((x) => x.question && x.answer);

  // The reverse of autofill: reads whatever is already on the page instead of
  // putting something there. A field recognised as a standard detail (by the
  // same kindOf() the fill uses) goes into `details` under that key; anything
  // else with a label and a value becomes an extra { question, answer } —
  // the page's own question, and what is currently answered.
  window.__jobrightAutofillCatch = function autofillCatch() {
    const details = {};
    const extra = [];
    const seen = new Set();

    for (const el of document.querySelectorAll("input, textarea, select")) {
      if (!usable(el)) continue;
      const isSelect = el instanceof HTMLSelectElement;
      if (isSelect ? unpicked(el) : !clean(el.value)) continue;

      const value = isSelect ? clean(el.options[el.selectedIndex]?.text) : clean(el.value);
      if (!value) continue;

      const key = isSelect ? null : kindOf(el);
      if (key) {
        if (!details[key]) details[key] = value;
        continue;
      }

      const label = wordsFor(el)[0] || "";
      const q = norm(label);
      if (!q || seen.has(q)) continue;
      seen.add(q);
      extra.push({ question: label, answer: value });
    }

    return { ok: true, url: location.href, title: document.title, details, extra };
  };

  window.__jobrightAutofill = function autofill(details) {
    const values = valuesFrom(details);
    const extra = extraFrom(details);
    const filled = [];
    const kept = [];
    const missed = []; // a question found, but no option of its dropdown matches the answer
    let unknown = 0;
    let first = null;

    const put = (el, value, name, label) => {
      if (!isEmpty(el)) {
        kept.push({ name, label });
        return;
      }
      setValue(el, value);
      mark(el);
      first ||= el;
      filled.push({ name, label });
    };

    for (const el of document.querySelectorAll("input, textarea, select")) {
      if (!usable(el)) continue;
      const isSelect = el instanceof HTMLSelectElement;
      const label = wordsFor(el)[0] || "";

      // A standard detail, when the field is one and there is a value for it.
      const key = isSelect ? null : kindOf(el);
      if (key && values[key]) {
        put(el, values[key], NAMES[key], label || NAMES[key]);
        continue;
      }

      // Otherwise an extra answer whose question it asks.
      const x = extra.length ? answerFor(el, extra) : null;
      if (x) {
        if (!isSelect) {
          put(el, x.answer, x.question, label || x.question);
          continue;
        }
        const option = optionFor(el, x.answer);
        if (option) put(el, option.value, x.question, label || x.question);
        else missed.push({ name: x.question, label, answer: x.answer });
        continue;
      }

      if (!key) unknown++;
    }

    first?.scrollIntoView({ block: "center", behavior: "smooth" });
    return { ok: true, url: location.href, title: document.title, filled, kept, missed, unknown };
  };

  // The extension's own sample form cannot be injected into, so the panel
  // asks it by message instead.
  if (location.protocol === "chrome-extension:" && globalThis.chrome?.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (msg?.type === "AUTOFILL_RUN") sendResponse(window.__jobrightAutofill(msg.details));
      else if (msg?.type === "AUTOFILL_CATCH") sendResponse(window.__jobrightAutofillCatch());
      return false;
    });
  }
})();
