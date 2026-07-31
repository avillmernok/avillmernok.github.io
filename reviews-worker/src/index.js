const GITHUB_API_VERSION = "2022-11-28";
const DEFAULT_FILE_PATH = "data/reviews.json";
const DEFAULT_TOKEN_TTL_HOURS = 168;
const MAX_REQUEST_BYTES = 12_000;
const MAX_TOKEN_LENGTH = 8_000;
const MAX_GITHUB_RETRIES = 3;
const RESEND_ENDPOINT = "https://api.resend.com/emails";

export default {
    async fetch(request, env) {
        const url = new URL(request.url);

        if (request.method === "OPTIONS" && url.pathname === "/reviews") {
            const origin = request.headers.get("Origin") || "";
            const corsHeaders = getCorsHeaders(origin, env.ALLOWED_ORIGINS);

            if (!isAllowedOrigin(origin, env.ALLOWED_ORIGINS)) {
                return jsonResponse({ error: "Nem engedélyezett eredet." }, 403, corsHeaders);
            }

            return new Response(null, { status: 204, headers: corsHeaders });
        }

        if (request.method === "POST" && url.pathname === "/reviews") {
            return handleReviewSubmission(request, env, url);
        }

        if (request.method === "GET" && url.pathname === "/moderate") {
            return handleModerationPreview(url, env);
        }

        if (request.method === "POST" && url.pathname === "/approve") {
            return handleApproval(request, env);
        }

        if (request.method === "GET" && url.pathname === "/health") {
            return jsonResponse({ ok: true }, 200, { "Cache-Control": "no-store" });
        }

        return jsonResponse({ error: "A végpont nem található." }, 404, {
            "Cache-Control": "no-store"
        });
    }
};

class PublicError extends Error {
    constructor(message, status = 400) {
        super(message);
        this.name = "PublicError";
        this.status = status;
    }
}

async function handleReviewSubmission(request, env, url) {
    const origin = request.headers.get("Origin") || "";
    const corsHeaders = getCorsHeaders(origin, env.ALLOWED_ORIGINS);

    if (!isAllowedOrigin(origin, env.ALLOWED_ORIGINS)) {
        return jsonResponse({ error: "Nem engedélyezett eredet." }, 403, corsHeaders);
    }

    try {
        validateSubmissionEnvironment(env);
        enforceRequestSize(request);

        const contentType = request.headers.get("Content-Type") || "";
        if (!contentType.includes("application/json")) {
            return jsonResponse({ error: "Csak JSON kérés fogadható." }, 415, corsHeaders);
        }

        const payload = await request.json();
        const validation = validateReview(payload, env);

        if (!validation.ok) {
            return jsonResponse({ error: validation.error }, 400, corsHeaders);
        }

        // Honeypot: a bot ugyan sikeres választ kap, de nem küldünk e-mailt.
        if (validation.website) {
            return jsonResponse({ ok: true, pending: true }, 202, corsHeaders);
        }

        await verifyTurnstile(validation.turnstileToken, request, env);

        const token = await createModerationToken(validation.moderationPayload, env.MODERATION_SECRET);
        const moderationUrl = `${url.origin}/moderate?token=${encodeURIComponent(token)}`;
        await sendModerationEmail(validation.moderationPayload, moderationUrl, env);

        return jsonResponse({
            ok: true,
            pending: true,
            message: "A vélemény ellenőrzésre elküldve."
        }, 202, corsHeaders);
    } catch (error) {
        console.error("Review submission failed", error);

        const publicMessage = error instanceof PublicError
            ? error.message
            : "A vélemény elküldése most nem sikerült. Kérlek, próbáld újra később.";
        const status = error instanceof PublicError ? error.status : 500;

        return jsonResponse({ error: publicMessage }, status, corsHeaders);
    }
}

async function handleModerationPreview(url, env) {
    try {
        validateModerationEnvironment(env);
        const token = normalizeToken(url.searchParams.get("token"));
        const payload = await readModerationToken(token, env.MODERATION_SECRET);

        return htmlResponse(renderModerationPage(payload, token, env), 200);
    } catch (error) {
        console.error("Moderation preview failed", error);
        const message = error instanceof PublicError
            ? error.message
            : "A jóváhagyási hivatkozás nem olvasható.";

        return htmlResponse(renderMessagePage(
            "A hivatkozás nem használható",
            message,
            env,
            "error"
        ), error instanceof PublicError ? error.status : 400);
    }
}

