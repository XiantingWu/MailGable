import test from "node:test";
import assert from "node:assert/strict";
import {
  base64ToBytes,
  bytesToBase64,
  emailList,
  forwardSubject,
  normalizeEmail,
  replySubject,
  safeFilename,
  sanitizeHtml,
  safeExternalHref,
  stripBidiControls,
  safeDisplayText,
  safeDisplayFilename,
  stableStringify,
  timingSafeEqual,
  truncateUtf8,
} from "../.test-build/src/lib.js";

test("normalizes and deduplicates email addresses", () => {
  assert.equal(normalizeEmail("Support <Support@Example.com>"), "support@example.com");

  assert.deepEqual(emailList("A@example.com, a@example.com; b@example.com"), ["a@example.com", "b@example.com"]);
});

test("sanitizes active and remote HTML content", () => {
  const output = sanitizeHtml('<script>alert(1)</script><p onclick="x()"><a href="https://tracker.test/x">hello</a><img src="javascript:x"><svg onload="x()"></svg></p>');
  assert.equal(output.includes("script"), false);
  assert.equal(output.includes("onclick"), false);
  assert.equal(output.includes("javascript:"), false);
  assert.equal(output.includes("svg"), false);
  assert.equal(output.includes("hello"), true);
  assert.match(output, /href="https:\/\/tracker\.test\/x" target="_blank"/);
  assert.equal(output.includes("src="), false, "img src is always removed (remote images blocked)");
});

test("safe HTML link policy: https and mailto survive with hardened attributes; dangerous URIs are removed", () => {
  const output = sanitizeHtml(
    '<a href="https://example.com/a">safe</a>'
    + '<a href="mailto:test@example.com">mail</a>'
    + '<a href="http://example.com">http</a>'
    + '<a href="javascript:alert(1)">js</a>'
    + '<a href="JaVaScRiPt:alert(2)">mixed</a>'
    + '<a href="data:text/html,x">data</a>'
    + '<a href="vbscript:msgbox">vbs</a>'
    + '<a href="//evil.example/x">proto</a>'
    + '<a href="/relative">rel</a>'
    + '<img src="https://tracker.test/pixel.png">'
    + '<a href="https://example.com/a" target="_self" rel="ugc">existing</a>',
  );
  assert.match(output, /href="https:\/\/example\.com\/a" target="_blank" rel="noopener noreferrer nofollow"/);
  assert.match(output, /href="mailto:test@example\.com" target="_blank" rel="noopener noreferrer nofollow"/);
  assert.equal(output.includes("http://example.com"), false, "plain http is not allowed");
  assert.equal(output.includes("javascript:"), false);
  assert.equal(output.includes("JaVaScRiPt"), false);
  assert.equal(output.includes("data:text/html"), false);
  assert.equal(output.includes("vbscript"), false);
  assert.equal(output.includes("//evil.example"), false);
  assert.equal(output.includes("/relative"), false, "relative links are not allowed");
  assert.equal(output.includes("pixel.png"), false, "remote images stay blocked (src removed)");
  assert.equal(output.includes('target="_self"'), false, 'attacker-specified target/rel are replaced');
  assert.equal(output.includes('rel="ugc"'), false);
});

test("truncates by UTF-8 bytes without splitting Unicode", () => {
  const input = "猫猫猫😀abc";
  const output = truncateUtf8(input, 10);
  assert.ok(new TextEncoder().encode(output).byteLength <= 10);
  assert.equal(output.includes("�"), false);
  assert.equal(output, "猫猫猫");
});

test("stable stringification ignores object key order", () => {
  assert.equal(stableStringify({ b: 2, a: { z: 1, y: 2 } }), stableStringify({ a: { y: 2, z: 1 }, b: 2 }));
});

test("sanitizes attachment filenames", () => {
  assert.equal(safeFilename("../../invoice:\u0000.pdf"), ".._.._invoice_.pdf");
  assert.equal(safeFilename("..."), "attachment");
});

test("round-trips base64 attachment data", () => {
  const bytes = new TextEncoder().encode("mailbox service");
  assert.deepEqual(base64ToBytes(bytesToBase64(bytes)), bytes);
});

test("builds reply and forward subjects without duplicate prefixes", () => {
  assert.equal(replySubject("Hello"), "Re: Hello");
  assert.equal(replySubject("RE: Hello"), "RE: Hello");
  assert.equal(forwardSubject("Hello"), "Fwd: Hello");
});

test("uses length-aware constant-time comparison", () => {
  assert.equal(timingSafeEqual("same", "same"), true);
  assert.equal(timingSafeEqual("same", "different"), false);
});

test("safeExternalHref is a strict allowlist", () => {
  assert.equal(safeExternalHref("https://example.com/a"), "https://example.com/a");
  assert.equal(safeExternalHref("mailto:test@example.com"), "mailto:test@example.com");
  for (const value of [
    "javascript:alert(1)",
    "JaVaScRiPt:alert(2)",
    "data:text/html,x",
    "vbscript:msgbox",
    "file:///etc/passwd",
    "blob:https://example.com/id",
    "//evil.example/x",
    "/relative",
    "https:example.com",
    "ftp://example.com",
  ]) {
    assert.equal(safeExternalHref(value), null, value);
  }
});

