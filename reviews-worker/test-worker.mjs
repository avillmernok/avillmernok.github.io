import assert from "node:assert/strict";
import worker from "./src/index.js";

const env = {
    GITHUB_TOKEN: "github-test-token",
    GITHUB_OWNER: "avillmernok",
    GITHUB_REPO: "avillmernok.github.io",
    GITHUB_BRANCH: "main",
    REVIEWS_FILE_PATH: "data/reviews.json",
    ALLOWED_ORIGINS: "https://avillmernok.hu",
    ALLOWED_HOSTNAMES: "avillmernok.hu",
    REQUIRE_TURNSTILE: "true",
    TURNSTILE_SECRET: "turnstile-test-secret",
    RESEND_API_KEY: "resend-test-key",
    MODERATION_EMAIL: "avillmernok@proton.me",
    EMAIL_FROM: "A Villmérnök vélemények <velemenyek@ertesites.avillmernok.hu>",
    MODERATION_SECRET: "a-long-random-test-secret-that-is-not-used-in-production",
    REVIEW_TOKEN_TTL_HOURS: "168",
    PUBLIC_SITE_URL: "https://avillmernok.hu/"
};

let reviews = [];
let resendPayload = null;
let githubWrites = 0;
let turnstileCalls = 0;

const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
    const url = String(input);

    if (url.includes("turnstile/v0/siteverify")) {
        turnstileCalls += 1;
        return Response.json({ success: true, hostname: "avillmernok.hu" });
    }

    if (url === "https://api.resend.com/emails") {
        resendPayload = JSON.parse(init.body);
        return Response.json({ id: "email-test-id" }, { status: 200 });
    }

    if (url.includes("api.github.com/repos/avillmernok/avillmernok.github.io/contents/data/reviews.json")) {
        if ((init.method || "GET") === "GET") {
            return Response.json({
                sha: "test-sha",
                content: Buffer.from(`${JSON.stringify(reviews, null, 2)}\n`, "utf8").toString("base64")
            });
        }

        if (init.method === "PUT") {
            githubWrites += 1;
            const body = JSON.parse(init.body);
            reviews = JSON.parse(Buffer.from(body.content, "base64").toString("utf8"));
            return Response.json({ content: { sha: "new-sha" } }, { status: 200 });
        }
    }

    throw new Error(`Unexpected fetch: ${url}`);
};

try {
    const submission = new Request("https://avillmernok-reviews.example.workers.dev/reviews", {
        method: "POST",
        headers: {
            "Origin": "https://avillmernok.hu",
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            firstName: "Dávid",
            lastName: "Koplányi",
            opinion: "Nagyon korrekt, pontos és megbízható munkavégzés.",
            website: "",
            consent: true,
            turnstileToken: "valid-token"
        })
    });

    const submissionResponse = await worker.fetch(submission, env);
    assert.equal(submissionResponse.status, 202);
    const submissionJson = await submissionResponse.json();
    assert.equal(submissionJson.pending, true);
    assert.equal(turnstileCalls, 1);
    assert.equal(githubWrites, 0, "Submission must not publish immediately");
    assert.equal(resendPayload.to[0], "avillmernok@proton.me");
    assert.match(resendPayload.text, /Koplányi Dávid/);

    const match = resendPayload.text.match(/Ellenőrzés és jóváhagyás: (https:\/\/\S+)/);
    assert.ok(match, "Moderation link must be included in email");
    const moderationUrl = match[1];

    const previewResponse = await worker.fetch(new Request(moderationUrl), env);
    assert.equal(previewResponse.status, 200);
    const previewHtml = await previewResponse.text();
    assert.match(previewHtml, /Koplányi Dávid/);
    assert.match(previewHtml, /Jóváhagyás és közzététel/);
    assert.equal(githubWrites, 0, "Opening email link must not publish");

    const token = new URL(moderationUrl).searchParams.get("token");
    const approvalResponse = await worker.fetch(new Request("https://avillmernok-reviews.example.workers.dev/approve", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token })
    }), env);

    assert.equal(approvalResponse.status, 200);
    assert.equal(githubWrites, 1);
    assert.equal(reviews.length, 1);
    assert.equal(reviews[0].author, "K. Dávid");
    assert.equal(Object.hasOwn(reviews[0], "submittedName"), false);

    const duplicateResponse = await worker.fetch(new Request("https://avillmernok-reviews.example.workers.dev/approve", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token })
    }), env);
    const duplicateHtml = await duplicateResponse.text();
    assert.equal(githubWrites, 1, "Duplicate approval must not create another commit");
    assert.match(duplicateHtml, /Már közzé lett téve/);

    const forbiddenResponse = await worker.fetch(new Request("https://avillmernok-reviews.example.workers.dev/reviews", {
        method: "POST",
        headers: {
            "Origin": "https://example.com",
            "Content-Type": "application/json"
        },
        body: "{}"
    }), env);
    assert.equal(forbiddenResponse.status, 403);

    resendPayload = null;
    const honeypotResponse = await worker.fetch(new Request("https://avillmernok-reviews.example.workers.dev/reviews", {
        method: "POST",
        headers: {
            "Origin": "https://avillmernok.hu",
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            firstName: "Robot",
            lastName: "Teszt",
            opinion: "Ez egy megfelelő hosszúságú robot vélemény.",
            website: "https://spam.example",
            consent: true,
            turnstileToken: "ignored"
        })
    }), env);
    assert.equal(honeypotResponse.status, 202);
    assert.equal(resendPayload, null, "Honeypot submissions must not send email");

    console.log("All moderation workflow tests passed.");
} finally {
    globalThis.fetch = originalFetch;
}