async function handleApproval(request, env) {
    try {
        validateApprovalEnvironment(env);
        enforceRequestSize(request);

        const contentType = request.headers.get("Content-Type") || "";
        if (!contentType.includes("application/x-www-form-urlencoded") &&
            !contentType.includes("multipart/form-data")) {
            throw new PublicError("Érvénytelen jóváhagyási kérés.", 415);
        }

        const formData = await request.formData();
        const token = normalizeToken(formData.get("token"));
        const payload = await readModerationToken(token, env.MODERATION_SECRET);
        const result = await saveReviewToGitHub(payload.review, env);

        if (result === "already-published") {
            return htmlResponse(renderMessagePage(
                "Már közzé lett téve",
                "Ez a vélemény már szerepel a weboldal véleményei között.",
                env,
                "success"
            ), 200);
        }

        return htmlResponse(renderMessagePage(
            "Vélemény jóváhagyva",
            "A vélemény bekerült a GitHub-repóba. A GitHub Pages frissítése után megjelenik a weboldalon.",
            env,
            "success"
        ), 200);
    } catch (error) {
        console.error("Review approval failed", error);
        const message = error instanceof PublicError
            ? error.message
            : "A vélemény közzététele most nem sikerült.";

        return htmlResponse(renderMessagePage(
            "A jóváhagyás sikertelen",
            message,
            env,
            "error"
        ), error instanceof PublicError ? error.status : 500);
    }
}

function validateSubmissionEnvironment(env) {
    const required = [
        "ALLOWED_ORIGINS",
        "RESEND_API_KEY",
        "MODERATION_EMAIL",
        "EMAIL_FROM",
        "MODERATION_SECRET"
    ];
    validateRequiredEnvironment(env, required);

    if (String(env.REQUIRE_TURNSTILE || "true").toLowerCase() === "true" && !env.TURNSTILE_SECRET) {
        throw new Error("A Turnstile kötelező, de a TURNSTILE_SECRET nincs beállítva.");
    }
}

function validateModerationEnvironment(env) {
    validateRequiredEnvironment(env, ["MODERATION_SECRET"]);
}

function validateApprovalEnvironment(env) {
    validateRequiredEnvironment(env, [
        "MODERATION_SECRET",
        "GITHUB_TOKEN",
        "GITHUB_OWNER",
        "GITHUB_REPO"
    ]);
}

function validateRequiredEnvironment(env, required) {
    const missing = required.filter((key) => !env[key]);
    if (missing.length > 0) {
        throw new Error(`Hiányzó Worker-beállítások: ${missing.join(", ")}`);
    }
}

function enforceRequestSize(request) {
    const contentLength = Number(request.headers.get("Content-Length") || 0);
    if (contentLength > MAX_REQUEST_BYTES) {
        throw new PublicError("A kérés túl nagy.", 413);
    }
}