test("stripBidiControls removes bidi control characters but keeps normal RTL text", () => {
  const rlo = "invoice\u202Efdp.exe";
  assert.equal(stripBidiControls(rlo), "invoicefdp.exe");
  assert.equal(stripBidiControls("subject\u202Doverride"), "subjectoverride");
  const nested = "a\u2066b\u2069c";
  assert.equal(stripBidiControls(nested), "abc");
  const normalArabic = "السلام عليكم";
  assert.equal(stripBidiControls(normalArabic), normalArabic, "normal RTL text must survive");
  const mixed = "مرحبا hello";
  assert.equal(stripBidiControls(mixed), mixed);
  assert.equal(stripBidiControls("\u202A\u202B\u202C\u202D\u202E\u2066\u2067\u2068\u2069"), "");
});

test("safeDisplayText and safeDisplayFilename strip bidi controls", () => {
  assert.equal(safeDisplayText("Invoice \u202Egnp.exe"), "Invoice gnp.exe");
  assert.equal(safeDisplayFilename("invoice\u202Efdp.exe"), "invoicefdp.exe");
  assert.equal(safeDisplayFilename("..\u202Eexe"), "..exe", "bidi controls stripped; server-side object keys remain server-generated");
  assert.equal(safeDisplayText("plain \u202A text"), "plain  text");
});

test("hostile HTML corpus cannot produce executable or navigable structures", () => {
  const corpus = [
    "<script>alert(1)</script>",
    "<script\n>alert(2)</script>",
    "<ScRiPt>alert(3)</sCrIpT>",
    "<img src=x onerror=alert(4)>",
    "<svg><script>alert(5)</script></svg>",
    "<math><mtext><script>alert(6)</script></mtext></math>",
    "<foreignObject><body><script>alert(7)</script></body></foreignObject>",
    "<template><script>alert(8)</script></template>",
    "<meta http-equiv=refresh content='0;url=javascript:alert(9)'>",
    "<base href='https://evil.example/'>",
    "<iframe srcdoc='<script>alert(10)</script>'></iframe>",
    "<iframe src='javascript:alert(11)'></iframe>",
    "<object data='javascript:alert(12)'></object>",
    "<embed src='data:text/html,<script>alert(13)</script>'>",
    "<a href='javascript&#58;alert(14)'>x</a>",
    "<a href='java&#x73;cript:alert(15)'>x</a>",
    "<a href='  javascript:alert(16)'>x</a>",
    "<a href='java\tascript:alert(17)'>x</a>",
    "<a href='java\u0000script:alert(18)'>x</a>",
    "<a href='data:text/html;base64,PHNjcmlwdD4xPC9zY3JpcHQ+'>x</a>",
    "<a href='blob:https://example.com/id'>x</a>",
    "<a href='//evil.example/x'>x</a>",
    "<a href='/relative'>x</a>",
    "<a href='https://example.com' onclick=alert(19)>x</a>",
    "<form action='javascript:alert(20)'><button>x</button></form>",
    "<input type=image src=x formaction=javascript:alert(21)>",
    "<img src='https://tracker.example/pixel.png'>",
    "<img srcset='https://tracker.example/a.png 1x'>",
    "<img poster='javascript:alert(22)'>",
    "<svg><a xlink:href='javascript:alert(23)'>x</a></svg>",
    "<style>body{background:url(javascript:alert(24))}</style>",
    "<div style='background:url(https://tracker.example/x)'></div>",
    "<a href='https://example.com' download='evil.exe'>x</a>",
    "<a href='https://example.com' target='_self' rel='ugc'>x</a>",
  ];
  for (const input of corpus) {
    const output = sanitizeHtml(input);
    assert.equal(output.includes("script"), false, `script survived: ${input}`);
    assert.equal(output.includes("javascript"), false, `javascript survived: ${input}`);
    assert.equal(output.includes("onerror"), false, `handler survived: ${input}`);
    assert.equal(output.includes("onclick"), false);
    assert.equal(output.includes("onload"), false);
    assert.equal(output.includes("srcdoc"), false);
    assert.equal(output.includes("xlink:href"), false);
    assert.equal(output.includes("formaction"), false);
    assert.equal(output.includes("poster"), false);
    assert.equal(output.includes("srcset"), false);
    assert.equal(output.includes("tracker.example"), false, `remote load survived: ${input}`);
    assert.equal(output.includes("evil.example"), false);
    assert.equal(output.includes("data:"), false);
    assert.equal(output.includes("blob:"), false);
    assert.equal(output.includes("//evil"), false);
    assert.equal(output.includes("_self"), false);
    assert.equal(output.includes('rel="ugc"'), false);
    assert.equal(output.includes('download='), false);
  }
});

test("sanitized output keeps only hardened safe links", () => {
  const output = sanitizeHtml('<p><a href="https://example.com/a">ok</a> <a href="mailto:x@example.com">m</a> text</p>');
  assert.match(output, /<p><a href="https:\/\/example\.com\/a" target="_blank" rel="noopener noreferrer nofollow">ok<\/a> <a href="mailto:x@example\.com" target="_blank" rel="noopener noreferrer nofollow">m<\/a> text<\/p>/);
});