function normalize(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeToken(value) {
    const token = String(value || "").trim();
    if (!token || token.length > MAX_TOKEN_LENGTH || !/^[A-Za-z0-9_-]+$/.test(token)) {
        throw new PublicError("A jóváhagyási hivatkozás érvénytelen.", 400);
    }
    return token;
}

function validateReview(payload, env) {
    if (!payload || typeof payload !== "object") {
        return { ok: false, error: "Érvénytelen kérés." };
    }

    const firstName = normalize(payload.firstName);
    const lastName = normalize(payload.lastName);
    const opinion = normalize(payload.opinion);
    const website = normalize(payload.website);
    const consent = payload.consent === true;
    const turnstileToken = normalize(payload.turnstileToken);
    const namePattern = /^[\p{L}\p{M}][\p{L}\p{M} .'-]{0,79}$/u;

    if (!namePattern.test(firstName)) {
        return { ok: false, error: "Adj meg egy érvényes keresztnevet." };
    }

    if (!namePattern.test(lastName)) {
        return { ok: false, error: "Adj meg egy érvényes vezetéknevet." };
    }

    if (opinion.length < 10 || opinion.length > 1500) {
        return { ok: false, error: "A vélemény 10–1500 karakter hosszú lehet." };
    }

    if (!consent) {
        return { ok: false, error: "A közzétételhez szükséges a hozzájárulás." };
    }

    const initial = Array.from(lastName)[0].toLocaleUpperCase("hu-HU");
    const author = `${initial}. ${firstName}`;
    const now = Date.now();
    const ttlHours = parsePositiveInteger(env.REVIEW_TOKEN_TTL_HOURS, DEFAULT_TOKEN_TTL_HOURS);

    return {
        ok: true,
        website,
        turnstileToken,
        moderationPayload: {
            version: 1,
            submittedName: `${lastName} ${firstName}`,
            submittedAt: new Date(now).toISOString(),
            expiresAt: new Date(now + ttlHours * 60 * 60 * 1000).toISOString(),
            review: {
                id: crypto.randomUUID(),
                text: opinion,
                author,
                createdAt: new Date(now).toISOString()
            }
        }
    };
}

function parsePositiveInteger(value, fallback) {
    const parsed = Number.parseInt(String(value || ""), 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

async function verifyTurnstile(token, request, env) {
    const required = String(env.REQUIRE_TURNSTILE || "true").toLowerCase() === "true";

    if (!required && !env.TURNSTILE_SECRET) {
        return;
    }

    if (!token) {
        throw new PublicError("Végezd el a robotellenőrzést.", 400);
    }

    const formData = new FormData();
    formData.append("secret", env.TURNSTILE_SECRET);
    formData.append("response", token);
    formData.append("idempotency_key", crypto.randomUUID());

    const remoteIp = request.headers.get("CF-Connecting-IP");
    if (remoteIp) {
        formData.append("remoteip", remoteIp);
    }

    const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
        method: "POST",
        body: formData
    });

    if (!response.ok) {
        throw new Error(`Turnstile Siteverify HTTP ${response.status}`);
    }

    const result = await response.json();
    if (!result.success) {
        console.warn("Turnstile validation rejected", result["error-codes"] || []);
        throw new PublicError("A robotellenőrzés sikertelen volt. Frissítsd az oldalt, majd próbáld újra.", 400);
    }

    const allowedHostnames = parseCsv(env.ALLOWED_HOSTNAMES || "avillmernok.hu,www.avillmernok.hu,avillmernok.github.io");
    if (result.hostname && allowedHostnames.length > 0 && !allowedHostnames.includes(result.hostname)) {
        throw new PublicError("A robotellenőrzés nem ehhez a weboldalhoz tartozik.", 403);
    }
}

async function createModerationToken(payload, secret) {
    const key = await getModerationKey(secret, ["encrypt"]);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plaintext = new TextEncoder().encode(JSON.stringify(payload));
    const encrypted = new Uint8Array(await crypto.subtle.encrypt(
        { name: "AES-GCM", iv },
        key,
        plaintext
    ));

    const combined = new Uint8Array(iv.length + encrypted.length);
    combined.set(iv, 0);
    combined.set(encrypted, iv.length);
    return bytesToBase64Url(combined);
}

async function readModerationToken(token, secret) {
    try {
        const combined = base64UrlToBytes(token);
        if (combined.length <= 28) {
            throw new Error("Token too short");
        }

        const iv = combined.slice(0, 12);
        const encrypted = combined.slice(12);
        const key = await getModerationKey(secret, ["decrypt"]);
        const decrypted = await crypto.subtle.decrypt(
            { name: "AES-GCM", iv },
            key,
            encrypted
        );
        const payload = JSON.parse(new TextDecoder().decode(decrypted));
        validateModerationPayload(payload);
        return payload;
    } catch (error) {
        if (error instanceof PublicError) {
            throw error;
        }
        throw new PublicError("A jóváhagyási hivatkozás sérült vagy nem hiteles.", 400);
    }
}

function validateModerationPayload(payload) {
    if (!payload || payload.version !== 1 || !payload.review ||
        !payload.review.id || !payload.review.text || !payload.review.author ||
        !payload.submittedName || !payload.expiresAt) {
        throw new PublicError("A jóváhagyási hivatkozás tartalma érvénytelen.", 400);
    }

    const expiresAt = Date.parse(payload.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
        throw new PublicError("A jóváhagyási hivatkozás lejárt. A véleményt újra be kell küldeni.", 410);
    }
}

async function getModerationKey(secret, usages) {
    const material = new TextEncoder().encode(String(secret));
    const digest = await crypto.subtle.digest("SHA-256", material);
    return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, usages);
}

async function sendModerationEmail(payload, moderationUrl, env) {
    const submitted = formatDate(payload.submittedAt);
    const expires = formatDate(payload.expiresAt);
    const subject = `Új jóváhagyandó vélemény – ${payload.review.author}`;

    const html = `<!doctype html>
<html lang="hu">
<body style="margin:0;background:#f3f4f6;font-family:Arial,sans-serif;color:#1f2937">
  <div style="max-width:680px;margin:0 auto;padding:32px 16px">
    <div style="background:#ffffff;border-radius:12px;padding:28px;border:1px solid #e5e7eb">
      <h1 style="margin:0 0 20px;font-size:24px">Új vélemény érkezett</h1>
      <p><strong>Beküldő teljes neve:</strong> ${escapeHtml(payload.submittedName)}</p>
      <p><strong>Nyilvános név:</strong> ${escapeHtml(payload.review.author)}</p>
      <p><strong>Beküldve:</strong> ${escapeHtml(submitted)}</p>
      <div style="margin:22px 0;padding:18px;background:#f9fafb;border-left:4px solid #6b7280;white-space:pre-wrap">${escapeHtml(payload.review.text)}</div>
      <p style="margin:26px 0">
        <a href="${escapeHtmlAttribute(moderationUrl)}" style="display:inline-block;padding:12px 20px;background:#111827;color:#ffffff;text-decoration:none;border-radius:6px;font-weight:bold">Vélemény ellenőrzése</a>
      </p>
      <p style="font-size:13px;color:#6b7280">A hivatkozás ${escapeHtml(expires)} időpontig érvényes. A link megnyitása önmagában nem teszi közzé a véleményt; az ellenőrző oldalon külön jóváhagyó gombot kell megnyomni.</p>
    </div>
  </div>
</body>
</html>`;

    const text = [
        "Új vélemény érkezett",
        "",
        `Beküldő teljes neve: ${payload.submittedName}`,
        `Nyilvános név: ${payload.review.author}`,
        `Beküldve: ${submitted}`,
        "",
        payload.review.text,
        "",
        `Ellenőrzés és jóváhagyás: ${moderationUrl}`,
        `A hivatkozás eddig érvényes: ${expires}`,
        "A link megnyitása önmagában nem publikál; az oldalon külön jóváhagyás szükséges."
    ].join("\n");

    const response = await fetch(RESEND_ENDPOINT, {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${env.RESEND_API_KEY}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            from: env.EMAIL_FROM,
            to: [env.MODERATION_EMAIL],
            subject,
            html,
            text
        })
    });

    if (!response.ok) {
        const details = await safeJson(response);
        console.error("Resend send failed", response.status, details);
        throw new Error(`A Resend nem tudta elküldeni a moderációs e-mailt (${response.status}).`);
    }
}

async function saveReviewToGitHub(review, env) {
    const owner = env.GITHUB_OWNER;
    const repo = env.GITHUB_REPO;
    const branch = env.GITHUB_BRANCH || "main";
    const filePath = env.REVIEWS_FILE_PATH || DEFAULT_FILE_PATH;
    const endpoint = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${filePath.split("/").map(encodeURIComponent).join("/")}`;

    for (let attempt = 1; attempt <= MAX_GITHUB_RETRIES; attempt += 1) {
        const current = await getReviewsFile(endpoint, branch, env.GITHUB_TOKEN);
        const reviews = current.reviews;

        if (reviews.some((item) => item && item.id === review.id)) {
            return "already-published";
        }

        reviews.push(review);

        const updateResponse = await fetch(endpoint, {
            method: "PUT",
            headers: githubHeaders(env.GITHUB_TOKEN),
            body: JSON.stringify({
                message: `Approve customer review from ${review.author}`,
                content: encodeBase64Utf8(`${JSON.stringify(reviews, null, 2)}\n`),
                sha: current.sha,
                branch
            })
        });

        if (updateResponse.ok) {
            return "published";
        }

        if (updateResponse.status === 409 && attempt < MAX_GITHUB_RETRIES) {
            await sleep(attempt * 150);
            continue;
        }

        const details = await safeJson(updateResponse);
        console.error("GitHub update failed", updateResponse.status, details);

        if (updateResponse.status === 401 || updateResponse.status === 403) {
            throw new Error("A GitHub token érvénytelen vagy nincs Contents: write jogosultsága.");
        }

        throw new Error(`A GitHub nem tudta frissíteni a véleményfájlt (${updateResponse.status}).`);
    }

    throw new Error("A GitHub-fájl többszöri próbálkozás után sem frissíthető.");
}

async function getReviewsFile(endpoint, branch, token) {
    const response = await fetch(`${endpoint}?ref=${encodeURIComponent(branch)}`, {
        headers: githubHeaders(token)
    });

    if (!response.ok) {
        const details = await safeJson(response);
        console.error("GitHub read failed", response.status, details);
        throw new Error(`A GitHub nem tudta beolvasni a véleményfájlt (${response.status}).`);
    }

    const file = await response.json();
    const decoded = decodeBase64Utf8(file.content || "");
    const reviews = JSON.parse(decoded);

    if (!Array.isArray(reviews)) {
        throw new Error("A reviews.json tartalma nem tömb.");
    }

    return { sha: file.sha, reviews };
}

function githubHeaders(token) {
    return {
        "Accept": "application/vnd.github+json",
        "Authorization": `Bearer ${token}`,
        "X-GitHub-Api-Version": GITHUB_API_VERSION,
        "User-Agent": "avillmernok-review-worker"
    };
}

function renderModerationPage(payload, token, env) {
    const siteUrl = normalizeSiteUrl(env.PUBLIC_SITE_URL);
    return pageTemplate(
        "Vélemény ellenőrzése",
        `<div class="card">
            <p class="eyebrow">A Villmérnök</p>
            <h1>Vélemény ellenőrzése</h1>
            <dl>
                <dt>Beküldő teljes neve</dt>
                <dd>${escapeHtml(payload.submittedName)}</dd>
                <dt>Weboldalon megjelenő név</dt>
                <dd>${escapeHtml(payload.review.author)}</dd>
                <dt>Beküldés időpontja</dt>
                <dd>${escapeHtml(formatDate(payload.submittedAt))}</dd>
                <dt>Link lejárata</dt>
                <dd>${escapeHtml(formatDate(payload.expiresAt))}</dd>
            </dl>
            <blockquote>${escapeHtml(payload.review.text)}</blockquote>
            <form method="post" action="/approve">
                <input type="hidden" name="token" value="${escapeHtmlAttribute(token)}">
                <button type="submit">Jóváhagyás és közzététel</button>
            </form>
            <p class="note">A vélemény csak a fenti gomb megnyomása után kerül a GitHub-repóba. Elutasításhoz egyszerűen zárd be ezt az oldalt.</p>
            ${siteUrl ? `<p><a href="${escapeHtmlAttribute(siteUrl)}">Vissza a weboldalra</a></p>` : ""}
        </div>`
    );
}

function renderMessagePage(title, message, env, type) {
    const siteUrl = normalizeSiteUrl(env.PUBLIC_SITE_URL);
    return pageTemplate(
        title,
        `<div class="card ${type === "error" ? "error" : "success"}">
            <p class="eyebrow">A Villmérnök</p>
            <h1>${escapeHtml(title)}</h1>
            <p>${escapeHtml(message)}</p>
            ${siteUrl ? `<p><a class="secondary" href="${escapeHtmlAttribute(siteUrl)}">Vissza a weboldalra</a></p>` : ""}
        </div>`
    );
}

function pageTemplate(title, content) {
    return `<!doctype html>
<html lang="hu">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="robots" content="noindex,nofollow">
    <title>${escapeHtml(title)} – A Villmérnök</title>
    <style>
        :root { color-scheme: light; font-family: Inter, Arial, sans-serif; }
        * { box-sizing: border-box; }
        body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px; background: #111827; color: #1f2937; }
        .card { width: min(720px, 100%); background: #fff; border-radius: 14px; padding: clamp(24px, 5vw, 44px); box-shadow: 0 20px 60px rgba(0,0,0,.3); }
        .card.success { border-top: 6px solid #15803d; }
        .card.error { border-top: 6px solid #b91c1c; }
        .eyebrow { margin: 0 0 8px; color: #6b7280; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
        h1 { margin: 0 0 24px; font-size: clamp(28px, 5vw, 40px); line-height: 1.1; }
        dl { display: grid; grid-template-columns: minmax(170px, 1fr) 2fr; gap: 8px 18px; margin: 0 0 24px; }
        dt { font-weight: 700; }
        dd { margin: 0; overflow-wrap: anywhere; }
        blockquote { margin: 24px 0; padding: 20px; border-left: 5px solid #4b5563; background: #f3f4f6; white-space: pre-wrap; overflow-wrap: anywhere; }
        button, .secondary { display: inline-block; border: 0; border-radius: 7px; padding: 13px 20px; background: #111827; color: #fff; font: inherit; font-weight: 700; cursor: pointer; text-decoration: none; }
        button:hover, .secondary:hover { background: #374151; }
        .note { margin-top: 20px; color: #6b7280; font-size: 14px; line-height: 1.55; }
        a { color: #1d4ed8; }
        @media (max-width: 560px) { dl { grid-template-columns: 1fr; } dd { margin-bottom: 8px; } }
    </style>
</head>
<body>${content}</body>
</html>`;
}

function normalizeSiteUrl(value) {
    try {
        const url = new URL(String(value || ""));
        return url.protocol === "https:" ? url.toString() : "";
    } catch (_) {
        return "";
    }
}

function formatDate(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        return String(value || "");
    }

    return new Intl.DateTimeFormat("hu-HU", {
        timeZone: "Europe/Budapest",
        year: "numeric",
        month: "long",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit"
    }).format(date);
}

function getCorsHeaders(origin, allowedOriginsValue) {
    const allowed = isAllowedOrigin(origin, allowedOriginsValue);
    return {
        "Access-Control-Allow-Origin": allowed ? origin : "null",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Accept",
        "Access-Control-Max-Age": "86400",
        "Vary": "Origin",
        "Cache-Control": "no-store"
    };
}

function isAllowedOrigin(origin, allowedOriginsValue) {
    if (!origin) {
        return false;
    }
    return parseCsv(allowedOriginsValue).includes(origin);
}

function parseCsv(value) {
    return String(value || "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
}

function jsonResponse(body, status, extraHeaders = {}) {
    return new Response(JSON.stringify(body), {
        status,
        headers: {
            "Content-Type": "application/json; charset=utf-8",
            ...extraHeaders
        }
    });
}

function htmlResponse(body, status) {
    return new Response(body, {
        status,
        headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store",
            "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
            "Referrer-Policy": "no-referrer",
            "X-Content-Type-Options": "nosniff",
            "X-Frame-Options": "DENY"
        }
    });
}

function escapeHtml(value) {
    return String(value || "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}

function escapeHtmlAttribute(value) {
    return escapeHtml(value).replaceAll("`", "&#096;");
}

function bytesToBase64Url(bytes) {
    let binary = "";
    const chunkSize = 0x8000;
    for (let index = 0; index < bytes.length; index += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
    }
    return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function base64UrlToBytes(value) {
    const base64 = String(value).replaceAll("-", "+").replaceAll("_", "/");
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
    const binary = atob(padded);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function encodeBase64Utf8(value) {
    const bytes = new TextEncoder().encode(value);
    let binary = "";
    const chunkSize = 0x8000;

    for (let index = 0; index < bytes.length; index += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
    }

    return btoa(binary);
}

function decodeBase64Utf8(value) {
    const binary = atob(String(value).replace(/\s/g, ""));
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return new TextDecoder().decode(bytes);
}

async function safeJson(response) {
    try {
        return await response.json();
    } catch (_) {
        return null;
    }
}

function sleep(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
